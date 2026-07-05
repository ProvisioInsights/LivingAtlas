import { createHash } from "node:crypto";
import {
  EndpointRecordSchema,
  TemporalEdgeSchema,
  type EndpointRecord,
  type GraphObjectEnvelope,
  type TemporalEdge
} from "@living-atlas/contracts";
import { FileLocalGraphStore } from "@living-atlas/local-graph-store";
import {
  decryptGraphObjectPayload,
  FileLocalKeyringStore,
  type LocalKeyringState
} from "@living-atlas/local-keyring";
import type {
  AccessClass,
  AtlasEdge,
  AtlasNode,
  EncryptionClass,
  NodeType,
  WorkbenchGraph
} from "./workbench-state";

type PayloadCache = Map<string, Record<string, unknown> | undefined>;

export type WorkbenchSourceCapabilities = {
  source: "synthetic-server" | "local-graph-readonly";
  mutable: boolean;
  event_stream: boolean;
  object_limit?: number;
  truncated?: boolean;
  readable_payload_count?: number;
  edge_object_count?: number;
  readable_edge_count?: number;
  opaque_edge_object_count?: number;
  status?: {
    authority_id: string;
    generation: number;
    object_count: number;
    active_object_count: number;
    tombstone_count: number;
    plaintext_persistence: string;
  };
};

export type LocalGraphWorkbenchLoad = {
  graph: WorkbenchGraph;
  capabilities: WorkbenchSourceCapabilities;
};

const LocalGraphAck = "read-local-graph-metadata-for-workbench";
const LocalGraphDecryptAck = "decrypt-local-graph-for-workbench";
const LocalGraphPlaintextAck = "allow-plaintext-local-graph-workbench";
const defaultObjectLimit = 500;
const maxObjectLimit = 5000;

export function localGraphWorkbenchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LIVING_ATLAS_WORKBENCH_SOURCE === "local-graph";
}

export async function loadLocalGraphWorkbenchFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<LocalGraphWorkbenchLoad | undefined> {
  if (!localGraphWorkbenchEnabled(env)) {
    return undefined;
  }
  if (env.LIVING_ATLAS_WORKBENCH_LOCAL_GRAPH_ACK !== LocalGraphAck) {
    throw new Error(`Set LIVING_ATLAS_WORKBENCH_LOCAL_GRAPH_ACK=${LocalGraphAck} to use the local graph workbench source.`);
  }
  const directory = env.LIVING_ATLAS_LOCAL_GRAPH_DIR;
  if (!directory) {
    throw new Error("Set LIVING_ATLAS_LOCAL_GRAPH_DIR to use the local graph workbench source.");
  }

  const limit = objectLimitFromEnv(env);
  const store = await FileLocalGraphStore.open({
    directory,
    plaintextPersistence: env.LIVING_ATLAS_WORKBENCH_LOCAL_GRAPH_PLAINTEXT_ACK === LocalGraphPlaintextAck ? "allow" : "redact"
  });
  const status = store.status();
  const keyring = await optionalKeyring(env);
  const allObjects = store.listObjects({ include_tombstones: true });
  const projected = await projectLocalGraphObjects({
    objects: allObjects,
    keyring,
    objectLimit: limit
  });

  return {
    graph: projected.graph,
    capabilities: {
      source: "local-graph-readonly",
      mutable: false,
      event_stream: true,
      object_limit: limit,
      truncated: projected.truncated,
      readable_payload_count: projected.readablePayloadCount,
      edge_object_count: projected.edgeObjectCount,
      readable_edge_count: projected.readableEdgeCount,
      opaque_edge_object_count: projected.opaqueEdgeObjectCount,
      status: {
        authority_id: status.authority_id,
        generation: status.generation,
        object_count: status.object_count,
        active_object_count: status.active_object_count,
        tombstone_count: status.tombstone_count,
        plaintext_persistence: status.plaintext_persistence
      }
    }
  };
}

