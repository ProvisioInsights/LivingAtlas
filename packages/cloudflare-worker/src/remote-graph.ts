import {
  GraphObjectEnvelopeSchema,
  TemporalEdgeSchema,
  canonicalizePredicate,
  isRemoteReadableAccessClass,
  type GraphObjectEnvelope,
  type ObjectType,
  type SyncStatus,
  type TemporalEdge
} from "@living-atlas/contracts";
import { readSyncEnvelopePull, readSyncStatus } from "./sync-storage";

export type RemoteGraphObjectStore = {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  put(
    key: string,
    value: string,
    options?: {
      httpMetadata?: {
        contentType?: string;
      };
      customMetadata?: Record<string, string>;
    }
  ): Promise<unknown>;
};

type BindableStatement = {
  bind(...values: unknown[]): BindableStatement;
  run(): Promise<unknown>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all?<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
};

export type RemoteGraphMetadataStore = {
  prepare(query: string): BindableStatement;
};

export type RemoteGraphStorageBindings = {
  graphBucket: RemoteGraphObjectStore;
  controlDb: RemoteGraphMetadataStore;
};

export type RemoteGraphObjectRow = {
  object_ref: string;
  version: number;
  envelope_r2_key: string;
};

export type RemoteGraphMutation = "created" | "updated" | "deleted" | "restored";

export type RemoteGraphMutationResult = {
  mutation: RemoteGraphMutation;
  object: GraphObjectEnvelope;
  previous_version?: number;
  new_version: number;
};

export type RemoteGraphListOptions = {
  include_tombstones?: boolean;
  object_type?: ObjectType;
  limit?: number;
};

export type RemoteGraphSearchResult = {
  object: GraphObjectEnvelope;
  score: number;
  matched_fields: string[];
  snippet?: string;
};

export type RemoteGraphTraverseResult = {
  start_object_id: string;
  max_depth: number;
  visited_object_ids: string[];
  edges: GraphObjectEnvelope[];
};

export type RemoteGraphTimelineResult = {
  object: GraphObjectEnvelope;
  timeline_at: string;
  field: string;
};

export type RemoteGraphWriteOperation = "create" | "update" | "delete" | "restore" | "edge-create" | "edge-update" | "edge-delete";

export type RemoteGraphWriteStage =
  | {
      status: "staged";
      idempotency_key: string;
      created_at: string;
    }
  | {
      status: "committed";
      idempotency_key: string;
      response: Record<string, unknown>;
    };

export type RemoteGraphReconciliation = {
  ok: true;
  authority_id: string;
  reconciliation_schema: "living-atlas-remote-graph-reconciliation:v1";
  decision: "reconciled" | "drift-detected";
  remote_graph_index: {
    indexed_versions: number;
    latest_object_count: number;
    active_object_count: number;
    tombstone_count: number;
  };
  sync_envelopes: Pick<SyncStatus, "latest_generation" | "latest_batch_id" | "object_count" | "change_count" | "latest_withheld_plaintext_count"> & {
    remote_readable_object_versions: number;
    truncated: boolean;
  };
  drift: {
    remote_graph_versions_missing_sync_envelope: number;
    remote_readable_sync_versions_missing_remote_graph_index: number;
    samples: Array<{
      kind: "remote-graph-missing-sync-envelope" | "sync-envelope-missing-remote-graph";
      object_id: string;
      version: number;
      object_type: ObjectType;
      access_class: string;
    }>;
  };
};

const MaxGraphListLimit = 1000;
const textEncoder = new TextEncoder();

const RemoteGraphObjectsSql = `
CREATE TABLE IF NOT EXISTS remote_graph_objects (
  object_ref TEXT NOT NULL,
  authority_ref TEXT NOT NULL,
  version INTEGER NOT NULL,
  object_type TEXT NOT NULL,
  access_class TEXT NOT NULL,
  envelope_r2_key TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  tombstone INTEGER NOT NULL CHECK (tombstone IN (0, 1)),
  edge_ref TEXT,
  source_ref TEXT,
  target_ref TEXT,
  predicate TEXT,
  valid_from TEXT,
  valid_to TEXT,
  timeline_start TEXT,
  timeline_end TEXT,
  search_text TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (object_ref, version)
)`;

const RemoteGraphWritesSql = `
CREATE TABLE IF NOT EXISTS remote_graph_writes (
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  authority_ref TEXT NOT NULL,
  object_ref TEXT,
  operation TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('staged', 'committed', 'failed')),
  sync_batch_id TEXT,
  sync_generation INTEGER,
  response_json TEXT,
  failure_reason TEXT,
  created_at TEXT NOT NULL,
  committed_at TEXT,
  last_seen_at TEXT NOT NULL
)`;

