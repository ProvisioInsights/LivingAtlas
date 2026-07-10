import type { AccessMode } from "@living-atlas/contracts";
import {
  LivingAtlasMcpToolNames,
  type LivingAtlasMcpToolName
} from "@living-atlas/mcp-contract";

export * from "./canonical-assertions";

export type LivingAtlasIngress = "local-stdio" | "remote-http";
export type LivingAtlasKeyCustody = "local-keyholding" | "transient-cloud-unlock" | "host-blind";

export type LivingAtlasGraphExecutionContext = {
  ingress: LivingAtlasIngress;
  access_mode: AccessMode;
  authority_id?: string;
  client_id?: string;
  capability_id?: string;
  cloud_unlock_key_present?: boolean;
};

export type LivingAtlasGraphToolResult = unknown;

export type LivingAtlasGraphToolAdapter = {
  execute(
    toolName: LivingAtlasMcpToolName,
    args: unknown,
    context: LivingAtlasGraphExecutionContext
  ): Promise<LivingAtlasGraphToolResult>;
};

export type LivingAtlasGraphService = {
  callTool(
    toolName: string,
    args: unknown,
    context: LivingAtlasGraphExecutionContext
  ): Promise<LivingAtlasGraphToolResult>;
  describeExecution(context: LivingAtlasGraphExecutionContext): LivingAtlasGraphExecutionDescription;
};

export type LivingAtlasGraphExecutionDescription = {
  ingress: LivingAtlasIngress;
  access_mode: AccessMode;
  key_custody: LivingAtlasKeyCustody;
  sensitive_plaintext_available: boolean;
  host_blind_sensitive_plaintext: boolean;
};

export type LivingAtlasBatchOperation = "create" | "update" | "delete";

export type LivingAtlasBatchItemResult = {
  index: number;
  op: LivingAtlasBatchOperation;
  ok: boolean;
  tool: LivingAtlasMcpToolName;
  idempotency_key?: string;
  result?: unknown;
  error?: string;
};

export type LivingAtlasBatchResult = {
  ok: boolean;
  batch_kind: "object" | "edge";
  requested_items: number;
  accepted_items: number;
  failed_items: number;
  limits: {
    max_items: number;
    max_bytes: number;
    payload_bytes: number;
  };
  usage_estimate: {
    worker_requests_used: 1;
    worker_requests_saved_vs_single_item: number;
    d1_rows_written_are_per_item: true;
    r2_operations_are_per_item: true;
  };
  results: LivingAtlasBatchItemResult[];
};

const ToolNameSet = new Set<string>(LivingAtlasMcpToolNames);
const BatchToolNames = new Set<LivingAtlasMcpToolName>(["object_batch", "edge_batch"]);
const LocalOnlyToolNames = new Set<LivingAtlasMcpToolName>(["resolution_apply"]);
const BatchMaxBytes = 1024 * 1024;
const LocalBatchMaxItems = 100;
const RemoteBatchMaxItems = 10;

export function isLivingAtlasMcpToolName(value: string): value is LivingAtlasMcpToolName {
  return ToolNameSet.has(value);
}

export function resolveKeyCustody(context: LivingAtlasGraphExecutionContext): LivingAtlasKeyCustody {
  if (context.ingress === "local-stdio" || context.access_mode === "local-keyholding-only") {
    return "local-keyholding";
  }

  if (context.access_mode === "cloud-unlock-session" && context.cloud_unlock_key_present) {
    return "transient-cloud-unlock";
  }

  return "host-blind";
}

