import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  GraphObjectEnvelopeSchema,
  LocalControlStateSchema,
  type GraphObjectEnvelope,
  type LocalControlState,
  type SyncPullCursor
} from "@living-atlas/contracts";
import {
  FileLocalControlStore,
  createFixtureLocalControlState
} from "@living-atlas/local-control-store";
import { FileLocalGraphStore } from "@living-atlas/local-graph-store";
import {
  FileLocalKeyringStore,
  createDefaultLocalKeyring
} from "@living-atlas/local-keyring";
import {
  applyPulledEnvelopes,
  buildCiphertextSyncBatch,
  fetchSyncEnvelopes,
  fetchSyncStatus,
  nextSyncGenerationFromStatus,
  runFileOutboxPushHandshake,
  submitSyncBatch,
  type ApplyPulledEnvelopeConflict,
  type FetchSyncEnvelopesOptions,
  type FetchSyncEnvelopesResult,
  type FetchSyncStatusOptions,
  type FetchSyncStatusResult
} from "@living-atlas/sync-agent";
import {
  printCloudflareLiveUsageGateResult,
  runCloudflareLiveUsageGate
} from "./cloudflare-live-usage-gate";

const ackEnv = "LIVING_ATLAS_LIVE_BIDIRECTIONAL_SYNC_ACK";
const ackValue = "mutates-deployed-sync-state";
const envFileName = "local-runtime.env";
const cursorFileName = "sync-cursor.json";
const reportFileName = "sync-report.json";
const ownerOnlyMode = 0o600;
const defaultDaemonCycles = 1;
const maxDaemonCycles = 1000;
const defaultDaemonPollMs = 30_000;
const defaultDaemonBackoffMs = 5_000;
const defaultEnvelopePullLimit = 1;
const defaultReadRetryCount = 3;

type RuntimeSecrets = {
  controlPassphrase: string;
  keyringPassphrase: string;
  localMcpToken: string;
};

type LocalRuntimePaths = {
  rootDir: string;
  controlStorePath: string;
  keyringPath: string;
  graphDir: string;
  activityLogPath: string;
  envPath: string;
  cursorPath: string;
  outboxDir: string;
  reportPath: string;
};

type RuntimeConfig = {
  endpoint: string;
  syncToken: string;
  syncClientId: string;
  syncCapabilityId: string;
  syncTokenId?: string;
  authorityId: string;
  syncDeviceId: string;
  envelopePullLimit: number;
  paths: LocalRuntimePaths;
  secrets: RuntimeSecrets;
  controlState: LocalControlState;
};

type SyncReport = {
  report_schema: "living-atlas-local-sync-report:v1";
  mode: "proof" | "daemon" | "drain";
  authority_id: string;
  recorded_at: string;
  ok: boolean;
  cursor_generation: number;
  local_generation: number;
  applied: number;
  skipped: number;
  conflicts: number;
  pushed_batches: number;
  pushed_objects: number;
  outbox_pending: number;
  conflict_samples: ApplyPulledEnvelopeConflict[];
  last_error?: string;
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

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function digest(value: string, length = 24): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function randomSecret(label: string): string {
  return `la_${label}_${randomBytes(24).toString("hex")}`;
}

function defaultReplicaDir(): string {
  const environmentName = envValue("LIVING_ATLAS_ENV") ?? "default";
  return join(homedir(), "Library", "Application Support", "LivingAtlas", environmentName);
}

function runtimePaths(): LocalRuntimePaths {
  const rootDir = envValue("LIVING_ATLAS_LOCAL_REPLICA_DIR") ?? defaultReplicaDir();
  return {
    rootDir,
    controlStorePath: envValue("LIVING_ATLAS_LOCAL_CONTROL_STORE") ?? join(rootDir, "control-store.json"),
    keyringPath: envValue("LIVING_ATLAS_LOCAL_KEYRING") ?? join(rootDir, "keyring.json"),
    graphDir: envValue("LIVING_ATLAS_LOCAL_GRAPH_DIR") ?? join(rootDir, "graph"),
    activityLogPath: envValue("LIVING_ATLAS_ACTIVITY_LOG") ?? join(rootDir, "activity.jsonl"),
    envPath: join(rootDir, envFileName),
    cursorPath: join(rootDir, cursorFileName),
    outboxDir: envValue("LIVING_ATLAS_LOCAL_SYNC_OUTBOX_DIR") ?? join(rootDir, "outbox"),
    reportPath: join(rootDir, reportFileName)
  };
}

function parseRuntimeEnvFile(value: string): Partial<RuntimeSecrets> {
  const output: Partial<RuntimeSecrets> = {};
  for (const line of value.split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!match) {
      continue;
    }
    const raw = match[2] ?? "";
    const parsed = raw.startsWith("\"") && raw.endsWith("\"")
      ? JSON.parse(raw)
      : raw;
    if (match[1] === "LIVING_ATLAS_LOCAL_CONTROL_STORE_PASSPHRASE") {
      output.controlPassphrase = parsed;
    }
    if (match[1] === "LIVING_ATLAS_LOCAL_KEYRING_PASSPHRASE") {
      output.keyringPassphrase = parsed;
    }
    if (match[1] === "LIVING_ATLAS_LOCAL_MCP_TOKEN") {
      output.localMcpToken = parsed;
    }
  }
  return output;
}

