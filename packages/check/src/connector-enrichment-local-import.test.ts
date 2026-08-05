import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultLocalKeyring, FileLocalKeyringStore } from "@living-atlas/local-keyring";
import { describe, expect, it } from "vitest";
import { importConnectorEnrichmentPacket } from "./connector-enrichment-local-import";

const authorityId = "la_authority_fixture0001";
const hashA = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const hashB = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const hashC = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const hashD = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

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

function fixturePacket() {
  return {
    packet_schema: "living-atlas-connector-enrichment-packet:v1",
    plaintext_policy: "local-private-connector-enrichment-packet",
    source_path_policy: "connector-id-hash-only",
    generated_at: "2026-06-24T00:00:00.000Z",
    connector_sources: ["outlook-calendar", "fireflies"],
    candidates: [
      {
        candidate_id: "la_enrich_candidate_import0001",
        source: {
          connector: "outlook-calendar",
          source_id_hash: hashA,
          source_time: "2026-06-23T18:00:00.000Z",
          fetched_at: "2026-06-24T00:00:00.000Z",
          evidence_hash: hashB,
          evidence_kind: "calendar-event"
        },
        proposed_fact: {
          kind: "occurrence",
          endpoint_type: "occurrence",
          confidence: "high",
          local_private_payload: {
            title: "Fixture Connector Event Alpha",
            participant: "Fixture Connector Person Beta",
            scheduled_start: "2026-06-23T18:00:00.000Z",
            scheduled_end: "2026-06-23T18:30:00.000Z",
            timezone: "America/Chicago"
          }
        },
        decision: "promote",
        plaintext_evidence: "Fixture connector evidence gamma must stay encrypted."
      },
      {
        candidate_id: "la_enrich_candidate_import0002",
        source: {
          connector: "fireflies",
          source_id_hash: hashC,
          fetched_at: "2026-06-24T00:00:00.000Z",
          evidence_hash: hashD,
          evidence_kind: "metadata"
        },
        proposed_fact: {
          kind: "source-note",
          confidence: "medium",
          local_private_payload: {
            title: "Fixture Held Evidence Delta"
          }
        },
        decision: "defer",
        rationale: "Fixture held rationale epsilon must stay encrypted."
      }
    ]
  } as const;
}

