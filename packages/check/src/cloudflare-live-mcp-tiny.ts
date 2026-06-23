import { createHash, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  createAtlasClient,
  type AtlasClient,
  type RemoteMcpToolName
} from "@living-atlas/atlas-client";
import type { GraphObjectEnvelope } from "@living-atlas/contracts";
import { printCloudflareLiveUsageGateResult, runCloudflareLiveUsageGate } from "./cloudflare-live-usage-gate";

const ackEnv = "LIVING_ATLAS_LIVE_MCP_TINY_ACK";
const mutationAcknowledgement = "mutates-deployed-sync-state";
const requiredTools: RemoteMcpToolName[] = [
  "remote_graph_create",
  "remote_graph_read",
  "remote_graph_update",
  "remote_graph_delete",
  "remote_semantic_search",
  "remote_graph_traverse",
  "remote_timeline_query",
  "remote_edge_create",
  "remote_edge_read",
  "remote_edge_update",
  "remote_activity_audit",
  "remote_graph_reconcile"
];

function envValue(key: string): string | undefined {
  const value = process.env[key]?.trim();
  return value ? value : undefined;
}

function requireEnv(key: string): string {
  const value = envValue(key);
  if (!value) {
    throw new Error(`missing ${key}`);
  }
  return value;
}

function digest(value: string, length = 24): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function runId(): string {
  return envValue("LIVING_ATLAS_LIVE_RUN_ID") ?? `live_mcp_${randomBytes(8).toString("hex")}`;
}

function nowIso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function assertNoSecretText(label: string, value: unknown, secrets: string[]): void {
  const serialized = JSON.stringify(value);
  for (const secret of secrets) {
    if (secret && serialized.includes(secret)) {
      throw new Error(`${label} leaked secret material`);
    }
  }
}

function plaintextObject(input: {
  authorityId: string;
  objectId: string;
  title: string;
  body: string;
  sequence: number;
}): GraphObjectEnvelope {
  const timestamp = nowIso(input.sequence * 1000);
  const payload = {
    kind: "plaintext-json" as const,
    data: {
      title: input.title,
      body: input.body,
      tags: ["live-mcp-proof", "synthetic"],
      occurred_on: timestamp.slice(0, 10)
    }
  };
  return {
    schema_version: 1,
    authority_id: input.authorityId,
    object_id: input.objectId,
    object_type: "page",
    version: 1,
    access_class: "remote-safe",
    encryption_class: "plaintext",
    created_at: timestamp,
    updated_at: timestamp,
    content_hash: sha256(JSON.stringify(payload)),
    visible_metadata: {
      schema_namespace: "live-proof/mcp",
      tombstone: false,
      size_class: "tiny",
      remote_indexable: true
    },
    payload
  };
}

function encryptedProbeObject(authorityId: string, objectId: string): GraphObjectEnvelope {
  return {
    schema_version: 1,
    authority_id: authorityId,
    object_id: objectId,
    object_type: "page",
    version: 1,
    access_class: "local-private",
    encryption_class: "client-encrypted",
    created_at: nowIso(),
    updated_at: nowIso(),
    content_hash: sha256("ciphertext-probe"),
    key_ref: `la_key_${digest(`key:${objectId}`, 18)}`,
    visible_metadata: {
      tombstone: false,
      remote_indexable: false,
      size_class: "tiny"
    },
    payload: {
      kind: "ciphertext-inline",
      ciphertext: Buffer.from("not-real-secret-ciphertext").toString("base64"),
      nonce: Buffer.from("123456789012").toString("base64"),
      algorithm: "synthetic-probe"
    }
  };
}

async function rawMcpCall(input: {
  endpoint: string;
  syncToken?: string;
  clientId?: string;
  capabilityId?: string;
  tokenId?: string;
  name?: string;
  args?: unknown;
  method?: string;
  id?: number;
}): Promise<{ status: number; body: unknown; text: string }> {
  const headers: Record<string, string> = {
    "content-type": "application/json"
  };
  if (input.syncToken) {
    headers["x-living-atlas-sync-token"] = input.syncToken;
  }
  if (input.clientId) {
    headers["x-living-atlas-sync-client-id"] = input.clientId;
  }
  if (input.capabilityId) {
    headers["x-living-atlas-sync-capability-id"] = input.capabilityId;
  }
  if (input.tokenId) {
    headers["x-living-atlas-sync-token-id"] = input.tokenId;
  }

  const response = await fetch(new URL("/mcp", input.endpoint), {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: input.id ?? 1,
      method: input.method ?? "tools/call",
      params: input.name ? {
        name: input.name,
        arguments: input.args ?? {}
      } : undefined
    })
  });
  const text = await response.text();
  let body: unknown = text;
  if (text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: response.status, body, text };
}

