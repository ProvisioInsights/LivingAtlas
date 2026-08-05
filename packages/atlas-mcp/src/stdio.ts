import { serveStdio, StdioServerTransport, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import type { Transport } from "@modelcontextprotocol/server";
import { CONTRACT_PROTOCOL_VERSION } from "@living-atlas/atlas-contract";
import { CapabilityRefusalSink, capabilityRefusalTransport } from "./capability-refusal.js";
import { buildAtlasServer, type AtlasServerOptions } from "./server.js";
import { gateTransport, type GateRejection } from "./protocol-gate.js";

/**
 * The stdio entry.
 *
 * Three answers the SDK does not produce on its own, all at the transport,
 * because all three have to reach the wire as JSON-RPC ERRORS and a throw
 * inside a handler does not: `McpServer` flattens it into
 * `{isError, content:[text]}` and the numeric code — the only part a client can
 * branch on — is lost.
 *
 *  - `legacy: 'reject'` refuses a 2025-era OPENING. An `initialize` request, or
 *    any request carrying no `_meta` envelope, is answered `-32022` naming the
 *    supported revisions and the connection stays open for a modern opening.
 *    This is the SDK's own behaviour and it works.
 *
 *  - `gateTransport` refuses a request whose envelope NAMES a revision this
 *    server does not speak. The SDK does not check that value at all — verified
 *    against 2.0.0 — so without the gate a request declaring `2019-01-01` is
 *    served 2026-07-28 answers.
 *
 *  - `capabilityRefusalTransport` turns a parked capability refusal into
 *    `-32021`, which the spec makes a MUST for a request needing a capability
 *    the client did not declare.
 *
 * Order matters: the version gate is INBOUND and the capability swap is
 * OUTBOUND, so the capability decorator wraps the gate rather than the reverse.
 * A request the gate refused never reaches a handler, so it can never have a
 * parked refusal, and its `-32022` passes straight out.
 */

export const SUPPORTED_PROTOCOL_VERSIONS = [CONTRACT_PROTOCOL_VERSION] as const;

/**
 * `capabilityRefusals` is deliberately NOT an input: this entry owns the
 * sink, because the sink is only meaningful once it is wired to a transport,
 * and a caller that supplied one without wiring it would get a server that
 * silently never raises `-32021`.
 */
export type ServeAtlasStdioOptions = Omit<AtlasServerOptions, "capabilityRefusals"> & {
  /** Defaults to a transport over this process's stdio. */
  transport?: Transport;
  onerror?: (error: Error) => void;
  /** Observability for gate refusals. They never reach a tool, so they never reach the audit log. */
  onProtocolRejection?: (rejection: GateRejection) => void;
};

export function serveAtlasStdio(options: ServeAtlasStdioOptions): StdioServerHandle {
  const inner = options.transport ?? new StdioServerTransport();
  const capabilityRefusals = new CapabilityRefusalSink();
  const transport = capabilityRefusalTransport(
    gateTransport(inner, { supportedVersions: SUPPORTED_PROTOCOL_VERSIONS }, options.onProtocolRejection),
    capabilityRefusals
  );

  return serveStdio(() => buildAtlasServer({ ...options, capabilityRefusals }).server, {
    legacy: "reject",
    transport,
    ...(options.onerror === undefined ? {} : { onerror: options.onerror })
  });
}
