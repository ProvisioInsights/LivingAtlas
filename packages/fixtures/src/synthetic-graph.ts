import { createHash } from "node:crypto";
import type {
  ControlPlaneSnapshot,
  DurableAuditEvent,
  GraphObjectEnvelope,
  SyncChangeEvent,
  TemporalEdge,
  TemporalEvent
} from "@living-atlas/contracts";

export type BaitString = {
  id: string;
  value: string;
  classification: "sensitive" | "remote-safe";
  reason: string;
};

export const fixtureAuthorityId = "la_authority_fixture0001";
export const fixtureUserId = "la_user_fixture0001";
export const fixtureDeviceId = "la_device_fixture0001";
export const fixtureRemoteClientId = "la_client_remote0001";
export const fixtureLocalClientId = "la_client_local0001";

export const sensitiveBaitRegistry: BaitString[] = [
  { id: "private-person-name", value: "Avery North", classification: "sensitive", reason: "synthetic private person" },
  { id: "private-title", value: "Blue Orchid Salary Negotiation", classification: "sensitive", reason: "synthetic private page title" },
  { id: "private-project", value: "Project Glass Lantern", classification: "sensitive", reason: "synthetic private project" },
  { id: "private-date", value: "2026-02-14", classification: "sensitive", reason: "synthetic journal date" },
  { id: "private-relationship", value: "estranged-from", classification: "sensitive", reason: "sensitive edge predicate bait" },
  { id: "private-attachment", value: "orchid-ledger-offer.pdf", classification: "sensitive", reason: "synthetic attachment filename" }
];

export const remoteSafeBaitRegistry: BaitString[] = [
  { id: "remote-safe-topic", value: "Living Atlas public fixture", classification: "remote-safe", reason: "remote-readable text" }
];

export const baitRegistry = [...sensitiveBaitRegistry, ...remoteSafeBaitRegistry];

export const syntheticPlaintextFixtures = {
  "la_object_privatepage0001": {
    title: "Blue Orchid Salary Negotiation",
    body: "Avery North discussed Project Glass Lantern on 2026-02-14.",
    attachment: "orchid-ledger-offer.pdf"
  },
  "la_object_privateedge0001": {
    predicate: "estranged-from",
    note: "Synthetic private family relationship bait."
  }
} as const;

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

const now = "2026-06-21T12:00:00.000Z";
const privatePageCiphertextHash = sha256("ciphertext-private-page");
const privateEdgeCiphertextHash = sha256("ciphertext-private-edge");

