import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { CapabilityRefusalSink } from "../capability-refusal.js";
import { credentialResolver } from "../credentials.js";
import { CONSUMER_PRINCIPAL, SYNTHETIC_SECRET, envelope, standardHeaders, syntheticDirectory } from "../testing.js";
import { atlasHttpFetchHandler } from "./serve.js";
import {
  CAPABILITY_REFUSAL_HTTP_STATUS,
  applyCapabilityRefusal,
  capabilityRefusalTransform,
  rewriteSseBody,
  rewriteSseFrame
} from "./refusal-rewrite.js";

/**
 * The `-32021` swap on the HTTP side.
 *
 * Most of it is asserted against literal bytes, for the reason `gateInbound` and
 * `capabilityErrorFor` are also exported as pure functions: the frame rewriter
 * is a decision about one message and is worth testing without a transport.
 *
 * The ORDERING is not, and cannot be. Whether a refusal parked by a handler ever
 * reaches an already-opened stream is a property of when the sink is read, and a
 * hand-built `Response` alongside a pre-populated sink answers that question by
 * assuming it away — which is how the SSE path came to be broken while every
 * test here passed. So the file now drives a real streaming exchange too.
 */

const REFUSAL = {
  requiredCapabilities: { elicitation: {} },
  message: "This call needs elicitation.",
  result: { outcome: "refused" as const }
};

function sinkHolding(id: string | number): CapabilityRefusalSink {
  const sink = new CapabilityRefusalSink();
  sink.park(id, REFUSAL);
  return sink;
}

const resultFrame = (id: number) =>
  `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result: { content: [] } })}\n\n`;

describe("rewriting one SSE frame", () => {
  it("replaces a parked result with the -32021 error and keeps the event line", () => {
    const rewritten = rewriteSseFrame(resultFrame(1).trimEnd(), sinkHolding(1));

    expect(rewritten.startsWith("event: message\n")).toBe(true);
    const payload = JSON.parse(rewritten.split("\ndata: ")[1] as string);
    expect(payload.error.code).toBe(-32021);
    expect(payload.error.data.requiredCapabilities).toEqual({ elicitation: {} });
    expect(payload.id).toBe(1);
  });

  it("leaves a frame alone when nothing is parked for its id", () => {
    const frame = resultFrame(7).trimEnd();
    expect(rewriteSseFrame(frame, sinkHolding(1))).toBe(frame);
  });

  it("leaves a notification frame alone, because it carries no result to swap", () => {
    const frame = `event: message\ndata: ${JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: { progress: 1 }
    })}`;
    expect(rewriteSseFrame(frame, sinkHolding(1))).toBe(frame);
  });

  it("leaves a keep-alive comment frame alone", () => {
    expect(rewriteSseFrame(":", sinkHolding(1))).toBe(":");
  });

  it("folds a multi-line data field before parsing it", () => {
    // Per the SSE specification a payload may be split across `data:` lines and
    // is rejoined with newlines. A rewriter that read only the first line would
    // fail to parse the JSON and silently pass a swappable result through.
    const message = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } });
    // Rejoining inserts a newline the original JSON did not have, so the halves
    // straddle a structural comma — the one place a newline is insignificant
    // whitespace rather than a control character inside a string literal.
    const cut = message.indexOf(',"id"') + 1;
    const split = `event: message\ndata: ${message.slice(0, cut)}\ndata: ${message.slice(cut)}`;
    expect(JSON.parse(`${message.slice(0, cut)}\n${message.slice(cut)}`)).toEqual(JSON.parse(message));

    const rewritten = rewriteSseFrame(split, sinkHolding(1));
    expect(JSON.parse(rewritten.split("\ndata: ")[1] as string).error.code).toBe(-32021);
    // The two data lines became one, and the event line survived.
    expect(rewritten.split("\n").filter((line) => line.startsWith("data:"))).toHaveLength(1);
  });
});

describe("rewriting a whole SSE body", () => {
  it("swaps only the result frame and preserves frame boundaries", () => {
    const progress = `event: message\ndata: ${JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: { progress: 1 }
    })}\n\n`;
    const body = `${progress}${resultFrame(1)}`;

    const rewritten = rewriteSseBody(body, sinkHolding(1));

    expect(rewritten.startsWith(progress)).toBe(true);
    expect(rewritten.endsWith("\n\n")).toBe(true);
    expect(rewritten).toContain('"code":-32021');
    // Exactly one swap: the progress notification is still on the stream.
    expect(rewritten.match(/-32021/g)).toHaveLength(1);
  });

  it("handles CRLF frame separators", () => {
    const body = `event: message\r\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })}\r\n\r\n`;
    const rewritten = rewriteSseBody(body, sinkHolding(1));
    expect(rewritten).toContain('"code":-32021');
    expect(rewritten.endsWith("\r\n\r\n")).toBe(true);
  });

  it("returns a body unchanged when the sink is empty", () => {
    const body = resultFrame(1);
    expect(rewriteSseBody(body, new CapabilityRefusalSink())).toBe(body);
  });
});

