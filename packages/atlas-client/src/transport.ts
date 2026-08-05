/**
 * The seam between "what Atlas means" and "how the bytes travelled".
 *
 * The interface is deliberately narrow — one request in, one response out — and
 * deliberately dumb: it knows nothing about `_meta`, credentials, contract
 * revisions or tools. Every rule that could differ between two deployments lives
 * above it, in `AtlasConsumerClient`, so a correct consumer NEVER branches on
 * how it connected. That is the same rule the server states from its side
 * (`grant.ts`: "nothing in this type names a transport, and nothing may"), and
 * it is the property that makes transport parity testable rather than
 * aspirational: the identical client object, driven identically, over two
 * transports.
 *
 * `request`, not `send` + `onmessage`. MCP 2026-07-28's multi-round-trip flow
 * returns its `inputRequests` INSIDE the tool result rather than as a
 * server-initiated JSON-RPC request, so every message this client cares about is
 * client-initiated and correlation belongs to whoever owns the socket. A future
 * transport that must carry server-initiated requests adds a member here; it
 * does not need this one to change shape.
 *
 * Only the stdio transport ships in this package today. The HTTP transport
 * belongs to whoever lands the Streamable HTTP surface — it implements THIS
 * interface, and everything above the seam, including every test that drives a
 * journey, is reused unchanged. Nothing in `client.ts` reads a URL, a header, a
 * pipe, or a process handle.
 */

export type JsonRpcId = string | number;

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
};

export type JsonRpcErrorBody = { code: number; message: string; data?: unknown };

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: Record<string, unknown>;
  error?: JsonRpcErrorBody;
};

export type AtlasTransport = {
  /** A name for diagnostics only. Nothing may branch on it. */
  readonly description: string;
  /** Send one request and resolve with the response carrying the same id. */
  request(message: JsonRpcRequest, options?: { signal?: AbortSignal }): Promise<JsonRpcResponse>;
  close(): Promise<void>;
};