export const syntheticGraphObjects: GraphObjectEnvelope[] = [
  {
    schema_version: 1,
    authority_id: fixtureAuthorityId,
    object_id: "la_object_privatepage0001",
    object_type: "page",
    version: 1,
    access_class: "local-private",
    encryption_class: "client-encrypted",
    created_at: now,
    updated_at: now,
    content_hash: privatePageCiphertextHash,
    key_ref: "la_key_sensitive0001",
    visible_metadata: {
      schema_namespace: "fixture/private-page",
      tombstone: false,
      size_class: "small",
      remote_indexable: false
    },
    payload: {
      kind: "ciphertext-ref",
      storage: "r2",
      path: "objects/a=8ccf81da9572c36e/p=4b/s=4b63a209f7a5343c619a6fa7dd1f833045b61d52.bin",
      ciphertext_hash: privatePageCiphertextHash,
      byte_size: 4096,
      algorithm: "xchacha20-poly1305"
    }
  },
  {
    schema_version: 1,
    authority_id: fixtureAuthorityId,
    object_id: "la_object_privateedge0001",
    object_type: "edge",
    version: 1,
    access_class: "local-private",
    encryption_class: "client-encrypted",
    created_at: now,
    updated_at: now,
    content_hash: privateEdgeCiphertextHash,
    key_ref: "la_key_sensitive0001",
    visible_metadata: {
      schema_namespace: "fixture/private-edge",
      tombstone: false,
      size_class: "tiny",
      remote_indexable: false
    },
    payload: {
      kind: "ciphertext-ref",
      storage: "r2",
      path: "objects/a=8ccf81da9572c36e/p=be/s=be2e22d093ae5cfce0eaf8c6e1a410507c0a9ca7.bin",
      ciphertext_hash: privateEdgeCiphertextHash,
      byte_size: 1024,
      algorithm: "xchacha20-poly1305"
    }
  },
  {
    schema_version: 1,
    authority_id: fixtureAuthorityId,
    object_id: "la_object_remotesafe0001",
    object_type: "page",
    version: 1,
    access_class: "remote-safe",
    encryption_class: "plaintext",
    created_at: now,
    updated_at: now,
    content_hash: sha256("Living Atlas public fixture remote-readable note"),
    visible_metadata: {
      schema_namespace: "fixture/remote-safe-page",
      tombstone: false,
      size_class: "tiny",
      remote_indexable: true
    },
    payload: {
      kind: "plaintext-json",
      data: {
        title: "Living Atlas public fixture",
        body: "This synthetic note is approved for remote-safe MCP reads and tests."
      }
    }
  },
  {
    schema_version: 1,
    authority_id: fixtureAuthorityId,
    object_id: "la_object_shareable0001",
    object_type: "attachment",
    version: 1,
    access_class: "shareable",
    encryption_class: "remote-readable",
    created_at: now,
    updated_at: now,
    content_hash: sha256("shareable remote-readable attachment fixture"),
    visible_metadata: {
      schema_namespace: "fixture/shareable-attachment",
      tombstone: false,
      size_class: "small",
      remote_indexable: true
    },
    payload: {
      kind: "plaintext-json",
      data: {
        filename: "public-demo-attachment.txt",
        body: "Shareable fixture attachment."
      }
    }
  },
  {
    schema_version: 1,
    authority_id: fixtureAuthorityId,
    object_id: "la_object_release0001",
    object_type: "page",
    version: 1,
    access_class: "release",
    encryption_class: "remote-readable",
    created_at: now,
    updated_at: now,
    content_hash: sha256("release projection fixture"),
    visible_metadata: {
      schema_namespace: "fixture/release-page",
      tombstone: false,
      size_class: "tiny",
      remote_indexable: true,
      release_expires_at: "2027-06-21T12:00:00.000Z"
    },
    payload: {
      kind: "plaintext-json",
      data: {
        title: "Release projection fixture",
        body: "Synthetic release content with explicit expiry."
      }
    }
  },
  {
    schema_version: 1,
    authority_id: fixtureAuthorityId,
    object_id: "la_object_quarantine0001",
    object_type: "page",
    version: 1,
    access_class: "quarantine",
    encryption_class: "client-encrypted",
    created_at: now,
    updated_at: now,
    content_hash: sha256("fixture-ciphertext"),
    key_ref: "la_key_sensitive0001",
    visible_metadata: {
      schema_namespace: "fixture/quarantine",
      tombstone: false,
      size_class: "tiny",
      remote_indexable: false
    },
    payload: {
      kind: "ciphertext-inline",
      ciphertext: "fixture-ciphertext",
      nonce: "fixture-nonce",
      algorithm: "xchacha20-poly1305"
    }
  }
];

export const temporalEdges: TemporalEdge[] = [
  {
    edge_id: "la_edge_remoteadvises0001",
    source_object_id: "la_object_remotesafe0001",
    source_type: "person",
    target_object_id: "la_object_shareable0001",
    target_type: "project",
    predicate: "advises",
    valid_from: "2024",
    status: "active",
    confidence: "high",
    source: "synthetic-fixture",
    attrs: {
      scope: "remote-safe test edge"
    }
  },
  {
    edge_id: "la_edge_privatefamily0001",
    source_object_id: "la_object_privatepage0001",
    source_type: "person",
    target_object_id: "la_object_privateedge0001",
    target_type: "person",
    predicate: "estranged-from",
    valid_from: "~2025",
    status: "active",
    confidence: "low",
    source: "synthetic-fixture",
    attrs: {
      note: "sensitive relationship fixture"
    }
  },
  {
    edge_id: "la_edge_remoteinvest0001",
    source_object_id: "la_object_remotesafe0001",
    source_type: "organization",
    target_object_id: "la_object_shareable0001",
    target_type: "project",
    predicate: "invests-in",
    valid_from: "2026-06",
    status: "pending",
    confidence: "medium",
    source: "synthetic-fixture",
    attrs: {
      amount: "synthetic",
      status: "pending"
    }
  }
];

export const temporalEvents: TemporalEvent[] = [
  {
    event_id: "la_event_remoteformed0001",
    subject_object_id: "la_object_remotesafe0001",
    subject_type: "person",
    kind: "relationship-formed",
    occurred_on: "2024",
    recorded_at: now,
    predicate: "advises",
    object_object_id: "la_object_shareable0001",
    source: "synthetic-fixture",
    supersedes: []
  },
  {
    event_id: "la_event_privatecontact0001",
    subject_object_id: "la_object_privatepage0001",
    subject_type: "person",
    kind: "contact",
    occurred_on: "2026-02-14",
    recorded_at: now,
    source: "synthetic-fixture",
    detail: "Synthetic local-only contact event.",
    supersedes: []
  },
  {
    event_id: "la_event_correction0001",
    subject_object_id: "la_object_remotesafe0001",
    subject_type: "person",
    kind: "correction",
    occurred_on: "2024",
    recorded_at: "2026-06-21T12:05:00.000Z",
    source: "synthetic-fixture",
    supersedes: ["la_event_remoteformed0001"],
    detail: "Synthetic correction event with explicit supersedes."
  }
];

