import { createHash } from "node:crypto";
import {
  CanonicalPayloadSchema,
  type CanonicalPayload,
  type CanonicalReviewItemPayload,
  type GraphObjectEnvelope
} from "@living-atlas/contracts";
import {
  localResolutionApply,
  type LocalMcpContext,
  type LocalResolutionApplyInput
} from "@living-atlas/local-mcp";
import {
  projectLocalReviewQueue,
  type LocalReviewQueue,
  type LocalReviewQueueItem
} from "@living-atlas/review-projection";

const PlanSchema = "living-atlas-exact-preservation-plan:v1" as const;

export type ExactPreservationPlanEntry = {
  candidate_id: string;
  candidate_hash: `sha256:${string}`;
  review_id: string;
  review_version: number;
  eligibility_fingerprint: `sha256:${string}`;
};

export type ExactPreservationPlan = {
  schema: typeof PlanSchema;
  plan_hash: `sha256:${string}`;
  auto_apply: string[];
  manual: string[];
  entries: ExactPreservationPlanEntry[];
};

export type ExactPreservationAcknowledgement = {
  authorization: string;
  plan_hash: string;
};

export type ExactPreservationReceipt = {
  plan_hash: `sha256:${string}`;
  attempted: number;
  committed: number;
  idempotent: number;
  failed: number;
  outcomes: Array<{
    candidate_hash: `sha256:${string}`;
    outcome: "committed" | "idempotent" | "failed";
    reason_code?: "plan-stale" | "apply-rejected" | "retry-reconstruction-failed" | "reconciliation-required";
  }>;
};

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]));
  }
  return value;
}

function stableHash(value: unknown): `sha256:${string}` {
  return sha256(JSON.stringify(stableValue(value)));
}

function allQueueItems(queue: LocalReviewQueue): LocalReviewQueueItem[] {
  return [...queue.owner_review, ...queue.research, ...queue.deferred, ...queue.automatic];
}

function hasRefutingEvidence(item: LocalReviewQueueItem): boolean {
  return item.proposed_records.some((payload) => (
    (payload.schema === "atlas.fact:v1"
      || payload.schema === "atlas.relationship:v2"
      || payload.schema === "atlas.entity-resolution:v1")
    && payload.evidence_links.some((link) => link.stance === "refutes")
  ));
}

function hasIdentityOrEditIntent(item: LocalReviewQueueItem): boolean {
  return item.proposed_records.some((payload) => {
    if (payload.schema === "atlas.entity-resolution:v1") return true;
    if (payload.schema === "atlas.fact:v1" || payload.schema === "atlas.relationship:v2") {
      return payload.lineage_action !== "assert" || payload.supersedes.length > 0;
    }
    if (payload.schema === "atlas.observation:v1") return (payload.supersedes?.length ?? 0) > 0;
    return false;
  });
}

function parityCoverageIsExact(item: LocalReviewQueueItem): boolean {
  const expected = new Set(item.review_record.source_coverage_keys);
  const actual = new Set(item.parity_records.map((parity) => parity.source_coverage_key));
  return item.parity_records.length === expected.size
    && actual.size === expected.size
    && [...expected].every((coverageKey) => actual.has(coverageKey));
}

function isZeroMeaningCandidate(item: LocalReviewQueueItem): boolean {
  return item.source_accounting.meaningful_units.length === 0
    && item.proposed_object_ids.length === 0
    && item.proposed_records.length === 0
    && parityCoverageIsExact(item)
    && item.parity_records.every((parity) => (
      parity.coverage_state === "unrepresented"
      && parity.meaning_state === "non-meaningful"
      && parity.representation_kind === undefined
      && parity.canonical_object_ids.length === 0
    ));
}

function isCompleteRichCandidate(item: LocalReviewQueueItem): boolean {
  if (item.resolution_mode !== "rich" || item.source_accounting.meaningful_units.length === 0) return false;
  if (!parityCoverageIsExact(item)) return false;
  const proposedIds = new Set(item.proposed_object_ids);
  const representedObservationIds = new Set(item.parity_records.flatMap((parity) => (
    parity.coverage_state === "represented" && parity.representation_kind === "observation"
      ? parity.canonical_object_ids
      : []
  )));
  if (representedObservationIds.size === 0
    || item.parity_records.some((parity) => (
      parity.coverage_state !== "represented"
      || parity.representation_kind !== "observation"
      || parity.canonical_object_ids.length === 0
      || parity.canonical_object_ids.some((objectId) => !proposedIds.has(objectId))
    ))) return false;
  return item.unit_mappings.length === item.source_accounting.meaningful_units.length
    && item.unit_mappings.every((mapping) => (
      mapping.unit_evidence_ids.length > 0
      && mapping.destination_records.length > 0
      && mapping.observation_ids.some((objectId) => representedObservationIds.has(objectId))
    ));
}

