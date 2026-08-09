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
 *  - The legacy era. When `SUPPORTED_LEGACY_PROTOCOL_VERSIONS` is non-empty the
 *    SDK runs `legacy: 'serve'` and serves a 2025-era `initialize` as a legacy
 *    connection; the gate narrows that to exactly the admitted revisions. When
 *    the list is empty the SDK runs `legacy: 'reject'` and answers a 2025-era
 *    opening with `-32022`, which is the original modern-only behaviour. The two
 *    layers read ONE constant, so the era is a single edit either way.
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
 * THE SUNSET SWITCH. The 2025-era revisions this server serves as a transitional
 * legacy connection, and the single place the era is decided.
 *
 * `2025-11-25` is here because that is the revision Claude Desktop's `initialize`
 * negotiates on the wire, even from a bundle carrying 2026-07-28 code — verified
 * from the server's own stderr, not assumed. Reads work over it; the in-band MRTR
 * reveal does not (it needs the modern envelope and elicitation capability) and
 * falls to the documented `-32021`, which does not affect reading local-private
 * content. See ADR 0034.
 *
 * This is TRANSITIONAL. The condition to remove it is that clients open without a
 * legacy `initialize` — i.e. Claude Desktop negotiates 2026-07-28 on the wire.
 * When that holds, set this to `[]`: the SDK reverts to `legacy:'reject'` and the
 * gate stops admitting any legacy opening, restoring the modern-only server
 * exactly. Both layers read this one constant, so sunset is that single edit.
 */
export const SUPPORTED_LEGACY_PROTOCOL_VERSIONS: readonly string[] = ["2025-11-25"];

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
    gateTransport(
      inner,
      { supportedVersions: SUPPORTED_PROTOCOL_VERSIONS, legacyVersions: SUPPORTED_LEGACY_PROTOCOL_VERSIONS },
      options.onProtocolRejection
    ),
    capabilityRefusals
  );

  return serveStdio(() => buildAtlasServer({ ...options, capabilityRefusals }).server, {
    // Driven by the one switch above: `serve` while a legacy era is admitted,
    // `reject` when the list is emptied at sunset. The gate narrows `serve` to
    // the admitted revisions; without the gate, `serve` would admit every
    // 2025-era opening.
    legacy: SUPPORTED_LEGACY_PROTOCOL_VERSIONS.length > 0 ? "serve" : "reject",
    transport,
    ...(options.onerror === undefined ? {} : { onerror: options.onerror })
  });
}
