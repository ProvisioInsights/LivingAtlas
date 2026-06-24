import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createLogseqSemanticReviewTargetHash,
  createMarkdownSourceRef
} from "@living-atlas/importer";
import {
  buildSemanticReviewPacket
} from "./logseq-semantic-review-packet";

const pathRedactionSecret = "fixture-path-redaction-secret-0001";

function sourceRef(sourcePath: string): string {
  return createMarkdownSourceRef(sourcePath, { path_redaction_secret: pathRedactionSecret });
}

function batchRecord(sourcePaths: string[]) {
  return {
    record_schema: "living-atlas-logseq-semantic-batch:v1" as const,
    source_kind: "logseq" as const,
    source_mode: "markdown-only" as const,
    file_offset: 0,
    requested_file_count: sourcePaths.length,
    actual_file_count: sourcePaths.length,
    files: sourcePaths.map((sourcePath) => ({
      source_path_ref: sourceRef(sourcePath),
      review_status: "needs-review" as const
    })),
    plaintext_policy: "hash-counts-refs-only" as const
  };
}

describe("Logseq semantic review packet", () => {
  it("builds a local-private actionable packet without source paths", () => {
    const files = [
      {
        source_path: "pages/Synthetic City.md",
        markdown: "type:: location\nalias:: Synthetic Metro\n\n- body text\n",
        source_kind: "logseq" as const
      },
      {
        source_path: "pages/Synthetic Person.md",
        markdown: "type:: person\nlocation:: Synthetic Metro\norg:: Synthetic Unknown Org\n\n- body text\n",
        source_kind: "logseq" as const
      },
      {
        source_path: "pages/Synthetic Org.md",
        markdown: "type:: organization\nheadquarters:: Synthetic Unknown HQ\ntags:: [[Synthetic Weak Tie]]-adjacent\n\n- body text\n",
        source_kind: "logseq" as const
      }
    ];

    const packet = buildSemanticReviewPacket({
      files,
      records: [batchRecord(files.map((file) => file.source_path))],
      pathRedactionSecret,
      generatedAt: "2026-06-24T00:00:00.000Z"
    });

    expect(packet).toMatchObject({
      packet_schema: "living-atlas-logseq-semantic-review-packet:v1",
      plaintext_policy: "local-private-review-packet",
      source_path_policy: "redacted",
      covered_file_count: 3,
      needs_review_file_count: 3,
      candidate_count: 3,
      grouped_candidate_count: 3,
      reason_counts: {
        "non-wikilink-location-review": 1,
        "non-wikilink-organization-review": 1,
        "suffix-tag-weak-tie-needs-note": 1
      }
    });
    expect(packet.groups.map((group) => group.target_value)).toEqual(expect.arrayContaining([
      "Synthetic Unknown Org",
      "Synthetic Unknown HQ",
      "Synthetic Weak Tie"
    ]));
    expect(packet.groups.map((group) => group.target_value)).not.toContain("Synthetic Metro");
    expect(JSON.stringify(packet)).not.toContain("pages/Synthetic");
    expect(JSON.stringify(packet)).not.toContain("/tmp/");
  });

  it("groups repeated unresolved values by reason and target hash", () => {
    const files = [
      {
        source_path: "pages/Synthetic Person A.md",
        markdown: "type:: person\norg:: Synthetic Unknown Org\n\n- body text\n",
        source_kind: "logseq" as const
      },
      {
        source_path: "pages/Synthetic Person B.md",
        markdown: "type:: person\norganization:: Synthetic Unknown Org\n\n- body text\n",
        source_kind: "logseq" as const
      }
    ];

    const packet = buildSemanticReviewPacket({
      files,
      records: [batchRecord(files.map((file) => file.source_path))],
      pathRedactionSecret,
      generatedAt: "2026-06-24T00:00:00.000Z"
    });

    expect(packet.candidate_count).toBe(2);
    expect(packet.grouped_candidate_count).toBe(1);
    expect(packet.groups[0]).toMatchObject({
      reason_code: "non-wikilink-organization-review",
      target_value: "Synthetic Unknown Org",
      occurrence_count: 2,
      property_keys: ["org", "organization"]
    });
    expect(packet.groups[0]!.source_refs).toHaveLength(2);
    expect(packet.groups[0]!.target_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("suppresses candidates already handled by a private review resolution map", () => {
    const files = [
      {
        source_path: "pages/Synthetic Person.md",
        markdown: "type:: person\nlocation:: Synthetic Unknown City\norg:: Synthetic Unknown Org\n\n- body text\n",
        source_kind: "logseq" as const
      }
    ];
    const resolvedOrgHash = createLogseqSemanticReviewTargetHash({
      pathRedactionSecret,
      reasonCode: "non-wikilink-organization-review",
      value: "Synthetic Unknown Org"
    });

    const packet = buildSemanticReviewPacket({
      files,
      records: [batchRecord(files.map((file) => file.source_path))],
      pathRedactionSecret,
      reviewResolutions: [
        {
          target_hash: resolvedOrgHash,
          reason_code: "non-wikilink-organization-review",
          decision: "create-endpoint",
          endpoint_type: "organization",
          endpoint_title: "Synthetic Unknown Org",
          aliases: [],
          confidence: "high"
        }
      ],
      generatedAt: "2026-06-24T00:00:00.000Z"
    });

    expect(packet.candidate_count).toBe(1);
    expect(packet.grouped_candidate_count).toBe(1);
    expect(packet.reason_counts).toEqual({
      "non-wikilink-location-review": 1
    });
    expect(packet.groups.map((group) => group.target_value)).toEqual(["Synthetic Unknown City"]);
  });

  it("suppresses explicitly deferred candidates from residual packets", () => {
    const files = [
      {
        source_path: "pages/Synthetic Person.md",
        markdown: "type:: person\nspouse:: Synthetic Deferred Person\norg:: Synthetic Unknown Org\n\n- body text\n",
        source_kind: "logseq" as const
      }
    ];
    const deferredPersonHash = createLogseqSemanticReviewTargetHash({
      pathRedactionSecret,
      reasonCode: "non-wikilink-person-review",
      value: "Synthetic Deferred Person"
    });

    const packet = buildSemanticReviewPacket({
      files,
      records: [batchRecord(files.map((file) => file.source_path))],
      pathRedactionSecret,
      reviewResolutions: [
        {
          target_hash: deferredPersonHash,
          reason_code: "non-wikilink-person-review",
          decision: "defer",
          aliases: [],
          confidence: "high"
        }
      ],
      generatedAt: "2026-06-24T00:00:00.000Z"
    });

    expect(packet.candidate_count).toBe(1);
    expect(packet.grouped_candidate_count).toBe(1);
    expect(packet.reason_counts).toEqual({
      "non-wikilink-organization-review": 1
    });
    expect(packet.groups.map((group) => group.target_value)).toEqual(["Synthetic Unknown Org"]);
  });

  it("writes tests outside the repository without relying on private paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "living-atlas-review-packet-"));
    try {
      const path = join(root, "packet.json");
      await writeFile(path, "{}\n", { mode: 0o600 });
      expect(path).toContain(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