function exactPreservationEligible(item: LocalReviewQueueItem): boolean {
  if (item.resolution_state === "auto-applied" || item.resolution_state === "resolved") return false;
  if (item.resolution_state === "deferred-unknown") return false;
  if (item.context_unavailable || !item.exact_source_encrypted || item.source_context.length === 0) return false;
  if (!item.source_context.every((evidence) => evidence.extraction_method === "canonical-markdown-lossless-v1")) return false;
  if (item.missing_references.length > 0 || (item.review_record.auto_apply_blockers?.length ?? 0) > 0) return false;
  if (hasRefutingEvidence(item) || hasIdentityOrEditIntent(item)) return false;
  return isZeroMeaningCandidate(item) || isCompleteRichCandidate(item);
}

function eligibilityFingerprint(item: LocalReviewQueueItem): `sha256:${string}` {
  return stableHash({
    review_version: item.review_version,
    review_record: item.review_record,
    proposed_records: item.proposed_records,
    evidence: item.evidence,
    source_context: item.source_context,
    unit_mappings: item.unit_mappings,
    parity_records: item.parity_records,
    source_accounting: item.source_accounting,
    missing_references: item.missing_references,
    context_unavailable: item.context_unavailable,
    exact_source_encrypted: item.exact_source_encrypted,
    resolution_mode: item.resolution_mode
  });
}

function planHashInput(plan: Omit<ExactPreservationPlan, "plan_hash">): unknown {
  return {
    schema: plan.schema,
    auto_apply: [...plan.auto_apply].sort(),
    manual: [...plan.manual].sort(),
    entries: [...plan.entries].sort((left, right) => left.candidate_id.localeCompare(right.candidate_id))
  };
}

export function planExactPreservation(queue: LocalReviewQueue): ExactPreservationPlan {
  const unresolved = allQueueItems(queue).filter((item) => (
    item.resolution_state !== "auto-applied" && item.resolution_state !== "resolved"
  ));
  const autoItems = unresolved.filter(exactPreservationEligible)
    .sort((left, right) => left.candidate_id.localeCompare(right.candidate_id));
  const manual = unresolved.filter((item) => !exactPreservationEligible(item))
    .map((item) => item.candidate_id)
    .sort();
  const entries = autoItems.map((item): ExactPreservationPlanEntry => ({
    candidate_id: item.candidate_id,
    candidate_hash: sha256(item.candidate_id),
    review_id: item.review_id,
    review_version: item.review_version,
    eligibility_fingerprint: eligibilityFingerprint(item)
  }));
  const withoutHash = {
    schema: PlanSchema,
    auto_apply: autoItems.map((item) => item.candidate_id),
    manual,
    entries
  };
  return { ...withoutHash, plan_hash: stableHash(planHashInput(withoutHash)) };
}

async function canonicalPayloadForObject(
  context: LocalMcpContext,
  object: GraphObjectEnvelope
): Promise<CanonicalPayload | undefined> {
  if (object.payload.kind === "plaintext-json") {
    const parsed = CanonicalPayloadSchema.safeParse(object.payload.data);
    return parsed.success ? parsed.data : undefined;
  }
  const decrypted = await context.decryptPayload?.(object).catch(() => undefined);
  const data = decrypted && "kind" in decrypted && decrypted.kind === "plaintext-json"
    ? decrypted.data
    : decrypted;
  const parsed = CanonicalPayloadSchema.safeParse(data);
  return parsed.success ? parsed.data : undefined;
}

async function currentQueue(context: LocalMcpContext): Promise<LocalReviewQueue> {
  const objects = context.graphStore!.listObjects();
  return projectLocalReviewQueue({
    objects,
    decryptPayload: async (object) => canonicalPayloadForObject(context, object)
  });
}

function cleanResolution(result: Awaited<ReturnType<typeof localResolutionApply>>): boolean {
  return result.ok
    && result.result.local_commit === "committed"
    && result.result.audit === "recorded"
    && (result.result.sync_queue === "queued" || result.result.sync_queue === "not-configured");
}

function identifiers(candidateId: string): { operation_id: string; idempotency_key: string } {
  const digest = sha256(`exact-source-preservation:v1:${candidateId}`).slice("sha256:".length, "sha256:".length + 24);
  return {
    operation_id: `la_operation_${digest}`,
    idempotency_key: `la_idem_${digest}`
  };
}

function reviewDraft(
  object: GraphObjectEnvelope,
  payload: CanonicalReviewItemPayload,
  version: number,
  updatedAt: string
): GraphObjectEnvelope {
  return {
    ...object,
    version,
    updated_at: updatedAt,
    content_hash: stableHash(payload),
    payload: { kind: "plaintext-json", data: payload }
  };
}

async function retryRequest(
  context: LocalMcpContext,
  entry: ExactPreservationPlanEntry,
  authorization: string,
  identifiersForCandidate: ReturnType<typeof identifiers>
): Promise<LocalResolutionApplyInput | undefined> {
  const prior = context.graphStore!.operationRecordForIdempotency(identifiersForCandidate.idempotency_key);
  if (!prior) return undefined;
  const stored = prior.objects.find((object) => object.object_id === entry.review_id);
  if (!stored || prior.generation < 1) return undefined;
  const payload = await canonicalPayloadForObject(context, stored);
  if (payload?.schema !== "atlas.review-item:v1") return undefined;
  return {
    authorization,
    ...identifiersForCandidate,
    candidate_id: entry.candidate_id,
    expected_generation: prior.generation - 1,
    expected_review_version: entry.review_version,
    objects: [reviewDraft(stored, payload, stored.version, stored.updated_at)]
  };
}

