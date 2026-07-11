import { describe, expect, it } from "vitest";
import { CanonicalPayloadSchema, canonicalPayloadObjectId } from "@living-atlas/contracts";
import {
  createCanonicalMarkdownMigration,
  createCanonicalMarkdownMigrationExport
} from "./canonical-markdown-migration";
import { createMarkdownSourceRef } from "./markdown";

describe("canonical markdown migration", () => {
  it("preserves an empty source exactly without fabricating knowledge or represented parity", () => {
    const migration = createCanonicalMarkdownMigration([{
      source_path: "pages/Synthetic Empty.md",
      markdown: "",
      source_kind: "logseq"
    }], {
      authority_id: "la_authority_fixture0001",
      created_at: "2026-07-10T12:00:00.000Z",
      path_redaction_secret: "synthetic-migration-path-secret"
    });

    const evidence = migration.payloads.filter((payload) => payload.schema === "atlas.evidence:v1");
    const observations = migration.payloads.filter((payload) => payload.schema === "atlas.observation:v1");
    const review = migration.payloads.find((payload) => payload.schema === "atlas.review-item:v1");
    const parity = migration.payloads.find((payload) => payload.schema === "atlas.parity-record:v1");

    expect(evidence).toEqual([expect.objectContaining({
      excerpt: "",
      content_hash: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      extraction_method: "canonical-markdown-lossless-v1"
    })]);
    expect(observations).toEqual([]);
    expect(review).toMatchObject({ recommendation: "research", resolution_state: "research", proposed_object_ids: [] });
    expect(parity).toEqual(expect.objectContaining({
      coverage_state: "unrepresented",
      canonical_object_ids: []
    }));
    expect(parity).not.toHaveProperty("representation_kind");
    expect(JSON.stringify(migration)).not.toContain("[empty source]");
  });

  it("rejects duplicate source references before canonical payload construction", () => {
    const pathRedactionSecret = "synthetic-migration-path-secret";
    const sourcePath = "pages/Synthetic Duplicate.md";
    const sourceRef = createMarkdownSourceRef(sourcePath, { path_redaction_secret: pathRedactionSecret });

    expect(() => createCanonicalMarkdownMigration([
      { source_path: sourcePath, markdown: "- First synthetic value.", source_kind: "logseq" },
      { source_path: sourcePath, markdown: "- Second synthetic value.", source_kind: "logseq" }
    ], {
      authority_id: "la_authority_fixture0001",
      created_at: "2026-07-10T12:00:00.000Z",
      path_redaction_secret: pathRedactionSecret
    })).toThrow(`duplicate canonical markdown source_ref ${sourceRef}`);
  });

  it("keeps identical content at distinct source paths with globally unique canonical object ids", () => {
    const markdown = "- Shared synthetic content.";
    const migration = createCanonicalMarkdownMigration([
      { source_path: "pages/Synthetic Copy One.md", markdown, source_kind: "logseq" },
      { source_path: "pages/Synthetic Copy Two.md", markdown, source_kind: "logseq" }
    ], {
      authority_id: "la_authority_fixture0001",
      created_at: "2026-07-10T12:00:00.000Z",
      path_redaction_secret: "synthetic-migration-path-secret"
    });
    const objectIds = migration.payloads.map(canonicalPayloadObjectId);

    expect(migration.payloads.filter((payload) => payload.schema === "atlas.review-item:v1")).toHaveLength(2);
    expect(new Set(objectIds).size).toBe(objectIds.length);
  });

  it("rejects a duplicate canonical object id at the migration export boundary", () => {
    const migration = createCanonicalMarkdownMigration([{
      source_path: "pages/Synthetic Export.md",
      markdown: "- Synthetic export value.",
      source_kind: "logseq"
    }], {
      authority_id: "la_authority_fixture0001",
      created_at: "2026-07-10T12:00:00.000Z",
      path_redaction_secret: "synthetic-migration-path-secret"
    });
    const duplicate = migration.payloads[0]!;

    expect(() => createCanonicalMarkdownMigrationExport({
      ...migration,
      payloads: [...migration.payloads, duplicate]
    })).toThrow(`duplicate canonical object_id ${canonicalPayloadObjectId(duplicate)} in migration export`);
  });

  it("keeps repeated meaningful units as distinct occurrence-scoped observations", () => {
    const markdown = [
      "- Repeated synthetic note.",
      "- Repeated synthetic note.",
      "- Unique synthetic note."
    ].join("\n");
    const migration = createCanonicalMarkdownMigration([{
      source_path: "pages/Synthetic Repetition.md",
      markdown,
      source_kind: "logseq"
    }], {
      authority_id: "la_authority_fixture0001",
      created_at: "2026-07-10T12:00:00.000Z",
      path_redaction_secret: "synthetic-migration-path-secret"
    });

    const observations = migration.payloads.filter((payload) => payload.schema === "atlas.observation:v1");
    const evidence = migration.payloads.filter((payload) => payload.schema === "atlas.evidence:v1");
    const unitEvidence = evidence.filter((payload) => payload.extraction_method === "canonical-source-unit-v1");
    const losslessEvidence = evidence.filter((payload) => payload.extraction_method === "canonical-markdown-lossless-v1");
    const parity = migration.payloads.find((payload) => payload.schema === "atlas.parity-record:v1");

    expect(observations.map((payload) => payload.statement)).toEqual([
      "Repeated synthetic note.",
      "Repeated synthetic note.",
      "Unique synthetic note."
    ]);
    expect(new Set(observations.map((payload) => payload.assertion_id)).size).toBe(3);
    expect(unitEvidence).toHaveLength(3);
    expect(unitEvidence.map((payload) => payload.locator)).toEqual([
      expect.stringContaining(":occurrence:1:excerpt:1"),
      expect.stringContaining(":occurrence:2:excerpt:1"),
      expect.stringContaining(":occurrence:1:excerpt:1")
    ]);
    expect(observations.every((payload) => unitEvidence.some((item) => payload.evidence_refs.includes(item.evidence_id))
      && losslessEvidence.every((item) => payload.evidence_refs.includes(item.evidence_id)))).toBe(true);
    expect(parity).toMatchObject({
      coverage_state: "represented",
      representation_kind: "observation",
      canonical_object_ids: observations.map((payload) => payload.assertion_id)
    });
  });

  it("keeps a long meaningful unit complete across bounded observations and evidence", () => {
    const knowledge = "x".repeat(9_000);
    const markdown = `- ${knowledge}`;
    const migration = createCanonicalMarkdownMigration([{
      source_path: "pages/Synthetic Long Unit.md",
      markdown,
      source_kind: "logseq"
    }], {
      authority_id: "la_authority_fixture0001",
      created_at: "2026-07-10T12:00:00.000Z",
      path_redaction_secret: "synthetic-migration-path-secret"
    });

    const evidence = migration.payloads.filter((payload) => payload.schema === "atlas.evidence:v1");
    const losslessEvidence = evidence.filter((payload) => payload.extraction_method === "canonical-markdown-lossless-v1");
    const unitEvidence = evidence.filter((payload) => payload.extraction_method === "canonical-source-unit-v1");
    const observations = migration.payloads.filter((payload) => payload.schema === "atlas.observation:v1");
    const parity = migration.payloads.find((payload) => payload.schema === "atlas.parity-record:v1");

    expect(losslessEvidence.map((payload) => payload.excerpt).join("")).toBe(markdown);
    expect(unitEvidence.map((payload) => payload.excerpt).join("")).toBe(markdown);
    expect(unitEvidence.every((payload) => (payload.excerpt?.length ?? 0) <= 4_096)).toBe(true);
    expect(observations.map((payload) => payload.statement).join("")).toBe(knowledge);
    expect(observations).toHaveLength(2);
    expect(observations.every((payload) => payload.statement.length <= 8_192)).toBe(true);
    expect(observations.every((payload) => unitEvidence.some((item) => payload.evidence_refs.includes(item.evidence_id))
      && losslessEvidence.every((item) => payload.evidence_refs.includes(item.evidence_id)))).toBe(true);
    expect(parity).toMatchObject({
      representation_kind: "observation",
      canonical_object_ids: observations.map((payload) => payload.assertion_id)
    });
  });

  it("binds observation candidates only by exact source provenance and unique exact wiki titles or aliases", () => {
    const migration = createCanonicalMarkdownMigration([
      {
        source_path: "pages/Synthetic Primary.md",
        markdown: [
          "type:: person",
          "alias:: Synthetic Unique Alias",
          "- Coordinates with [[Synthetic Exact Org]], [[Synthetic Unique Org Alias]], [[Synthetic Shared Alias]], and [[Synthetic Exact]]."
        ].join("\n"),
        source_kind: "logseq"
      },
      {
        source_path: "notes/Synthetic Primary.md",
        markdown: "# Synthetic Primary",
        source_kind: "generic-markdown"
      },
      {
        source_path: "pages/Synthetic Exact Org.md",
        markdown: "type:: organization\nalias:: Synthetic Unique Org Alias",
        source_kind: "logseq"
      },
      {
        source_path: "pages/Synthetic Collision One.md",
        markdown: "type:: organization\nalias:: Synthetic Shared Alias",
        source_kind: "logseq"
      },
      {
        source_path: "pages/Synthetic Collision Two.md",
        markdown: "type:: project\nalias:: Synthetic Shared Alias",
        source_kind: "logseq"
      }
    ], {
      authority_id: "la_authority_fixture0001",
      created_at: "2026-07-10T12:00:00.000Z",
      path_redaction_secret: "synthetic-migration-path-secret"
    });

    const entities = migration.payloads.filter((payload) => payload.schema === "atlas.entity:v1");
    const entityId = (name: string) => entities.find((payload) => payload.name === name)?.entity_id;
    const observations = migration.payloads.filter((payload) => payload.schema === "atlas.observation:v1");
    const primaryUnit = observations.find((payload) => payload.statement.startsWith("Coordinates with"));
    const sameTitleDifferentSource = observations.find((payload) => payload.statement === "Synthetic Primary");

    expect(primaryUnit).toMatchObject({
      resolution_state: "owner-review",
      candidate_entity_ids: [
        entityId("Synthetic Primary"),
        entityId("Synthetic Exact Org")
      ]
    });
    expect(sameTitleDifferentSource).toMatchObject({
      resolution_state: "research",
      candidate_entity_ids: []
    });
  });

  it("refuses same-title typed endpoint collisions before entity and candidate projection", () => {
    const migration = createCanonicalMarkdownMigration([
      {
        source_path: "synthetic-one/Synthetic Collision.md",
        markdown: "type:: person\nphone:: +1 555 0199",
        source_kind: "logseq"
      },
      {
        source_path: "synthetic-two/Synthetic Collision.md",
        markdown: "type:: project",
        source_kind: "logseq"
      },
      {
        source_path: "notes/Synthetic Collision Reference.md",
        markdown: [
          "- See [[Synthetic Collision]].",
          "",
          "## Edges",
          "- [[Synthetic Collision]] (project) about [[Synthetic Collision Topic]] (topic)"
        ].join("\n"),
        source_kind: "generic-markdown"
      },
      {
        source_path: "pages/Synthetic Collision Topic.md",
        markdown: "type:: topic",
        source_kind: "logseq"
      }
    ], {
      authority_id: "la_authority_fixture0001",
      created_at: "2026-07-10T12:00:00.000Z",
      path_redaction_secret: "synthetic-migration-path-secret"
    });

    const collisionEntities = migration.payloads.filter((payload) => payload.schema === "atlas.entity:v1"
      && payload.name === "Synthetic Collision");
    const collisionFacts = migration.payloads.filter((payload) => payload.schema === "atlas.fact:v1");
    const collisionRelationships = migration.payloads.filter((payload) => payload.schema === "atlas.relationship:v2");
    const collisionObservations = migration.payloads
      .filter((payload) => payload.schema === "atlas.observation:v1")
      .filter((payload) => ["Type: person", "Phone: +1 555 0199", "Type: project", "See Synthetic Collision."].includes(payload.statement));
    const payloadById = new Map(migration.payloads.map((payload) => [canonicalPayloadObjectId(payload), payload]));
    const reviews = migration.payloads.filter((payload) => payload.schema === "atlas.review-item:v1");
    const reviewForStatement = (statement: string) => {
      const observation = collisionObservations.find((payload) => payload.statement === statement);
      return reviews.find((review) => observation && review.proposed_object_ids.includes(observation.assertion_id));
    };
    const rawTypedSourceReviews = [
      reviewForStatement("Type: person"),
      reviewForStatement("Type: project"),
      reviewForStatement("See Synthetic Collision.")
    ];

    expect(collisionEntities).toEqual([]);
    expect(collisionFacts).toEqual([]);
    expect(collisionRelationships).toEqual([]);
    expect(collisionObservations).toHaveLength(4);
    expect(collisionObservations.every((payload) => payload.resolution_state === "owner-review"
      && payload.candidate_entity_ids.length === 0)).toBe(true);
    expect(rawTypedSourceReviews.every((review) => review?.recommendation === "owner-review"
      && review.resolution_state === "owner-review"
      && review.proposed_object_ids.every((id) => payloadById.get(id)?.schema === "atlas.observation:v1"))).toBe(true);
  });

  it("counts typed projection omissions without inventing edges or dropping observations", () => {
    const migration = createCanonicalMarkdownMigration([
      { source_path: "pages/Synthetic Person.md", markdown: "type:: person", source_kind: "logseq" },
      { source_path: "pages/Synthetic Project.md", markdown: "type:: project", source_kind: "logseq" },
      { source_path: "pages/Synthetic Organization.md", markdown: "type:: organization", source_kind: "logseq" },
      { source_path: "one/Synthetic Collision.md", markdown: "type:: person", source_kind: "logseq" },
      { source_path: "two/Synthetic Collision.md", markdown: "type:: project", source_kind: "logseq" },
      {
        source_path: "pages/Synthetic Omitted Edges.md",
        markdown: [
          "## Edges",
          "- [[Synthetic Person]] (person) advises [[Synthetic Missing]] (project) from 2025",
          "- [[Synthetic Person]] (organization) customer-of [[Synthetic Organization]] (organization) from 2025",
          "- [[Synthetic Collision]] (person) advises [[Synthetic Project]] (project) from 2025",
          "- [[Synthetic Person]] (alien) advises [[Synthetic Project]] (project) from 2025"
        ].join("\n"),
        source_kind: "logseq"
      }
    ], {
      authority_id: "la_authority_fixture0001",
      created_at: "2026-07-10T12:00:00.000Z",
      path_redaction_secret: "synthetic-typed-omission-secret"
    });

    expect(migration.typed_projection_omissions).toEqual({
      ambiguous_typed_entity_ids: 1,
      missing_edge_endpoints: 1,
      endpoint_type_mismatches: 1,
      ambiguous_endpoint_edges: 1,
      duplicate_edge_ids: 0,
      other_edge_omissions: 1
    });
    expect(migration.payloads.filter((payload) => payload.schema === "atlas.relationship:v2")).toEqual([]);
    const observations = migration.payloads.filter((payload) => payload.schema === "atlas.observation:v1");
    expect(observations.some((observation) => observation.statement.includes("Synthetic Missing"))).toBe(true);
    expect(observations.some((observation) => observation.statement.includes("alien"))).toBe(true);
  });

  it("emits only parseable measured direct fields as typed facts backed by unit evidence", () => {
    const migration = createCanonicalMarkdownMigration([{
      source_path: "pages/Synthetic Contact.md",
      markdown: [
        "type:: person",
        "phone:: +1 555 0100",
        "email:: synthetic@example.invalid",
        "address:: 1 Synthetic Way",
        "birthday:: 2000-01-02",
        "last-contacted:: 2026-07-09T15:30:00.000Z",
        "birth-date:: someday",
        "last-contacted:: recently"
      ].join("\n"),
      source_kind: "logseq"
    }], {
      authority_id: "la_authority_fixture0001",
      created_at: "2026-07-10T12:00:00.000Z",
      path_redaction_secret: "synthetic-migration-path-secret"
    });

    const primary = migration.payloads.find((payload) => payload.schema === "atlas.entity:v1");
    const evidenceById = new Map(migration.payloads
      .filter((payload) => payload.schema === "atlas.evidence:v1")
      .map((payload) => [payload.evidence_id, payload]));
    const facts = migration.payloads.filter((payload) => payload.schema === "atlas.fact:v1");
    const observations = migration.payloads.filter((payload) => payload.schema === "atlas.observation:v1");

    expect(facts.map((payload) => ({ predicate: payload.predicate, value: payload.value }))).toEqual([
      { predicate: "phone", value: { kind: "text", value: "+1 555 0100" } },
      { predicate: "email", value: { kind: "text", value: "synthetic@example.invalid" } },
      { predicate: "address", value: { kind: "text", value: "1 Synthetic Way" } },
      { predicate: "birth-date", value: { kind: "date", value: "2000-01-02" } },
      { predicate: "last-contacted", value: { kind: "timestamp", value: "2026-07-09T15:30:00.000Z" } }
    ]);
    expect(facts.every((payload) => payload.subject_entity_id === primary?.entity_id)).toBe(true);
    expect(facts.every((payload) => payload.evidence_links.length > 0
      && payload.evidence_links.every((link) => evidenceById.get(link.evidence_id)?.extraction_method === "canonical-source-unit-v1"))).toBe(true);
    expect(observations.map((payload) => payload.statement)).toEqual(expect.arrayContaining([
      "Birth date: someday",
      "Last contacted: recently"
    ]));
  });

  it("emits extractor-proven relationships only for existing typed endpoints with specific unit evidence", () => {
    const migration = createCanonicalMarkdownMigration([
      {
        source_path: "pages/Synthetic Person.md",
        markdown: [
          "type:: person",
          "org:: [[Synthetic Employer]]",
          "",
          "- Narrative collaboration with [[Synthetic Project]].",
          "",
          "## Edges",
          "- [[Synthetic Person]] (person) advises [[Synthetic Project]] (project) from 2025",
          "- [[Synthetic Person]] (person) advises [[Synthetic Missing Project]] (project) from 2025"
        ].join("\n"),
        source_kind: "logseq"
      },
      {
        source_path: "pages/Synthetic Employer.md",
        markdown: "type:: organization",
        source_kind: "logseq"
      },
      {
        source_path: "pages/Synthetic Project.md",
        markdown: "type:: project",
        source_kind: "logseq"
      }
    ], {
      authority_id: "la_authority_fixture0001",
      created_at: "2026-07-10T12:00:00.000Z",
      path_redaction_secret: "synthetic-migration-path-secret"
    });

    const entities = new Map(migration.payloads
      .filter((payload) => payload.schema === "atlas.entity:v1")
      .map((payload) => [payload.entity_id, payload]));
    const evidenceById = new Map(migration.payloads
      .filter((payload) => payload.schema === "atlas.evidence:v1")
      .map((payload) => [payload.evidence_id, payload]));
    const relationships = migration.payloads.filter((payload) => payload.schema === "atlas.relationship:v2");

    expect(relationships.map((payload) => payload.predicate).sort()).toEqual(["advises", "employed-by"]);
    expect(relationships.every((payload) => entities.get(payload.source_entity_id)?.type === payload.source_type
      && entities.get(payload.target_entity_id)?.type === payload.target_type)).toBe(true);
    expect(relationships.every((payload) => payload.evidence_links.length > 0
      && payload.evidence_links.every((link) => evidenceById.get(link.evidence_id)?.extraction_method === "canonical-source-unit-v1"))).toBe(true);
    expect(relationships.find((payload) => payload.predicate === "employed-by")?.evidence_links
      .map((link) => evidenceById.get(link.evidence_id)?.excerpt).join("")).toBe("org:: [[Synthetic Employer]]");
    expect(relationships.find((payload) => payload.predicate === "advises")?.evidence_links
      .map((link) => evidenceById.get(link.evidence_id)?.excerpt).join("")).toContain("Synthetic Project");
  });

  it("keeps typed projections additive in owner review while parity names only complete observations", () => {
    const migration = createCanonicalMarkdownMigration([
      {
        source_path: "pages/Synthetic Owner Review.md",
        markdown: "type:: person\nphone:: +1 555 0123\norg:: [[Synthetic Review Org]]",
        source_kind: "logseq"
      },
      {
        source_path: "pages/Synthetic Review Org.md",
        markdown: "type:: organization",
        source_kind: "logseq"
      },
      {
        source_path: "notes/Synthetic Research.md",
        markdown: "- Untyped synthetic research note.",
        source_kind: "generic-markdown"
      }
    ], {
      authority_id: "la_authority_fixture0001",
      created_at: "2026-07-10T12:00:00.000Z",
      path_redaction_secret: "synthetic-migration-path-secret"
    });

    const payloadById = new Map(migration.payloads.map((payload) => [
      payload.schema === "atlas.entity:v1" ? payload.entity_id
        : payload.schema === "atlas.evidence:v1" ? payload.evidence_id
          : payload.schema === "atlas.review-item:v1" ? payload.review_id
            : payload.schema === "atlas.parity-record:v1" ? payload.parity_id
              : payload.schema === "atlas.entity-resolution:v1" ? payload.resolution_id
                : payload.assertion_id,
      payload
    ]));
    const reviews = migration.payloads.filter((payload) => payload.schema === "atlas.review-item:v1");
    const ownerReview = reviews.find((review) => review.proposed_object_ids.some((id) => {
      const payload = payloadById.get(id);
      return payload?.schema === "atlas.observation:v1" && payload.statement === "Phone: +1 555 0123";
    }));
    const researchReview = reviews.find((review) => review.proposed_object_ids.some((id) => {
      const payload = payloadById.get(id);
      return payload?.schema === "atlas.observation:v1" && payload.statement === "Untyped synthetic research note.";
    }));
    const proposed = ownerReview?.proposed_object_ids.map((id) => payloadById.get(id));
    const parity = migration.payloads
      .filter((payload) => payload.schema === "atlas.parity-record:v1")
      .find((payload) => ownerReview?.source_coverage_keys.includes(payload.source_coverage_key));

    expect(ownerReview).toMatchObject({ recommendation: "owner-review", resolution_state: "owner-review" });
    expect(proposed?.map((payload) => payload?.schema)).toEqual(expect.arrayContaining([
      "atlas.observation:v1",
      "atlas.entity:v1",
      "atlas.fact:v1",
      "atlas.relationship:v2"
    ]));
    expect(researchReview).toMatchObject({ recommendation: "research", resolution_state: "research" });
    expect(parity).toMatchObject({ coverage_state: "represented", representation_kind: "observation" });
    expect(parity?.canonical_object_ids.every((id) => payloadById.get(id)?.schema === "atlas.observation:v1"
      && ownerReview?.proposed_object_ids.includes(id))).toBe(true);
    expect(ownerReview?.proposed_object_ids.every((id) => payloadById.has(id))).toBe(true);
  });

  it("routes an explicit typed-relationship source to unresolved owner review", () => {
    const migration = createCanonicalMarkdownMigration([
      { source_path: "pages/Synthetic Advisor.md", markdown: "type:: person", source_kind: "logseq" },
      { source_path: "pages/Synthetic Initiative.md", markdown: "type:: project", source_kind: "logseq" },
      {
        source_path: "notes/Synthetic Explicit Links.md",
        markdown: "## Edges\n- [[Synthetic Advisor]] (person) advises [[Synthetic Initiative]] (project) from 2025",
        source_kind: "generic-markdown"
      }
    ], {
      authority_id: "la_authority_fixture0001",
      created_at: "2026-07-10T12:00:00.000Z",
      path_redaction_secret: "synthetic-migration-path-secret"
    });

    const relationship = migration.payloads.find((payload) => payload.schema === "atlas.relationship:v2");
    const review = migration.payloads.find((payload) => payload.schema === "atlas.review-item:v1"
      && relationship && payload.proposed_object_ids.includes(relationship.assertion_id));

    expect(review).toMatchObject({ recommendation: "owner-review", resolution_state: "owner-review" });
  });

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
    const losslessEvidence = evidence.filter((payload) => payload.extraction_method === "canonical-markdown-lossless-v1");
    const unitEvidence = evidence.filter((payload) => payload.extraction_method === "canonical-source-unit-v1");
    expect(losslessEvidence.length).toBeGreaterThan(1);
    expect(losslessEvidence.map((payload) => payload.excerpt).join("")).toBe(markdown);
    const observations = migration.payloads.filter((payload) => payload.schema === "atlas.observation:v1");
    const review = migration.payloads.find((payload) => payload.schema === "atlas.review-item:v1");
    const parity = migration.payloads.find((payload) => payload.schema === "atlas.parity-record:v1");
    expect(observations.length).toBeGreaterThan(1);
    expect(observations.every((observation) => observation.resolution_state === "research"
      && unitEvidence.some((item) => observation.evidence_refs.includes(item.evidence_id))
      && losslessEvidence.every((item) => observation.evidence_refs.includes(item.evidence_id)))).toBe(true);
    expect(review).toMatchObject({
      recommendation: "research",
      resolution_state: "research",
      proposed_object_ids: observations.map((observation) => observation.assertion_id)
    });
    expect(parity).toMatchObject({
      coverage_state: "represented",
      representation_kind: "observation",
      canonical_object_ids: observations.map((observation) => observation.assertion_id)
    });
    expect(JSON.stringify(migration)).not.toContain(sourcePath);
    expect(JSON.stringify(migration)).not.toMatch(/"object_type"\s*:\s*"(?:page|block|attachment|index)"/);
  });

  it("adds only explicitly typed Logseq endpoints as canonical entities", () => {
    const migration = createCanonicalMarkdownMigration([{
      source_path: "pages/Synthetic Topic.md",
      markdown: "type:: topic\nsubtype:: theme\n\n- canonical entity\n",
      source_kind: "logseq"
    }], { authority_id: "la_authority_fixture0001", created_at: "2026-07-10T12:00:00.000Z", path_redaction_secret: "synthetic-migration-path-secret" });
    expect(migration.payloads.filter((payload) => payload.schema === "atlas.entity:v1")).toEqual([
      expect.objectContaining({ type: "topic", subtype: "theme" })
    ]);
  });
});
