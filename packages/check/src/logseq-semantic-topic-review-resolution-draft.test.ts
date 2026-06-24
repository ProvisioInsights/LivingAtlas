import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildTopicReviewResolutionDraft,
  buildTopicReviewResolutionDraftReport
} from "./logseq-semantic-topic-review-resolution-draft";
import { SemanticTopicReviewPacketSchema } from "./logseq-semantic-topic-review-packet";

const packet = SemanticTopicReviewPacketSchema.parse({
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
      target_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      target_value: "Synthetic Topic Alpha",
      occurrence_count: 1,
      source_refs: ["la_source_aaaaaaaaaaaaaaaaaaaaaaaa"]
    },
    {
      reason_code: "plain-tag-topic-review",
      target_hash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      target_value: "Synthetic Topic Beta",
      occurrence_count: 2,
      source_refs: ["la_source_bbbbbbbbbbbbbbbbbbbbbbbb"]
    }
  ]
});

describe("Logseq semantic topic review resolution draft", () => {
  it("creates a conservative all-defer resolution map without plaintext in the report", () => {
    const draft = buildTopicReviewResolutionDraft({
      packet,
      generatedAt: "2026-06-24T00:01:00.000Z"
    });
    const report = buildTopicReviewResolutionDraftReport({
      packet,
      draft,
      outputWritten: false
    });

    expect(draft.resolutions).toEqual([
      expect.objectContaining({ decision: "defer", target_hash: packet.groups[0]?.target_hash }),
      expect.objectContaining({ decision: "defer", target_hash: packet.groups[1]?.target_hash })
    ]);
    expect(report.draft).toMatchObject({
      resolution_count: 2,
      promote_topic_count: 0,
      defer_count: 2,
      reject_count: 0
    });
    expect(JSON.stringify(report)).not.toContain("Synthetic Topic Alpha");
    expect(JSON.stringify(report)).not.toContain("Synthetic Topic Beta");
    expect(JSON.stringify(report)).not.toContain("la_source_aaaaaaaa");
  });

  it("writes a private draft through the CLI", async () => {
    const root = await mkdtemp(join(tmpdir(), "living-atlas-topic-resolution-draft-"));
    try {
      const packetPath = join(root, "packet.json");
      const outputPath = join(root, "private", "resolutions.json");
      await writeFile(packetPath, JSON.stringify(packet, null, 2));

      const { spawnSync } = await import("node:child_process");
      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", "packages/check/src/logseq-semantic-topic-review-resolution-draft.ts"],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            LIVING_ATLAS_LOGSEQ_TOPIC_REVIEW_RESOLUTION_DRAFT_ACK: "write-local-private-topic-review-resolution-draft",
            LIVING_ATLAS_LOGSEQ_TOPIC_REVIEW_PACKET_PATH: packetPath,
            LIVING_ATLAS_LOGSEQ_TOPIC_REVIEW_RESOLUTION_PATH: outputPath
          },
          encoding: "utf8"
        }
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("\"defer_count\": 2");
      expect(result.stdout).not.toContain("Synthetic Topic");
      const output = await readFile(outputPath, "utf8");
      expect(output).toContain("defer");
      expect(output).not.toContain("Synthetic Topic");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
