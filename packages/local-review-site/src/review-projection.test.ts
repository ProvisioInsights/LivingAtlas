import { describe, expect, it } from "vitest";
import type { GraphObjectEnvelope } from "@living-atlas/contracts";
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
    const evidence = { schema: "atlas.evidence:v1", evidence_id: evidenceId, source_kind: "migration", locator: "synthetic://review", content_hash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", retrieved_at: now, independence_key: "synthetic-review", excerpt: "Synthetic supporting evidence." };
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
        exact_source_preserved: false,
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
