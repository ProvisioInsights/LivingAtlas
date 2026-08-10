#!/usr/bin/env -S npx tsx
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

/**
 * A STDIO-TO-HTTP PIPE, so a client that can only spawn a process reaches the
 * one live service (ADR 0037).
 *
 * ## Why this exists at all
 *
 * ADR 0036 made the service speak Claude Desktop's protocol revision, and that
 * turned out not to be enough: Desktop reaches an MCP server by one of two
 * routes, and neither admits a plain loopback HTTP URL.
 * `claude_desktop_config.json` defines a COMMAND (stdio) and has no URL server
 * type; a custom connector takes a URL and requires `https://`, even for
 * `127.0.0.1`. Measured by the owner against the running service.
 *
 * So the client that needs live editing can spawn a process but cannot dial a
 * local socket, and the service can be dialled but not spawned. This bridges
 * exactly that gap and nothing else.
 *
 * ## Why it is a PIPE and not a second server
 *
 * ADR 0036 rejected a bridge because a second protocol implementation is a
 * second thing to keep from drifting — the condition the anti-drift gates exist
 * to prevent. That objection applied to a bridge that would have TRANSLATED
 * between eras: parsing an opening, minting a modern envelope, tracking a
 * session, reimplementing the ladder.
 *
 * None of that is needed, because ADR 0036 taught the service to accept a
 * 2025-era opening directly. So this forwards the bytes VERBATIM and adds one
 * header. It parses a JSON-RPC message only far enough to know whether a reply
 * is expected, and it has no idea what any tool means: the contract, the grant,
 * the audit and the tool handlers all stay in the one service. There is nothing
 * here for the published surface to drift from.
 *
 * ## The two shapes it must unwrap, both measured
 *
 *  - a REQUEST is answered `text/event-stream` with `event: message` and
 *    `data: {...}` frames. stdio wants one bare JSON object per line, so each
 *    `data:` payload is re-emitted as its own line.
 *  - a NOTIFICATION is answered `202` with an EMPTY body. Emitting anything for
 *    it would put a reply on the wire for a message that has no id, which a
 *    client is entitled to treat as a protocol violation.
 *
 * ## Env contract
 *
 *   LIVING_ATLAS_HTTP_URL      (required) the service endpoint, e.g.
 *                              http://127.0.0.1:8787/mcp
 *   LIVING_ATLAS_HTTP_BEARER   (required) the credential. Supplied by the
 *                              launcher, which reads it from the Keychain, so
 *                              the secret never lives in a config file.
 */

export const BRIDGE_URL_ENV = "LIVING_ATLAS_HTTP_URL" as const;
export const BRIDGE_BEARER_ENV = "LIVING_ATLAS_HTTP_BEARER" as const;

/** stderr, never stdout: stdout is the JSON-RPC wire and a stray line corrupts framing. */
function note(message: string): void {
  process.stderr.write(`[atlas-bridge] ${message}\n`);
}

/**
 * Every JSON object carried by an SSE body, in order.
 *
 * Split on `data:` rather than parsing the whole frame, because the only field
 * this pipe needs is the payload and a frame may also carry `event:` and `id:`
 * lines it has no business interpreting.
 */
export function jsonPayloadsFromSse(body: string): string[] {
  const payloads: string[] = [];
  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload.length > 0) payloads.push(payload);
  }
  return payloads;
}

/**
 * The lines to emit for one response body.
 *
 * A body that is not SSE is passed through as a single line — the service
 * answers plain JSON for edge refusals, and a refusal is exactly the thing a
 * client must still receive.
 */
export function responseLines(contentType: string | null, body: string): string[] {
  if (body.trim().length === 0) return [];
  if (contentType !== null && contentType.includes("text/event-stream")) return jsonPayloadsFromSse(body);
  return [body.trim()];
}

/** True when a message expects a reply. A notification carries no `id`. */
export function expectsReply(line: string): boolean {
  try {
    const message: unknown = JSON.parse(line);
    return typeof message === "object" && message !== null && "id" in message;
  } catch {
    // Unparseable: forward it and let the service answer with the parse error it
    // is entitled to send. Swallowing it here would strand the client.
    return true;
  }
}

/**
 * A JSON-RPC error the CLIENT can act on, for failures that never reached the
 * service — it is down, the port moved, the bearer is wrong.
 *
 * Without this the bridge would simply write nothing and the client would wait
 * forever on a request that can never be answered, which reads as a hang rather
 * than as a service that is not running.
 */
function transportError(id: unknown, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code: -32000, message } });
}

function idOf(line: string): unknown {
  try {
    return (JSON.parse(line) as { id?: unknown }).id;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const url = process.env[BRIDGE_URL_ENV];
  const bearer = process.env[BRIDGE_BEARER_ENV];
  if (url === undefined || url.trim().length === 0) {
    note(`${BRIDGE_URL_ENV} is not set`);
    process.exit(2);
  }
  if (bearer === undefined || bearer.trim().length === 0) {
    note(`${BRIDGE_BEARER_ENV} is not set: the service authenticates every request`);
    process.exit(2);
  }

  const headers = {
    "content-type": "application/json",
    // Both, because the service answers a request as SSE and an edge refusal as
    // JSON, and this pipe has to accept whichever it gets.
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${bearer}`
  };

  /**
   * Messages are forwarded IN ORDER, one at a time.
   *
   * A client may pipeline, and answering out of order would be legal JSON-RPC —
   * but the service is a single writer over one store, and serialising here
   * keeps "the order the client sent" and "the order the graph saw" the same
   * thing, which is what makes a transcript reconcilable against the audit log.
   */
  let chain: Promise<void> = Promise.resolve();

  const forward = async (line: string): Promise<void> => {
    try {
      const response = await fetch(url, { method: "POST", headers, body: line });
      const body = await response.text();
      for (const payload of responseLines(response.headers.get("content-type"), body)) {
        process.stdout.write(`${payload}\n`);
      }
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      note(`forward failed: ${detail}`);
      if (expectsReply(line)) {
        process.stdout.write(`${transportError(idOf(line), `The Atlas service could not be reached: ${detail}`)}\n`);
      }
    }
  };

  const input = createInterface({ input: process.stdin });
  input.on("line", (line) => {
    if (line.trim().length === 0) return;
    chain = chain.then(() => forward(line));
  });

  // stdin closing is how a client says it is done; exit once the queue drains
  // rather than mid-flight, so a final reply is not lost.
  await new Promise<void>((resolve) => input.on("close", () => resolve()));
  await chain;
}

/**
 * Run only when this file IS the process, the same guard the `real-data:*`
 * runners use. Without it, importing the framing helpers for a test starts a
 * pipe, which then exits the test runner because no service was configured for
 * it — measured: `process.exit unexpectedly called with "1"` from a suite that
 * had otherwise passed.
 */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((cause) => {
    note(cause instanceof Error ? (cause.stack ?? cause.message) : String(cause));
    process.exit(1);
  });
}