export async function projectLocalGraphObjects(input: {
  objects: GraphObjectEnvelope[];
  keyring?: LocalKeyringState;
  objectLimit?: number;
}): Promise<{
  graph: WorkbenchGraph;
  truncated: boolean;
  readablePayloadCount: number;
  edgeObjectCount: number;
  readableEdgeCount: number;
  opaqueEdgeObjectCount: number;
}> {
  const limit = Math.max(1, Math.min(input.objectLimit ?? defaultObjectLimit, maxObjectLimit));
  const payloadCache: PayloadCache = new Map();
  const objectsById = new Map(input.objects.map((object) => [object.object_id, object]));
  const selectedObjects = await selectWorkbenchObjects({
    objects: input.objects,
    keyring: input.keyring,
    limit,
    payloadCache
  });
  const truncated = input.objects.length > selectedObjects.length;
  const nodesById = new Map<string, AtlasNode>();
  const edges: AtlasEdge[] = [];
  const edgeObjectCount = input.objects.filter((object) => object.object_type === "edge").length;
  let opaqueEdgeObjectCount = 0;
  let readablePayloadCount = 0;

  for (const object of selectedObjects) {
    const isEdgeObject = object.object_type === "edge";
    const payload = await cachedPayloadDataForObject(object, input.keyring, payloadCache);
    if (payload) {
      readablePayloadCount += 1;
    }

    const endpoint = endpointFromPayload(payload);
    if (endpoint) {
      nodesById.set(endpoint.object_id, nodeFromEndpoint(endpoint, object));
      continue;
    }

    const edge = edgeFromPayload(payload);
    if (edge) {
      edges.push(edgeFromTemporalEdge(edge, object));
      await ensureReferenceNode({
        nodesById,
        objectId: edge.source_object_id,
        type: edge.source_type,
        accessClass: object.access_class,
        encryptionClass: object.encryption_class,
        edge,
        endpointRole: "source",
        objectsById,
        keyring: input.keyring,
        payloadCache
      });
      await ensureReferenceNode({
        nodesById,
        objectId: edge.target_object_id,
        type: edge.target_type,
        accessClass: object.access_class,
        encryptionClass: object.encryption_class,
        edge,
        endpointRole: "target",
        objectsById,
        keyring: input.keyring,
        payloadCache
      });
      continue;
    }

    if (isEdgeObject) {
      opaqueEdgeObjectCount += 1;
    }
    nodesById.set(object.object_id, nodeFromObjectEnvelope(object));
  }

  const graph: WorkbenchGraph = {
    nodes: [...nodesById.values()],
    edges,
    audit: [
      {
        event_id: `la_event_workbench_${shortHash(`local-graph:${selectedObjects.length}:${edges.length}`, 16)}`,
        at: new Date().toISOString(),
        action: "graph.imported",
        subject_id: "local-graph",
        summary: "Loaded local graph projection",
        operation: {
          source: "local-graph-readonly",
          objects_considered: selectedObjects.length,
          total_objects: input.objects.length,
          truncated,
          readable_payload_count: readablePayloadCount,
          edge_object_count: edgeObjectCount,
          readable_edge_count: edges.length,
          opaque_edge_object_count: opaqueEdgeObjectCount
        }
      }
    ]
  };

  return {
    graph,
    truncated,
    readablePayloadCount,
    edgeObjectCount,
    readableEdgeCount: edges.length,
    opaqueEdgeObjectCount
  };
}

async function selectWorkbenchObjects(input: {
  objects: GraphObjectEnvelope[];
  keyring?: LocalKeyringState;
  limit: number;
  payloadCache: PayloadCache;
}): Promise<GraphObjectEnvelope[]> {
  const newestFirst = (left: GraphObjectEnvelope, right: GraphObjectEnvelope): number => right.updated_at.localeCompare(left.updated_at);
  const objectsById = new Map(input.objects.map((object) => [object.object_id, object]));
  const selected: GraphObjectEnvelope[] = [];
  const seen = new Set<string>();
  const endpointObjectIds = new Set<string>();

  const addObject = (object: GraphObjectEnvelope | undefined): boolean => {
    if (!object || seen.has(object.object_id)) {
      return false;
    }
    if (selected.length >= input.limit) {
      return false;
    }
    seen.add(object.object_id);
    selected.push(object);
    return true;
  };

  for (const object of input.objects.filter((candidate) => candidate.object_type === "edge").sort(newestFirst)) {
    if (!addObject(object)) {
      break;
    }
    const edge = edgeFromPayload(await cachedPayloadDataForObject(object, input.keyring, input.payloadCache));
    if (edge) {
      endpointObjectIds.add(edge.source_object_id);
      endpointObjectIds.add(edge.target_object_id);
    }
  }

  for (const objectId of endpointObjectIds) {
    addObject(objectsById.get(objectId));
  }

  const cohorts = [
    input.objects.filter((object) => object.object_type !== "edge" && object.object_type !== "attachment").sort(newestFirst),
    input.objects.filter((object) => object.object_type === "attachment").sort(newestFirst)
  ];

  for (const cohort of cohorts) {
    for (const object of cohort) {
      if (selected.length >= input.limit) {
        return selected;
      }
      addObject(object);
    }
  }
  return selected;
}

