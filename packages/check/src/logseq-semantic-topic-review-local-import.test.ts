import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultLocalKeyring, FileLocalKeyringStore } from "@living-atlas/local-keyring";
import { describe, expect, it } from "vitest";
import { importTopicReviewResolutions } from "./logseq-semantic-topic-review-local-import";

const authorityId = "la_authority_fixture0001";
const hashA = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const hashB = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function fixturePacket() {
  return {
    packet_schema: "living-atlas-logseq-topic-review-packet:v1",
    plaintext_policy: "local-private-topic-review-packet",
    source_path_policy: "redacted",
    generated_at: "2026-06-24T00:00:00.000Z",
    source_mode: "logseq-notes",
    covered_file_count: 2,
    candidate_count: 3,
    grouped_candidate_count: 2,
    excluded_suffix_tag_count: 1,
    reason_counts: {
      "hash-tag-topic-review": 1,
      "plain-tag-topic-review": 2
    },
    groups: [
      {
        reason_code: "hash-tag-topic-review",
        target_hash: hashA,
        target_value: "Fixture Topic Alpha",
        occurrence_count: 1,
        source_refs: ["la_source_aaaaaaaaaaaaaaaaaaaaaaaa"]
      },
      {
        reason_code: "plain-tag-topic-review",
        target_hash: hashB,
        target_value: "Fixture Topic Beta",
        occurrence_count: 2,
        source_refs: ["la_source_bbbbbbbbbbbbbbbbbbbbbbbb"]
      }
    ]
  };
}

function fixtureResolutions() {
  return {
    resolution_schema: "living-atlas-logseq-topic-review-resolution-map:v1",
    plaintext_policy: "local-private-topic-review-resolution-map",
    generated_at: "2026-06-24T00:01:00.000Z",
    resolutions: [
      {
        target_hash: hashA,
        reason_code: "hash-tag-topic-review",
        decision: "promote-topic",
        topic_title: "Fixture Topic Alpha",
        subtype: "theme",
        aliases: ["Fixture Topic Alias"],
        confidence: "high"
      },
      {
        target_hash: hashB,
        reason_code: "plain-tag-topic-review",
        decision: "defer",
        confidence: "high",
        rationale_hash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
      }
    ]
  };
}

async function readTextIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

