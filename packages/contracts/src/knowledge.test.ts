import { describe, expect, it } from "vitest";
import {
  CanonicalEntityPayloadSchema,
  CanonicalEntityResolutionPayloadSchema,
  CanonicalEvidencePayloadSchema,
  CanonicalExportSchema,
  CanonicalFactPayloadSchema,
  CanonicalObservationPayloadSchema,
  CanonicalParityRecordPayloadSchema,
  CanonicalRelationshipPayloadSchema,
  CanonicalReviewItemPayloadSchema,
  CanonicalWriteSchema,
  canonicalIntervalsOverlap,
  canonicalObjectTypeForPayload,
  canonicalWorldTimeInterval,
  parseCanonicalExport
} from "./index";

const timestamp = "2026-07-09T12:00:00.000Z";
const hash = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const evidenceId = "la_object_evidence0001";

const confidence = {
  band: "high",
  assessment_kind: "assertion",
  method: "synthetic-manual-review",
  assessed_at: timestamp,
  evidence_refs: [evidenceId]
} as const;

const evidenceLinks = [{ evidence_id: evidenceId, stance: "supports" }] as const;

function entityResolutionInput() {
  return {
    schema: "atlas.entity-resolution:v1",
    resolution_id: "la_object_resolution0001",
    actor_id: "synthetic-reviewer",
    observed_identifiers: ["synthetic-identifier"],
    candidate_entity_ids: ["la_object_entity0001", "la_object_entity0002"],
    decision: "merge",
    canonical_entity_id: "la_object_entity0001",
    evidence_refs: [evidenceId],
    evidence_links: [...evidenceLinks],
    confidence,
    recorded_at: timestamp
  } as const;
}

