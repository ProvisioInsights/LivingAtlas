import { describe, expect, it } from "vitest";
import {
  canonicalObjectTypeForPayload,
  canonicalPayloadObjectId,
  type CanonicalPayload,
  type GraphObjectEnvelope
} from "@living-atlas/contracts";
import { createCanonicalMarkdownMigration } from "@living-atlas/importer";
import { accountSourceMeaning, projectLocalReviewQueue } from "./review-projection";

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

    const orgMapping = item!.unit_mappings.find((mapping) => mapping.unit.atlas_text === "Org: Synthetic Destination Org");
    expect(orgMapping?.destination_records.map((destination) => destination.record_type)).toEqual([
      "observation",
      "relationship"
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
      resolution_mode_explanation: expect.stringContaining("parity")
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
      resolution_mode_explanation: expect.stringContaining("unit")
    });
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
    const review = { schema: "atlas.review-item:v1", review_id: reviewId, candidate_id: "la_candidate_reviewsite0001", source_coverage_keys: ["la_coverage_reviewsite0001"], recommendation: "owner-review", resolution_state: "owner-review", proposed_object_ids: [observationId], recorded_at: now };
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
