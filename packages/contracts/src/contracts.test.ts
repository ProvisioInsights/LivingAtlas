import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CapabilityGrantSchema,
  ClientRecordSchema,
  ControlPlaneSnapshotSchema,
  DurableAuditEventSchema,
  GraphObjectEnvelopeSchema,
  LiveActivityEventSchema,
  LocalControlStateSchema,
  OperationalEventSchema,
  SyncBatchSchema,
  SyncPullRecoverySchema,
  SyncStatusSchema,
  TemporalEdgeSchema,
  TemporalEventSchema,
  canonicalSyncBatchHashPayload,
  canonicalizePredicate
} from "./index";

const timestamp = "2026-06-21T12:00:00.000Z";

function ciphertextSyncObject(objectId = "la_object_contract0006") {
  return {
    schema_version: 1,
    authority_id: "la_authority_contract0001",
    object_id: objectId,
    object_type: "page",
    version: 1,
    access_class: "local-private",
    encryption_class: "client-encrypted",
    created_at: timestamp,
    updated_at: timestamp,
    content_hash: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    visible_metadata: {
      tombstone: false,
      remote_indexable: false
    },
    payload: {
      kind: "ciphertext-inline",
      ciphertext: `ciphertext-${objectId}`,
      nonce: "nonce"
    }
  } as const;
}

function payloadRefFor(object: ReturnType<typeof ciphertextSyncObject>) {
  return {
    object_id: object.object_id,
    version: object.version,
    envelope_hash: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
    payload_hash: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
    byte_size: 128
  };
}

function syncBatchInput(overrides: Record<string, unknown> = {}) {
  const objects = (overrides.objects as ReturnType<typeof ciphertextSyncObject>[] | undefined) ?? [
    ciphertextSyncObject()
  ];

  return {
    batch_id: "la_sync_batch_contract0003",
    authority_id: "la_authority_contract0001",
    device_id: "la_device_contract0001",
    client_id: "la_client_contract0001",
    capability_id: "la_cap_contract0004",
    operation_id: "la_operation_contract0001",
    trace_id: "la_trace_contract0001",
    idempotency_key: "la_idem_contract0001",
    batch_hash: "sha256:4444444444444444444444444444444444444444444444444444444444444444",
    submitted_at: timestamp,
    base_generation: 0,
    target_generation: 1,
    base_cursor: {
      authority_id: "la_authority_contract0001",
      generation: 0
    },
    pull_recovery: {
      mode: "none",
      reason: "current"
    },
    object_payloads: objects.map(payloadRefFor),
    objects,
    changes: [],
    estimated_batch_bytes: 256,
    limits: {
      max_objects: 250,
      max_changes: 1000,
      max_bytes: 1_000_000
    },
    withheld_plaintext_count: 0,
    ...overrides
  };
}