describe("applying the swap to a Response", () => {
  it("returns the very same Response object when nothing is parked", async () => {
    const response = new Response("{}", { headers: { "content-type": "application/json" } });
    // Identity, not equality: the common path must not read the body, so a
    // streaming response keeps streaming.
    expect(await applyCapabilityRefusal(response, new CapabilityRefusalSink())).toBe(response);
    expect(response.bodyUsed).toBe(false);
  });

  it("rewrites a JSON body, keeps the headers, and answers 400 rather than the result's 200", async () => {
    /**
     * The status is part of the refusal, not decoration.
     * `MissingRequiredClientCapability` is the ONE in-band code the revision does
     * not answer `200` on, and `@modelcontextprotocol/server@2.0.0` sends `400`
     * from its own ladder table whenever it raises the error itself. This seam
     * raises it after the SDK already chose `200` for the RESULT it is
     * replacing, so carrying that status through would leave the same server
     * answering the same refusal two different ways depending on which path
     * produced it.
     */
    const response = new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } }), {
      status: 200,
      headers: { "content-type": "application/json", "x-atlas-probe": "kept" }
    });

    const swapped = await applyCapabilityRefusal(response, sinkHolding(1));
    const body = (await swapped.json()) as { error: { code: number } };

    expect(swapped.status).toBe(CAPABILITY_REFUSAL_HTTP_STATUS);
    expect(swapped.status).toBe(400);
    expect(swapped.headers.get("x-atlas-probe")).toBe("kept");
    expect(body.error.code).toBe(-32021);
  });

  it("leaves the status alone when the sink held a refusal for some OTHER id", async () => {
    // Nothing was swapped, so nothing about the answer changed — a `400` here
    // would report a refusal that did not happen.
    const response = new Response(JSON.stringify({ jsonrpc: "2.0", id: 99, result: { content: [] } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });

    const swapped = await applyCapabilityRefusal(response, sinkHolding(1));
    expect(swapped.status).toBe(200);
  });

  it("rewrites an SSE body and keeps the streaming headers", async () => {
    const response = new Response(resultFrame(1), {
      status: 200,
      headers: { "content-type": "text/event-stream", "x-accel-buffering": "no" }
    });

    const swapped = await applyCapabilityRefusal(response, sinkHolding(1));

    expect(swapped.headers.get("x-accel-buffering")).toBe("no");
    expect(await swapped.text()).toContain('"code":-32021');
    // The status belongs to the STREAM, which opened long before any refusal
    // existed, so it stays 200 — the SDK's own ladder agrees and applies the
    // `400` only when the exchange has not upgraded.
    expect(swapped.status).toBe(200);
  });

  it("swaps a frame against a refusal parked AFTER the response was handed over", async () => {
    /**
     * The ordering, in isolation. On a real SSE upgrade the response settles the
     * instant the first notification is written — before the handler has
     * produced a result, and therefore before anything is parked. A function
     * that decided on `sink.size` at that moment would decide "nothing to do"
     * every time, which is exactly what it did.
     *
     * The sink here is EMPTY when `applyCapabilityRefusal` runs and is filled
     * only after the first frame has already gone out.
     */
    const sink = new CapabilityRefusalSink();
    let push: (chunk: string) => void = () => {};
    let finish: () => void = () => {};
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        push = (chunk) => controller.enqueue(encoder.encode(chunk));
        finish = () => controller.close();
      }
    });

    const swapped = await applyCapabilityRefusal(
      new Response(upstream, { status: 200, headers: { "content-type": "text/event-stream" } }),
      sink
    );
    const reader = (swapped.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();

    push(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress" })}\n\n`);
    const notification = decoder.decode((await reader.read()).value);
    // Forwarded before the exchange ended: the transform streams rather than
    // buffering the body, which is the property `await response.text()` gave up.
    expect(notification).toContain("notifications/progress");
    expect(notification).not.toContain("-32021");

    sink.park(1, REFUSAL);
    push(resultFrame(1));
    finish();

    const result = decoder.decode((await reader.read()).value);
    expect(result).toContain('"code":-32021');
  });

  it("reassembles a frame that arrived split across chunks", async () => {
    // A chunk boundary respects nothing, least of all a frame. A rewriter that
    // read whatever bytes turned up would fail to parse the half it was given
    // and pass a swappable result straight through.
    const sink = sinkHolding(1);
    const frame = resultFrame(1);
    const cut = Math.floor(frame.length / 2);

    const encoder = new TextEncoder();
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(frame.slice(0, cut)));
        controller.enqueue(encoder.encode(frame.slice(cut)));
        controller.close();
      }
    });

    const swapped = await applyCapabilityRefusal(
      new Response(upstream, { status: 200, headers: { "content-type": "text/event-stream" } }),
      sink
    );
    expect(await swapped.text()).toContain('"code":-32021');
  });

  it("streams an untouched body through when nothing is ever parked", async () => {
    // The empty-sink SSE case cannot short-circuit on identity any more, so it
    // is held to byte equality instead: wrapping must cost the bytes nothing.
    const body = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 5, result: {} })}\n\n`;
    const swapped = await applyCapabilityRefusal(
      new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
      new CapabilityRefusalSink()
    );
    expect(await swapped.text()).toBe(body);
  });

  it("forwards a trailing frame that never got its blank line", async () => {
    // A stream cut short still has to deliver what it managed to write.
    const encoder = new TextEncoder();
    const unterminated = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })}`;
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(unterminated));
        controller.close();
      }
    });

    const transformed = new Response(upstream).body!.pipeThrough(capabilityRefusalTransform(sinkHolding(1)));
    const text = await new Response(transformed).text();
    expect(text).toContain('"code":-32021');
  });

  it("passes a body it cannot parse through untouched rather than replacing it", async () => {
    // A sink can hold a refusal while the response is something this function
    // does not understand. Claiming to have understood it would be worse than
    // leaving it alone.
    const response = new Response("not json at all", {
      status: 200,
      headers: { "content-type": "application/json" }
    });

    const swapped = await applyCapabilityRefusal(response, sinkHolding(1));
    expect(await swapped.text()).toBe("not json at all");
  });

  it("does not swap a result whose id nobody parked", async () => {
    const response = new Response(JSON.stringify({ jsonrpc: "2.0", id: 99, result: { content: [] } }), {
      headers: { "content-type": "application/json" }
    });

    const swapped = await applyCapabilityRefusal(response, sinkHolding(1));
    const body = (await swapped.json()) as { result?: unknown; error?: unknown };
    expect(body.result).toEqual({ content: [] });
    expect(body.error).toBeUndefined();
  });
});