function createClient(input: {
  endpoint: string;
  syncToken: string;
  healthToken?: string;
  clientId: string;
  capabilityId: string;
  tokenId?: string;
}): AtlasClient {
  return createAtlasClient({
    endpoint: input.endpoint,
    syncToken: input.syncToken,
    healthToken: input.healthToken ?? input.syncToken,
    clientId: input.clientId,
    capabilityId: input.capabilityId,
    tokenId: input.tokenId
  });
}

export async function main(): Promise<void> {
  if (process.env[ackEnv] !== mutationAcknowledgement) {
    console.error(`${ackEnv} must equal ${mutationAcknowledgement}`);
    process.exitCode = 2;
    return;
  }

  const gate = await runCloudflareLiveUsageGate();
  printCloudflareLiveUsageGateResult(gate);
  if (!gate.ok) {
    process.exitCode = 2;
    return;
  }

  const endpoint = requireEnv("LIVING_ATLAS_LIVE_SYNC_ENDPOINT");
  const syncToken = requireEnv("LIVING_ATLAS_LIVE_SYNC_TOKEN");
  const clientId = requireEnv("LIVING_ATLAS_LIVE_SYNC_CLIENT_ID");
  const capabilityId = requireEnv("LIVING_ATLAS_LIVE_SYNC_CAPABILITY_ID");
  const tokenId = envValue("LIVING_ATLAS_LIVE_SYNC_TOKEN_ID");
  const healthToken = envValue("LIVING_ATLAS_LIVE_HEALTH_TOKEN");
  const id = runId();
  const authorityId = `la_authority_livemcp${digest(id, 18)}`;
  const objectA = `la_object_livemcp${digest(`${id}:a`, 18)}`;
  const objectB = `la_object_livemcp${digest(`${id}:b`, 18)}`;
  const edgeId = `la_edge_livemcp${digest(`${id}:edge`, 18)}`;
  const secrets = [syncToken, healthToken ?? "", envValue("LIVING_ATLAS_LIVE_CLOUD_UNLOCK_CAPABILITY_ID") ?? ""].filter(Boolean);

  const unauth = await rawMcpCall({ endpoint, method: "tools/list", id: 10 });
  if (![401, 404].includes(unauth.status)) {
    throw new Error(`expected unauthenticated MCP discovery to be denied, got HTTP ${unauth.status}`);
  }
  assertNoSecretText("unauthenticated MCP response", unauth.body, secrets);

  const client = createClient({ endpoint, syncToken, healthToken, clientId, capabilityId, tokenId });
  const tools = await client.listRemoteMcpTools();
  const toolNames = new Set(tools.map((tool: { name: string }) => tool.name));
  for (const tool of requiredTools) {
    if (!toolNames.has(tool)) {
      throw new Error(`remote MCP tools/list missing ${tool}`);
    }
  }

  const encryptedCreate = await rawMcpCall({
    endpoint,
    syncToken,
    clientId,
    capabilityId,
    tokenId,
    id: 20,
    name: "remote_graph_create",
    args: {
      object: encryptedProbeObject(authorityId, `la_object_livemcp${digest(`${id}:encrypted`, 18)}`)
    }
  });
  if (encryptedCreate.status !== 200 || !encryptedCreate.text.includes("remote graph objects must be remote-readable plaintext")) {
    throw new Error(`expected encrypted remote_graph_create to be rejected, got HTTP ${encryptedCreate.status}: ${encryptedCreate.text}`);
  }

  const first = plaintextObject({
    authorityId,
    objectId: objectA,
    title: "Synthetic MCP proof alpha",
    body: `deterministic searchable alpha ${digest(id, 10)}`,
    sequence: 1
  });
  const second = plaintextObject({
    authorityId,
    objectId: objectB,
    title: "Synthetic MCP proof beta",
    body: `deterministic traversable beta ${digest(id, 10)}`,
    sequence: 2
  });

  const createdA = await client.callRemoteMcpTool("remote_graph_create", { object: first, idempotency_key: `la_idem_${digest(`${id}:create-a`, 24)}` });
  const createdB = await client.callRemoteMcpTool("remote_graph_create", { object: second, idempotency_key: `la_idem_${digest(`${id}:create-b`, 24)}` });
  if (createdA.ok !== true || createdB.ok !== true) {
    throw new Error("remote_graph_create did not return ok=true");
  }

  const readA = await client.callRemoteMcpTool("remote_graph_read", { authority_id: authorityId, object_id: objectA });
  if (readA.ok !== true) {
    throw new Error("remote_graph_read did not return created object");
  }

  const updatedPayload = {
    kind: "plaintext-json" as const,
    data: {
      title: "Synthetic MCP proof alpha updated",
      body: `deterministic searchable alpha updated ${digest(id, 10)}`,
      tags: ["live-mcp-proof", "synthetic", "updated"],
      occurred_on: nowIso(3000).slice(0, 10)
    }
  };
  const updatedA = await client.callRemoteMcpTool("remote_graph_update", {
    authority_id: authorityId,
    object_id: objectA,
    expected_version: 1,
    idempotency_key: `la_idem_${digest(`${id}:update-a`, 24)}`,
    patch: {
      payload: updatedPayload,
      content_hash: sha256(JSON.stringify(updatedPayload)),
      updated_at: nowIso(3000)
    }
  });
  if (updatedA.ok !== true || updatedA.new_version !== 2) {
    throw new Error("remote_graph_update did not advance object version");
  }

  const search = await client.callRemoteMcpTool("remote_semantic_search", {
    authority_id: authorityId,
    query: `updated ${digest(id, 10)}`,
    limit: 5
  });
  if (search.ok !== true || !Array.isArray(search.results) || search.results.length < 1) {
    throw new Error("remote_semantic_search did not find updated object");
  }

  const edgeCreate = await client.callRemoteMcpTool("remote_edge_create", {
    authority_id: authorityId,
    idempotency_key: `la_idem_${digest(`${id}:edge-create`, 24)}`,
    edge: {
      edge_id: edgeId,
      source_object_id: objectA,
      source_type: "person",
      target_object_id: objectB,
      target_type: "person",
      predicate: "mentor-of",
      valid_from: nowIso(4000).slice(0, 10),
      status: "active",
      confidence: "high",
      source: "synthetic-live-mcp-proof",
      attrs: {
        note: "synthetic edge-specific CRUD proof"
      }
    }
  });
  if (edgeCreate.ok !== true || !edgeCreate.object || typeof edgeCreate.object !== "object") {
    throw new Error("remote_edge_create did not create an edge object");
  }

  const edgeRead = await client.callRemoteMcpTool("remote_edge_read", { authority_id: authorityId, edge_id: edgeId });
  if (edgeRead.ok !== true) {
    throw new Error("remote_edge_read did not return created edge");
  }

  const traversal = await client.callRemoteMcpTool("remote_graph_traverse", {
    authority_id: authorityId,
    start_object_id: objectA,
    direction: "outbound",
    max_depth: 1,
    predicates: ["mentor-of"],
    limit: 5
  });
  if (traversal.ok !== true || !Array.isArray(traversal.visited_object_ids) || !traversal.visited_object_ids.includes(objectB)) {
    throw new Error("remote_graph_traverse did not traverse the created edge");
  }

  const edgeUpdate = await client.callRemoteMcpTool("remote_edge_update", {
    authority_id: authorityId,
    edge_id: edgeId,
    expected_version: 1,
    idempotency_key: `la_idem_${digest(`${id}:edge-update`, 24)}`,
    patch: {
      confidence: "medium",
      attrs: {
        note: "synthetic edge-specific update proof"
      }
    }
  });
  if (edgeUpdate.ok !== true || edgeUpdate.new_version !== 2) {
    throw new Error("remote_edge_update did not advance edge version");
  }

  const timeline = await client.callRemoteMcpTool("remote_timeline_query", {
    authority_id: authorityId,
    object_id: objectA,
    limit: 10
  });
  if (timeline.ok !== true || !Array.isArray(timeline.results) || timeline.results.length < 1) {
    throw new Error("remote_timeline_query did not return object timeline rows");
  }

  const deleted = await client.callRemoteMcpTool("remote_graph_delete", {
    authority_id: authorityId,
    object_id: objectB,
    expected_version: 1,
    idempotency_key: `la_idem_${digest(`${id}:delete-b`, 24)}`
  });
  if (deleted.ok !== true || deleted.new_version !== 2) {
    throw new Error("remote_graph_delete did not tombstone object");
  }

  const reconcile = await client.callRemoteMcpTool("remote_graph_reconcile", {
    authority_id: authorityId,
    limit: 100
  });
  if (reconcile.ok !== true || reconcile.decision !== "reconciled") {
    throw new Error(`remote_graph_reconcile did not reconcile: ${JSON.stringify(reconcile)}`);
  }

  const audit = await client.callRemoteMcpTool("remote_activity_audit", {
    authority_id: authorityId,
    limit: 20
  });
  if (audit.ok !== true || !Array.isArray(audit.events) || audit.events.length < 5) {
    throw new Error("remote_activity_audit did not return CRUD audit events");
  }
  assertNoSecretText("remote MCP proof responses", { tools, createdA, createdB, readA, updatedA, search, edgeCreate, edgeRead, traversal, edgeUpdate, timeline, deleted, reconcile, audit }, secrets);

  console.log("Living Atlas live MCP tiny proof passed");
  console.log(`authority=${authorityId}`);
  console.log(`created=2 updated=1 edge_created=1 edge_updated=1 deleted=1 audit_events=${audit.events.length}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