export const controlPlaneFixture: ControlPlaneSnapshot = {
  authority: {
    authority_id: fixtureAuthorityId,
    display_name: "Synthetic Fixture Authority",
    created_at: now,
    policy_generation: 1
  },
  users: [
    {
      user_id: fixtureUserId,
      authority_id: fixtureAuthorityId,
      display_name: "Fixture Operator",
      created_at: now
    }
  ],
  devices: [
    {
      device_id: fixtureDeviceId,
      authority_id: fixtureAuthorityId,
      user_id: fixtureUserId,
      trust_level: "keyholding",
      public_key_hash: "fixture-public-key-hash-0001",
      created_at: now
    }
  ],
  clients: [
    {
      client_id: fixtureLocalClientId,
      authority_id: fixtureAuthorityId,
      client_type: "local-ai",
      device_id: fixtureDeviceId,
      allowed_profile: "local-full",
      credential_ref: "local-fixture-credential",
      created_at: now
    },
    {
      client_id: "la_client_sync0001",
      authority_id: fixtureAuthorityId,
      client_type: "sync-agent",
      device_id: fixtureDeviceId,
      allowed_profile: "sync-device",
      credential_ref: "sync-fixture-credential",
      created_at: now
    },
    {
      client_id: "la_client_admin0001",
      authority_id: fixtureAuthorityId,
      client_type: "admin-cli",
      device_id: fixtureDeviceId,
      allowed_profile: "local-admin",
      credential_ref: "admin-fixture-credential",
      created_at: now
    },
    {
      client_id: fixtureRemoteClientId,
      authority_id: fixtureAuthorityId,
      client_type: "remote-provider",
      allowed_profile: "remote-safe",
      credential_ref: "remote-fixture-credential",
      created_at: now
    }
  ],
  capabilities: [
    {
      capability_id: "la_cap_localfull0001",
      authority_id: fixtureAuthorityId,
      client_id: fixtureLocalClientId,
      profile: "local-full",
      operations: ["read", "search", "traverse", "create", "update", "delete", "restore", "decrypt", "audit-read"],
      access_classes: ["local-private", "remote-safe", "shareable", "quarantine", "release"],
      created_at: now
    },
    {
      capability_id: "la_cap_remotesafe0001",
      authority_id: fixtureAuthorityId,
      client_id: fixtureRemoteClientId,
      profile: "remote-safe",
      operations: ["read", "search", "traverse", "create", "update", "delete", "restore", "audit-read"],
      access_classes: ["remote-safe", "shareable", "release"],
      created_at: now
    },
    {
      capability_id: "la_cap_sync0001",
      authority_id: fixtureAuthorityId,
      client_id: "la_client_sync0001",
      profile: "sync-device",
      operations: ["sync-read", "sync-write", "audit-read"],
      access_classes: ["local-private", "remote-safe", "shareable", "quarantine", "release"],
      created_at: now
    },
    {
      capability_id: "la_cap_admin0001",
      authority_id: fixtureAuthorityId,
      client_id: "la_client_admin0001",
      profile: "local-admin",
      operations: ["read", "search", "traverse", "admin-config", "grant-capability", "enroll-device", "audit-read"],
      access_classes: ["local-private", "remote-safe", "shareable", "quarantine", "release"],
      created_at: now
    }
  ],
  keys: [
    {
      key_id: "la_key_sensitive0001",
      authority_id: fixtureAuthorityId,
      purpose: "access-class",
      access_class: "local-private",
      created_at: now,
      cloud_unwrapped: false
    }
  ],
  policy_generation: 1
};

export const auditEventFixture: DurableAuditEvent = {
  audit_id: "la_audit_fixture0001",
  authority_id: fixtureAuthorityId,
  operation_id: "la_operation_fixture0001",
  trace_id: "la_trace_fixture0001",
  recorded_at: now,
  actor_id: fixtureRemoteClientId,
  mcp_profile: "remote-safe",
  operation: "read",
  event_type: "object.denied",
  object_id: "la_object_privatepage0001",
  access_class: "local-private",
  redaction: "remote-redacted",
  summary: "Remote object unavailable"
};

export const syncChangeFixture: SyncChangeEvent = {
  change_id: "la_change_fixture0001",
  authority_id: fixtureAuthorityId,
  operation_id: "la_operation_fixture0001",
  trace_id: "la_trace_fixture0001",
  recorded_at: now,
  object_id: "la_object_remotesafe0001",
  operation: "update",
  base_version: 0,
  new_version: 1,
  content_hash: sha256("remote-safe update"),
  access_class: "remote-safe",
  generation: 1,
  actor_id: fixtureRemoteClientId
};