async function readOrCreateRuntimeSecrets(paths: LocalRuntimePaths): Promise<RuntimeSecrets> {
  const fromEnv = {
    controlPassphrase: envValue("LIVING_ATLAS_LOCAL_CONTROL_STORE_PASSPHRASE"),
    keyringPassphrase: envValue("LIVING_ATLAS_LOCAL_KEYRING_PASSPHRASE"),
    localMcpToken: envValue("LIVING_ATLAS_LOCAL_MCP_TOKEN")
  };
  const existing = existsSync(paths.envPath)
    ? parseRuntimeEnvFile(await readFile(paths.envPath, "utf8"))
    : {};
  const secrets = {
    controlPassphrase: fromEnv.controlPassphrase ?? existing.controlPassphrase ?? randomSecret("control"),
    keyringPassphrase: fromEnv.keyringPassphrase ?? existing.keyringPassphrase ?? randomSecret("keyring"),
    localMcpToken: fromEnv.localMcpToken ?? existing.localMcpToken ?? randomSecret("mcp")
  };

  await mkdir(paths.rootDir, { recursive: true });
  const lines = [
    "# Local LivingAtlas runtime secrets. Do not commit.",
    `LIVING_ATLAS_LOCAL_REPLICA_DIR=${JSON.stringify(paths.rootDir)}`,
    `LIVING_ATLAS_LOCAL_CONTROL_STORE=${JSON.stringify(paths.controlStorePath)}`,
    `LIVING_ATLAS_LOCAL_CONTROL_STORE_PASSPHRASE=${JSON.stringify(secrets.controlPassphrase)}`,
    `LIVING_ATLAS_LOCAL_KEYRING=${JSON.stringify(paths.keyringPath)}`,
    `LIVING_ATLAS_LOCAL_KEYRING_PASSPHRASE=${JSON.stringify(secrets.keyringPassphrase)}`,
    `LIVING_ATLAS_LOCAL_GRAPH_DIR=${JSON.stringify(paths.graphDir)}`,
    `LIVING_ATLAS_LOCAL_SYNC_OUTBOX_DIR=${JSON.stringify(paths.outboxDir)}`,
    `LIVING_ATLAS_LOCAL_MCP_TOKEN=${JSON.stringify(secrets.localMcpToken)}`,
    `LIVING_ATLAS_ACTIVITY_LOG=${JSON.stringify(paths.activityLogPath)}`,
    ""
  ];
  await writeFile(paths.envPath, lines.join("\n"), { mode: ownerOnlyMode });
  await chmod(paths.envPath, ownerOnlyMode);
  return secrets;
}

