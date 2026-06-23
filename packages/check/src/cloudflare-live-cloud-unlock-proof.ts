import { createHash, randomBytes, webcrypto } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createAtlasClient } from "@living-atlas/atlas-client";
import {
  SyncBatchSchema,
  type GraphObjectEnvelope,
  type SyncBatch
} from "@living-atlas/contracts";
import { CloudUnlockObjectAlgorithm } from "@living-atlas/cloudflare-worker/cloud-unlock";
import { fetchSyncEnvelopes, submitSyncBatch } from "@living-atlas/sync-agent";
import { printCloudflareLiveUsageGateResult, runCloudflareLiveUsageGate } from "./cloudflare-live-usage-gate";

const ackEnv = "LIVING_ATLAS_LIVE_CLOUD_UNLOCK_ACK";
const mutationAcknowledgement = "mutates-deployed-sync-state";
const plaintextBait = "CLOUD_UNLOCK_LIVE_PROOF_SECRET_BAIT_DO_NOT_STORE";
const textEncoder = new TextEncoder();

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

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function bufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function runId(): string {
  return envValue("LIVING_ATLAS_LIVE_RUN_ID") ?? `live_cloud_unlock_${randomBytes(8).toString("hex")}`;
}

function nowIso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function objectAdditionalData(object: GraphObjectEnvelope): Uint8Array {
  return textEncoder.encode([
    "living-atlas-cloud-unlock-object-payload:v1",
    object.authority_id,
    object.object_id,
    object.object_type,
    String(object.version),
    object.access_class,
    object.encryption_class,
    object.key_ref ?? "",
    object.created_at,
    object.updated_at,
    stableJson(object.visible_metadata)
  ].join(":"));
}

async function encryptCloudUnlockObject(input: {
  rawKey: Uint8Array;
  nonce: Uint8Array;
  object: Omit<GraphObjectEnvelope, "content_hash" | "payload">;
  plaintext: Record<string, unknown>;
}): Promise<GraphObjectEnvelope> {
  const draft: GraphObjectEnvelope = {
    ...input.object,
    content_hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    payload: {
      kind: "ciphertext-inline",
      ciphertext: "pending",
      nonce: toBase64(input.nonce),
      algorithm: CloudUnlockObjectAlgorithm
    }
  };
  const key = await webcrypto.subtle.importKey(
    "raw",
    bufferSource(input.rawKey),
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );
  const ciphertext = new Uint8Array(await webcrypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: bufferSource(input.nonce),
      additionalData: bufferSource(objectAdditionalData(draft))
    },
    key,
    bufferSource(textEncoder.encode(JSON.stringify({
      kind: "plaintext-json",
      data: input.plaintext
    })))
  ));
  const ciphertextBase64 = toBase64(ciphertext);
  return {
    ...draft,
    content_hash: sha256(ciphertextBase64),
    payload: {
      kind: "ciphertext-inline",
      ciphertext: ciphertextBase64,
      nonce: toBase64(input.nonce),
      algorithm: CloudUnlockObjectAlgorithm
    }
  };
}

function assertNoText(label: string, value: unknown, forbidden: string[]): void {
  const serialized = JSON.stringify(value);
  for (const text of forbidden) {
    if (text && serialized.includes(text)) {
      throw new Error(`${label} leaked forbidden text`);
    }
  }
}

async function rawMcpCall(input: {
  endpoint: string;
  syncToken: string;
  clientId: string;
  capabilityId?: string;
  tokenId?: string;
  cloudUnlockKey?: string;
  name: string;
  args: unknown;
  id?: number;
}): Promise<unknown> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-living-atlas-sync-token": input.syncToken,
    "x-living-atlas-sync-client-id": input.clientId
  };
  if (input.capabilityId) {
    headers["x-living-atlas-sync-capability-id"] = input.capabilityId;
  }
  if (input.tokenId) {
    headers["x-living-atlas-sync-token-id"] = input.tokenId;
  }
  if (input.cloudUnlockKey) {
    headers["x-living-atlas-cloud-unlock-key"] = input.cloudUnlockKey;
  }
  const response = await fetch(new URL("/mcp", input.endpoint), {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: input.id ?? 1,
      method: "tools/call",
      params: {
        name: input.name,
        arguments: input.args
      }
    })
  });
  return response.json();
}

function structuredContent(response: unknown): Record<string, unknown> {
  if (!response || typeof response !== "object" || !("result" in response)) {
    throw new Error(`invalid MCP response: ${JSON.stringify(response)}`);
  }
  const result = (response as { result?: unknown }).result;
  if (!result || typeof result !== "object" || !("structuredContent" in result)) {
    throw new Error(`MCP response missing structuredContent: ${JSON.stringify(response)}`);
  }
  const content = (result as { structuredContent?: unknown }).structuredContent;
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    throw new Error(`MCP structuredContent was not an object: ${JSON.stringify(response)}`);
  }
  return content as Record<string, unknown>;
}

