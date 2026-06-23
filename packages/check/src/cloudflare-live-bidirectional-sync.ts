import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
  submitSyncBatch
} from "@living-atlas/sync-agent";
import {
  printCloudflareLiveUsageGateResult,
  runCloudflareLiveUsageGate
} from "./cloudflare-live-usage-gate";

const ackEnv = "LIVING_ATLAS_LIVE_BIDIRECTIONAL_SYNC_ACK";
const ackValue = "mutates-deployed-sync-state";
const envFileName = "local-runtime.env";
const cursorFileName = "sync-cursor.json";
const ownerOnlyMode = 0o600;

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
  return join(homedir(), "Library", "Application Support", "LivingAtlas", "personal-prod");
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
    cursorPath: join(rootDir, cursorFileName)
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
  store: FileLocalGraphStore;
  startCursor: SyncPullCursor;
  secrets: RuntimeSecrets;
}): Promise<{
  cursor: SyncPullCursor;
  applied: number;
  skipped: number;
  conflicts: number;
  pulls: number;
}> {
  let cursor = input.startCursor;
  let pulls = 0;
  let applied = 0;
  let skipped = 0;
  let conflicts = 0;

  do {
    const pulled = await fetchSyncEnvelopes({
      endpoint: input.endpoint,
      authorityId: input.authorityId,
      afterGeneration: cursor.generation,
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

  const endpoint = requireEnv("LIVING_ATLAS_LIVE_SYNC_ENDPOINT");
  const syncToken = requireEnv("LIVING_ATLAS_LIVE_SYNC_TOKEN");
  const syncClientId = requireEnv("LIVING_ATLAS_LIVE_SYNC_CLIENT_ID");
  const syncCapabilityId = requireEnv("LIVING_ATLAS_LIVE_SYNC_CAPABILITY_ID");
  const syncTokenId = envValue("LIVING_ATLAS_LIVE_SYNC_TOKEN_ID");
  const authorityId = requireEnv("LIVING_ATLAS_LIVE_AUTHORITY_ID");
  const syncDeviceId = envValue("LIVING_ATLAS_LIVE_SYNC_DEVICE_ID") ?? `la_device_localbidir${digest(syncClientId, 16)}`;
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

  const store = await FileLocalGraphStore.open({
    directory: paths.graphDir,
    authorityId,
    plaintextPersistence: "redact"
  });
  const startingCursor = await readCursor(paths, authorityId);
  const pullBefore = await pullAndApplyAll({
    paths,
    endpoint,
    syncToken,
    syncClientId,
    syncCapabilityId,
    syncTokenId,
    authorityId,
    store,
    startCursor: startingCursor,
    secrets
  });

  const status = await fetchSyncStatus({
    endpoint,
    syncToken,
    clientId: syncClientId,
    capabilityId: syncCapabilityId,
    tokenId: syncTokenId
  });
  if (!status.ok) {
    throw new Error(`sync status failed HTTP ${status.status_code}: ${JSON.stringify(status.error)}`);
  }
  const nextGeneration = nextSyncGenerationFromStatus(status.status);
  if (pullBefore.cursor.generation !== status.status.latest_generation) {
    throw new Error(`local cursor ${pullBefore.cursor.generation} is not caught up to remote ${status.status.latest_generation}`);
  }

  const proofObject = localProofObject(authorityId, `${Date.now()}:${status.status.latest_generation}:${store.status().generation}`);
  const created = await store.createObject({
    object: proofObject,
    expected_generation: store.status().generation,
    actor_id: syncClientId
  });
  if (!created.ok) {
    throw new Error(`local proof create failed: ${created.reason}`);
  }

  const built = buildCiphertextSyncBatch({
    controlState,
    graphObjects: [created.object],
    syncClientId,
    tokenId: syncTokenId,
    baseGeneration: nextGeneration.base_generation,
    targetGeneration: nextGeneration.target_generation,
    now: new Date().toISOString()
  });
  assertNoSecretText("bidirectional sync batch", JSON.stringify(built.batch), {
    ...secrets,
    syncToken
  });
  const submitted = await submitSyncBatch({
    endpoint,
    batch: built.batch,
    syncToken
  });
  if (!submitted.ok) {
    throw new Error(`bidirectional sync push failed HTTP ${submitted.status}: ${JSON.stringify(submitted.error)}`);
  }

  const pullAfter = await pullAndApplyAll({
    paths,
    endpoint,
    syncToken,
    syncClientId,
    syncCapabilityId,
    syncTokenId,
    authorityId,
    store,
    startCursor: pullBefore.cursor,
    secrets
  });
  if (pullAfter.cursor.generation !== submitted.accepted.target_generation) {
    throw new Error(`round-trip cursor ${pullAfter.cursor.generation} did not reach pushed generation ${submitted.accepted.target_generation}`);
  }

  await store.compact();
  const snapshot = await readFile(join(paths.graphDir, "snapshot.json"), "utf8");
  assertNoSecretText("local graph snapshot", snapshot, {
    ...secrets,
    syncToken
  });
  await rm(join(paths.rootDir, ".tmp"), { recursive: true, force: true });

  console.log("Living Atlas live bidirectional sync passed");
  console.log(`replica_dir=${paths.rootDir}`);
  console.log(`remote_generation_before=${status.status.latest_generation}; remote_generation_after=${submitted.accepted.target_generation}`);
  console.log(`pull_before_applied=${pullBefore.applied}; pull_before_skipped=${pullBefore.skipped}; pull_before_conflicts=${pullBefore.conflicts}; pull_before_cursor=${pullBefore.cursor.generation}`);
  console.log(`local_create_object=${created.object.object_id}; local_generation=${store.status().generation}`);
  console.log(`push_synced_objects=${submitted.accepted.accepted_objects}; pull_after_applied=${pullAfter.applied}; pull_after_skipped=${pullAfter.skipped}; pull_after_cursor=${pullAfter.cursor.generation}`);
  console.log(`local_runtime_env=${paths.envPath}; local_cursor=${paths.cursorPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