describe("connector enrichment local import", () => {
  it("writes promoted and held connector candidates as encrypted local graph objects", async () => {
    const root = await mkdtemp(join(tmpdir(), "living-atlas-connector-import-"));
    try {
      const packetPath = join(root, "packet.json");
      const keyringPath = join(root, "keyring.json");
      const graphDir = join(root, "graph");
      const ledgerPath = join(root, "ledger.json");
      await writeFile(packetPath, JSON.stringify(fixturePacket(), null, 2));
      await new FileLocalKeyringStore(keyringPath).write(createDefaultLocalKeyring({
        authorityId,
        createdAt: "2026-06-24T00:00:00.000Z"
      }), "fixture-passphrase");

      const ledger = await importConnectorEnrichmentPacket({
        packetPath,
        localGraphDir: graphDir,
        keyringPath,
        keyringPassphrase: "fixture-passphrase",
        authorityId,
        ledgerPath,
        recordedAt: "2026-06-24T00:00:00.000Z"
      });

      expect(ledger.import_totals).toMatchObject({
        created_objects: 2,
        promoted_objects: 1,
        quarantine_objects: 1,
        failed_objects: 0
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
        expect(output).not.toContain("Fixture Connector Event Alpha");
        expect(output).not.toContain("Fixture Connector Person Beta");
        expect(output).not.toContain("Fixture connector evidence gamma");
        expect(output).not.toContain("Fixture Held Evidence Delta");
        expect(output).not.toContain("Fixture held rationale epsilon");
      }
      expect(`${snapshot}\n${journal}`).toContain("\"ciphertext-inline\"");
      expect(`${snapshot}\n${journal}`).not.toContain("\"plaintext-json\"");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("is idempotent for an already imported packet", async () => {
    const root = await mkdtemp(join(tmpdir(), "living-atlas-connector-import-idempotent-"));
    try {
      const packetPath = join(root, "packet.json");
      const keyringPath = join(root, "keyring.json");
      const graphDir = join(root, "graph");
      await writeFile(packetPath, JSON.stringify(fixturePacket(), null, 2));
      await new FileLocalKeyringStore(keyringPath).write(createDefaultLocalKeyring({
        authorityId,
        createdAt: "2026-06-24T00:00:00.000Z"
      }), "fixture-passphrase");

      await importConnectorEnrichmentPacket({
        packetPath,
        localGraphDir: graphDir,
        keyringPath,
        keyringPassphrase: "fixture-passphrase",
        authorityId,
        recordedAt: "2026-06-24T00:00:00.000Z"
      });
      const second = await importConnectorEnrichmentPacket({
        packetPath,
        localGraphDir: graphDir,
        keyringPath,
        keyringPassphrase: "fixture-passphrase",
        authorityId,
        recordedAt: "2026-06-24T00:00:00.000Z"
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

  it("can update existing connector objects when explicitly requested", async () => {
    const root = await mkdtemp(join(tmpdir(), "living-atlas-connector-import-update-"));
    try {
      const packetPath = join(root, "packet.json");
      const keyringPath = join(root, "keyring.json");
      const graphDir = join(root, "graph");
      await writeFile(packetPath, JSON.stringify(fixturePacket(), null, 2));
      await new FileLocalKeyringStore(keyringPath).write(createDefaultLocalKeyring({
        authorityId,
        createdAt: "2026-06-24T00:00:00.000Z"
      }), "fixture-passphrase");

      await importConnectorEnrichmentPacket({
        packetPath,
        localGraphDir: graphDir,
        keyringPath,
        keyringPassphrase: "fixture-passphrase",
        authorityId,
        recordedAt: "2026-06-24T00:00:00.000Z"
      });
      const updated = await importConnectorEnrichmentPacket({
        packetPath,
        localGraphDir: graphDir,
        keyringPath,
        keyringPassphrase: "fixture-passphrase",
        authorityId,
        recordedAt: "2026-06-24T00:01:00.000Z",
        updateExisting: true
      });

      expect(updated.import_totals).toMatchObject({
        created_objects: 0,
        updated_existing_objects: 2,
        already_existing_objects: 0,
        failed_objects: 0
      });
      expect(updated.object_refs.every((ref) => ref.import_status === "updated-existing")).toBe(true);
      expect(updated.graph_status.object_count).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  /**
   * A word the ratified table does not name must be REFUSED, never filed under
   * the modal value. `meeting` was the default, so an unmapped kind promoted as
   * a plausible-looking meeting and nothing counted the misclassification — the
   * exact defect the migration path states its Rule A to prevent, with the two
   * paths holding opposite answers to one ratified question.
   */
  it("quarantines an occurrence whose kind the ratified vocabulary does not name", async () => {
    const root = await mkdtemp(join(tmpdir(), "living-atlas-connector-import-unmapped-"));
    try {
      const packetPath = join(root, "packet.json");
      const keyringPath = join(root, "keyring.json");
      const graphDir = join(root, "graph");
      const packet = fixturePacket() as unknown as {
        candidates: Array<{ proposed_fact: { local_private_payload: Record<string, unknown> } }>;
      };
      const first = packet.candidates[0];
      if (!first) throw new Error("fixture packet lost its occurrence candidate");
      first.proposed_fact.local_private_payload.occurrence_kind = "symposium";

      await writeFile(packetPath, JSON.stringify(packet, null, 2));
      await new FileLocalKeyringStore(keyringPath).write(createDefaultLocalKeyring({
        authorityId,
        createdAt: "2026-06-24T00:00:00.000Z"
      }), "fixture-passphrase");

      const ledger = await importConnectorEnrichmentPacket({
        packetPath,
        localGraphDir: graphDir,
        keyringPath,
        keyringPassphrase: "fixture-passphrase",
        authorityId,
        recordedAt: "2026-06-24T00:00:00.000Z"
      });

      expect(ledger.import_totals).toMatchObject({
        promoted_objects: 0,
        quarantine_objects: 2,
        // Countable, and counted apart from the low-confidence holds: this one is
        // waiting on a vocabulary decision, not on evidence.
        unmapped_occurrence_kind: 1
      });
      expect(ledger.object_refs[0]).toMatchObject({ import_status: "quarantined", access_class: "quarantine" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  /**
   * The G5 backfill, and the reason the refusal above does not swallow every
   * calendar event: a candidate that names who was there is a meeting on the
   * evidence, which is a different act from defaulting a word nobody supplied.
   */
  it("backfills meeting from participant evidence when the connector named no kind", async () => {
    const root = await mkdtemp(join(tmpdir(), "living-atlas-connector-import-backfill-"));
    try {
      const packetPath = join(root, "packet.json");
      const keyringPath = join(root, "keyring.json");
      const graphDir = join(root, "graph");
      await writeFile(packetPath, JSON.stringify(fixturePacket(), null, 2));
      await new FileLocalKeyringStore(keyringPath).write(createDefaultLocalKeyring({
        authorityId,
        createdAt: "2026-06-24T00:00:00.000Z"
      }), "fixture-passphrase");

      const ledger = await importConnectorEnrichmentPacket({
        packetPath,
        localGraphDir: graphDir,
        keyringPath,
        keyringPassphrase: "fixture-passphrase",
        authorityId,
        recordedAt: "2026-06-24T00:00:00.000Z"
      });

      expect(ledger.import_totals).toMatchObject({ promoted_objects: 1, unmapped_occurrence_kind: 0 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