function remapControlState(input: LocalControlState, options: {
  authorityId: string;
  syncClientId: string;
  syncCapabilityId: string;
  syncDeviceId: string;
}): LocalControlState {
  const syncClientIndex = input.control_plane.clients.findIndex((client) => client.allowed_profile === "sync-device");
  const syncCapabilityIndex = input.control_plane.capabilities.findIndex((capability) => capability.profile === "sync-device");
  if (syncClientIndex < 0 || syncCapabilityIndex < 0) {
    throw new Error("fixture control state is missing sync-device records");
  }

  const next = structuredClone(input);
  const originalPrimaryDeviceId = next.control_plane.devices[0]?.device_id;
  next.authority_id = options.authorityId;
  next.control_plane.authority = {
    ...next.control_plane.authority,
    authority_id: options.authorityId,
    display_name: "LivingAtlas Personal Production Local Replica"
  };
  next.control_plane.users = next.control_plane.users.map((user) => ({
    ...user,
    authority_id: options.authorityId
  }));
  next.control_plane.devices = next.control_plane.devices.map((device, index) => ({
    ...device,
    authority_id: options.authorityId,
    device_id: index === 0 ? options.syncDeviceId : device.device_id
  }));
  next.control_plane.clients = next.control_plane.clients.map((client, index) => ({
    ...client,
    authority_id: options.authorityId,
    client_id: index === syncClientIndex ? options.syncClientId : client.client_id,
    device_id: client.device_id === originalPrimaryDeviceId ? options.syncDeviceId : client.device_id
  }));
  next.control_plane.capabilities = next.control_plane.capabilities.map((capability, index) => ({
    ...capability,
    authority_id: options.authorityId,
    capability_id: index === syncCapabilityIndex ? options.syncCapabilityId : capability.capability_id,
    client_id: index === syncCapabilityIndex ? options.syncClientId : capability.client_id
  }));
  next.control_plane.keys = next.control_plane.keys.map((key) => ({
    ...key,
    authority_id: options.authorityId
  }));

  return LocalControlStateSchema.parse(next);
}

async function ensureLocalStores(input: {
  paths: LocalRuntimePaths;
  secrets: RuntimeSecrets;
  authorityId: string;
  controlState: LocalControlState;
}): Promise<void> {
  await mkdir(input.paths.rootDir, { recursive: true });
  await mkdir(input.paths.graphDir, { recursive: true });
  await mkdir(input.paths.outboxDir, { recursive: true });
  if (!existsSync(input.paths.controlStorePath)) {
    await new FileLocalControlStore(input.paths.controlStorePath).write(input.controlState, input.secrets.controlPassphrase);
  }
  if (!existsSync(input.paths.keyringPath)) {
    const keyring = createDefaultLocalKeyring({
      authorityId: input.authorityId,
      createdAt: new Date().toISOString()
    });
    await new FileLocalKeyringStore(input.paths.keyringPath).write(keyring, input.secrets.keyringPassphrase);
  }
}

async function readCursor(paths: LocalRuntimePaths, authorityId: string): Promise<SyncPullCursor> {
  if (!existsSync(paths.cursorPath)) {
    return {
      authority_id: authorityId,
      generation: 0
    };
  }
  const parsed = JSON.parse(await readFile(paths.cursorPath, "utf8")) as SyncPullCursor;
  if (parsed.authority_id !== authorityId) {
    throw new Error("local sync cursor authority mismatch");
  }
  return parsed;
}

async function writeCursor(paths: LocalRuntimePaths, cursor: SyncPullCursor): Promise<void> {
  await writeFile(paths.cursorPath, `${JSON.stringify(cursor, null, 2)}\n`, { mode: ownerOnlyMode });
  await chmod(paths.cursorPath, ownerOnlyMode);
}

async function writeReport(paths: LocalRuntimePaths, report: SyncReport): Promise<void> {
  await writeFile(paths.reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: ownerOnlyMode });
  await chmod(paths.reportPath, ownerOnlyMode);
}

function assertNoSecretText(label: string, value: string, secrets: RuntimeSecrets & { syncToken: string }): void {
  for (const secret of [secrets.controlPassphrase, secrets.keyringPassphrase, secrets.localMcpToken, secrets.syncToken]) {
    if (value.includes(secret)) {
      throw new Error(`${label} leaked secret material`);
    }
  }
}

