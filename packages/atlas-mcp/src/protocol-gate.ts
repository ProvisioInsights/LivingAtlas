import {
  CLIENT_CAPABILITIES_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  ProtocolErrorCode,
  type JSONRPCMessage,
  type Transport
} from "@modelcontextprotocol/server";

/**
 * Per-request protocol-version negotiation, which the SDK does not do.
 *
 * Measured against `@modelcontextprotocol/server@2.0.0`: `serveStdio` with
 * `legacy: 'reject'` refuses a 2025-era OPENING (an `initialize`, or a request
 * carrying no `_meta` envelope at all) with `-32022`. It does NOT look at the
 * VALUE of `io.modelcontextprotocol/protocolVersion` once an envelope is
 * present — a request naming `2019-01-01`, `2025-06-18`, `not-a-date` or the
 * empty string is dispatched and answered as though it had named 2026-07-28.
 * The classifier asks whether an envelope exists, never whether the revision it
 * names is one this server speaks.
 *
 * That is exactly the failure mode the single-revision decision exists to
 * prevent. A consumer that believes it is talking 2025 gets 2026 answers whose
 * `resultType`, `ttlMs` and `cacheScope` it has no vocabulary for, and reads
 * them as an unrecognised server rather than as a version mismatch it could
 * fix. So the gate runs BEFORE the SDK sees the message.
 *
 * It is a transport decorator rather than a request handler because the answer
 * has to be a JSON-RPC ERROR. A `ProtocolError` thrown inside a tool handler
 * does not reach the wire as one: `McpServer` flattens any handler throw into
 * `{ isError: true, content: [{ text: <message> }] }`, so the numeric code —
 * the only part a client can branch on — is lost. Verified by running it.
 */

/** The single revision this server speaks. There is no legacy era and no dual era. */
export type ProtocolGateOptions = {
  supportedVersions: readonly string[];
  /**
   * Methods answered without an envelope check. Empty by design: the 2026-07-28
   * revision has no handshake, so there is no request that legitimately arrives
   * before version agreement. The option exists so that adding an exemption is a
   * visible, reviewable act rather than a quiet edit inside the matcher.
   */
  exemptMethods?: readonly string[];
};

export type GateRejection = {
  id: string | number;
  method: string;
  code: ProtocolErrorCode;
  requested?: string;
};

/**
 * What the gate decided about one inbound message.
 *
 * `pass` covers notifications and responses too: the gate only ever refuses
 * REQUESTS, because a refusal needs an `id` to answer on. A notification with a
 * bad envelope is dropped by the SDK's own classifier; inventing an error
 * response for it would put an unmatched id on the wire.
 */
export type GateDecision = { kind: "pass" } | { kind: "reject"; response: unknown; rejection: GateRejection };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A JSON-RPC request, structurally. Deliberately not the SDK's `isJSONRPCRequest`
 * type guard: that one parses against the full request schema, and a message
 * this gate must refuse is frequently one that would fail that parse. The gate
 * needs the id and the method off a possibly-malformed envelope, and nothing
 * more.
 */
function requestShape(message: unknown): { id: string | number; method: string; params: unknown } | undefined {
  if (!isRecord(message)) return undefined;
  const { id, method } = message;
  if (typeof method !== "string") return undefined;
  if (typeof id !== "string" && typeof id !== "number") return undefined;
  return { id, method, params: message["params"] };
}

function errorResponse(id: string | number, code: ProtocolErrorCode, message: string, data: unknown): unknown {
  return { jsonrpc: "2.0", id, error: { code, message, data } };
}

/**
 * Decide one inbound message.
 *
 * Exported separately from the transport wrapper so the rule can be tested as a
 * pure function against literal wire bytes — the wrapper only decides where the
 * answer goes.
 */
export function gateInbound(message: unknown, options: ProtocolGateOptions): GateDecision {
  const request = requestShape(message);
  if (!request) return { kind: "pass" };
  if (options.exemptMethods?.includes(request.method)) return { kind: "pass" };

  const params = isRecord(request.params) ? request.params : undefined;
  const meta = params && isRecord(params["_meta"]) ? params["_meta"] : undefined;
  const requested = meta?.[PROTOCOL_VERSION_META_KEY];

  // No envelope at all is the SDK's own case and it already answers -32022 for
  // it. Passing it through keeps ONE answer for that shape rather than two
  // implementations that can drift; the gate exists for the value check the SDK
  // does not perform.
  if (requested === undefined) return { kind: "pass" };

  if (typeof requested !== "string" || !options.supportedVersions.includes(requested)) {
    const named = typeof requested === "string" ? requested : JSON.stringify(requested);
    return {
      kind: "reject",
      rejection: {
        id: request.id,
        method: request.method,
        code: ProtocolErrorCode.UnsupportedProtocolVersion,
        ...(typeof requested === "string" ? { requested } : {})
      },
      response: errorResponse(
        request.id,
        ProtocolErrorCode.UnsupportedProtocolVersion,
        `Unsupported protocol version: ${named}`,
        // Both members, always. `supported` alone tells a client what to try;
        // `requested` is what lets it tell a version it chose from a version
        // some proxy rewrote underneath it.
        { supported: [...options.supportedVersions], requested: named }
      )
    };
  }

  // `clientCapabilities` is REQUIRED on every 2026-07-28 request. The SDK
  // enforces it (as `-32602`) — asserted by a test here, because the whole
  // reason this gate exists is that one envelope rule turned out to be
  // unenforced, and an assumption about the other one is the same bet.
  if (meta?.[CLIENT_CAPABILITIES_META_KEY] === undefined) return { kind: "pass" };

  return { kind: "pass" };
}

/**
 * Wrap a transport so every inbound message passes the gate first.
 *
 * The wrapper owns `onmessage`: the SDK's serving entry assigns to the wrapper,
 * and the wrapper assigns to the inner transport. A rejected message is answered
 * on the same transport and never forwarded, so no handler and no audit sink
 * ever observes a request the server refused to speak the version of.
 */
export function gateTransport(
  inner: Transport,
  options: ProtocolGateOptions,
  onReject?: (rejection: GateRejection) => void
): Transport {
  const gated: Transport = {
    start: () => inner.start(),
    close: () => inner.close(),
    send: (message: JSONRPCMessage, sendOptions?: Parameters<Transport["send"]>[1]) => inner.send(message, sendOptions),
    get sessionId() {
      return inner.sessionId;
    },
    setProtocolVersion: inner.setProtocolVersion?.bind(inner),
    setSupportedProtocolVersions: inner.setSupportedProtocolVersions?.bind(inner)
  };

  inner.onclose = () => gated.onclose?.();
  inner.onerror = (error: Error) => gated.onerror?.(error);
  inner.onmessage = (message, extra) => {
    const decision = gateInbound(message, options);
    if (decision.kind === "pass") {
      gated.onmessage?.(message, extra);
      return;
    }
    onReject?.(decision.rejection);
    // Answered directly on the wire. `send` takes the SDK's message type; the
    // refusal is a well-formed JSON-RPC error response by construction above,
    // and the cast is confined to this one line rather than widening the type
    // of everything the gate builds.
    void inner.send(decision.response as JSONRPCMessage);
  };

  return gated;
}
