import { describe, expect, it } from "vitest";
import type {
  CanonicalObservationPayload,
  CanonicalParityRecordPayload,
  CanonicalReviewItemPayload,
  GraphObjectEnvelope
} from "@living-atlas/contracts";
import { loadCanonicalParityInputsFromObjects, projectCanonicalParity } from "./canonical-parity";

const now = "2026-07-10T12:00:00.000Z";
const evidenceId = "la_object_parityevidence0001";
const observationId = "la_object_parityobservation0001";
const factId = "la_object_parityfact0001";

function parity(input: Pick<CanonicalParityRecordPayload, "parity_id" | "source_coverage_key" | "coverage_state"> & Partial<CanonicalParityRecordPayload>): CanonicalParityRecordPayload {
  const { parity_id, source_coverage_key, coverage_state, ...overrides } = input;
  return {
    schema: "atlas.parity-record:v1",
    parity_id,
    source_coverage_key,
    coverage_state,
    representation_kind: coverage_state === "represented" ? "fact" : undefined,
    canonical_object_ids: coverage_state === "represented" ? [factId] : [],
    idempotency_key: "la_idem_parityreport0001",
    recorded_at: now,
    ...overrides
  };
}

function review(input: Pick<CanonicalReviewItemPayload, "review_id" | "candidate_id" | "source_coverage_keys" | "resolution_state"> & Partial<CanonicalReviewItemPayload>): CanonicalReviewItemPayload {
  const { review_id, candidate_id, source_coverage_keys, resolution_state, ...overrides } = input;
  return {
    schema: "atlas.review-item:v1",
    review_id,
    candidate_id,
    source_coverage_keys,
    recommendation: "owner-review",
    resolution_state,
    proposed_object_ids: [observationId],
    recorded_at: now,
    ...overrides
  };
}

const observation: CanonicalObservationPayload = {
  schema: "atlas.observation:v1",
  assertion_id: observationId,
  statement: "Synthetic unresolved meaning is preserved as an observation.",
  candidate_entity_ids: [],
  resolution_state: "owner-review",
  recorded_at: now,
  evidence_refs: [evidenceId]
};

function encryptedEnvelope(objectId: string, objectType: GraphObjectEnvelope["object_type"]): GraphObjectEnvelope {
  return {
    schema_version: 1,
    authority_id: "la_authority_parity0001",
    object_id: objectId,
    object_type: objectType,
    version: 1,
    access_class: "local-private",
    encryption_class: "client-encrypted",
    created_at: now,
    updated_at: now,
    content_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    key_ref: "la_key_parity0001",
    visible_metadata: { tombstone: false, remote_indexable: false },
    payload: { kind: "ciphertext-inline", ciphertext: "synthetic-ciphertext", nonce: "synthetic-nonce", algorithm: "xchacha20-poly1305" }
  };
}

describe("canonical parity projection", () => {
  it("separates unrepresented coverage from preserved unresolved truth", () => {
    const represented = parity({
      parity_id: "la_object_parityrecord0001",
      source_coverage_key: "la_coverage_parity0001",
      coverage_state: "represented"
    });
    const unrepresented = parity({
      parity_id: "la_object_parityrecord0002",
      source_coverage_key: "la_coverage_parity0002",
      coverage_state: "unrepresented"
    });
    const ownerReview = review({
      review_id: "la_object_parityreview0001",
      candidate_id: "la_candidate_parity0001",
      source_coverage_keys: [represented.source_coverage_key],
      resolution_state: "owner-review"
    });

    const report = projectCanonicalParity({
      parity_records: [represented, unrepresented],
      reviews: [ownerReview],
      observations: [observation],
      canonical_object_ids: new Set([factId, observationId])
    });

    expect(report.totals).toEqual({ coverage: 2, represented: 1, unrepresented: 1 });
    expect(report.open_review_ids).toEqual([ownerReview.review_id]);
    expect(report.blockers).toEqual(["unrepresented-coverage"]);
    expect(report.cutover_ready).toBe(false);
  });

  it("allows represented open review work when it references a canonical observation", () => {
    const represented = parity({
      parity_id: "la_object_parityrecord0003",
      source_coverage_key: "la_coverage_parity0003",
      coverage_state: "represented",
      representation_kind: "observation",
      canonical_object_ids: [observationId]
    });
    const research = review({
      review_id: "la_object_parityreview0002",
      candidate_id: "la_candidate_parity0002",
      source_coverage_keys: [represented.source_coverage_key],
      resolution_state: "research"
    });

    const report = projectCanonicalParity({
      parity_records: [represented],
      reviews: [research],
      observations: [observation],
      canonical_object_ids: new Set([observationId])
    });
    expect(report.blockers).toEqual([]);
    expect(report.semantic_parity_ready).toBe(true);
    expect(report.cutover_ready).toBe(false);
    expect(report.cutover_blockers).toContain("backup-restore-unverified");
  });

  it("blocks missing canonical coverage and open review without an observation", () => {
    const missingObject = parity({
      parity_id: "la_object_parityrecord0004",
      source_coverage_key: "la_coverage_parity0004",
      coverage_state: "represented",
      canonical_object_ids: ["la_object_missingcanonical0001"]
    });
    const ownerReview = review({
      review_id: "la_object_parityreview0003",
      candidate_id: "la_candidate_parity0003",
      source_coverage_keys: [missingObject.source_coverage_key],
      resolution_state: "owner-review",
      proposed_object_ids: [factId]
    });

    expect(projectCanonicalParity({
      parity_records: [missingObject],
      reviews: [ownerReview],
      observations: [],
      canonical_object_ids: new Set([factId])
    }).blockers).toEqual([
      "open-review-missing-coverage",
      "open-review-without-observation",
      "represented-coverage-missing-object"
    ]);
  });

  it("loads only canonical parity, review, and observation envelopes", async () => {
    const represented = parity({
      parity_id: "la_object_parityrecord0005",
      source_coverage_key: "la_coverage_parity0005",
      coverage_state: "represented"
    });
    const item = review({
      review_id: "la_object_parityreview0004",
      candidate_id: "la_candidate_parity0004",
      source_coverage_keys: [represented.source_coverage_key],
      resolution_state: "resolved"
    });
    const payloads = new Map<string, Record<string, unknown>>([
      [represented.parity_id, represented], [item.review_id, item], [observation.assertion_id, observation]
    ]);
    const legacy = encryptedEnvelope("la_object_legacypage0002", "page");

    await expect(loadCanonicalParityInputsFromObjects([
      legacy,
      encryptedEnvelope(represented.parity_id, "manifest"),
      encryptedEnvelope(item.review_id, "review"),
      encryptedEnvelope(observation.assertion_id, "assertion")
    ], async (object) => {
      if (object.object_type === "page") throw new Error("legacy objects must not be decrypted");
      return payloads.get(object.object_id);
    })).resolves.toEqual({
      parity_records: [represented], reviews: [item], observations: [observation], canonical_object_ids: new Set([represented.parity_id, item.review_id, observation.assertion_id])
    });
  });
});