describe("Logseq semantic topic review local import", () => {
  it("writes promoted topics and terminal review decisions as encrypted local graph objects", async () => {
    const root = await mkdtemp(join(tmpdir(), "living-atlas-topic-review-import-"));
    try {
      const packetPath = join(root, "packet.json");
      const resolutionPath = join(root, "resolutions.json");
      const keyringPath = join(root, "keyring.json");
      const graphDir = join(root, "graph");
      const ledgerPath = join(root, "ledger.json");
      await writeFile(packetPath, JSON.stringify(fixturePacket(), null, 2));
      await writeFile(resolutionPath, JSON.stringify(fixtureResolutions(), null, 2));
      await new FileLocalKeyringStore(keyringPath).write(createDefaultLocalKeyring({
        authorityId,
        createdAt: "2026-06-24T00:00:00.000Z"
      }), "fixture-passphrase");

      const ledger = await importTopicReviewResolutions({
        packetPath,
        resolutionPath,
        localGraphDir: graphDir,
        keyringPath,
        keyringPassphrase: "fixture-passphrase",
        authorityId,
        ledgerPath,
        recordedAt: "2026-06-24T00:02:00.000Z"
      });

      expect(ledger.import_totals).toMatchObject({
        created_objects: 2,
        promoted_objects: 1,
        quarantine_objects: 1,
        failed_objects: 0
      });
      expect(ledger.resolution_totals).toMatchObject({
        resolution_count: 2,
        promote_topic_count: 1,
        defer_count: 1,
        reject_count: 0
      });
      expect(ledger.sync.attempted).toBe(false);
      expect(ledger.graph_status.plaintext_persistence).toBe("encrypted");
      expect(ledger.object_refs).toEqual([
        expect.objectContaining({ import_status: "promoted", access_class: "local-private", object_type: "page" }),
        expect.objectContaining({ import_status: "quarantined", access_class: "quarantine", object_type: "attachment" })
      ]);

      const snapshot = await readTextIfExists(join(graphDir, "snapshot.json"));
      const journal = await readFile(join(graphDir, "journal.jsonl"), "utf8");
      const ledgerText = await readFile(ledgerPath, "utf8");
      for (const output of [snapshot, journal, ledgerText, JSON.stringify(ledger)]) {
        expect(output).not.toContain("Fixture Topic Alpha");
        expect(output).not.toContain("Fixture Topic Beta");
        expect(output).not.toContain("Fixture Topic Alias");
      }
      expect(`${snapshot}\n${journal}`).toContain("\"ciphertext-inline\"");
      expect(`${snapshot}\n${journal}`).not.toContain("\"plaintext-json\"");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("is idempotent for already imported topic resolutions", async () => {
    const root = await mkdtemp(join(tmpdir(), "living-atlas-topic-review-import-idempotent-"));
    try {
      const packetPath = join(root, "packet.json");
      const resolutionPath = join(root, "resolutions.json");
      const keyringPath = join(root, "keyring.json");
      const graphDir = join(root, "graph");
      await writeFile(packetPath, JSON.stringify(fixturePacket(), null, 2));
      await writeFile(resolutionPath, JSON.stringify(fixtureResolutions(), null, 2));
      await new FileLocalKeyringStore(keyringPath).write(createDefaultLocalKeyring({
        authorityId,
        createdAt: "2026-06-24T00:00:00.000Z"
      }), "fixture-passphrase");

      await importTopicReviewResolutions({
        packetPath,
        resolutionPath,
        localGraphDir: graphDir,
        keyringPath,
        keyringPassphrase: "fixture-passphrase",
        authorityId,
        recordedAt: "2026-06-24T00:02:00.000Z"
      });
      const second = await importTopicReviewResolutions({
        packetPath,
        resolutionPath,
        localGraphDir: graphDir,
        keyringPath,
        keyringPassphrase: "fixture-passphrase",
        authorityId,
        recordedAt: "2026-06-24T00:03:00.000Z"
      });

      expect(second.import_totals).toMatchObject({
        created_objects: 0,
        already_existing_objects: 2,
        failed_objects: 0
      });
      expect(second.graph_status.object_count).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("can update existing topic review objects when explicitly requested", async () => {
    const root = await mkdtemp(join(tmpdir(), "living-atlas-topic-review-import-update-"));
    try {
      const packetPath = join(root, "packet.json");
      const resolutionPath = join(root, "resolutions.json");
      const keyringPath = join(root, "keyring.json");
      const graphDir = join(root, "graph");
      await writeFile(packetPath, JSON.stringify(fixturePacket(), null, 2));
      await writeFile(resolutionPath, JSON.stringify(fixtureResolutions(), null, 2));
      await new FileLocalKeyringStore(keyringPath).write(createDefaultLocalKeyring({
        authorityId,
        createdAt: "2026-06-24T00:00:00.000Z"
      }), "fixture-passphrase");

      await importTopicReviewResolutions({
        packetPath,
        resolutionPath,
        localGraphDir: graphDir,
        keyringPath,
        keyringPassphrase: "fixture-passphrase",
        authorityId,
        recordedAt: "2026-06-24T00:02:00.000Z"
      });
      const updated = await importTopicReviewResolutions({
        packetPath,
        resolutionPath,
        localGraphDir: graphDir,
        keyringPath,
        keyringPassphrase: "fixture-passphrase",
        authorityId,
        recordedAt: "2026-06-24T00:04:00.000Z",
        updateExisting: true
      });

      expect(updated.import_totals).toMatchObject({
        created_objects: 0,
        updated_existing_objects: 2,
        already_existing_objects: 0,
        failed_objects: 0
      });
      expect(updated.object_refs.every((ref) => ref.import_status === "updated-existing")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
