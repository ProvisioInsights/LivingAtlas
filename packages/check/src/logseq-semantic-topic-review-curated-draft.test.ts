import { describe, expect, it } from "vitest";
import { SemanticTopicReviewPacketSchema } from "./logseq-semantic-topic-review-packet";
import {
  buildTopicReviewCuratedDraft,
  buildTopicReviewCuratedDraftReport
} from "./logseq-semantic-topic-review-curated-draft";

const hashA = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const hashB = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const hashC = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const hashD = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

const packet = SemanticTopicReviewPacketSchema.parse({
  packet_schema: "living-atlas-logseq-topic-review-packet:v1",
  plaintext_policy: "local-private-topic-review-packet",
  source_path_policy: "redacted",
  generated_at: "2026-06-24T00:00:00.000Z",
  source_mode: "logseq-notes",
  covered_file_count: 3,
  candidate_count: 7,
  grouped_candidate_count: 4,
  excluded_suffix_tag_count: 1,
  reason_counts: {
    "wikilink-tag-topic-review": 3,
    "plain-tag-topic-review": 2,
    "hash-tag-topic-review": 2
  },
  groups: [
    {
      reason_code: "wikilink-tag-topic-review",
      target_hash: hashA,
      target_value: "Synthetic Topic Alpha",
      occurrence_count: 3,
      source_refs: ["la_source_aaaaaaaaaaaaaaaaaaaaaaaa"]
    },
    {
      reason_code: "wikilink-tag-topic-review",
      target_hash: hashB,
      target_value: "Synthetic Topic Beta",
      occurrence_count: 1,
      source_refs: ["la_source_bbbbbbbbbbbbbbbbbbbbbbbb"]
    },
    {
      reason_code: "plain-tag-topic-review",
      target_hash: hashC,
      target_value: "synthetic-plain-tag",
      occurrence_count: 2,
      source_refs: ["la_source_cccccccccccccccccccccccc"]
    },
    {
      reason_code: "hash-tag-topic-review",
      target_hash: hashD,
      target_value: "recurring-hash-tag",
      occurrence_count: 2,
      source_refs: ["la_source_dddddddddddddddddddddddd"]
    }
  ]
});

describe("Logseq semantic topic curated draft", () => {
  it("promotes recurring wikilink tag topics and defers other default candidates", () => {
    const draft = buildTopicReviewCuratedDraft({
      packet,
      generatedAt: "2026-06-24T00:01:00.000Z"
    });

    expect(draft.resolutions).toHaveLength(4);
    expect(draft.resolutions.filter((resolution) => resolution.decision === "promote-topic")).toHaveLength(1);
    expect(draft.resolutions.filter((resolution) => resolution.decision === "defer")).toHaveLength(3);
    expect(draft.resolutions.find((resolution) => resolution.target_hash === hashA)).toMatchObject({
      decision: "promote-topic",
      topic_title: "Synthetic Topic Alpha",
      subtype: "theme",
      confidence: "high"
    });
    expect(draft.resolutions.find((resolution) => resolution.target_hash === hashB)).toMatchObject({
      decision: "defer",
      confidence: "high"
    });
  });

  it("can be configured to promote additional explicit tag classes", () => {
    const draft = buildTopicReviewCuratedDraft({
      packet,
      minOccurrences: 2,
      promoteReasons: new Set(["wikilink-tag-topic-review", "plain-tag-topic-review"]),
      subtype: "domain",
      generatedAt: "2026-06-24T00:01:00.000Z"
    });

    expect(draft.resolutions.filter((resolution) => resolution.decision === "promote-topic")).toHaveLength(2);
    expect(draft.resolutions.find((resolution) => resolution.target_hash === hashC)).toMatchObject({
      decision: "promote-topic",
      topic_title: "synthetic-plain-tag",
      subtype: "domain"
    });
  });

  it("reports count-only draft results without leaking private labels", () => {
    const draft = buildTopicReviewCuratedDraft({
      packet,
      generatedAt: "2026-06-24T00:01:00.000Z"
    });
    const report = buildTopicReviewCuratedDraftReport({
      packet,
      draft,
      outputWritten: true,
      minOccurrences: 2,
      promoteReasons: new Set(["wikilink-tag-topic-review"]),
      subtype: "theme"
    });

    expect(report.report_schema).toBe("living-atlas-logseq-topic-review-curated-draft-report:v1");
    expect(report.draft.promote_topic_count).toBe(1);
    expect(report.draft.defer_count).toBe(3);
    expect(report.draft.promoted_by_reason_code).toEqual({ "wikilink-tag-topic-review": 1 });
    expect(report.draft.deferred_by_occurrence_bucket).toEqual({ "1": 1, "2-3": 2 });
    expect(JSON.stringify(report)).not.toContain("Synthetic Topic Alpha");
    expect(JSON.stringify(report)).not.toContain("synthetic-plain-tag");
  });
});