async function pullAndApplyAll(input: {
  paths: LocalRuntimePaths;
  endpoint: string;
  syncToken: string;
  syncClientId: string;
  syncCapabilityId: string;
  syncTokenId?: string;
  authorityId: string;
  envelopePullLimit: number;
  store: FileLocalGraphStore;
  startCursor: SyncPullCursor;
  secrets: RuntimeSecrets;
}): Promise<{
  cursor: SyncPullCursor;
  applied: number;
  skipped: number;
  conflicts: number;
  conflictSamples: ApplyPulledEnvelopeConflict[];
  pulls: number;
}> {
  let cursor = input.startCursor;
  let pulls = 0;
  let applied = 0;
  let skipped = 0;
  let conflicts = 0;
  const conflictSamples: ApplyPulledEnvelopeConflict[] = [];

  do {
    const pulled = await fetchSyncEnvelopesWithRetry({
      endpoint: input.endpoint,
      authorityId: input.authorityId,
      afterGeneration: cursor.generation,
      limit: input.envelopePullLimit,
      syncToken: input.syncToken,
      clientId: input.syncClientId,
      capabilityId: input.syncCapabilityId,
      tokenId: input.syncTokenId
    });
    if (!pulled.ok) {
      throw new Error(`sync envelope pull failed HTTP ${pulled.status_code}: ${JSON.stringify(pulled.error)}`);
    }
    assertNoSecretText("sync envelope pull", JSON.stringify(pulled.response), {
      ...input.secrets,
      syncToken: input.syncToken
    });
    pulls += 1;
    const result = await applyPulledEnvelopes({
      store: input.store,
      response: pulled.response,
      actorId: input.syncClientId
    });
    applied += result.applied_count;
    skipped += result.skipped_count;
    conflicts += result.conflict_count;
    conflictSamples.push(...result.conflicts.slice(0, Math.max(0, 10 - conflictSamples.length)));
    if (!result.ok) {
      throw new Error(`local apply failed: ${JSON.stringify(result.conflicts)}`);
    }
    cursor = result.cursor;
    await writeCursor(input.paths, cursor);
    if (!pulled.response.has_more) {
      break;
    }
  } while (true);

  return {
    cursor,
    applied,
    skipped,
    conflicts,
    conflictSamples,
    pulls
  };
}

function localProofObject(authorityId: string, seed: string): GraphObjectEnvelope {
  const objectId = `la_object_localbidir${digest(seed, 16)}`;
  const nonce = randomBytes(12).toString("base64");
  const ciphertext = Buffer.from(`living-atlas-local-bidirectional-proof:${seed}`).toString("base64");
  const contentHash = sha256(`${nonce}:${ciphertext}`);
  const now = new Date().toISOString();
  return GraphObjectEnvelopeSchema.parse({
    schema_version: 1,
    authority_id: authorityId,
    object_id: objectId,
    object_type: "page",
    version: 1,
    access_class: "local-private",
    encryption_class: "client-encrypted",
    created_at: now,
    updated_at: now,
    content_hash: contentHash,
    key_ref: `la_key_localbidir${digest(`${seed}:key`, 16)}`,
    visible_metadata: {
      schema_namespace: "sync/local-bidirectional-proof",
      tombstone: false,
      size_class: "tiny",
      remote_indexable: false
    },
    payload: {
      kind: "ciphertext-inline",
      ciphertext,
      nonce,
      algorithm: "aes-256-gcm"
    }
  });
}

