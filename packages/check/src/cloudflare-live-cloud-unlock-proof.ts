import { createHash, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createAtlasClient } from "@living-atlas/atlas-client";
import {
  SyncBatchSchema,
  type GraphObjectEnvelope,
  type SyncBatch
} from "@living-atlas/contracts";
import {
  CloudUnlockObjectAlgorithm,
  encryptCloudUnlockObject
} from "@living-atlas/cloudflare-worker/cloud-unlock";
import {
  CloudUnlockEscalatedObjectAlgorithm,
  encryptEscalatedCloudUnlockObject
} from "@living-atlas/cloudflare-worker/cloud-unlock-escalated";
import { fetchSyncEnvelopes, submitSyncBatch } from "@living-atlas/sync-agent";
import { printCloudflareLiveUsageGateResult, runCloudflareLiveUsageGate } from "./cloudflare-live-usage-gate";

const ackEnv = "LIVING_ATLAS_LIVE_CLOUD_UNLOCK_ACK";
const mutationAcknowledgement = "mutates-deployed-sync-state";
const plaintextBait = "CLOUD_UNLOCK_LIVE_PROOF_SECRET_BAIT_DO_NOT_STORE";
const escalatedBait = "ESCALATED_LIVE_PROOF_SECRET_BAIT_DO_NOT_STORE";

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

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function runId(): string {
  return envValue("LIVING_ATLAS_LIVE_RUN_ID") ?? `live_cloud_unlock_${randomBytes(8).toString("hex")}`;
}

