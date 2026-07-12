import { describe, expect, it } from "vitest";
import type {
  CanonicalFactPayload,
  CanonicalRelationshipPayload,
  CanonicalResearchResultPayload
} from "@living-atlas/contracts";
import {
  canonicalResearchEvidenceId,
  canonicalResearchMutationFingerprint,
  canonicalResearchResultId,
  canonicalResearchRunId,
  evaluateResearchRecommendation
} from "./canonical-recommendation";

const now = "2026-07-11T12:00:00.000Z";
const evidenceId = "la_object_researchevidence0001";

function fact(predicate: CanonicalFactPayload["predicate"] = "status"): CanonicalFactPayload {
  return {
    schema: "atlas.fact:v1",
    assertion_id: "la_object_placeholderfact0001",
    subject_entity_id: "la_object_researchentity0001",
    predicate,
    value: { kind: "text", value: "Synthetic active status" },
    recorded_at: now,
    lineage_action: "assert",
    supersedes: [],
    evidence_links: [{ evidence_id: evidenceId, stance: "supports" }],
    confidence: {
      band: "high",
      assessment_kind: "assertion",
      method: "synthetic-fixture",
      assessed_at: now,
      evidence_refs: [evidenceId]
    }
  };
}

function relationship(): CanonicalRelationshipPayload {
  return {
    schema: "atlas.relationship:v2",
    assertion_id: "la_object_placeholderrelationship0001",
    edge_id: "la_edge_researchrelationship0001",
    source_entity_id: "la_object_researchperson0001",
    source_type: "person",
    target_entity_id: "la_object_researchorganization0001",
    target_type: "organization",
    predicate: "advises",
    valid_from: "2026",
    status: "active",
    attrs: { role: "Synthetic advisor" },
    recorded_at: now,
    lineage_action: "assert",
    supersedes: [],
    evidence_links: [{ evidence_id: evidenceId, stance: "supports" }],
    confidence: {
      band: "high",
      assessment_kind: "assertion",
      method: "synthetic-fixture",
      assessed_at: now,
      evidence_refs: [evidenceId]
    }
  };
}

function result(input: {
  index: number;
  connector_kind?: CanonicalResearchResultPayload["connector_kind"];
  independence_key?: string;
  stance?: CanonicalResearchResultPayload["stance"];
  confidence?: "high" | "medium" | "low";
  proposal?: CanonicalFactPayload | CanonicalRelationshipPayload;
  mutationHash?: string;
  proposedObjectId?: string;
}): CanonicalResearchResultPayload {
  const proposal = input.proposal ?? fact();
  const fingerprint = canonicalResearchMutationFingerprint(proposal);
  const suffix = String(input.index).padStart(4, "0");
  const pairedEvidenceId = `la_object_researchevidence${suffix}`;
  return {
    schema: "atlas.research-result:v1",
    research_result_id: `la_object_researchresult${suffix}`,
    run_id: "la_research_run_aaaaaaaaaaaaaaaaaaaaaaaa",
    candidate_id: "la_candidate_research0001",
    source_unit_id: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    algorithm_version: "canonical-research-v1",
    normalized_query_hash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    connector_kind: input.connector_kind ?? "public-web",
    upstream_identity: `synthetic-upstream-${suffix}`,
    independence_key: input.independence_key ?? `synthetic-group-${suffix}`,
    evidence_id: pairedEvidenceId,
    evidence_content_hash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    retrieved_at: now,
    stance: input.stance ?? "supports",
    identity_state: "resolved",
    identity_confidence: {
      band: input.confidence ?? "high",
      assessment_kind: "identity",
      method: "synthetic-identity",
      assessed_at: now,
      evidence_refs: [pairedEvidenceId]
    },
    proposed_object_id: input.proposedObjectId ?? fingerprint.proposed_object_id,
    proposed_mutation_hash: input.mutationHash ?? fingerprint.proposed_mutation_hash,
    recorded_at: now
  };
}

