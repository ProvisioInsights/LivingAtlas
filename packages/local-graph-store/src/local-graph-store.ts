import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type {
  AuthorityId,
  GraphObjectEnvelope,
  ObjectId,
  SyncChangeEvent
} from "@living-atlas/contracts";
import {
  AuthorityIdSchema,
  GraphObjectEnvelopeSchema,
  IsoTimestampSchema,
  ObjectIdSchema,
  OperationIdSchema,
  Sha256HashSchema,
  SyncChangeEventSchema,
  TraceIdSchema
} from "@living-atlas/contracts";
import {
  encryptGraphObjectPayload,
  encryptPlaintextGraphObjectDraft,
  type LocalKeyringState
} from "@living-atlas/local-keyring";

const LocalGraphJournalOperationSchema = z.enum(["create", "update", "tombstone"]);
export type LocalGraphJournalOperation = z.infer<typeof LocalGraphJournalOperationSchema>;

export const LocalGraphSnapshotSchema = z
  .object({
    schema_version: z.literal(1),
    authority_id: AuthorityIdSchema,
    created_at: IsoTimestampSchema,
    updated_at: IsoTimestampSchema,
    generation: z.number().int().nonnegative(),
    journal_sequence: z.number().int().nonnegative(),
    plaintext_persistence: z.enum(["redacted", "encrypted", "allowed"]),
    objects: z.array(GraphObjectEnvelopeSchema)
  })
  .strict();

export type LocalGraphSnapshot = z.infer<typeof LocalGraphSnapshotSchema>;

const LocalGraphJournalEntryHashPayloadSchema = z
  .object({
    schema_version: z.literal(1),
    sequence: z.number().int().positive(),
    previous_generation: z.number().int().nonnegative(),
    generation: z.number().int().positive(),
    operation: LocalGraphJournalOperationSchema,
    recorded_at: IsoTimestampSchema,
    actor_id: z.string().min(1),
    operation_id: OperationIdSchema,
    trace_id: TraceIdSchema,
    object_id: ObjectIdSchema,
    base_version: z.number().int().nonnegative().optional(),
    new_version: z.number().int().nonnegative(),
    object: GraphObjectEnvelopeSchema,
    change: SyncChangeEventSchema
  })
  .strict();

type LocalGraphJournalEntryHashPayload = z.infer<typeof LocalGraphJournalEntryHashPayloadSchema>;

export const LocalGraphJournalEntrySchema = LocalGraphJournalEntryHashPayloadSchema.extend({
  entry_hash: Sha256HashSchema
}).strict();

export type LocalGraphJournalEntry = z.infer<typeof LocalGraphJournalEntrySchema>;

export type LocalGraphPlaintextPersistenceMode = "redact" | "encrypt" | "allow";

export type OpenFileLocalGraphStoreOptions = {
  directory: string;
  authorityId?: AuthorityId;
  plaintextPersistence?: LocalGraphPlaintextPersistenceMode;
  keyring?: LocalKeyringState;
  now?: () => string;
};

export type InitializeLocalGraphStoreOptions = {
  expected_generation?: number;
  created_at?: string;
};

export type LocalGraphStoreStatus = {
  authority_id: AuthorityId;
  generation: number;
  journal_sequence: number;
  object_count: number;
  active_object_count: number;
  tombstone_count: number;
  updated_at: string;
  plaintext_persistence: "redacted" | "encrypted" | "allowed";
};

export type LocalGraphMutationInputBase = {
  expected_generation: number;
  actor_id: string;
  operation_id?: string;
  trace_id?: string;
  recorded_at?: string;
};

export type CreateLocalGraphObjectInput = LocalGraphMutationInputBase & {
  object: unknown;
};

export type UpdateLocalGraphObjectInput = LocalGraphMutationInputBase & {
  object: unknown;
  expected_version?: number;
};

export type TombstoneLocalGraphObjectInput = LocalGraphMutationInputBase & {
  object_id: ObjectId;
  expected_version?: number;
};

export type LocalGraphMutationConflictReason =
  | "generation-conflict"
  | "version-conflict"
  | "object-already-exists"
  | "object-already-tombstoned"
  | "object-authority-mismatch"
  | "object-missing"
  | "invalid-object"
  | "invalid-object-id";

