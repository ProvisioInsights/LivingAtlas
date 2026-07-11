import { createHash } from "node:crypto";
import type {
  CanonicalFactPayload,
  CanonicalRelationshipPayload,
  CanonicalResearchResultPayload
} from "@living-atlas/contracts";

export type CanonicalResearchProposal = CanonicalFactPayload | CanonicalRelationshipPayload;

export interface ResearchRecommendationInput {
  proposal: CanonicalResearchProposal;
  proposed_mutation_hash: string;
  identity_state: "resolved" | "ambiguous";
  relationship_basis?: "explicit" | "inferred-sensitive";
  results: readonly CanonicalResearchResultPayload[];
}

export type ResearchRecommendationReasonCode =
  | "qualifies-two-independent-public"
  | "qualifies-linkedin-plus-independent"
  | "insufficient-evidence"
  | "evidence-conflict"
  | "identity-ambiguous"
  | "proposal-conflict"
  | "unsupported-predicate"
  | "contact-detail-prohibited"
  | "sensitive-relationship";

export type ResearchRecommendationSummary = {
  recommendation: "auto-apply" | "owner-review" | "research";
  independence_group_count: number;
  reason_codes: ResearchRecommendationReasonCode[];
};

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]));
  }
  return value;
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function normalizedMutation(proposal: CanonicalResearchProposal): Record<string, unknown> {
  if (proposal.schema === "atlas.fact:v1") {
    return {
      kind: "fact",
      subject_entity_id: proposal.subject_entity_id,
      predicate: proposal.predicate,
      value: proposal.value,
      ...(proposal.valid_from ? { valid_from: proposal.valid_from } : {}),
      ...(proposal.valid_to ? { valid_to: proposal.valid_to } : {})
    };
  }
  return {
    kind: "relationship",
    source_entity_id: proposal.source_entity_id,
    source_type: proposal.source_type,
    target_entity_id: proposal.target_entity_id,
    target_type: proposal.target_type,
    predicate: proposal.predicate,
    valid_from: proposal.valid_from,
    ...(proposal.valid_to ? { valid_to: proposal.valid_to } : {}),
    status: proposal.status,
    attrs: proposal.attrs
  };
}

export function canonicalResearchMutationFingerprint(proposal: CanonicalResearchProposal): {
  proposed_object_id: string;
  proposed_mutation_hash: `sha256:${string}`;
} {
  const proposed_mutation_hash = sha256(JSON.stringify(stableValue(normalizedMutation(proposal))));
  return {
    proposed_object_id: `la_object_${proposed_mutation_hash.slice("sha256:".length, "sha256:".length + 24)}`,
    proposed_mutation_hash
  };
}

export function summarizeResearchRecommendation(input: ResearchRecommendationInput): ResearchRecommendationSummary {
  const fingerprint = canonicalResearchMutationFingerprint(input.proposal);
  const groups = new Map<string, CanonicalResearchResultPayload[]>();
  for (const result of input.results) {
    const group = groups.get(result.independence_key) ?? [];
    group.push(result);
    groups.set(result.independence_key, group);
  }
  const ownerReview = (reason: ResearchRecommendationReasonCode): ResearchRecommendationSummary => ({
    recommendation: "owner-review",
    independence_group_count: groups.size,
    reason_codes: [reason]
  });
  if (input.identity_state === "ambiguous"
    || input.results.some((result) => result.identity_confidence.band !== "high")) {
    return ownerReview("identity-ambiguous");
  }
  if (input.proposed_mutation_hash !== fingerprint.proposed_mutation_hash
    || input.results.some((result) => result.proposed_mutation_hash !== fingerprint.proposed_mutation_hash
      || result.proposed_object_id !== fingerprint.proposed_object_id)) {
    return ownerReview("proposal-conflict");
  }
  if (input.results.some((result) => result.stance === "refutes")) {
    return ownerReview("evidence-conflict");
  }
  if (input.proposal.lineage_action !== "assert" || input.proposal.supersedes.length > 0) {
    return ownerReview("unsupported-predicate");
  }
  if (input.proposal.schema === "atlas.fact:v1"
    && (input.proposal.predicate === "phone"
      || input.proposal.predicate === "email"
      || input.proposal.predicate === "address")) {
    return ownerReview("contact-detail-prohibited");
  }
  if (input.proposal.schema === "atlas.relationship:v2" && input.relationship_basis === "inferred-sensitive") {
    return ownerReview("sensitive-relationship");
  }

  let publicGroups = 0;
  let linkedinGroups = 0;
  for (const results of groups.values()) {
    const supporting = results.filter((result) => result.stance === "supports");
    if (supporting.some((result) => result.connector_kind === "public-web" || result.connector_kind === "organization")) {
      publicGroups += 1;
    } else if (supporting.some((result) => result.connector_kind === "linkedin")) {
      linkedinGroups += 1;
    }
  }
  if (publicGroups >= 2) {
    return {
      recommendation: "auto-apply",
      independence_group_count: groups.size,
      reason_codes: ["qualifies-two-independent-public"]
    };
  }
  if (publicGroups >= 1 && linkedinGroups >= 1) {
    return {
      recommendation: "auto-apply",
      independence_group_count: groups.size,
      reason_codes: ["qualifies-linkedin-plus-independent"]
    };
  }
  return {
    recommendation: "research",
    independence_group_count: groups.size,
    reason_codes: ["insufficient-evidence"]
  };
}

export function evaluateResearchRecommendation(input: ResearchRecommendationInput): "auto-apply" | "owner-review" | "research" {
  return summarizeResearchRecommendation(input).recommendation;
}
