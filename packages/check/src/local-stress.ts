import { createHash } from "node:crypto";
import type { GraphObjectEnvelope, SyncBatch } from "@living-atlas/contracts";
import { fixtureAuthorityId, fixtureDeviceId, fixtureUserId, sensitiveBaitRegistry } from "@living-atlas/fixtures";
import { createFixtureLocalControlState } from "@living-atlas/local-control-store";
import {
  InMemoryLocalMcpActivitySink,
  InMemoryLocalMcpAuditSink,
  createLocalMcpContextFromControlState,
  localCreateObject,
  localGraphStatus,
  localListObjects,
  localReadObject,
  localTombstoneObject,
  localUpdateObject
} from "@living-atlas/local-mcp";
import {
  SyntheticLocalSyncDaemon,
  buildCiphertextSyncBatch,
  submitSyncBatch
} from "@living-atlas/sync-agent";
import { BootstrapClaimLockCore, InMemoryBootstrapClaimLockStorage } from "../../cloudflare-worker/src/bootstrap-lock";
import { sha256TokenHash } from "../../cloudflare-worker/src/bootstrap";
import type { BootstrapWorkerEnv } from "../../cloudflare-worker/src/worker";
import { LocalD1Database, LocalR2Bucket, createWorkerFetch } from "./local-worker-harness";

type JsonObject = Record<string, unknown>;

const baseUrl = "https://living-atlas.local";
const localMcpToken = "synthetic-local-stress-mcp-token-0001";
const syncToken = "synthetic-local-stress-sync-token-0001";
const syncTokenId = "la_sync_token_stress0001";
const bootstrapToken = "synthetic-local-stress-bootstrap-token-0001";
const now = "2026-06-22T13:00:00.000Z";
const localObjectCount = 300;
const syncGenerationCount = 40;
const syncCiphertextObjectsPerGeneration = 4;
const syncPlaintextObjectsPerGeneration = 2;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function fixedHash(seed: string): `sha256:${string}` {
  return sha256(`living-atlas-local-stress:${seed}`);
}

function isoAtSecond(secondOffset: number): string {
  return new Date(Date.parse(now) + secondOffset * 1000).toISOString();
}

function opaqueR2Path(seed: string): string {
  const authority = createHash("sha256").update(`${seed}:authority`).digest("hex").slice(0, 16);
  const segment = createHash("sha256").update(`${seed}:segment`).digest("hex").slice(0, 40);
  return `objects/a=${authority}/p=${segment.slice(0, 2)}/s=${segment}.bin`;
}

function localPlaintextObject(index: number): GraphObjectEnvelope {
  const objectId = `la_object_stresslocal${index.toString().padStart(4, "0")}`;
  return {
    schema_version: 1,
    authority_id: fixtureAuthorityId,
    object_id: objectId,
    object_type: "page",
    version: 1,
    access_class: "remote-safe",
    encryption_class: "plaintext",
    created_at: now,
    updated_at: now,
    content_hash: fixedHash(`${objectId}:v1`),
    visible_metadata: {
      schema_namespace: "synthetic/local-stress",
      tombstone: false,
      size_class: index % 5 === 0 ? "small" : "tiny",
      remote_indexable: true
    },
    payload: {
      kind: "plaintext-json",
      data: {
        title: `Synthetic stress local object ${index}`,
        body: `Synthetic CRUD stress payload ${index}.`
      }
    }
  };
}

function syncCiphertextObject(generation: number, index: number): GraphObjectEnvelope {
  const objectId = `la_object_stresssync${generation.toString().padStart(3, "0")}${index.toString().padStart(3, "0")}`;
  const ciphertextHash = fixedHash(`${objectId}:ciphertext`);
  return {
    schema_version: 1,
    authority_id: fixtureAuthorityId,
    object_id: objectId,
    object_type: index % 3 === 0 ? "edge" : "page",
    version: 1,
    access_class: "local-private",
    encryption_class: "client-encrypted",
    created_at: isoAtSecond(generation),
    updated_at: isoAtSecond(generation),
    content_hash: ciphertextHash,
    key_ref: "la_key_stresssync0001",
    visible_metadata: {
      schema_namespace: "synthetic/sync-stress",
      tombstone: false,
      size_class: "small",
      remote_indexable: false
    },
    payload: {
      kind: "ciphertext-ref",
      storage: "r2",
      path: opaqueR2Path(objectId),
      ciphertext_hash: ciphertextHash,
      byte_size: 2048 + index,
      algorithm: "xchacha20-poly1305"
    }
  };
}