/**
 * The same rule through the REAL edge, on an exchange that actually streams.
 *
 * No Atlas tool emits a notification today, so the plane's own servers cannot
 * reach this shape and a parity test against them never will. That is precisely
 * why it is worth building a server that can: the defect this covers is latent,
 * and a latent defect with no test is one that surfaces the day somebody adds a
 * progress notification to a slow read — at which point the spec MUST silently
 * stops being met and nothing fails.
 */
const handlers: { close: () => Promise<void> }[] = [];

afterEach(async () => {
  while (handlers.length > 0) await handlers.pop()?.close();
});

/** A handler that announces progress, yields, THEN parks a refusal and returns a result. */
function streamingRefusalHandler(): { fetch: (request: Request) => Promise<Response>; close: () => Promise<void> } {
  const directory = syntheticDirectory(CONSUMER_PRINCIPAL);
  const handler = atlasHttpFetchHandler(
    { resolvePrincipal: credentialResolver({ directory, plane: "consumer" }), credentials: directory },
    ({ capabilityRefusals }) => {
      const server = new McpServer(
        { name: "streaming-probe", version: "1" },
        { capabilities: { tools: { listChanged: false } } }
      );
      // `inputSchema` is declared, and not for validation's sake: the SDK
      // switches the callback to `(ctx) => …` when a tool declares none, and a
      // handler written for `(args, ctx)` would then read `mcpReq` off
      // `undefined` and be reported as an ordinary tool error.
      server.registerTool(
        "probe.stream",
        { description: "notifies, works, then refuses", inputSchema: z.object({}) },
        async (_args, ctx) => {
          // This is what upgrades the exchange under the default
          // `responseMode: 'auto'` — the response settles here.
          await ctx.mcpReq.notify({ method: "notifications/progress", params: { progressToken: "t", progress: 1 } });
          // One macrotask of real work. Without it the park lands in the same
          // microtask drain as the upgrade and the old code passed by accident,
          // which is the whole reason this defect was invisible.
          await new Promise((resolve) => setTimeout(resolve, 5));
          capabilityRefusals.park(ctx.mcpReq.id, REFUSAL);
          return { content: [{ type: "text" as const, text: "ok" }] };
        }
      );
      return { server };
    }
  );
  handlers.push(handler);
  return handler;
}

describe("a streaming exchange through the HTTP edge", () => {
  it("still answers -32021, even though the response settled before the refusal existed", async () => {
    const handler = streamingRefusalHandler();
    const message = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "probe.stream", arguments: {}, _meta: envelope() }
    };

    const response = await handler.fetch(
      new Request("http://127.0.0.1/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${SYNTHETIC_SECRET}`,
          ...standardHeaders(message)
        },
        body: JSON.stringify(message)
      })
    );

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    // The SDK's own streaming headers survive being re-wrapped around the
    // transform. `X-Accel-Buffering: no` is the one a reverse proxy reads, and a
    // stream it decided to buffer is a stream that has stopped being one.
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(response.headers.get("cache-control")).toContain("no-cache");
    // Streamed, not buffered: the response settled while the handler was still
    // working, so reading it here is reading a live stream.
    expect(response.status).toBe(200);

    const body = await response.text();

    // The progress frame is untouched and still on the stream.
    expect(body).toContain("notifications/progress");
    // And the terminal frame is the refusal, not the result the handler built.
    expect(body).toContain('"code":-32021');
    expect(body).toContain('"requiredCapabilities":{"elicitation":{}}');
    expect(body).not.toContain('"text":"ok"');
  });
});
