import { createHash, randomBytes, webcrypto } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import {
  GraphObjectEnvelopeSchema,
  type GraphObjectEnvelope,
  type LocalControlState
} from "@living-atlas/contracts";
import {
  createLogseqSemanticGraphObjects,
  MarkdownImportSourceKindSchema,
  type MarkdownFileInput
} from "@living-atlas/importer";
import { createFixtureLocalControlState } from "@living-atlas/local-control-store";
import { FileLocalGraphStore } from "@living-atlas/local-graph-store";
import {
  buildCiphertextSyncBatch,
  fetchSyncEnvelopes,
  fetchSyncStatus,
  nextSyncGenerationFromStatus,
  submitSyncBatch,
  type FetchSyncEnvelopesOptions,
  type FetchSyncEnvelopesResult,
  type FetchSyncStatusOptions,
  type FetchSyncStatusResult
} from "@living-atlas/sync-agent";
import {
  printCloudflareLiveUsageGateResult,
  runCloudflareLiveUsageGate
} from "./cloudflare-live-usage-gate";
import {
  SemanticSourceModeSchema,
  walkImportableSemanticSourceFiles
} from "./logseq-semantic-source-files";

const defaultFileCount = 5;
const maxFileCount = 10;
const maxFileOffset = 1_000_000;
const maxFileBytes = 256_000;
const defaultMaxSyncObjectsPerBatch = 240;
const hardMaxSyncObjectsPerBatch = 250;
const defaultReadRetryCount = 3;
const liveAckEnv = "LIVING_ATLAS_LOGSEQ_SEMANTIC_SYNC_ACK";
const liveAckValue = "sync-semantic-ciphertext-to-cloudflare";
const backfillAckEnv = "LIVING_ATLAS_LOGSEQ_SEMANTIC_BACKFILL_ACK";
const backfillAckValue = "record-known-synced-batch";
const syncModeEnv = "LIVING_ATLAS_LOGSEQ_SEMANTIC_SYNC_MODE";
const syncScopeEnv = "LIVING_ATLAS_LOGSEQ_SEMANTIC_SYNC_SCOPE";
const allObjectsSyncScope = "all";
const sourceCapsulesOnlySyncScope = "source-capsules-only";
const localOnlySyncMode = "local-only";
const cloudflareSyncMode = "cloudflare";
const backfillSyncMode = "backfill";
const textEncoder = new TextEncoder();

type SemanticSyncScope = typeof allObjectsSyncScope | typeof sourceCapsulesOnlySyncScope;
export type SemanticSyncMode = typeof localOnlySyncMode | typeof cloudflareSyncMode | typeof backfillSyncMode;

type CrudCase = {
  name: string;
  ok: boolean;
  detail?: string;
};

type SemanticBatchLedgerRecord = {
  record_schema: "living-atlas-logseq-semantic-batch:v1";
  recorded_at: string;
  authority_id: string;
  root_ref: `sha256:${string}`;
  source_kind: "logseq" | "obsidian" | "generic-markdown";
  source_mode: "markdown-only" | "logseq-notes" | "logseq-extensionless-only";
  file_offset: number;
  requested_file_count: number;
  actual_file_count: number;
  ledger_id: string;
  plan_totals: {
    bytes: number;
    pages: number;
    blocks: number;
    page_properties: number;
    block_properties: number;
    wikilinks: number;
    hash_tags: number;
    block_refs: number;
    edge_candidates: number;
    valid_edge_candidates: number;
    quarantined_edge_candidates: number;
    planned_objects: number;
    page_objects: number;
    block_objects: number;
    reference_index_objects: number;
    edge_objects: number;
    quarantine_objects: number;
  };
  crud: {
    ok: boolean;
    local_generation: number;
    checked_cases: number;
  };
  sync: {
    attempted: boolean;
    generation?: number;
    generations?: number[];
    batch_count?: number;
    synced_objects?: number;
  };
  files: Array<{
    source_path_ref: string;
    content_hash: `sha256:${string}`;
    migration_status: "migrated" | "skipped" | "quarantined";
    review_status: "not-required" | "needs-review" | "reviewed";
    parity_status: "local-verified" | "synced" | "blocked";
    source_capsule_object_id: string;
    planned_objects: number;
    object_plan_hash: `sha256:${string}`;
  }>;
  decisions: Record<string, number>;
  plaintext_policy: "hash-counts-refs-only";
};

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