const RemoteGraphIndexSql = [
  "CREATE INDEX IF NOT EXISTS idx_remote_graph_authority_object ON remote_graph_objects (authority_ref, object_ref, version)",
  "CREATE INDEX IF NOT EXISTS idx_remote_graph_authority_updated ON remote_graph_objects (authority_ref, updated_at)",
  "CREATE INDEX IF NOT EXISTS idx_remote_graph_authority_type ON remote_graph_objects (authority_ref, object_type, updated_at)",
  "CREATE INDEX IF NOT EXISTS idx_remote_graph_authority_edge ON remote_graph_objects (authority_ref, edge_ref, version)",
  "CREATE INDEX IF NOT EXISTS idx_remote_graph_authority_source ON remote_graph_objects (authority_ref, source_ref, predicate)",
  "CREATE INDEX IF NOT EXISTS idx_remote_graph_authority_target ON remote_graph_objects (authority_ref, target_ref, predicate)",
  "CREATE INDEX IF NOT EXISTS idx_remote_graph_authority_timeline ON remote_graph_objects (authority_ref, timeline_start)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_remote_graph_writes_authority_idempotency ON remote_graph_writes (authority_ref, idempotency_key)",
  "CREATE INDEX IF NOT EXISTS idx_remote_graph_writes_authority_status ON remote_graph_writes (authority_ref, status, created_at)"
];

export const RemoteGraphD1SchemaStatements = [
  RemoteGraphObjectsSql,
  RemoteGraphWritesSql,
  ...RemoteGraphIndexSql
];

async function ensureRemoteGraphTables(controlDb: RemoteGraphMetadataStore): Promise<void> {
  for (const statement of RemoteGraphD1SchemaStatements) {
    await controlDb.prepare(statement).run();
  }
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(value));
  return toHex(new Uint8Array(digest));
}

async function sha256Hash(value: string): Promise<`sha256:${string}`> {
  return `sha256:${await sha256Hex(value)}`;
}