function makeCloudUnlockBatch(input: {
  object: GraphObjectEnvelope;
  clientId: string;
  capabilityId: string;
  deviceId: string;
  tokenId?: string;
  runId: string;
}): SyncBatch {
  const submittedAt = nowIso();
  return SyncBatchSchema.parse({
    batch_id: `la_sync_batch_${digest(`${input.runId}:cloud-unlock-batch`, 24)}`,
    authority_id: input.object.authority_id,
    device_id: input.deviceId,
    client_id: input.clientId,
    capability_id: input.capabilityId,
    token_id: input.tokenId,
    operation_id: `la_operation_${digest(`${input.runId}:cloud-unlock-operation`, 24)}`,
    trace_id: `la_trace_${digest(`${input.runId}:cloud-unlock-trace`, 24)}`,
    idempotency_key: `la_idem_${digest(`${input.runId}:cloud-unlock-idempotency`, 24)}`,
    submitted_at: submittedAt,
    base_generation: 0,
    target_generation: 1,
    objects: [input.object],
    changes: [
      {
        change_id: `la_change_${digest(`${input.runId}:cloud-unlock-change`, 24)}`,
        authority_id: input.object.authority_id,
        operation_id: `la_operation_${digest(`${input.runId}:cloud-unlock-operation`, 24)}`,
        trace_id: `la_trace_${digest(`${input.runId}:cloud-unlock-trace`, 24)}`,
        recorded_at: submittedAt,
        object_id: input.object.object_id,
        operation: "create",
        base_version: 0,
        new_version: input.object.version,
        content_hash: input.object.content_hash,
        access_class: input.object.access_class,
        generation: 1,
        actor_id: input.clientId
      }
    ],
    withheld_plaintext_count: 1
  });
}

