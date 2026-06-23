import { describe, expect, it } from "vitest";
import type { GraphObjectEnvelope } from "@living-atlas/contracts";
import { selectSemanticObjectsForSyncScope } from "./logseq-semantic-parity";

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
