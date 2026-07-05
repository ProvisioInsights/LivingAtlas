import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultLocalKeyring, FileLocalKeyringStore } from "@living-atlas/local-keyring";
import { describe, expect, it } from "vitest";
import { buildOfferingItemReviewGroupedPacket } from "./logseq-offering-item-review-grouped-packet";
import { buildOfferingItemReviewPacket } from "./logseq-offering-item-review-packet";
import { importOfferingItemReviewResolutions } from "./logseq-offering-item-review-local-import";
import { OfferingItemReviewResolutionMapSchema } from "./logseq-offering-item-review-report";

const authorityId = "la_authority_fixture0001";

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

function fixtureGroupedPacket() {
  const packet = buildOfferingItemReviewPacket({
    pathRedactionSecret: "fixture-path-redaction-secret-0001",
    sourceMode: "markdown-only",
    generatedAt: "2026-06-24T00:00:00.000Z",
    files: [
      {
        source_path: "pages/Synthetic Offering.md",
        source_kind: "logseq",
        markdown: [
          "type:: product",
          "provider:: [[Synthetic Vendor]]",
          "- Synthetic receipt for a subscription renewal from Synthetic Vendor."
        ].join("\n")
      }
    ]
  });
  return buildOfferingItemReviewGroupedPacket({
    packet,
    generatedAt: "2026-06-24T00:01:00.000Z"
  });
}

function fixtureResolutionMap(groupedPacket: ReturnType<typeof fixtureGroupedPacket>) {
  const explicit = groupedPacket.groups.find((group) => group.kind === "explicit-offering-or-item") ?? groupedPacket.groups[0]!;
  const deferred = groupedPacket.groups.find((group) => group.kind !== explicit.kind) ?? groupedPacket.groups[1]!;
  return OfferingItemReviewResolutionMapSchema.parse({
    resolution_schema: "living-atlas-logseq-offering-item-review-resolution-map:v1",
    plaintext_policy: "local-private-offering-item-review-resolution-map",
    generated_at: "2026-06-24T00:02:00.000Z",
    resolutions: [
      {
        group_id: explicit.group_id,
        group_hash: explicit.group_hash,
        decision: "promote",
        confidence: "high",
        normalized_facts: [
          {
            fact_kind: "endpoint",
            endpoint: {
              object_id: "la_object_offeringfixture0001",
              type: "offering",
              subtype: "service",
              name: "Synthetic Offering Alpha",
              aliases: ["Synthetic Offering Alias"],
              access_class: "local-private",
              source_ref: explicit.group_hash,
              confidence: "high",
              created_at: "2026-06-24T00:02:00.000Z",
              updated_at: "2026-06-24T00:02:00.000Z"
            }
          },
          {
            fact_kind: "edge",
            edge: {
              edge_id: "la_edge_offeredbyfixture0001",
              source_object_id: "la_object_offeringfixture0001",
              source_type: "offering",
              target_object_id: "la_object_vendorfixture0001",
              target_type: "organization",
              predicate: "offered-by",
              valid_from: "2026-06-24",
              status: "active",
              confidence: "high",
              source: explicit.group_hash,
              attrs: {
                note: "Synthetic edge note should be encrypted."
              }
            }
          }
        ]
      },
      {
        group_id: deferred.group_id,
        group_hash: deferred.group_hash,
        decision: "defer",
        confidence: "high",
        normalized_facts: []
      }
    ]
  });
}

describe("Logseq offering/item review local import", () => {
  it("writes promoted facts and terminal decisions as encrypted local graph objects", async () => {
    const root = await mkdtemp(join(tmpdir(), "living-atlas-offering-item-import-"));
    try {
      const groupedPacket = fixtureGroupedPacket();
      const resolutionMap = fixtureResolutionMap(groupedPacket);
      const packetPath = join(root, "groups.json");
      const resolutionPath = join(root, "resolutions.json");
      const keyringPath = join(root, "keyring.json");
      const graphDir = join(root, "graph");
      const ledgerPath = join(root, "ledger.json");
      await writeFile(packetPath, JSON.stringify(groupedPacket, null, 2));
      await writeFile(resolutionPath, JSON.stringify(resolutionMap, null, 2));
      await new FileLocalKeyringStore(keyringPath).write(createDefaultLocalKeyring({
        authorityId,
        createdAt: "2026-06-24T00:00:00.000Z"
      }), "fixture-passphrase");

      const ledger = await importOfferingItemReviewResolutions({
        groupedPacketPath: packetPath,
        resolutionPath,
        localGraphDir: graphDir,
        keyringPath,
        keyringPassphrase: "fixture-passphrase",
        authorityId,
        ledgerPath,
        recordedAt: "2026-06-24T00:03:00.000Z"
      });

      expect(ledger.resolution_totals).toMatchObject({
        promote_count: 1,
        defer_count: 1,
        normalized_fact_count: 2
      });
      expect(ledger.import_totals).toMatchObject({
        created_objects: 3,
        promoted_objects: 2,
        quarantine_objects: 1,
        failed_objects: 0
      });
      expect(ledger.sync.attempted).toBe(false);
      expect(ledger.graph_status.plaintext_persistence).toBe("encrypted");

      const snapshot = await readTextIfExists(join(graphDir, "snapshot.json"));
      const journal = await readFile(join(graphDir, "journal.jsonl"), "utf8");
      const ledgerText = await readFile(ledgerPath, "utf8");
      for (const output of [snapshot, journal, ledgerText, JSON.stringify(ledger)]) {
        expect(output).not.toContain("Synthetic Offering Alpha");
        expect(output).not.toContain("Synthetic Offering Alias");
        expect(output).not.toContain("Synthetic edge note");
        expect(output).not.toContain("Synthetic receipt");
        expect(output).not.toContain("Synthetic Vendor");
      }
      expect(`${snapshot}\n${journal}`).toContain("\"ciphertext-inline\"");
      expect(`${snapshot}\n${journal}`).not.toContain("\"plaintext-json\"");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("is idempotent for already imported offering/item resolutions", async () => {
    const root = await mkdtemp(join(tmpdir(), "living-atlas-offering-item-import-idempotent-"));
    try {
      const groupedPacket = fixtureGroupedPacket();
      const resolutionMap = fixtureResolutionMap(groupedPacket);
      const packetPath = join(root, "groups.json");
      const resolutionPath = join(root, "resolutions.json");
      const keyringPath = join(root, "keyring.json");
      const graphDir = join(root, "graph");
      await writeFile(packetPath, JSON.stringify(groupedPacket, null, 2));
      await writeFile(resolutionPath, JSON.stringify(resolutionMap, null, 2));
      await new FileLocalKeyringStore(keyringPath).write(createDefaultLocalKeyring({
        authorityId,
        createdAt: "2026-06-24T00:00:00.000Z"
      }), "fixture-passphrase");

      await importOfferingItemReviewResolutions({
        groupedPacketPath: packetPath,
        resolutionPath,
        localGraphDir: graphDir,
        keyringPath,
        keyringPassphrase: "fixture-passphrase",
        authorityId,
        recordedAt: "2026-06-24T00:03:00.000Z"
      });
      const second = await importOfferingItemReviewResolutions({
        groupedPacketPath: packetPath,
        resolutionPath,
        localGraphDir: graphDir,
        keyringPath,
        keyringPassphrase: "fixture-passphrase",
        authorityId,
        recordedAt: "2026-06-24T00:04:00.000Z"
      });

      expect(second.import_totals).toMatchObject({
        created_objects: 0,
        already_existing_objects: 3,
        failed_objects: 0
      });
      expect(second.graph_status.object_count).toBe(3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
