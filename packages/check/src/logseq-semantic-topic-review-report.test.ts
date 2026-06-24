import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildTopicReviewReport,
  buildTopicReviewReportFromPaths,
  TopicReviewResolutionMapSchema
} from "./logseq-semantic-topic-review-report";
import { SemanticTopicReviewPacketSchema } from "./logseq-semantic-topic-review-packet";

const hashA = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const hashB = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const hashC = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

const packet = SemanticTopicReviewPacketSchema.parse({
  packet_schema: "living-atlas-logseq-topic-review-packet:v1",
  plaintext_policy: "local-private-topic-review-packet",
  source_path_policy: "redacted",
  generated_at: "2026-06-24T00:00:00.000Z",
  source_mode: "logseq-notes",
  covered_file_count: 2,
  candidate_count: 4,
  grouped_candidate_count: 2,
  excluded_suffix_tag_count: 1,
  reason_counts: {
    "hash-tag-topic-review": 2,
    "plain-tag-topic-review": 2
  },
  groups: [
    {
      reason_code: "hash-tag-topic-review",
      target_hash: hashA,
      target_value: "Synthetic Topic Alpha",
      occurrence_count: 2,
      source_refs: ["la_source_aaaaaaaaaaaaaaaaaaaaaaaa"]
    },
    {
      reason_code: "plain-tag-topic-review",
      target_hash: hashB,
      target_value: "Synthetic Topic Beta",
      occurrence_count: 2,
      source_refs: ["la_source_bbbbbbbbbbbbbbbbbbbbbbbb"]
    }
  ]
});

describe("Logseq semantic topic review report", () => {
  it("summarizes unresolved private topic candidates without plaintext values", () => {
    const report = buildTopicReviewReport({ packet });

    expect(report.report_schema).toBe("living-atlas-logseq-topic-review-report:v1");
    expect(report.complete).toBe(true);
    expect(report.review_complete).toBe(false);
    expect(report.packet.candidate_count).toBe(4);
    expect(report.resolutions.provided).toBe(false);
    expect(report.resolutions.unresolved_group_count).toBe(2);
    expect(report.resolutions.unresolved_candidate_count).toBe(4);
    expect(JSON.stringify(report)).not.toContain("Synthetic Topic Alpha");
    expect(JSON.stringify(report)).not.toContain("Synthetic Topic Beta");
    expect(JSON.stringify(report)).not.toContain("la_source_aaaaaaaa");
  });

  it("counts complete high-confidence topic resolutions", () => {
    const resolutionMap = TopicReviewResolutionMapSchema.parse({
      resolution_schema: "living-atlas-logseq-topic-review-resolution-map:v1",
      plaintext_policy: "local-private-topic-review-resolution-map",
      generated_at: "2026-06-24T00:01:00.000Z",
      resolutions: [
        {
          target_hash: hashA,
          reason_code: "hash-tag-topic-review",
          decision: "promote-topic",
          topic_title: "Synthetic Topic Alpha",
          subtype: "theme",
          aliases: ["Synthetic Alias"],
          confidence: "high"
        },
        {
          target_hash: hashB,
          reason_code: "plain-tag-topic-review",
          decision: "defer",
          confidence: "high"
        }
      ]
    });

    const report = buildTopicReviewReport({ packet, resolutionMap, requireComplete: true });

    expect(report.complete).toBe(true);
    expect(report.review_complete).toBe(true);
    expect(report.resolutions.resolution_count).toBe(2);
    expect(report.resolutions.matched_resolution_count).toBe(2);
    expect(report.resolutions.promoted_topic_count).toBe(1);
    expect(report.resolutions.deferred_count).toBe(1);
    expect(report.resolutions.unresolved_group_count).toBe(0);
    expect(report.resolutions.by_subtype).toEqual({ theme: 1 });
    expect(JSON.stringify(report)).not.toContain("Synthetic Topic Alpha");
    expect(JSON.stringify(report)).not.toContain("Synthetic Alias");
  });

  it("rejects non-promote resolutions that carry topic names", () => {
    const parsed = TopicReviewResolutionMapSchema.safeParse({
      resolution_schema: "living-atlas-logseq-topic-review-resolution-map:v1",
      plaintext_policy: "local-private-topic-review-resolution-map",
      generated_at: "2026-06-24T00:01:00.000Z",
      resolutions: [
        {
          target_hash: hashA,
          reason_code: "hash-tag-topic-review",
          decision: "reject",
          topic_title: "Should Not Be Here",
          confidence: "high"
        }
      ]
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.some((issue) => issue.message.includes("must not carry"))).toBe(true);
  });

  it("fails reports with unknown resolution targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "living-atlas-topic-review-report-"));
    try {
      const packetPath = join(root, "packet.json");
      const resolutionPath = join(root, "resolutions.json");
      await writeFile(packetPath, JSON.stringify(packet, null, 2));
      await writeFile(resolutionPath, JSON.stringify({
        resolution_schema: "living-atlas-logseq-topic-review-resolution-map:v1",
        plaintext_policy: "local-private-topic-review-resolution-map",
        generated_at: "2026-06-24T00:01:00.000Z",
        resolutions: [
          {
            target_hash: hashC,
            reason_code: "hash-tag-topic-review",
            decision: "defer",
            confidence: "high"
          }
        ]
      }, null, 2));

      const report = await buildTopicReviewReportFromPaths({ packetPath, resolutionPath });

      expect(report.complete).toBe(false);
      expect(report.review_complete).toBe(false);
      expect(report.resolutions.unknown_target_resolution_count).toBe(1);
      expect(JSON.stringify(report)).not.toContain(root);
      expect(JSON.stringify(report)).not.toContain("Synthetic Topic");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
