import { describe, expect, it } from "vitest";
import type { GraphObjectEnvelope } from "@living-atlas/contracts";
import {
  parseSemanticSyncMode,
  resolveSemanticSyncMode,
  selectSemanticObjectsForSyncScope
} from "./logseq-semantic-parity";

function envelope(id: string, schemaNamespace: string): GraphObjectEnvelope {
  return {
    schema_version: 1,
    authority_id: "la_authority_test00000001",
    object_id: id,
    object_type: "page",
    version: 1,
    access_class: "local-private",
    encryption_class: "client-encrypted",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    content_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    key_ref: "la_key_test00000001",
    visible_metadata: {
      schema_namespace: schemaNamespace,
      tombstone: false,
      remote_indexable: false,
      size_class: "small"
    },
    payload: {
      kind: "ciphertext-inline",
      ciphertext: "ciphertext",
      nonce: "nonce",
      algorithm: "aes-256-gcm"
    }
  };
}

describe("Logseq semantic parity sync scope", () => {
  it("selects every object for full sync", () => {
    const objects = [
      envelope("la_object_page000000001", "import/logseq-semantic/page"),
      envelope("la_object_capsule000001", "import/logseq-semantic/source-capsule")
    ];

    const selected = selectSemanticObjectsForSyncScope(objects, "all");

    expect(selected.objectsToSync).toEqual(objects);
    expect(selected.knownPreviouslySyncedObjects).toBe(0);
  });

  it("selects only source capsules and accounts for previously synced objects", () => {
    const sourceCapsule = envelope("la_object_capsule000001", "import/logseq-semantic/source-capsule");
    const objects = [
      envelope("la_object_page000000001", "import/logseq-semantic/page"),
      sourceCapsule,
      envelope("la_object_block00000001", "import/logseq-semantic/block")
    ];

    const selected = selectSemanticObjectsForSyncScope(objects, "source-capsules-only");

    expect(selected.objectsToSync).toEqual([sourceCapsule]);
    expect(selected.knownPreviouslySyncedObjects).toBe(2);
  });
});

describe("Logseq semantic parity sync mode", () => {
  it("defaults to local-only so Cloudflare sync is explicitly opt-in", () => {
    expect(parseSemanticSyncMode(undefined)).toBe("local-only");
    expect(resolveSemanticSyncMode({})).toBe("local-only");
  });

  it("rejects stale mutation acknowledgements while paused", () => {
    expect(() => resolveSemanticSyncMode({
      syncMode: "local-only",
      liveAck: "sync-semantic-ciphertext-to-cloudflare"
    })).toThrow("rejects");
    expect(() => resolveSemanticSyncMode({
      syncMode: "local-only",
      backfillAck: "record-known-synced-batch"
    })).toThrow("rejects");
  });

  it("requires both cloudflare mode and live acknowledgement before syncing", () => {
    expect(() => resolveSemanticSyncMode({
      syncMode: "cloudflare"
    })).toThrow("requires");
    expect(resolveSemanticSyncMode({
      syncMode: "cloudflare",
      liveAck: "sync-semantic-ciphertext-to-cloudflare"
    })).toBe("cloudflare");
  });

  it("keeps backfill as an explicit non-Cloudflare mutation mode", () => {
    expect(() => resolveSemanticSyncMode({
      syncMode: "backfill"
    })).toThrow("requires");
    expect(resolveSemanticSyncMode({
      syncMode: "backfill",
      backfillAck: "record-known-synced-batch"
    })).toBe("backfill");
  });
});
