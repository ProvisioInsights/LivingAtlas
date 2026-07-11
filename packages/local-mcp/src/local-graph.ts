import { createHash } from "node:crypto";
import type {
  CapabilityGrant,
  ControlPlaneSnapshot,
  GraphObjectEnvelope,
  LocalControlState,
  ObjectId,
  ObjectType,
  Operation
} from "@living-atlas/contracts";
import {
  AccessClassSchema,
  CanonicalWriteSchema,
  type CanonicalPayload,
  type CanonicalReviewItemPayload,
  EncryptionClassSchema,
  GraphObjectEnvelopeSchema,
  GraphPayloadSchema,
  IsoTimestampSchema,
  KeyIdSchema,
  ObjectIdSchema,
  ObjectTypeSchema,
  Sha256HashSchema,
  TemporalEdgeSchema,
  canonicalPayloadObjectId,
  canonicalizePredicate,
  type TemporalEdge
} from "@living-atlas/contracts";
import { controlPlaneFixture, syntheticGraphObjects } from "@living-atlas/fixtures";
import type {
  FileLocalGraphStore,
  LocalGraphOperationRecord,
  LocalGraphResolutionRequestFingerprint
} from "@living-atlas/local-graph-store";
import {
  PlaintextGraphObjectDraftSchema,
  type PlaintextGraphObjectDraft
} from "@living-atlas/local-keyring";
import { evaluatePolicy, type PolicyDecision } from "@living-atlas/policy";
import { z } from "zod";
import {
  createLocalMcpLiveActivityEvent,
  type LocalMcpActivitySink
} from "./activity";
import { createLocalMcpAuditEvent, type LocalMcpAuditSink } from "./audit";
import {
  authenticateLocalMcp,
  InMemoryLocalMcpCredentialStore,
  type LocalMcpAuthenticatedClient,
  type LocalMcpCredentialStore
} from "./auth";

export type LocalMcpContext = {
  controlPlane: ControlPlaneSnapshot;
  graphObjects: GraphObjectEnvelope[];
  graphStore?: FileLocalGraphStore;
  /** Decrypts a durable local object only inside the authenticated local MCP process. */
  decryptPayload?: (object: GraphObjectEnvelope) => Promise<GraphObjectEnvelope["payload"] | undefined>;
  credentialStore: LocalMcpCredentialStore;
  auditSink?: LocalMcpAuditSink;
  activitySink?: LocalMcpActivitySink;
  outboxSink?: LocalMcpMutationOutboxSink;
  now?: string;
  syntheticStoreLimits?: Partial<LocalGraphSyntheticStoreLimits>;
};

export type LocalMcpMutationOutboxRecord = {
  mutation: "created" | "updated" | "tombstoned";
  object: GraphObjectEnvelope;
  actor_id: string;
  recorded_at: string;
  generation: number;
  journal_sequence: number;
  operation_id?: string;
  idempotency_key?: string;
  change_id?: string;
};

export type LocalMcpMutationOutboxSink = {
  enqueue(record: LocalMcpMutationOutboxRecord): Promise<void>;
};

export type LocalGraphSyntheticStoreLimits = {
  maxObjects: number;
  maxEnvelopeBytes: number;
};

const DefaultSyntheticStoreLimits: LocalGraphSyntheticStoreLimits = {
  maxObjects: 256,
  maxEnvelopeBytes: 64 * 1024
};

const LocalGraphVisibleMetadataPatchSchema = z
  .object({
    schema_namespace: z.string().min(1).optional(),
    size_class: z.enum(["tiny", "small", "medium", "large", "huge"]).optional(),
    remote_indexable: z.boolean().optional(),
    release_expires_at: IsoTimestampSchema.optional()
  })
  .strict();

