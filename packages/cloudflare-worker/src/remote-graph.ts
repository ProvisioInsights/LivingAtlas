import {
  GraphObjectEnvelopeSchema,
  TemporalEdgeSchema,
  canonicalizePredicate,
  isRemoteReadableAccessClass,
  type GraphObjectEnvelope,
  type ObjectType,
  type TemporalEdge
} from "@living-atlas/contracts";

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

const RemoteGraphIndexSql = [
  "CREATE INDEX IF NOT EXISTS idx_remote_graph_authority_object ON remote_graph_objects (authority_ref, object_ref, version)",
  "CREATE INDEX IF NOT EXISTS idx_remote_graph_authority_updated ON remote_graph_objects (authority_ref, updated_at)",
  "CREATE INDEX IF NOT EXISTS idx_remote_graph_authority_type ON remote_graph_objects (authority_ref, object_type, updated_at)",
  "CREATE INDEX IF NOT EXISTS idx_remote_graph_authority_edge ON remote_graph_objects (authority_ref, edge_ref, version)",
  "CREATE INDEX IF NOT EXISTS idx_remote_graph_authority_source ON remote_graph_objects (authority_ref, source_ref, predicate)",
  "CREATE INDEX IF NOT EXISTS idx_remote_graph_authority_target ON remote_graph_objects (authority_ref, target_ref, predicate)",
  "CREATE INDEX IF NOT EXISTS idx_remote_graph_authority_timeline ON remote_graph_objects (authority_ref, timeline_start)"
];

export const RemoteGraphD1SchemaStatements = [
  RemoteGraphObjectsSql,
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
  return `sha256:${await sha256Hex(value)}`;
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

async function remoteGraphEnvelopeR2Key(object: GraphObjectEnvelope): Promise<string> {
  const authority = (await sha256Hex(object.authority_id)).slice(0, 16);
  const segment = (await sha256Hex([
    "remote-graph-envelope:v1",
    object.authority_id,
    object.object_id,
    String(object.version),
    object.content_hash
  ].join(":"))).slice(0, 40);
  return `remote-graph/a=${authority}/p=${segment.slice(0, 2)}/s=${segment}.json`;
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
INSERT OR REPLACE INTO remote_graph_objects (
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

async function loadObject(storage: RemoteGraphStorageBindings, key: string): Promise<GraphObjectEnvelope> {
  const body = await storage.graphBucket.get(key);
  if (!body) {
    throw new Error(`Missing remote graph envelope: ${key}`);
  }
  return GraphObjectEnvelopeSchema.parse(JSON.parse(await body.text()));
}

function ensureRemoteGraphObject(input: unknown): GraphObjectEnvelope {
  const parsed = GraphObjectEnvelopeSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error("invalid-graph-object-envelope");
  }
  const object = parsed.data;
  if (!objectAllowedForRemoteGraph(object)) {
    throw new Error("remote graph objects must be remote-readable plaintext");
  }
  return object;
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

export async function createRemoteGraphObject(
  storage: RemoteGraphStorageBindings,
  input: unknown
): Promise<RemoteGraphMutationResult> {
  await ensureRemoteGraphTables(storage.controlDb);
  const object = ensureRemoteGraphObject(input);
  const existing = await latestRemoteGraphObject(storage, object.authority_id, object.object_id);
  if (existing && !existing.visible_metadata.tombstone) {
    throw new Error("object-already-exists");
  }
  await storeRemoteGraphObject(storage, object);
  return {
    mutation: existing ? "restored" : "created",
    object,
    previous_version: existing?.version,
    new_version: object.version
  };
}

export async function updateRemoteGraphObject(
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
  const merged = ensureRemoteGraphObject({
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
    content_hash: typeof patch.content_hash === "string" ? patch.content_hash : await sha256Hash(JSON.stringify(patch.payload ?? existing.payload))
  });
  await storeRemoteGraphObject(storage, merged);
  return {
    mutation: merged.visible_metadata.tombstone ? "deleted" : "updated",
    object: merged,
    previous_version: existing.version,
    new_version: merged.version
  };
}

export async function deleteRemoteGraphObject(
  storage: RemoteGraphStorageBindings,
  authorityId: string,
  objectId: string,
  expectedVersion?: number
): Promise<RemoteGraphMutationResult> {
  return updateRemoteGraphObject(
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

export async function createRemoteEdgeObject(
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
  return createRemoteGraphObject(storage, object);
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

export async function updateRemoteEdgeObject(
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
  return updateRemoteGraphObject(storage, authorityId, existing.object_id, {
    payload: {
      kind: "plaintext-json",
      data: updatedEdge
    },
    content_hash: await sha256Hash(JSON.stringify(updatedEdge))
  }, expectedVersion);
}

export async function deleteRemoteEdgeObject(
  storage: RemoteGraphStorageBindings,
  authorityId: string,
  edgeId: string,
  expectedVersion?: number
): Promise<RemoteGraphMutationResult> {
  const existing = await findRemoteEdgeObject(storage, authorityId, edgeId);
  if (!existing) {
    throw new Error("edge-not-found");
  }
  return deleteRemoteGraphObject(storage, authorityId, existing.object_id, expectedVersion);
}

export function canonicalPredicate(input: string): string {
  const result = canonicalizePredicate(input);
  if (!result.ok) {
    throw new Error(result.reason);
  }
  return result.predicate;
}