export type LocalGraphMutationResult =
  | {
      ok: true;
      operation: LocalGraphJournalOperation;
      object: GraphObjectEnvelope;
      change: SyncChangeEvent;
      previous_generation: number;
      generation: number;
      journal_sequence: number;
      previous_version?: number;
      new_version: number;
      persistence: "snapshot+journal";
    }
  | {
      ok: false;
      reason: LocalGraphMutationConflictReason;
      current_generation: number;
      current_version?: number;
    };

type LocalGraphState = {
  authorityId: AuthorityId;
  createdAt: string;
  updatedAt: string;
  generation: number;
  journalSequence: number;
  objects: Map<ObjectId, GraphObjectEnvelope>;
};

type LocalGraphStorePaths = {
  directory: string;
  snapshotPath: string;
  journalPath: string;
};

const ownerOnlyMode = 0o600;
const defaultSnapshotName = "snapshot.json";
const defaultJournalName = "journal.jsonl";

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

async function readTextIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function fsyncFile(filePath: string): Promise<void> {
  const handle = await open(filePath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function fsyncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is not uniformly available across filesystems. File sync
    // plus rename still gives us the durable path on supported local disks.
  }
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, { mode: ownerOnlyMode });
  await chmod(tmpPath, ownerOnlyMode);
  await fsyncFile(tmpPath);
  await rename(tmpPath, filePath);
  await chmod(filePath, ownerOnlyMode);
  await fsyncDirectory(dirname(filePath));
}

async function atomicWriteText(filePath: string, value: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await writeFile(tmpPath, value, { mode: ownerOnlyMode });
  await chmod(tmpPath, ownerOnlyMode);
  await fsyncFile(tmpPath);
  await rename(tmpPath, filePath);
  await chmod(filePath, ownerOnlyMode);
  await fsyncDirectory(dirname(filePath));
}

