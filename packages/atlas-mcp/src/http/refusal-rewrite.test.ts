import { describe, expect, it } from "vitest";
import { CapabilityRefusalSink } from "../capability-refusal.js";
import { applyCapabilityRefusal, rewriteSseBody, rewriteSseFrame } from "./refusal-rewrite.js";

/**
 * The `-32021` swap on the HTTP side, against literal bytes.
 *
 * Asserted here rather than only through a live server for the reason
 * `gateInbound` and `capabilityErrorFor` are also exported as pure functions:
 * the SSE path is reachable but not what a refusal produces today, so a test
 * that could only reach it through a real streaming response would be a test
 * nobody could write until the day it broke.
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

  it("rewrites a JSON body and keeps the status and headers", async () => {
    const response = new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } }), {
      status: 200,
      headers: { "content-type": "application/json", "x-atlas-probe": "kept" }
    });

    const swapped = await applyCapabilityRefusal(response, sinkHolding(1));
    const body = (await swapped.json()) as { error: { code: number } };

    expect(swapped.status).toBe(200);
    expect(swapped.headers.get("x-atlas-probe")).toBe("kept");
    expect(body.error.code).toBe(-32021);
  });

  it("rewrites an SSE body and keeps the streaming headers", async () => {
    const response = new Response(resultFrame(1), {
      status: 200,
      headers: { "content-type": "text/event-stream", "x-accel-buffering": "no" }
    });

    const swapped = await applyCapabilityRefusal(response, sinkHolding(1));

    expect(swapped.headers.get("x-accel-buffering")).toBe("no");
    expect(await swapped.text()).toContain('"code":-32021');
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
