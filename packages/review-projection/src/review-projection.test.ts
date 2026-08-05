import { describe, expect, it } from "vitest";
import {
  canonicalObjectTypeForPayload,
  canonicalPayloadObjectId,
  type CanonicalPayload,
  type GraphObjectEnvelope
} from "@living-atlas/contracts";
import { createCanonicalMarkdownMigration } from "@living-atlas/importer";
import { canonicalResearchMutationFingerprint } from "@living-atlas/graph-service";
import { accountSourceMeaning, projectLocalReviewQueue } from "@living-atlas/review-projection";

const now = "2026-07-10T12:00:00.000Z";
const reviewId = "la_object_reviewsite0001";
const observationId = "la_object_reviewobservation0001";
const evidenceId = "la_object_reviewevidence0001";
const parityId = "la_object_reviewparity0001";

function envelope(id: string, type: GraphObjectEnvelope["object_type"]): GraphObjectEnvelope {
  return { schema_version: 1, authority_id: "la_authority_reviewsite0001", object_id: id, object_type: type, version: 1, access_class: "local-private", encryption_class: "client-encrypted", created_at: now, updated_at: now, content_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", key_ref: "la_key_reviewsite0001", visible_metadata: { tombstone: false, remote_indexable: false }, payload: { kind: "ciphertext-inline", ciphertext: "synthetic", nonce: "synthetic", algorithm: "synthetic" } };
}

describe("local review projection", () => {
  it("normalizes bulk compatibility across IDs and separates different mutation templates", async () => {
    const migration = createCanonicalMarkdownMigration([
      {
        source_path: "pages/Synthetic Bulk Person A.md",
        markdown: "type:: person\nphone:: +1 555 0101",
        source_kind: "logseq"
      },
      {
        source_path: "pages/Synthetic Bulk Person B.md",
        markdown: "type:: person\nphone:: +1 555 0102",
        source_kind: "logseq"
      },
      {
        source_path: "pages/Synthetic Bulk Organization.md",
        markdown: "type:: organization",
        source_kind: "logseq"
      }
    ], {
      authority_id: "la_authority_reviewsite0001",
      created_at: now,
      path_redaction_secret: "synthetic-bulk-compatibility-secret"
    });
    const payloads = new Map(migration.payloads.map((payload) => [canonicalPayloadObjectId(payload), payload]));
    const queue = await projectLocalReviewQueue({
      objects: migration.payloads.map((payload) => envelope(
        canonicalPayloadObjectId(payload),
        canonicalObjectTypeForPayload(payload)
      )),
      decryptPayload: async (object) => payloads.get(object.object_id)
    });
    const itemNamed = (name: string) => queue.owner_review.find((item) => item.proposed_records.some((record) => (
      record.schema === "atlas.entity:v1" && record.name === name
    )))!;
    const left = itemNamed("Synthetic Bulk Person A");
    const sameTemplate = itemNamed("Synthetic Bulk Person B");
    const differentTemplate = itemNamed("Synthetic Bulk Organization");

    expect(left.bulk_compatibility_key).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(left.bulk_compatibility_key).toBe(sameTemplate.bulk_compatibility_key);
    expect(left.bulk_compatibility_key).not.toBe(differentTemplate.bulk_compatibility_key);
  });

  it("separates bulk evidence rules by independent groups and evidence stance", async () => {
    const cases = [
      { name: "Synthetic LinkedIn Only", evidence: [{ source_kind: "linkedin", group: "linkedin-only", stance: "supports" }] },
      { name: "Synthetic LinkedIn Plus", evidence: [
        { source_kind: "linkedin", group: "linkedin-plus", stance: "supports" },
        { source_kind: "public-web", group: "linkedin-independent", stance: "supports" }
      ] },
      { name: "Synthetic One Public", evidence: [{ source_kind: "public-web", group: "public-one", stance: "supports" }] },
      { name: "Synthetic Two Public", evidence: [
        { source_kind: "public-web", group: "public-two-a", stance: "supports" },
        { source_kind: "public-web", group: "public-two-b", stance: "supports" }
      ] },
      { name: "Synthetic Supported", evidence: [{ source_kind: "public-web", group: "public-stance", stance: "supports" }] },
      { name: "Synthetic Refuted", evidence: [{ source_kind: "public-web", group: "public-stance-other", stance: "refutes" }] },
      { name: "Synthetic Context Only", evidence: [{ source_kind: "public-web", group: "public-context", stance: "context" }] },
      { name: "Synthetic Confidence Only", evidence: [{ source_kind: "public-web", group: "public-confidence-only", stance: "supports", reference: "confidence" }] },
      { name: "Synthetic Owner Source", evidence: [] }
    ] as const;
    const migration = createCanonicalMarkdownMigration(cases.map((entry, index) => ({
      source_path: `pages/${entry.name}.md`,
      markdown: `type:: person\nphone:: +1 555 02${String(index).padStart(2, "0")}`,
      source_kind: "logseq" as const
    })), {
      authority_id: "la_authority_reviewsite0001",
      created_at: now,
      path_redaction_secret: "synthetic-evidence-rule-secret"
    });
    const entityNames = new Map(migration.payloads.flatMap((payload) => (
      payload.schema === "atlas.entity:v1" ? [[payload.entity_id, payload.name] as const] : []
    )));
    const evidenceByName = new Map(cases.map((entry) => [String(entry.name), entry.evidence] as const));
    const addedEvidence: CanonicalPayload[] = [];
    let evidenceIndex = 0;
    const withResearchEvidence = migration.payloads.map((payload): CanonicalPayload => {
      if (payload.schema !== "atlas.fact:v1") return payload;
      const definitions = evidenceByName.get(entityNames.get(payload.subject_entity_id) ?? "") ?? [];
      const evidenceReferences = definitions.map((definition) => {
        evidenceIndex += 1;
        const evidence_id = `la_object_ruleevidence${String(evidenceIndex).padStart(4, "0")}`;
        addedEvidence.push({
          schema: "atlas.evidence:v1",
          evidence_id,
          source_kind: definition.source_kind,
          locator: `synthetic://evidence-rule/${evidenceIndex}`,
          content_hash: `sha256:${String(evidenceIndex % 10).repeat(64)}`,
          retrieved_at: now,
          independence_key: definition.group,
          excerpt: `Synthetic evidence rule ${evidenceIndex}.`
        });
        return { evidence_id, stance: definition.stance, confidenceOnly: "reference" in definition };
      });
      return {
        ...payload,
        evidence_links: [
          ...payload.evidence_links,
          ...evidenceReferences.filter((reference) => !reference.confidenceOnly)
            .map(({ evidence_id, stance }) => ({ evidence_id, stance }))
        ],
        confidence: {
          ...payload.confidence,
          evidence_refs: [
            ...payload.confidence.evidence_refs,
            ...evidenceReferences.filter((reference) => reference.confidenceOnly).map((reference) => reference.evidence_id)
          ]
        }
      };
    });
    const payloadList = [...withResearchEvidence, ...addedEvidence];
    const payloads = new Map(payloadList.map((payload) => [canonicalPayloadObjectId(payload), payload]));
    const queue = await projectLocalReviewQueue({
      objects: payloadList.map((payload) => envelope(canonicalPayloadObjectId(payload), canonicalObjectTypeForPayload(payload))),
      decryptPayload: async (object) => payloads.get(object.object_id)
    });
    const keyFor = (name: string) => queue.owner_review.find((item) => item.proposed_records.some((payload) => (
      payload.schema === "atlas.entity:v1" && payload.name === name
    )))!.bulk_compatibility_key;

    expect(keyFor("Synthetic LinkedIn Only")).not.toBe(keyFor("Synthetic LinkedIn Plus"));
    expect(keyFor("Synthetic One Public")).not.toBe(keyFor("Synthetic Two Public"));
    expect(keyFor("Synthetic Supported")).not.toBe(keyFor("Synthetic Refuted"));
    expect(keyFor("Synthetic Supported")).not.toBe(keyFor("Synthetic Context Only"));
    const confidenceOnly = queue.owner_review.find((item) => item.proposed_records.some((payload) => (
      payload.schema === "atlas.entity:v1" && payload.name === "Synthetic Confidence Only"
    )))!;
    expect(confidenceOnly.evidence.some((evidence) => evidence.independence_key === "public-confidence-only")).toBe(true);
    expect(confidenceOnly.bulk_compatibility_key).not.toBe(keyFor("Synthetic Supported"));
    expect(confidenceOnly.bulk_compatibility_key).not.toBe(keyFor("Synthetic Owner Source"));
    const supported = queue.owner_review.find((item) => item.proposed_records.some((payload) => (
      payload.schema === "atlas.entity:v1" && payload.name === "Synthetic Supported"
    )))!;
    const supportedFactSummary = supported.unit_mappings
      .flatMap((mapping) => mapping.destination_summaries)
      .find((summary) => summary.destination_kind === "fact");
    expect(supportedFactSummary?.evidence.map((evidence) => evidence.source_label)).toContain("Public web");
  });

  it("attributes mixed complete-source and public evidence to complete source context", async () => {
    const migration = createCanonicalMarkdownMigration([{
      source_path: "pages/Synthetic Mixed Source Context.md",
      markdown: "type:: person\nstatus:: active",
      source_kind: "logseq"
    }], {
      authority_id: "la_authority_reviewsite0001",
      created_at: now,
      path_redaction_secret: "synthetic-mixed-source-context-secret"
    });
    const review = migration.payloads.find((payload): payload is Extract<CanonicalPayload, { schema: "atlas.review-item:v1" }> => (
      payload.schema === "atlas.review-item:v1"
    ))!;
    const sourceEvidence = migration.payloads.find((payload): payload is Extract<CanonicalPayload, { schema: "atlas.evidence:v1" }> => (
      payload.schema === "atlas.evidence:v1" && payload.extraction_method === "canonical-markdown-lossless-v1"
    ))!;
    const entity = migration.payloads.find((payload): payload is Extract<CanonicalPayload, { schema: "atlas.entity:v1" }> => (
      payload.schema === "atlas.entity:v1"
    ))!;
    const publicEvidence = {
      schema: "atlas.evidence:v1" as const,
      evidence_id: "la_object_mixedsourcepublic0001",
      source_kind: "public-web" as const,
      locator: "synthetic://mixed-source/public",
      content_hash: "sha256:5555555555555555555555555555555555555555555555555555555555555555",
      retrieved_at: now,
      independence_key: "synthetic-mixed-source-public",
      excerpt: "Synthetic public support."
    };
    const sourceContextFact = {
      schema: "atlas.fact:v1" as const,
      assertion_id: "la_object_mixedsourcefact0001",
      subject_entity_id: entity.entity_id,
      predicate: "status" as const,
      value: { kind: "text" as const, value: "active" },
      recorded_at: now,
      lineage_action: "assert" as const,
      supersedes: [],
      evidence_links: [
        { evidence_id: sourceEvidence.evidence_id, stance: "supports" as const },
        { evidence_id: publicEvidence.evidence_id, stance: "supports" as const }
      ],
      confidence: {
        band: "high" as const,
        assessment_kind: "assertion" as const,
        method: "synthetic-mixed-source-v1",
        assessed_at: now,
        evidence_refs: [sourceEvidence.evidence_id, publicEvidence.evidence_id]
      }
    };
    const updatedReview = {
      ...review,
      proposed_object_ids: [...review.proposed_object_ids, sourceContextFact.assertion_id]
    };
    const payloadList = [
      ...migration.payloads.filter((payload) => payload !== review),
      updatedReview,
      publicEvidence,
      sourceContextFact
    ] as CanonicalPayload[];
    const payloads = new Map(payloadList.map((payload) => [canonicalPayloadObjectId(payload), payload]));
    const queue = await projectLocalReviewQueue({
      objects: payloadList.map((payload) => envelope(canonicalPayloadObjectId(payload), canonicalObjectTypeForPayload(payload))),
      decryptPayload: async (object) => payloads.get(object.object_id)
    });
    const item = queue.owner_review[0]!;

    expect(item.source_context_mapping.destination_records.map((destination) => destination.object_id)).toContain(
      sourceContextFact.assertion_id
    );
    expect(item.unmapped_destination_ids).not.toContain(sourceContextFact.assertion_id);
    expect(item.decision_summaries.find((summary) => summary.destination_object_id === sourceContextFact.assertion_id)).toMatchObject({
      coverage_basis: "source-context",
      evidence: [
        { source_label: "Owner source" },
        { source_label: "Public web" }
      ]
    });
  });

  it("maps repeated source-unit occurrences to their real canonical destination graph", async () => {
    const migration = createCanonicalMarkdownMigration([
      {
        source_path: "pages/Synthetic Destination Person.md",
        markdown: [
          "type:: person",
          "phone:: +1 555 0100",
          "phone:: +1 555 0100",
          "org:: [[Synthetic Destination Org]]"
        ].join("\n"),
        source_kind: "logseq"
      },
      {
        source_path: "pages/Synthetic Destination Org.md",
        markdown: "type:: organization",
        source_kind: "logseq"
      }
    ], {
      authority_id: "la_authority_reviewsite0001",
      created_at: now,
      path_redaction_secret: "synthetic-review-destination-secret"
    });
    const payloads = new Map(migration.payloads.map((payload) => [canonicalPayloadObjectId(payload), payload]));
    const queue = await projectLocalReviewQueue({
      objects: migration.payloads.map((payload) => envelope(
        canonicalPayloadObjectId(payload),
        canonicalObjectTypeForPayload(payload)
      )),
      decryptPayload: async (object) => payloads.get(object.object_id)
    });
    const item = queue.owner_review.find((candidate) => candidate.proposed_records.some((record) => (
      record.schema === "atlas.fact:v1" && record.predicate === "phone"
    )));

    expect(item).toBeDefined();
    expect(item!.resolution_mode).toBe("rich");
    expect(item!.source_context.every((evidence) => evidence.extraction_method === "canonical-markdown-lossless-v1")).toBe(true);
    expect(item!.source_context.map((evidence) => evidence.excerpt).join("")).toBe([
      "type:: person",
      "phone:: +1 555 0100",
      "phone:: +1 555 0100",
      "org:: [[Synthetic Destination Org]]"
    ].join("\n"));

    const phoneMappings = item!.unit_mappings.filter((mapping) => mapping.unit.atlas_text === "Phone: +1 555 0100");
    expect(phoneMappings.map((mapping) => mapping.occurrence)).toEqual([1, 2]);
    expect(phoneMappings.map((mapping) => mapping.unit_evidence.map((evidence) => evidence.locator))).toEqual([
      [expect.stringContaining(`:unit:${phoneMappings[0]!.unit.unit_id}:occurrence:1:excerpt:1`)],
      [expect.stringContaining(`:unit:${phoneMappings[1]!.unit.unit_id}:occurrence:2:excerpt:1`)]
    ]);
    expect(phoneMappings.every((mapping) => mapping.destination_records.some((destination) => (
      destination.record_type === "observation"
      && destination.object_id === destination.record.assertion_id
    )))).toBe(true);
    expect(phoneMappings.every((mapping) => mapping.destination_records.some((destination) => (
      destination.record_type === "fact"
      && destination.record.schema === "atlas.fact:v1"
      && destination.record.predicate === "phone"
      && destination.object_id === destination.record.assertion_id
    )))).toBe(true);
    expect(new Set(phoneMappings.flatMap((mapping) => mapping.observation_ids)).size).toBe(2);
    expect(new Set(phoneMappings.flatMap((mapping) => mapping.fact_ids)).size).toBe(2);
    expect(phoneMappings.every((mapping) => /^mapping:[a-f0-9]{24}$/.test(mapping.mapping_id))).toBe(true);
    expect(phoneMappings.every((mapping) => mapping.entity_ids.length === 1)).toBe(true);
    expect(phoneMappings.every((mapping) => (
      mapping.destination_records.map((destination) => destination.record_type).join(",")
        === "entity,fact,observation"
    ))).toBe(true);
    expect(phoneMappings.every((mapping) => (
      mapping.destination_summaries.map((summary) => summary.destination_object_id)
        .join(",") === mapping.destination_records.map((destination) => destination.object_id).join(",")
    ))).toBe(true);
    const phoneFactSummary = phoneMappings[0]!.destination_summaries.find((summary) => summary.destination_kind === "fact");
    expect(phoneFactSummary).toMatchObject({
      parity: "covered",
      coverage_basis: "unit-via-observation",
      confidence: "high",
      evidence: [{
        stance: "supports",
        source_label: "Owner source",
        retrieved_at: now,
        confidence: "high",
        private_detail: {
          locator: expect.stringContaining(":unit:"),
          excerpt: "phone:: +1 555 0100"
        }
      }]
    });
    const phoneObservationSummary = phoneMappings[0]!.destination_summaries.find((summary) => summary.destination_kind === "observation");
    expect(phoneObservationSummary).toMatchObject({ parity: "covered", coverage_basis: "direct", confidence: "unassessed" });

    const orgMapping = item!.unit_mappings.find((mapping) => mapping.unit.atlas_text === "Org: Synthetic Destination Org");
    expect(orgMapping?.destination_records.map((destination) => destination.record_type)).toEqual([
      "entity",
      "entity",
      "relationship",
      "observation"
    ]);
    const parityObservationIds = new Set(item!.parity_records.flatMap((parity) => parity.canonical_object_ids));
    expect(item!.unit_mappings.flatMap((mapping) => mapping.observation_ids)
      .every((id) => parityObservationIds.has(id))).toBe(true);
    expect(item!.parity_records.every((parity) => parity.representation_kind === "observation"
      && parity.canonical_object_ids.every((id) => item!.destination_graph.observations.some((record) => record.object_id === id)))).toBe(true);

    expect(item!.destination_graph.entities.map((destination) => destination.record.name).sort()).toEqual([
      "Synthetic Destination Org",
      "Synthetic Destination Person"
    ]);
    expect(item!.destination_graph.facts).toHaveLength(2);
    expect(item!.destination_graph.relationships).toHaveLength(1);
    expect(item!.destination_graph.observations).toHaveLength(4);
    expect(item!.destination_graph.relationships[0]?.record.target_entity_id).toBe(
      item!.destination_graph.entities.find((destination) => destination.record.name === "Synthetic Destination Org")?.object_id
    );
    const relationship = item!.destination_graph.relationships[0]!.record;
    expect(item!.graph.edges).toContainEqual({
      edge_id: relationship.edge_id,
      kind: "relationship",
      assertion_id: relationship.assertion_id,
      source_entity_id: relationship.source_entity_id,
      target_entity_id: relationship.target_entity_id,
      predicate: relationship.predicate,
      style: "solid"
    });
    const fact = item!.destination_graph.facts[0]!.record;
    expect(item!.graph.edges).toContainEqual({
      edge_id: `fact:${fact.assertion_id}`,
      kind: "fact",
      assertion_id: fact.assertion_id,
      source_entity_id: fact.subject_entity_id,
      target_node_id: `fact:${fact.assertion_id}`,
      predicate: fact.predicate,
      style: "solid"
    });
    expect(item!.source_context_mapping).toEqual({
      source_evidence_ids: item!.source_context.map((evidence) => evidence.evidence_id),
      destination_records: [],
      destination_summaries: []
    });
    expect(item!.unmapped_destination_ids).toEqual([]);
    expect(new Set(item!.decision_summaries.map((summary) => summary.destination_object_id))).toEqual(
      new Set(item!.unit_mappings.flatMap((mapping) => mapping.destination_records.map((destination) => destination.object_id)))
    );
    expect(item!.decision_summaries.map((summary) => summary.destination_kind)).toEqual([
      "entity", "entity", "fact", "fact", "relationship", "observation", "observation", "observation", "observation"
    ]);
  });

  it("keeps an unreferenced proposed entity visibly unmapped and blocks a misleading decision", async () => {
    const migration = createCanonicalMarkdownMigration([{
      source_path: "pages/Synthetic Unmapped Person.md",
      markdown: "type:: person\nphone:: +1 555 0133",
      source_kind: "logseq"
    }], {
      authority_id: "la_authority_reviewsite0001",
      created_at: now,
      path_redaction_secret: "synthetic-unmapped-destination-secret"
    });
    const review = migration.payloads.find((payload) => payload.schema === "atlas.review-item:v1")!;
    const entity = migration.payloads.find((payload) => payload.schema === "atlas.entity:v1")!;
    const orphan = { ...entity, entity_id: "la_object_unmappedentity0001", name: "Synthetic Unmapped Entity" };
    const payloadList = [
      ...migration.payloads.map((payload) => payload === review
        ? { ...review, proposed_object_ids: [...review.proposed_object_ids, orphan.entity_id] }
        : payload),
      orphan
    ] as CanonicalPayload[];
    const payloads = new Map(payloadList.map((payload) => [canonicalPayloadObjectId(payload), payload]));

    const queue = await projectLocalReviewQueue({
      objects: payloadList.map((payload) => envelope(canonicalPayloadObjectId(payload), canonicalObjectTypeForPayload(payload))),
      decryptPayload: async (object) => payloads.get(object.object_id)
    });

    expect(queue.owner_review[0]).toMatchObject({
      unmapped_destination_ids: [orphan.entity_id],
      resolution_mode: "incomplete",
      resolution_mode_explanation: expect.stringContaining("destination")
    });
  });

  it("keeps mixed relationship-basis research in owner review regardless of result ordering", async () => {
    const migration = createCanonicalMarkdownMigration([
      { source_path: "pages/Synthetic Basis Person.md", markdown: "type:: person\norg:: [[Synthetic Basis Org]]", source_kind: "logseq" },
      { source_path: "pages/Synthetic Basis Org.md", markdown: "type:: organization", source_kind: "logseq" }
    ], {
      authority_id: "la_authority_reviewsite0001",
      created_at: now,
      path_redaction_secret: "synthetic-mixed-basis-secret"
    });
    const review = migration.payloads.find((payload): payload is Extract<CanonicalPayload, { schema: "atlas.review-item:v1" }> => payload.schema === "atlas.review-item:v1"
      && payload.proposed_object_ids.some((id) => migration.payloads.some((candidate) => (
        candidate.schema === "atlas.relationship:v2" && candidate.assertion_id === id
      ))))!;
    const sourceRelationship = migration.payloads.find((payload): payload is Extract<CanonicalPayload, { schema: "atlas.relationship:v2" }> => (
      payload.schema === "atlas.relationship:v2"
    ))!;
    const sourceUnitEvidence = migration.payloads.find((payload): payload is Extract<CanonicalPayload, { schema: "atlas.evidence:v1" }> => (
      payload.schema === "atlas.evidence:v1" && payload.extraction_method === "canonical-source-unit-v1"
    ))!;
    const evidenceA = {
      schema: "atlas.evidence:v1" as const,
      evidence_id: "la_object_basisresearchevidence0001",
      source_kind: "public-web" as const,
      locator: "synthetic://basis/one",
      content_hash: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      retrieved_at: now,
      independence_key: "synthetic-basis-one",
      excerpt: "Synthetic relationship evidence one."
    };
    const evidenceB = {
      ...evidenceA,
      evidence_id: "la_object_basisresearchevidence0002",
      locator: "synthetic://basis/two",
      content_hash: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
      independence_key: "synthetic-basis-two",
      excerpt: "Synthetic relationship evidence two."
    };
    const proposalSeed = {
      ...sourceRelationship,
      evidence_links: [
        { evidence_id: evidenceA.evidence_id, stance: "supports" as const },
        { evidence_id: evidenceB.evidence_id, stance: "supports" as const }
      ],
      confidence: {
        ...sourceRelationship.confidence,
        evidence_refs: [evidenceA.evidence_id, evidenceB.evidence_id]
      }
    };
    const fingerprint = canonicalResearchMutationFingerprint(proposalSeed);
    const proposal = {
      ...proposalSeed,
      assertion_id: fingerprint.proposed_object_id,
      edge_id: `la_edge_${fingerprint.proposed_mutation_hash.slice("sha256:".length, "sha256:".length + 24)}`
    };
    const result = (suffix: "0001" | "0002", evidence: typeof evidenceA, relationshipBasis: "explicit" | "inferred-sensitive") => ({
      schema: "atlas.research-result:v1" as const,
      research_result_id: `la_object_basisresearchresult${suffix}`,
      run_id: `la_research_run_${suffix.repeat(6)}`,
      candidate_id: review.candidate_id,
      source_unit_id: sourceUnitEvidence.locator.match(/:unit:(sha256:[a-f0-9]{64}):/)![1]!,
      algorithm_version: "synthetic-basis-v1",
      normalized_query_hash: `sha256:${suffix === "0001" ? "3" : "4"}`.padEnd(71, suffix === "0001" ? "3" : "4"),
      connector_kind: "public-web" as const,
      upstream_identity: `synthetic-basis-${suffix}`,
      independence_key: evidence.independence_key,
      evidence_id: evidence.evidence_id,
      evidence_content_hash: evidence.content_hash,
      retrieved_at: now,
      stance: "supports" as const,
      identity_state: "resolved" as const,
      identity_confidence: {
        band: "high" as const,
        assessment_kind: "identity" as const,
        method: "synthetic-basis-v1",
        assessed_at: now,
        evidence_refs: [evidence.evidence_id]
      },
      relationship_basis: relationshipBasis,
      proposed_object_id: proposal.assertion_id,
      proposed_mutation_hash: fingerprint.proposed_mutation_hash,
      recorded_at: now
    });
    const explicit = result("0001", evidenceA, "explicit");
    const sensitive = result("0002", evidenceB, "inferred-sensitive");
    const updatedReview = {
      ...review,
      proposed_object_ids: [
        ...review.proposed_object_ids.filter((id) => id !== sourceRelationship.assertion_id),
        proposal.assertion_id,
        evidenceA.evidence_id,
        evidenceB.evidence_id,
        explicit.research_result_id,
        sensitive.research_result_id
      ]
    };
    const payloadList = [
      ...migration.payloads.filter((payload) => payload !== review && payload !== sourceRelationship),
      updatedReview,
      proposal,
      evidenceA,
      evidenceB,
      explicit,
      sensitive
    ] as CanonicalPayload[];
    const payloads = new Map(payloadList.map((payload) => [canonicalPayloadObjectId(payload), payload]));
    const queue = await projectLocalReviewQueue({
      objects: payloadList.map((payload) => envelope(canonicalPayloadObjectId(payload), canonicalObjectTypeForPayload(payload))),
      decryptPayload: async (object) => payloads.get(object.object_id)
    });

    expect(queue.owner_review.find((item) => item.review_id === review.review_id)?.recommendation_rationale).toMatchObject({
      outcome: "owner-review",
      reason_codes: ["sensitive-relationship"]
    });
  });

  it("marks a rich candidate with typed parity incomplete instead of coercing its parity", async () => {
    const migration = createCanonicalMarkdownMigration([{
      source_path: "pages/Synthetic Typed Parity.md",
      markdown: "type:: person\nphone:: +1 555 0111",
      source_kind: "logseq"
    }], {
      authority_id: "la_authority_reviewsite0001",
      created_at: now,
      path_redaction_secret: "synthetic-typed-parity-secret"
    });
    const review = migration.payloads.find((payload) => payload.schema === "atlas.review-item:v1")!;
    const fact = migration.payloads.find((payload) => payload.schema === "atlas.fact:v1")!;
    const typedParity = {
      schema: "atlas.parity-record:v1" as const,
      parity_id: "la_object_reviewtypedparity0001",
      source_coverage_key: review.source_coverage_keys[0]!,
      coverage_state: "represented" as const,
      representation_kind: "fact" as const,
      canonical_object_ids: [fact.assertion_id],
      idempotency_key: "la_idem_reviewtypedparity0001",
      recorded_at: now
    };
    const allPayloads = [...migration.payloads, typedParity];
    const payloads = new Map(allPayloads.map((payload) => [canonicalPayloadObjectId(payload), payload]));
    const queue = await projectLocalReviewQueue({
      objects: allPayloads.map((payload) => envelope(canonicalPayloadObjectId(payload), canonicalObjectTypeForPayload(payload))),
      decryptPayload: async (object) => payloads.get(object.object_id)
    });

    expect(queue.owner_review[0]).toMatchObject({
      resolution_mode: "incomplete",
      resolution_mode_explanation: expect.stringContaining("source coverage")
    });
    expect(queue.owner_review[0]!.decision_summaries.find((summary) => (
      summary.destination_object_id === fact.assertion_id
    ))).toMatchObject({ parity: "covered", coverage_basis: "direct" });
  });

  it("shows a missing relationship endpoint in its exact source mapping and blocks decisions", async () => {
    const migration = createCanonicalMarkdownMigration([
      { source_path: "pages/Synthetic Missing Endpoint Person.md", markdown: "type:: person\norg:: [[Synthetic Missing Endpoint Org]]", source_kind: "logseq" },
      { source_path: "pages/Synthetic Missing Endpoint Org.md", markdown: "type:: organization", source_kind: "logseq" }
    ], {
      authority_id: "la_authority_reviewsite0001",
      created_at: now,
      path_redaction_secret: "synthetic-missing-endpoint-secret"
    });
    const relationship = migration.payloads.find((payload) => payload.schema === "atlas.relationship:v2")!;
    const withoutTarget = migration.payloads.filter((payload) => !(
      payload.schema === "atlas.entity:v1" && payload.entity_id === relationship.target_entity_id
    ));
    const payloads = new Map(withoutTarget.map((payload) => [canonicalPayloadObjectId(payload), payload]));
    const queue = await projectLocalReviewQueue({
      objects: withoutTarget.map((payload) => envelope(canonicalPayloadObjectId(payload), canonicalObjectTypeForPayload(payload))),
      decryptPayload: async (object) => payloads.get(object.object_id)
    });
    const item = queue.owner_review.find((candidate) => candidate.proposed_object_ids.includes(relationship.assertion_id))!;
    const mapping = item.unit_mappings.find((candidate) => candidate.relationship_ids.includes(relationship.assertion_id))!;

    expect(mapping.entity_ids).toContain(relationship.target_entity_id);
    expect(item.missing_references).toContain(relationship.target_entity_id);
    expect(item).toMatchObject({
      resolution_mode: "incomplete",
      resolution_mode_explanation: expect.stringContaining("referenced")
    });
  });

  it("marks a partially mapped canonical candidate incomplete with an explanation", async () => {
    const migration = createCanonicalMarkdownMigration([{
      source_path: "pages/Synthetic Partial Mapping.md",
      markdown: "type:: person\nphone:: +1 555 0122",
      source_kind: "logseq"
    }], {
      authority_id: "la_authority_reviewsite0001",
      created_at: now,
      path_redaction_secret: "synthetic-partial-mapping-secret"
    });
    const partialPayloads = migration.payloads.filter((payload) => !(
      payload.schema === "atlas.evidence:v1"
      && payload.extraction_method === "canonical-source-unit-v1"
      && payload.excerpt?.includes("phone::")
    ));
    const payloads = new Map(partialPayloads.map((payload) => [canonicalPayloadObjectId(payload), payload]));
    const queue = await projectLocalReviewQueue({
      objects: partialPayloads.map((payload) => envelope(canonicalPayloadObjectId(payload), canonicalObjectTypeForPayload(payload))),
      decryptPayload: async (object) => payloads.get(object.object_id)
    });

    expect(queue.owner_review[0]).toMatchObject({
      resolution_mode: "incomplete",
      resolution_mode_explanation: expect.stringContaining("referenced")
    });
    expect(queue.owner_review[0]!.source_context_mapping.destination_records.some((destination) => (
      destination.record_type === "observation"
    ))).toBe(false);
  });

  it("keeps complete-source coverage mapped when third-party evidence corroborates it", async () => {
    const sourceEvidenceId = "la_object_mixedsourceevidence0001";
    const publicEvidenceId = "la_object_mixedpublicevidence0001";
    const unrelatedSourceEvidenceId = "la_object_mixedsourceevidence0002";
    const mixedObservationId = "la_object_mixedsourceobservation0001";
    const mixedReviewId = "la_object_mixedsourcereview0001";
    const mixedParityId = "la_object_mixedsourceparity0001";
    const coverageKey = "la_coverage_mixedsource0001";
    const candidateId = "la_candidate_mixedsource0001";
    const payloadList: CanonicalPayload[] = [
      {
        schema: "atlas.evidence:v1",
        evidence_id: sourceEvidenceId,
        source_kind: "migration",
        locator: "synthetic://mixed-source/owner",
        content_hash: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
        retrieved_at: now,
        independence_key: "synthetic-mixed-owner",
        extraction_method: "canonical-markdown-lossless-v1",
        excerpt: "Synthetic complete-source statement."
      },
      {
        schema: "atlas.evidence:v1",
        evidence_id: publicEvidenceId,
        source_kind: "public-web",
        locator: "synthetic://mixed-source/public",
        content_hash: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
        retrieved_at: now,
        independence_key: "synthetic-mixed-public",
        excerpt: "Synthetic public corroboration."
      },
      {
        schema: "atlas.evidence:v1",
        evidence_id: unrelatedSourceEvidenceId,
        source_kind: "migration",
        locator: "synthetic://mixed-source/unrelated",
        content_hash: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
        retrieved_at: now,
        independence_key: "synthetic-mixed-unrelated",
        extraction_method: "canonical-markdown-lossless-v1",
        excerpt: "Synthetic unrelated source statement."
      },
      {
        schema: "atlas.observation:v1",
        assertion_id: mixedObservationId,
        statement: "Synthetic complete-source statement.",
        candidate_entity_ids: [],
        resolution_state: "owner-review",
        recorded_at: now,
        evidence_refs: [sourceEvidenceId, publicEvidenceId, unrelatedSourceEvidenceId]
      },
      {
        schema: "atlas.review-item:v1",
        review_id: mixedReviewId,
        candidate_id: candidateId,
        source_coverage_keys: [coverageKey],
        recommendation: "owner-review",
        resolution_state: "owner-review",
        proposed_object_ids: [mixedObservationId],
        source_evidence_ids: [sourceEvidenceId],
        recorded_at: now
      },
      {
        schema: "atlas.parity-record:v1",
        parity_id: mixedParityId,
        source_coverage_key: coverageKey,
        coverage_state: "represented",
        representation_kind: "observation",
        canonical_object_ids: [mixedObservationId],
        idempotency_key: "la_idem_mixedsource0001",
        recorded_at: now
      }
    ];
    const payloads = new Map(payloadList.map((payload) => [canonicalPayloadObjectId(payload), payload]));

    const queue = await projectLocalReviewQueue({
      objects: payloadList.map((payload) => envelope(canonicalPayloadObjectId(payload), canonicalObjectTypeForPayload(payload))),
      decryptPayload: async (object) => payloads.get(object.object_id)
    });

    expect(queue.owner_review[0]).toMatchObject({ resolution_mode: "legacy", unmapped_destination_ids: [] });
    expect(queue.owner_review[0]!.source_context.map((evidence) => evidence.evidence_id)).toEqual([sourceEvidenceId]);
    expect(queue.owner_review[0]!.source_context.map((evidence) => evidence.excerpt).join(""))
      .not.toContain("unrelated");
    expect(queue.owner_review[0]!.source_context_mapping.destination_records.map((destination) => destination.object_id))
      .toContain(mixedObservationId);
    const evidenceLabels = queue.owner_review[0]!.source_context_mapping.destination_summaries[0]!.evidence
      .map((evidence) => evidence.source_label);
    expect(evidenceLabels).toHaveLength(2);
    expect(evidenceLabels).toEqual(expect.arrayContaining(["Owner source", "Public web"]));
  });

  it("does not show a different source unit as evidence for a complete-source entity mapping", async () => {
    const sourceEvidenceId = "la_object_scopedevidenceowner0001";
    const unitEvidenceId = "la_object_scopedevidenceunit0001";
    const entityId = "la_object_scopedentity0001";
    const observationId = "la_object_scopedobservation0001";
    const factId = "la_object_scopedfact0001";
    const reviewId = "la_object_scopedreview0001";
    const parityId = "la_object_scopedparity0001";
    const coverageKey = "la_coverage_scoped0001";
    const sourceEvidence = {
      schema: "atlas.evidence:v1" as const,
      evidence_id: sourceEvidenceId,
      source_kind: "migration" as const,
      locator: "migration:la_source_aaaaaaaaaaaaaaaaaaaaaaaa:excerpt:1",
      content_hash: "sha256:4444444444444444444444444444444444444444444444444444444444444444",
      retrieved_at: now,
      independence_key: "synthetic-scoped-source",
      extraction_method: "canonical-markdown-lossless-v1",
      excerpt: "description:: Synthetic complete context"
    };
    const sourceUnit = accountSourceMeaning([sourceEvidence]).meaningful_units[0]!;
    const payloadList: CanonicalPayload[] = [
      sourceEvidence,
      {
        schema: "atlas.evidence:v1",
        evidence_id: unitEvidenceId,
        source_kind: "migration",
        locator: `migration:la_source_aaaaaaaaaaaaaaaaaaaaaaaa:unit:${sourceUnit.unit_id}:occurrence:1:excerpt:1`,
        content_hash: "sha256:5555555555555555555555555555555555555555555555555555555555555555",
        retrieved_at: now,
        independence_key: "synthetic-scoped-source",
        extraction_method: "canonical-source-unit-v1",
        excerpt: "description:: Synthetic complete context"
      },
      {
        schema: "atlas.entity:v1",
        entity_id: entityId,
        type: "person",
        subtype: "individual",
        name: "Synthetic Scoped Person",
        aliases: [],
        created_at: now,
        updated_at: now
      },
      {
        schema: "atlas.observation:v1",
        assertion_id: observationId,
        statement: "Synthetic complete context.",
        candidate_entity_ids: [entityId],
        resolution_state: "owner-review",
        recorded_at: now,
        evidence_refs: [sourceEvidenceId]
      },
      {
        schema: "atlas.fact:v1",
        assertion_id: factId,
        subject_entity_id: entityId,
        predicate: "description",
        value: { kind: "text", value: "Synthetic unit detail" },
        recorded_at: now,
        lineage_action: "assert",
        supersedes: [],
        evidence_links: [{ evidence_id: unitEvidenceId, stance: "supports" }],
        confidence: {
          band: "high",
          assessment_kind: "assertion",
          method: "synthetic-scoped-evidence-v1",
          assessed_at: now,
          evidence_refs: [unitEvidenceId]
        }
      },
      {
        schema: "atlas.review-item:v1",
        review_id: reviewId,
        candidate_id: "la_candidate_scoped0001",
        source_coverage_keys: [coverageKey],
        recommendation: "owner-review",
        resolution_state: "owner-review",
        proposed_object_ids: [entityId, observationId, factId],
        source_evidence_ids: [sourceEvidenceId],
        recorded_at: now
      },
      {
        schema: "atlas.parity-record:v1",
        parity_id: parityId,
        source_coverage_key: coverageKey,
        coverage_state: "represented",
        representation_kind: "observation",
        canonical_object_ids: [observationId],
        idempotency_key: "la_idem_scoped0001",
        recorded_at: now
      }
    ];
    const payloads = new Map(payloadList.map((payload) => [canonicalPayloadObjectId(payload), payload]));

    const queue = await projectLocalReviewQueue({
      objects: payloadList.map((payload) => envelope(canonicalPayloadObjectId(payload), canonicalObjectTypeForPayload(payload))),
      decryptPayload: async (object) => payloads.get(object.object_id)
    });
    const item = queue.owner_review[0]!;
    const entitySummary = item.source_context_mapping.destination_summaries.find((summary) => (
      summary.destination_object_id === entityId
    ));

    expect(entitySummary?.evidence.map((evidence) => evidence.evidence_id)).toEqual([sourceEvidenceId]);
    expect(item.unit_mappings[0]!.destination_summaries.find((summary) => (
      summary.destination_object_id === entityId
    ))?.evidence.map((evidence) => evidence.evidence_id)).toEqual([unitEvidenceId]);
  });

  it("accounts for every meaningful source unit and separates editorial migration commentary", () => {
    const accounting = accountSourceMeaning([
      {
        schema: "atlas.evidence:v1",
        evidence_id: evidenceId,
        source_kind: "migration",
        locator: "synthetic://meaning-accounting",
        content_hash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        retrieved_at: now,
        independence_key: "synthetic-meaning-accounting",
        extraction_method: "canonical-markdown-lossless-v1",
        excerpt: [
          "type:: person",
          "status:: active",
          "privacy:: family-adjacent · no web enrichment performed · presence-only",
          "org:: [[Synthetic Company]]",
          "email:: person@example.com",
          "source:: owner correction and message review",
          "- **Phone:** +1 (555) 010-2040 (regional number)",
          "- **Address:** 100 Example Avenue",
          "- **Relationship to [[Synthetic Person]]:** longtime collaborator (much richer than initial stub captured)",
          "- **Contact**",
          "- **Relationship to [[Synthetic Person]]**",
          "- 2025-11-05 8:30 CT · video call",
          "- **How to render (Logseq):** `{{query (todo TODO)}}`",
          "- Met through a shared project in 2021."
        ].join("\n")
      }
    ]);

    expect(accounting.exact_source_preserved).toBe(true);
    expect(accounting.meaningful_units.map((unit) => [unit.kind, unit.atlas_text])).toEqual([
      ["attribute", "Type: person"],
      ["attribute", "Status: active"],
      ["attribute", "Privacy: family-adjacent · presence-only"],
      ["relationship", "Org: Synthetic Company"],
      ["fact", "Email: person@example.com"],
      ["provenance", "Source: owner correction and message review"],
      ["fact", "Phone: +1 (555) 010-2040 (regional number)"],
      ["fact", "Address: 100 Example Avenue"],
      ["relationship", "Relationship to Synthetic Person: longtime collaborator"],
      ["observation", "2025-11-05 8:30 CT · video call"],
      ["observation", "Met through a shared project in 2021."]
    ]);
    expect(accounting.meaningful_units.every((unit) => /^sha256:[a-f0-9]{64}$/.test(unit.unit_id))).toBe(true);
    expect(accounting.excluded_units).toEqual([
      { source_text: "no web enrichment performed", reason: "editorial migration commentary" },
      { source_text: "much richer than initial stub captured", reason: "editorial migration commentary" },
      { source_text: "- **Contact**", reason: "source organization" },
      { source_text: "- **Relationship to [[Synthetic Person]]**", reason: "source organization" },
      { source_text: "- **How to render (Logseq):** `{{query (todo TODO)}}`", reason: "source-system instruction" }
    ]);
  });

  it("uses meaningful migration context instead of a generic coverage placeholder", async () => {
    const placeholderObservationId = "la_object_reviewplaceholderobs0001";
    const placeholderEvidenceId = "la_object_reviewplaceholderevidence0001";
    const placeholderReviewId = "la_object_reviewplaceholderreview0001";
    const placeholderParityId = "la_object_reviewplaceholderparity0001";
    const coverageKey = "la_coverage_reviewplaceholder0001";
    const payloads = new Map<string, Record<string, unknown>>([
      [placeholderObservationId, {
        schema: "atlas.observation:v1",
        assertion_id: placeholderObservationId,
        statement: `Imported source coverage ${coverageKey} without inferred entities, claims, relationships, or dates.`,
        candidate_entity_ids: [],
        resolution_state: "research",
        recorded_at: now,
        evidence_refs: [placeholderEvidenceId]
      }],
      [placeholderEvidenceId, {
        schema: "atlas.evidence:v1",
        evidence_id: placeholderEvidenceId,
        source_kind: "migration",
        locator: "synthetic://placeholder",
        content_hash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        retrieved_at: now,
        independence_key: "synthetic-placeholder",
        extraction_method: "canonical-markdown-lossless-v1",
        excerpt: "type:: person\ndescription:: Founder and investor focused on durable cybersecurity companies."
      }],
      [placeholderReviewId, {
        schema: "atlas.review-item:v1",
        review_id: placeholderReviewId,
        candidate_id: "la_candidate_reviewplaceholder0001",
        source_coverage_keys: [coverageKey],
        recommendation: "research",
        resolution_state: "research",
        proposed_object_ids: [placeholderObservationId],
        source_evidence_ids: [placeholderEvidenceId],
        recorded_at: now
      }],
      [placeholderParityId, {
        schema: "atlas.parity-record:v1",
        parity_id: placeholderParityId,
        source_coverage_key: coverageKey,
        coverage_state: "represented",
        representation_kind: "observation",
        canonical_object_ids: [placeholderObservationId],
        idempotency_key: "la_idem_reviewplaceholder0001",
        recorded_at: now
      }]
    ]);
    const queue = await projectLocalReviewQueue({
      objects: [
        envelope(placeholderObservationId, "assertion"),
        envelope(placeholderEvidenceId, "evidence"),
        envelope(placeholderReviewId, "review"),
        envelope(placeholderParityId, "manifest")
      ],
      decryptPayload: async (object) => payloads.get(object.object_id)
    });

    expect(queue.research[0]?.headline).toBe("Founder and investor focused on durable cybersecurity companies.");
  });

  it("keeps owner-review items separate and joins their canonical evidence, parity, and proposed records", async () => {
    const review = { schema: "atlas.review-item:v1", review_id: reviewId, candidate_id: "la_candidate_reviewsite0001", source_coverage_keys: ["la_coverage_reviewsite0001"], recommendation: "owner-review", resolution_state: "owner-review", proposed_object_ids: [observationId], source_evidence_ids: [evidenceId], recorded_at: now };
    const research = { ...review, review_id: "la_object_reviewsite0002", candidate_id: "la_candidate_reviewsite0002", resolution_state: "research" };
    const deferred = { ...review, review_id: "la_object_reviewsite0003", candidate_id: "la_candidate_reviewsite0003", resolution_state: "deferred-unknown" };
    const observation = { schema: "atlas.observation:v1", assertion_id: observationId, statement: "Synthetic unresolved review context.", candidate_entity_ids: [], resolution_state: "owner-review", recorded_at: now, evidence_refs: [evidenceId] };
    const evidence = { schema: "atlas.evidence:v1", evidence_id: evidenceId, source_kind: "migration", locator: "synthetic://review", content_hash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", retrieved_at: now, independence_key: "synthetic-review", extraction_method: "canonical-markdown-lossless-v1", excerpt: "Synthetic supporting evidence." };
    const parity = { schema: "atlas.parity-record:v1", parity_id: parityId, source_coverage_key: "la_coverage_reviewsite0001", coverage_state: "represented", representation_kind: "observation", canonical_object_ids: [observationId], idempotency_key: "la_idem_reviewsite0001", recorded_at: now };
    const payloads = new Map<string, Record<string, unknown>>([
      [reviewId, review], [research.review_id, research], [deferred.review_id, deferred], [observationId, observation], [evidenceId, evidence], [parityId, parity]
    ]);
    const queue = await projectLocalReviewQueue({ objects: [envelope(reviewId, "review"), envelope(research.review_id, "review"), envelope(deferred.review_id, "review"), envelope(observationId, "assertion"), envelope(evidenceId, "evidence"), envelope(parityId, "manifest"), envelope("la_object_legacyreview0001", "page")], decryptPayload: async (object) => {
      if (object.object_type === "page") throw new Error("legacy must not decrypt");
      return payloads.get(object.object_id);
    } });

    expect(queue.owner_review).toHaveLength(1);
    expect(queue.owner_review[0]).toMatchObject({
      review_id: reviewId,
      resolution_mode: "legacy",
      recommendation: "owner-review",
      headline: "Synthetic unresolved review context.",
      proposal_label: "Observation",
      proposed_object_ids: [observationId],
      proposed_records: [observation],
      evidence_ids: [evidenceId],
      evidence: [evidence],
      source_context: [evidence],
      parity_ids: [parityId],
      parity_records: [parity],
      source_accounting: {
        exact_source_preserved: true,
        meaningful_units: [{ kind: "observation", atlas_text: "Synthetic supporting evidence." }],
        excluded_units: []
      },
      context_unavailable: false
    });
    expect(queue.research.map((item) => item.review_id)).toEqual([research.review_id]);
    expect(queue.deferred.map((item) => item.review_id)).toEqual([deferred.review_id]);
    expect(queue.automatic).toEqual([]);
  });
});