async function opaqueRef(value: string): Promise<string> {
  return `sha256:${await sha256Hex(`living-atlas-remote-graph-ref:v2:${value}`)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedLimit(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? 100, 1), MaxGraphListLimit);
}

function textFromValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(textFromValue).join(" ");
  }
  if (isRecord(value)) {
    return Object.entries(value)
      .map(([key, nested]) => `${key} ${textFromValue(nested)}`)
      .join(" ");
  }
  return "";
}

function parseStoredResponse(value: string | null | undefined): Record<string, unknown> {
  if (!value) {
    throw new Error("remote-write-missing-response");
  }
  const parsed = JSON.parse(value) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("remote-write-invalid-response");
  }
  return parsed;
}

function plaintextData(object: GraphObjectEnvelope): Record<string, unknown> | undefined {
  return object.payload.kind === "plaintext-json" ? object.payload.data : undefined;
}

function searchText(object: GraphObjectEnvelope): string {
  return [
    object.object_id,
    object.object_type,
    object.access_class,
    object.visible_metadata.schema_namespace,
    textFromValue(object.visible_metadata),
    textFromValue(plaintextData(object))
  ].filter(Boolean).join(" ").toLowerCase();
}

function edgeData(object: GraphObjectEnvelope): (TemporalEdge & { edge_id?: string }) | undefined {
  if (object.object_type !== "edge") {
    return undefined;
  }
  const data = plaintextData(object);
  if (!data) {
    return undefined;
  }
  const candidate = isRecord(data.edge) ? data.edge : data;
  const parsed = TemporalEdgeSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

function timelineCandidates(object: GraphObjectEnvelope): Array<{ field: string; value: string }> {
  const data = plaintextData(object);
  const candidates: Array<{ field: string; value: string }> = [
    { field: "created_at", value: object.created_at },
    { field: "updated_at", value: object.updated_at }
  ];
  if (data) {
    for (const field of ["occurred_on", "occurred_until", "recorded_at", "valid_from", "valid_to"] as const) {
      const value = data[field];
      if (typeof value === "string") {
        candidates.push({ field, value });
      }
    }
    const edge = edgeData(object);
    if (edge) {
      candidates.push({ field: "edge.valid_from", value: edge.valid_from });
      if (edge.valid_to) {
        candidates.push({ field: "edge.valid_to", value: edge.valid_to });
      }
    }
  }
  return candidates;
}

function normalizedDateKey(value: string): string {
  if (value === "unknown") {
    return "9999";
  }
  return value.replace(/^~/, "");
}

function objectAllowedForRemoteGraph(object: GraphObjectEnvelope): boolean {
  if (!isRemoteReadableAccessClass(object.access_class)) {
    return false;
  }
  if (object.payload.kind !== "plaintext-json") {
    return false;
  }
  if (object.encryption_class === "client-encrypted" || object.encryption_class === "local-only-index") {
    return false;
  }
  if (object.access_class === "release" && !object.visible_metadata.release_expires_at) {
    return false;
  }
  return true;
}

export function isExpiredReleaseObject(object: GraphObjectEnvelope, now = Date.now()): boolean {
  if (object.access_class !== "release") {
    return false;
  }
  const expiresAt = object.visible_metadata.release_expires_at;
  return !!expiresAt && Date.parse(expiresAt) <= now;
}

async function remoteGraphEnvelopeR2Key(object: GraphObjectEnvelope): Promise<string> {
  const authority = (await sha256Hex(`living-atlas-remote-graph-r2-authority:v2:${object.authority_id}`)).slice(0, 16);
  const segment = (await sha256Hex([
    "remote-graph-envelope:v1",
    object.authority_id,
    object.object_id,
    String(object.version),
    object.content_hash
  ].join(":"))).slice(0, 40);
  return `remote-graph/a=${authority}/p=${segment.slice(0, 2)}/s=${segment}.json`;
}

type RemoteGraphWriteRow = {
  idempotency_key: string;
  request_hash: string;
  status: "staged" | "committed" | "failed";
  response_json?: string | null;
  failure_reason?: string | null;
  created_at: string;
};

async function readRemoteGraphWrite(
  controlDb: RemoteGraphMetadataStore,
  authorityId: string,
  idempotencyKey: string
): Promise<RemoteGraphWriteRow | undefined> {
  const authorityRef = await opaqueRef(authorityId);
  const row = await controlDb.prepare(`
SELECT idempotency_key, request_hash, status, response_json, failure_reason, created_at
FROM remote_graph_writes
WHERE authority_ref = ? AND idempotency_key = ?
LIMIT 1`).bind(authorityRef, idempotencyKey).first<RemoteGraphWriteRow>();
  return row ?? undefined;
}

export async function stageRemoteGraphWrite(
  storage: RemoteGraphStorageBindings,
  input: {
    idempotency_key: string;
    request_hash: string;
    authority_id: string;
    object_id?: string;
    operation: RemoteGraphWriteOperation;
  }
): Promise<RemoteGraphWriteStage> {
  await ensureRemoteGraphTables(storage.controlDb);
  const authorityRef = await opaqueRef(input.authority_id);
  const existing = await readRemoteGraphWrite(storage.controlDb, input.authority_id, input.idempotency_key);
  if (existing) {
    await storage.controlDb.prepare(`
UPDATE remote_graph_writes
SET last_seen_at = ?
WHERE authority_ref = ? AND idempotency_key = ?`).bind(new Date().toISOString(), authorityRef, input.idempotency_key).run();

    if (existing.request_hash !== input.request_hash) {
      throw new Error("remote-write-idempotency-conflict");
    }
    if (existing.status === "committed") {
      return {
        status: "committed",
        idempotency_key: input.idempotency_key,
        response: parseStoredResponse(existing.response_json)
      };
    }
    if (existing.status === "failed") {
      throw new Error(existing.failure_reason || "remote-write-failed");
    }
    return {
      status: "staged",
      idempotency_key: input.idempotency_key,
      created_at: existing.created_at
    };
  }

  const now = new Date().toISOString();
  await storage.controlDb.prepare(`
INSERT OR IGNORE INTO remote_graph_writes (
  idempotency_key,
  request_hash,
  authority_ref,
  object_ref,
  operation,
  status,
  sync_batch_id,
  sync_generation,
  response_json,
  failure_reason,
  created_at,
  committed_at,
  last_seen_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    input.idempotency_key,
    input.request_hash,
    authorityRef,
    input.object_id ? await opaqueRef(input.object_id) : null,
    input.operation,
    "staged",
    null,
    null,
    null,
    null,
    now,
    null,
    now
  ).run();

  const staged = await readRemoteGraphWrite(storage.controlDb, input.authority_id, input.idempotency_key);
  if (!staged || staged.request_hash !== input.request_hash) {
    throw new Error("remote-write-idempotency-conflict");
  }
  if (staged.status !== "staged" || staged.created_at !== now) {
    throw new Error(staged.status === "committed" ? "remote-write-committed-before-stage" : "remote-write-in-flight");
  }

  return {
    status: "staged",
    idempotency_key: input.idempotency_key,
    created_at: now
  };
}