function parseIntegerEnv(key: string, fallback: number, min: number, max: number): number {
  const value = envValue(key);
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${key} must be an integer from ${min} to ${max}`);
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
  const retries = parseIntegerEnv("LIVING_ATLAS_LIVE_SYNC_READ_RETRIES", defaultReadRetryCount, 0, 10);
  let result = await fetchSyncStatus(options);
  for (let attempt = 1; !result.ok && isTransientReadStatus(result.status_code) && attempt <= retries; attempt += 1) {
    const delayMs = 500 * attempt;
    console.warn(`live sync status read returned HTTP ${result.status_code}; retry ${attempt}/${retries} in ${delayMs}ms`);
    await sleep(delayMs);
    result = await fetchSyncStatus(options);
  }
  return result;
}

async function fetchSyncEnvelopesWithRetry(options: FetchSyncEnvelopesOptions): Promise<FetchSyncEnvelopesResult> {
  const retries = parseIntegerEnv("LIVING_ATLAS_LIVE_SYNC_READ_RETRIES", defaultReadRetryCount, 0, 10);
  let result = await fetchSyncEnvelopes(options);
  for (let attempt = 1; !result.ok && isTransientReadStatus(result.status_code) && attempt <= retries; attempt += 1) {
    const delayMs = 500 * attempt;
    console.warn(`live sync envelope pull returned HTTP ${result.status_code}; retry ${attempt}/${retries} in ${delayMs}ms`);
    await sleep(delayMs);
    result = await fetchSyncEnvelopes(options);
  }
  return result;
}

async function createRuntimeConfig(): Promise<RuntimeConfig> {
  const endpoint = requireEnv("LIVING_ATLAS_LIVE_SYNC_ENDPOINT");
  const syncToken = requireEnv("LIVING_ATLAS_LIVE_SYNC_TOKEN");
  const syncClientId = requireEnv("LIVING_ATLAS_LIVE_SYNC_CLIENT_ID");
  const syncCapabilityId = requireEnv("LIVING_ATLAS_LIVE_SYNC_CAPABILITY_ID");
  const syncTokenId = envValue("LIVING_ATLAS_LIVE_SYNC_TOKEN_ID");
  const authorityId = requireEnv("LIVING_ATLAS_LIVE_AUTHORITY_ID");
  const syncDeviceId = envValue("LIVING_ATLAS_LIVE_SYNC_DEVICE_ID") ?? `la_device_localbidir${digest(syncClientId, 16)}`;
  const envelopePullLimit = parseIntegerEnv("LIVING_ATLAS_LIVE_SYNC_ENVELOPE_PULL_LIMIT", defaultEnvelopePullLimit, 1, 50);
  const paths = runtimePaths();
  const secrets = await readOrCreateRuntimeSecrets(paths);
  const controlState = remapControlState(await createFixtureLocalControlState(secrets.localMcpToken), {
    authorityId,
    syncClientId,
    syncCapabilityId,
    syncDeviceId
  });
  await ensureLocalStores({
    paths,
    secrets,
    authorityId,
    controlState
  });
  return {
    endpoint,
    syncToken,
    syncClientId,
    syncCapabilityId,
    syncTokenId,
    authorityId,
    syncDeviceId,
    envelopePullLimit,
    paths,
    secrets,
    controlState
  };
}

async function queuedOutboxFiles(paths: LocalRuntimePaths): Promise<string[]> {
  await mkdir(paths.outboxDir, { recursive: true });
  const entries = await readdir(paths.outboxDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && !entry.name.includes(".accepted.") && !entry.name.includes(".failed."))
    .map((entry) => join(paths.outboxDir, entry.name))
    .sort();
}

async function writeProofOutboxObject(config: RuntimeConfig, store: FileLocalGraphStore): Promise<string> {
  const object = localProofObject(config.authorityId, `${Date.now()}:${store.status().generation}:daemon-proof`);
  const filePath = join(config.paths.outboxDir, `queued-${Date.now()}-${digest(object.object_id, 12)}.json`);
  await writeFile(filePath, `${JSON.stringify({ objects: [object] }, null, 2)}\n`, { mode: ownerOnlyMode });
  await chmod(filePath, ownerOnlyMode);
  return filePath;
}

async function runImmediateDrain(config: RuntimeConfig, mode: "daemon" | "drain"): Promise<{
  cursor: SyncPullCursor;
  localGeneration: number;
  applied: number;
  skipped: number;
  conflicts: number;
  conflictSamples: ApplyPulledEnvelopeConflict[];
  pushedBatches: number;
  pushedObjects: number;
  outboxPending: number;
}> {
  const store = await FileLocalGraphStore.open({
    directory: config.paths.graphDir,
    authorityId: config.authorityId,
    plaintextPersistence: "redact"
  });
  const cursor = await readCursor(config.paths, config.authorityId);
  const result = await runFileOutboxPushHandshake({
    outboxDir: config.paths.outboxDir,
    store,
    controlState: config.controlState,
    cursor,
    endpoint: config.endpoint,
    syncToken: config.syncToken,
    syncClientId: config.syncClientId,
    tokenId: config.syncTokenId
  });
  await writeCursor(config.paths, result.cursor);
  await store.compact();
  const localGeneration = store.status().generation;
  await writeReport(config.paths, {
    report_schema: "living-atlas-local-sync-report:v1",
    mode,
    authority_id: config.authorityId,
    recorded_at: new Date().toISOString(),
    ok: result.ok,
    cursor_generation: result.cursor.generation,
    local_generation: localGeneration,
    applied: result.applied,
    skipped: result.skipped,
    conflicts: result.conflicts,
    conflict_samples: result.conflict_samples,
    pushed_batches: result.pushed_batches,
    pushed_objects: result.pushed_objects,
    outbox_pending: result.outbox_pending,
    ...(!result.ok ? { last_error: result.reason } : {})
  });

  if (!result.ok) {
    throw new Error(`local outbox push handshake failed: ${result.reason}${result.error ? ` ${JSON.stringify(result.error)}` : ""}`);
  }

  return {
    cursor: result.cursor,
    localGeneration,
    applied: result.applied,
    skipped: result.skipped,
    conflicts: result.conflicts,
    conflictSamples: result.conflict_samples,
    pushedBatches: result.pushed_batches,
    pushedObjects: result.pushed_objects,
    outboxPending: result.outbox_pending
  };
}

async function runDaemonMode(config: RuntimeConfig): Promise<void> {
  const cycles = parseIntegerEnv("LIVING_ATLAS_LIVE_SYNC_DAEMON_CYCLES", defaultDaemonCycles, 1, maxDaemonCycles);
  const pollMs = parseIntegerEnv("LIVING_ATLAS_LIVE_SYNC_DAEMON_POLL_MS", defaultDaemonPollMs, 100, 3_600_000);
  const backoffMs = parseIntegerEnv("LIVING_ATLAS_LIVE_SYNC_DAEMON_BACKOFF_MS", defaultDaemonBackoffMs, 100, 3_600_000);
  const queueProof = envValue("LIVING_ATLAS_LIVE_SYNC_DAEMON_QUEUE_PROOF") === "1";
  let cursor = await readCursor(config.paths, config.authorityId);
  let applied = 0;
  let skipped = 0;
  let conflicts = 0;
  const conflictSamples: ApplyPulledEnvelopeConflict[] = [];
  let pushedBatches = 0;
  let pushedObjects = 0;
  let localGeneration = 0;
  let proofQueued = false;
  let lastError: string | undefined;

  for (let cycle = 1; cycle <= cycles; cycle += 1) {
    try {
      if (queueProof && !proofQueued) {
        const store = await FileLocalGraphStore.open({
          directory: config.paths.graphDir,
          authorityId: config.authorityId,
          plaintextPersistence: "redact"
        });
        await writeProofOutboxObject(config, store);
        proofQueued = true;
      }

      const drained = await runImmediateDrain(config, "daemon");
      cursor = drained.cursor;
      localGeneration = drained.localGeneration;
      applied += drained.applied;
      skipped += drained.skipped;
      conflicts += drained.conflicts;
      pushedBatches += drained.pushedBatches;
      pushedObjects += drained.pushedObjects;
      conflictSamples.push(...drained.conflictSamples.slice(0, Math.max(0, 10 - conflictSamples.length)));
      lastError = undefined;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await sleep(backoffMs);
    }

    const pending = (await queuedOutboxFiles(config.paths)).length;
    await writeReport(config.paths, {
      report_schema: "living-atlas-local-sync-report:v1",
      mode: "daemon",
      authority_id: config.authorityId,
      recorded_at: new Date().toISOString(),
      ok: lastError === undefined,
      cursor_generation: cursor.generation,
      local_generation: localGeneration,
      applied,
      skipped,
      conflicts,
      conflict_samples: conflictSamples,
      pushed_batches: pushedBatches,
      pushed_objects: pushedObjects,
      outbox_pending: pending,
      ...(lastError ? { last_error: lastError } : {})
    });

    if (cycle < cycles) {
      await sleep(lastError ? backoffMs : pollMs);
    }
  }

  if (lastError) {
    throw new Error(lastError);
  }

  console.log("Living Atlas live sync daemon cycle passed");
  console.log(`replica_dir=${config.paths.rootDir}`);
  console.log(`cursor=${cursor.generation}; local_generation=${localGeneration}; applied=${applied}; skipped=${skipped}; conflicts=${conflicts}`);
  console.log(`pushed_batches=${pushedBatches}; pushed_objects=${pushedObjects}; outbox_pending=${(await queuedOutboxFiles(config.paths)).length}`);
  console.log(`sync_report=${config.paths.reportPath}; outbox=${config.paths.outboxDir}`);
}

async function runDrainMode(config: RuntimeConfig): Promise<void> {
  const drained = await runImmediateDrain(config, "drain");
  console.log("Living Atlas live local outbox drain passed");
  console.log(`replica_dir=${config.paths.rootDir}`);
  console.log(`cursor=${drained.cursor.generation}; local_generation=${drained.localGeneration}; applied=${drained.applied}; skipped=${drained.skipped}; conflicts=${drained.conflicts}`);
  console.log(`pushed_batches=${drained.pushedBatches}; pushed_objects=${drained.pushedObjects}; outbox_pending=${drained.outboxPending}`);
  console.log(`sync_report=${config.paths.reportPath}; outbox=${config.paths.outboxDir}`);
}

async function main(): Promise<void> {
  if (envValue(ackEnv) !== ackValue) {
    console.error(`${ackEnv} must equal ${ackValue}`);
    process.exitCode = 2;
    return;
  }

  const gate = await runCloudflareLiveUsageGate();
  printCloudflareLiveUsageGateResult(gate);
  if (!gate.ok) {
    process.exitCode = 2;
    return;
  }

  const config = await createRuntimeConfig();

  const syncMode = envValue("LIVING_ATLAS_LIVE_BIDIRECTIONAL_SYNC_MODE");
  if (syncMode === "daemon") {
    await runDaemonMode(config);
    return;
  }
  if (syncMode === "drain") {
    await runDrainMode(config);
    return;
  }

  const store = await FileLocalGraphStore.open({
    directory: config.paths.graphDir,
    authorityId: config.authorityId,
    plaintextPersistence: "redact"
  });
  const startingCursor = await readCursor(config.paths, config.authorityId);
  const pullBefore = await pullAndApplyAll({
    paths: config.paths,
    endpoint: config.endpoint,
    syncToken: config.syncToken,
    syncClientId: config.syncClientId,
    syncCapabilityId: config.syncCapabilityId,
    syncTokenId: config.syncTokenId,
    authorityId: config.authorityId,
    envelopePullLimit: config.envelopePullLimit,
    store,
    startCursor: startingCursor,
    secrets: config.secrets
  });

  const status = await fetchSyncStatusWithRetry({
    endpoint: config.endpoint,
    syncToken: config.syncToken,
    clientId: config.syncClientId,
    capabilityId: config.syncCapabilityId,
    tokenId: config.syncTokenId
  });
  if (!status.ok) {
    throw new Error(`sync status failed HTTP ${status.status_code}: ${JSON.stringify(status.error)}`);
  }
  const nextGeneration = nextSyncGenerationFromStatus(status.status);
  if (pullBefore.cursor.generation !== status.status.latest_generation) {
    throw new Error(`local cursor ${pullBefore.cursor.generation} is not caught up to remote ${status.status.latest_generation}`);
  }

  const proofObject = localProofObject(config.authorityId, `${Date.now()}:${status.status.latest_generation}:${store.status().generation}`);
  const created = await store.createObject({
    object: proofObject,
    expected_generation: store.status().generation,
    actor_id: config.syncClientId
  });
  if (!created.ok) {
    throw new Error(`local proof create failed: ${created.reason}`);
  }

  const built = buildCiphertextSyncBatch({
    controlState: config.controlState,
    graphObjects: [created.object],
    syncClientId: config.syncClientId,
    tokenId: config.syncTokenId,
    baseGeneration: nextGeneration.base_generation,
    targetGeneration: nextGeneration.target_generation,
    now: new Date().toISOString()
  });
  assertNoSecretText("bidirectional sync batch", JSON.stringify(built.batch), {
    ...config.secrets,
    syncToken: config.syncToken
  });
  const submitted = await submitSyncBatch({
    endpoint: config.endpoint,
    batch: built.batch,
    syncToken: config.syncToken
  });
  if (!submitted.ok) {
    throw new Error(`bidirectional sync push failed HTTP ${submitted.status}: ${JSON.stringify(submitted.error)}`);
  }

  const pullAfter = await pullAndApplyAll({
    paths: config.paths,
    endpoint: config.endpoint,
    syncToken: config.syncToken,
    syncClientId: config.syncClientId,
    syncCapabilityId: config.syncCapabilityId,
    syncTokenId: config.syncTokenId,
    authorityId: config.authorityId,
    envelopePullLimit: config.envelopePullLimit,
    store,
    startCursor: pullBefore.cursor,
    secrets: config.secrets
  });
  if (pullAfter.cursor.generation !== submitted.accepted.target_generation) {
    throw new Error(`round-trip cursor ${pullAfter.cursor.generation} did not reach pushed generation ${submitted.accepted.target_generation}`);
  }

  await store.compact();
  const snapshot = await readFile(join(config.paths.graphDir, "snapshot.json"), "utf8");
  assertNoSecretText("local graph snapshot", snapshot, {
    ...config.secrets,
    syncToken: config.syncToken
  });
  await rm(join(config.paths.rootDir, ".tmp"), { recursive: true, force: true });
  await writeReport(config.paths, {
    report_schema: "living-atlas-local-sync-report:v1",
    mode: "proof",
    authority_id: config.authorityId,
    recorded_at: new Date().toISOString(),
    ok: true,
    cursor_generation: pullAfter.cursor.generation,
    local_generation: store.status().generation,
    applied: pullBefore.applied + pullAfter.applied,
    skipped: pullBefore.skipped + pullAfter.skipped,
    conflicts: pullBefore.conflicts + pullAfter.conflicts,
    conflict_samples: [...pullBefore.conflictSamples, ...pullAfter.conflictSamples].slice(0, 10),
    pushed_batches: 1,
    pushed_objects: submitted.accepted.accepted_objects,
    outbox_pending: (await queuedOutboxFiles(config.paths)).length
  });

  console.log("Living Atlas live bidirectional sync passed");
  console.log(`replica_dir=${config.paths.rootDir}`);
  console.log(`remote_generation_before=${status.status.latest_generation}; remote_generation_after=${submitted.accepted.target_generation}`);
  console.log(`pull_before_applied=${pullBefore.applied}; pull_before_skipped=${pullBefore.skipped}; pull_before_conflicts=${pullBefore.conflicts}; pull_before_cursor=${pullBefore.cursor.generation}`);
  console.log(`object_create=${created.object.object_id}; local_generation=${store.status().generation}`);
  console.log(`push_synced_objects=${submitted.accepted.accepted_objects}; pull_after_applied=${pullAfter.applied}; pull_after_skipped=${pullAfter.skipped}; pull_after_cursor=${pullAfter.cursor.generation}`);
  console.log(`local_runtime_env=${config.paths.envPath}; local_cursor=${config.paths.cursorPath}; sync_report=${config.paths.reportPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