function sha256(value: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function digest(value: string, length = 24): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function parseSemanticSyncScope(value: string | undefined): SemanticSyncScope {
  if (!value || value === allObjectsSyncScope) {
    return allObjectsSyncScope;
  }
  if (value === sourceCapsulesOnlySyncScope) {
    return sourceCapsulesOnlySyncScope;
  }
  throw new Error(`${syncScopeEnv} must be ${allObjectsSyncScope} or ${sourceCapsulesOnlySyncScope}`);
}

export function parseSemanticSyncMode(value: string | undefined): SemanticSyncMode {
  const mode = value ?? localOnlySyncMode;
  if (mode === localOnlySyncMode || mode === cloudflareSyncMode || mode === backfillSyncMode) {
    return mode;
  }
  throw new Error(`${syncModeEnv} must be ${localOnlySyncMode}, ${cloudflareSyncMode}, or ${backfillSyncMode}`);
}

export function resolveSemanticSyncMode(input: {
  syncMode?: string;
  liveAck?: string;
  backfillAck?: string;
}): SemanticSyncMode {
  const mode = parseSemanticSyncMode(input.syncMode);
  const hasLiveAck = input.liveAck !== undefined;
  const hasBackfillAck = input.backfillAck !== undefined;
  const liveAckValid = input.liveAck === liveAckValue;
  const backfillAckValid = input.backfillAck === backfillAckValue;

  if (mode === localOnlySyncMode) {
    if (hasLiveAck || hasBackfillAck) {
      throw new Error(`${syncModeEnv}=${localOnlySyncMode} rejects ${liveAckEnv} and ${backfillAckEnv}; unset them or choose an explicit mutating mode`);
    }
    return mode;
  }

  if (mode === cloudflareSyncMode) {
    if (!liveAckValid) {
      throw new Error(`${syncModeEnv}=${cloudflareSyncMode} requires ${liveAckEnv}=${liveAckValue}`);
    }
    if (hasBackfillAck) {
      throw new Error(`${syncModeEnv}=${cloudflareSyncMode} cannot be combined with ${backfillAckEnv}`);
    }
    return mode;
  }

  if (!backfillAckValid) {
    throw new Error(`${syncModeEnv}=${backfillSyncMode} requires ${backfillAckEnv}=${backfillAckValue}`);
  }
  if (hasLiveAck) {
    throw new Error(`${syncModeEnv}=${backfillSyncMode} cannot be combined with ${liveAckEnv}`);
  }
  return mode;
}

function isSourceCapsuleObject(object: GraphObjectEnvelope): boolean {
  return object.visible_metadata.schema_namespace === "import/logseq-semantic/source-capsule";
}

export function selectSemanticObjectsForSyncScope(
  objects: GraphObjectEnvelope[],
  scope: SemanticSyncScope
): {
  objectsToSync: GraphObjectEnvelope[];
  knownPreviouslySyncedObjects: number;
} {
  if (scope === allObjectsSyncScope) {
    return {
      objectsToSync: objects,
      knownPreviouslySyncedObjects: 0
    };
  }

  const objectsToSync = objects.filter(isSourceCapsuleObject);
  if (objectsToSync.length === 0) {
    throw new Error(`${syncScopeEnv}=${sourceCapsulesOnlySyncScope} found no source capsule objects`);
  }
  return {
    objectsToSync,
    knownPreviouslySyncedObjects: objects.length - objectsToSync.length
  };
}

function parseInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`expected integer from ${min} to ${max}, got ${value}`);
  }
  return parsed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientReadStatus(statusCode: number): boolean {
  return statusCode === 408 || statusCode === 429 || (statusCode >= 500 && statusCode <= 599);
}

async function fetchSyncStatusWithRetry(options: FetchSyncStatusOptions): Promise<FetchSyncStatusResult> {
  const retries = parseInteger(envValue("LIVING_ATLAS_LOGSEQ_SEMANTIC_READ_RETRIES"), defaultReadRetryCount, 0, 10);
  let result = await fetchSyncStatus(options);
  for (let attempt = 1; !result.ok && isTransientReadStatus(result.status_code) && attempt <= retries; attempt += 1) {
    const delayMs = 500 * attempt;
    console.warn(`semantic sync status read returned HTTP ${result.status_code}; retry ${attempt}/${retries} in ${delayMs}ms`);
    await sleep(delayMs);
    result = await fetchSyncStatus(options);
  }
  return result;
}

