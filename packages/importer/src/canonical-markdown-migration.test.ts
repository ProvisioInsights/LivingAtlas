import { describe, expect, it } from "vitest";
import { CanonicalPayloadSchema } from "@living-atlas/contracts";
import { createCanonicalMarkdownMigration } from "./canonical-markdown-migration";

describe("canonical markdown migration", () => {
  it("preserves every source character as canonical evidence without legacy payloads or source paths", () => {
    const markdown = `# Project Birch\n\n- status:: private\n- Follow up with [[Example Person]].\n\n${"x".repeat(4_200)}`;
    const sourcePath = "/synthetic/private-vault/pages/Project Birch.md";
    const migration = createCanonicalMarkdownMigration([{
      source_path: sourcePath,
      markdown,
      source_kind: "logseq"
    }], {
      authority_id: "la_authority_fixture0001",
      created_at: "2026-07-10T12:00:00.000Z",
      path_redaction_secret: "synthetic-migration-path-secret"
    });

    expect(migration.payloads.every((payload) => CanonicalPayloadSchema.safeParse(payload).success)).toBe(true);
    expect(migration.payloads.map((payload) => payload.schema)).toEqual(expect.arrayContaining([
      "atlas.evidence:v1", "atlas.observation:v1", "atlas.review-item:v1", "atlas.parity-record:v1"
    ]));
    const evidence = migration.payloads.filter((payload) => payload.schema === "atlas.evidence:v1");
    expect(evidence.length).toBeGreaterThan(1);
    expect(evidence.map((payload) => payload.excerpt).join("")).toBe(markdown);
    const observation = migration.payloads.find((payload) => payload.schema === "atlas.observation:v1");
    const review = migration.payloads.find((payload) => payload.schema === "atlas.review-item:v1");
    const parity = migration.payloads.find((payload) => payload.schema === "atlas.parity-record:v1");
    expect(observation).toMatchObject({ resolution_state: "research", evidence_refs: evidence.map((payload) => payload.evidence_id) });
    expect(review).toMatchObject({ recommendation: "research", resolution_state: "research", proposed_object_ids: [observation?.assertion_id] });
    expect(parity).toMatchObject({ coverage_state: "represented", representation_kind: "observation", canonical_object_ids: [observation?.assertion_id] });
    expect(JSON.stringify(migration)).not.toContain(sourcePath);
    expect(JSON.stringify(migration)).not.toMatch(/"object_type"\s*:\s*"(?:page|block|attachment|index)"/);
  });
});
