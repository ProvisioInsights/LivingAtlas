import { describe, expect, it } from "vitest";
import type { CanonicalEvidencePayload } from "@living-atlas/contracts";
import { accountSourceMeaning } from "./source-meaning";

const now = "2026-07-10T12:00:00.000Z";

function evidence(excerpt: string, index = 0): CanonicalEvidencePayload {
  return {
    schema: "atlas.evidence:v1",
    evidence_id: `la_object_sourcemeaning${String(index).padStart(4, "0")}`,
    source_kind: "migration",
    locator: `synthetic://source-meaning/${index}`,
    content_hash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    retrieved_at: now,
    independence_key: "synthetic-source-meaning",
    extraction_method: "canonical-markdown-lossless-v1",
    excerpt
  };
}

describe("source meaning accounting", () => {
  it("keeps the exact source fragment separate from its cleaned Atlas text", () => {
    const source = "- **Relationship to [[Synthetic Person]]:** trusted collaborator (migration note: qualifier retained)";

    const accounting = accountSourceMeaning([evidence(source)]);

    expect(accounting.exact_source_preserved).toBe(true);
    expect(accounting.meaningful_units).toEqual([
      expect.objectContaining({
        source_text: source,
        atlas_text: "Relationship to Synthetic Person: trusted collaborator",
        kind: "relationship"
      })
    ]);
    expect(accounting.excluded_units).toContainEqual({
      source_text: "migration note: qualifier retained",
      reason: "editorial migration commentary"
    });
  });

  it("makes editorial, organizational, and source-system exclusions explicit", () => {
    const accounting = accountSourceMeaning([evidence([
      "- no web research performed",
      "- **Context**",
      "- **Contact**",
      "- **Relationship to [[Synthetic Person]]**",
      "type:: query",
      "- Durable synthetic knowledge."
    ].join("\n"))]);

    expect(accounting.excluded_units).toEqual([
      { source_text: "no web research performed", reason: "editorial migration commentary" },
      { source_text: "- **Context**", reason: "source organization" },
      { source_text: "- **Contact**", reason: "source organization" },
      { source_text: "- **Relationship to [[Synthetic Person]]**", reason: "source organization" },
      { source_text: "type:: query", reason: "source-system instruction" }
    ]);
    expect(accounting.meaningful_units.map((unit) => unit.atlas_text)).toEqual([
      "Durable synthetic knowledge."
    ]);
  });

  it("keeps fully bold knowledge statements and sentences that merely mention Logseq", () => {
    const boldStatement = "- **This relationship matters**";
    const logseqStatement = "- Migrated customer research from Logseq in 2024.";
    const accounting = accountSourceMeaning([evidence([
      boldStatement,
      logseqStatement
    ].join("\n"))]);

    expect(accounting.meaningful_units).toEqual([
      expect.objectContaining({
        source_text: boldStatement,
        atlas_text: "This relationship matters",
        kind: "observation"
      }),
      expect.objectContaining({
        source_text: logseqStatement,
        atlas_text: "Migrated customer research from Logseq in 2024.",
        kind: "observation"
      })
    ]);
    expect(accounting.excluded_units).toEqual([]);
  });

  it("continues to exclude actual Logseq query and source-system instructions", () => {
    const accounting = accountSourceMeaning([evidence([
      "type:: query",
      "{{query (property :synthetic)}}",
      "- Run grep -n against pages/*.md before migration."
    ].join("\n\n"))]);

    expect(accounting.meaningful_units).toEqual([]);
    expect(accounting.excluded_units).toEqual([
      { source_text: "type:: query", reason: "source-system instruction" },
      { source_text: "{{query (property :synthetic)}}", reason: "source-system instruction" },
      { source_text: "- Run grep -n against pages/*.md before migration.", reason: "source-system instruction" }
    ]);
  });

  it("retains normalized wiki-reference targets for exact resolution", () => {
    const accounting = accountSourceMeaning([evidence([
      "org:: [[Synthetic Company|the company]]",
      "- Met [[Synthetic Person#History]] through [[Synthetic Project]]."
    ].join("\n"))]);

    expect(accounting.meaningful_units.map((unit) => unit.wiki_references)).toEqual([
      ["Synthetic Company"],
      ["Synthetic Person", "Synthetic Project"]
    ]);
  });

  it("does not expose wiki references found only in excluded editorial commentary", () => {
    const source = "- Met [[Synthetic Person]] (migration note: compare with [[Excluded Draft]])";

    const accounting = accountSourceMeaning([evidence(source)]);

    expect(accounting.meaningful_units[0]).toMatchObject({
      source_text: source,
      atlas_text: "Met Synthetic Person",
      wiki_references: ["Synthetic Person"]
    });
    expect(accounting.excluded_units).toContainEqual({
      source_text: "migration note: compare with [[Excluded Draft]]",
      reason: "editorial migration commentary"
    });
  });

  it("certifies exact source only for a non-empty all-lossless evidence set", () => {
    const canonical = evidence("- Canonical synthetic source.");
    const nonLossless: CanonicalEvidencePayload = {
      ...evidence("- Derived synthetic source.", 1),
      extraction_method: "synthetic-derived-v1"
    };

    expect(accountSourceMeaning([]).exact_source_preserved).toBe(false);
    expect(accountSourceMeaning([canonical]).exact_source_preserved).toBe(true);
    expect(accountSourceMeaning([canonical, nonLossless]).exact_source_preserved).toBe(false);
  });

  it("keeps stable hashes and complete units across lossless evidence chunks", () => {
    const source = `- ${"x".repeat(6_000)} [[Synthetic Anchor]]`;
    const whole = accountSourceMeaning([evidence(source)]);
    const chunked = accountSourceMeaning([
      evidence(source.slice(0, 3_777), 1),
      evidence(source.slice(3_777), 2)
    ]);

    expect(chunked).toEqual(whole);
    expect(whole.meaningful_units[0]).toMatchObject({
      source_text: source,
      wiki_references: ["Synthetic Anchor"]
    });
    expect(whole.meaningful_units[0]?.atlas_text.length).toBeGreaterThan(4_096);
    expect(whole.meaningful_units[0]?.unit_id).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});