function syncPlaintextObject(generation: number, index: number): GraphObjectEnvelope {
  const objectId = `la_object_stressplain${generation.toString().padStart(3, "0")}${index.toString().padStart(3, "0")}`;
  return {
    schema_version: 1,
    authority_id: fixtureAuthorityId,
    object_id: objectId,
    object_type: "page",
    version: 1,
    access_class: "remote-safe",
    encryption_class: "plaintext",
    created_at: isoAtSecond(generation),
    updated_at: isoAtSecond(generation),
    content_hash: fixedHash(`${objectId}:plaintext`),
    visible_metadata: {
      schema_namespace: "synthetic/sync-stress-plaintext",
      tombstone: false,
      size_class: "tiny",
      remote_indexable: true
    },
    payload: {
      kind: "plaintext-json",
      data: {
        title: `Synthetic withheld sync plaintext ${generation}-${index}`,
        body: "Plaintext projections are intentionally withheld from ciphertext sync batches."
      }
    }
  };
}

function syncGenerationObjects(generation: number): GraphObjectEnvelope[] {
  return [
    ...Array.from({ length: syncCiphertextObjectsPerGeneration }, (_, index) => syncCiphertextObject(generation, index + 1)),
    ...Array.from({ length: syncPlaintextObjectsPerGeneration }, (_, index) => syncPlaintextObject(generation, index + 1))
  ];
}

function assertNoLeak(label: string, value: string): void {
  for (const secret of [localMcpToken, syncToken, bootstrapToken]) {
    assert(!value.includes(secret), `${label} leaked secret material`);
  }

  for (const bait of sensitiveBaitRegistry) {
    assert(!value.includes(bait.value), `${label} leaked sensitive bait: ${bait.id}`);
  }
}