export async function commitRemoteGraphWrite(
  storage: RemoteGraphStorageBindings,
  input: {
    authority_id: string;
    idempotency_key: string;
    request_hash: string;
    sync_batch_id: string;
    sync_generation: number;
    response: Record<string, unknown>;
  }
): Promise<void> {
  const now = new Date().toISOString();
  const authorityRef = await opaqueRef(input.authority_id);
  await storage.controlDb.prepare(`
UPDATE remote_graph_writes
SET status = 'committed',
    sync_batch_id = ?,
    sync_generation = ?,
    response_json = ?,
    failure_reason = NULL,
    committed_at = ?,
    last_seen_at = ?
WHERE authority_ref = ? AND idempotency_key = ? AND request_hash = ? AND status = 'staged'`).bind(
    input.sync_batch_id,
    input.sync_generation,
    JSON.stringify(input.response),
    now,
    now,
    authorityRef,
    input.idempotency_key,
    input.request_hash
  ).run();
}

export async function failRemoteGraphWrite(
  storage: RemoteGraphStorageBindings,
  input: {
    authority_id: string;
    idempotency_key: string;
    request_hash: string;
    reason: string;
  }
): Promise<void> {
  const now = new Date().toISOString();
  const authorityRef = await opaqueRef(input.authority_id);
  await storage.controlDb.prepare(`
UPDATE remote_graph_writes
SET status = 'failed',
    failure_reason = ?,
    last_seen_at = ?
WHERE authority_ref = ? AND idempotency_key = ? AND request_hash = ? AND status = 'staged'`).bind(
    input.reason,
    now,
    authorityRef,
    input.idempotency_key,
    input.request_hash
  ).run();
}

