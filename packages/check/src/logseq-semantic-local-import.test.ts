import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TemporalEdgeSchema } from "@living-atlas/contracts";
import {
  createDefaultLocalKeyring,
  decryptGraphObjectPayload,
  FileLocalKeyringStore
} from "@living-atlas/local-keyring";
import { FileLocalGraphStore } from "@living-atlas/local-graph-store";
import { describe, expect, it } from "vitest";
import { importLogseqSemanticLocalObjects } from "./logseq-semantic-local-import";

const authorityId = "la_authority_fixture0001";

async function readStoreFiles(directory: string): Promise<string> {
  const snapshot = await readFile(join(directory, "snapshot.json"), "utf8").catch(() => "");
  const journal = await readFile(join(directory, "journal.jsonl"), "utf8").catch(() => "");
  return `${snapshot}\n${journal}`;
}

describe("Logseq semantic local import", () => {
  it("persists semantic edge drafts as local-keyring encrypted graph objects", async () => {
    const root = await mkdtemp(join(tmpdir(), "living-atlas-semantic-local-import-"));
    try {
      const keyringPath = join(root, "keyring.json");
      const graphDir = join(root, "graph");
      const ledgerPath = join(root, "ledger.json");
      const keyring = createDefaultLocalKeyring({
        authorityId,
        createdAt: "2026-06-24T00:00:00.000Z"
      });
      await new FileLocalKeyringStore(keyringPath).write(keyring, "fixture-passphrase");

      const ledger = await importLogseqSemanticLocalObjects({
        files: [
          {
            source_path: "pages/Synthetic Relationship.md",
            source_kind: "logseq",
            markdown: "## Edges\n\n- [[Synthetic Person]] (person) advises [[Synthetic Project]] (project) from 2026-06\n"
          }
        ],
        sourceRootRef: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        sourceKind: "logseq",
        sourceMode: "logseq-notes",
        pathRedactionSecret: "fixture-path-redaction-secret-0001",
        localGraphDir: graphDir,
        keyringPath,
        keyringPassphrase: "fixture-passphrase",
        authorityId,
        ledgerPath,
        recordedAt: "2026-06-24T00:01:00.000Z",
        scope: "edges-only"
      });

      expect(ledger.object_totals).toMatchObject({
        selected_objects: 1,
        created_objects: 1,
        updated_existing_objects: 0,
        failed_objects: 0
      });
      expect(ledger.by_object_type).toEqual({ edge: 1 });
      expect(ledger.by_semantic_kind).toEqual({ "typed-edge": 1 });
      expect(ledger.sync.attempted).toBe(false);
      expect(ledger.graph_status.plaintext_persistence).toBe("encrypted");

      const store = await FileLocalGraphStore.open({
        directory: graphDir,
        authorityId,
        plaintextPersistence: "redact"
      });
      const edge = store.listObjects({ include_tombstones: true }).find((object) => object.object_type === "edge");
      expect(edge).toEqual(expect.objectContaining({
        encryption_class: "client-encrypted",
        key_ref: expect.stringMatching(/^la_key_/),
        payload: expect.objectContaining({
          kind: "ciphertext-inline",
          algorithm: "AES-GCM-256+local-keyring-v1"
        })
      }));
      const decrypted = await decryptGraphObjectPayload(edge!, keyring);
      expect(decrypted?.kind).toBe("plaintext-json");
      if (decrypted?.kind !== "plaintext-json") {
        throw new Error("expected decryptable plaintext edge payload");
      }
      const parsedEdge = TemporalEdgeSchema.parse((decrypted.data as { edge?: unknown }).edge);
      expect(parsedEdge).toEqual(expect.objectContaining({
        predicate: "advises",
        source_type: "person",
        target_type: "project"
      }));

      const files = await readStoreFiles(graphDir);
      const ledgerText = await readFile(ledgerPath, "utf8");
      for (const output of [files, ledgerText, JSON.stringify(ledger)]) {
        expect(output).not.toContain("Synthetic Person");
        expect(output).not.toContain("Synthetic Project");
        expect(output).not.toContain("Synthetic Relationship");
      }
      expect(files).toContain("AES-GCM-256+local-keyring-v1");
      expect(files).not.toContain("plaintext-json");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("imports every supplied source file and records one redacted terminal outcome for ambiguous relationships", async () => {
    const root = await mkdtemp(join(tmpdir(), "living-atlas-semantic-local-import-ledger-"));
    try {
      const keyringPath = join(root, "keyring.json");
      const graphDir = join(root, "graph");
      const keyring = createDefaultLocalKeyring({
        authorityId,
        createdAt: "2026-06-24T00:00:00.000Z"
      });
      await new FileLocalKeyringStore(keyringPath).write(keyring, "fixture-passphrase");

      const ledger = await importLogseqSemanticLocalObjects({
        files: [
          {
            source_path: "pages/Synthetic Ambiguous Relationship.md",
            source_kind: "logseq",
            markdown: "## Edges\n\n- [[Synthetic Acquirer]] acquired [[Synthetic Target]]\n"
          }
        ],
        sourceRootRef: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        sourceKind: "logseq",
        sourceMode: "logseq-notes",
        pathRedactionSecret: "fixture-path-redaction-secret-0001",
        localGraphDir: graphDir,
        keyringPath,
        keyringPassphrase: "fixture-passphrase",
        authorityId,
        recordedAt: "2026-06-24T00:01:00.000Z"
      });

      expect(ledger.object_totals.selected_objects).toBe(ledger.object_totals.planned_objects);
      expect(ledger.source_outcomes).toEqual([
        expect.objectContaining({
          outcome: "quarantined",
          reason_codes: expect.arrayContaining(["direction-unsafe-alias"])
        })
      ]);
      expect(ledger.source_outcomes).toHaveLength(ledger.file_count);
      expect(JSON.stringify(ledger)).not.toContain("Synthetic Acquirer");
      expect(JSON.stringify(ledger)).not.toContain("Synthetic Target");

      const store = await FileLocalGraphStore.open({
        directory: graphDir,
        authorityId,
        plaintextPersistence: "encrypt",
        keyring
      });
      expect(store.status().object_count).toBe(ledger.object_totals.planned_objects);
      expect(store.listObjects({ include_tombstones: true })).toContainEqual(expect.objectContaining({
        access_class: "quarantine",
        visible_metadata: expect.objectContaining({ schema_namespace: "import/logseq-semantic/edge-candidate" })
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