async function optionalKeyring(env: NodeJS.ProcessEnv): Promise<LocalKeyringState | undefined> {
  if (env.LIVING_ATLAS_WORKBENCH_DECRYPT_ACK !== LocalGraphDecryptAck) {
    return undefined;
  }
  const keyringPath = env.LIVING_ATLAS_LOCAL_KEYRING;
  const passphrase = env.LIVING_ATLAS_LOCAL_KEYRING_PASSPHRASE;
  if (!keyringPath || !passphrase) {
    throw new Error("Set LIVING_ATLAS_LOCAL_KEYRING and LIVING_ATLAS_LOCAL_KEYRING_PASSPHRASE to decrypt local graph payloads.");
  }
  return new FileLocalKeyringStore(keyringPath).read(passphrase);
}

function objectLimitFromEnv(env: NodeJS.ProcessEnv): number {
  const raw = env.LIVING_ATLAS_WORKBENCH_LOCAL_GRAPH_LIMIT;
  if (!raw) {
    return defaultObjectLimit;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("LIVING_ATLAS_WORKBENCH_LOCAL_GRAPH_LIMIT must be a positive integer.");
  }
  return Math.min(parsed, maxObjectLimit);
}

async function payloadDataForObject(object: GraphObjectEnvelope, keyring: LocalKeyringState | undefined): Promise<Record<string, unknown> | undefined> {
  if (object.payload.kind === "plaintext-json") {
    return object.payload.data;
  }
  if (!keyring) {
    return undefined;
  }
  const decrypted = await decryptGraphObjectPayload(object, keyring);
  return decrypted?.kind === "plaintext-json" ? decrypted.data : undefined;
}

async function cachedPayloadDataForObject(object: GraphObjectEnvelope, keyring: LocalKeyringState | undefined, cache: PayloadCache): Promise<Record<string, unknown> | undefined> {
  if (cache.has(object.object_id)) {
    return cache.get(object.object_id);
  }
  const payload = await payloadDataForObject(object, keyring);
  cache.set(object.object_id, payload);
  return payload;
}