export function describeGraphExecution(context: LivingAtlasGraphExecutionContext): LivingAtlasGraphExecutionDescription {
  const keyCustody = resolveKeyCustody(context);
  return {
    ingress: context.ingress,
    access_mode: context.access_mode,
    key_custody: keyCustody,
    sensitive_plaintext_available: keyCustody === "local-keyholding" || keyCustody === "transient-cloud-unlock",
    host_blind_sensitive_plaintext: keyCustody !== "transient-cloud-unlock"
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function payloadBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function numericLimit(value: unknown, fallback: number, max: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? Math.min(value, max)
    : fallback;
}

function batchLimits(args: unknown, context: LivingAtlasGraphExecutionContext): { max_items: number; max_bytes: number; payload_bytes: number } {
  const defaultItems = context.ingress === "remote-http" ? RemoteBatchMaxItems : LocalBatchMaxItems;
  const limits = isRecord(args) && isRecord(args.limits) ? args.limits : {};
  return {
    max_items: numericLimit(limits.max_items, defaultItems, defaultItems),
    max_bytes: numericLimit(limits.max_bytes, BatchMaxBytes, BatchMaxBytes),
    payload_bytes: payloadBytes(args)
  };
}

function derivedBatchItemIdempotencyKey(batchKey: string, index: number): string {
  const safeBatchKey = batchKey.replace(/[^A-Za-z0-9_-]/g, "_");
  return safeBatchKey.startsWith("la_idem_")
    ? `${safeBatchKey}_${index}`
    : `la_idem_${safeBatchKey}_${index}`;
}

function itemIdempotencyKey(batchKey: string | undefined, item: Record<string, unknown>, index: number): string | undefined {
  if (typeof item.idempotency_key === "string" && item.idempotency_key) {
    return item.idempotency_key;
  }
  return batchKey ? derivedBatchItemIdempotencyKey(batchKey, index) : undefined;
}

function authorityForBatch(args: Record<string, unknown>, item: Record<string, unknown>): string | undefined {
  const itemAuthority = typeof item.authority_id === "string" ? item.authority_id : undefined;
  const batchAuthority = typeof args.authority_id === "string" ? args.authority_id : undefined;
  if (itemAuthority && batchAuthority && itemAuthority !== batchAuthority) {
    throw new Error("batch-authority-mismatch");
  }
  return itemAuthority ?? batchAuthority;
}

function objectToolForOperation(op: LivingAtlasBatchOperation): LivingAtlasMcpToolName {
  if (op === "create") {
    return "object_create";
  }
  if (op === "update") {
    return "object_update";
  }
  return "object_delete";
}

function edgeToolForOperation(op: LivingAtlasBatchOperation): LivingAtlasMcpToolName {
  if (op === "create") {
    return "edge_create";
  }
  if (op === "update") {
    return "edge_update";
  }
  return "edge_delete";
}

function normalizeObjectBatchArgs(args: Record<string, unknown>, item: Record<string, unknown>, index: number): { tool: LivingAtlasMcpToolName; op: LivingAtlasBatchOperation; args: Record<string, unknown> } {
  const op = item.op;
  if (op !== "create" && op !== "update" && op !== "delete") {
    throw new Error("invalid-batch-op");
  }
  const tool = objectToolForOperation(op);
  const authorityId = authorityForBatch(args, item);
  const idempotencyKey = itemIdempotencyKey(typeof args.idempotency_key === "string" ? args.idempotency_key : undefined, item, index);
  if (op === "create") {
    return {
      tool,
      op,
      args: {
        object: item.object,
        ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {})
      }
    };
  }
  return {
    tool,
    op,
    args: {
      authority_id: authorityId,
      object_id: item.object_id,
      ...(item.expected_version !== undefined ? { expected_version: item.expected_version } : {}),
      ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
      ...(op === "update" ? { patch: item.patch } : {})
    }
  };
}

function normalizeEdgeBatchArgs(args: Record<string, unknown>, item: Record<string, unknown>, index: number): { tool: LivingAtlasMcpToolName; op: LivingAtlasBatchOperation; args: Record<string, unknown> } {
  const op = item.op;
  if (op !== "create" && op !== "update" && op !== "delete") {
    throw new Error("invalid-batch-op");
  }
  const tool = edgeToolForOperation(op);
  const authorityId = authorityForBatch(args, item);
  const idempotencyKey = itemIdempotencyKey(typeof args.idempotency_key === "string" ? args.idempotency_key : undefined, item, index);
  if (op === "create") {
    return {
      tool,
      op,
      args: {
        authority_id: authorityId,
        edge: item.edge,
        ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {})
      }
    };
  }
  return {
    tool,
    op,
    args: {
      authority_id: authorityId,
      edge_id: item.edge_id,
      ...(item.expected_version !== undefined ? { expected_version: item.expected_version } : {}),
      ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
      ...(op === "update" ? { patch: item.patch } : {})
    }
  };
}

