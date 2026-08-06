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
        markdown: "type:: topic\naliases:: Synthetic Theme\n\n- body text\n",
        source_kind: "logseq" as const
      },
      {
        source_path: "/tmp/living-atlas-fixtures/Topic Edge.md",
        markdown: "## Edges\n\n- [[Synthetic Weekly Meeting]] (occurrence) about [[Synthetic Topic]] (topic) from 2026-06-21\n",
        source_kind: "logseq" as const
      },
      {
        source_path: "/tmp/living-atlas-fixtures/Synthetic Org.md",
        markdown: "type:: org\ntags:: [[Synthetic Weak Tie]]-adjacent\n\n- body text\n",
        source_kind: "logseq" as const
      },
      {
        source_path: "/tmp/living-atlas-fixtures/Synthetic Product.md",
        markdown: "type:: product\nprovider:: [[Synthetic Org]]\n\n- body text\n",
        source_kind: "logseq" as const
      },
      {
        source_path: "/tmp/living-atlas-fixtures/Synthetic Device.md",
        markdown: "type:: device\nproduct:: [[Synthetic Product]]\n\n- body text\n",
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
      source_file_count: 6,
      occurrence_count: 1,
      occurrence_with_recurrence_count: 1,
      occurrence_with_timezone_count: 1,
      occurrence_with_participants_count: 1,
      topic_count: 1,
      edge_count: 1,
      // The weak-tie suffix tag, PLUS the two classifications this import has
      // nowhere to put: `type:: product` resolves to `offering` and `type::
      // device` resolves to `item`, and in both cases the word is gone. They used
      // to vanish with no row and no count. `type:: org` adds none, because "org"
      // is a spelling of the type rather than a kind the type does not say.
      quarantine_object_count: 3
    });
    expect(report.endpoint_type_counts).toMatchObject({
      occurrence: 1,
      topic: 1,
      organization: 1,
      offering: 1,
      item: 1
    });
    expect(report.edge_predicate_counts).toEqual({
      about: 1
    });
    expect(report.quarantine_reason_counts).toEqual({
      "suffix-tag-weak-tie-needs-note": 1,
      // The countable half of ADR 0023's consequence. Ongoing import cannot yet
      // emit the `has-type` edge the ADR describes (OPEN-20), so the words the
      // endpoint record cannot carry are queued for review instead of dropped.
      "dropped-classification-review": 2
    });
    expect(report.semantic_kind_counts["typed-endpoint"]).toBe(5);
    expect(JSON.stringify(report)).not.toContain("Synthetic Weekly Meeting");
    expect(JSON.stringify(report)).not.toContain("Synthetic Topic");
    expect(JSON.stringify(report)).not.toContain("Synthetic Weak Tie");
  });

  /**
   * ADR 0023 said the retired subtype "is not lost, it moves to a has-type edge".
   * On ongoing import it does not: nothing here mints the topic node such an edge
   * would need (OPEN-20). So the word is counted instead of carried, and this is
   * the test that says which words count and which do not — a spelling of the
   * type loses nothing and must not produce a row, or the queue fills with noise
   * and nobody reads it.
   */
  it("counts a dropped classification and not a mere spelling of the type", () => {
    const report = createLogseqSemanticKnowledgeSummary(
      [
        // Two words gone: `saas` is not what `offering` says, and `threat-actor`
        // is not what `organization` says.
        {
          source_path: "/tmp/living-atlas-fixtures/Synthetic Platform.md",
          markdown: "type:: saas\n\n- body text\n",
          source_kind: "logseq" as const
        },
        {
          source_path: "/tmp/living-atlas-fixtures/Synthetic Actor.md",
          markdown: "type:: organization\nsubtype:: threat-actor\n\n- body text\n",
          source_kind: "logseq" as const
        },
        // Nothing gone: "org" and "organization" are one word twice.
        {
          source_path: "/tmp/living-atlas-fixtures/Synthetic Company.md",
          markdown: "type:: org\n\n- body text\n",
          source_kind: "logseq" as const
        },
        // Nothing gone: an occurrence's subtype survives as a real enum value.
        {
          source_path: "/tmp/living-atlas-fixtures/Synthetic Standup.md",
          markdown: "type:: occurrence\nsubtype:: meeting\noccurred-on:: 2026-06-24\n\n- body text\n",
          source_kind: "logseq" as const
        }
      ],
      {
        authority_id: fixtureAuthorityId,
        created_at: "2026-06-22T12:00:00.000Z",
        path_redaction_secret: "fixture-path-redaction-secret-0001"
      }
    );

    expect(report.quarantine_reason_counts["dropped-classification-review"]).toBe(2);
    // Counted, never quoted: the row carries a hash of the word, not the corpus.
    expect(JSON.stringify(report)).not.toContain("threat-actor");
    expect(JSON.stringify(report)).not.toContain("saas");
  });
});
