import { describe, expect, it } from "vitest";
import { SyncBatchSchema, type SyncBatch } from "@living-atlas/contracts";
import { sha256TokenHash } from "./bootstrap";
import { encryptCloudUnlockObject } from "./cloud-unlock";
import { encryptEscalatedCloudUnlockObject } from "./cloud-unlock-escalated";
import { handleBootstrapRequest, type BootstrapWorkerEnv } from "./worker";
import { FakeD1Database, FakeR2Bucket } from "./worker-test-doubles";

const syncToken = "fixture-sync-token-0001";
const timestamp = "2026-07-04T12:00:00.000Z";
const cloudUnlockCapabilityId = "la_cap_cloudunlock0001";
const authorityId = "la_authority_worker0001";

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function keyMaterial(seed: number): string {
  return toBase64(new Uint8Array(Array.from({ length: 32 }, (_, index) => (index * 7 + seed) % 256)));
}

// Distinct primary session key and escalation key.
const primaryKey = keyMaterial(1);
const escalationKey = keyMaterial(2);
const wrongEscalationKey = keyMaterial(99);

async function createEnv(): Promise<{
  env: BootstrapWorkerEnv;
  graphBucket: FakeR2Bucket;
  controlDb: FakeD1Database;
}> {
  const graphBucket = new FakeR2Bucket();
  const controlDb = new FakeD1Database();
  return {
    graphBucket,
    controlDb,
    env: {
      BOOTSTRAP_CLAIM_LOCK: {
        getByName: () => {
          throw new Error("bootstrap lock should not be used by escalation tests");
        }
      },
      LA_GRAPH_BUCKET: graphBucket as unknown as R2Bucket,
      LA_CONTROL_DB: controlDb as unknown as D1Database,
      LA_AUTHORITY_ID: authorityId,
      LA_SYNC_TOKEN_HASH: await sha256TokenHash(syncToken),
      LA_CLOUD_UNLOCK_CAPABILITY_ID: cloudUnlockCapabilityId
    }
  };
}

function envelopeFor(objectId: string): {
  schema_version: 1;
  authority_id: string;
  object_id: string;
  object_type: "page";
  version: 1;
  access_class: "local-private";
  encryption_class: "client-encrypted";
  created_at: string;
  updated_at: string;
  key_ref: string;
  visible_metadata: { tombstone: false; size_class: "tiny"; remote_indexable: false };
} {
  return {
    schema_version: 1,
    authority_id: authorityId,
    object_id: objectId,
    object_type: "page",
    version: 1,
    access_class: "local-private",
    encryption_class: "client-encrypted",
    created_at: timestamp,
    updated_at: timestamp,
    key_ref: `la_key_${objectId}`,
    visible_metadata: { tombstone: false, size_class: "tiny", remote_indexable: false }
  };
}

async function seedBatch(env: BootstrapWorkerEnv): Promise<SyncBatch> {
  // A NORMAL object (primary cloud-unlock class) and an ESCALATED object.
  const normal = await encryptCloudUnlockObject({
    envelope: envelopeFor("la_object_normal0001"),
    plaintext: { title: "Normal note", body: "Decryptable with the primary session key." },
    encodedUnlockKey: primaryKey
  });
  const escalated = await encryptEscalatedCloudUnlockObject({
    envelope: envelopeFor("la_object_escalated0001"),
    plaintext: { title: "SSN", body: "Super-sensitive: escalation required." },
    encodedEscalationKey: escalationKey
  });

  const batch = SyncBatchSchema.parse({
    batch_id: "la_sync_batch_escalation0001",
    authority_id: authorityId,
    device_id: "la_device_worker0001",
    client_id: "la_client_worker0001",
    capability_id: cloudUnlockCapabilityId,
    operation_id: "la_operation_escalation0001",
    trace_id: "la_trace_escalation0001",
    idempotency_key: "la_idem_escalation0001",
    submitted_at: timestamp,
    base_generation: 0,
    target_generation: 1,
    objects: [normal, escalated],
    changes: [normal, escalated].map((object, index) => ({
      change_id: `la_change_escalation000${index + 1}`,
      authority_id: authorityId,
      operation_id: "la_operation_escalation0001",
      trace_id: "la_trace_escalation0001",
      recorded_at: timestamp,
      object_id: object.object_id,
      operation: "update" as const,
      base_version: 0,
      new_version: 1,
      content_hash: object.content_hash,
      access_class: object.access_class,
      generation: 1,
      actor_id: "la_client_worker0001"
    })),
    withheld_plaintext_count: 0
  });

  const response = await handleBootstrapRequest(new Request("https://living-atlas.example/api/sync/batch", {
    method: "POST",
    headers: { "content-type": "application/json", "x-living-atlas-sync-token": syncToken },
    body: JSON.stringify(batch)
  }), env);
  expect(response.status).toBe(202);
  return batch;
}

function decryptCall(
  env: BootstrapWorkerEnv,
  objectId: string,
  id: number,
  headers: Record<string, string>
): Promise<Response> {
  return handleBootstrapRequest(new Request("https://living-atlas.example/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-living-atlas-sync-token": syncToken,
      "x-living-atlas-sync-capability-id": cloudUnlockCapabilityId,
      ...headers
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "sensitive_decrypt", arguments: { authority_id: authorityId, object_id: objectId } }
    })
  }), env);
}