async function executeBatch(input: {
  kind: "object" | "edge";
  args: unknown;
  context: LivingAtlasGraphExecutionContext;
  adapter: LivingAtlasGraphToolAdapter;
}): Promise<LivingAtlasBatchResult> {
  if (!isRecord(input.args) || !Array.isArray(input.args.items)) {
    throw new Error("invalid-batch-request");
  }

  const limits = batchLimits(input.args, input.context);
  if (input.args.items.length > limits.max_items) {
    throw new Error(`batch-too-large:max-items:${limits.max_items}`);
  }
  if (limits.payload_bytes > limits.max_bytes) {
    throw new Error(`batch-too-large:max-bytes:${limits.max_bytes}`);
  }

  const results: LivingAtlasBatchItemResult[] = [];
  for (const [index, rawItem] of input.args.items.entries()) {
    let normalized: { tool: LivingAtlasMcpToolName; op: LivingAtlasBatchOperation; args: Record<string, unknown> } | undefined;
    if (!isRecord(rawItem)) {
      results.push({
        index,
        op: "create",
        ok: false,
        tool: input.kind === "object" ? "object_create" : "edge_create",
        error: "invalid-batch-item"
      });
      continue;
    }
    try {
      normalized = input.kind === "object"
        ? normalizeObjectBatchArgs(input.args, rawItem, index)
        : normalizeEdgeBatchArgs(input.args, rawItem, index);
      const result = await input.adapter.execute(normalized.tool, normalized.args, input.context);
      results.push({
        index,
        op: normalized.op,
        ok: true,
        tool: normalized.tool,
        idempotency_key: typeof normalized.args.idempotency_key === "string" ? normalized.args.idempotency_key : undefined,
        result
      });
    } catch (error) {
      const op = rawItem.op === "update" || rawItem.op === "delete" ? rawItem.op : "create";
      results.push({
        index,
        op,
        ok: false,
        tool: normalized?.tool ?? (input.kind === "object" ? objectToolForOperation(op) : edgeToolForOperation(op)),
        idempotency_key: typeof normalized?.args.idempotency_key === "string"
          ? normalized.args.idempotency_key
          : typeof rawItem.idempotency_key === "string"
            ? rawItem.idempotency_key
            : undefined,
        error: error instanceof Error ? error.message : "batch-item-failed"
      });
    }
  }

  const acceptedItems = results.filter((result) => result.ok).length;
  return {
    ok: acceptedItems === results.length,
    batch_kind: input.kind,
    requested_items: input.args.items.length,
    accepted_items: acceptedItems,
    failed_items: results.length - acceptedItems,
    limits,
    usage_estimate: {
      worker_requests_used: 1,
      worker_requests_saved_vs_single_item: Math.max(input.args.items.length - 1, 0),
      d1_rows_written_are_per_item: true,
      r2_operations_are_per_item: true
    },
    results
  };
}

export function createLivingAtlasGraphService(adapter: LivingAtlasGraphToolAdapter): LivingAtlasGraphService {
  return {
    async callTool(toolName, args, context) {
      if (!isLivingAtlasMcpToolName(toolName)) {
        throw new Error("unknown-tool");
      }

      if (LocalOnlyToolNames.has(toolName) && context.ingress !== "local-stdio") {
        throw new Error("local-only-tool");
      }

      if (BatchToolNames.has(toolName)) {
        return executeBatch({
          kind: toolName === "object_batch" ? "object" : "edge",
          args,
          context,
          adapter
        });
      }

      return adapter.execute(toolName, args, context);
    },
    describeExecution: describeGraphExecution
  };
}
