import { ProtocolErrorCode, type JSONRPCMessage, type Transport } from "@modelcontextprotocol/server";

/**
 * `-32021` on the wire, as a transport decorator.
 *
 * MCP 2026-07-28 (basic, `_meta`): when processing a request needs a client
 * capability the request did not declare, the server **MUST** answer with a
 * MissingRequiredClientCapability error (`-32021`) whose
 * `data.requiredCapabilities` names what is missing. That is a JSON-RPC ERROR,
 * not a tool result — the numeric code is the only part a conformant client can
 * branch on, and a result carrying the number in a field is a number nobody
 * reads.
 *
 * A tool handler cannot raise it. `McpServer`'s built-in `tools/call` wraps
 * input validation, the handler and output validation in one try/catch that
 * re-throws only `UrlElicitationRequired` and turns everything else into
 * `createToolError(message)` — measured against
 * `@modelcontextprotocol/server@2.0.0`. Wrapping that handler does not work
 * either: `Server._wrapHandler` verifies and DECODES `requestState` before
 * calling it, so a second pass through the same wrapper sees an already-decoded
 * payload where it expects the raw string and refuses every multi-round-trip
 * retry with `-32602`. Measured, by breaking it.
 *
 * So the answer is produced where `protocol-gate.ts` produces its `-32022`, for
 * the same stated reason and in the same shape: at the transport, where a
 * JSON-RPC error is simply a message. The handler parks the refusal under its
 * request id; this swaps the outbound result for the error.
 *
 * The parked payload rides along in `data.result`, so the typed
 * `atlas.error:v1` record and the audit receipt the tool's own contract
 * requires on every outcome survive the change of channel.
 */

export type CapabilityRefusal = {
  /** The `ClientCapabilities` SHAPE the spec's `data` member requires, not a name list. */
  requiredCapabilities: Record<string, unknown>;
  message: string;
  /** The typed contract payload the in-band form would have carried. */
  result: Record<string, unknown>;
};

/**
 * Refusals awaiting their outbound response, keyed by JSON-RPC request id.
 *
 * A `Map` and not a `WeakMap`: the key is an id, not an object, and the entry
 * is consumed by the response that answers that id. `take` deletes on read, so
 * a served refusal cannot be replayed onto a later response that happens to
 * reuse the id.
 */
export class CapabilityRefusalSink {
  private readonly parked = new Map<string | number, CapabilityRefusal>();

  park(id: string | number, refusal: CapabilityRefusal): void {
    this.parked.set(id, refusal);
  }

  take(id: string | number): CapabilityRefusal | undefined {
    const refusal = this.parked.get(id);
    if (refusal !== undefined) this.parked.delete(id);
    return refusal;
  }

  /** Outstanding entries. Asserted in tests, so a leak is a failure and not a slow growth. */
  get size(): number {
    return this.parked.size;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Decide one outbound message.
 *
 * A pure function over wire bytes, like `gateInbound`, so the rule is testable
 * without a transport. Only a RESULT response is swapped: an error response for
 * the same id is already an error, and replacing one error with another would
 * hide whatever actually went wrong.
 */
export function capabilityErrorFor(message: unknown, sink: CapabilityRefusalSink): unknown | undefined {
  if (!isRecord(message)) return undefined;
  const id = message["id"];
  if (typeof id !== "string" && typeof id !== "number") return undefined;
  if (!("result" in message)) return undefined;

  const refusal = sink.take(id);
  if (refusal === undefined) return undefined;

  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: ProtocolErrorCode.MissingRequiredClientCapability,
      message: refusal.message,
      data: { requiredCapabilities: refusal.requiredCapabilities, result: refusal.result }
    }
  };
}

/** Wrap a transport so a parked capability refusal replaces its own response. */
export function capabilityRefusalTransport(inner: Transport, sink: CapabilityRefusalSink): Transport {
  const decorated: Transport = {
    start: () => inner.start(),
    close: () => inner.close(),
    send: (message: JSONRPCMessage, sendOptions?: Parameters<Transport["send"]>[1]) => {
      const replacement = capabilityErrorFor(message, sink);
      // The cast is confined to this line: `capabilityErrorFor` builds a
      // well-formed JSON-RPC error response by construction above.
      return inner.send((replacement ?? message) as JSONRPCMessage, sendOptions);
    },
    get sessionId() {
      return inner.sessionId;
    },
    setProtocolVersion: inner.setProtocolVersion?.bind(inner),
    setSupportedProtocolVersions: inner.setSupportedProtocolVersions?.bind(inner)
  };

  inner.onclose = () => decorated.onclose?.();
  inner.onerror = (error: Error) => decorated.onerror?.(error);
  inner.onmessage = (message, extra) => decorated.onmessage?.(message, extra);

  return decorated;
}