function nowIso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
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
  escalationKey?: string;
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
  if (input.escalationKey) {
    headers["x-living-atlas-escalation-key"] = input.escalationKey;
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
  objects: GraphObjectEnvelope[];
  clientId: string;
  capabilityId: string;
  deviceId: string;
  tokenId?: string;
  runId: string;
}): SyncBatch {
  const submittedAt = nowIso();
  const firstObject = input.objects[0];
  if (!firstObject) {
    throw new Error("cloud-unlock proof batch requires at least one object");
  }
  return SyncBatchSchema.parse({
    batch_id: `la_sync_batch_${digest(`${input.runId}:cloud-unlock-batch`, 24)}`,
    authority_id: firstObject.authority_id,
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
    objects: input.objects,
    changes: input.objects.map((object, index) => ({
        change_id: `la_change_${digest(`${input.runId}:cloud-unlock-change:${index}`, 24)}`,
        authority_id: object.authority_id,
        operation_id: `la_operation_${digest(`${input.runId}:cloud-unlock-operation`, 24)}`,
        trace_id: `la_trace_${digest(`${input.runId}:cloud-unlock-trace`, 24)}`,
        recorded_at: submittedAt,
        object_id: object.object_id,
        operation: "create",
        base_version: 0,
        new_version: object.version,
        content_hash: object.content_hash,
        access_class: object.access_class,
        generation: 1,
        actor_id: input.clientId
      })),
    withheld_plaintext_count: input.objects.length
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
  const escalatedObjectId = `la_object_liveunlockesc${digest(`${id}:escalated`, 18)}`;
  const deviceId = envValue("LIVING_ATLAS_LIVE_SYNC_DEVICE_ID") ?? `la_device_liveunlock${digest(clientId, 18)}`;
  const unlockKey = toBase64(randomBytes(32));
  const wrongUnlockKey = toBase64(randomBytes(32));
  const escalationKey = toBase64(randomBytes(32));
  const wrongEscalationKey = toBase64(randomBytes(32));
  const visibleMetadata = {
    tombstone: false,
    remote_indexable: false,
    size_class: "tiny" as const,
    schema_namespace: "live-proof/cloud-unlock"
  };
  const encryptedObject = await encryptCloudUnlockObject({
    envelope: {
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
    },
    encodedUnlockKey: unlockKey
  });
  const submittedObject: GraphObjectEnvelope = {
    ...encryptedObject,
    version: encryptedObject.version + 1,
    updated_at: nowIso(1000),
    key_ref: `la_key_liveunlock_rematerialized${digest(`${id}:key`, 12)}`,
    visible_metadata: {
      ...visibleMetadata,
      size_class: "small" as const
    }
  };
  const encryptedEscalatedObject = await encryptEscalatedCloudUnlockObject({
    envelope: {
      schema_version: 1,
      authority_id: authorityId,
      object_id: escalatedObjectId,
      object_type: "page",
      version: 1,
      access_class: "local-private",
      encryption_class: "client-encrypted",
      created_at: nowIso(),
      updated_at: nowIso(),
      key_ref: `la_key_liveunlockesc${digest(`${id}:escalated-key`, 18)}`,
      visible_metadata: visibleMetadata
    },
    plaintext: {
      title: "Synthetic escalated cloud unlock proof",
      body: escalatedBait,
      run_id: id
    },
    encodedEscalationKey: escalationKey
  });
  const submittedEscalatedObject: GraphObjectEnvelope = {
    ...encryptedEscalatedObject,
    version: encryptedEscalatedObject.version + 1,
    updated_at: nowIso(2000),
    key_ref: `la_key_liveunlockesc_rematerialized${digest(`${id}:escalated-key`, 12)}`,
    visible_metadata: {
      ...visibleMetadata,
      size_class: "small" as const
    }
  };
  const batch = makeCloudUnlockBatch({
    objects: [submittedObject, submittedEscalatedObject],
    clientId,
    capabilityId: syncCapabilityId,
    deviceId,
    tokenId,
    runId: id
  });
  assertNoText("cloud-unlock sync batch", batch, [plaintextBait, escalatedBait, unlockKey, wrongUnlockKey, escalationKey, wrongEscalationKey, syncToken]);

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
  assertNoText("cloud-unlock pulled envelope", pulled.response, [plaintextBait, escalatedBait, unlockKey, wrongUnlockKey, escalationKey, wrongEscalationKey, syncToken]);
  const pulledObject = pulled.response.objects.find((entry) => entry.object.object_id === objectId)?.object;
  if (!pulledObject || pulledObject.payload.kind !== "ciphertext-inline" || pulledObject.payload.algorithm !== CloudUnlockObjectAlgorithm) {
    throw new Error("pulled cloud-unlock object was not ciphertext-inline with the expected algorithm");
  }
  const pulledEscalatedObject = pulled.response.objects.find((entry) => entry.object.object_id === escalatedObjectId)?.object;
  if (!pulledEscalatedObject || pulledEscalatedObject.payload.kind !== "ciphertext-inline" || pulledEscalatedObject.payload.algorithm !== CloudUnlockEscalatedObjectAlgorithm) {
    throw new Error("pulled escalated cloud-unlock object was not ciphertext-inline with the expected algorithm");
  }

  const graphCreate = await rawMcpCall({
    endpoint,
    syncToken,
    clientId,
    capabilityId: syncCapabilityId,
    tokenId,
    id: 20,
    name: "object_create",
    args: { object: submittedObject }
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
  assertNoText("normal decrypt denied response", normalDecrypt, [plaintextBait, escalatedBait, unlockKey, escalationKey, syncToken]);

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
  assertNoText("wrong-key decrypt response", wrongDecrypt, [plaintextBait, escalatedBait, wrongUnlockKey, syncToken]);

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
  assertNoText("correct decrypt response", correctDecrypt, [unlockKey, escalationKey, syncToken]);

  const escalationRequired = structuredContent(await rawMcpCall({
    endpoint,
    syncToken,
    clientId,
    capabilityId: cloudUnlockCapabilityId,
    tokenId,
    cloudUnlockKey: unlockKey,
    id: 60,
    name: "sensitive_decrypt",
    args: { authority_id: authorityId, object_id: escalatedObjectId }
  }));
  if (escalationRequired.ok !== false || escalationRequired.reason !== "escalation-required") {
    throw new Error(`escalated object did not require escalation: ${JSON.stringify(escalationRequired)}`);
  }
  assertNoText("escalation-required response", escalationRequired, [plaintextBait, escalatedBait, unlockKey, escalationKey, syncToken]);

  const wrongEscalationDecrypt = structuredContent(await rawMcpCall({
    endpoint,
    syncToken,
    clientId,
    capabilityId: cloudUnlockCapabilityId,
    tokenId,
    cloudUnlockKey: unlockKey,
    escalationKey: wrongEscalationKey,
    id: 70,
    name: "sensitive_decrypt",
    args: { authority_id: authorityId, object_id: escalatedObjectId }
  }));
  if (wrongEscalationDecrypt.ok !== false || wrongEscalationDecrypt.reason !== "decrypt-failed") {
    throw new Error(`wrong escalation key did not fail correctly: ${JSON.stringify(wrongEscalationDecrypt)}`);
  }
  assertNoText("wrong-escalation decrypt response", wrongEscalationDecrypt, [plaintextBait, escalatedBait, unlockKey, wrongEscalationKey, syncToken]);

  const escalatedDecrypt = structuredContent(await rawMcpCall({
    endpoint,
    syncToken,
    clientId,
    capabilityId: cloudUnlockCapabilityId,
    tokenId,
    cloudUnlockKey: unlockKey,
    escalationKey,
    id: 80,
    name: "sensitive_decrypt",
    args: { authority_id: authorityId, object_id: escalatedObjectId }
  }));
  if (escalatedDecrypt.ok !== true || escalatedDecrypt.current_mode !== "cloud-unlock-session" || escalatedDecrypt.tier !== "super-sensitive") {
    throw new Error(`correct escalation key did not decrypt: ${JSON.stringify(escalatedDecrypt)}`);
  }
  if (!JSON.stringify(escalatedDecrypt).includes(escalatedBait)) {
    throw new Error("correct escalated cloud-unlock response did not contain decrypted plaintext bait");
  }
  assertNoText("escalated decrypt response", escalatedDecrypt, [unlockKey, escalationKey, syncToken]);

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
  assertNoText("cloud-unlock audit stream", audit, [
    plaintextBait,
    escalatedBait,
    unlockKey,
    wrongUnlockKey,
    escalationKey,
    wrongEscalationKey,
    syncToken,
    submittedObject.payload.kind === "ciphertext-inline" ? submittedObject.payload.ciphertext : "",
    submittedEscalatedObject.payload.kind === "ciphertext-inline" ? submittedEscalatedObject.payload.ciphertext : ""
  ]);

  console.log("Living Atlas live cloud-unlock proof passed");
  console.log(`authority=${authorityId}`);
  console.log(`object=${objectId}; submitted_version=${submittedObject.version}; escalated_object=${escalatedObjectId}; escalated_submitted_version=${submittedEscalatedObject.version}; accepted_generation=${submitted.accepted.target_generation}; decrypted_with_transient_key=true; escalated_decrypted=true; audit_events=${audit.events.length}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
