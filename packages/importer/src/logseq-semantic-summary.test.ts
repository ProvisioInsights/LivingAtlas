import { describe, expect, it } from "vitest";
import { createLogseqSemanticKnowledgeSummary } from "./index";

const fixtureAuthorityId = "la_authority_fixture0001";

describe("Logseq semantic knowledge summary", () => {
  it("counts endpoint types, occurrences, topics, recurrence, edges, and quarantine without plaintext", () => {
    const files = [
      {
        source_path: "/tmp/living-atlas-fixtures/Synthetic Weekly Meeting.md",
        markdown: [
          "type:: occurrence",
          "subtype:: meeting",
          "occurred-on:: 2026-06-24",
          "scheduled-start:: 2026-06-24T14:00:00.000Z",
          "scheduled-end:: 2026-06-24T15:00:00.000Z",
          "timezone:: America/Chicago",
          "participants:: [[Person A]], [[Synthetic Org]]",
          "recurrence-set:: DTSTART;TZID=America/Chicago:20260624T090000\\nRRULE:FREQ=WEEKLY;BYDAY=WE",
          "duration:: PT1H",
          "",
          "- body text"
        ].join("\n"),
        source_kind: "logseq" as const
      },
      {
        source_path: "/tmp/living-atlas-fixtures/Synthetic Topic.md",
        markdown: "type:: topic\nsubtype:: theme\naliases:: Synthetic Theme\n\n- body text\n",
        source_kind: "logseq" as const
      },
      {
        source_path: "/tmp/living-atlas-fixtures/Topic Edge.md",
        markdown: "## Edges\n\n- [[Synthetic Topic]] (topic) discussed-at [[Synthetic Weekly Meeting]] (occurrence) from 2026-06-21\n",
        source_kind: "logseq" as const
      },
      {
        source_path: "/tmp/living-atlas-fixtures/Synthetic Org.md",
        markdown: "type:: org\ntags:: [[Synthetic Weak Tie]]-adjacent\n\n- body text\n",
        source_kind: "logseq" as const
      }
    ];

    const report = createLogseqSemanticKnowledgeSummary(files, {
      authority_id: fixtureAuthorityId,
      created_at: "2026-06-22T12:00:00.000Z",
      path_redaction_secret: "fixture-path-redaction-secret-0001"
    });

    expect(report).toMatchObject({
      report_schema: "living-atlas-logseq-semantic-knowledge-summary:v1",
      plaintext_policy: "counts-only",
      source_file_count: 4,
      occurrence_count: 1,
      occurrence_with_recurrence_count: 1,
      occurrence_with_timezone_count: 1,
      occurrence_with_participants_count: 1,
      topic_count: 1,
      edge_count: 1,
      quarantine_object_count: 1
    });
    expect(report.endpoint_type_counts).toMatchObject({
      occurrence: 1,
      topic: 1,
      organization: 1
    });
    expect(report.edge_predicate_counts).toEqual({
      "discussed-at": 1
    });
    expect(report.quarantine_reason_counts).toEqual({
      "suffix-tag-weak-tie-needs-note": 1
    });
    expect(report.semantic_kind_counts["typed-endpoint"]).toBe(3);
    expect(JSON.stringify(report)).not.toContain("Synthetic Weekly Meeting");
    expect(JSON.stringify(report)).not.toContain("Synthetic Topic");
    expect(JSON.stringify(report)).not.toContain("Synthetic Weak Tie");
  });
});
