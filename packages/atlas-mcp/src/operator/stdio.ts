import { serveStdio, StdioServerTransport, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import type { Transport } from "@modelcontextprotocol/server";
import { CONTRACT_PROTOCOL_VERSION } from "@living-atlas/atlas-contract";
import { gateTransport, type GateRejection } from "../protocol-gate.js";
import { buildOperatorServer, type OperatorServerOptions } from "./server.js";

/**
 * The operator plane's stdio entry.
 *
 * The same two refusals as the consumer plane, from the same shared gate: the
 * SDK's `legacy: 'reject'` refuses a 2025-era opening, and `gateTransport`
 * refuses a request whose envelope names a revision this server does not speak
 * — which the SDK does not check. Shared rather than reimplemented, because two
 * copies of a protocol gate are two gates that can drift, and the one that
 * drifts is the one nobody is looking at.
 */

export const OPERATOR_SUPPORTED_PROTOCOL_VERSIONS = [CONTRACT_PROTOCOL_VERSION] as const;

export type ServeOperatorStdioOptions = OperatorServerOptions & {
  /** Defaults to a transport over this process's stdio. */
  transport?: Transport;
  onerror?: (error: Error) => void;
  /** Gate refusals never reach a tool, so they never reach the audit log. */
  onProtocolRejection?: (rejection: GateRejection) => void;
};

export function serveOperatorStdio(options: ServeOperatorStdioOptions): StdioServerHandle {
  const inner = options.transport ?? new StdioServerTransport();
  const transport = gateTransport(
    inner,
    { supportedVersions: OPERATOR_SUPPORTED_PROTOCOL_VERSIONS },
    options.onProtocolRejection
  );

  return serveStdio(() => buildOperatorServer(options).server, {
    legacy: "reject",
    transport,
    ...(options.onerror === undefined ? {} : { onerror: options.onerror })
  });
}