async function appendJournalEntry(filePath: string, entry: LocalGraphJournalEntry): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const handle = await open(filePath, "a", ownerOnlyMode);
  try {
    await handle.writeFile(`${JSON.stringify(entry)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(filePath, ownerOnlyMode);
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function digest(value: string, length = 24): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function makeId(prefix: "la_change" | "la_operation" | "la_trace", seed: string): string {
  return `${prefix}_${digest(seed)}`;
}

function cloneGraphObject(object: GraphObjectEnvelope): GraphObjectEnvelope {
  return GraphObjectEnvelopeSchema.parse(structuredClone(object));
}

function normalizeRecordedAt(recordedAt: string | undefined, now: () => string): string {
  return IsoTimestampSchema.parse(recordedAt ?? now());
}

function journalEntryHashPayload(entry: LocalGraphJournalEntryHashPayload): string {
  return JSON.stringify({
    schema_version: entry.schema_version,
    sequence: entry.sequence,
    previous_generation: entry.previous_generation,
    generation: entry.generation,
    operation: entry.operation,
    recorded_at: entry.recorded_at,
    actor_id: entry.actor_id,
    operation_id: entry.operation_id,
    trace_id: entry.trace_id,
    object_id: entry.object_id,
    base_version: entry.base_version,
    new_version: entry.new_version,
    object: entry.object,
    change: entry.change
  });
}

function buildJournalEntryHash(entry: LocalGraphJournalEntryHashPayload): `sha256:${string}` {
  return sha256(journalEntryHashPayload(entry));
}

function parseOperationId(value: string | undefined, seed: string): string {
  return OperationIdSchema.parse(value ?? makeId("la_operation", seed));
}

function parseTraceId(value: string | undefined, seed: string): string {
  return TraceIdSchema.parse(value ?? makeId("la_trace", seed));
}

function redactedPlaintextPayload(object: GraphObjectEnvelope): GraphObjectEnvelope {
  if (object.payload.kind !== "plaintext-json") {
    return object;
  }

  const nonce = randomBytes(16).toString("hex");
  const redactionMarker = digest(`${object.authority_id}:${object.object_id}:${object.version}:${nonce}:local-redaction`, 32);

  return GraphObjectEnvelopeSchema.parse({
    ...object,
    encryption_class: "client-encrypted",
    payload: {
      kind: "ciphertext-inline",
      ciphertext: `local-redacted:${redactionMarker}`,
      nonce,
      algorithm: "local-graph-store-redacted-v1"
    }
  });
}

async function objectForPersistence(
  objectInput: unknown,
  plaintextPersistence: LocalGraphPlaintextPersistenceMode,
  keyring: LocalKeyringState | undefined
): Promise<GraphObjectEnvelope | undefined> {
  const parsed = GraphObjectEnvelopeSchema.safeParse(objectInput);

  if (plaintextPersistence === "encrypt") {
    if (!keyring) {
      throw new Error("Local graph encrypted persistence requires an unlocked local keyring");
    }

    if (parsed.success) {
      return encryptGraphObjectPayload(cloneGraphObject(parsed.data), keyring);
    }

    return encryptPlaintextGraphObjectDraft(objectInput, keyring);
  }

  if (!parsed.success) {
    return undefined;
  }

  const object = cloneGraphObject(parsed.data);
  return plaintextPersistence === "redact" ? redactedPlaintextPayload(object) : object;
}

function assertNoPlaintextPayloads(objects: Iterable<GraphObjectEnvelope>): void {
  for (const object of objects) {
    if (object.payload.kind === "plaintext-json") {
      throw new Error(`Local graph store plaintext persistence denied for ${object.object_id}`);
    }
  }
}

function snapshotFromState(
  state: LocalGraphState,
  plaintextPersistence: LocalGraphPlaintextPersistenceMode
): LocalGraphSnapshot {
  return LocalGraphSnapshotSchema.parse({
    schema_version: 1,
    authority_id: state.authorityId,
    created_at: state.createdAt,
    updated_at: state.updatedAt,
    generation: state.generation,
    journal_sequence: state.journalSequence,
    plaintext_persistence: plaintextPersistence === "redact" ? "redacted" : plaintextPersistence === "encrypt" ? "encrypted" : "allowed",
    objects: Array.from(state.objects.values()).map(cloneGraphObject)
  });
}

function statusFromState(
  state: LocalGraphState,
  plaintextPersistence: LocalGraphPlaintextPersistenceMode
): LocalGraphStoreStatus {
  const objects = Array.from(state.objects.values());
  const tombstoneCount = objects.filter((object) => object.visible_metadata.tombstone).length;
  return {
    authority_id: state.authorityId,
    generation: state.generation,
    journal_sequence: state.journalSequence,
    object_count: objects.length,
    active_object_count: objects.length - tombstoneCount,
    tombstone_count: tombstoneCount,
    updated_at: state.updatedAt,
    plaintext_persistence: plaintextPersistence === "redact" ? "redacted" : plaintextPersistence === "encrypt" ? "encrypted" : "allowed"
  };
}

function mapFromObjects(objects: GraphObjectEnvelope[]): Map<ObjectId, GraphObjectEnvelope> {
  const map = new Map<ObjectId, GraphObjectEnvelope>();
  for (const object of objects) {
    map.set(object.object_id, cloneGraphObject(object));
  }
  return map;
}

function applyJournalEntry(state: LocalGraphState, entry: LocalGraphJournalEntry): LocalGraphState {
  const payload = LocalGraphJournalEntryHashPayloadSchema.parse({
    schema_version: entry.schema_version,
    sequence: entry.sequence,
    previous_generation: entry.previous_generation,
    generation: entry.generation,
    operation: entry.operation,
    recorded_at: entry.recorded_at,
    actor_id: entry.actor_id,
    operation_id: entry.operation_id,
    trace_id: entry.trace_id,
    object_id: entry.object_id,
    base_version: entry.base_version,
    new_version: entry.new_version,
    object: entry.object,
    change: entry.change
  });

  if (buildJournalEntryHash(payload) !== entry.entry_hash) {
    throw new Error(`Local graph journal hash mismatch at sequence ${entry.sequence}`);
  }

  if (entry.sequence !== state.journalSequence + 1) {
    throw new Error(`Local graph journal sequence gap at sequence ${entry.sequence}`);
  }

  if (entry.previous_generation !== state.generation || entry.generation !== state.generation + 1) {
    throw new Error(`Local graph journal generation gap at sequence ${entry.sequence}`);
  }

  if (entry.object.authority_id !== state.authorityId || entry.change.authority_id !== state.authorityId) {
    throw new Error(`Local graph journal authority mismatch at sequence ${entry.sequence}`);
  }

  const existing = state.objects.get(entry.object_id);
  if (entry.operation === "create" && existing) {
    throw new Error(`Local graph journal create collision at sequence ${entry.sequence}`);
  }

  if ((entry.operation === "update" || entry.operation === "tombstone") && !existing) {
    throw new Error(`Local graph journal missing object at sequence ${entry.sequence}`);
  }

  if (existing && entry.base_version !== undefined && existing.version !== entry.base_version) {
    throw new Error(`Local graph journal version conflict at sequence ${entry.sequence}`);
  }

  const nextObjects = new Map(state.objects);
  nextObjects.set(entry.object_id, cloneGraphObject(entry.object));
  return {
    authorityId: state.authorityId,
    createdAt: state.createdAt,
    updatedAt: entry.recorded_at,
    generation: entry.generation,
    journalSequence: entry.sequence,
    objects: nextObjects
  };
}

function pathsForDirectory(directory: string): LocalGraphStorePaths {
  return {
    directory,
    snapshotPath: join(directory, defaultSnapshotName),
    journalPath: join(directory, defaultJournalName)
  };
}

async function readSnapshot(paths: LocalGraphStorePaths): Promise<LocalGraphSnapshot | undefined> {
  const content = await readTextIfExists(paths.snapshotPath);
  return content === undefined ? undefined : LocalGraphSnapshotSchema.parse(JSON.parse(content));
}

async function readJournal(paths: LocalGraphStorePaths): Promise<LocalGraphJournalEntry[]> {
  const content = await readTextIfExists(paths.journalPath);
  if (content === undefined || content.trim() === "") {
    return [];
  }

  return content
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => LocalGraphJournalEntrySchema.parse(JSON.parse(line)));
}

async function loadState(
  paths: LocalGraphStorePaths,
  authorityId: AuthorityId | undefined,
  plaintextPersistence: LocalGraphPlaintextPersistenceMode,
  now: () => string
): Promise<LocalGraphState> {
  const snapshot = await readSnapshot(paths);
  const createdAt = snapshot?.created_at ?? now();
  const effectiveAuthorityId = AuthorityIdSchema.parse(snapshot?.authority_id ?? authorityId);

  let state: LocalGraphState = {
    authorityId: effectiveAuthorityId,
    createdAt,
    updatedAt: snapshot?.updated_at ?? createdAt,
    generation: snapshot?.generation ?? 0,
    journalSequence: snapshot?.journal_sequence ?? 0,
    objects: snapshot ? mapFromObjects(snapshot.objects) : new Map()
  };

  if (plaintextPersistence !== "allow") {
    assertNoPlaintextPayloads(state.objects.values());
  }

  const journalEntries = await readJournal(paths);
  for (const entry of journalEntries) {
    if (entry.sequence <= state.journalSequence) {
      continue;
    }
    state = applyJournalEntry(state, entry);
  }

  if (plaintextPersistence !== "allow") {
    assertNoPlaintextPayloads(state.objects.values());
  }

  return state;
}

export class FileLocalGraphStore {
  private mutationQueue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly paths: LocalGraphStorePaths,
    private state: LocalGraphState,
    private readonly plaintextPersistence: LocalGraphPlaintextPersistenceMode,
    private readonly keyring: LocalKeyringState | undefined,
    private readonly now: () => string
  ) {}

  static async open(options: OpenFileLocalGraphStoreOptions): Promise<FileLocalGraphStore> {
    const plaintextPersistence = options.plaintextPersistence ?? "redact";
    if (plaintextPersistence === "encrypt" && !options.keyring) {
      throw new Error("Local graph encrypted persistence requires an unlocked local keyring");
    }
    const now = options.now ?? (() => new Date().toISOString());
    const paths = pathsForDirectory(options.directory);
    await mkdir(paths.directory, { recursive: true });
    const state = await loadState(paths, options.authorityId, plaintextPersistence, now);
    return new FileLocalGraphStore(paths, state, plaintextPersistence, options.keyring, now);
  }

  private serializeMutation<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(fn, fn);
    this.mutationQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  status(): LocalGraphStoreStatus {
    return statusFromState(this.state, this.plaintextPersistence);
  }

  listObjects(options: { include_tombstones?: boolean } = {}): GraphObjectEnvelope[] {
    return Array.from(this.state.objects.values())
      .filter((object) => options.include_tombstones ?? !object.visible_metadata.tombstone)
      .map(cloneGraphObject);
  }

  readObject(objectId: ObjectId): GraphObjectEnvelope | undefined {
    const object = this.state.objects.get(ObjectIdSchema.parse(objectId));
    return object ? cloneGraphObject(object) : undefined;
  }

  async initializeFromObjects(
    objectsInput: GraphObjectEnvelope[],
    options: InitializeLocalGraphStoreOptions = {}
  ): Promise<LocalGraphMutationResult | { ok: true; status: LocalGraphStoreStatus; persistence: "snapshot+journal" }> {
    return this.serializeMutation(async () => {
    const expectedGeneration = options.expected_generation ?? 0;
    if (this.state.generation !== expectedGeneration) {
      return {
        ok: false,
        reason: "generation-conflict",
        current_generation: this.state.generation
      };
    }

    if (this.state.objects.size > 0) {
      return {
        ok: false,
        reason: "object-already-exists",
        current_generation: this.state.generation
      };
    }

    const objects: GraphObjectEnvelope[] = [];
    for (const objectInput of objectsInput) {
      const object = await objectForPersistence(objectInput, this.plaintextPersistence, this.keyring);
      if (!object) {
        return {
          ok: false,
          reason: "invalid-object",
          current_generation: this.state.generation
        };
      }

      if (object.authority_id !== this.state.authorityId) {
        return {
          ok: false,
          reason: "object-authority-mismatch",
          current_generation: this.state.generation
        };
      }

      if (objects.some((candidate) => candidate.object_id === object.object_id)) {
        return {
          ok: false,
          reason: "object-already-exists",
          current_generation: this.state.generation
        };
      }

      objects.push(object);
    }

    const timestamp = normalizeRecordedAt(options.created_at, this.now);
    const nextState: LocalGraphState = {
      authorityId: this.state.authorityId,
      createdAt: timestamp,
      updatedAt: timestamp,
      generation: expectedGeneration,
      journalSequence: this.state.journalSequence,
      objects: mapFromObjects(objects)
    };

    await atomicWriteJson(this.paths.snapshotPath, snapshotFromState(nextState, this.plaintextPersistence));
    this.state = nextState;
    return {
      ok: true,
      status: this.status(),
      persistence: "snapshot+journal"
    };
    });
  }

  async createObject(input: CreateLocalGraphObjectInput): Promise<LocalGraphMutationResult> {
    return this.serializeMutation(async () => {
    if (this.state.generation !== input.expected_generation) {
      return {
        ok: false,
        reason: "generation-conflict",
        current_generation: this.state.generation
      };
    }

    const object = await objectForPersistence(input.object, this.plaintextPersistence, this.keyring);
    if (!object) {
      return {
        ok: false,
        reason: "invalid-object",
        current_generation: this.state.generation
      };
    }

    if (object.authority_id !== this.state.authorityId) {
      return {
        ok: false,
        reason: "object-authority-mismatch",
        current_generation: this.state.generation
      };
    }

    if (this.state.objects.has(object.object_id)) {
      return {
        ok: false,
        reason: "object-already-exists",
        current_generation: this.state.generation,
        current_version: this.state.objects.get(object.object_id)?.version
      };
    }

    return this.commitMutation("create", object, undefined, input);
    });
  }

  async updateObject(input: UpdateLocalGraphObjectInput): Promise<LocalGraphMutationResult> {
    return this.serializeMutation(async () => {
    if (this.state.generation !== input.expected_generation) {
      return {
        ok: false,
        reason: "generation-conflict",
        current_generation: this.state.generation
      };
    }

    const object = await objectForPersistence(input.object, this.plaintextPersistence, this.keyring);
    if (!object) {
      return {
        ok: false,
        reason: "invalid-object",
        current_generation: this.state.generation
      };
    }

    if (object.authority_id !== this.state.authorityId) {
      return {
        ok: false,
        reason: "object-authority-mismatch",
        current_generation: this.state.generation
      };
    }

    const existing = this.state.objects.get(object.object_id);
    if (!existing) {
      return {
        ok: false,
        reason: "object-missing",
        current_generation: this.state.generation
      };
    }

    if (input.expected_version !== undefined && existing.version !== input.expected_version) {
      return {
        ok: false,
        reason: "version-conflict",
        current_generation: this.state.generation,
        current_version: existing.version
      };
    }

    if (object.version !== existing.version + 1) {
      return {
        ok: false,
        reason: "version-conflict",
        current_generation: this.state.generation,
        current_version: existing.version
      };
    }

    return this.commitMutation("update", object, existing.version, input);
    });
  }

  async tombstoneObject(input: TombstoneLocalGraphObjectInput): Promise<LocalGraphMutationResult> {
    return this.serializeMutation(async () => {
    if (this.state.generation !== input.expected_generation) {
      return {
        ok: false,
        reason: "generation-conflict",
        current_generation: this.state.generation
      };
    }

    const parsedObjectId = ObjectIdSchema.safeParse(input.object_id);
    if (!parsedObjectId.success) {
      return {
        ok: false,
        reason: "invalid-object-id",
        current_generation: this.state.generation
      };
    }

    const existing = this.state.objects.get(parsedObjectId.data);
    if (!existing) {
      return {
        ok: false,
        reason: "object-missing",
        current_generation: this.state.generation
      };
    }

    if (existing.visible_metadata.tombstone) {
      return {
        ok: false,
        reason: "object-already-tombstoned",
        current_generation: this.state.generation,
        current_version: existing.version
      };
    }

    if (input.expected_version !== undefined && existing.version !== input.expected_version) {
      return {
        ok: false,
        reason: "version-conflict",
        current_generation: this.state.generation,
        current_version: existing.version
      };
    }

    const recordedAt = normalizeRecordedAt(input.recorded_at, this.now);
    const tombstone = GraphObjectEnvelopeSchema.parse({
      ...existing,
      version: existing.version + 1,
      updated_at: recordedAt,
      visible_metadata: {
        ...existing.visible_metadata,
        tombstone: true
      }
    });

    return this.commitMutation("tombstone", tombstone, existing.version, {
      ...input,
      recorded_at: recordedAt
    });
    });
  }

  async compact(): Promise<LocalGraphStoreStatus> {
    return this.serializeMutation(async () => {
      await atomicWriteJson(this.paths.snapshotPath, snapshotFromState(this.state, this.plaintextPersistence));
      await atomicWriteText(this.paths.journalPath, "");
      return this.status();
    });
  }

  private async commitMutation(
    operation: LocalGraphJournalOperation,
    object: GraphObjectEnvelope,
    baseVersion: number | undefined,
    input: LocalGraphMutationInputBase
  ): Promise<LocalGraphMutationResult> {
    const previousGeneration = this.state.generation;
    const generation = previousGeneration + 1;
    const sequence = this.state.journalSequence + 1;
    const recordedAt = normalizeRecordedAt(input.recorded_at, this.now);
    const seed = `${operation}:${object.object_id}:${generation}:${sequence}:${recordedAt}`;
    const operationId = parseOperationId(input.operation_id, seed);
    const traceId = parseTraceId(input.trace_id, seed);
    const change = SyncChangeEventSchema.parse({
      change_id: makeId("la_change", seed),
      authority_id: this.state.authorityId,
      operation_id: operationId,
      trace_id: traceId,
      recorded_at: recordedAt,
      object_id: object.object_id,
      operation,
      base_version: baseVersion,
      new_version: object.version,
      content_hash: object.content_hash,
      access_class: object.access_class,
      generation,
      actor_id: input.actor_id
    });

    const entryPayload = LocalGraphJournalEntryHashPayloadSchema.parse({
      schema_version: 1,
      sequence,
      previous_generation: previousGeneration,
      generation,
      operation,
      recorded_at: recordedAt,
      actor_id: input.actor_id,
      operation_id: operationId,
      trace_id: traceId,
      object_id: object.object_id,
      base_version: baseVersion,
      new_version: object.version,
      object,
      change
    });

    const entry = LocalGraphJournalEntrySchema.parse({
      ...entryPayload,
      entry_hash: buildJournalEntryHash(entryPayload)
    });

    await appendJournalEntry(this.paths.journalPath, entry);

    const nextObjects = new Map(this.state.objects);
    nextObjects.set(object.object_id, cloneGraphObject(object));
    this.state = {
      authorityId: this.state.authorityId,
      createdAt: this.state.createdAt,
      updatedAt: recordedAt,
      generation,
      journalSequence: sequence,
      objects: nextObjects
    };

    return {
      ok: true,
      operation,
      object: cloneGraphObject(object),
      change,
      previous_generation: previousGeneration,
      generation,
      journal_sequence: sequence,
      previous_version: baseVersion,
      new_version: object.version,
      persistence: "snapshot+journal"
    };
  }
}