async function fetchSyncEnvelopesWithRetry(options: FetchSyncEnvelopesOptions): Promise<FetchSyncEnvelopesResult> {
  const retries = parseInteger(envValue("LIVING_ATLAS_LOGSEQ_SEMANTIC_READ_RETRIES"), defaultReadRetryCount, 0, 10);
  let result = await fetchSyncEnvelopes(options);
  for (let attempt = 1; !result.ok && isTransientReadStatus(result.status_code) && attempt <= retries; attempt += 1) {
    const delayMs = 500 * attempt;
    console.warn(`semantic envelope pull returned HTTP ${result.status_code}; retry ${attempt}/${retries} in ${delayMs}ms`);
    await sleep(delayMs);
    result = await fetchSyncEnvelopes(options);
  }
  return result;
}

function collectPlaintextNeedles(files: MarkdownFileInput[]): string[] {
  const needles = new Set<string>();
  for (const file of files) {
    const normalized = file.markdown.replace(/\s+/g, " ").trim();
    for (const match of normalized.matchAll(/[A-Za-z0-9][A-Za-z0-9 ,;:'"()[\]#/_-]{31,160}/g)) {
      const value = match[0]?.trim();
      if (value && value.length >= 32) {
        needles.add(value.slice(0, Math.min(value.length, 80)));
        break;
      }
    }
  }
  return [...needles].slice(0, files.length);
}

function assertNoNeedles(label: string, value: unknown, needles: string[]): void {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  for (const needle of needles) {
    if (needle && serialized.includes(needle)) {
      throw new Error(`${label} leaked sampled plaintext`);
    }
  }
}

function semanticFileRefs(
  ledger: Awaited<ReturnType<typeof createLogseqSemanticGraphObjects>>["ledger"],
  parityStatus: "local-verified" | "synced" | "blocked"
): SemanticBatchLedgerRecord["files"] {
  return ledger.files.map((file) => ({
    source_path_ref: file.source_path_ref,
    content_hash: file.content_hash as `sha256:${string}`,
    migration_status: file.counts.terminal_quarantined > 0 ? "quarantined" : "migrated",
    review_status: file.review_status,
    parity_status: parityStatus,
    source_capsule_object_id: file.source_capsule_object_id,
    planned_objects: file.objects.length,
    object_plan_hash: sha256(JSON.stringify(file.objects))
  }));
}

async function appendBatchLedgerRecord(path: string | undefined, record: SemanticBatchLedgerRecord, needles: string[]): Promise<void> {
  if (!path) {
    return;
  }
  assertNoNeedles("semantic batch ledger record", record, needles);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

async function encryptPayload(plaintext: string, aad: string): Promise<{
  ciphertext: string;
  nonce: string;
  hash: `sha256:${string}`;
  algorithm: string;
}> {
  const key = await webcrypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  const nonce = randomBytes(12);
  const ciphertext = new Uint8Array(await webcrypto.subtle.encrypt({
    name: "AES-GCM",
    iv: nonce,
    additionalData: textEncoder.encode(aad)
  }, key, textEncoder.encode(plaintext)));
  const encodedCiphertext = Buffer.from(ciphertext).toString("base64");
  const encodedNonce = Buffer.from(nonce).toString("base64");
  return {
    ciphertext: encodedCiphertext,
    nonce: encodedNonce,
    hash: sha256(`${encodedNonce}:${encodedCiphertext}`),
    algorithm: "aes-256-gcm"
  };
}

function nextVersionObject(object: GraphObjectEnvelope, seed: string, tombstone: boolean): GraphObjectEnvelope {
  const nonce = randomBytes(12).toString("base64");
  const ciphertext = Buffer.from(`semantic-crud:${seed}:${object.object_id}:v${object.version + 1}`).toString("base64");
  const contentHash = sha256(`${nonce}:${ciphertext}`);
  return GraphObjectEnvelopeSchema.parse({
    ...object,
    version: object.version + 1,
    updated_at: new Date().toISOString(),
    content_hash: contentHash,
    visible_metadata: {
      ...object.visible_metadata,
      tombstone
    },
    payload: {
      kind: "ciphertext-inline",
      ciphertext,
      nonce,
      algorithm: "aes-256-gcm"
    }
  });
}

function addCase(cases: CrudCase[], name: string, ok: boolean, detail?: string): void {
  cases.push({ name, ok, ...(detail ? { detail } : {}) });
}

async function runLocalCrudProof(objects: GraphObjectEnvelope[], needles: string[]): Promise<{
  cases: CrudCase[];
  directory: string;
  generation: number;
}> {
  const cases: CrudCase[] = [];
  const directory = await mkdtemp(join(tmpdir(), "living-atlas-logseq-semantic-"));
  const authorityId = objects[0]?.authority_id;
  if (!authorityId) {
    throw new Error("semantic conversion produced no objects");
  }
  const store = await FileLocalGraphStore.open({
    directory,
    authorityId,
    now: () => new Date().toISOString()
  });

  let expectedGeneration = 0;
  for (const object of objects) {
    const created = await store.createObject({
      object,
      expected_generation: expectedGeneration,
      actor_id: "la_client_logseqsemcrud0001"
    });
    if (!created.ok) {
      addCase(cases, `create-${object.object_type}`, false, created.reason);
      continue;
    }
    expectedGeneration = created.generation;
  }
  addCase(cases, "create-all-semantic-objects", cases.every((testCase) => testCase.ok), `objects=${objects.length}`);

  const listed = store.listObjects({ include_tombstones: true });
  addCase(cases, "read-list-all-semantic-objects", listed.length === objects.length, `listed=${listed.length}; expected=${objects.length}`);

  const byType = new Map<string, GraphObjectEnvelope>();
  for (const object of listed) {
    if (!byType.has(object.object_type)) {
      byType.set(object.object_type, object);
    }
  }

  for (const [objectType, object] of byType) {
    const read = store.readObject(object.object_id);
    addCase(cases, `read-${objectType}`, read?.object_id === object.object_id);

    const updated = await store.updateObject({
      object: nextVersionObject(object, `update:${objectType}`, false),
      expected_generation: expectedGeneration,
      expected_version: object.version,
      actor_id: "la_client_logseqsemcrud0001"
    });
    addCase(cases, `update-${objectType}`, updated.ok, updated.ok ? `generation=${updated.generation}` : updated.reason);
    if (!updated.ok) {
      continue;
    }
    expectedGeneration = updated.generation;

    const tombstoned = await store.tombstoneObject({
      object_id: object.object_id,
      expected_generation: expectedGeneration,
      expected_version: updated.object.version,
      actor_id: "la_client_logseqsemcrud0001"
    });
    addCase(cases, `delete-${objectType}`, tombstoned.ok, tombstoned.ok ? `generation=${tombstoned.generation}` : tombstoned.reason);
    if (!tombstoned.ok) {
      continue;
    }
    expectedGeneration = tombstoned.generation;

    const restored = await store.updateObject({
      object: nextVersionObject(tombstoned.object, `restore:${objectType}`, false),
      expected_generation: expectedGeneration,
      expected_version: tombstoned.object.version,
      actor_id: "la_client_logseqsemcrud0001"
    });
    addCase(cases, `restore-${objectType}`, restored.ok, restored.ok ? `generation=${restored.generation}` : restored.reason);
    if (restored.ok) {
      expectedGeneration = restored.generation;
    }
  }

  await store.compact();
  const persisted = `${await readFile(join(directory, "snapshot.json"), "utf8")}\n${await readFile(join(directory, "journal.jsonl"), "utf8")}`;
  assertNoNeedles("semantic local graph store files", persisted, needles);
  addCase(cases, "persisted-store-no-sampled-plaintext", true);

  return {
    cases,
    directory,
    generation: expectedGeneration
  };
}

function latestGenerationFromSyncError(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const status = (error as { status?: unknown }).status;
  if (!status || typeof status !== "object") {
    return undefined;
  }
  const latest = (status as { latest_generation?: unknown }).latest_generation;
  return typeof latest === "number" && Number.isInteger(latest) && latest >= 0 ? latest : undefined;
}

function remapControlState(input: LocalControlState, options: {
  authorityId: string;
  syncClientId: string;
  syncCapabilityId: string;
  syncDeviceId: string;
}): LocalControlState {
  const next = structuredClone(input);
  const originalPrimaryDeviceId = next.control_plane.devices[0]?.device_id;
  next.authority_id = options.authorityId;
  next.control_plane.authority = {
    ...next.control_plane.authority,
    authority_id: options.authorityId
  };
  next.control_plane.users = next.control_plane.users.map((user) => ({ ...user, authority_id: options.authorityId }));
  next.control_plane.devices = next.control_plane.devices.map((device, index) => ({
    ...device,
    authority_id: options.authorityId,
    device_id: index === 0 ? options.syncDeviceId : device.device_id
  }));
  next.control_plane.clients = next.control_plane.clients.map((client) => ({
    ...client,
    authority_id: options.authorityId,
    client_id: client.allowed_profile === "sync-device" ? options.syncClientId : client.client_id,
    device_id: client.device_id === originalPrimaryDeviceId ? options.syncDeviceId : client.device_id
  }));
  next.control_plane.capabilities = next.control_plane.capabilities.map((capability) => ({
    ...capability,
    authority_id: options.authorityId,
    capability_id: capability.profile === "sync-device" ? options.syncCapabilityId : capability.capability_id,
    client_id: capability.profile === "sync-device" ? options.syncClientId : capability.client_id
  }));
  next.control_plane.keys = next.control_plane.keys.map((key) => ({ ...key, authority_id: options.authorityId }));
  return next;
}

async function syncSemanticObjects(input: {
  objects: GraphObjectEnvelope[];
  needles: string[];
  authorityId: string;
}): Promise<{ generation: number; generations: number[]; batch_count: number; synced_objects: number }> {
  const gate = await runCloudflareLiveUsageGate();
  printCloudflareLiveUsageGateResult(gate);
  if (!gate.ok) {
    throw new Error("usage gate refused semantic ciphertext push");
  }

  const endpoint = requireEnv("LIVING_ATLAS_LIVE_SYNC_ENDPOINT");
  const syncToken = requireEnv("LIVING_ATLAS_LIVE_SYNC_TOKEN");
  const syncClientId = requireEnv("LIVING_ATLAS_LIVE_SYNC_CLIENT_ID");
  const syncCapabilityId = requireEnv("LIVING_ATLAS_LIVE_SYNC_CAPABILITY_ID");
  const syncTokenId = envValue("LIVING_ATLAS_LIVE_SYNC_TOKEN_ID");
  const syncDeviceId = envValue("LIVING_ATLAS_LIVE_SYNC_DEVICE_ID") ?? `la_device_logseqsem${digest(syncClientId, 18)}`;
  const maxObjectsPerBatch = parseInteger(
    envValue("LIVING_ATLAS_LOGSEQ_SEMANTIC_SYNC_MAX_OBJECTS_PER_BATCH"),
    defaultMaxSyncObjectsPerBatch,
    1,
    hardMaxSyncObjectsPerBatch
  );

  const status = await fetchSyncStatusWithRetry({
    endpoint,
    syncToken,
    clientId: syncClientId,
    capabilityId: syncCapabilityId,
    tokenId: syncTokenId
  });
  if (!status.ok) {
    throw new Error(`sync status failed HTTP ${status.status_code}: ${JSON.stringify(status.error)}`);
  }

  const initialBaseGeneration = status.status.latest_generation;
  const controlState = remapControlState(await createFixtureLocalControlState(`logseq-semantic-${digest(new Date().toISOString())}`), {
    authorityId: input.authorityId,
    syncClientId,
    syncCapabilityId,
    syncDeviceId
  });
  let baseGeneration = initialBaseGeneration;
  const generations: number[] = [];
  let syncedObjects = 0;

  for (let start = 0; start < input.objects.length; start += maxObjectsPerBatch) {
    const chunk = input.objects.slice(start, start + maxObjectsPerBatch);
    let targetGeneration = baseGeneration + 1;
    let built = buildCiphertextSyncBatch({
      controlState,
      graphObjects: chunk,
      syncClientId,
      tokenId: syncTokenId,
      baseGeneration,
      targetGeneration,
      now: new Date().toISOString()
    });
    assertNoNeedles("semantic sync batch", built.batch, input.needles);

    let submitted = await submitSyncBatch({
      endpoint,
      batch: built.batch,
      syncToken
    });
    if (!submitted.ok && submitted.status === 409) {
      const latest = latestGenerationFromSyncError(submitted.error);
      if (latest !== undefined && latest !== baseGeneration) {
        baseGeneration = latest;
        targetGeneration = latest + 1;
        built = buildCiphertextSyncBatch({
          controlState,
          graphObjects: chunk,
          syncClientId,
          tokenId: syncTokenId,
          baseGeneration,
          targetGeneration,
          now: new Date().toISOString()
        });
        assertNoNeedles("semantic sync batch retry", built.batch, input.needles);
        submitted = await submitSyncBatch({
          endpoint,
          batch: built.batch,
          syncToken
        });
      }
    }
    if (!submitted.ok) {
      throw new Error(`semantic ciphertext sync failed HTTP ${submitted.status}: ${JSON.stringify(submitted.error)}`);
    }
    baseGeneration = submitted.accepted.target_generation;
    generations.push(submitted.accepted.target_generation);
    syncedObjects += submitted.accepted.accepted_objects;
  }

  const pulledObjects: GraphObjectEnvelope[] = [];
  let afterGeneration = initialBaseGeneration;
  do {
    const pulled = await fetchSyncEnvelopesWithRetry({
      endpoint,
      authorityId: input.authorityId,
      afterGeneration,
      syncToken,
      clientId: syncClientId,
      capabilityId: syncCapabilityId,
      tokenId: syncTokenId
    });
    if (!pulled.ok) {
      throw new Error(`semantic envelope pull failed HTTP ${pulled.status_code}: ${JSON.stringify(pulled.error)}`);
    }
    assertNoNeedles("semantic pulled envelopes", pulled.response, input.needles);
    pulledObjects.push(...pulled.response.objects.map((entry) => entry.object));
    afterGeneration = pulled.response.next_cursor.generation;
    if (!pulled.response.has_more) {
      break;
    }
  } while (afterGeneration < baseGeneration);

  const pulledById = new Map(pulledObjects.map((object) => [object.object_id, object]));
  for (const expected of input.objects) {
    const actual = pulledById.get(expected.object_id);
    if (!actual) {
      throw new Error(`semantic envelope pull missed object ${expected.object_id}`);
    }
    if (actual.version !== expected.version || actual.content_hash !== expected.content_hash) {
      throw new Error(`semantic envelope mismatch for ${expected.object_id}`);
    }
  }

  return {
    generation: generations.at(-1) ?? initialBaseGeneration,
    generations,
    batch_count: generations.length,
    synced_objects: syncedObjects
  };
}

async function main(): Promise<void> {
  const root = envValue("LIVING_ATLAS_REAL_MARKDOWN_ROOT") ?? "./logseq";
  const fileCount = parseInteger(envValue("LIVING_ATLAS_LOGSEQ_SEMANTIC_FILE_COUNT"), defaultFileCount, 1, maxFileCount);
  const fileOffset = parseInteger(envValue("LIVING_ATLAS_LOGSEQ_SEMANTIC_FILE_OFFSET"), 0, 0, maxFileOffset);
  const batchLedgerPath = envValue("LIVING_ATLAS_LOGSEQ_SEMANTIC_LEDGER_PATH");
  const authorityId = envValue("LIVING_ATLAS_LIVE_AUTHORITY_ID") ?? "la_authority_logseqsemantic0001";
  const configuredPathRedactionSecret = envValue("LIVING_ATLAS_REAL_DATA_PATH_REDACTION_SECRET");
  const sourceKind = MarkdownImportSourceKindSchema.parse(envValue("LIVING_ATLAS_REAL_MARKDOWN_SOURCE_KIND") ?? "logseq");
  const sourceMode = SemanticSourceModeSchema.parse(envValue("LIVING_ATLAS_LOGSEQ_SEMANTIC_SOURCE_MODE") ?? "logseq-notes");
  const syncMode = resolveSemanticSyncMode({
    syncMode: envValue(syncModeEnv),
    liveAck: envValue(liveAckEnv),
    backfillAck: envValue(backfillAckEnv)
  });
  if (syncMode !== localOnlySyncMode && !configuredPathRedactionSecret) {
    throw new Error("LIVING_ATLAS_REAL_DATA_PATH_REDACTION_SECRET is required for live semantic sync or ledger backfill");
  }
  const pathRedactionSecret = configuredPathRedactionSecret ?? randomBytes(32).toString("hex");
  const createdAt = new Date().toISOString();
  const paths = await walkImportableSemanticSourceFiles({
    root,
    sourceKind,
    mode: sourceMode,
    maxFiles: fileCount,
    offset: fileOffset,
    maxFileBytes
  });
  if (paths.length === 0) {
    throw new Error(`no semantic source files found under configured root at offset ${fileOffset}`);
  }

  const files: MarkdownFileInput[] = [];
  for (const path of paths) {
    files.push({
      source_path: relative(root, path),
      markdown: await readFile(path, "utf8"),
      source_kind: sourceKind
    });
  }
  const needles = collectPlaintextNeedles(files);
  const result = await createLogseqSemanticGraphObjects(files, {
    authority_id: authorityId,
    created_at: createdAt,
    path_redaction_secret: pathRedactionSecret,
    encrypt: async ({ plaintext, aad }) => encryptPayload(plaintext, aad)
  });

  assertNoNeedles("semantic parity ledger", result.ledger, needles);
  assertNoNeedles("semantic encrypted envelopes", result.objects, needles);
  const crud = await runLocalCrudProof(result.objects, needles);
  const failed = crud.cases.filter((testCase) => !testCase.ok);
  if (failed.length > 0) {
    for (const testCase of crud.cases) {
      console.error(`- ${testCase.ok ? "ok" : "fail"} ${testCase.name}${testCase.detail ? ` (${testCase.detail})` : ""}`);
    }
    throw new Error(`semantic CRUD proof failed: ${failed.map((testCase) => testCase.name).join(", ")}`);
  }

  console.log("Living Atlas Logseq semantic parity and CRUD passed");
  console.log(`files=${result.ledger.file_count}; offset=${fileOffset}; source_mode=${sourceMode}; sync_mode=${syncMode}; objects=${result.objects.length}; local_generation=${crud.generation}`);
  console.log(`pages=${result.ledger.totals.pages}; blocks=${result.ledger.totals.blocks}; indexes=${result.ledger.totals.reference_index_objects_planned}; edges=${result.ledger.totals.edge_objects}; quarantine=${result.ledger.totals.quarantine_objects}`);
  console.log(`wikilinks=${result.ledger.totals.wikilinks}; tags=${result.ledger.totals.hash_tags}; block_refs=${result.ledger.totals.block_refs}; page_properties=${result.ledger.totals.page_properties}; block_properties=${result.ledger.totals.block_properties}`);
  const rootRef = `sha256:${digest(`${pathRedactionSecret}:semantic-root:v1:${root}`, 64)}` as const;
  console.log(`bytes=${result.ledger.totals.bytes}; root_ref=${rootRef}`);

  if (syncMode === backfillSyncMode) {
    if (!batchLedgerPath) {
      throw new Error("LIVING_ATLAS_LOGSEQ_SEMANTIC_LEDGER_PATH is required for semantic ledger backfill");
    }
    const backfillGeneration = parseInteger(envValue("LIVING_ATLAS_LOGSEQ_SEMANTIC_BACKFILL_GENERATION"), 0, 1, 1_000_000_000);
    const backfillSyncedObjects = parseInteger(
      envValue("LIVING_ATLAS_LOGSEQ_SEMANTIC_BACKFILL_SYNCED_OBJECTS"),
      result.objects.length,
      0,
      10_000_000
    );
    if (backfillSyncedObjects !== result.objects.length) {
      throw new Error(`backfill synced object count ${backfillSyncedObjects} did not match recomputed objects ${result.objects.length}`);
    }
    await appendBatchLedgerRecord(batchLedgerPath, {
      record_schema: "living-atlas-logseq-semantic-batch:v1",
      recorded_at: new Date().toISOString(),
      authority_id: authorityId,
      root_ref: rootRef,
      source_kind: sourceKind,
      source_mode: sourceMode,
      file_offset: fileOffset,
      requested_file_count: fileCount,
      actual_file_count: result.ledger.file_count,
      ledger_id: result.ledger.ledger_id,
      plan_totals: {
        bytes: result.ledger.totals.bytes,
        pages: result.ledger.totals.pages,
        blocks: result.ledger.totals.blocks,
        page_properties: result.ledger.totals.page_properties,
        block_properties: result.ledger.totals.block_properties,
        wikilinks: result.ledger.totals.wikilinks,
        hash_tags: result.ledger.totals.hash_tags,
        block_refs: result.ledger.totals.block_refs,
        edge_candidates: result.ledger.totals.edge_candidates,
        valid_edge_candidates: result.ledger.totals.valid_edge_candidates,
        quarantined_edge_candidates: result.ledger.totals.quarantined_edge_candidates,
        planned_objects: result.ledger.totals.planned_objects,
        page_objects: result.ledger.totals.page_objects,
        block_objects: result.ledger.totals.block_objects,
        reference_index_objects: result.ledger.totals.reference_index_objects_planned,
        edge_objects: result.ledger.totals.edge_objects,
        quarantine_objects: result.ledger.totals.quarantine_objects
      },
      crud: {
        ok: true,
        local_generation: crud.generation,
        checked_cases: crud.cases.length
      },
      sync: {
        attempted: true,
        generation: backfillGeneration,
        synced_objects: backfillSyncedObjects
      },
      files: semanticFileRefs(result.ledger, "synced"),
      decisions: result.ledger.decisions,
      plaintext_policy: "hash-counts-refs-only"
    }, needles);
    console.log("Living Atlas Logseq semantic ledger backfill recorded without Cloudflare mutation");
    console.log(`authority=${authorityId}; known_generation=${backfillGeneration}; synced_objects=${backfillSyncedObjects}`);
    return;
  }

  if (syncMode === localOnlySyncMode) {
    await appendBatchLedgerRecord(batchLedgerPath, {
      record_schema: "living-atlas-logseq-semantic-batch:v1",
      recorded_at: new Date().toISOString(),
      authority_id: authorityId,
      root_ref: rootRef,
      source_kind: sourceKind,
      source_mode: sourceMode,
      file_offset: fileOffset,
      requested_file_count: fileCount,
      actual_file_count: result.ledger.file_count,
      ledger_id: result.ledger.ledger_id,
      plan_totals: {
        bytes: result.ledger.totals.bytes,
        pages: result.ledger.totals.pages,
        blocks: result.ledger.totals.blocks,
        page_properties: result.ledger.totals.page_properties,
        block_properties: result.ledger.totals.block_properties,
        wikilinks: result.ledger.totals.wikilinks,
        hash_tags: result.ledger.totals.hash_tags,
        block_refs: result.ledger.totals.block_refs,
        edge_candidates: result.ledger.totals.edge_candidates,
        valid_edge_candidates: result.ledger.totals.valid_edge_candidates,
        quarantined_edge_candidates: result.ledger.totals.quarantined_edge_candidates,
        planned_objects: result.ledger.totals.planned_objects,
        page_objects: result.ledger.totals.page_objects,
        block_objects: result.ledger.totals.block_objects,
        reference_index_objects: result.ledger.totals.reference_index_objects_planned,
        edge_objects: result.ledger.totals.edge_objects,
        quarantine_objects: result.ledger.totals.quarantine_objects
      },
      crud: {
        ok: true,
        local_generation: crud.generation,
        checked_cases: crud.cases.length
      },
      sync: {
        attempted: false
      },
      files: semanticFileRefs(result.ledger, "local-verified"),
      decisions: result.ledger.decisions,
      plaintext_policy: "hash-counts-refs-only"
    }, needles);
    console.log(`live_sync=paused; set ${syncModeEnv}=${cloudflareSyncMode} and ${liveAckEnv}=${liveAckValue} to sync semantic ciphertext to Cloudflare`);
    return;
  }

  const syncScope = parseSemanticSyncScope(envValue(syncScopeEnv));
  const scoped = selectSemanticObjectsForSyncScope(result.objects, syncScope);
  const synced = await syncSemanticObjects({
    objects: scoped.objectsToSync,
    needles,
    authorityId
  });
  const totalSyncedObjects = scoped.knownPreviouslySyncedObjects + synced.synced_objects;
  if (totalSyncedObjects !== result.objects.length) {
    throw new Error(`semantic sync scope accounted for ${totalSyncedObjects} objects, expected ${result.objects.length}`);
  }
  await appendBatchLedgerRecord(batchLedgerPath, {
    record_schema: "living-atlas-logseq-semantic-batch:v1",
    recorded_at: new Date().toISOString(),
    authority_id: authorityId,
    root_ref: rootRef,
    source_kind: sourceKind,
    source_mode: sourceMode,
    file_offset: fileOffset,
    requested_file_count: fileCount,
    actual_file_count: result.ledger.file_count,
    ledger_id: result.ledger.ledger_id,
    plan_totals: {
      bytes: result.ledger.totals.bytes,
      pages: result.ledger.totals.pages,
      blocks: result.ledger.totals.blocks,
      page_properties: result.ledger.totals.page_properties,
      block_properties: result.ledger.totals.block_properties,
      wikilinks: result.ledger.totals.wikilinks,
      hash_tags: result.ledger.totals.hash_tags,
      block_refs: result.ledger.totals.block_refs,
      edge_candidates: result.ledger.totals.edge_candidates,
      valid_edge_candidates: result.ledger.totals.valid_edge_candidates,
      quarantined_edge_candidates: result.ledger.totals.quarantined_edge_candidates,
      planned_objects: result.ledger.totals.planned_objects,
      page_objects: result.ledger.totals.page_objects,
      block_objects: result.ledger.totals.block_objects,
      reference_index_objects: result.ledger.totals.reference_index_objects_planned,
      edge_objects: result.ledger.totals.edge_objects,
      quarantine_objects: result.ledger.totals.quarantine_objects
    },
    crud: {
      ok: true,
      local_generation: crud.generation,
      checked_cases: crud.cases.length
    },
      sync: {
        attempted: true,
        generation: synced.generation,
        generations: synced.generations,
        batch_count: synced.batch_count,
        synced_objects: totalSyncedObjects
      },
    files: semanticFileRefs(result.ledger, "synced"),
    decisions: result.ledger.decisions,
    plaintext_policy: "hash-counts-refs-only"
  }, needles);
  console.log("Living Atlas Logseq semantic Cloudflare ciphertext sync passed");
  console.log(`authority=${authorityId}; generation=${synced.generation}; synced_objects=${totalSyncedObjects}; sync_scope=${syncScope}; pushed_objects=${synced.synced_objects}; previously_synced_objects=${scoped.knownPreviouslySyncedObjects}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