describe("worker two-key escalation flow", () => {
  it("normal object decrypts with only the primary session key (no escalation needed)", async () => {
    const { env } = await createEnv();
    await seedBatch(env);

    const response = await decryptCall(env, "la_object_normal0001", 1, {
      "x-living-atlas-cloud-unlock-key": primaryKey
    });
    const body = await response.json();
    expect(body).toMatchObject({
      result: {
        structuredContent: {
          ok: true,
          current_mode: "cloud-unlock-session",
          object_id: "la_object_normal0001",
          tier: "normal",
          payload: { kind: "plaintext-json", data: { title: "Normal note" } }
        }
      }
    });
  });

  it("escalated object WITHOUT the escalation key returns escalation-required and does NOT decrypt", async () => {
    const { env } = await createEnv();
    await seedBatch(env);

    const response = await decryptCall(env, "la_object_escalated0001", 2, {
      "x-living-atlas-cloud-unlock-key": primaryKey
    });
    const body = await response.json();
    expect(body).toMatchObject({
      result: {
        structuredContent: {
          ok: false,
          reason: "escalation-required",
          tier: "super-sensitive",
          current_mode: "cloud-unlock-session",
          object_id: "la_object_escalated0001",
          escalation_required_header: "x-living-atlas-escalation-key",
          key_persisted_by_cloudflare: false,
          host_blind_sensitive_plaintext: true
        }
      }
    });
    // No plaintext body leaked.
    expect(JSON.stringify(body)).not.toContain("Super-sensitive: escalation required.");
  });

  it("escalated object WITH a valid escalation key decrypts", async () => {
    const { env } = await createEnv();
    await seedBatch(env);

    const response = await decryptCall(env, "la_object_escalated0001", 3, {
      "x-living-atlas-cloud-unlock-key": primaryKey,
      "x-living-atlas-escalation-key": escalationKey
    });
    const body = await response.json();
    expect(body).toMatchObject({
      result: {
        structuredContent: {
          ok: true,
          current_mode: "cloud-unlock-session",
          object_id: "la_object_escalated0001",
          tier: "super-sensitive",
          escalated: true,
          payload: { kind: "plaintext-json", data: { title: "SSN", body: "Super-sensitive: escalation required." } }
        }
      }
    });
  });

  it("escalated object with a WRONG escalation key fails (does not decrypt)", async () => {
    const { env } = await createEnv();
    await seedBatch(env);

    const response = await decryptCall(env, "la_object_escalated0001", 4, {
      "x-living-atlas-cloud-unlock-key": primaryKey,
      "x-living-atlas-escalation-key": wrongEscalationKey
    });
    const body = await response.json();
    expect(body).toMatchObject({
      result: {
        structuredContent: {
          ok: false,
          reason: "decrypt-failed",
          tier: "super-sensitive",
          current_mode: "cloud-unlock-session"
        }
      }
    });
    expect(JSON.stringify(body)).not.toContain("Super-sensitive: escalation required.");
  });

  it("the escalation key alone (as the primary header) does NOT decrypt an escalated object without proper escalation", async () => {
    const { env } = await createEnv();
    await seedBatch(env);

    // Only the primary header is set (to the escalation key value). The escalated
    // object still requires the escalation header — escalation-required fires.
    const response = await decryptCall(env, "la_object_escalated0001", 5, {
      "x-living-atlas-cloud-unlock-key": escalationKey
    });
    const body = await response.json();
    expect(body).toMatchObject({
      result: { structuredContent: { ok: false, reason: "escalation-required", tier: "super-sensitive" } }
    });
  });
});

describe("worker escalation key custody", () => {
  it("neither the primary NOR the escalation key appears in any response, header, D1, or R2 across all paths", async () => {
    const { env, graphBucket, controlDb } = await createEnv();
    await seedBatch(env);

    const primaryUrlSafe = primaryKey.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const escalationUrlSafe = escalationKey.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const primaryHex = [...atob(primaryKey)].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
    const escalationHex = [...atob(escalationKey)].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
    const wrongUrlSafe = wrongEscalationKey.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const keyForms = [
      primaryKey, escalationKey, wrongEscalationKey,
      primaryUrlSafe, escalationUrlSafe, wrongUrlSafe,
      primaryHex, escalationHex
    ];

    const surfaces: string[] = [];
    const capture = async (response: Response): Promise<unknown> => {
      const body = await response.json();
      surfaces.push(JSON.stringify(body));
      surfaces.push(JSON.stringify([...response.headers.entries()]));
      return body;
    };

    // success (normal), escalation-required, escalated success, wrong-key, malformed escalation key
    await capture(await decryptCall(env, "la_object_normal0001", 10, { "x-living-atlas-cloud-unlock-key": primaryKey }));
    await capture(await decryptCall(env, "la_object_escalated0001", 11, { "x-living-atlas-cloud-unlock-key": primaryKey }));
    await capture(await decryptCall(env, "la_object_escalated0001", 12, {
      "x-living-atlas-cloud-unlock-key": primaryKey,
      "x-living-atlas-escalation-key": escalationKey
    }));
    await capture(await decryptCall(env, "la_object_escalated0001", 13, {
      "x-living-atlas-cloud-unlock-key": primaryKey,
      "x-living-atlas-escalation-key": wrongEscalationKey
    }));
    await capture(await decryptCall(env, "la_object_escalated0001", 14, {
      "x-living-atlas-cloud-unlock-key": primaryKey,
      "x-living-atlas-escalation-key": "%%%not-base64-escalation%%%"
    }));

    for (const put of graphBucket.puts) {
      surfaces.push(put.key, put.value, JSON.stringify(put.options ?? {}));
    }
    for (const record of controlDb.records) {
      surfaces.push(record.query, JSON.stringify(record.bindings ?? []));
    }

    for (const surface of surfaces) {
      for (const form of keyForms) {
        expect(surface).not.toContain(form);
      }
    }
  });
});