describe("GraphObjectEnvelopeSchema", () => {
  it("defaults new objects to local-private", () => {
    const parsed = GraphObjectEnvelopeSchema.parse({
      schema_version: 1,
      authority_id: "la_authority_contract0001",
      object_id: "la_object_contract0001",
      object_type: "page",
      version: 0,
      encryption_class: "client-encrypted",
      created_at: timestamp,
      updated_at: timestamp,
      content_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      payload: {
        kind: "ciphertext-inline",
        ciphertext: "ciphertext",
        nonce: "nonce"
      }
    });

    expect(parsed.access_class).toBe("local-private");
  });

  it("rejects sensitive plaintext envelopes", () => {
    const parsed = GraphObjectEnvelopeSchema.safeParse({
      schema_version: 1,
      authority_id: "la_authority_contract0001",
      object_id: "la_object_contract0002",
      object_type: "page",
      version: 0,
      access_class: "local-private",
      encryption_class: "plaintext",
      created_at: timestamp,
      updated_at: timestamp,
      content_hash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      payload: {
        kind: "plaintext-json",
        data: { title: "should be encrypted" }
      }
    });

    expect(parsed.success).toBe(false);
  });

  it("requires release expiry", () => {
    const parsed = GraphObjectEnvelopeSchema.safeParse({
      schema_version: 1,
      authority_id: "la_authority_contract0001",
      object_id: "la_object_contract0003",
      object_type: "page",
      version: 0,
      access_class: "release",
      encryption_class: "remote-readable",
      created_at: timestamp,
      updated_at: timestamp,
      content_hash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      payload: {
        kind: "plaintext-json",
        data: { title: "release without expiry" }
      }
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects sensitive remote indexing, plaintext-hash metadata, and semantic R2 paths", () => {
    const parsed = GraphObjectEnvelopeSchema.safeParse({
      schema_version: 1,
      authority_id: "la_authority_contract0001",
      object_id: "la_object_contract0004",
      object_type: "page",
      version: 0,
      access_class: "local-private",
      encryption_class: "client-encrypted",
      created_at: timestamp,
      updated_at: timestamp,
      content_hash: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      visible_metadata: {
        tombstone: false,
        remote_indexable: true
      },
      payload: {
        kind: "ciphertext-ref",
        storage: "r2",
        path: "objects/a=fixtureopaque/p=7d/s=privatepageciphertext0001.bin",
        ciphertext_hash: "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        byte_size: 100,
        algorithm: "xchacha20-poly1305"
      }
    });

    expect(parsed.success).toBe(false);
  });
});

describe("CapabilityGrantSchema", () => {
  it("rejects remote-safe grants that include sensitive access", () => {
    const parsed = CapabilityGrantSchema.safeParse({
      capability_id: "la_cap_contract0001",
      authority_id: "la_authority_contract0001",
      client_id: "la_client_contract0001",
      profile: "remote-safe",
      operations: ["read", "decrypt"],
      access_classes: ["remote-safe", "local-private"],
      created_at: timestamp
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects local-readonly mutation grants", () => {
    const parsed = CapabilityGrantSchema.safeParse({
      capability_id: "la_cap_contract0002",
      authority_id: "la_authority_contract0001",
      client_id: "la_client_contract0001",
      profile: "local-readonly",
      operations: ["read", "update"],
      access_classes: ["local-private"],
      created_at: timestamp
    });

    expect(parsed.success).toBe(false);
  });
});

describe("identity and control-plane contracts", () => {
  it("rejects remote-provider clients configured as local-admin", () => {
    const parsed = ClientRecordSchema.safeParse({
      client_id: "la_client_contract0001",
      authority_id: "la_authority_contract0001",
      client_type: "remote-provider",
      allowed_profile: "local-admin",
      credential_ref: "credential",
      created_at: timestamp
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects snapshots with dangling capability clients and policy generation mismatch", () => {
    const parsed = ControlPlaneSnapshotSchema.safeParse({
      authority: {
        authority_id: "la_authority_contract0001",
        display_name: "Contract authority",
        created_at: timestamp,
        policy_generation: 2
      },
      users: [
        {
          user_id: "la_user_contract0001",
          authority_id: "la_authority_contract0001",
          display_name: "Contract user",
          created_at: timestamp
        }
      ],
      devices: [],
      clients: [],
      capabilities: [
        {
          capability_id: "la_cap_contract0003",
          authority_id: "la_authority_contract0001",
          client_id: "la_client_missing0001",
          profile: "local-full",
          operations: ["read"],
          access_classes: ["local-private"],
          created_at: timestamp
        }
      ],
      keys: [],
      policy_generation: 1
    });

    expect(parsed.success).toBe(false);
  });
});

describe("local control and sync contracts", () => {
  it("rejects local control states whose authority does not match the control plane", () => {
    const parsed = LocalControlStateSchema.safeParse({
      schema_version: 1,
      authority_id: "la_authority_other0001",
      control_plane: {
        authority: {
          authority_id: "la_authority_contract0001",
          display_name: "Contract authority",
          created_at: timestamp,
          policy_generation: 1
        },
        users: [],
        devices: [],
        clients: [],
        capabilities: [],
        keys: [],
        policy_generation: 1
      },
      local_credentials: [],
      created_at: timestamp,
      updated_at: timestamp
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects plaintext sync-batch object payloads", () => {
    const parsed = SyncBatchSchema.safeParse({
      batch_id: "la_sync_batch_contract0001",
      authority_id: "la_authority_contract0001",
      device_id: "la_device_contract0001",
      client_id: "la_client_contract0001",
      operation_id: "la_operation_contract0001",
      trace_id: "la_trace_contract0001",
      submitted_at: timestamp,
      base_generation: 0,
      target_generation: 1,
      objects: [
        {
          schema_version: 1,
          authority_id: "la_authority_contract0001",
          object_id: "la_object_contract0005",
          object_type: "page",
          version: 1,
          access_class: "remote-safe",
          encryption_class: "plaintext",
          created_at: timestamp,
          updated_at: timestamp,
          content_hash: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          visible_metadata: {
            tombstone: false,
            remote_indexable: true
          },
          payload: {
            kind: "plaintext-json",
            data: { title: "not allowed in sync batch" }
          }
        }
      ],
      changes: [],
      withheld_plaintext_count: 0
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects sync batches that skip generations", () => {
    const parsed = SyncBatchSchema.safeParse({
      batch_id: "la_sync_batch_contract0002",
      authority_id: "la_authority_contract0001",
      device_id: "la_device_contract0001",
      client_id: "la_client_contract0001",
      operation_id: "la_operation_contract0001",
      trace_id: "la_trace_contract0001",
      submitted_at: timestamp,
      base_generation: 1,
      target_generation: 3,
      objects: [],
      changes: [],
      withheld_plaintext_count: 0
    });

    expect(parsed.success).toBe(false);
  });

  it("accepts deploy-ready sync batch metadata and derives it for legacy-compatible inputs", () => {
    const parsed = SyncBatchSchema.parse(syncBatchInput());
    expect(parsed.capability_id).toBe("la_cap_contract0004");
    expect(parsed.idempotency_key).toBe("la_idem_contract0001");
    expect(parsed.batch_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(parsed.object_payloads).toHaveLength(1);
    expect(parsed.base_cursor).toEqual({
      authority_id: "la_authority_contract0001",
      generation: 0
    });

    const derived = SyncBatchSchema.parse({
      batch_id: "la_sync_batch_contract0004",
      authority_id: "la_authority_contract0001",
      device_id: "la_device_contract0001",
      client_id: "la_client_contract0001",
      operation_id: "la_operation_contract0001",
      trace_id: "la_trace_contract0001",
      submitted_at: timestamp,
      base_generation: 0,
      target_generation: 1,
      objects: [ciphertextSyncObject("la_object_contract0007")],
      changes: [],
      withheld_plaintext_count: 0
    });

    expect(derived.capability_id).toMatch(/^la_cap_[A-Za-z0-9_-]{8,}$/);
    expect(derived.idempotency_key).toMatch(/^la_idem_[A-Za-z0-9_-]{8,}$/);
    expect(derived.batch_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(derived.object_payloads).toHaveLength(1);
    expect(derived.estimated_batch_bytes).toBeGreaterThan(0);

    const { batch_hash: _batchHash, ...derivedWithoutHash } = derived;
    expect(derived.batch_hash).toBe(`sha256:${createHash("sha256").update(
      canonicalSyncBatchHashPayload(derivedWithoutHash)
    ).digest("hex")}`);
  });

  it("rejects mismatched object payload hashes and batches over configured limits", () => {
    expect(SyncBatchSchema.safeParse(syncBatchInput({
      object_payloads: []
    })).success).toBe(false);

    expect(SyncBatchSchema.safeParse(syncBatchInput({
      objects: [
        ciphertextSyncObject("la_object_contract0008"),
        ciphertextSyncObject("la_object_contract0009")
      ],
      limits: {
        max_objects: 1,
        max_changes: 1000,
        max_bytes: 1_000_000
      }
    })).success).toBe(false);
  });

  it("requires pull recovery metadata to name its replay point", () => {
    expect(SyncPullRecoverySchema.safeParse({
      mode: "replay",
      reason: "local-cursor-behind"
    }).success).toBe(false);
  });

  it("accepts a minimal empty sync status", () => {
    expect(SyncStatusSchema.parse({
      ok: true,
      latest_generation: 0,
      object_count: 0,
      change_count: 0,
      latest_withheld_plaintext_count: 0
    })).toEqual({
      ok: true,
      latest_generation: 0,
      object_count: 0,
      change_count: 0,
      latest_withheld_plaintext_count: 0
    });
  });
});

describe("live activity contract", () => {
  it("accepts redacted metadata graph activity for Praxis", () => {
    const parsed = LiveActivityEventSchema.parse({
      event_id: "la_event_contract0001",
      operation_id: "la_operation_contract0001",
      trace_id: "la_trace_contract0001",
      cursor: "000000000123",
      recorded_at: timestamp,
      plane: "local",
      crud: "read",
      policy_decision: "allow",
      graph_touch: {
        nodes: ["la_object_contract0001"],
        edges: [],
        objects: ["la_object_contract0001"],
        path: ["la_object_contract0001"]
      },
      visibility: {
        mode: "metadata",
        contains_sensitive: true,
        redacted: true
      },
      summary: "local_read_object read allowed",
      visual: {
        motion: "pulse",
        intensity: 0.7,
        color_role: "created"
      }
    });

    expect(parsed.visibility.redacted).toBe(true);
  });
});

describe("durable audit contract", () => {
  const baseAuditEvent = {
    audit_id: "la_audit_contract0001",
    authority_id: "la_authority_contract0001",
    operation_id: "la_operation_contract0001",
    trace_id: "la_trace_contract0001",
    recorded_at: timestamp,
    actor_id: "la_client_contract0001",
    mcp_profile: "remote-safe",
    operation: "read",
    event_type: "object.read",
    object_id: "la_object_contract0001",
    access_class: "remote-safe",
    redaction: "remote-redacted",
    summary: "Remote object read allowed"
  } as const;

  it("accepts read, denial, release, and key audit events without arbitrary payloads", () => {
    expect(DurableAuditEventSchema.parse(baseAuditEvent)).toMatchObject({
      event_type: "object.read",
      object_id: "la_object_contract0001"
    });

    expect(DurableAuditEventSchema.parse({
      ...baseAuditEvent,
      audit_id: "la_audit_contract0002",
      event_type: "object.denied",
      outcome: "denied",
      reason_code: "remote-sensitive-unavailable",
      access_class: "local-private",
      summary: "Remote object unavailable"
    })).toMatchObject({ event_type: "object.denied", outcome: "denied" });

    expect(DurableAuditEventSchema.parse({
      ...baseAuditEvent,
      audit_id: "la_audit_contract0003",
      event_type: "release.published",
      outcome: "released",
      operation: "create",
      mcp_profile: "local-release",
      access_class: "release",
      release_id: "la_object_contract0002",
      summary: "Release projection published"
    })).toMatchObject({ event_type: "release.published", release_id: "la_object_contract0002" });

    expect(DurableAuditEventSchema.parse({
      ...baseAuditEvent,
      audit_id: "la_audit_contract0004",
      event_type: "key.changed",
      outcome: "changed",
      operation: "admin-config",
      mcp_profile: "sensitive-keyholding-client",
      object_id: undefined,
      access_class: undefined,
      key_id: "la_key_contract0001",
      summary: "Key reference changed"
    })).toMatchObject({ event_type: "key.changed", key_id: "la_key_contract0001" });
  });

  it("rejects audit events that try to carry payload or leak markers", () => {
    expect(DurableAuditEventSchema.safeParse({
      ...baseAuditEvent,
      payload: { ciphertext: "wrapped-key-ciphertext-fixture" }
    }).success).toBe(false);

    expect(DurableAuditEventSchema.safeParse({
      ...baseAuditEvent,
      summary: "Leaked plaintext payload"
    }).success).toBe(false);

    expect(DurableAuditEventSchema.safeParse({
      ...baseAuditEvent,
      event_type: "release.revoked",
      access_class: "shareable",
      release_id: "la_object_contract0002",
      summary: "Release revoked"
    }).success).toBe(false);

    expect(DurableAuditEventSchema.safeParse({
      ...baseAuditEvent,
      event_type: "key.rotated",
      operation: "admin-config",
      object_id: undefined,
      summary: "Key rotated"
    }).success).toBe(false);
  });
});

describe("operational observability contract", () => {
  it("accepts redacted request metrics with trace correlation", () => {
    const parsed = OperationalEventSchema.parse({
      event_schema: "living-atlas-operational-event:v1",
      event_id: "la_observe_contract0001",
      recorded_at: timestamp,
      severity: "info",
      plane: "cloudflare-worker",
      event_kind: "request",
      trace_id: "la_trace_contract0001",
      operation_id: "la_operation_contract0001",
      route: "/api/sync/status",
      method: "GET",
      status: 200,
      duration_ms: 7,
      outcome: "ok",
      counters: {
        http_requests: 1,
        http_2xx: 1,
        http_4xx: 0,
        http_5xx: 0
      },
      redaction: "operational-redacted",
      sensitive: false,
      message: "Cloudflare Worker request completed"
    });

    expect(parsed.sensitive).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain("sync_token");
  });
});

describe("temporal contracts", () => {
  it("rejects unknown predicates", () => {
    const parsed = TemporalEdgeSchema.safeParse({
      edge_id: "la_edge_contract0001",
      source_object_id: "la_object_contract0001",
      source_type: "person",
      target_object_id: "la_object_contract0002",
      target_type: "person",
      predicate: "knows-secretly",
      valid_from: "2026",
      source: "test"
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects direction-flipping aliases instead of silently reversing them", () => {
    expect(canonicalizePredicate("manages")).toEqual({
      ok: false,
      reason: "direction-unsafe-alias",
      suggestion: "Use the canonical predicate with explicitly swapped endpoints and confirm direction."
    });
  });

  it("canonicalizes safe aliases", () => {
    expect(canonicalizePredicate("works-for")).toEqual({
      ok: true,
      predicate: "employed-by",
      source: "safe-alias"
    });
  });

  it("requires correction events to name superseded events", () => {
    const parsed = TemporalEventSchema.safeParse({
      event_id: "la_event_contract0001",
      subject_object_id: "la_object_contract0001",
      subject_type: "person",
      kind: "correction",
      occurred_on: "2026",
      recorded_at: timestamp,
      source: "test"
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects impossible calendar dates", () => {
    const parsed = TemporalEventSchema.safeParse({
      event_id: "la_event_contract0002",
      subject_object_id: "la_object_contract0001",
      subject_type: "person",
      kind: "observation",
      occurred_on: "2026-02-31",
      recorded_at: timestamp,
      source: "test"
    });

    expect(parsed.success).toBe(false);
  });
});