async function expectWorkerJson<T extends JsonObject>(
  label: string,
  response: Response,
  expectedStatus: number,
  outputs: string[]
): Promise<T> {
  const text = await response.text();
  outputs.push(text);
  assert(response.status === expectedStatus, `${label} expected HTTP ${expectedStatus}, got ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}

function syncHeaders(input: {
  token?: string;
  clientId?: string;
  capabilityId?: string;
  tokenId?: string;
  contentType?: boolean;
}): Record<string, string> {
  return {
    ...(input.contentType === false ? {} : { "content-type": "application/json" }),
    ...(input.token ? { "x-living-atlas-sync-token": input.token } : {}),
    ...(input.clientId ? { "x-living-atlas-sync-client-id": input.clientId } : {}),
    ...(input.capabilityId ? { "x-living-atlas-sync-capability-id": input.capabilityId } : {}),
    ...(input.tokenId ? { "x-living-atlas-sync-token-id": input.tokenId } : {})
  };
}

function mutateBatchHash(batch: SyncBatch): SyncBatch {
  return {
    ...batch,
    batch_hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000"
  };
}

async function exerciseLocalCrudStress(outputs: string[]): Promise<void> {
  const auditSink = new InMemoryLocalMcpAuditSink();
  const activitySink = new InMemoryLocalMcpActivitySink();
  const controlState = await createFixtureLocalControlState(localMcpToken);
  const context = createLocalMcpContextFromControlState({
    controlState,
    auditSink,
    activitySink,
    now,
    syntheticStoreLimits: {
      maxObjects: localObjectCount + 6,
      maxEnvelopeBytes: 8 * 1024
    }
  });
  const authorization = `Bearer ${localMcpToken}`;

  const initial = await localGraphStatus(context, { authorization });
  assert(initial.ok && initial.result.object_count === 6, "local stress should start with six fixture objects");

  for (let index = 1; index <= localObjectCount; index += 1) {
    const result = await localCreateObject(context, {
      authorization,
      object: localPlaintextObject(index)
    });
    assert(result.ok, `local stress create ${index} failed: ${result.ok ? "" : result.reason}`);
    assert(result.result.new_version === 1, `local stress create ${index} returned wrong version`);
  }

  const duplicate = await localCreateObject(context, {
    authorization,
    object: localPlaintextObject(1)
  });
  assert(!duplicate.ok && duplicate.reason === "object-already-exists", "local stress duplicate create did not fail correctly");

  const full = await localCreateObject(context, {
    authorization,
    object: localPlaintextObject(localObjectCount + 1)
  });
  assert(!full.ok && full.reason === "synthetic-store-full", "local stress did not enforce synthetic store limit");

  for (let index = 1; index <= localObjectCount; index += 1) {
    const objectId = `la_object_stresslocal${index.toString().padStart(4, "0")}`;
    const update = await localUpdateObject(context, {
      authorization,
      object_id: objectId,
      expected_version: 1,
      patch: {
        content_hash: fixedHash(`${objectId}:v2`),
        visible_metadata: {
          size_class: index % 7 === 0 ? "medium" : "small"
        },
        payload: {
          kind: "plaintext-json",
          data: {
            title: `Synthetic stress local object ${index} revised`,
            body: `Synthetic CRUD stress update payload ${index}.`
          }
        }
      }
    });
    assert(update.ok, `local stress update ${index} failed: ${update.ok ? "" : update.reason}`);
    assert(update.result.previous_version === 1 && update.result.new_version === 2, `local stress update ${index} version mismatch`);
  }

  const stale = await localUpdateObject(context, {
    authorization,
    object_id: "la_object_stresslocal0001",
    expected_version: 1,
    patch: {
      visible_metadata: {
        size_class: "large"
      }
    }
  });
  assert(!stale.ok && stale.reason === "version-conflict", "local stress stale update did not fail correctly");

  const invalidVersion = await localUpdateObject(context, {
    authorization,
    object_id: "la_object_stresslocal0001",
    expected_version: -1,
    patch: {
      visible_metadata: {
        size_class: "large"
      }
    }
  });
  assert(!invalidVersion.ok && invalidVersion.reason === "invalid-expected-version", "local stress invalid version did not fail correctly");

  const emptyPatch = await localUpdateObject(context, {
    authorization,
    object_id: "la_object_stresslocal0001",
    expected_version: 2,
    patch: {}
  });
  assert(!emptyPatch.ok && emptyPatch.reason === "invalid-patch", "local stress empty patch did not fail correctly");

  const tooLarge = await localUpdateObject(context, {
    authorization,
    object_id: "la_object_stresslocal0001",
    expected_version: 2,
    patch: {
      payload: {
        kind: "plaintext-json",
        data: {
          title: "Synthetic stress oversized object",
          body: "x".repeat(16 * 1024)
        }
      }
    }
  });
  assert(!tooLarge.ok && tooLarge.reason === "object-too-large", "local stress oversized update did not fail correctly");

  let tombstones = 0;
  for (let index = 3; index <= localObjectCount; index += 3) {
    const objectId = `la_object_stresslocal${index.toString().padStart(4, "0")}`;
    const tombstone = await localTombstoneObject(context, {
      authorization,
      object_id: objectId,
      expected_version: 2
    });
    assert(tombstone.ok, `local stress tombstone ${index} failed: ${tombstone.ok ? "" : tombstone.reason}`);
    assert(tombstone.result.previous_version === 2 && tombstone.result.new_version === 3, `local stress tombstone ${index} version mismatch`);
    tombstones += 1;
  }

  const missing = await localReadObject(context, {
    authorization,
    object_id: "la_object_stressmissing0001"
  });
  assert(!missing.ok && missing.reason === "object-missing", "local stress missing read did not fail correctly");

  const sampleRead = await localReadObject(context, {
    authorization,
    object_id: "la_object_stresslocal0003"
  });
  assert(sampleRead.ok && sampleRead.result.object.version === 3, "local stress sample tombstone version was not visible");
  assert(sampleRead.result.object.visible_metadata.tombstone === true, "local stress sample tombstone metadata was not visible");

  const list = await localListObjects(context, { authorization });
  assert(list.ok && list.result.objects.length === localObjectCount + 5, "local stress list did not return all non-quarantine local-full objects");
  assert(list.ok && list.result.withheld_count === 1, "local stress local-full list should withhold only the quarantine fixture");

  const final = await localGraphStatus(context, { authorization });
  assert(final.ok && final.result.object_count === localObjectCount + 6, "local stress final object count mismatch");
  assert(auditSink.events.length >= localObjectCount * 2 + tombstones, "local stress did not emit enough audit events");
  assert(activitySink.events.length >= localObjectCount * 2 + tombstones, "local stress did not emit enough activity events");
  assertNoLeak("local stress audit/activity", JSON.stringify({ audit: auditSink.events, activity: activitySink.events }));

  outputs.push(JSON.stringify({
    local_crud_objects: localObjectCount,
    tombstones,
    audit_events: auditSink.events.length,
    activity_events: activitySink.events.length
  }));
  console.log(`ok local CRUD stress -> ${localObjectCount} creates, ${localObjectCount} updates, ${tombstones} tombstones`);
}

async function exerciseWorkerSyncStress(outputs: string[]): Promise<void> {
  const controlState = await createFixtureLocalControlState(localMcpToken);
  const syncClient = controlState.control_plane.clients.find((client) => client.allowed_profile === "sync-device");
  const syncCapability = controlState.control_plane.capabilities.find((capability) => capability.profile === "sync-device");
  assert(syncClient?.client_id, "stress fixture missing sync client");
  assert(syncCapability?.capability_id, "stress fixture missing sync capability");

  const graphBucket = new LocalR2Bucket(now);
  const controlDb = new LocalD1Database();
  const claimLock = new BootstrapClaimLockCore(new InMemoryBootstrapClaimLockStorage());
  const env: BootstrapWorkerEnv = {
    BOOTSTRAP_CLAIM_LOCK: {
      getByName: () => claimLock
    },
    LA_GRAPH_BUCKET: graphBucket as unknown as R2Bucket,
    LA_CONTROL_DB: controlDb as unknown as D1Database,
    LA_AUTHORITY_ID: fixtureAuthorityId,
    BOOTSTRAP_CLAIM_TOKEN_HASH: await sha256TokenHash(bootstrapToken),
    BOOTSTRAP_TOKEN_EXPIRES_AT: "2099-01-01T00:00:00.000Z",
    LA_SYNC_TOKEN_HASH: await sha256TokenHash(syncToken),
    LA_SYNC_CLIENT_ID: syncClient.client_id,
    LA_SYNC_CAPABILITY_ID: syncCapability.capability_id,
    LA_SYNC_TOKEN_ID: syncTokenId
  };
  const workerFetch = createWorkerFetch(env);

  await expectWorkerJson("stress bootstrap claim", await workerFetch(new URL("/api/bootstrap/claim", baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-living-atlas-bootstrap-token": bootstrapToken
    },
    body: JSON.stringify({
      authority_id: fixtureAuthorityId,
      user_id: fixtureUserId,
      device_id: fixtureDeviceId,
      device_public_key_hash: "synthetic-local-stress-device-public-key-hash",
      policy_generation: 1,
      wrapped_keys: [
        {
          key_id: "la_key_stresswrapped0001",
          wrapping_device_id: fixtureDeviceId,
          algorithm: "synthetic-fixture",
          ciphertext: "synthetic-local-stress-wrapped-key"
        }
      ],
      initial_remote_config: {
        fixture_only: true
      }
    })
  }), 201, outputs);

  const daemon = new SyntheticLocalSyncDaemon({
    controlState,
    endpoint: baseUrl,
    syncToken,
    tokenId: syncTokenId,
    fetchImpl: workerFetch
  });

  let firstBatch: SyncBatch | undefined;
  for (let generation = 1; generation <= syncGenerationCount; generation += 1) {
    const plan = await daemon.planFromRemoteStatus();
    assert(plan.ok, `stress generation ${generation} status fetch failed`);
    assert(plan.plan.action === "idle" || plan.plan.action === "push", `stress generation ${generation} unexpected plan ${plan.plan.action}`);

    const queued = daemon.queueCiphertextBatch({
      graphObjects: syncGenerationObjects(generation),
      remoteStatus: plan.status,
      now: isoAtSecond(100 + generation)
    });
    assert(queued.included_object_count === syncCiphertextObjectsPerGeneration, `stress generation ${generation} included wrong object count`);
    assert(queued.withheld_plaintext_count === syncPlaintextObjectsPerGeneration, `stress generation ${generation} withheld wrong plaintext count`);
    firstBatch ??= queued.batch;

    const submitted = await daemon.submitNextPending();
    assert(submitted.ok && submitted.submitted, `stress generation ${generation} submit failed: ${JSON.stringify(submitted)}`);
    assert(submitted.accepted.target_generation === generation, `stress generation ${generation} target mismatch`);
  }

  assert(firstBatch, "stress did not keep first batch for replay checks");
  const replay = await submitSyncBatch({
    endpoint: baseUrl,
    batch: firstBatch,
    syncToken,
    fetchImpl: workerFetch
  });
  assert(replay.ok && replay.accepted.idempotent_replay === true, "stress idempotent replay was not accepted");

  const currentStatus = await expectWorkerJson<{
    ok?: boolean;
    latest_generation?: number;
    object_count?: number;
    change_count?: number;
  }>("stress sync status", await workerFetch(new URL("/api/sync/status", baseUrl), {
    method: "GET",
    headers: syncHeaders({
      token: syncToken,
      clientId: syncClient.client_id,
      capabilityId: syncCapability.capability_id,
      tokenId: syncTokenId,
      contentType: false
    })
  }), 200, outputs);
  const expectedEnvelopeCount = syncGenerationCount * syncCiphertextObjectsPerGeneration;
  assert(currentStatus.ok === true, "stress sync status did not report ok");
  assert(currentStatus.latest_generation === syncGenerationCount, "stress sync status generation mismatch");
  assert(currentStatus.object_count === expectedEnvelopeCount, "stress sync status object count mismatch");
  assert(currentStatus.change_count === expectedEnvelopeCount, "stress sync status change count mismatch");
  assert(graphBucket.puts.length === expectedEnvelopeCount, "stress R2 envelope write count mismatch");

  const pull = await expectWorkerJson<{
    ok?: boolean;
    latest_generation?: number;
    batches?: unknown[];
    has_more?: boolean;
  }>("stress sync pull", await workerFetch(new URL(`/api/sync/pull?authority_id=${fixtureAuthorityId}&after_generation=0`, baseUrl), {
    method: "GET",
    headers: syncHeaders({
      token: syncToken,
      clientId: syncClient.client_id,
      capabilityId: syncCapability.capability_id,
      tokenId: syncTokenId,
      contentType: false
    })
  }), 200, outputs);
  assert(pull.ok === true && pull.latest_generation === syncGenerationCount, "stress pull generation mismatch");
  assert(Array.isArray(pull.batches) && pull.batches.length === syncGenerationCount, "stress pull did not return all batches");
  assert(pull.has_more === false, "stress pull unexpectedly paginated");

  const futureGap = buildCiphertextSyncBatch({
    controlState,
    graphObjects: syncGenerationObjects(900),
    tokenId: syncTokenId,
    baseGeneration: syncGenerationCount + 2,
    targetGeneration: syncGenerationCount + 3,
    now: isoAtSecond(900)
  });
  const gap = await submitSyncBatch({
    endpoint: baseUrl,
    batch: futureGap.batch,
    syncToken,
    fetchImpl: workerFetch
  });
  assert(!gap.ok && gap.status === 409, "stress generation gap was not rejected");

  const stale = buildCiphertextSyncBatch({
    controlState,
    graphObjects: syncGenerationObjects(901),
    tokenId: syncTokenId,
    baseGeneration: 0,
    targetGeneration: 1,
    now: isoAtSecond(901)
  });
  const staleResult = await submitSyncBatch({
    endpoint: baseUrl,
    batch: stale.batch,
    syncToken,
    fetchImpl: workerFetch
  });
  assert(!staleResult.ok && staleResult.status === 409, "stress stale generation was not rejected");

  const tampered = await workerFetch(new URL("/api/sync/batch", baseUrl), {
    method: "POST",
    headers: syncHeaders({
      token: syncToken,
      clientId: syncClient.client_id,
      capabilityId: syncCapability.capability_id,
      tokenId: syncTokenId
    }),
    body: JSON.stringify(mutateBatchHash(futureGap.batch))
  });
  await expectWorkerJson("stress tampered batch hash", tampered, 400, outputs);

  const malformed = await workerFetch(new URL("/api/sync/batch", baseUrl), {
    method: "POST",
    headers: syncHeaders({
      token: syncToken,
      clientId: syncClient.client_id,
      capabilityId: syncCapability.capability_id,
      tokenId: syncTokenId
    }),
    body: "{"
  });
  await expectWorkerJson("stress malformed batch", malformed, 400, outputs);

  const missingToken = await workerFetch(new URL("/api/sync/status", baseUrl), {
    method: "GET",
    headers: syncHeaders({
      clientId: syncClient.client_id,
      capabilityId: syncCapability.capability_id,
      tokenId: syncTokenId,
      contentType: false
    })
  });
  await expectWorkerJson("stress missing sync token", missingToken, 401, outputs);

  const badToken = await workerFetch(new URL("/api/sync/status", baseUrl), {
    method: "GET",
    headers: syncHeaders({
      token: "synthetic-local-stress-wrong-token-0001",
      clientId: syncClient.client_id,
      capabilityId: syncCapability.capability_id,
      tokenId: syncTokenId,
      contentType: false
    })
  });
  await expectWorkerJson("stress invalid sync token", badToken, 401, outputs);

  const badBinding = await workerFetch(new URL("/api/sync/status", baseUrl), {
    method: "GET",
    headers: syncHeaders({
      token: syncToken,
      clientId: syncClient.client_id,
      capabilityId: syncCapability.capability_id,
      tokenId: "la_sync_token_stresswrong0001",
      contentType: false
    })
  });
  await expectWorkerJson("stress bad token binding", badBinding, 403, outputs);

  const queryToken = await workerFetch(new URL("/api/sync/status?sync_token=synthetic-query-token", baseUrl), {
    method: "GET",
    headers: syncHeaders({
      token: syncToken,
      clientId: syncClient.client_id,
      capabilityId: syncCapability.capability_id,
      tokenId: syncTokenId,
      contentType: false
    })
  });
  await expectWorkerJson("stress query token rejection", queryToken, 400, outputs);

  const invalidPull = await workerFetch(new URL(`/api/sync/pull?authority_id=${fixtureAuthorityId}&after_generation=-1`, baseUrl), {
    method: "GET",
    headers: syncHeaders({
      token: syncToken,
      clientId: syncClient.client_id,
      capabilityId: syncCapability.capability_id,
      tokenId: syncTokenId,
      contentType: false
    })
  });
  await expectWorkerJson("stress invalid pull", invalidPull, 400, outputs);

  assertNoLeak("stress worker responses", outputs.join("\n"));
  assertNoLeak("stress R2 envelopes", JSON.stringify(graphBucket.puts));
  assertNoLeak("stress D1 records", JSON.stringify(controlDb.records));

  outputs.push(JSON.stringify({
    sync_generations: syncGenerationCount,
    sync_envelopes: expectedEnvelopeCount,
    r2_puts: graphBucket.puts.length,
    d1_records: controlDb.records.length
  }));
  console.log(`ok Worker sync stress -> ${syncGenerationCount} generations, ${expectedEnvelopeCount} ciphertext envelopes`);
}

const outputs: string[] = [];
const startedAt = Date.now();
await exerciseLocalCrudStress(outputs);
await exerciseWorkerSyncStress(outputs);
assertNoLeak("stress combined outputs", outputs.join("\n"));
console.log(`ok local stress leakage guard -> ${outputs.length} observed outputs in ${Date.now() - startedAt}ms`);