describe("canonical research recommendation", () => {
  it("derives stable run, evidence, and result IDs from their complete provenance inputs", () => {
    const run = canonicalResearchRunId({
      candidate_id: "la_candidate_research0001",
      source_unit_id: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      connector_kind: "public-web",
      normalized_query_hash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      algorithm_version: "canonical-research-v1"
    });
    const evidence = canonicalResearchEvidenceId({
      upstream_identity: "synthetic-upstream-0001",
      locator: "https://synthetic.invalid/research/0001",
      content_hash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    });
    const researchResult = canonicalResearchResultId({
      run_id: run,
      evidence_id: evidence,
      proposed_mutation_hash: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
    });

    expect(run).toMatch(/^la_research_run_[a-f0-9]{24}$/);
    expect(evidence).toMatch(/^la_object_[a-f0-9]{24}$/);
    expect(researchResult).toMatch(/^la_object_[a-f0-9]{24}$/);
    expect(canonicalResearchResultId({
      run_id: run,
      evidence_id: evidence,
      proposed_mutation_hash: "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
    })).not.toBe(researchResult);
  });

  it("fingerprints only stable semantic fact fields", () => {
    const first = fact();
    const changedEnvelope = {
      ...first,
      assertion_id: "la_object_anotherplaceholder0001",
      recorded_at: "2026-07-12T12:00:00.000Z",
      evidence_links: [{ evidence_id: "la_object_anotherevidence0001", stance: "context" as const }],
      confidence: { ...first.confidence, assessed_at: "2026-07-12T12:00:00.000Z" }
    };

    expect(canonicalResearchMutationFingerprint(changedEnvelope))
      .toEqual(canonicalResearchMutationFingerprint(first));
    expect(canonicalResearchMutationFingerprint(first)).toMatchObject({
      proposed_object_id: expect.stringMatching(/^la_object_[a-f0-9]{24}$/),
      proposed_mutation_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)
    });
  });

  it("auto-applies two independent public groups or LinkedIn plus an independent public group", () => {
    const proposal = fact();
    const fingerprint = canonicalResearchMutationFingerprint(proposal);

    expect(evaluateResearchRecommendation({
      proposal,
      ...fingerprint,
      identity_state: "resolved",
      results: [result({ index: 1, proposal }), result({ index: 2, connector_kind: "organization", proposal })]
    })).toBe("auto-apply");
    expect(evaluateResearchRecommendation({
      proposal,
      ...fingerprint,
      identity_state: "resolved",
      results: [
        result({ index: 3, connector_kind: "linkedin", proposal }),
        result({ index: 4, connector_kind: "public-web", proposal })
      ]
    })).toBe("auto-apply");
  });

  it("keeps syndicated, single-source, LinkedIn-only, context-only, and local-corpus evidence in research", () => {
    const proposal = fact();
    const fingerprint = canonicalResearchMutationFingerprint(proposal);
    const evaluate = (results: CanonicalResearchResultPayload[]) => evaluateResearchRecommendation({
      proposal,
      ...fingerprint,
      identity_state: "resolved",
      results
    });

    expect(evaluate([
      result({ index: 1, proposal, independence_key: "syndicated" }),
      result({ index: 2, proposal, independence_key: "syndicated" })
    ])).toBe("research");
    expect(evaluate([result({ index: 3, proposal })])).toBe("research");
    expect(evaluate([result({ index: 4, connector_kind: "linkedin", proposal })])).toBe("research");
    expect(evaluate([result({ index: 5, stance: "context", proposal })])).toBe("research");
    expect(evaluate([
      result({ index: 6, connector_kind: "public-web", proposal }),
      result({ index: 7, connector_kind: "local-corpus", proposal })
    ])).toBe("research");
  });

  it("sends conflicts, proposal drift, and non-high identity to owner review", () => {
    const proposal = fact();
    const fingerprint = canonicalResearchMutationFingerprint(proposal);
    const evaluate = (results: CanonicalResearchResultPayload[], identity_state: "resolved" | "ambiguous" = "resolved") => (
      evaluateResearchRecommendation({ proposal, ...fingerprint, identity_state, results })
    );

    expect(evaluate([result({ index: 1, proposal }), result({ index: 2, stance: "refutes", proposal })]))
      .toBe("owner-review");
    expect(evaluate([result({ index: 3, proposal, mutationHash: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" })]))
      .toBe("owner-review");
    expect(evaluate([result({ index: 4, proposal, proposedObjectId: "la_object_differentresearchproposal0001" })]))
      .toBe("owner-review");
    expect(evaluate([result({ index: 5, proposal, confidence: "medium" })])).toBe("owner-review");
    expect(evaluate([result({ index: 6, proposal })], "ambiguous")).toBe("owner-review");
    const correction = {
      ...proposal,
      lineage_action: "correct" as const,
      supersedes: ["la_object_priorresearchfact0001"]
    };
    const correctionFingerprint = canonicalResearchMutationFingerprint(correction);
    expect(evaluateResearchRecommendation({
      proposal: correction,
      ...correctionFingerprint,
      identity_state: "resolved",
      results: [result({ index: 7, proposal: correction }), result({ index: 8, proposal: correction })]
    })).toBe("owner-review");
  });

  it("never auto-applies contact details or inferred sensitive relationships", () => {
    const contact = fact("phone");
    const contactFingerprint = canonicalResearchMutationFingerprint(contact);
    expect(evaluateResearchRecommendation({
      proposal: contact,
      ...contactFingerprint,
      identity_state: "resolved",
      results: [result({ index: 1, proposal: contact }), result({ index: 2, proposal: contact })]
    })).toBe("owner-review");

    const edge = relationship();
    const edgeFingerprint = canonicalResearchMutationFingerprint(edge);
    expect(evaluateResearchRecommendation({
      proposal: edge,
      ...edgeFingerprint,
      identity_state: "resolved",
      relationship_basis: "inferred-sensitive",
      results: [result({ index: 3, proposal: edge }), result({ index: 4, proposal: edge })]
    })).toBe("owner-review");
    expect(evaluateResearchRecommendation({
      proposal: edge,
      ...edgeFingerprint,
      identity_state: "resolved",
      relationship_basis: "explicit",
      results: [result({ index: 5, proposal: edge }), result({ index: 6, proposal: edge })]
    })).toBe("auto-apply");
  });

  it("is invariant to input order", () => {
    const proposal = fact();
    const fingerprint = canonicalResearchMutationFingerprint(proposal);
    const results = [result({ index: 1, proposal }), result({ index: 2, connector_kind: "organization", proposal })];
    const input = { proposal, ...fingerprint, identity_state: "resolved" as const };

    expect(evaluateResearchRecommendation({ ...input, results }))
      .toBe(evaluateResearchRecommendation({ ...input, results: [...results].reverse() }));
  });
});
