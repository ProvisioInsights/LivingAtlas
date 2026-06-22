import type {
  CapabilityGrant,
  ControlPlaneSnapshot,
  GraphObjectEnvelope,
  LocalControlState,
  ObjectId,
  Operation
} from "@living-atlas/contracts";
import {
  AccessClassSchema,
  EncryptionClassSchema,
  GraphObjectEnvelopeSchema,
  GraphPayloadSchema,
  IsoTimestampSchema,
  KeyIdSchema,
  ObjectIdSchema,
  ObjectTypeSchema,
  Sha256HashSchema
} from "@living-atlas/contracts";
import { controlPlaneFixture, syntheticGraphObjects } from "@living-atlas/fixtures";
import type { FileLocalGraphStore } from "@living-atlas/local-graph-store";
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
  credentialStore: LocalMcpCredentialStore;
  auditSink?: LocalMcpAuditSink;
  activitySink?: LocalMcpActivitySink;
  now?: string;
  syntheticStoreLimits?: Partial<LocalGraphSyntheticStoreLimits>;
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
export type LocalGraphUpdatePatch = z.infer<typeof LocalGraphUpdatePatchSchema>;

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

export type LocalGraphStatusResult = {
  authority_id: string;
  policy_generation: number;
  object_count: number;
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
  object: GraphObjectEnvelope;
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

export type LocalGraphToolResult<T> =
  | {
      ok: true;
      result: T;
    }
  | {
      ok: false;
      reason: string;
    };

export function createFixtureLocalMcpContext(options: {
  credentialStore: LocalMcpCredentialStore;
  auditSink?: LocalMcpAuditSink;
  activitySink?: LocalMcpActivitySink;
  now?: string;
  syntheticStoreLimits?: Partial<LocalGraphSyntheticStoreLimits>;
}): LocalMcpContext {
  return {
    controlPlane: controlPlaneFixture,
    graphObjects: cloneGraphObjects(syntheticGraphObjects),
    credentialStore: options.credentialStore,
    auditSink: options.auditSink,
    activitySink: options.activitySink,
    now: options.now,
    syntheticStoreLimits: options.syntheticStoreLimits
  };
}

export function createLocalMcpContextFromControlState(options: {
  controlState: LocalControlState;
  graphObjects?: GraphObjectEnvelope[];
  graphStore?: FileLocalGraphStore;
  auditSink?: LocalMcpAuditSink;
  activitySink?: LocalMcpActivitySink;
  now?: string;
  syntheticStoreLimits?: Partial<LocalGraphSyntheticStoreLimits>;
}): LocalMcpContext {
  return {
    controlPlane: options.controlState.control_plane,
    graphObjects: cloneGraphObjects(options.graphObjects ?? syntheticGraphObjects),
    graphStore: options.graphStore,
    credentialStore: new InMemoryLocalMcpCredentialStore(options.controlState.local_credentials),
    auditSink: options.auditSink,
    activitySink: options.activitySink,
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

function envelopeByteSize(object: GraphObjectEnvelope): number {
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
  return context.graphStore?.readObject(objectId) ?? context.graphObjects.find((candidate) => candidate.object_id === objectId);
}

function objectWithinSyntheticLimit(context: LocalMcpContext, object: GraphObjectEnvelope): boolean {
  return envelopeByteSize(object) <= syntheticStoreLimits(context).maxEnvelopeBytes;
}

function sanitizeAuthorizedObject(object: GraphObjectEnvelope, plaintextAllowed: boolean): AuthorizedLocalObject {
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
    toolName: "local_graph_status",
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
      client_id: auth.authenticated.client.client_id,
      profile: auth.authenticated.capability.profile,
      access_classes: auth.authenticated.capability.access_classes,
      operations: auth.authenticated.capability.operations
    }
  };
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
      toolName: "local_list_objects",
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
      toolName: "local_read_object",
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
    toolName: "local_read_object",
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
      object: sanitizeAuthorizedObject(object, decision.plaintext_allowed)
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

  const parsedObject = GraphObjectEnvelopeSchema.safeParse(input.object);
  if (!parsedObject.success) {
    recordToolDecision({
      context,
      authenticated: auth.authenticated,
      toolName: "local_create_object",
      operation: "create",
      allowed: false,
      reason: "invalid-object"
    });
    return { ok: false, reason: "invalid-object" };
  }

  const object = parsedObject.data;
  if (object.authority_id !== context.controlPlane.authority.authority_id) {
    recordToolDecision({
      context,
      authenticated: auth.authenticated,
      toolName: "local_create_object",
      operation: "create",
      object,
      allowed: false,
      reason: "object-authority-mismatch"
    });
    return { ok: false, reason: "object-authority-mismatch" };
  }

  if (readContextObject(context, object.object_id)) {
    recordToolDecision({
      context,
      authenticated: auth.authenticated,
      toolName: "local_create_object",
      operation: "create",
      object,
      allowed: false,
      reason: "object-already-exists"
    });
    return { ok: false, reason: "object-already-exists" };
  }

  if (!context.graphStore && context.graphObjects.length >= syntheticStoreLimits(context).maxObjects) {
    recordToolDecision({
      context,
      authenticated: auth.authenticated,
      toolName: "local_create_object",
      operation: "create",
      object,
      allowed: false,
      reason: "synthetic-store-full"
    });
    return { ok: false, reason: "synthetic-store-full" };
  }

  if (!objectWithinSyntheticLimit(context, object)) {
    recordToolDecision({
      context,
      authenticated: auth.authenticated,
      toolName: "local_create_object",
      operation: "create",
      object,
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
  }, object);

  recordToolDecision({
    context,
    authenticated: auth.authenticated,
    toolName: "local_create_object",
    operation: "create",
    object,
    decision,
    allowed: decision.allowed,
    reason: decision.reason_code
  });

  if (!decision.allowed) {
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
      return { ok: false, reason: mutation.reason };
    }

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

  const storedObject = cloneGraphObject(object);
  context.graphObjects.push(storedObject);

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
      toolName: "local_update_object",
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
      toolName: "local_update_object",
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
      toolName: "local_update_object",
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
      toolName: "local_update_object",
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
      toolName: "local_update_object",
      operation: "update",
      object: existingObject,
      allowed: false,
      reason: "version-conflict"
    });
    return { ok: false, reason: "version-conflict" };
  }

  const patch = parsedPatch.data;
  const candidate = GraphObjectEnvelopeSchema.safeParse({
    ...existingObject,
    ...patch,
    authority_id: existingObject.authority_id,
    object_id: existingObject.object_id,
    created_at: existingObject.created_at,
    updated_at: patch.updated_at ?? nowForMutation(context),
    version: existingObject.version + 1,
    visible_metadata: patch.visible_metadata
      ? {
          ...existingObject.visible_metadata,
          ...patch.visible_metadata
        }
      : existingObject.visible_metadata
  });

  if (!candidate.success) {
    recordToolDecision({
      context,
      authenticated: auth.authenticated,
      toolName: "local_update_object",
      operation: "update",
      object: existingObject,
      allowed: false,
      reason: "invalid-object"
    });
    return { ok: false, reason: "invalid-object" };
  }

  const nextObject = candidate.data;
  if (!objectWithinSyntheticLimit(context, nextObject)) {
    recordToolDecision({
      context,
      authenticated: auth.authenticated,
      toolName: "local_update_object",
      operation: "update",
      object: existingObject,
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
  }, nextObject);

  recordToolDecision({
    context,
    authenticated: auth.authenticated,
    toolName: "local_update_object",
    operation: "update",
    object: nextObject,
    decision,
    allowed: decision.allowed,
    reason: decision.reason_code
  });

  if (!decision.allowed) {
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
      return { ok: false, reason: mutation.reason };
    }

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
      toolName: "local_tombstone_object",
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
      toolName: "local_tombstone_object",
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
      toolName: "local_tombstone_object",
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
      toolName: "local_tombstone_object",
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

  recordToolDecision({
    context,
    authenticated: auth.authenticated,
    toolName: "local_tombstone_object",
    operation: "delete",
    object: nextObject,
    decision,
    allowed: decision.allowed,
    reason: decision.reason_code
  });

  if (!decision.allowed) {
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
      return { ok: false, reason: mutation.reason };
    }

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