export const LocalGraphUpdatePatchSchema = z
  .object({
    object_type: ObjectTypeSchema.optional(),
    access_class: AccessClassSchema.optional(),
    encryption_class: EncryptionClassSchema.optional(),
    updated_at: IsoTimestampSchema.optional(),
    content_hash: Sha256HashSchema.optional(),
    key_ref: KeyIdSchema.optional(),
    visible_metadata: LocalGraphVisibleMetadataPatchSchema.optional(),
    payload: GraphPayloadSchema.optional()
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, "Synthetic update patch must include at least one field.");

export const LocalGraphExpectedVersionSchema = z.number().int().nonnegative().optional();
export const LocalGraphObjectInputSchema = z.union([
  GraphObjectEnvelopeSchema,
  PlaintextGraphObjectDraftSchema
]);
export type LocalGraphUpdatePatch = z.infer<typeof LocalGraphUpdatePatchSchema>;
type LocalGraphObjectInput = GraphObjectEnvelope | PlaintextGraphObjectDraft;

export type AuthorizedLocalObject = {
  object_id: string;
  object_type: GraphObjectEnvelope["object_type"];
  version: number;
  access_class: GraphObjectEnvelope["access_class"];
  encryption_class: GraphObjectEnvelope["encryption_class"];
  visible_metadata: GraphObjectEnvelope["visible_metadata"];
  payload: GraphObjectEnvelope["payload"];
  plaintext_available: boolean;
};

/** A local-only read view may hold decrypted payload bytes without claiming the on-disk envelope is plaintext. */
type LocalGraphReadableObject = Omit<GraphObjectEnvelope, "payload"> & {
  payload: GraphObjectEnvelope["payload"];
};

export type LocalGraphStatusResult = {
  authority_id: string;
  policy_generation: number;
  object_count: number;
  plaintext_persistence?: "redacted" | "encrypted" | "allowed";
  client_id: string;
  profile: CapabilityGrant["profile"];
  access_classes: CapabilityGrant["access_classes"];
  operations: CapabilityGrant["operations"];
};

export type LocalGraphListResult = {
  objects: AuthorizedLocalObject[];
  withheld_count: number;
};

export type LocalGraphReadResult = {
  object: AuthorizedLocalObject;
};

export type LocalGraphToolInput = {
  authorization: string;
};

export type LocalGraphReadToolInput = LocalGraphToolInput & {
  object_id: ObjectId;
};

export type LocalGraphCreateToolInput = LocalGraphToolInput & {
  object: unknown;
};

export type LocalGraphUpdateToolInput = LocalGraphToolInput & {
  object_id: ObjectId;
  expected_version?: number;
  patch: LocalGraphUpdatePatch;
};

export type LocalGraphTombstoneToolInput = LocalGraphToolInput & {
  object_id: ObjectId;
  expected_version?: number;
};

export type LocalGraphAuthorityToolInput = LocalGraphToolInput & {
  authority_id?: string;
};

export type LocalGraphSearchToolInput = LocalGraphAuthorityToolInput & {
  query?: string;
  object_type?: ObjectType;
  limit?: number;
};

export type LocalGraphTraverseToolInput = LocalGraphAuthorityToolInput & {
  start_object_id?: ObjectId;
  direction?: "outbound" | "inbound" | "both";
  max_depth?: number;
  predicates?: string[];
  limit?: number;
};

export type LocalGraphTimelineToolInput = LocalGraphAuthorityToolInput & {
  from?: string;
  to?: string;
  object_id?: ObjectId;
  predicate?: string;
  limit?: number;
};

export type LocalGraphEdgeCreateToolInput = LocalGraphAuthorityToolInput & {
  edge?: unknown;
};

export type LocalGraphEdgeReadToolInput = LocalGraphAuthorityToolInput & {
  edge_id?: string;
};

export type LocalGraphEdgeUpdateToolInput = LocalGraphAuthorityToolInput & {
  edge_id?: string;
  expected_version?: number;
  patch?: unknown;
};

export type LocalGraphEdgeDeleteToolInput = LocalGraphAuthorityToolInput & {
  edge_id?: string;
  expected_version?: number;
};

export type LocalResolutionApplyInput = LocalGraphToolInput & {
  operation_id: string;
  idempotency_key: string;
  candidate_id: string;
  expected_generation: number;
  expected_review_version: number;
  objects: unknown[];
};

export type LocalResolutionApplyBatchInput = LocalGraphToolInput & {
  operation_id: string;
  idempotency_key: string;
  expected_generation: number;
  resolutions: Array<Pick<LocalResolutionApplyInput, "candidate_id" | "expected_review_version" | "objects">>;
};

export type LocalResolutionReceipt = {
  local_commit: "committed" | "not-committed";
  audit: "recorded" | "reconciliation-required";
  sync_queue: "queued" | "not-configured" | "reconciliation-required";
  committed_object_ids: string[];
  resolved_candidate_ids: string[];
  generation?: number;
  journal_sequence?: number;
};

export type LocalGraphMutationResult = {
  object: AuthorizedLocalObject;
  mutation: "created" | "updated" | "tombstoned";
  persistence: "synthetic-in-memory" | "snapshot+journal";
  object_count: number;
  previous_version?: number;
  new_version: number;
  generation?: number;
  journal_sequence?: number;
};

export type LocalGraphSearchResult = {
  object: AuthorizedLocalObject;
  score: number;
  matched_fields: string[];
  snippet?: string;
};

export type LocalGraphTraverseResult = {
  start_object_id: string;
  max_depth: number;
  visited_object_ids: string[];
  edges: AuthorizedLocalObject[];
};

export type LocalGraphTimelineResult = {
  object: AuthorizedLocalObject;
  timeline_at: string;
  field: string;
};

export type LocalGraphToolResult<T> =
  | {
      ok: true;
      result: T;
    }
  | {
      ok: false;
      reason: string;
      result?: unknown;
    };

export function createFixtureLocalMcpContext(options: {
  credentialStore: LocalMcpCredentialStore;
  auditSink?: LocalMcpAuditSink;
  activitySink?: LocalMcpActivitySink;
  outboxSink?: LocalMcpMutationOutboxSink;
  now?: string;
  syntheticStoreLimits?: Partial<LocalGraphSyntheticStoreLimits>;
}): LocalMcpContext {
  return {
    controlPlane: controlPlaneFixture,
    graphObjects: cloneGraphObjects(syntheticGraphObjects),
    credentialStore: options.credentialStore,
    auditSink: options.auditSink,
    activitySink: options.activitySink,
    outboxSink: options.outboxSink,
    now: options.now,
    syntheticStoreLimits: options.syntheticStoreLimits
  };
}

export function createLocalMcpContextFromControlState(options: {
  controlState: LocalControlState;
  graphObjects?: GraphObjectEnvelope[];
  graphStore?: FileLocalGraphStore;
  decryptPayload?: (object: GraphObjectEnvelope) => Promise<GraphObjectEnvelope["payload"] | undefined>;
  auditSink?: LocalMcpAuditSink;
  activitySink?: LocalMcpActivitySink;
  outboxSink?: LocalMcpMutationOutboxSink;
  now?: string;
  syntheticStoreLimits?: Partial<LocalGraphSyntheticStoreLimits>;
}): LocalMcpContext {
  return {
    controlPlane: options.controlState.control_plane,
    graphObjects: cloneGraphObjects(options.graphObjects ?? syntheticGraphObjects),
    graphStore: options.graphStore,
    decryptPayload: options.decryptPayload,
    credentialStore: new InMemoryLocalMcpCredentialStore(options.controlState.local_credentials),
    auditSink: options.auditSink,
    activitySink: options.activitySink,
    outboxSink: options.outboxSink,
    now: options.now,
    syntheticStoreLimits: options.syntheticStoreLimits
  };
}

function cloneGraphObject(object: GraphObjectEnvelope): GraphObjectEnvelope {
  return GraphObjectEnvelopeSchema.parse(structuredClone(object));
}

function cloneGraphObjects(objects: GraphObjectEnvelope[]): GraphObjectEnvelope[] {
  return objects.map(cloneGraphObject);
}

function recordToolDecision(input: {
  context: LocalMcpContext;
  authenticated?: LocalMcpAuthenticatedClient;
  toolName: string;
  operation: Operation;
  object?: GraphObjectEnvelope;
  decision?: PolicyDecision;
  allowed: boolean;
  reason: string;
  operationId?: string;
  idempotencyKey?: string;
}): void {
  input.context.auditSink?.record(
    createLocalMcpAuditEvent({
      event_type: input.allowed ? "tool.allowed" : "tool.denied",
      client_id: input.authenticated?.client.client_id,
      profile: input.authenticated?.capability.profile,
      operation: input.operation,
      tool_name: input.toolName,
      object_id: input.object?.object_id,
      access_class: input.object?.access_class,
      operation_id: input.operationId,
      idempotency_key: input.idempotencyKey,
      reason_code: input.reason,
      summary: input.allowed ? "Local MCP tool call allowed" : "Local MCP tool call denied"
    })
  );
  input.context.activitySink?.record(
    createLocalMcpLiveActivityEvent({
      client_id: input.authenticated?.client.client_id,
      profile: input.authenticated?.capability.profile,
      operation: input.operation,
      tool_name: input.toolName,
      object: input.object,
      allowed: input.allowed,
      reason_code: input.reason,
      recorded_at: input.context.now
    })
  );
}

async function authenticateToolCall(context: LocalMcpContext, authorization: string): Promise<LocalMcpAuthenticationResult> {
  return authenticateLocalMcp({
    authorizationHeader: authorization,
    credentialStore: context.credentialStore,
    controlPlane: context.controlPlane,
    auditSink: context.auditSink,
    now: context.now
  });
}

type LocalMcpAuthenticationResult = Awaited<ReturnType<typeof authenticateLocalMcp>>;

function nowForMutation(context: LocalMcpContext): string {
  return context.now ?? new Date().toISOString();
}

function syntheticStoreLimits(context: LocalMcpContext): LocalGraphSyntheticStoreLimits {
  return {
    ...DefaultSyntheticStoreLimits,
    ...context.syntheticStoreLimits
  };
}

function envelopeByteSize(object: unknown): number {
  return Buffer.byteLength(JSON.stringify(object), "utf8");
}

function findObjectIndex(context: LocalMcpContext, objectId: ObjectId): number {
  return context.graphObjects.findIndex((candidate) => candidate.object_id === objectId);
}

function contextObjects(context: LocalMcpContext): GraphObjectEnvelope[] {
  return context.graphStore
    ? context.graphStore.listObjects({ include_tombstones: true })
    : context.graphObjects;
}

function contextActiveObjectCount(context: LocalMcpContext): number {
  return context.graphStore
    ? context.graphStore.status().object_count
    : context.graphObjects.length;
}

function readContextObject(context: LocalMcpContext, objectId: ObjectId): GraphObjectEnvelope | undefined {
  return context.graphStore
    ? context.graphStore.readObject(objectId)
    : context.graphObjects.find((candidate) => candidate.object_id === objectId);
}

async function materializeAuthorizedObject(
  context: LocalMcpContext,
  object: GraphObjectEnvelope,
  plaintextAllowed: boolean
): Promise<LocalGraphReadableObject> {
  if (!plaintextAllowed || object.payload.kind === "plaintext-json" || !context.decryptPayload) {
    return object;
  }
  const payload = await context.decryptPayload(object);
  return payload ? { ...object, payload } : object;
}

function objectWithinSyntheticLimit(context: LocalMcpContext, object: unknown): boolean {
  return envelopeByteSize(object) <= syntheticStoreLimits(context).maxEnvelopeBytes;
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function boundedLimit(limit: number | undefined, max = 1000): number {
  return Math.min(Math.max(limit ?? 100, 1), max);
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
  if (value && typeof value === "object") {
    return Object.entries(value)
      .map(([key, nested]) => `${key} ${textFromValue(nested)}`)
      .join(" ");
  }
  return "";
}

function plaintextData(object: LocalGraphReadableObject): Record<string, unknown> | undefined {
  return object.payload.kind === "plaintext-json" ? object.payload.data : undefined;
}

function searchText(object: LocalGraphReadableObject): string {
  return [
    object.object_id,
    object.object_type,
    object.access_class,
    object.visible_metadata.schema_namespace,
    textFromValue(object.visible_metadata),
    textFromValue(plaintextData(object))
  ].filter(Boolean).join(" ").toLowerCase();
}

function edgeData(object: LocalGraphReadableObject): TemporalEdge | undefined {
  if (object.object_type !== "edge") {
    return undefined;
  }
  const data = plaintextData(object);
  if (!data) {
    return undefined;
  }
  const candidate = data.edge && typeof data.edge === "object" && !Array.isArray(data.edge) ? data.edge : data;
  const parsed = TemporalEdgeSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

function timelineCandidates(object: LocalGraphReadableObject): Array<{ field: string; value: string }> {
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

function canonicalPredicate(input: string): string {
  const result = canonicalizePredicate(input);
  if (!result.ok) {
    throw new Error(result.reason);
  }
  return result.predicate;
}

function validateAuthority(context: LocalMcpContext, authorityId: string | undefined): boolean {
  return !authorityId || authorityId === context.controlPlane.authority.authority_id;
}

function localEdgeObjectId(edgeId: string): ObjectId {
  return ObjectIdSchema.parse(`la_object_${createHash("sha256").update(edgeId).digest("hex").slice(0, 24)}`);
}

function edgeObjectFromTemporalEdge(context: LocalMcpContext, edge: TemporalEdge, now: string): GraphObjectEnvelope {
  return GraphObjectEnvelopeSchema.parse({
    schema_version: 1,
    authority_id: context.controlPlane.authority.authority_id,
    object_id: localEdgeObjectId(edge.edge_id),
    object_type: "edge",
    version: 1,
    access_class: "remote-safe",
    encryption_class: "plaintext",
    created_at: now,
    updated_at: now,
    content_hash: sha256(JSON.stringify(edge)),
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
}

function findEdgeObject(context: LocalMcpContext, edgeId: string): GraphObjectEnvelope | undefined {
  return contextObjects(context).find((object) => edgeData(object)?.edge_id === edgeId);
}

function operationDecision(input: {
  context: LocalMcpContext;
  authenticated: LocalMcpAuthenticatedClient;
  operation: Operation;
  object: GraphObjectEnvelope;
}): PolicyDecision {
  return evaluatePolicy({
    profile: input.authenticated.capability.profile,
    operation: input.operation,
    actor_id: input.authenticated.client.client_id,
    capability: input.authenticated.capability,
    now: input.context.now
  }, input.object);
}

function policyEnvelopeForDraft(draft: PlaintextGraphObjectDraft): GraphObjectEnvelope {
  return GraphObjectEnvelopeSchema.parse({
    ...draft,
    encryption_class: "client-encrypted",
    payload: {
      kind: "ciphertext-inline",
      ciphertext: "policy-placeholder",
      nonce: "policy-placeholder",
      algorithm: "AES-GCM-256+local-keyring-v1"
    }
  });
}

function parseLocalGraphObjectInput(input: unknown, allowPlaintextDraft: boolean): {
  object: LocalGraphObjectInput;
  policyObject: GraphObjectEnvelope;
} | undefined {
  const parsedEnvelope = GraphObjectEnvelopeSchema.safeParse(input);
  if (parsedEnvelope.success) {
    return {
      object: parsedEnvelope.data,
      policyObject: parsedEnvelope.data
    };
  }

  if (!allowPlaintextDraft) {
    return undefined;
  }

  const parsedDraft = PlaintextGraphObjectDraftSchema.safeParse(input);
  if (!parsedDraft.success) {
    return undefined;
  }

  return {
    object: parsedDraft.data,
    policyObject: policyEnvelopeForDraft(parsedDraft.data)
  };
}

function sanitizeAuthorizedObject(object: LocalGraphReadableObject, plaintextAllowed: boolean): AuthorizedLocalObject {
  return {
    object_id: object.object_id,
    object_type: object.object_type,
    version: object.version,
    access_class: object.access_class,
    encryption_class: object.encryption_class,
    visible_metadata: object.visible_metadata,
    payload: object.payload,
    plaintext_available: plaintextAllowed && object.payload.kind === "plaintext-json"
  };
}

async function enqueueDurableMutationOutbox(input: {
  context: LocalMcpContext;
  mutation: LocalMcpMutationOutboxRecord["mutation"];
  object: GraphObjectEnvelope;
  actorId: string;
  recordedAt: string;
  generation?: number;
  journalSequence?: number;
}): Promise<void> {
  if (!input.context.outboxSink || input.generation === undefined || input.journalSequence === undefined) {
    return;
  }

  await input.context.outboxSink.enqueue({
    mutation: input.mutation,
    object: input.object,
    actor_id: input.actorId,
    recorded_at: input.recordedAt,
    generation: input.generation,
    journal_sequence: input.journalSequence
  });
}

export async function localGraphStatus(
  context: LocalMcpContext,
  input: LocalGraphToolInput
): Promise<LocalGraphToolResult<LocalGraphStatusResult>> {
  const auth = await authenticateToolCall(context, input.authorization);
  if (!auth.ok) {
    return { ok: false, reason: auth.reason };
  }

  recordToolDecision({
    context,
    authenticated: auth.authenticated,
    toolName: "status",
    operation: "audit-read",
    allowed: true,
    reason: "allowed"
  });

  return {
    ok: true,
    result: {
	      authority_id: context.controlPlane.authority.authority_id,
	      policy_generation: context.controlPlane.policy_generation,
	      object_count: contextActiveObjectCount(context),
	      plaintext_persistence: context.graphStore?.status().plaintext_persistence,
	      client_id: auth.authenticated.client.client_id,
	      profile: auth.authenticated.capability.profile,
	      access_classes: auth.authenticated.capability.access_classes,
      operations: auth.authenticated.capability.operations
    }
  };
}

type ParsedResolutionMutationSet = {
  drafts: PlaintextGraphObjectDraft[];
  payloads: CanonicalPayload[];
};

type ValidatedResolutionMutationSet = ParsedResolutionMutationSet & {
  review: CanonicalReviewItemPayload;
};

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, nested]) => [key, stableJsonValue(nested)])
  );
}

function resolutionRequestFingerprint(input: {
  candidateId: string;
  expectedGeneration: number;
  expectedReviewVersion: number;
  parsed: ParsedResolutionMutationSet;
}): LocalGraphResolutionRequestFingerprint {
  const objects = input.parsed.drafts.map((draft, index) => ({
    ...draft,
    payload: {
      kind: "plaintext-json" as const,
      data: input.parsed.payloads[index]!
    }
  })).sort((left, right) => left.object_id < right.object_id ? -1 : left.object_id > right.object_id ? 1 : 0);
  const schema = "living-atlas-resolution-request-fingerprint:v1" as const;
  return {
    schema,
    candidate_id: input.candidateId,
    digest: sha256(JSON.stringify(stableJsonValue({
      schema,
      candidate_id: input.candidateId,
      expected_generation: input.expectedGeneration,
      expected_review_version: input.expectedReviewVersion,
      objects
    })))
  };
}

async function validateCanonicalMutationSet(input: {
  context: LocalMcpContext;
  candidateId: string;
  parsed: ParsedResolutionMutationSet;
}): Promise<
  | { ok: true; value: ValidatedResolutionMutationSet }
  | { ok: false; reason: "resolution-review-mismatch" | "resolution-review-not-resolved" | "resolution-parity-mismatch" | "resolution-missing-reference" }
> {
  const reviews = input.parsed.payloads.filter((payload): payload is CanonicalReviewItemPayload => (
    payload.schema === "atlas.review-item:v1"
  ));
  if (reviews.length !== 1 || reviews[0]!.candidate_id !== input.candidateId) {
    return { ok: false, reason: "resolution-review-mismatch" };
  }
  const review = reviews[0]!;
  if (review.resolution_state === "pending") {
    return { ok: false, reason: "resolution-review-not-resolved" };
  }

  const reviewCoverage = new Set(review.source_coverage_keys);
  if (reviewCoverage.size !== review.source_coverage_keys.length) {
    return { ok: false, reason: "resolution-review-mismatch" };
  }
  const parityRecords = input.parsed.payloads.filter((payload) => payload.schema === "atlas.parity-record:v1");
  const parityCoverage = new Set(parityRecords.map((record) => record.source_coverage_key));
  if (
    parityRecords.length === 0
    || parityCoverage.size !== parityRecords.length
    || parityCoverage.size !== reviewCoverage.size
    || [...reviewCoverage].some((coverageKey) => !parityCoverage.has(coverageKey))
    || parityRecords.some((record) => record.coverage_state !== "represented")
  ) {
    return { ok: false, reason: "resolution-parity-mismatch" };
  }

  const draftsById = new Map(input.parsed.drafts.map((draft, index) => [
    draft.object_id,
    { draft, payload: input.parsed.payloads[index]! }
  ]));
  const activeTypedReference = (objectId: string, objectType: ObjectType): boolean => {
    const proposed = draftsById.get(objectId)?.draft;
    if (proposed) {
      return !proposed.visible_metadata.tombstone && proposed.object_type === objectType;
    }
    const existing = input.context.graphStore!.readObject(ObjectIdSchema.parse(objectId));
    return Boolean(
      existing
      && !existing.visible_metadata.tombstone
      && existing.object_type === objectType
    );
  };
  const canonicalReferenceCache = new Map<string, CanonicalPayload | null>();
  const activeCanonicalPayload = async (objectId: string): Promise<CanonicalPayload | undefined> => {
    const proposed = draftsById.get(objectId);
    if (proposed) return proposed.draft.visible_metadata.tombstone ? undefined : proposed.payload;
    const cached = canonicalReferenceCache.get(objectId);
    if (cached !== undefined) return cached ?? undefined;
    const existing = input.context.graphStore!.readObject(ObjectIdSchema.parse(objectId));
    if (!existing || existing.visible_metadata.tombstone) {
      canonicalReferenceCache.set(objectId, null);
      return undefined;
    }
    let payload = existing.payload;
    if (payload.kind !== "plaintext-json") {
      payload = await input.context.decryptPayload?.(existing).catch(() => undefined) ?? payload;
    }
    if (payload.kind !== "plaintext-json") {
      canonicalReferenceCache.set(objectId, null);
      return undefined;
    }
    const canonical = CanonicalWriteSchema.safeParse({
      object_type: existing.object_type,
      payload: payload.data
    });
    const valid = canonical.success && canonicalPayloadObjectId(canonical.data.payload) === existing.object_id
      ? canonical.data.payload
      : undefined;
    canonicalReferenceCache.set(objectId, valid ?? null);
    return valid;
  };

  const typedReferences: Array<{ objectId: string; objectType: ObjectType }> = [];
  for (const payload of input.parsed.payloads) {
    switch (payload.schema) {
      case "atlas.fact:v1":
        typedReferences.push({ objectId: payload.subject_entity_id, objectType: "entity" });
        if (payload.value.kind === "entity-ref") {
          typedReferences.push({ objectId: payload.value.entity_id, objectType: "entity" });
        }
        typedReferences.push(
          ...payload.evidence_links.map((link) => ({ objectId: link.evidence_id, objectType: "evidence" as const })),
          ...payload.confidence.evidence_refs.map((objectId) => ({ objectId, objectType: "evidence" as const })),
          ...payload.supersedes.map((objectId) => ({ objectId, objectType: "assertion" as const }))
        );
        break;
      case "atlas.observation:v1":
        typedReferences.push(
          ...payload.candidate_entity_ids.map((objectId) => ({ objectId, objectType: "entity" as const })),
          ...payload.evidence_refs.map((objectId) => ({ objectId, objectType: "evidence" as const })),
          ...(payload.supersedes ?? []).map((objectId) => ({ objectId, objectType: "assertion" as const }))
        );
        break;
      case "atlas.relationship:v2":
        typedReferences.push(
          { objectId: payload.source_entity_id, objectType: "entity" },
          { objectId: payload.target_entity_id, objectType: "entity" },
          ...payload.evidence_links.map((link) => ({ objectId: link.evidence_id, objectType: "evidence" as const })),
          ...payload.confidence.evidence_refs.map((objectId) => ({ objectId, objectType: "evidence" as const })),
          ...payload.supersedes.map((objectId) => ({ objectId, objectType: "edge" as const }))
        );
        break;
      case "atlas.entity-resolution:v1":
        typedReferences.push(
          ...payload.candidate_entity_ids.map((objectId) => ({ objectId, objectType: "entity" as const })),
          ...(payload.canonical_entity_id ? [{ objectId: payload.canonical_entity_id, objectType: "entity" as const }] : []),
          ...payload.evidence_refs.map((objectId) => ({ objectId, objectType: "evidence" as const })),
          ...payload.evidence_links.map((link) => ({ objectId: link.evidence_id, objectType: "evidence" as const })),
          ...payload.confidence.evidence_refs.map((objectId) => ({ objectId, objectType: "evidence" as const })),
          ...payload.supersedes.map((objectId) => ({ objectId, objectType: "review" as const }))
        );
        break;
    }
  }
  if (typedReferences.some((reference) => !activeTypedReference(reference.objectId, reference.objectType))) {
    return { ok: false, reason: "resolution-missing-reference" };
  }

  const parityTargetIds = new Set(parityRecords.flatMap((parity) => parity.canonical_object_ids));
  for (const objectId of review.proposed_object_ids) {
    if (!await activeCanonicalPayload(objectId)) {
      return {
        ok: false,
        reason: parityTargetIds.has(objectId) ? "resolution-parity-mismatch" : "resolution-missing-reference"
      };
    }
  }
  const proposedIds = new Set(review.proposed_object_ids);
  const parityKindMatches = (
    representationKind: typeof parityRecords[number]["representation_kind"],
    payload: CanonicalPayload
  ): boolean => {
    switch (representationKind) {
      case "fact": return payload.schema === "atlas.fact:v1";
      case "relationship": return payload.schema === "atlas.relationship:v2";
      case "observation": return payload.schema === "atlas.observation:v1";
      case "occurrence": return payload.schema === "atlas.entity:v1" && payload.type === "occurrence";
      default: return false;
    }
  };
  for (const parity of parityRecords) {
    for (const objectId of parity.canonical_object_ids) {
      const payload = await activeCanonicalPayload(objectId);
      if (!proposedIds.has(objectId) || !payload || !parityKindMatches(parity.representation_kind, payload)) {
        return { ok: false, reason: "resolution-parity-mismatch" };
      }
    }
  }

  return { ok: true, value: { ...input.parsed, review } };
}

function resolutionOperationPairs(record: LocalGraphOperationRecord): Array<{
  object: GraphObjectEnvelope;
  change: LocalGraphOperationRecord["changes"][number];
}> | undefined {
  if (record.objects.length !== record.changes.length) return undefined;
  const objectIds = new Set(record.objects.map((object) => object.object_id));
  const changeObjectIds = new Set(record.changes.map((change) => change.object_id));
  const changeIds = new Set(record.changes.map((change) => change.change_id));
  if (
    objectIds.size !== record.objects.length
    || changeObjectIds.size !== record.changes.length
    || changeIds.size !== record.changes.length
    || objectIds.size !== changeObjectIds.size
    || [...objectIds].some((objectId) => !changeObjectIds.has(objectId))
  ) return undefined;

  const changesByObjectId = new Map(record.changes.map((change) => [change.object_id, change]));
  const pairs: Array<{
    object: GraphObjectEnvelope;
    change: LocalGraphOperationRecord["changes"][number];
  }> = [];
  for (const object of record.objects) {
    const change = changesByObjectId.get(object.object_id);
    if (
      !change
      || (change.operation !== "create" && change.operation !== "update")
      || change.operation_id !== record.operation_id
      || change.actor_id !== record.actor_id
      || change.generation !== record.generation
      || change.authority_id !== object.authority_id
      || change.content_hash !== object.content_hash
      || change.access_class !== object.access_class
      || change.new_version !== object.version
    ) return undefined;
    pairs.push({ object, change });
  }
  return pairs;
}

async function reconcileResolutionRecord(input: {
  context: LocalMcpContext;
  authenticated: LocalMcpAuthenticatedClient;
  operationRecord: LocalGraphOperationRecord;
  candidateIds: string[];
}): Promise<LocalGraphToolResult<LocalResolutionReceipt>> {
  const pairs = resolutionOperationPairs(input.operationRecord);
  if (!pairs) {
    return {
      ok: true,
      result: {
        local_commit: "committed",
        audit: "reconciliation-required",
        sync_queue: input.context.outboxSink ? "reconciliation-required" : "not-configured",
        committed_object_ids: input.operationRecord.objects.map((object) => object.object_id),
        resolved_candidate_ids: input.candidateIds,
        generation: input.operationRecord.generation,
        journal_sequence: input.operationRecord.journal_sequence
      }
    };
  }
  let audit: LocalResolutionReceipt["audit"] = "recorded";
  try {
    if (!input.context.auditSink) throw new Error("audit-not-configured");
    recordToolDecision({
      context: input.context,
      authenticated: input.authenticated,
      toolName: "resolution_apply",
      operation: "create",
      allowed: true,
      reason: "resolution-committed",
      operationId: input.operationRecord.operation_id,
      idempotencyKey: input.operationRecord.idempotency_key
    });
  } catch {
    audit = "reconciliation-required";
  }

  let syncQueue: LocalResolutionReceipt["sync_queue"] = input.context.outboxSink ? "queued" : "not-configured";
  if (input.context.outboxSink) {
    try {
      for (const { object, change } of pairs) {
        await input.context.outboxSink.enqueue({
          mutation: change.operation === "update" ? "updated" : "created",
          object,
          actor_id: input.authenticated.client.client_id,
          recorded_at: object.updated_at,
          generation: input.operationRecord.generation,
          journal_sequence: input.operationRecord.journal_sequence,
          operation_id: input.operationRecord.operation_id,
          idempotency_key: input.operationRecord.idempotency_key,
          change_id: change.change_id
        });
      }
    } catch {
      syncQueue = "reconciliation-required";
    }
  }

  return {
    ok: true,
    result: {
      local_commit: "committed",
      audit,
      sync_queue: syncQueue,
      committed_object_ids: input.operationRecord.objects.map((object) => object.object_id),
      resolved_candidate_ids: input.candidateIds,
      generation: input.operationRecord.generation,
      journal_sequence: input.operationRecord.journal_sequence
    }
  };
}

export async function localResolutionApply(
  context: LocalMcpContext,
  input: LocalResolutionApplyInput
): Promise<LocalGraphToolResult<LocalResolutionReceipt>> {
  const auth = await authenticateToolCall(context, input.authorization);
  if (!auth.ok) {
    return { ok: false, reason: auth.reason };
  }
  if (!context.graphStore) {
    recordToolDecision({
      context,
      authenticated: auth.authenticated,
      toolName: "resolution_apply",
      operation: "create",
      allowed: false,
      reason: "resolution-requires-durable-local-store",
      operationId: input.operation_id,
      idempotencyKey: input.idempotency_key
    });
    return { ok: false, reason: "resolution-requires-durable-local-store" };
  }
  if (!/^la_candidate_[A-Za-z0-9_-]{8,}$/.test(input.candidate_id) || input.objects.length === 0) {
    return { ok: false, reason: "resolution-invalid-request" };
  }

  const parsedDrafts: PlaintextGraphObjectDraft[] = [];
  const payloads: CanonicalPayload[] = [];
  for (const object of input.objects) {
    const draft = PlaintextGraphObjectDraftSchema.safeParse(object);
    if (!draft.success) return { ok: false, reason: "resolution-invalid-object" };
    if (draft.data.access_class !== "local-private" || draft.data.payload.kind !== "plaintext-json") {
      return { ok: false, reason: "resolution-invalid-canonical-write" };
    }
    const canonicalWrite = CanonicalWriteSchema.safeParse({
      object_type: draft.data.object_type,
      payload: draft.data.payload.data
    });
    if (!canonicalWrite.success) return { ok: false, reason: "resolution-invalid-canonical-write" };
    if (draft.data.object_id !== canonicalPayloadObjectId(canonicalWrite.data.payload)) {
      return { ok: false, reason: "resolution-object-id-mismatch" };
    }
    parsedDrafts.push(draft.data);
    payloads.push(canonicalWrite.data.payload);
  }
  const objectIds = new Set(parsedDrafts.map((draft) => draft.object_id));
  if (objectIds.size !== parsedDrafts.length) {
    return { ok: false, reason: "resolution-duplicate-object" };
  }
  const parsed = { drafts: parsedDrafts, payloads };
  const requestFingerprint = resolutionRequestFingerprint({
    candidateId: input.candidate_id,
    expectedGeneration: input.expected_generation,
    expectedReviewVersion: input.expected_review_version,
    parsed
  });

  const prior = context.graphStore.operationRecordForIdempotency(input.idempotency_key);
  if (prior) {
    if (
      prior.operation_id !== input.operation_id
      || prior.actor_id !== auth.authenticated.client.client_id
      || !prior.request_fingerprint
      || JSON.stringify(prior.request_fingerprint) !== JSON.stringify(requestFingerprint)
    ) {
      return { ok: false, reason: "idempotency-conflict" };
    }
    return reconcileResolutionRecord({
      context,
      authenticated: auth.authenticated,
      operationRecord: prior,
      candidateIds: [input.candidate_id]
    });
  }

  const validation = await validateCanonicalMutationSet({
    context,
    candidateId: input.candidate_id,
    parsed
  });
  if (!validation.ok) return { ok: false, reason: validation.reason };
  const { review } = validation.value;

  const existingReview = context.graphStore.readObject(review.review_id);
  if (existingReview && existingReview.version !== input.expected_review_version) {
    return { ok: false, reason: "resolution-review-version-conflict" };
  }
  if (context.graphStore.status().generation !== input.expected_generation) {
    return { ok: false, reason: "generation-conflict" };
  }
  for (const draft of parsedDrafts) {
    const operation: Operation = context.graphStore.readObject(draft.object_id) ? "update" : "create";
    const decision = evaluatePolicy({
      profile: auth.authenticated.capability.profile,
      operation,
      actor_id: auth.authenticated.client.client_id,
      capability: auth.authenticated.capability,
      now: context.now
    }, policyEnvelopeForDraft(draft));
    if (!decision.allowed) {
      recordToolDecision({
        context,
        authenticated: auth.authenticated,
        toolName: "resolution_apply",
        operation,
        object: policyEnvelopeForDraft(draft),
        decision,
        allowed: false,
        reason: decision.reason_code,
        operationId: input.operation_id,
        idempotencyKey: input.idempotency_key
      });
      return { ok: false, reason: decision.reason_code };
    }
  }
  const transaction = await context.graphStore.commitTransaction({
    expected_generation: input.expected_generation,
    actor_id: auth.authenticated.client.client_id,
    operation_id: input.operation_id,
    idempotency_key: input.idempotency_key,
    request_fingerprint: requestFingerprint,
    recorded_at: nowForMutation(context),
    writes: parsedDrafts.map((draft) => {
      const existing = context.graphStore!.readObject(draft.object_id);
      return existing
        ? { kind: "update" as const, object: draft, expected_version: existing.version }
        : { kind: "create" as const, object: draft };
    })
  });
  if (!transaction.ok) {
    return { ok: false, reason: transaction.reason };
  }
  return reconcileResolutionRecord({
    context,
    authenticated: auth.authenticated,
    operationRecord: transaction.operation_record,
    candidateIds: [input.candidate_id]
  });
}

/** Applies independently precomputed owner decisions in one local transaction. */
export async function localResolutionApplyBatch(
  context: LocalMcpContext,
  input: LocalResolutionApplyBatchInput
): Promise<LocalGraphToolResult<LocalResolutionReceipt>> {
  const auth = await authenticateToolCall(context, input.authorization);
  if (!auth.ok) return { ok: false, reason: auth.reason };
  if (!context.graphStore) return localResolutionApply(context, { ...input, candidate_id: "la_candidate_batch0001", expected_review_version: 1, objects: [] });
  if (input.resolutions.length === 0 || context.graphStore.status().generation !== input.expected_generation) {
    return { ok: false, reason: input.resolutions.length === 0 ? "resolution-invalid-request" : "generation-conflict" };
  }
  const candidates = new Set<string>();
  for (const resolution of input.resolutions) {
    if (!/^la_candidate_[A-Za-z0-9_-]{8,}$/.test(resolution.candidate_id) || resolution.objects.length === 0 || candidates.has(resolution.candidate_id)) {
      return { ok: false, reason: "resolution-invalid-request" };
    }
    candidates.add(resolution.candidate_id);
    const review = resolution.objects.flatMap((object) => {
      const draft = PlaintextGraphObjectDraftSchema.safeParse(object);
      if (!draft.success || draft.data.payload.kind !== "plaintext-json") return [];
      const write = CanonicalWriteSchema.safeParse({ object_type: draft.data.object_type, payload: draft.data.payload.data });
      return write.success && write.data.payload.schema === "atlas.review-item:v1" && write.data.payload.candidate_id === resolution.candidate_id ? [write.data.payload] : [];
    })[0];
    if (!review || review.resolution_state === "pending") return { ok: false, reason: "resolution-review-not-resolved" };
    const existing = context.graphStore.readObject(review.review_id);
    if (existing && existing.version !== resolution.expected_review_version) return { ok: false, reason: "resolution-review-version-conflict" };
  }
  const first = input.resolutions[0]!;
  const result = await localResolutionApply(context, {
    authorization: input.authorization,
    operation_id: input.operation_id,
    idempotency_key: input.idempotency_key,
    expected_generation: input.expected_generation,
    candidate_id: first.candidate_id,
    expected_review_version: first.expected_review_version,
    objects: input.resolutions.flatMap((resolution) => resolution.objects)
  });
  if (!result.ok) return result;
  return { ok: true, result: { ...result.result, resolved_candidate_ids: [...candidates].sort() } };
}

export async function localListObjects(
  context: LocalMcpContext,
  input: LocalGraphToolInput
): Promise<LocalGraphToolResult<LocalGraphListResult>> {
  const auth = await authenticateToolCall(context, input.authorization);
  if (!auth.ok) {
    return { ok: false, reason: auth.reason };
  }

  const objects: AuthorizedLocalObject[] = [];
  let withheld_count = 0;

  for (const object of contextObjects(context)) {
    const decision = evaluatePolicy({
      profile: auth.authenticated.capability.profile,
      operation: "read",
      actor_id: auth.authenticated.client.client_id,
      capability: auth.authenticated.capability,
      now: context.now
    }, object);

    recordToolDecision({
      context,
      authenticated: auth.authenticated,
      toolName: "object_list",
      operation: "read",
      object,
      decision,
      allowed: decision.allowed,
      reason: decision.reason_code
    });

    if (decision.allowed) {
      objects.push(sanitizeAuthorizedObject(object, decision.plaintext_allowed));
    } else {
      withheld_count += 1;
    }
  }

  return {
    ok: true,
    result: {
      objects,
      withheld_count
    }
  };
}

export async function localReadObject(
  context: LocalMcpContext,
  input: LocalGraphReadToolInput
): Promise<LocalGraphToolResult<LocalGraphReadResult>> {
  const auth = await authenticateToolCall(context, input.authorization);
  if (!auth.ok) {
    return { ok: false, reason: auth.reason };
  }

  const objectId = ObjectIdSchema.parse(input.object_id);
  const object = readContextObject(context, objectId);
  if (!object) {
    recordToolDecision({
      context,
      authenticated: auth.authenticated,
      toolName: "object_read",
      operation: "read",
      allowed: false,
      reason: "object-missing"
    });
    return { ok: false, reason: "object-missing" };
  }

  const decision = evaluatePolicy({
    profile: auth.authenticated.capability.profile,
    operation: "read",
    actor_id: auth.authenticated.client.client_id,
    capability: auth.authenticated.capability,
    now: context.now
  }, object);

  recordToolDecision({
    context,
    authenticated: auth.authenticated,
    toolName: "object_read",
    operation: "read",
    object,
    decision,
    allowed: decision.allowed,
    reason: decision.reason_code
  });

  if (!decision.allowed) {
    return { ok: false, reason: decision.reason_code };
  }

  return {
    ok: true,
    result: {
      object: sanitizeAuthorizedObject(
        await materializeAuthorizedObject(context, object, decision.plaintext_allowed),
        decision.plaintext_allowed
      )
    }
  };
}

export async function localCreateObject(
  context: LocalMcpContext,
  input: LocalGraphCreateToolInput
): Promise<LocalGraphToolResult<LocalGraphMutationResult>> {
  const auth = await authenticateToolCall(context, input.authorization);
  if (!auth.ok) {
    return { ok: false, reason: auth.reason };
  }

  const parsedObject = parseLocalGraphObjectInput(input.object, Boolean(context.graphStore));
  if (!parsedObject) {
    recordToolDecision({
      context,
      authenticated: auth.authenticated,
      toolName: "object_create",
      operation: "create",
      allowed: false,
      reason: "invalid-object"
    });
    return { ok: false, reason: "invalid-object" };
  }

  const object = parsedObject.object;
  const policyObject = parsedObject.policyObject;
  if (object.authority_id !== context.controlPlane.authority.authority_id) {
    recordToolDecision({
      context,
      authenticated: auth.authenticated,
      toolName: "object_create",
      operation: "create",
      object: policyObject,
      allowed: false,
      reason: "object-authority-mismatch"
    });
    return { ok: false, reason: "object-authority-mismatch" };
  }

  if (readContextObject(context, object.object_id)) {
    recordToolDecision({
      context,
      authenticated: auth.authenticated,
      toolName: "object_create",
      operation: "create",
      object: policyObject,
      allowed: false,
      reason: "object-already-exists"
    });
    return { ok: false, reason: "object-already-exists" };
  }

  if (!context.graphStore && context.graphObjects.length >= syntheticStoreLimits(context).maxObjects) {
    recordToolDecision({
      context,
      authenticated: auth.authenticated,
      toolName: "object_create",
      operation: "create",
      object: policyObject,
      allowed: false,
      reason: "synthetic-store-full"
    });
    return { ok: false, reason: "synthetic-store-full" };
  }

  if (!objectWithinSyntheticLimit(context, object)) {
    recordToolDecision({
      context,
      authenticated: auth.authenticated,
      toolName: "object_create",
      operation: "create",
      object: policyObject,
      allowed: false,
      reason: "object-too-large"
    });
    return { ok: false, reason: "object-too-large" };
  }

  const decision = evaluatePolicy({
    profile: auth.authenticated.capability.profile,
    operation: "create",
    actor_id: auth.authenticated.client.client_id,
    capability: auth.authenticated.capability,
    now: context.now
  }, policyObject);

  if (!decision.allowed) {
    recordToolDecision({
      context,
      authenticated: auth.authenticated,
      toolName: "object_create",
      operation: "create",
      object: policyObject,
      decision,
      allowed: false,
      reason: decision.reason_code
    });
    return { ok: false, reason: decision.reason_code };
  }

  if (context.graphStore) {
    const mutation = await context.graphStore.createObject({
      object,
      expected_generation: context.graphStore.status().generation,
      actor_id: auth.authenticated.client.client_id,
      recorded_at: nowForMutation(context)
    });
    if (!mutation.ok) {
      recordToolDecision({
        context,
        authenticated: auth.authenticated,
        toolName: "object_create",
        operation: "create",
        object: policyObject,
        decision,
        allowed: false,
        reason: mutation.reason
      });
      return { ok: false, reason: mutation.reason };
    }

    recordToolDecision({
      context,
      authenticated: auth.authenticated,
      toolName: "object_create",
      operation: "create",
      object: mutation.object,
      decision,
      allowed: true,
      reason: decision.reason_code
    });
    await enqueueDurableMutationOutbox({
      context,
      mutation: "created",
      object: mutation.object,
      actorId: auth.authenticated.client.client_id,
      recordedAt: mutation.object.updated_at,
      generation: mutation.generation,
      journalSequence: mutation.journal_sequence
    });

    return {
      ok: true,
      result: {
        object: sanitizeAuthorizedObject(mutation.object, decision.plaintext_allowed),
        mutation: "created",
        persistence: mutation.persistence,
        object_count: context.graphStore.status().object_count,
        new_version: mutation.new_version,
        generation: mutation.generation,
        journal_sequence: mutation.journal_sequence
      }
    };
  }

  const storedObject = cloneGraphObject(policyObject);
  context.graphObjects.push(storedObject);
  recordToolDecision({
    context,
    authenticated: auth.authenticated,
    toolName: "object_create",
    operation: "create",
    object: storedObject,
    decision,
    allowed: true,
    reason: decision.reason_code
  });

  return {
    ok: true,
    result: {
      object: sanitizeAuthorizedObject(storedObject, decision.plaintext_allowed),
      mutation: "created",
      persistence: "synthetic-in-memory",
      object_count: context.graphObjects.length,
      new_version: storedObject.version
    }
  };
}

export async function localUpdateObject(
  context: LocalMcpContext,
  input: LocalGraphUpdateToolInput
): Promise<LocalGraphToolResult<LocalGraphMutationResult>> {
  const auth = await authenticateToolCall(context, input.authorization);
  if (!auth.ok) {
    return { ok: false, reason: auth.reason };
  }

  const parsedObjectId = ObjectIdSchema.safeParse(input.object_id);
  if (!parsedObjectId.success) {
    recordToolDecision({
      context,
      authenticated: auth.authenticated,
      toolName: "object_update",
      operation: "update",
      allowed: false,
      reason: "invalid-object-id"
    });
    return { ok: false, reason: "invalid-object-id" };
  }

  const parsedExpectedVersion = LocalGraphExpectedVersionSchema.safeParse(input.expected_version);
  if (!parsedExpectedVersion.success) {
    recordToolDecision({
      context,
      authenticated: auth.authenticated,
      toolName: "object_update",
      operation: "update",
      allowed: false,
      reason: "invalid-expected-version"
    });
    return { ok: false, reason: "invalid-expected-version" };
  }

  const parsedPatch = LocalGraphUpdatePatchSchema.safeParse(input.patch);
  if (!parsedPatch.success) {
    recordToolDecision({
      context,
      authenticated: auth.authenticated,
      toolName: "object_update",
      operation: "update",
      allowed: false,
      reason: "invalid-patch"
    });
    return { ok: false, reason: "invalid-patch" };
  }

  const objectId = parsedObjectId.data;
  const existingIndex = findObjectIndex(context, objectId);
  const existingObject = readContextObject(context, objectId);
  if (!existingObject) {
    recordToolDecision({
      context,
      authenticated: auth.authenticated,
      toolName: "object_update",
      operation: "update",
      allowed: false,
      reason: "object-missing"
    });
    return { ok: false, reason: "object-missing" };
  }

  if (parsedExpectedVersion.data !== undefined && existingObject.version !== parsedExpectedVersion.data) {
    recordToolDecision({
      context,
      authenticated: auth.authenticated,
      toolName: "object_update",
      operation: "update",
      object: existingObject,
      allowed: false,
      reason: "version-conflict"
    });
    return { ok: false, reason: "version-conflict" };
  }

  const patch = parsedPatch.data;
  const existingDecision = evaluatePolicy({
    profile: auth.authenticated.capability.profile,
    operation: "update",
    actor_id: auth.authenticated.client.client_id,
    capability: auth.authenticated.capability,
    now: context.now
  }, existingObject);

  if (!existingDecision.allowed) {
    recordToolDecision({
      context,
      authenticated: auth.authenticated,
      toolName: "object_update",
      operation: "update",
      object: existingObject,
      decision: existingDecision,
      allowed: false,
      reason: existingDecision.reason_code
    });
    return { ok: false, reason: existingDecision.reason_code };
  }

  const encryptedDurableStore = context.graphStore?.status().plaintext_persistence === "encrypted";
  if (encryptedDurableStore && patch.payload && patch.payload.kind !== "plaintext-json") {
    recordToolDecision({
      context,
      authenticated: auth.authenticated,
      toolName: "object_update",
      operation: "update",
      object: existingObject,
      allowed: false,
      reason: "encrypted-payload-update-requires-plaintext"
    });
    return { ok: false, reason: "encrypted-payload-update-requires-plaintext" };
  }
  const decryptedExistingPayload = encryptedDurableStore
    && !patch.payload
    && existingObject.payload.kind !== "plaintext-json"
    && context.decryptPayload
    ? await context.decryptPayload(existingObject)
    : undefined;
  if (encryptedDurableStore && !patch.payload && existingObject.payload.kind !== "plaintext-json" && !decryptedExistingPayload) {
    recordToolDecision({
      context,
      authenticated: auth.authenticated,
      toolName: "object_update",
      operation: "update",
      object: existingObject,
      allowed: false,
      reason: "plaintext-not-available-through-local-mcp"
    });
    return { ok: false, reason: "plaintext-not-available-through-local-mcp" };
  }
  const nextPayload = patch.payload ?? decryptedExistingPayload ?? existingObject.payload;
  const candidateInput = {
    ...existingObject,
    ...patch,
    authority_id: existingObject.authority_id,
    object_id: existingObject.object_id,
    created_at: existingObject.created_at,
    updated_at: patch.updated_at ?? nowForMutation(context),
    version: existingObject.version + 1,
    payload: nextPayload,
    encryption_class: patch.encryption_class ?? (nextPayload.kind === "plaintext-json" ? "plaintext" : existingObject.encryption_class),
    visible_metadata: patch.visible_metadata
      ? {
          ...existingObject.visible_metadata,
          ...patch.visible_metadata
        }
      : existingObject.visible_metadata
  };
  const candidate = parseLocalGraphObjectInput(candidateInput, Boolean(context.graphStore));

  if (!candidate) {
    recordToolDecision({
      context,
      authenticated: auth.authenticated,
      toolName: "object_update",
      operation: "update",
      object: existingObject,
      allowed: false,
      reason: "invalid-object"
    });
    return { ok: false, reason: "invalid-object" };
  }

  const nextObject = candidate.object;
  const policyObject = candidate.policyObject;
  if (!objectWithinSyntheticLimit(context, nextObject)) {
    recordToolDecision({
      context,
      authenticated: auth.authenticated,
      toolName: "object_update",
      operation: "update",
      object: policyObject,
      allowed: false,
      reason: "object-too-large"
    });
    return { ok: false, reason: "object-too-large" };
  }

  const decision = evaluatePolicy({
    profile: auth.authenticated.capability.profile,
    operation: "update",
    actor_id: auth.authenticated.client.client_id,
    capability: auth.authenticated.capability,
    now: context.now
  }, policyObject);

  if (!decision.allowed) {
    recordToolDecision({
      context,
      authenticated: auth.authenticated,
      toolName: "object_update",
      operation: "update",
      object: policyObject,
      decision,
      allowed: false,
      reason: decision.reason_code
    });
    return { ok: false, reason: decision.reason_code };
  }

  if (context.graphStore) {
    const mutation = await context.graphStore.updateObject({
      object: nextObject,
      expected_generation: context.graphStore.status().generation,
      expected_version: parsedExpectedVersion.data,
      actor_id: auth.authenticated.client.client_id,
      recorded_at: nextObject.updated_at
    });
    if (!mutation.ok) {
      recordToolDecision({
        context,
        authenticated: auth.authenticated,
        toolName: "object_update",
        operation: "update",
        object: policyObject,
        decision,
        allowed: false,
        reason: mutation.reason
      });
      return { ok: false, reason: mutation.reason };
    }

    recordToolDecision({
      context,
      authenticated: auth.authenticated,
      toolName: "object_update",
      operation: "update",
      object: mutation.object,
      decision,
      allowed: true,
      reason: decision.reason_code
    });
    await enqueueDurableMutationOutbox({
      context,
      mutation: "updated",
      object: mutation.object,
      actorId: auth.authenticated.client.client_id,
      recordedAt: mutation.object.updated_at,
      generation: mutation.generation,
      journalSequence: mutation.journal_sequence
    });

    return {
      ok: true,
      result: {
        object: sanitizeAuthorizedObject(mutation.object, decision.plaintext_allowed),
        mutation: "updated",
        persistence: mutation.persistence,
        object_count: context.graphStore.status().object_count,
        previous_version: mutation.previous_version,
        new_version: mutation.new_version,
        generation: mutation.generation,
        journal_sequence: mutation.journal_sequence
      }
    };
  }

  context.graphObjects[existingIndex] = nextObject;
  recordToolDecision({
    context,
    authenticated: auth.authenticated,
    toolName: "object_update",
    operation: "update",
    object: nextObject,
    decision,
    allowed: true,
    reason: decision.reason_code
  });

  return {
    ok: true,
    result: {
      object: sanitizeAuthorizedObject(nextObject, decision.plaintext_allowed),
      mutation: "updated",
      persistence: "synthetic-in-memory",
      object_count: context.graphObjects.length,
      previous_version: existingObject.version,
      new_version: nextObject.version
    }
  };
}

export async function localTombstoneObject(
  context: LocalMcpContext,
  input: LocalGraphTombstoneToolInput
): Promise<LocalGraphToolResult<LocalGraphMutationResult>> {
  const auth = await authenticateToolCall(context, input.authorization);
  if (!auth.ok) {
    return { ok: false, reason: auth.reason };
  }

  const parsedObjectId = ObjectIdSchema.safeParse(input.object_id);
  if (!parsedObjectId.success) {
    recordToolDecision({
      context,
      authenticated: auth.authenticated,
      toolName: "object_delete",
      operation: "delete",
      allowed: false,
      reason: "invalid-object-id"
    });
    return { ok: false, reason: "invalid-object-id" };
  }

  const parsedExpectedVersion = LocalGraphExpectedVersionSchema.safeParse(input.expected_version);
  if (!parsedExpectedVersion.success) {
    recordToolDecision({
      context,
      authenticated: auth.authenticated,
      toolName: "object_delete",
      operation: "delete",
      allowed: false,
      reason: "invalid-expected-version"
    });
    return { ok: false, reason: "invalid-expected-version" };
  }

  const objectId = parsedObjectId.data;
  const existingIndex = findObjectIndex(context, objectId);
  const existingObject = readContextObject(context, objectId);
  if (!existingObject) {
    recordToolDecision({
      context,
      authenticated: auth.authenticated,
      toolName: "object_delete",
      operation: "delete",
      allowed: false,
      reason: "object-missing"
    });
    return { ok: false, reason: "object-missing" };
  }

  if (parsedExpectedVersion.data !== undefined && existingObject.version !== parsedExpectedVersion.data) {
    recordToolDecision({
      context,
      authenticated: auth.authenticated,
      toolName: "object_delete",
      operation: "delete",
      object: existingObject,
      allowed: false,
      reason: "version-conflict"
    });
    return { ok: false, reason: "version-conflict" };
  }

  const decision = evaluatePolicy({
    profile: auth.authenticated.capability.profile,
    operation: "delete",
    actor_id: auth.authenticated.client.client_id,
    capability: auth.authenticated.capability,
    now: context.now
  }, existingObject);

  const nextObject = GraphObjectEnvelopeSchema.parse({
    ...existingObject,
    version: existingObject.version + 1,
    updated_at: nowForMutation(context),
    visible_metadata: {
      ...existingObject.visible_metadata,
      tombstone: true
    }
  });

  if (!decision.allowed) {
    recordToolDecision({
      context,
      authenticated: auth.authenticated,
      toolName: "object_delete",
      operation: "delete",
      object: nextObject,
      decision,
      allowed: false,
      reason: decision.reason_code
    });
    return { ok: false, reason: decision.reason_code };
  }

  if (context.graphStore) {
    const mutation = await context.graphStore.tombstoneObject({
      object_id: objectId,
      expected_generation: context.graphStore.status().generation,
      expected_version: parsedExpectedVersion.data,
      actor_id: auth.authenticated.client.client_id,
      recorded_at: nextObject.updated_at
    });
    if (!mutation.ok) {
      recordToolDecision({
        context,
        authenticated: auth.authenticated,
        toolName: "object_delete",
        operation: "delete",
        object: nextObject,
        decision,
        allowed: false,
        reason: mutation.reason
      });
      return { ok: false, reason: mutation.reason };
    }

    recordToolDecision({
      context,
      authenticated: auth.authenticated,
      toolName: "object_delete",
      operation: "delete",
      object: mutation.object,
      decision,
      allowed: true,
      reason: decision.reason_code
    });
    await enqueueDurableMutationOutbox({
      context,
      mutation: "tombstoned",
      object: mutation.object,
      actorId: auth.authenticated.client.client_id,
      recordedAt: mutation.object.updated_at,
      generation: mutation.generation,
      journalSequence: mutation.journal_sequence
    });

    return {
      ok: true,
      result: {
        object: sanitizeAuthorizedObject(mutation.object, decision.plaintext_allowed),
        mutation: "tombstoned",
        persistence: mutation.persistence,
        object_count: context.graphStore.status().object_count,
        previous_version: mutation.previous_version,
        new_version: mutation.new_version,
        generation: mutation.generation,
        journal_sequence: mutation.journal_sequence
      }
    };
  }

  context.graphObjects[existingIndex] = nextObject;
  recordToolDecision({
    context,
    authenticated: auth.authenticated,
    toolName: "object_delete",
    operation: "delete",
    object: nextObject,
    decision,
    allowed: true,
    reason: decision.reason_code
  });

  return {
    ok: true,
    result: {
      object: sanitizeAuthorizedObject(nextObject, decision.plaintext_allowed),
      mutation: "tombstoned",
      persistence: "synthetic-in-memory",
      object_count: context.graphObjects.length,
      previous_version: existingObject.version,
      new_version: nextObject.version
    }
  };
}

export async function localAccessModes(
  context: LocalMcpContext,
  input: LocalGraphToolInput
): Promise<LocalGraphToolResult<Record<string, unknown>>> {
  const auth = await authenticateToolCall(context, input.authorization);
  if (!auth.ok) {
    return { ok: false, reason: auth.reason };
  }

  recordToolDecision({
    context,
    authenticated: auth.authenticated,
    toolName: "access_modes",
    operation: "audit-read",
    allowed: true,
    reason: "allowed"
  });

  return {
    ok: true,
    result: {
      current_mode: "local-keyholding-only",
      key_persisted_by_cloudflare: false,
      host_blind_sensitive_plaintext: true,
      sensitive_plaintext_available: true,
      profile: auth.authenticated.capability.profile
    }
  };
}

export async function localSensitiveDecrypt(
  context: LocalMcpContext,
  input: LocalGraphReadToolInput & { authority_id?: string }
): Promise<LocalGraphToolResult<Record<string, unknown>>> {
  if (!validateAuthority(context, input.authority_id)) {
    return { ok: false, reason: "authority-mismatch" };
  }

  const result = await localReadObject(context, input);
  if (!result.ok) {
    return result;
  }
  if (result.result.object.payload.kind !== "plaintext-json") {
    return {
      ok: false,
      reason: "plaintext-not-available-through-local-mcp",
      result: {
        object_id: result.result.object.object_id,
        payload_kind: result.result.object.payload.kind,
        key_persisted_by_cloudflare: false
      }
    };
  }

  return {
    ok: true,
    result: {
      object_id: result.result.object.object_id,
      object_type: result.result.object.object_type,
      version: result.result.object.version,
      access_class: result.result.object.access_class,
      visible_metadata: result.result.object.visible_metadata,
      payload: result.result.object.payload.data,
      key_persisted_by_cloudflare: false
    }
  };
}

export async function localSearchObjects(
  context: LocalMcpContext,
  input: LocalGraphSearchToolInput
): Promise<LocalGraphToolResult<{ query: string; search_mode: string; results: LocalGraphSearchResult[] }>> {
  const auth = await authenticateToolCall(context, input.authorization);
  if (!auth.ok) {
    return { ok: false, reason: auth.reason };
  }
  if (!validateAuthority(context, input.authority_id)) {
    return { ok: false, reason: "authority-mismatch" };
  }
  const query = input.query?.trim();
  if (!query) {
    return { ok: false, reason: "invalid-search-request" };
  }

  const terms = query.toLowerCase().split(/\s+/).map((term) => term.trim()).filter(Boolean);
  const results: LocalGraphSearchResult[] = [];
  for (const object of contextObjects(context)) {
    if (object.visible_metadata.tombstone || (input.object_type && object.object_type !== input.object_type)) {
      continue;
    }
    const decision = operationDecision({ context, authenticated: auth.authenticated, operation: "search", object });
    recordToolDecision({
      context,
      authenticated: auth.authenticated,
      toolName: "search",
      operation: "search",
      object,
      decision,
      allowed: decision.allowed,
      reason: decision.reason_code
    });
    if (!decision.allowed) {
      continue;
    }
    const visibleObject = await materializeAuthorizedObject(context, object, decision.plaintext_allowed);
    const text = searchText(visibleObject);
    const matched = terms.filter((term) => text.includes(term));
    const score = matched.reduce((sum, term) => sum + (text.split(term).length - 1), 0);
    if (score > 0) {
      results.push({
        object: sanitizeAuthorizedObject(visibleObject, decision.plaintext_allowed),
        score,
        matched_fields: matched,
        snippet: text.slice(0, 240)
      });
    }
  }

  return {
    ok: true,
    result: {
      query,
      search_mode: "deterministic-text-v1",
      results: results
        .sort((left, right) => right.score - left.score || right.object.version - left.object.version)
        .slice(0, boundedLimit(input.limit))
    }
  };
}

export async function localTraverseGraph(
  context: LocalMcpContext,
  input: LocalGraphTraverseToolInput
): Promise<LocalGraphToolResult<LocalGraphTraverseResult>> {
  const auth = await authenticateToolCall(context, input.authorization);
  if (!auth.ok) {
    return { ok: false, reason: auth.reason };
  }
  if (!validateAuthority(context, input.authority_id)) {
    return { ok: false, reason: "authority-mismatch" };
  }
  const startObjectId = input.start_object_id;
  if (!startObjectId) {
    return { ok: false, reason: "invalid-traverse-request" };
  }

  const direction = input.direction ?? "both";
  const maxDepth = Math.min(Math.max(input.max_depth ?? 1, 1), 5);
  const limit = boundedLimit(input.limit);
  const allowedPredicates = input.predicates ? new Set(input.predicates.map(canonicalPredicate)) : undefined;
  const edges: Array<{ object: LocalGraphReadableObject; edge: TemporalEdge; plaintextAllowed: boolean }> = [];
  for (const object of contextObjects(context)) {
    if (object.visible_metadata.tombstone) {
      continue;
    }
    const decision = operationDecision({ context, authenticated: auth.authenticated, operation: "traverse", object });
    recordToolDecision({
      context,
      authenticated: auth.authenticated,
      toolName: "traverse",
      operation: "traverse",
      object,
      decision,
      allowed: decision.allowed,
      reason: decision.reason_code
    });
    if (!decision.allowed) {
      continue;
    }
    const visibleObject = await materializeAuthorizedObject(context, object, decision.plaintext_allowed);
    const edge = edgeData(visibleObject);
    if (edge && (!allowedPredicates || allowedPredicates.has(edge.predicate))) {
      edges.push({ object: visibleObject, edge, plaintextAllowed: decision.plaintext_allowed });
    }
  }
  const visited = new Set<string>([startObjectId]);
  const frontier = new Set<string>([startObjectId]);
  const traversed: AuthorizedLocalObject[] = [];

  for (let depth = 0; depth < maxDepth && frontier.size > 0 && traversed.length < limit; depth += 1) {
    const next = new Set<string>();
    for (const entry of edges) {
      const outbound = frontier.has(entry.edge.source_object_id);
      const inbound = frontier.has(entry.edge.target_object_id);
      if ((direction === "outbound" || direction === "both") && outbound) {
        next.add(entry.edge.target_object_id);
        traversed.push(sanitizeAuthorizedObject(entry.object, entry.plaintextAllowed));
      }
      if ((direction === "inbound" || direction === "both") && inbound) {
        next.add(entry.edge.source_object_id);
        traversed.push(sanitizeAuthorizedObject(entry.object, entry.plaintextAllowed));
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
    ok: true,
    result: {
      start_object_id: startObjectId,
      max_depth: maxDepth,
      visited_object_ids: [...visited],
      edges: [...new Map(traversed.map((edge) => [edge.object_id, edge])).values()]
    }
  };
}

export async function localTimelineQuery(
  context: LocalMcpContext,
  input: LocalGraphTimelineToolInput
): Promise<LocalGraphToolResult<{ results: LocalGraphTimelineResult[] }>> {
  const auth = await authenticateToolCall(context, input.authorization);
  if (!auth.ok) {
    return { ok: false, reason: auth.reason };
  }
  if (!validateAuthority(context, input.authority_id)) {
    return { ok: false, reason: "authority-mismatch" };
  }

  const from = input.from ? normalizedDateKey(input.from) : undefined;
  const to = input.to ? normalizedDateKey(input.to) : undefined;
  const results: LocalGraphTimelineResult[] = [];
  for (const object of contextObjects(context)) {
    if (object.visible_metadata.tombstone) {
      continue;
    }
    if (input.object_id && object.object_id !== input.object_id) {
      continue;
    }
    const decision = operationDecision({ context, authenticated: auth.authenticated, operation: "read", object });
    recordToolDecision({
      context,
      authenticated: auth.authenticated,
      toolName: "timeline",
      operation: "read",
      object,
      decision,
      allowed: decision.allowed,
      reason: decision.reason_code
    });
    if (!decision.allowed) {
      continue;
    }
    const visibleObject = await materializeAuthorizedObject(context, object, decision.plaintext_allowed);
    const edge = edgeData(visibleObject);
    if (input.predicate && edge?.predicate !== canonicalPredicate(input.predicate)) {
      continue;
    }
    for (const candidate of timelineCandidates(visibleObject)) {
      const key = normalizedDateKey(candidate.value);
      if (from && key < from) {
        continue;
      }
      if (to && key > to) {
        continue;
      }
      results.push({
        object: sanitizeAuthorizedObject(visibleObject, decision.plaintext_allowed),
        timeline_at: candidate.value,
        field: candidate.field
      });
    }
  }

  return {
    ok: true,
    result: {
      results: results
        .sort((left, right) => normalizedDateKey(left.timeline_at).localeCompare(normalizedDateKey(right.timeline_at)))
        .slice(0, boundedLimit(input.limit))
    }
  };
}

export async function localCreateEdgeObject(
  context: LocalMcpContext,
  input: LocalGraphEdgeCreateToolInput
): Promise<LocalGraphToolResult<LocalGraphMutationResult>> {
  const edge = TemporalEdgeSchema.safeParse(input.edge);
  if (!edge.success) {
    return { ok: false, reason: "invalid-edge" };
  }
  const object = edgeObjectFromTemporalEdge(context, edge.data, nowForMutation(context));
  const result = await localCreateObject(context, {
    authorization: input.authorization,
    object
  });
  if (result.ok) {
    const auth = await authenticateToolCall(context, input.authorization);
    if (auth.ok) {
      recordToolDecision({
        context,
        authenticated: auth.authenticated,
        toolName: "edge_create",
        operation: "create",
        object,
        allowed: true,
        reason: "allowed"
      });
    }
  }
  return result;
}

export async function localReadEdgeObject(
  context: LocalMcpContext,
  input: LocalGraphEdgeReadToolInput
): Promise<LocalGraphToolResult<LocalGraphReadResult>> {
  if (!validateAuthority(context, input.authority_id)) {
    return { ok: false, reason: "authority-mismatch" };
  }
  if (!input.edge_id) {
    return { ok: false, reason: "invalid-edge-read-request" };
  }
  const object = findEdgeObject(context, input.edge_id);
  if (!object || object.visible_metadata.tombstone) {
    return { ok: false, reason: "edge-not-found" };
  }
  return localReadObject(context, {
    authorization: input.authorization,
    object_id: object.object_id
  });
}

export async function localUpdateEdgeObject(
  context: LocalMcpContext,
  input: LocalGraphEdgeUpdateToolInput
): Promise<LocalGraphToolResult<LocalGraphMutationResult>> {
  if (!validateAuthority(context, input.authority_id)) {
    return { ok: false, reason: "authority-mismatch" };
  }
  if (!input.edge_id || !input.patch || typeof input.patch !== "object" || Array.isArray(input.patch)) {
    return { ok: false, reason: "invalid-edge-update-request" };
  }
  const object = findEdgeObject(context, input.edge_id);
  const existingEdge = object ? edgeData(object) : undefined;
  if (!object || !existingEdge || object.visible_metadata.tombstone) {
    return { ok: false, reason: "edge-not-found" };
  }
  const updatedEdge = TemporalEdgeSchema.safeParse({
    ...existingEdge,
    ...input.patch
  });
  if (!updatedEdge.success) {
    return { ok: false, reason: "invalid-edge" };
  }
  const result = await localUpdateObject(context, {
    authorization: input.authorization,
    object_id: object.object_id,
    expected_version: input.expected_version,
    patch: {
      content_hash: sha256(JSON.stringify(updatedEdge.data)),
      payload: {
        kind: "plaintext-json",
        data: updatedEdge.data
      }
    }
  });
  if (result.ok) {
    const auth = await authenticateToolCall(context, input.authorization);
    if (auth.ok) {
      recordToolDecision({
        context,
        authenticated: auth.authenticated,
        toolName: "edge_update",
        operation: "update",
        object: object,
        allowed: true,
        reason: "allowed"
      });
    }
  }
  return result;
}

export async function localDeleteEdgeObject(
  context: LocalMcpContext,
  input: LocalGraphEdgeDeleteToolInput
): Promise<LocalGraphToolResult<LocalGraphMutationResult>> {
  if (!validateAuthority(context, input.authority_id)) {
    return { ok: false, reason: "authority-mismatch" };
  }
  if (!input.edge_id) {
    return { ok: false, reason: "invalid-edge-delete-request" };
  }
  const object = findEdgeObject(context, input.edge_id);
  if (!object || object.visible_metadata.tombstone) {
    return { ok: false, reason: "edge-not-found" };
  }
  const result = await localTombstoneObject(context, {
    authorization: input.authorization,
    object_id: object.object_id,
    expected_version: input.expected_version
  });
  if (result.ok) {
    const auth = await authenticateToolCall(context, input.authorization);
    if (auth.ok) {
      recordToolDecision({
        context,
        authenticated: auth.authenticated,
        toolName: "edge_delete",
        operation: "delete",
        object,
        allowed: true,
        reason: "allowed"
      });
    }
  }
  return result;
}

export async function localReconcileGraph(
  context: LocalMcpContext,
  input: LocalGraphAuthorityToolInput
): Promise<LocalGraphToolResult<Record<string, unknown>>> {
  const status = await localGraphStatus(context, input);
  if (!status.ok) {
    return status;
  }
  return {
    ok: true,
    result: {
      reconciliation_schema: "living-atlas-local-graph-reconciliation:v1",
      decision: "reconciled",
      authority_id: status.result.authority_id,
      local_graph: {
        object_count: status.result.object_count,
        persistence: status.result.plaintext_persistence ?? "synthetic-in-memory"
      }
    }
  };
}

export async function localSyncStatus(
  context: LocalMcpContext,
  input: LocalGraphToolInput
): Promise<LocalGraphToolResult<Record<string, unknown>>> {
  const status = await localGraphStatus(context, input);
  if (!status.ok) {
    return status;
  }
  const graphStoreStatus = context.graphStore?.status();
  return {
    ok: true,
    result: {
      authority_id: status.result.authority_id,
      latest_generation: graphStoreStatus?.generation ?? 0,
      object_count: status.result.object_count,
      change_count: graphStoreStatus?.journal_sequence ?? 0,
      latest_batch_id: undefined,
      latest_withheld_plaintext_count: 0,
      local_persistence: status.result.plaintext_persistence ?? "synthetic-in-memory"
    }
  };
}

export async function localActivityRead(
  context: LocalMcpContext,
  input: LocalGraphAuthorityToolInput & { limit?: number }
): Promise<LocalGraphToolResult<Record<string, unknown>>> {
  const auth = await authenticateToolCall(context, input.authorization);
  if (!auth.ok) {
    return { ok: false, reason: auth.reason };
  }
  if (!validateAuthority(context, input.authority_id)) {
    return { ok: false, reason: "authority-mismatch" };
  }
  const limit = boundedLimit(input.limit, 100);
  const events = context.activitySink?.read?.(limit) ?? [];
  const auditEvents = context.auditSink?.read?.(limit) ?? [];
  recordToolDecision({
    context,
    authenticated: auth.authenticated,
    toolName: "activity_read",
    operation: "audit-read",
    allowed: true,
    reason: "allowed"
  });
  return {
    ok: true,
    result: {
      ok: true,
      stream_schema: "living-atlas-praxis-activity-audit-stream:v1",
      plane: "local",
      events,
      audit_events: auditEvents
    }
  };
}

export async function localUnsupportedTool(
  context: LocalMcpContext,
  input: LocalGraphToolInput,
  toolName: string
): Promise<LocalGraphToolResult<Record<string, unknown>>> {
  const auth = await authenticateToolCall(context, input.authorization);
  if (!auth.ok) {
    return { ok: false, reason: auth.reason };
  }
  recordToolDecision({
    context,
    authenticated: auth.authenticated,
    toolName,
    operation: "audit-read",
    allowed: false,
    reason: "not-applicable-local-transport"
  });
  return {
    ok: false,
    reason: "not-applicable-local-transport",
    result: {
      tool: toolName,
      plane: "local"
    }
  };
}
