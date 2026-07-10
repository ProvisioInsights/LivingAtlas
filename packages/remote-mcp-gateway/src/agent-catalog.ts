import {
  RemoteLivingAtlasMcpToolDefinitions,
  RemoteLivingAtlasMcpToolNames,
  type RemoteLivingAtlasMcpToolName
} from "@living-atlas/mcp-contract";

/**
 * The identity injected end-to-end-encrypted by `@cloudflare/workers-oauth-provider`
 * as `ctx.props` and surfaced on the agent as `this.props`. Populated by the
 * `defaultHandler` at authorize time (see `auth-handler.ts`).
 */
export type GatewayProps = {
  capability_id: string;
  authority_id: string;
};

export type ToolRegistration = {
  name: string;
  description: string;
  capability_id: string;
};

/**
 * Worker environment bindings for the gateway. Declared in this runtime-free
 * module (no `agents/mcp` / `cloudflare:` imports) so both the DO agent
 * (`agent.ts`) and the node-loadable `defaultHandler` (`auth-handler.ts`) can
 * share the single source of truth without dragging in the Workers runtime.
 */
export type GatewayEnv = {
  LA_CAPABILITY_POLICY_JSON?: string;
  LA_REVOCATION_JSON?: string;
  LA_REDACTION_JSON?: string;
  LA_CLOUD_UNLOCK_KEY?: string; // T1 secret (Cloudflare secret)
  LA_GRANT_SIGNING_KEY?: string; // escalation grant HMAC key (Cloudflare secret)
  LA_ORACLE_URL?: string;
  OAUTH_KV: KVNamespace;
};

/**
 * Pure, node-unit-testable projection of the `mcp-contract` catalog onto the
 * gateway's `remote_`-prefixed surface. Kept in this Workers-runtime-free module
 * (no `agents/mcp` / `cloudflare:` imports) so Task 21/22 can assert catalog
 * parity under plain node vitest — drift from `mcp-contract` fails the build
 * without needing a Durable Object. The `McpAgent` subclass in `agent.ts`
 * imports these to drive its `McpServer.tool` registrations.
 */
export function remoteToolNames(): string[] {
  return RemoteLivingAtlasMcpToolNames.map((name) => `remote_${name}`);
}

export function toRemoteToolName(name: RemoteLivingAtlasMcpToolName): string {
  return `remote_${name}`;
}

export function buildToolRegistrations(props: GatewayProps): ToolRegistration[] {
  return RemoteLivingAtlasMcpToolDefinitions.map((def) => ({
    name: `remote_${def.name}`,
    description: def.description,
    capability_id: props.capability_id
  }));
}

/**
 * Long-running tools whose handlers stream interim progress (Task 24). All other
 * tools return a single result frame. Kept here (runtime-free) so the streaming
 * predicate is inspectable and reusable without loading the DO agent.
 */
export const STREAMING_TOOL_NAMES: ReadonlySet<string> = new Set([
  "remote_search",
  "remote_traverse",
  "remote_timeline"
]);

export function isStreamingTool(toolName: string): boolean {
  return STREAMING_TOOL_NAMES.has(toolName);
}
