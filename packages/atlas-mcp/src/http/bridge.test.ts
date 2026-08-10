import { describe, expect, it } from "vitest";
import { expectsReply, jsonPayloadsFromSse, responseLines } from "./bridge.js";

/**
 * The stdio-to-HTTP pipe's only real surface (ADR 0037).
 *
 * The pipe forwards bytes and adds a header, so almost nothing about it is
 * testable behaviour. What IS testable is the framing translation, and both
 * halves of it were established by measuring the running service rather than by
 * reading the spec: a request comes back as `text/event-stream`, a notification
 * comes back `202` with an empty body.
 *
 * Getting either wrong is invisible in a happy-path smoke test and fatal in use
 * — the first would hand a client an SSE frame where a JSON object belongs, and
 * the second would put a reply on the wire for a message that has no id.
 */

describe("unwrapping an SSE body", () => {
  it("emits the JSON payload of each frame, in order", () => {
    const body = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"a":1}}\n\n';
    expect(jsonPayloadsFromSse(body)).toEqual(['{"jsonrpc":"2.0","id":1,"result":{"a":1}}']);
  });

  it("keeps multiple frames as separate lines, because stdio frames on newlines", () => {
    const body = 'event: message\ndata: {"id":1}\n\nevent: message\ndata: {"id":2}\n\n';
    expect(jsonPayloadsFromSse(body)).toEqual(['{"id":1}', '{"id":2}']);
  });

  it("ignores the frame fields it has no business interpreting", () => {
    // `event:` and `id:` are SSE transport, not JSON-RPC. Passing them through
    // would put non-JSON on a wire that must carry one object per line.
    const body = 'event: message\nid: 7\nretry: 3000\ndata: {"id":1}\n\n';
    expect(jsonPayloadsFromSse(body)).toEqual(['{"id":1}']);
  });

  it("drops empty data lines rather than emitting a blank line", () => {
    expect(jsonPayloadsFromSse("event: ping\ndata:\n\n")).toEqual([]);
  });
});

describe("choosing how to emit a response", () => {
  it("unwraps when the content type says event-stream", () => {
    expect(responseLines("text/event-stream", 'data: {"id":1}\n\n')).toEqual(['{"id":1}']);
  });

  it("passes plain JSON straight through, because an edge refusal arrives that way", () => {
    // A refusal is exactly the thing a client must still receive: the service
    // answers -32020/-32022/401 as plain JSON, never as SSE.
    const refusal = '{"jsonrpc":"2.0","error":{"code":-32020,"message":"Missing required header"}}';
    expect(responseLines("application/json", refusal)).toEqual([refusal]);
  });

  it("emits NOTHING for an empty body, which is how a notification is answered", () => {
    // Measured: the service answers a notification 202 with no body. Emitting
    // anything here would reply to a message that has no id.
    expect(responseLines("application/json", "")).toEqual([]);
    expect(responseLines(null, "   ")).toEqual([]);
  });
});

describe("telling a request from a notification", () => {
  it("expects a reply when the message carries an id", () => {
    expect(expectsReply('{"jsonrpc":"2.0","id":1,"method":"tools/list"}')).toBe(true);
    // `id: null` is still an id, and JSON-RPC answers it.
    expect(expectsReply('{"jsonrpc":"2.0","id":null,"method":"tools/list"}')).toBe(true);
  });

  it("expects none when it does not", () => {
    expect(expectsReply('{"jsonrpc":"2.0","method":"notifications/initialized"}')).toBe(false);
  });

  it("expects a reply for an unparseable line, so a client is never stranded", () => {
    // The service is entitled to answer a parse error; swallowing the line here
    // would leave the client waiting on a request that can never be answered.
    expect(expectsReply("{not json")).toBe(true);
  });
});
