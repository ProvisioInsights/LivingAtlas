import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  LocalControlStateSchema,
  type GraphObjectEnvelope,
  type LocalControlState
} from "@living-atlas/contracts";
import { sensitiveBaitRegistry, syntheticGraphObjects } from "@living-atlas/fixtures";
import {
  FileLocalControlStore,
  createFixtureLocalControlState
} from "@living-atlas/local-control-store";
import { FileLocalGraphStore } from "@living-atlas/local-graph-store";
import {
  applyPulledEnvelopes,
  buildCiphertextSyncBatch,
  fetchSyncEnvelopes,
  submitSyncBatch
} from "@living-atlas/sync-agent";
import { printCloudflareLiveUsageGateResult, runCloudflareLiveUsageGate } from "./cloudflare-live-usage-gate";

const localSyncAckEnv = "LIVING_ATLAS_LIVE_LOCAL_SYNC_ACK";
const mutationAcknowledgement = "mutates-deployed-sync-state";

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

function runId(): string {
  return envValue("LIVING_ATLAS_LIVE_RUN_ID") ?? `live_local_sync_${randomBytes(8).toString("hex")}`;
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
  next.authority_id = options.authorityId;
  next.control_plane.authority = {
    ...next.control_plane.authority,
    authority_id: options.authorityId,
    display_name: "Synthetic Live Local Sync Authority"
  };
  next.control_plane.users = next.control_plane.users.map((user) => ({
    ...user,
    authority_id: options.authorityId
  }));
  const originalPrimaryDeviceId = next.control_plane.devices[0]?.device_id;
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

function remapGraphObjects(objects: GraphObjectEnvelope[], authorityId: string, seed: string): GraphObjectEnvelope[] {
  return objects.map((object, index) => ({
    ...object,
    authority_id: authorityId,
    object_id: `la_object_livelocal${digest(`${seed}:${object.object_id}:${index}`, 18)}`,
    key_ref: object.key_ref ? `la_key_livelocal${digest(`${seed}:${object.key_ref}`, 18)}` : undefined
  }));
}

function assertNoSensitiveText(label: string, value: string, secrets: string[]): void {
  for (const secret of secrets) {
    if (value.includes(secret)) {
      throw new Error(`${label} leaked secret material`);
    }
  }

  for (const bait of sensitiveBaitRegistry) {
    if (value.includes(bait.value)) {
      throw new Error(`${label} leaked sensitive bait: ${bait.id}`);
    }
  }
}

export async function main(): Promise<void> {
  if (process.env[localSyncAckEnv] !== mutationAcknowledgement) {
    console.error(`${localSyncAckEnv} must equal ${mutationAcknowledgement}`);
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
  const syncDeviceId = envValue("LIVING_ATLAS_LIVE_SYNC_DEVICE_ID") ?? `la_device_livelocal${digest(syncClientId, 18)}`;
  const syncTokenId = envValue("LIVING_ATLAS_LIVE_SYNC_TOKEN_ID");
  const id = runId();
  const authorityId = envValue("LIVING_ATLAS_LIVE_AUTHORITY_ID") ?? `la_authority_livelocal${digest(id, 18)}`;
  const now = new Date().toISOString();
  const tempDir = await mkdtemp(join(tmpdir(), "living-atlas-live-local-sync-"));
  const controlStorePath = join(tempDir, "control-store.json");
  const graphDir = join(tempDir, "graph");
  const localPassphrase = `local-sync-passphrase-${digest(id, 16)}`;
  const localMcpToken = `local-sync-mcp-token-${digest(`${id}:mcp`, 16)}`;

  try {
    const controlState = remapControlState(await createFixtureLocalControlState(localMcpToken), {
      authorityId,
      syncClientId,
      syncCapabilityId,
      syncDeviceId
    });
    const graphObjects = remapGraphObjects(syntheticGraphObjects, authorityId, id);
    const controlEnvelope = await new FileLocalControlStore(controlStorePath).write(controlState, localPassphrase);
    const serializedControl = JSON.stringify(controlEnvelope);
    assertNoSensitiveText("sealed local control store", serializedControl, [syncToken, localPassphrase, localMcpToken]);

    const batch = buildCiphertextSyncBatch({
      controlState,
      graphObjects,
      syncClientId,
      tokenId: syncTokenId,
      baseGeneration: 0,
      targetGeneration: 1,
      now
    }).batch;
    const serializedBatch = JSON.stringify(batch);
    assertNoSensitiveText("live local sync batch", serializedBatch, [syncToken, localPassphrase, localMcpToken]);
    if (batch.objects.length !== 3 || batch.withheld_plaintext_count !== 3) {
      throw new Error(`expected 3 ciphertext objects and 3 withheld plaintext objects, got ${batch.objects.length}/${batch.withheld_plaintext_count}`);
    }

    const submitted = await submitSyncBatch({ endpoint, batch, syncToken });
    if (!submitted.ok) {
      throw new Error(`live local sync submit failed HTTP ${submitted.status}: ${JSON.stringify(submitted.error)}`);
    }

    const pulled = await fetchSyncEnvelopes({
      endpoint,
      authorityId,
      afterGeneration: 0,
      syncToken,
      clientId: syncClientId,
      capabilityId: syncCapabilityId,
      tokenId: syncTokenId
    });
    if (!pulled.ok) {
      throw new Error(`live local sync envelope pull failed HTTP ${pulled.status_code}: ${JSON.stringify(pulled.error)}`);
    }
    assertNoSensitiveText("live local sync envelope pull", JSON.stringify(pulled.response), [syncToken, localPassphrase, localMcpToken]);

    const store = await FileLocalGraphStore.open({
      directory: graphDir,
      authorityId,
      plaintextPersistence: "redact"
    });
    const applied = await applyPulledEnvelopes({
      store,
      response: pulled.response,
      actorId: syncClientId
    });
    if (!applied.ok || applied.applied_count !== 3 || applied.conflict_count !== 0) {
      throw new Error(`live local sync apply failed: ${JSON.stringify(applied)}`);
    }

    await store.compact();
    const snapshot = await readFile(join(graphDir, "snapshot.json"), "utf8");
    assertNoSensitiveText("redacted local graph snapshot", snapshot, [syncToken, localPassphrase, localMcpToken]);

    console.log("Living Atlas live local sync passed");
    console.log(`authority=${authorityId}`);
    console.log(`accepted_generation=${submitted.accepted.target_generation}; applied=${applied.applied_count}; conflicts=${applied.conflict_count}`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
