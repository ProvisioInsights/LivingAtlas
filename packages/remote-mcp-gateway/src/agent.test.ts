import { describe, expect, it } from "vitest";
import {
  remoteToolNames,
  toRemoteToolName,
  buildToolRegistrations,
  isStreamingTool,
  type GatewayProps
} from "./agent-catalog";
import { RemoteLivingAtlasMcpToolNames, RemoteLivingAtlasMcpToolDefinitions } from "@living-atlas/mcp-contract";

describe("gateway agent tool surface", () => {
  it("exposes exactly the mcp-contract catalog, prefixed remote_", () => {
    expect(remoteToolNames()).toEqual(RemoteLivingAtlasMcpToolNames.map((n) => `remote_${n}`));
  });

  it("does not expose local-only semantic resolution through the gateway", () => {
    const props: GatewayProps = { capability_id: "la_cap_owner0001", authority_id: "la_authority_worker0001" };
    expect(remoteToolNames()).not.toContain("remote_resolution_apply");
    expect(buildToolRegistrations(props).map((registration) => registration.name)).not.toContain("remote_resolution_apply");
  });

  it("prefixes a single tool name deterministically", () => {
    expect(toRemoteToolName("search")).toBe("remote_search");
    expect(toRemoteToolName("sensitive_decrypt")).toBe("remote_sensitive_decrypt");
  });

  it("builds one registration per catalog tool and closes over the caller's capability", () => {
    const props: GatewayProps = { capability_id: "la_cap_owner0001", authority_id: "la_authority_worker0001" };
    const regs = buildToolRegistrations(props);
    expect(regs).toHaveLength(remoteToolNames().length);
    expect(regs.every((r) => r.name.startsWith("remote_"))).toBe(true);
    expect(regs[0]?.capability_id).toBe("la_cap_owner0001");
  });

  it("carries the mcp-contract description onto each registration (no drift)", () => {
    const props: GatewayProps = { capability_id: "c", authority_id: "a" };
    const regs = buildToolRegistrations(props);
    for (const def of RemoteLivingAtlasMcpToolDefinitions) {
      const reg = regs.find((r) => r.name === `remote_${def.name}`);
      expect(reg?.description).toBe(def.description);
    }
  });

  it("marks only the long read tools as streaming", () => {
    expect(isStreamingTool("remote_search")).toBe(true);
    expect(isStreamingTool("remote_traverse")).toBe(true);
    expect(isStreamingTool("remote_timeline")).toBe(true);
    expect(isStreamingTool("remote_object_read")).toBe(false);
    expect(isStreamingTool("remote_sensitive_decrypt")).toBe(false);
  });
});