export async function applyExactPreservation(
  context: LocalMcpContext,
  plan: ExactPreservationPlan,
  acknowledgement: ExactPreservationAcknowledgement
): Promise<ExactPreservationReceipt> {
  const recomputedHash = stableHash(planHashInput({
    schema: plan.schema,
    auto_apply: plan.auto_apply,
    manual: plan.manual,
    entries: plan.entries
  }));
  if (acknowledgement.plan_hash !== plan.plan_hash || recomputedHash !== plan.plan_hash) {
    throw new Error("exact preservation plan acknowledgement mismatch");
  }
  if (!context.graphStore || !context.decryptPayload) {
    throw new Error("exact preservation requires an encrypted durable local graph context");
  }

  const entriesByCandidate = new Map(plan.entries.map((entry) => [entry.candidate_id, entry]));
  const outcomes: ExactPreservationReceipt["outcomes"] = [];
  let committed = 0;
  let idempotent = 0;
  let cachedQueue: LocalReviewQueue | undefined;
  let knownGeneration: number | undefined;
  const freshQueue = async (): Promise<LocalReviewQueue> => {
    let startGeneration: number;
    let endGeneration: number;
    let queue: LocalReviewQueue;
    do {
      startGeneration = context.graphStore!.status().generation;
      queue = await currentQueue(context);
      endGeneration = context.graphStore!.status().generation;
    } while (startGeneration !== endGeneration);
    cachedQueue = queue;
    knownGeneration = endGeneration;
    return queue;
  };
  for (const candidateId of plan.auto_apply) {
    const entry = entriesByCandidate.get(candidateId);
    if (!entry) continue;
    const stableIdentifiers = identifiers(candidateId);
    const prior = context.graphStore.operationRecordForIdempotency(stableIdentifiers.idempotency_key);
    if (prior) {
      const request = await retryRequest(context, entry, acknowledgement.authorization, stableIdentifiers);
      if (!request) {
        outcomes.push({ candidate_hash: entry.candidate_hash, outcome: "failed", reason_code: "retry-reconstruction-failed" });
        continue;
      }
      const result = await localResolutionApply(context, request);
      if (cleanResolution(result)) {
        idempotent += 1;
        outcomes.push({ candidate_hash: entry.candidate_hash, outcome: "idempotent" });
      } else {
        outcomes.push({
          candidate_hash: entry.candidate_hash,
          outcome: "failed",
          reason_code: result.ok ? "reconciliation-required" : "apply-rejected"
        });
      }
      continue;
    }

    const actualGeneration = context.graphStore.status().generation;
    const queue = !cachedQueue || knownGeneration !== actualGeneration ? await freshQueue() : cachedQueue;
    const item = allQueueItems(queue).find((candidate) => candidate.candidate_id === candidateId);
    if (!item
      || item.review_id !== entry.review_id
      || item.review_version !== entry.review_version
      || eligibilityFingerprint(item) !== entry.eligibility_fingerprint
      || !exactPreservationEligible(item)) {
      outcomes.push({ candidate_hash: entry.candidate_hash, outcome: "failed", reason_code: "plan-stale" });
      continue;
    }
    const existingReview = context.graphStore.readObject(item.review_id);
    if (!existingReview) {
      outcomes.push({ candidate_hash: entry.candidate_hash, outcome: "failed", reason_code: "plan-stale" });
      continue;
    }
    const resolvedReview: CanonicalReviewItemPayload = {
      ...item.review_record,
      recommendation: "auto-apply",
      resolution_state: "auto-applied"
    };
    const request: LocalResolutionApplyInput = {
      authorization: acknowledgement.authorization,
      ...stableIdentifiers,
      candidate_id: candidateId,
      expected_generation: context.graphStore.status().generation,
      expected_review_version: item.review_version,
      objects: [reviewDraft(
        existingReview,
        resolvedReview,
        item.review_version + 1,
        context.now ?? new Date().toISOString()
      )]
    };
    const result = await localResolutionApply(context, request);
    if (cleanResolution(result)) {
      committed += 1;
      outcomes.push({ candidate_hash: entry.candidate_hash, outcome: "committed" });
      knownGeneration = context.graphStore.status().generation;
    } else {
      outcomes.push({
        candidate_hash: entry.candidate_hash,
        outcome: "failed",
        reason_code: result.ok ? "reconciliation-required" : "apply-rejected"
      });
    }
  }
  return {
    plan_hash: plan.plan_hash,
    attempted: plan.auto_apply.length,
    committed,
    idempotent,
    failed: outcomes.filter((outcome) => outcome.outcome === "failed").length,
    outcomes
  };
}
