import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileLocalGraphStore } from "@living-atlas/local-graph-store";
import {
  createDefaultLocalKeyring,
  encryptPlaintextGraphObjectDraft
} from "@living-atlas/local-keyring";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { reconcileSupersededSemanticObjects } from "./logseq-semantic-refresh-reconcile";

const now = "2026-07-15T00:00:00.000Z";
const authorityId = "la_authority_reconcile001";
const changedRef = "la_source_aaaaaaaaaaaaaaaaaaaaaaaa";
const untouchedRef = "la_source_bbbbbbbbbbbbbbbbbbbbbbbb";
const deletedRef = "la_source_cccccccccccccccccccccccc";

describe("reconcileSupersededSemanticObjects", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "living-atlas-reconcile-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function seedStore(keyring: ReturnType<typeof createDefaultLocalKeyring>) {
    const store = await FileLocalGraphStore.open({
      directory,
      authorityId,
      plaintextPersistence: "encrypt",
      keyring
    });
    const seed = async (
      objectId: string,
      namespace: string,
      sourceRef: string,
      data?: Record<string, unknown>
    ) => {
      const draft = await encryptPlaintextGraphObjectDraft({
        schema_version: 1,
        authority_id: authorityId,
        object_id: objectId,
        object_type: "block",
        version: 1,
        access_class: "local-private",
        encryption_class: "plaintext",
        created_at: now,
        updated_at: now,
        content_hash: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
        visible_metadata: { schema_namespace: namespace, tombstone: false },
        payload: {
          kind: "plaintext-json",
          data: data ?? { kind: "logseq-block", source_path_ref: sourceRef, text: "synthetic" }
        }
      }, keyring);
      const result = await store.createObject({
        expected_generation: store.status().generation,
        actor_id: "reconcile-test",
        operation_id: `la_operation_${objectId.slice(-24)}`,
        trace_id: `la_trace_${objectId.slice(-24)}`,
        recorded_at: now,
        object: draft
      });
      expect(result.ok).toBe(true);
    };
    return { store, seed };
  }

  it("tombstones only superseded per-path objects under covered source refs", async () => {
    const keyring = createDefaultLocalKeyring({ authorityId, createdAt: now });
    const { store, seed } = await seedStore(keyring);
    await seed("la_object_reconcilestale0001", "import/logseq-semantic/block", changedRef);
    await seed("la_object_reconcilekept00001", "import/logseq-semantic/block", changedRef);
    await seed("la_object_reconcileother0001", "import/logseq-semantic/block", untouchedRef);
    await seed("la_object_reconcileendpt0001", "import/logseq-semantic/typed-endpoint", changedRef);
    await seed("la_object_reconciledeleted01", "import/logseq-semantic/page", deletedRef);
    await seed("la_object_reconcileedge00001", "import/logseq-semantic/typed-edge", "unused", {
      kind: "logseq-temporal-edge",
      edge: { attrs: { source_path_ref: changedRef } }
    });

    const ledger = {
      object_refs: [{ object_id: "la_object_reconcilekept00001" }],
      source_outcomes: [{ source_path_ref: changedRef }]
    };

    const dry = await reconcileSupersededSemanticObjects({
      store,
      keyring,
      ledger,
      deletedSourceRefs: [deletedRef],
      actorId: "reconcile-test",
      dryRun: true,
      now
    });
    expect(dry).toMatchObject({ dry_run: true, stale: 3, tombstoned: 0, failed: 0 });

    const applied = await reconcileSupersededSemanticObjects({
      store,
      keyring,
      ledger,
      deletedSourceRefs: [deletedRef],
      actorId: "reconcile-test",
      dryRun: false,
      now
    });
    expect(applied).toMatchObject({
      dry_run: false,
      stale: 3,
      tombstoned: 3,
      failed: 0,
      stale_by_namespace: {
        "import/logseq-semantic/block": 1,
        "import/logseq-semantic/page": 1,
        "import/logseq-semantic/typed-edge": 1
      }
    });

    const liveIds = store.listObjects().map((object) => object.object_id).sort();
    expect(liveIds).toEqual([
      "la_object_reconcileendpt0001",
      "la_object_reconcilekept00001",
      "la_object_reconcileother0001"
    ]);
  });

  it("never tombstones undecryptable objects and reports them", async () => {
    const keyring = createDefaultLocalKeyring({ authorityId, createdAt: now });
    const { store, seed } = await seedStore(keyring);
    await seed("la_object_reconcilestale0002", "import/logseq-semantic/block", changedRef);
    const foreign = createDefaultLocalKeyring({ authorityId, createdAt: now });
    const draft = await encryptPlaintextGraphObjectDraft({
      schema_version: 1,
      authority_id: authorityId,
      object_id: "la_object_reconcileforeign01",
      object_type: "block",
      version: 1,
      access_class: "local-private",
      encryption_class: "plaintext",
      created_at: now,
      updated_at: now,
      content_hash: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      visible_metadata: { schema_namespace: "import/logseq-semantic/block", tombstone: false },
      payload: { kind: "plaintext-json", data: { source_path_ref: changedRef } }
    }, foreign);
    const created = await store.createObject({
      expected_generation: store.status().generation,
      actor_id: "reconcile-test",
      operation_id: "la_operation_reconcileforeig",
      trace_id: "la_trace_reconcileforeign001",
      recorded_at: now,
      object: draft
    });
    expect(created.ok).toBe(true);

    const result = await reconcileSupersededSemanticObjects({
      store,
      keyring,
      ledger: { object_refs: [], source_outcomes: [{ source_path_ref: changedRef }] },
      actorId: "reconcile-test",
      dryRun: false,
      now
    });
    expect(result).toMatchObject({ stale: 1, tombstoned: 1, undecryptable_skipped: 1 });
    const liveIds = store.listObjects().map((object) => object.object_id);
    expect(liveIds).toContain("la_object_reconcileforeign01");
  });
});
