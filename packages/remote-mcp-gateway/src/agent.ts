import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RemoteLivingAtlasMcpToolDefinitions } from "@living-atlas/mcp-contract";
import {
  buildToolRegistrations,
  isStreamingTool,
  remoteToolNames,
  toRemoteToolName,
  type GatewayEnv,
  type GatewayProps,
  type ToolRegistration
} from "./agent-catalog";
import { loadCapabilityPolicy, type CapabilityPolicy } from "./policy";
import { parseRevocationSet, isRevoked, recordT2Decrypt, type GuardrailSinks } from "./guardrails";
import { loadRedactionRules, applyRedaction } from "./redaction";
import { signEscalationGrant } from "./grant";
import { callDecryptionOracle } from "./oracle-client";
import { resolveDecrypt, type ResolveDecryptResult } from "./decrypt-resolver";
import { runStreamingTool, type ProgressNotification } from "./streaming";

export {
  buildToolRegistrations,
  remoteToolNames,
  toRemoteToolName,
  isStreamingTool
};
export type { GatewayEnv, GatewayProps, ToolRegistration };

/**
 * Resolve the effective per-request policy from the caller's capability against
 * the provider-generic policy config, failing safe (`remote-safe-only`) when the
 * capability is unknown or config is absent. Pure — unit-tested via `policy.ts`.
 */
export function resolveRequestPolicy(env: GatewayEnv, props: GatewayProps): CapabilityPolicy {
  return loadCapabilityPolicy(env.LA_CAPABILITY_POLICY_JSON, props.capability_id);
}

/**
 * NOT runtime-verified — requires a Workers runtime (`wrangler dev`) + a live
 * Durable Object to exercise. This module statically imports `agents/mcp`, which
 * pulls `cloudflare:`-scheme modules that plain-node vitest cannot load; that is
 * why the tool-catalog and decision logic live in runtime-free siblings
 * (`agent-catalog.ts`, `policy.ts`, `guardrails.ts`, `redaction.ts`,
 * `decrypt-resolver.ts`, `streaming.ts`) which ARE node-unit-tested. This class
 * only wires those tested units onto `McpServer.tool`.
 *
 * `McpAgent.serve("/mcp")` (Task 23) mounts this as the OAuthProvider `apiHandler`.
 * Resumability + `Last-Event-ID` replay come free from the agents SDK:
 * `McpAgent#getEventStore()` defaults to a `DurableObjectEventStore` backed by
 * this agent's storage (agents 0.17.3, `dist/mcp/index.d.ts`) — no event store is
 * hand-rolled here (OPEN QUESTION #2).
 */
export class LivingAtlasRemoteMcp extends McpAgent<GatewayEnv, unknown, GatewayProps> {
  server = new McpServer({ name: "living-atlas-remote-mcp", version: "0.1.0" });

  async init(): Promise<void> {
    // `this.props` is optional on McpAgent (agents 0.17.3); the OAuthProvider
    // guarantees it for an authorized session, but fail safe if it is absent.
    const props: GatewayProps = this.props ?? { capability_id: "", authority_id: "" };
    const env = this.env;

    for (const def of RemoteLivingAtlasMcpToolDefinitions) {
      const toolName = `remote_${def.name}`;
      this.server.tool(toolName, def.description, {}, async (_args: unknown, extra: unknown) => {
        // Kill switch: a revoked capability is dropped before any work or oracle
        // contact (guardrails.isRevoked, unit-tested in guardrails.test.ts).
        const revoked = parseRevocationSet(env.LA_REVOCATION_JSON);
        if (isRevoked(revoked, props.capability_id)) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ ok: false, reason: "capability-revoked" }) }],
            isError: true
          };
        }

        const policy = resolveRequestPolicy(env, props);

        // Streaming tools yield interim progress via the SDK's per-request
        // `sendNotification` (RequestHandlerExtra, @modelcontextprotocol/sdk
        // 1.29.0 shared/protocol.d.ts). `runStreamingTool` is unit-tested;
        // forwarding through the live transport is NOT runtime-verified here.
        if (isStreamingTool(toolName)) {
          const sendProgress = notificationSender(extra);
          await runStreamingTool({
            totalSteps: 1,
            onProgress: sendProgress,
            work: async () => ({ tool: toolName })
          });
        }

        // Redaction hook (off by default; guardrails.redaction unit-tested).
        const redaction = loadRedactionRules(env.LA_REDACTION_JSON);
        const payload = applyRedaction(redaction, {
          ok: true,
          tool: toolName,
          capability_id: policy.capability_id,
          tier_ceiling: policy.tier_ceiling
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
      });
    }
  }
}

/**
 * Adapts the SDK request handler `extra.sendNotification` into the progress
 * callback shape `runStreamingTool` expects, forwarding a
 * `notifications/progress` frame keyed by the request's `progressToken`
 * (`RequestHandlerExtra._meta.progressToken`, @modelcontextprotocol/sdk 1.29.0).
 * Kept out of `init` so the mapping is inspectable; the actual `sendNotification`
 * is exercised at runtime only.
 */
function notificationSender(extra: unknown): (p: ProgressNotification) => Promise<void> {
  const send = extra as
    | { sendNotification?: (n: unknown) => Promise<void>; _meta?: { progressToken?: string | number } }
    | undefined;
  const progressToken = send?._meta?.progressToken;
  return async (p: ProgressNotification) => {
    if (!send?.sendNotification || progressToken === undefined) {
      return;
    }
    await send.sendNotification({
      method: "notifications/progress",
      params: { progressToken, progress: p.progress, total: p.total }
    });
  };
}

// Re-export the resolver pipeline pieces the deploy-time escalation handler binds
// together, so the T2 path (sign grant -> call oracle -> record) is assembled
// from the already-tested units rather than re-implemented in the DO.
export { resolveDecrypt, signEscalationGrant, callDecryptionOracle, recordT2Decrypt };
export type { ResolveDecryptResult, GuardrailSinks };