describe("canonical knowledge payload contracts", () => {
  it("expands mixed-precision valid time and rejects empty canonical intervals", () => {
    expect(canonicalWorldTimeInterval("2026")).toEqual({
      lower: "2026-01-01",
      upper: "2027-01-01",
      approximate: false
    });
    expect(canonicalWorldTimeInterval("~2026-02")).toEqual({
      lower: "2026-02-01",
      upper: "2026-03-01",
      approximate: true
    });
    expect(canonicalWorldTimeInterval("unknown")).toBeUndefined();
    expect(canonicalIntervalsOverlap(
      canonicalWorldTimeInterval("2026")!,
      canonicalWorldTimeInterval("2026-06")!
    )).toBe(true);

    expect(CanonicalFactPayloadSchema.safeParse({
      schema: "atlas.fact:v1",
      assertion_id: "la_object_invalidinterval0001",
      subject_entity_id: "la_object_entity0001",
      predicate: "status",
      value: { kind: "text", value: "Synthetic status" },
      valid_from: "2026-06",
      valid_to: "2026-06",
      recorded_at: timestamp,
      lineage_action: "assert",
      evidence_links: evidenceLinks,
      confidence
    }).success).toBe(false);
  });

  it("accepts a canonical entity without legacy source or confidence fields", () => {
    const entity = CanonicalEntityPayloadSchema.parse({
      schema: "atlas.entity:v1",
      entity_id: "la_object_entity0001",
      type: "organization",
      subtype: "company",
      name: "Synthetic Organization",
      aliases: ["Synthetic Org"],
      created_at: timestamp,
      updated_at: timestamp
    });

    expect(entity).toMatchObject({
      schema: "atlas.entity:v1",
      entity_id: "la_object_entity0001",
      type: "organization"
    });
    expect(JSON.stringify(entity)).not.toContain("source_ref");
    expect(JSON.stringify(entity)).not.toContain("confidence");
  });

  it("requires a typed fact assertion with evidence and knowledge time", () => {
    const fact = CanonicalFactPayloadSchema.parse({
      schema: "atlas.fact:v1",
      assertion_id: "la_object_fact0001",
      subject_entity_id: "la_object_entity0001",
      predicate: "homepage",
      value: { kind: "uri", value: "https://example.invalid" },
      recorded_at: timestamp,
      lineage_action: "assert",
      evidence_links: evidenceLinks,
      confidence
    });

    expect(fact.value).toEqual({ kind: "uri", value: "https://example.invalid" });
    expect(CanonicalFactPayloadSchema.safeParse({ ...fact, predicate: "legacy-field" }).success).toBe(false);
    expect(CanonicalFactPayloadSchema.safeParse({
      ...fact,
      lineage_action: "correct",
      supersedes: []
    }).success).toBe(false);
  });

  it("constrains measured direct-contact fact predicates to their declared value kinds", () => {
    const fact = (predicate: string, value: unknown, suffix: string) => ({
      schema: "atlas.fact:v1",
      assertion_id: `la_object_measuredfact${suffix}`,
      subject_entity_id: "la_object_entity0001",
      predicate,
      value,
      recorded_at: timestamp,
      lineage_action: "assert",
      evidence_links: evidenceLinks,
      confidence
    });

    expect(CanonicalFactPayloadSchema.parse(fact("phone", { kind: "text", value: "+1 555 0100" }, "phone0001")).predicate).toBe("phone");
    expect(CanonicalFactPayloadSchema.parse(fact("email", { kind: "text", value: "synthetic@example.invalid" }, "email0001")).predicate).toBe("email");
    expect(CanonicalFactPayloadSchema.parse(fact("address", { kind: "text", value: "1 Synthetic Way" }, "address001")).predicate).toBe("address");
    expect(CanonicalFactPayloadSchema.parse(fact("birth-date", { kind: "date", value: "2000-01-02" }, "birth0001")).predicate).toBe("birth-date");
    expect(CanonicalFactPayloadSchema.parse(fact("last-contacted", { kind: "timestamp", value: timestamp }, "contact001")).predicate).toBe("last-contacted");
    expect(CanonicalFactPayloadSchema.parse(fact("last-contacted", { kind: "date", value: "2026-07-09" }, "contact002")).value).toEqual({ kind: "date", value: "2026-07-09" });

    expect(CanonicalFactPayloadSchema.safeParse(fact("phone", { kind: "number", value: 15550100 }, "badphone1")).success).toBe(false);
    expect(CanonicalFactPayloadSchema.safeParse(fact("birth-date", { kind: "timestamp", value: timestamp }, "badbirth1")).success).toBe(false);
    expect(CanonicalFactPayloadSchema.safeParse(fact("last-contacted", { kind: "text", value: "yesterday" }, "badcontact1")).success).toBe(false);
  });

  it("preserves ambiguous source meaning as a bounded observation without inventing a subject", () => {
    const observation = CanonicalObservationPayloadSchema.parse({
      schema: "atlas.observation:v1",
      assertion_id: "la_object_observation0001",
      statement: "Synthetic ambiguous context remains unresolved.",
      resolution_state: "deferred-unknown",
      recorded_at: timestamp,
      evidence_refs: [evidenceId]
    });

    expect(canonicalObjectTypeForPayload(observation)).toBe("assertion");
    expect(CanonicalObservationPayloadSchema.safeParse({
      ...observation,
      subject_entity_id: "la_object_entity0001"
    }).success).toBe(false);
  });

  it("keeps observation correction lineage optional but validates explicit predecessors", () => {
    const original = CanonicalObservationPayloadSchema.parse({
      schema: "atlas.observation:v1",
      assertion_id: "la_object_observationlineage0001",
      statement: "Synthetic original observation.",
      resolution_state: "owner-review",
      recorded_at: timestamp,
      evidence_refs: [evidenceId]
    });
    const successor = CanonicalObservationPayloadSchema.parse({
      ...original,
      assertion_id: "la_object_observationlineage0002",
      statement: "Synthetic corrected observation.",
      supersedes: [original.assertion_id]
    });

    expect(original).not.toHaveProperty("supersedes");
    expect(successor.supersedes).toEqual([original.assertion_id]);
    expect(CanonicalObservationPayloadSchema.safeParse({ ...successor, supersedes: [] }).success).toBe(false);
    expect(CanonicalObservationPayloadSchema.safeParse({
      ...successor,
      supersedes: [successor.assertion_id]
    }).success).toBe(false);
  });

  it("accepts a canonical relationship with temporal and evidence lineage", () => {
    const relationship = CanonicalRelationshipPayloadSchema.parse({
      schema: "atlas.relationship:v2",
      assertion_id: "la_object_relationship0001",
      edge_id: "la_edge_relationship0001",
      source_entity_id: "la_object_entity0001",
      source_type: "person",
      target_entity_id: "la_object_entity0002",
      target_type: "organization",
      predicate: "employed-by",
      valid_from: "2026",
      recorded_at: timestamp,
      lineage_action: "assert",
      evidence_links: evidenceLinks,
      confidence,
      attrs: {}
    });

    expect(canonicalObjectTypeForPayload(relationship)).toBe("edge");
    expect(CanonicalRelationshipPayloadSchema.safeParse({
      ...relationship,
      predicate: "unknown-relationship"
    }).success).toBe(false);
    expect(CanonicalRelationshipPayloadSchema.safeParse({
      ...relationship,
      lineage_action: "invalidate",
      supersedes: []
    }).success).toBe(false);
    expect(CanonicalRelationshipPayloadSchema.safeParse({
      ...relationship,
      attrs: { predicate: "shadowed-edge-spine" }
    }).success).toBe(false);
  });

  it("requires bounded, independently attributable evidence", () => {
    const evidence = CanonicalEvidencePayloadSchema.parse({
      schema: "atlas.evidence:v1",
      evidence_id: evidenceId,
      source_kind: "public-web",
      locator: "https://example.invalid/source",
      content_hash: hash,
      retrieved_at: timestamp,
      independence_key: "publisher:example",
      excerpt: "Synthetic supporting excerpt."
    });

    expect(canonicalObjectTypeForPayload(evidence)).toBe("evidence");
    expect(CanonicalEvidencePayloadSchema.safeParse({ ...evidence, excerpt: "x".repeat(4_097) }).success).toBe(false);
  });

  it("distinguishes a defined empty evidence excerpt from missing evidence custody", () => {
    const emptyEvidence = {
      schema: "atlas.evidence:v1",
      evidence_id: "la_object_emptyevidence0001",
      source_kind: "migration",
      locator: "migration:la_source_fixture:excerpt:1",
      content_hash: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      retrieved_at: timestamp,
      independence_key: "migration:la_source_fixture",
      excerpt: ""
    };

    expect(CanonicalEvidencePayloadSchema.parse(emptyEvidence).excerpt).toBe("");
    expect(CanonicalEvidencePayloadSchema.safeParse({ ...emptyEvidence, excerpt: undefined }).success).toBe(false);
  });

  it("requires a bounded actor on every entity resolution", () => {
    const { actor_id: _actorId, ...missingActor } = entityResolutionInput();
    const missingResult = CanonicalEntityResolutionPayloadSchema.safeParse(missingActor);

    expect(missingResult.success).toBe(false);
    if (!missingResult.success) {
      expect(missingResult.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: ["actor_id"] })
      ]));
    }
    expect(CanonicalEntityResolutionPayloadSchema.safeParse({
      ...entityResolutionInput(),
      actor_id: ""
    }).success).toBe(false);
    expect(CanonicalEntityResolutionPayloadSchema.safeParse({
      ...entityResolutionInput(),
      actor_id: "x".repeat(513)
    }).success).toBe(false);
  });

  it("requires nonempty resolution evidence links whose IDs exactly match evidence refs", () => {
    const { evidence_links: _evidenceLinks, ...missingLinks } = entityResolutionInput();
    const missingResult = CanonicalEntityResolutionPayloadSchema.safeParse(missingLinks);
    const emptyResult = CanonicalEntityResolutionPayloadSchema.safeParse({
      ...entityResolutionInput(),
      evidence_links: []
    });
    const mismatchResult = CanonicalEntityResolutionPayloadSchema.safeParse({
      ...entityResolutionInput(),
      evidence_links: [{ evidence_id: "la_object_otherresolutionevidence0001", stance: "supports" }]
    });

    for (const result of [missingResult, emptyResult, mismatchResult]) {
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toEqual(expect.arrayContaining([
          expect.objectContaining({ path: ["evidence_links"] })
        ]));
      }
    }
  });

  it("requires merge decisions to identify at least two distinct candidates", () => {
    const singleton = CanonicalEntityResolutionPayloadSchema.safeParse({
      ...entityResolutionInput(),
      candidate_entity_ids: ["la_object_entity0001"]
    });
    const duplicate = CanonicalEntityResolutionPayloadSchema.safeParse({
      ...entityResolutionInput(),
      candidate_entity_ids: ["la_object_entity0001", "la_object_entity0001"]
    });

    for (const result of [singleton, duplicate]) {
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toEqual(expect.arrayContaining([
          expect.objectContaining({ path: ["candidate_entity_ids"] })
        ]));
      }
    }
    expect(CanonicalEntityResolutionPayloadSchema.safeParse({
      ...entityResolutionInput(),
      decision: "link",
      candidate_entity_ids: ["la_object_entity0001"]
    }).success).toBe(true);
  });

  it("accepts support, refute, and context resolution evidence stances with exact evidence IDs", () => {
    const linkedEvidenceIds = [
      "la_object_resolutionevidence0001",
      "la_object_resolutionevidence0002",
      "la_object_resolutionevidence0003"
    ];
    const resolution = CanonicalEntityResolutionPayloadSchema.parse({
      ...entityResolutionInput(),
      evidence_refs: [...linkedEvidenceIds, linkedEvidenceIds[0]],
      evidence_links: [
        { evidence_id: linkedEvidenceIds[0], stance: "supports" },
        { evidence_id: linkedEvidenceIds[1], stance: "refutes" },
        { evidence_id: linkedEvidenceIds[2], stance: "context" }
      ],
      confidence: {
        ...confidence,
        evidence_refs: ["la_object_confidenceevidence0001"]
      }
    });

    expect(resolution.evidence_links.map((link) => link.stance)).toEqual(["supports", "refutes", "context"]);
    expect(resolution.confidence.evidence_refs).toEqual(["la_object_confidenceevidence0001"]);
  });

  it("requires durable identity, review, and parity records", () => {
    const resolution = CanonicalEntityResolutionPayloadSchema.parse(entityResolutionInput());
    const review = CanonicalReviewItemPayloadSchema.parse({
      schema: "atlas.review-item:v1",
      review_id: "la_object_review0001",
      candidate_id: "la_candidate_review0001",
      source_coverage_keys: ["la_coverage_source0001"],
      recommendation: "owner-review",
      resolution_state: "owner-review",
      proposed_object_ids: [resolution.resolution_id],
      recorded_at: timestamp
    });
    const parity = CanonicalParityRecordPayloadSchema.parse({
      schema: "atlas.parity-record:v1",
      parity_id: "la_object_parity0001",
      source_coverage_key: "la_coverage_source0001",
      coverage_state: "represented",
      representation_kind: "observation",
      canonical_object_ids: ["la_object_observation0001"],
      idempotency_key: "la_idem_parity0001",
      recorded_at: timestamp
    });

    expect(canonicalObjectTypeForPayload(resolution)).toBe("review");
    expect(canonicalObjectTypeForPayload(review)).toBe("review");
    expect(canonicalObjectTypeForPayload(parity)).toBe("manifest");
    expect(CanonicalEntityResolutionPayloadSchema.safeParse({
      ...resolution,
      canonical_entity_id: "la_object_notacandidate0001"
    }).success).toBe(false);
    expect(CanonicalEntityResolutionPayloadSchema.safeParse({
      ...resolution,
      decision: "split",
      canonical_entity_id: undefined,
      supersedes: []
    }).success).toBe(false);
    expect(CanonicalParityRecordPayloadSchema.safeParse({
      ...parity,
      canonical_object_ids: []
    }).success).toBe(false);
  });

  it("derives canonical write object types and rejects a legacy object-type override", () => {
    const write = CanonicalWriteSchema.parse({
      payload: {
        schema: "atlas.observation:v1",
        assertion_id: "la_object_observation0001",
        statement: "Synthetic ambiguous context remains unresolved.",
        resolution_state: "deferred-unknown",
        recorded_at: timestamp,
        evidence_refs: [evidenceId]
      }
    });

    expect(write.object_type).toBe("assertion");
    expect(CanonicalWriteSchema.safeParse({
      object_type: "page",
      payload: write.payload
    }).success).toBe(false);
  });

  it("round trips a versioned canonical export and rejects a legacy object type", () => {
    const record = {
      authority_id: "la_authority_contract0001",
      object_id: "la_object_entity0001",
      object_type: "entity",
      version: 1,
      access_class: "local-private",
      content_hash: hash,
      payload: {
        schema: "atlas.entity:v1",
        entity_id: "la_object_entity0001",
        type: "organization",
        subtype: "company",
        name: "Synthetic Organization",
        aliases: [],
        created_at: timestamp,
        updated_at: timestamp
      }
    } as const;
    const exported = {
      export_schema: "living-atlas-canonical-export:v1",
      plaintext_policy: "local-keyholding-canonical-export",
      authority_id: "la_authority_contract0001",
      exported_at: timestamp,
      records: [record]
    };

    expect(parseCanonicalExport(JSON.parse(JSON.stringify(exported)))).toEqual(exported);
    expect(CanonicalExportSchema.safeParse({
      ...exported,
      records: [{ ...record, object_type: "page" }]
    }).success).toBe(false);
  });

  it("rejects duplicate canonical object ids in one export", () => {
    const record = {
      authority_id: "la_authority_contract0001",
      object_id: "la_object_entity0001",
      object_type: "entity",
      version: 1,
      access_class: "local-private",
      content_hash: hash,
      payload: {
        schema: "atlas.entity:v1",
        entity_id: "la_object_entity0001",
        type: "organization",
        subtype: "company",
        name: "Synthetic Organization",
        aliases: [],
        created_at: timestamp,
        updated_at: timestamp
      }
    } as const;

    expect(CanonicalExportSchema.safeParse({
      export_schema: "living-atlas-canonical-export:v1",
      plaintext_policy: "local-keyholding-canonical-export",
      authority_id: record.authority_id,
      exported_at: timestamp,
      records: [record, record]
    }).success).toBe(false);
  });
});
