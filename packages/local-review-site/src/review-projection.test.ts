import { describe, expect, it } from "vitest";
import type { GraphObjectEnvelope } from "@living-atlas/contracts";
import { projectLocalReviewQueue } from "./review-projection";

const now = "2026-07-10T12:00:00.000Z";
const reviewId = "la_object_reviewsite0001";
const observationId = "la_object_reviewobservation0001";
const evidenceId = "la_object_reviewevidence0001";
const parityId = "la_object_reviewparity0001";

function envelope(id: string, type: GraphObjectEnvelope["object_type"]): GraphObjectEnvelope {
  return { schema_version: 1, authority_id: "la_authority_reviewsite0001", object_id: id, object_type: type, version: 1, access_class: "local-private", encryption_class: "client-encrypted", created_at: now, updated_at: now, content_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", key_ref: "la_key_reviewsite0001", visible_metadata: { tombstone: false, remote_indexable: false }, payload: { kind: "ciphertext-inline", ciphertext: "synthetic", nonce: "synthetic", algorithm: "synthetic" } };
}

describe("local review projection", () => {
  it("keeps owner-review items separate and joins their canonical evidence, parity, and proposed records", async () => {
    const review = { schema: "atlas.review-item:v1", review_id: reviewId, candidate_id: "la_candidate_reviewsite0001", source_coverage_keys: ["la_coverage_reviewsite0001"], recommendation: "owner-review", resolution_state: "owner-review", proposed_object_ids: [observationId], recorded_at: now };
    const research = { ...review, review_id: "la_object_reviewsite0002", candidate_id: "la_candidate_reviewsite0002", resolution_state: "research" };
    const observation = { schema: "atlas.observation:v1", assertion_id: observationId, statement: "Synthetic unresolved review context.", candidate_entity_ids: [], resolution_state: "owner-review", recorded_at: now, evidence_refs: [evidenceId] };
    const evidence = { schema: "atlas.evidence:v1", evidence_id: evidenceId, source_kind: "migration", locator: "synthetic://review", content_hash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", retrieved_at: now, independence_key: "synthetic-review", excerpt: "Synthetic supporting evidence." };
    const parity = { schema: "atlas.parity-record:v1", parity_id: parityId, source_coverage_key: "la_coverage_reviewsite0001", coverage_state: "represented", representation_kind: "observation", canonical_object_ids: [observationId], idempotency_key: "la_idem_reviewsite0001", recorded_at: now };
    const payloads = new Map<string, Record<string, unknown>>([
      [reviewId, review], [research.review_id, research], [observationId, observation], [evidenceId, evidence], [parityId, parity]
    ]);
    const queue = await projectLocalReviewQueue({ objects: [envelope(reviewId, "review"), envelope(research.review_id, "review"), envelope(observationId, "assertion"), envelope(evidenceId, "evidence"), envelope(parityId, "manifest"), envelope("la_object_legacyreview0001", "page")], decryptPayload: async (object) => {
      if (object.object_type === "page") throw new Error("legacy must not decrypt");
      return payloads.get(object.object_id);
    } });

    expect(queue.owner_review).toHaveLength(1);
    expect(queue.owner_review[0]).toMatchObject({ review_id: reviewId, proposed_object_ids: [observationId], proposed_records: [observation], evidence_ids: [evidenceId], evidence: [evidence], source_context: [evidence], parity_ids: [parityId], parity_records: [parity], context_unavailable: false });
    expect(queue.research.map((item) => item.review_id)).toEqual([research.review_id]);
    expect(queue.automatic).toEqual([]);
  });
});
