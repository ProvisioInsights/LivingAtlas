import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureAuthorityId, fixtureLocalClientId } from "@living-atlas/fixtures";
import { FileLocalGraphStore } from "@living-atlas/local-graph-store";
import { createDefaultLocalKeyring } from "@living-atlas/local-keyring";

const now = "2026-07-10T12:00:00.000Z";
const hash = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

export async function createCanonicalSyntheticMvpFixture() {
  const directory = await mkdtemp(join(tmpdir(), "living-atlas-canonical-mvp-"));
  const keyring = createDefaultLocalKeyring({ authorityId: fixtureAuthorityId, createdAt: now });
  const store = await FileLocalGraphStore.open({ directory, authorityId: fixtureAuthorityId, plaintextPersistence: "encrypt", keyring });
  const entityId = "la_object_canonicalmvpentity0001";
  const evidenceId = "la_object_canonicalmvpevidence0001";
  const factId = "la_object_canonicalmvpfact0001";
  const reviewId = "la_object_canonicalmvpreview0001";
  const parityId = "la_object_canonicalmvpparity0001";
  const draft = (object_id: string, object_type: string, data: Record<string, unknown>) => ({ schema_version: 1 as const, authority_id: fixtureAuthorityId, object_id, object_type, version: 1, access_class: "local-private" as const, encryption_class: "plaintext" as const, created_at: now, updated_at: now, content_hash: hash, visible_metadata: { tombstone: false, remote_indexable: false }, payload: { kind: "plaintext-json" as const, data } });
  const objects = [
    draft(entityId, "entity", { schema: "atlas.entity:v1", entity_id: entityId, type: "organization", subtype: "company", name: "Synthetic Canonical Entity", aliases: [], created_at: now, updated_at: now }),
    draft(evidenceId, "evidence", { schema: "atlas.evidence:v1", evidence_id: evidenceId, source_kind: "migration", locator: "synthetic://canonical-mvp", content_hash: hash, retrieved_at: now, independence_key: "synthetic-canonical-mvp", excerpt: "Synthetic canonical evidence." }),
    draft(factId, "assertion", { schema: "atlas.fact:v1", assertion_id: factId, subject_entity_id: entityId, predicate: "name", value: { kind: "text", value: "Synthetic Canonical Entity" }, recorded_at: now, lineage_action: "assert", supersedes: [], evidence_links: [{ evidence_id: evidenceId, stance: "supports" }], confidence: { band: "high", assessment_kind: "assertion", method: "synthetic-canonical-mvp", assessed_at: now, evidence_refs: [evidenceId] } }),
    draft(reviewId, "review", { schema: "atlas.review-item:v1", review_id: reviewId, candidate_id: "la_candidate_canonicalmvp0001", source_coverage_keys: ["la_coverage_canonicalmvp0001"], recommendation: "owner-review", resolution_state: "owner-review", proposed_object_ids: [factId], recorded_at: now }),
    draft(parityId, "manifest", { schema: "atlas.parity-record:v1", parity_id: parityId, source_coverage_key: "la_coverage_canonicalmvp0001", coverage_state: "represented", representation_kind: "fact", canonical_object_ids: [factId], idempotency_key: "la_idem_canonicalmvp0001", recorded_at: now })
  ];
  const result = await store.commitTransaction({ expected_generation: 0, actor_id: fixtureLocalClientId, operation_id: "la_operation_canonicalmvp0001", idempotency_key: "la_idem_canonicalmvp0001", recorded_at: now, writes: objects.map((object) => ({ kind: "create" as const, object })) });
  if (!result.ok) throw new Error(`canonical fixture failed: ${result.reason}`);
  return { directory, keyring, store, dispose: () => rm(directory, { recursive: true, force: true }) };
}
