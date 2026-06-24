import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSemanticTopicReviewPacket,
  SemanticTopicReviewPacketSchema
} from "./logseq-semantic-topic-review-packet";

describe("Logseq semantic topic review packet", () => {
  it("groups topic candidates from tags and hash tags without source paths", () => {
    const packet = buildSemanticTopicReviewPacket({
      pathRedactionSecret: "fixture-path-redaction-secret-0001",
      sourceMode: "logseq-notes",
      generatedAt: "2026-06-24T00:00:00.000Z",
      files: [
        {
          source_kind: "logseq",
          source_path: "pages/Synthetic Source A.md",
          markdown: [
            "tags:: #alpha, beta, [[Synthetic Theme]], [[Synthetic Counterparty]]-cohort",
            "",
            "- Body #bodytag"
          ].join("\n")
        },
        {
          source_kind: "logseq",
          source_path: "pages/Synthetic Source B.md",
          markdown: [
            "tags:: beta",
            "",
            "- More #alpha"
          ].join("\n")
        }
      ]
    });

    expect(SemanticTopicReviewPacketSchema.safeParse(packet).success).toBe(true);
    expect(packet.packet_schema).toBe("living-atlas-logseq-topic-review-packet:v1");
    expect(packet.plaintext_policy).toBe("local-private-topic-review-packet");
    expect(packet.covered_file_count).toBe(2);
    expect(packet.candidate_count).toBe(7);
    expect(packet.excluded_suffix_tag_count).toBe(1);
    expect(packet.reason_counts).toEqual({
      "hash-tag-topic-review": 3,
      "plain-tag-topic-review": 3,
      "wikilink-tag-topic-review": 1
    });
    expect(packet.groups.some((group) => group.occurrence_count === 2)).toBe(true);
    expect(JSON.stringify(packet)).not.toContain("Synthetic Source A.md");
    expect(JSON.stringify(packet)).not.toContain("pages/");
  });

  it("writes through the CLI only to a private output path", async () => {
    const root = await mkdtemp(join(tmpdir(), "living-atlas-topic-review-"));
    const output = join(root, "private", "topic-review.json");
    try {
      await mkdir(join(root, "pages"), { recursive: true });
      await writeFile(join(root, "pages", "Synthetic Topic Source.md"), "tags:: alpha\n\n- #beta\n");

      const { spawnSync } = await import("node:child_process");
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "packages/check/src/logseq-semantic-topic-review-packet.ts"
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            LIVING_ATLAS_LOGSEQ_TOPIC_REVIEW_PACKET_ACK: "write-local-private-topic-review-packet",
            LIVING_ATLAS_LOGSEQ_TOPIC_REVIEW_PACKET_PATH: output,
            LIVING_ATLAS_REAL_MARKDOWN_ROOT: root,
            LIVING_ATLAS_REAL_DATA_PATH_REDACTION_SECRET: "fixture-path-redaction-secret-0001",
            LIVING_ATLAS_LOGSEQ_SEMANTIC_SOURCE_MODE: "markdown-only"
          },
          encoding: "utf8"
        }
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("\"candidate_count\": 2");
      expect(result.stdout).not.toContain("alpha");
      expect(result.stdout).not.toContain("Synthetic Topic Source");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
