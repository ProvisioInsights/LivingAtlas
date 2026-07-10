import { describe, expect, it } from "vitest";
import {
  createLivingAtlasGraphService,
  describeGraphExecution,
  resolveKeyCustody,
  type LivingAtlasGraphExecutionContext
} from "./index";

const remoteSafeContext: LivingAtlasGraphExecutionContext = {
  ingress: "remote-http",
  access_mode: "remote-safe-only",
  authority_id: "la_authority_test0001"
};

describe("Living Atlas graph service", () => {
  it("dispatches canonical MCP tools through one shared service boundary", async () => {
    const calls: Array<{ toolName: string; context: LivingAtlasGraphExecutionContext }> = [];
    const service = createLivingAtlasGraphService({
      async execute(toolName, _args, context) {
        calls.push({ toolName, context });
        return {
          ok: true,
          toolName,
          ingress: context.ingress,
          access_mode: context.access_mode
        };
      }
    });

    await expect(service.callTool("object_read", { object_id: "la_object_test0001" }, remoteSafeContext)).resolves.toEqual({
      ok: true,
      toolName: "object_read",
      ingress: "remote-http",
      access_mode: "remote-safe-only"
    });
    expect(calls).toEqual([{ toolName: "object_read", context: remoteSafeContext }]);
  });

  it("rejects non-contract tool names before adapter execution", async () => {
    const service = createLivingAtlasGraphService({
      async execute() {
        throw new Error("adapter-should-not-run");
      }
    });

    await expect(service.callTool(["remote", "graph", "read"].join("_"), {}, remoteSafeContext)).rejects.toThrow("unknown-tool");
  });

  it("dispatches resolution_apply only on the local stdio ingress", async () => {
    const calls: Array<{ toolName: string; context: LivingAtlasGraphExecutionContext }> = [];
    const service = createLivingAtlasGraphService({
      async execute(toolName, _args, context) {
        calls.push({ toolName, context });
        return { ok: true, toolName };
      }
    });
    const localContext: LivingAtlasGraphExecutionContext = {
      ingress: "local-stdio",
      access_mode: "local-keyholding-only"
    };

    await expect(service.callTool("resolution_apply", {}, localContext)).resolves.toEqual({
      ok: true,
      toolName: "resolution_apply"
    });
    expect(calls).toEqual([{ toolName: "resolution_apply", context: localContext }]);
    await expect(service.callTool("resolution_apply", {}, remoteSafeContext)).rejects.toThrow("local-only-tool");
  });

  it("describes key custody by ingress and mode", () => {
    expect(resolveKeyCustody({
      ingress: "local-stdio",
      access_mode: "local-keyholding-only"
    })).toBe("local-keyholding");
    expect(resolveKeyCustody({
      ingress: "remote-http",
      access_mode: "cloud-unlock-session",
      cloud_unlock_key_present: true
    })).toBe("transient-cloud-unlock");
    expect(resolveKeyCustody(remoteSafeContext)).toBe("host-blind");

    expect(describeGraphExecution({
      ingress: "remote-http",
      access_mode: "cloud-unlock-session",
      cloud_unlock_key_present: true
    })).toEqual({
      ingress: "remote-http",
      access_mode: "cloud-unlock-session",
      key_custody: "transient-cloud-unlock",
      sensitive_plaintext_available: true,
      host_blind_sensitive_plaintext: false
    });
  });

  it("runs object batches through single-item adapter calls with usage estimates", async () => {
    const calls: Array<{ toolName: string; args: unknown }> = [];
    const service = createLivingAtlasGraphService({
      async execute(toolName, args) {
        calls.push({ toolName, args });
        return { ok: true, toolName };
      }
    });

    await expect(service.callTool("object_batch", {
      authority_id: "la_authority_test0001",
      idempotency_key: "la_idem_batch_objects_0001",
      items: [
        {
          op: "create",
          object: {
            authority_id: "la_authority_test0001",
            object_id: "la_object_batch0001"
          }
        },
        {
          op: "update",
          object_id: "la_object_batch0001",
          patch: { visible_metadata: { size_class: "small" } }
        },
        {
          op: "delete",
          object_id: "la_object_batch0001",
          expected_version: 2,
          idempotency_key: "la_idem_delete_item_0001"
        }
      ]
    }, remoteSafeContext)).resolves.toMatchObject({
      ok: true,
      batch_kind: "object",
      requested_items: 3,
      accepted_items: 3,
      failed_items: 0,
      usage_estimate: {
        worker_requests_used: 1,
        worker_requests_saved_vs_single_item: 2,
        d1_rows_written_are_per_item: true,
        r2_operations_are_per_item: true
      },
      results: [
        { index: 0, op: "create", ok: true, tool: "object_create", idempotency_key: "la_idem_batch_objects_0001_0" },
        { index: 1, op: "update", ok: true, tool: "object_update", idempotency_key: "la_idem_batch_objects_0001_1" },
        { index: 2, op: "delete", ok: true, tool: "object_delete", idempotency_key: "la_idem_delete_item_0001" }
      ]
    });

    expect(calls.map((call) => call.toolName)).toEqual(["object_create", "object_update", "object_delete"]);
  });

  it("runs edge batches through edge-specific adapter calls", async () => {
    const calls: Array<{ toolName: string; args: unknown }> = [];
    const service = createLivingAtlasGraphService({
      async execute(toolName, args) {
        calls.push({ toolName, args });
        return { ok: true, toolName };
      }
    });

    await expect(service.callTool("edge_batch", {
      authority_id: "la_authority_test0001",
      items: [
        { op: "create", edge: { edge_id: "la_edge_batch0001" } },
        { op: "update", edge_id: "la_edge_batch0001", patch: { status: "ended" } },
        { op: "delete", edge_id: "la_edge_batch0001" }
      ]
    }, {
      ingress: "local-stdio",
      access_mode: "local-keyholding-only"
    })).resolves.toMatchObject({
      ok: true,
      batch_kind: "edge",
      requested_items: 3,
      accepted_items: 3,
      results: [
        { index: 0, op: "create", ok: true, tool: "edge_create" },
        { index: 1, op: "update", ok: true, tool: "edge_update" },
        { index: 2, op: "delete", ok: true, tool: "edge_delete" }
      ]
    });

    expect(calls.map((call) => call.toolName)).toEqual(["edge_create", "edge_update", "edge_delete"]);
  });

  it("caps remote batches conservatively for Cloudflare free-tier subrequest safety", async () => {
    const service = createLivingAtlasGraphService({
      async execute() {
        return { ok: true };
      }
    });

    await expect(service.callTool("object_batch", {
      authority_id: "la_authority_test0001",
      items: Array.from({ length: 11 }, (_, index) => ({
        op: "delete",
        object_id: `la_object_batch${String(index).padStart(4, "0")}`
      }))
    }, remoteSafeContext)).rejects.toThrow("batch-too-large:max-items:10");
  });

  it("rejects item authority mismatches inside a batch", async () => {
    const service = createLivingAtlasGraphService({
      async execute() {
        throw new Error("adapter-should-not-run");
      }
    });

    await expect(service.callTool("edge_batch", {
      authority_id: "la_authority_test0001",
      items: [
        {
          op: "delete",
          authority_id: "la_authority_other0001",
          edge_id: "la_edge_batch0001"
        }
      ]
    }, remoteSafeContext)).resolves.toMatchObject({
      ok: false,
      requested_items: 1,
      accepted_items: 0,
      failed_items: 1,
      results: [
        {
          index: 0,
          op: "delete",
          ok: false,
          tool: "edge_delete",
          error: "batch-authority-mismatch"
        }
      ]
    });
  });
});