function endpointFromPayload(payload: Record<string, unknown> | undefined): EndpointRecord | undefined {
  if (!payload) {
    return undefined;
  }
  const candidate = payload.endpoint && typeof payload.endpoint === "object" && !Array.isArray(payload.endpoint)
    ? payload.endpoint
    : payload;
  const parsed = EndpointRecordSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

function edgeFromPayload(payload: Record<string, unknown> | undefined): TemporalEdge | undefined {
  if (!payload) {
    return undefined;
  }
  const candidate = payload.edge && typeof payload.edge === "object" && !Array.isArray(payload.edge)
    ? payload.edge
    : payload;
  const parsed = TemporalEdgeSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

function nodeFromEndpoint(endpoint: EndpointRecord, object: GraphObjectEnvelope): AtlasNode {
  return {
    object_id: endpoint.object_id,
    type: endpoint.type,
    subtype: endpoint.subtype,
    name: endpoint.name,
    description: endpoint.description,
    access_class: object.access_class,
    encryption_class: object.encryption_class,
    confidence: endpoint.confidence,
    updated_at: endpoint.updated_at,
    tombstone: object.visible_metadata.tombstone
  };
}

function edgeFromTemporalEdge(edge: TemporalEdge, object: GraphObjectEnvelope): AtlasEdge {
  return {
    edge_id: edge.edge_id,
    source_object_id: edge.source_object_id,
    source_type: edge.source_type,
    target_object_id: edge.target_object_id,
    target_type: edge.target_type,
    predicate: edge.predicate,
    valid_from: edge.valid_from,
    valid_to: edge.valid_to,
    status: edge.status,
    confidence: edge.confidence,
    source: edge.source,
    access_class: object.access_class,
    encryption_class: object.encryption_class,
    attrs: primitiveAttrs(edge.attrs),
    tombstone: object.visible_metadata.tombstone
  };
}

function nodeFromObjectEnvelope(object: GraphObjectEnvelope): AtlasNode {
  const namespace = object.visible_metadata.schema_namespace ?? object.object_type;
  return {
    object_id: object.object_id,
    type: "object",
    subtype: object.object_type,
    name: objectEnvelopeName(object),
    description: `${namespace} / ${objectPayloadSummary(object)}`,
    access_class: object.access_class,
    encryption_class: object.encryption_class,
    confidence: "medium",
    updated_at: object.updated_at,
    tombstone: object.visible_metadata.tombstone
  };
}

function objectEnvelopeName(object: GraphObjectEnvelope): string {
  const suffix = shortHash(object.object_id, 8);
  if (object.object_type === "attachment") {
    return `Attachment support record ${suffix}`;
  }
  if (object.object_type === "edge" && isRedactedPayload(object)) {
    return `Opaque edge envelope ${suffix}`;
  }
  return `${object.object_type}:${suffix}`;
}

function objectPayloadSummary(object: GraphObjectEnvelope): string {
  if (isRedactedPayload(object)) {
    return "redacted-payload";
  }
  return object.payload.kind;
}

function isRedactedPayload(object: GraphObjectEnvelope): boolean {
  return object.payload.kind === "ciphertext-inline" && object.payload.algorithm === "local-graph-store-redacted-v1";
}

async function ensureReferenceNode(input: {
  nodesById: Map<string, AtlasNode>;
  objectId: string;
  type: Exclude<NodeType, "object">;
  accessClass: AccessClass;
  encryptionClass: EncryptionClass;
  edge: TemporalEdge;
  endpointRole: "source" | "target";
  objectsById: Map<string, GraphObjectEnvelope>;
  keyring?: LocalKeyringState;
  payloadCache: PayloadCache;
}): Promise<void> {
  if (input.nodesById.has(input.objectId)) {
    return;
  }
  const inferredName = await inferredReferenceName(input);
  input.nodesById.set(input.objectId, {
    object_id: input.objectId,
    type: input.type,
    subtype: "reference",
    name: inferredName ?? `${input.type}:${shortHash(input.objectId, 8)}`,
    description: "Referenced endpoint not present in the current workbench projection.",
    access_class: input.accessClass,
    encryption_class: input.encryptionClass,
    confidence: inferredName ? "medium" : "low",
    updated_at: new Date().toISOString()
  });
}

async function inferredReferenceName(input: {
  edge: TemporalEdge;
  endpointRole: "source" | "target";
  objectsById: Map<string, GraphObjectEnvelope>;
  keyring?: LocalKeyringState;
  payloadCache: PayloadCache;
}): Promise<string | undefined> {
  if (input.endpointRole !== "target") {
    return undefined;
  }
  const sourceCapsuleObjectId = typeof input.edge.attrs.source_capsule_object_id === "string"
    ? input.edge.attrs.source_capsule_object_id
    : undefined;
  const propertyKey = typeof input.edge.attrs.property_key === "string"
    ? input.edge.attrs.property_key
    : undefined;
  if (!sourceCapsuleObjectId || !propertyKey) {
    return undefined;
  }
  const sourceCapsule = input.objectsById.get(sourceCapsuleObjectId);
  if (!sourceCapsule) {
    return undefined;
  }
  const payload = await cachedPayloadDataForObject(sourceCapsule, input.keyring, input.payloadCache);
  const markdown = typeof payload?.markdown === "string" ? payload.markdown : undefined;
  if (!markdown) {
    return undefined;
  }
  return referenceNameFromMarkdownProperty(markdown, propertyKey);
}

function referenceNameFromMarkdownProperty(markdown: string, propertyKey: string): string | undefined {
  const propertyPattern = new RegExp(`^${escapeRegExp(propertyKey)}::\\s*(.+)$`, "im");
  const rawValue = propertyPattern.exec(markdown)?.[1]?.trim();
  if (!rawValue) {
    return undefined;
  }
  const wikiLink = /\[\[([^\]]+)]]/.exec(rawValue)?.[1]?.trim();
  const candidate = wikiLink ?? rawValue
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/^["']|["']$/g, "")
    .trim();
  return candidate || undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function primitiveAttrs(attrs: Record<string, unknown>): Record<string, string | number | boolean> {
  const output: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      output[key] = value;
    }
  }
  return output;
}

function shortHash(value: string, length: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}