async function storeRemoteGraphObject(storage: RemoteGraphStorageBindings, object: GraphObjectEnvelope): Promise<void> {
  const authorityRef = await opaqueRef(object.authority_id);
  const objectRef = await opaqueRef(object.object_id);
  const edge = edgeData(object);
  const edgeRef = edge?.edge_id ? await opaqueRef(edge.edge_id) : null;
  const sourceRef = edge?.source_object_id ? await opaqueRef(edge.source_object_id) : null;
  const targetRef = edge?.target_object_id ? await opaqueRef(edge.target_object_id) : null;
  const timeline = timelineCandidates(object);
  const timelineStart = timeline.at(0)?.value ?? object.updated_at;
  const timelineEnd = timeline.find((candidate) => candidate.field.endsWith("valid_to") || candidate.field.endsWith("occurred_until"))?.value;
  const key = await remoteGraphEnvelopeR2Key(object);

  await storage.graphBucket.put(key, JSON.stringify(object), {
    httpMetadata: {
      contentType: "application/json; charset=utf-8"
    },
    customMetadata: {
      schema: "la-remote-graph-envelope-v1",
      authority_ref: authorityRef.slice(7, 23),
      object_ref: objectRef.slice(7, 23)
    }
  });

  await storage.controlDb.prepare(`
INSERT INTO remote_graph_objects (
  object_ref,
  authority_ref,
  version,
  object_type,
  access_class,
  envelope_r2_key,
  content_hash,
  created_at,
  updated_at,
  tombstone,
  edge_ref,
  source_ref,
  target_ref,
  predicate,
  valid_from,
  valid_to,
  timeline_start,
  timeline_end,
  search_text,
  recorded_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    objectRef,
    authorityRef,
    object.version,
    object.object_type,
    object.access_class,
    key,
    object.content_hash,
    object.created_at,
    object.updated_at,
    object.visible_metadata.tombstone ? 1 : 0,
    edgeRef,
    sourceRef,
    targetRef,
    edge?.predicate ?? null,
    edge?.valid_from ?? null,
    edge?.valid_to ?? null,
    timelineStart,
    timelineEnd ?? null,
    searchText(object),
    new Date().toISOString()
  ).run();
}

export async function storePreparedRemoteGraphMutation(
  storage: RemoteGraphStorageBindings,
  result: RemoteGraphMutationResult
): Promise<void> {
  await storeRemoteGraphObject(storage, result.object);
}

async function loadObject(storage: RemoteGraphStorageBindings, key: string): Promise<GraphObjectEnvelope> {
  const body = await storage.graphBucket.get(key);
  if (!body) {
    throw new Error(`Missing remote graph envelope: ${key}`);
  }
  return GraphObjectEnvelopeSchema.parse(JSON.parse(await body.text()));
}

async function contentHashForRemoteObject(object: Pick<GraphObjectEnvelope, "payload">): Promise<`sha256:${string}`> {
  return sha256Hash(JSON.stringify(object.payload));
}

async function ensureRemoteGraphObject(input: unknown): Promise<GraphObjectEnvelope> {
  const parsed = GraphObjectEnvelopeSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error("invalid-graph-object-envelope");
  }
  const object = parsed.data;
  if (!objectAllowedForRemoteGraph(object)) {
    throw new Error("remote graph objects must be remote-readable plaintext");
  }
  return GraphObjectEnvelopeSchema.parse({
    ...object,
    content_hash: await contentHashForRemoteObject(object)
  });
}

export async function latestRemoteGraphObject(
  storage: RemoteGraphStorageBindings,
  authorityId: string,
  objectId: string
): Promise<GraphObjectEnvelope | undefined> {
  await ensureRemoteGraphTables(storage.controlDb);
  const row = await storage.controlDb.prepare(`
SELECT object_ref, version, envelope_r2_key
FROM remote_graph_objects
WHERE authority_ref = ? AND object_ref = ?
ORDER BY version DESC
LIMIT 1`).bind(await opaqueRef(authorityId), await opaqueRef(objectId)).first<RemoteGraphObjectRow>();

  return row ? loadObject(storage, row.envelope_r2_key) : undefined;
}

export async function listRemoteGraphObjects(
  storage: RemoteGraphStorageBindings,
  authorityId: string,
  options: RemoteGraphListOptions = {}
): Promise<GraphObjectEnvelope[]> {
  await ensureRemoteGraphTables(storage.controlDb);
  const rows = (await storage.controlDb.prepare(`
SELECT object_ref, version, envelope_r2_key
FROM remote_graph_objects
WHERE authority_ref = ?
ORDER BY object_ref ASC, version DESC
LIMIT ?`).bind(await opaqueRef(authorityId), boundedLimit(options.limit) * 5).all?.<RemoteGraphObjectRow>())?.results ?? [];

  const latestRows = new Map<string, RemoteGraphObjectRow>();
  for (const row of rows) {
    if (!latestRows.has(row.object_ref)) {
      latestRows.set(row.object_ref, row);
    }
  }

  const objects: GraphObjectEnvelope[] = [];
  for (const row of latestRows.values()) {
    const object = await loadObject(storage, row.envelope_r2_key);
    if (isExpiredReleaseObject(object)) {
      continue;
    }
    if (!options.include_tombstones && object.visible_metadata.tombstone) {
      continue;
    }
    if (options.object_type && object.object_type !== options.object_type) {
      continue;
    }
    objects.push(object);
    if (objects.length >= boundedLimit(options.limit)) {
      break;
    }
  }
  return objects.sort((left, right) => right.updated_at.localeCompare(left.updated_at) || left.object_id.localeCompare(right.object_id));
}

export async function prepareCreateRemoteGraphObject(
  storage: RemoteGraphStorageBindings,
  input: unknown
): Promise<RemoteGraphMutationResult> {
  await ensureRemoteGraphTables(storage.controlDb);
  const object = await ensureRemoteGraphObject(input);
  const existing = await latestRemoteGraphObject(storage, object.authority_id, object.object_id);
  if (existing && !existing.visible_metadata.tombstone) {
    throw new Error("object-already-exists");
  }
  return {
    mutation: existing ? "restored" : "created",
    object,
    previous_version: existing?.version,
    new_version: object.version
  };
}

export async function createRemoteGraphObject(
  storage: RemoteGraphStorageBindings,
  input: unknown
): Promise<RemoteGraphMutationResult> {
  const result = await prepareCreateRemoteGraphObject(storage, input);
  await storePreparedRemoteGraphMutation(storage, result);
  return result;
}

export async function prepareUpdateRemoteGraphObject(
  storage: RemoteGraphStorageBindings,
  authorityId: string,
  objectId: string,
  patch: unknown,
  expectedVersion?: number
): Promise<RemoteGraphMutationResult> {
  await ensureRemoteGraphTables(storage.controlDb);
  const existing = await latestRemoteGraphObject(storage, authorityId, objectId);
  if (!existing) {
    throw new Error("object-not-found");
  }
  if (expectedVersion !== undefined && existing.version !== expectedVersion) {
    throw new Error("version-conflict");
  }
  if (!isRecord(patch)) {
    throw new Error("invalid-patch");
  }
  const visiblePatch = isRecord(patch.visible_metadata) ? patch.visible_metadata : {};
  const merged = await ensureRemoteGraphObject({
    ...existing,
    ...patch,
    schema_version: 1,
    authority_id: existing.authority_id,
    object_id: existing.object_id,
    version: existing.version + 1,
    created_at: existing.created_at,
    updated_at: typeof patch.updated_at === "string" ? patch.updated_at : new Date().toISOString(),
    visible_metadata: {
      ...existing.visible_metadata,
      ...visiblePatch
    },
    payload: patch.payload ?? existing.payload,
    content_hash: existing.content_hash
  });
  return {
    mutation: merged.visible_metadata.tombstone ? "deleted" : "updated",
    object: merged,
    previous_version: existing.version,
    new_version: merged.version
  };
}

export async function updateRemoteGraphObject(
  storage: RemoteGraphStorageBindings,
  authorityId: string,
  objectId: string,
  patch: unknown,
  expectedVersion?: number
): Promise<RemoteGraphMutationResult> {
  const result = await prepareUpdateRemoteGraphObject(storage, authorityId, objectId, patch, expectedVersion);
  await storePreparedRemoteGraphMutation(storage, result);
  return result;
}

export async function prepareDeleteRemoteGraphObject(
  storage: RemoteGraphStorageBindings,
  authorityId: string,
  objectId: string,
  expectedVersion?: number
): Promise<RemoteGraphMutationResult> {
  return prepareUpdateRemoteGraphObject(
    storage,
    authorityId,
    objectId,
    {
      visible_metadata: { tombstone: true },
      updated_at: new Date().toISOString()
    },
    expectedVersion
  );
}

export async function deleteRemoteGraphObject(
  storage: RemoteGraphStorageBindings,
  authorityId: string,
  objectId: string,
  expectedVersion?: number
): Promise<RemoteGraphMutationResult> {
  const result = await prepareDeleteRemoteGraphObject(storage, authorityId, objectId, expectedVersion);
  await storePreparedRemoteGraphMutation(storage, result);
  return result;
}

export async function searchRemoteGraphObjects(
  storage: RemoteGraphStorageBindings,
  authorityId: string,
  query: string,
  options: { limit?: number; object_type?: ObjectType } = {}
): Promise<RemoteGraphSearchResult[]> {
  const terms = query.toLowerCase().split(/\s+/).map((term) => term.trim()).filter(Boolean);
  if (terms.length === 0) {
    return [];
  }
  const objects = await listRemoteGraphObjects(storage, authorityId, {
    object_type: options.object_type,
    limit: MaxGraphListLimit
  });
  const results = objects.map((object) => {
    const text = searchText(object);
    const matched = terms.filter((term) => text.includes(term));
    const score = matched.reduce((sum, term) => sum + (text.split(term).length - 1), 0);
    return {
      object,
      score,
      matched_fields: matched,
      snippet: text.slice(0, 240)
    };
  }).filter((result) => result.score > 0);
  return results
    .sort((left, right) => right.score - left.score || right.object.updated_at.localeCompare(left.object.updated_at))
    .slice(0, boundedLimit(options.limit));
}

export async function traverseRemoteGraph(
  storage: RemoteGraphStorageBindings,
  authorityId: string,
  startObjectId: string,
  options: { direction?: "outbound" | "inbound" | "both"; max_depth?: number; predicates?: string[]; limit?: number } = {}
): Promise<RemoteGraphTraverseResult> {
  const direction = options.direction ?? "both";
  const maxDepth = Math.min(Math.max(options.max_depth ?? 1, 1), 5);
  const limit = boundedLimit(options.limit);
  const allowedPredicates = options.predicates ? new Set(options.predicates) : undefined;
  const edges = (await listRemoteGraphObjects(storage, authorityId, { object_type: "edge", limit: MaxGraphListLimit }))
    .map((object) => ({ object, edge: edgeData(object) }))
    .filter((entry): entry is { object: GraphObjectEnvelope; edge: TemporalEdge } => !!entry.edge)
    .filter((entry) => !allowedPredicates || allowedPredicates.has(entry.edge.predicate));
  const visited = new Set<string>([startObjectId]);
  const frontier = new Set<string>([startObjectId]);
  const traversed: GraphObjectEnvelope[] = [];

  for (let depth = 0; depth < maxDepth && frontier.size > 0 && traversed.length < limit; depth += 1) {
    const next = new Set<string>();
    for (const entry of edges) {
      const outbound = frontier.has(entry.edge.source_object_id);
      const inbound = frontier.has(entry.edge.target_object_id);
      if ((direction === "outbound" || direction === "both") && outbound) {
        next.add(entry.edge.target_object_id);
        traversed.push(entry.object);
      }
      if ((direction === "inbound" || direction === "both") && inbound) {
        next.add(entry.edge.source_object_id);
        traversed.push(entry.object);
      }
      if (traversed.length >= limit) {
        break;
      }
    }
    frontier.clear();
    for (const objectId of next) {
      if (!visited.has(objectId)) {
        visited.add(objectId);
        frontier.add(objectId);
      }
    }
  }

  return {
    start_object_id: startObjectId,
    max_depth: maxDepth,
    visited_object_ids: [...visited],
    edges: [...new Map(traversed.map((edge) => [edge.object_id, edge])).values()]
  };
}

export async function queryRemoteTimeline(
  storage: RemoteGraphStorageBindings,
  authorityId: string,
  options: { from?: string; to?: string; object_id?: string; predicate?: string; limit?: number } = {}
): Promise<RemoteGraphTimelineResult[]> {
  const objects = await listRemoteGraphObjects(storage, authorityId, { include_tombstones: true, limit: MaxGraphListLimit });
  const from = options.from ? normalizedDateKey(options.from) : undefined;
  const to = options.to ? normalizedDateKey(options.to) : undefined;
  const results: RemoteGraphTimelineResult[] = [];
  for (const object of objects) {
    if (options.object_id && object.object_id !== options.object_id) {
      continue;
    }
    const edge = edgeData(object);
    if (options.predicate && edge?.predicate !== options.predicate) {
      continue;
    }
    for (const candidate of timelineCandidates(object)) {
      const key = normalizedDateKey(candidate.value);
      if (from && key < from) {
        continue;
      }
      if (to && key > to) {
        continue;
      }
      results.push({
        object,
        timeline_at: candidate.value,
        field: candidate.field
      });
    }
  }
  return results
    .sort((left, right) => normalizedDateKey(left.timeline_at).localeCompare(normalizedDateKey(right.timeline_at)))
    .slice(0, boundedLimit(options.limit));
}

export async function reconcileRemoteGraph(
  storage: RemoteGraphStorageBindings,
  authorityId: string,
  options: { limit?: number } = {}
): Promise<RemoteGraphReconciliation> {
  await ensureRemoteGraphTables(storage.controlDb);
  const authorityRef = await opaqueRef(authorityId);
  const limit = boundedLimit(options.limit) * 5;
  const indexRows = (await storage.controlDb.prepare(`
SELECT object_ref, version, envelope_r2_key
FROM remote_graph_objects
WHERE authority_ref = ?
ORDER BY object_ref ASC, version DESC
LIMIT ?`).bind(authorityRef, limit).all?.<RemoteGraphObjectRow>())?.results ?? [];
  const indexedVersions = new Set(indexRows.map((row) => `${row.object_ref}:${row.version}`));
  const latestRows = new Map<string, RemoteGraphObjectRow>();
  for (const row of indexRows) {
    if (!latestRows.has(row.object_ref)) {
      latestRows.set(row.object_ref, row);
    }
  }

  const latestObjects: GraphObjectEnvelope[] = [];
  for (const row of latestRows.values()) {
    latestObjects.push(await loadObject(storage, row.envelope_r2_key));
  }

  const syncStatus = await readSyncStatus(storage.controlDb, authorityId);
  const syncPull = await readSyncEnvelopePull(storage, authorityId, 0, 50);
  const syncRemoteReadableEntries = syncPull.objects.filter((entry) => objectAllowedForRemoteGraph(entry.object));
  const syncRemoteReadableVersionRefs = new Set<string>();
  for (const entry of syncRemoteReadableEntries) {
    syncRemoteReadableVersionRefs.add(`${await opaqueRef(entry.object.object_id)}:${entry.object.version}`);
  }

  const samples: RemoteGraphReconciliation["drift"]["samples"] = [];
  let missingSyncCount = 0;
  for (const row of indexRows) {
    if (syncRemoteReadableVersionRefs.has(`${row.object_ref}:${row.version}`)) {
      continue;
    }
    missingSyncCount += 1;
    if (samples.length < 10) {
      const object = await loadObject(storage, row.envelope_r2_key);
      samples.push({
        kind: "remote-graph-missing-sync-envelope",
        object_id: object.object_id,
        version: object.version,
        object_type: object.object_type,
        access_class: object.access_class
      });
    }
  }

  let missingRemoteCount = 0;
  for (const entry of syncRemoteReadableEntries) {
    const ref = `${await opaqueRef(entry.object.object_id)}:${entry.object.version}`;
    if (indexedVersions.has(ref)) {
      continue;
    }
    missingRemoteCount += 1;
    if (samples.length < 10) {
      samples.push({
        kind: "sync-envelope-missing-remote-graph",
        object_id: entry.object.object_id,
        version: entry.object.version,
        object_type: entry.object.object_type,
        access_class: entry.object.access_class
      });
    }
  }

  const activeObjectCount = latestObjects.filter((object) => !object.visible_metadata.tombstone && !isExpiredReleaseObject(object)).length;
  const tombstoneCount = latestObjects.filter((object) => object.visible_metadata.tombstone).length;
  const decision = missingSyncCount === 0 && missingRemoteCount === 0 ? "reconciled" : "drift-detected";

  return {
    ok: true,
    authority_id: authorityId,
    reconciliation_schema: "living-atlas-remote-graph-reconciliation:v1",
    decision,
    remote_graph_index: {
      indexed_versions: indexRows.length,
      latest_object_count: latestObjects.length,
      active_object_count: activeObjectCount,
      tombstone_count: tombstoneCount
    },
    sync_envelopes: {
      latest_generation: syncStatus.latest_generation,
      latest_batch_id: syncStatus.latest_batch_id,
      object_count: syncStatus.object_count,
      change_count: syncStatus.change_count,
      latest_withheld_plaintext_count: syncStatus.latest_withheld_plaintext_count,
      remote_readable_object_versions: syncRemoteReadableEntries.length,
      truncated: syncPull.has_more
    },
    drift: {
      remote_graph_versions_missing_sync_envelope: missingSyncCount,
      remote_readable_sync_versions_missing_remote_graph_index: missingRemoteCount,
      samples
    }
  };
}

export async function prepareCreateRemoteEdgeObject(
  storage: RemoteGraphStorageBindings,
  authorityId: string,
  input: unknown
): Promise<RemoteGraphMutationResult> {
  const edge = TemporalEdgeSchema.parse(input);
  const now = new Date().toISOString();
  const object: GraphObjectEnvelope = GraphObjectEnvelopeSchema.parse({
    schema_version: 1,
    authority_id: authorityId,
    object_id: `la_object_${(await sha256Hex(edge.edge_id)).slice(0, 24)}`,
    object_type: "edge",
    version: 1,
    access_class: "remote-safe",
    encryption_class: "plaintext",
    created_at: now,
    updated_at: now,
    content_hash: await sha256Hash(JSON.stringify(edge)),
    visible_metadata: {
      schema_namespace: "edge/temporal",
      tombstone: false,
      size_class: "tiny",
      remote_indexable: true
    },
    payload: {
      kind: "plaintext-json",
      data: edge
    }
  });
  return prepareCreateRemoteGraphObject(storage, object);
}

export async function createRemoteEdgeObject(
  storage: RemoteGraphStorageBindings,
  authorityId: string,
  input: unknown
): Promise<RemoteGraphMutationResult> {
  const result = await prepareCreateRemoteEdgeObject(storage, authorityId, input);
  await storePreparedRemoteGraphMutation(storage, result);
  return result;
}

export async function findRemoteEdgeObject(
  storage: RemoteGraphStorageBindings,
  authorityId: string,
  edgeId: string
): Promise<GraphObjectEnvelope | undefined> {
  await ensureRemoteGraphTables(storage.controlDb);
  const row = await storage.controlDb.prepare(`
SELECT object_ref, version, envelope_r2_key
FROM remote_graph_objects
WHERE authority_ref = ? AND edge_ref = ?
ORDER BY version DESC
LIMIT 1`).bind(await opaqueRef(authorityId), await opaqueRef(edgeId)).first<RemoteGraphObjectRow>();
  return row ? loadObject(storage, row.envelope_r2_key) : undefined;
}

export async function prepareUpdateRemoteEdgeObject(
  storage: RemoteGraphStorageBindings,
  authorityId: string,
  edgeId: string,
  patch: unknown,
  expectedVersion?: number
): Promise<RemoteGraphMutationResult> {
  const existing = await findRemoteEdgeObject(storage, authorityId, edgeId);
  if (!existing) {
    throw new Error("edge-not-found");
  }
  const existingEdge = edgeData(existing);
  if (!existingEdge) {
    throw new Error("invalid-edge-object");
  }
  const updatedEdge = TemporalEdgeSchema.parse({
    ...existingEdge,
    ...(isRecord(patch) ? patch : {})
  });
  return prepareUpdateRemoteGraphObject(storage, authorityId, existing.object_id, {
    payload: {
      kind: "plaintext-json",
      data: updatedEdge
    },
    content_hash: await sha256Hash(JSON.stringify(updatedEdge))
  }, expectedVersion);
}

export async function updateRemoteEdgeObject(
  storage: RemoteGraphStorageBindings,
  authorityId: string,
  edgeId: string,
  patch: unknown,
  expectedVersion?: number
): Promise<RemoteGraphMutationResult> {
  const result = await prepareUpdateRemoteEdgeObject(storage, authorityId, edgeId, patch, expectedVersion);
  await storePreparedRemoteGraphMutation(storage, result);
  return result;
}

export async function prepareDeleteRemoteEdgeObject(
  storage: RemoteGraphStorageBindings,
  authorityId: string,
  edgeId: string,
  expectedVersion?: number
): Promise<RemoteGraphMutationResult> {
  const existing = await findRemoteEdgeObject(storage, authorityId, edgeId);
  if (!existing) {
    throw new Error("edge-not-found");
  }
  return prepareDeleteRemoteGraphObject(storage, authorityId, existing.object_id, expectedVersion);
}

export async function deleteRemoteEdgeObject(
  storage: RemoteGraphStorageBindings,
  authorityId: string,
  edgeId: string,
  expectedVersion?: number
): Promise<RemoteGraphMutationResult> {
  const result = await prepareDeleteRemoteEdgeObject(storage, authorityId, edgeId, expectedVersion);
  await storePreparedRemoteGraphMutation(storage, result);
  return result;
}

export function canonicalPredicate(input: string): string {
  const result = canonicalizePredicate(input);
  if (!result.ok) {
    throw new Error(result.reason);
  }
  return result.predicate;
}