export async function main(): Promise<void> {
  if (process.env[ackEnv] !== mutationAcknowledgement) {
    console.error(`${ackEnv} must equal ${mutationAcknowledgement}`);
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
  const clientId = requireEnv("LIVING_ATLAS_LIVE_SYNC_CLIENT_ID");
  const syncCapabilityId = requireEnv("LIVING_ATLAS_LIVE_SYNC_CAPABILITY_ID");
  const cloudUnlockCapabilityId = requireEnv("LIVING_ATLAS_LIVE_CLOUD_UNLOCK_CAPABILITY_ID");
  const tokenId = envValue("LIVING_ATLAS_LIVE_SYNC_TOKEN_ID");
  const id = runId();
  const authorityId = envValue("LIVING_ATLAS_LIVE_AUTHORITY_ID") ?? `la_authority_liveunlock${digest(id, 18)}`;
  const objectId = `la_object_liveunlock${digest(`${id}:object`, 18)}`;
  const deviceId = envValue("LIVING_ATLAS_LIVE_SYNC_DEVICE_ID") ?? `la_device_liveunlock${digest(clientId, 18)}`;
  const rawKey = randomBytes(32);
  const wrongRawKey = randomBytes(32);
  const unlockKey = toBase64(rawKey);
  const wrongUnlockKey = toBase64(wrongRawKey);
  const visibleMetadata = {
    tombstone: false,
    remote_indexable: false,
    size_class: "tiny" as const,
    schema_namespace: "live-proof/cloud-unlock"
  };
  const encryptedObject = await encryptCloudUnlockObject({
    rawKey,
    nonce: randomBytes(12),
    object: {
      schema_version: 1,
      authority_id: authorityId,
      object_id: objectId,
      object_type: "page",
      version: 1,
      access_class: "local-private",
      encryption_class: "client-encrypted",
      created_at: nowIso(),
      updated_at: nowIso(),
      key_ref: `la_key_liveunlock${digest(`${id}:key`, 18)}`,
      visible_metadata: visibleMetadata
    },
    plaintext: {
      title: "Synthetic cloud unlock proof",
      body: plaintextBait,
      run_id: id
    }
  });
  const batch = makeCloudUnlockBatch({
    object: encryptedObject,
    clientId,
    capabilityId: syncCapabilityId,
    deviceId,
    tokenId,
    runId: id
  });
  assertNoText("cloud-unlock sync batch", batch, [plaintextBait, unlockKey, wrongUnlockKey, syncToken]);

  const submitted = await submitSyncBatch({ endpoint, batch, syncToken });
  if (!submitted.ok) {
    throw new Error(`cloud-unlock sync batch submit failed HTTP ${submitted.status}: ${JSON.stringify(submitted.error)}`);
  }

  const pulled = await fetchSyncEnvelopes({
    endpoint,
    authorityId,
    afterGeneration: 0,
    syncToken,
    clientId,
    capabilityId: syncCapabilityId,
    tokenId
  });
  if (!pulled.ok) {
    throw new Error(`cloud-unlock envelope pull failed HTTP ${pulled.status_code}: ${JSON.stringify(pulled.error)}`);
  }
  assertNoText("cloud-unlock pulled envelope", pulled.response, [plaintextBait, unlockKey, wrongUnlockKey, syncToken]);
  const pulledObject = pulled.response.objects.find((entry) => entry.object.object_id === objectId)?.object;
  if (!pulledObject || pulledObject.payload.kind !== "ciphertext-inline" || pulledObject.payload.algorithm !== CloudUnlockObjectAlgorithm) {
    throw new Error("pulled cloud-unlock object was not ciphertext-inline with the expected algorithm");
  }

  const graphCreate = await rawMcpCall({
    endpoint,
    syncToken,
    clientId,
    capabilityId: syncCapabilityId,
    tokenId,
    id: 20,
    name: "object_create",
    args: { object: encryptedObject }
  });
  if (!JSON.stringify(graphCreate).includes("remote graph objects must be remote-readable plaintext")) {
    throw new Error(`encrypted cloud-unlock object was not rejected by remote graph create: ${JSON.stringify(graphCreate)}`);
  }

  const normalDecrypt = structuredContent(await rawMcpCall({
    endpoint,
    syncToken,
    clientId,
    capabilityId: syncCapabilityId,
    tokenId,
    cloudUnlockKey: unlockKey,
    id: 30,
    name: "sensitive_decrypt",
    args: { authority_id: authorityId, object_id: objectId }
  }));
  if (normalDecrypt.ok !== false || normalDecrypt.reason !== "cloud-unlock-capability-required") {
    throw new Error(`normal remote capability unexpectedly decrypted object: ${JSON.stringify(normalDecrypt)}`);
  }
  assertNoText("normal decrypt denied response", normalDecrypt, [plaintextBait, unlockKey, syncToken]);

  const wrongDecrypt = structuredContent(await rawMcpCall({
    endpoint,
    syncToken,
    clientId,
    capabilityId: cloudUnlockCapabilityId,
    tokenId,
    cloudUnlockKey: wrongUnlockKey,
    id: 40,
    name: "sensitive_decrypt",
    args: { authority_id: authorityId, object_id: objectId }
  }));
  if (wrongDecrypt.ok !== false || wrongDecrypt.reason !== "decrypt-failed") {
    throw new Error(`wrong cloud-unlock key did not fail correctly: ${JSON.stringify(wrongDecrypt)}`);
  }
  assertNoText("wrong-key decrypt response", wrongDecrypt, [plaintextBait, wrongUnlockKey, syncToken]);

  const correctDecrypt = structuredContent(await rawMcpCall({
    endpoint,
    syncToken,
    clientId,
    capabilityId: cloudUnlockCapabilityId,
    tokenId,
    cloudUnlockKey: unlockKey,
    id: 50,
    name: "sensitive_decrypt",
    args: { authority_id: authorityId, object_id: objectId }
  }));
  if (correctDecrypt.ok !== true || correctDecrypt.current_mode !== "cloud-unlock-session") {
    throw new Error(`correct cloud-unlock key did not decrypt: ${JSON.stringify(correctDecrypt)}`);
  }
  if (!JSON.stringify(correctDecrypt).includes(plaintextBait)) {
    throw new Error("correct cloud-unlock response did not contain decrypted plaintext bait");
  }
  assertNoText("correct decrypt response", correctDecrypt, [unlockKey, syncToken]);

  const client = createAtlasClient({
    endpoint,
    syncToken,
    healthToken: envValue("LIVING_ATLAS_LIVE_HEALTH_TOKEN") ?? syncToken,
    clientId,
    capabilityId: syncCapabilityId,
    tokenId
  });
  const audit = await client.callRemoteMcpTool("activity_read", {
    authority_id: authorityId,
    event_type: "object.decrypt",
    limit: 10
  });
  if (audit.ok !== true || !audit.events.some((event: { audit: { event_type: string; mcp_profile: string } }) => event.audit.event_type === "object.decrypt" && event.audit.mcp_profile === "remote-cloud-unlock")) {
    throw new Error(`cloud-unlock decrypt audit event missing: ${JSON.stringify(audit)}`);
  }
  assertNoText("cloud-unlock audit stream", audit, [plaintextBait, unlockKey, wrongUnlockKey, syncToken, encryptedObject.payload.kind === "ciphertext-inline" ? encryptedObject.payload.ciphertext : ""]);

  console.log("Living Atlas live cloud-unlock proof passed");
  console.log(`authority=${authorityId}`);
  console.log(`object=${objectId}; accepted_generation=${submitted.accepted.target_generation}; decrypted_with_transient_key=true; audit_events=${audit.events.length}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
