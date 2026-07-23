import { createHash } from "node:crypto";
import {
  buildLocalReviewDecisionPlan,
  projectLocalReviewQueue,
  type LocalReviewDecisionAction,
  type LocalReviewQueueItem
} from "@living-atlas/review-projection";
import {
  CanonicalPayloadSchema,
  canonicalPayloadObjectId,
  type CanonicalEvidencePayload,
  type CanonicalPayload,
  type CanonicalReviewItemPayload,
  type GraphObjectEnvelope
} from "@living-atlas/contracts";
import { authenticateLocalMcp } from "./auth";
import { createLocalMcpAuditEvent } from "./audit";
import {
  localResolutionApply,
  type LocalGraphToolInput,
  type LocalGraphToolResult,
  type LocalMcpContext
} from "./local-graph";

export type LocalReviewListInput = LocalGraphToolInput & {
  queue?: "actionable" | "owner-review" | "research" | "deferred" | "automatic" | "all";
  limit?: number;
};

export type LocalReviewReadInput = LocalGraphToolInput & {
  candidate_id: string;
};

export type LocalReviewDecideInput = LocalGraphToolInput & {
  action: LocalReviewDecisionAction;
  candidate_ids: string[];
  preview_only?: boolean;
  preview_token?: string;
};

type ReviewProjection = Awaited<ReturnType<typeof projectLocalReviewQueue>>;
type AtlasObservatorySummary = {
  object_count: number;
  object_type_counts: Record<string, number>;
  generation: number;
  change_count: number;
};
type ReviewAccess = {
  objects: GraphObjectEnvelope[];
  decryptPayload: (object: GraphObjectEnvelope) => Promise<Record<string, unknown> | undefined>;
  observatory: AtlasObservatorySummary;
  client_id: string;
  profile: string;
};

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function now(context: LocalMcpContext): string {
  return context.now ?? new Date().toISOString();
}

async function authenticatedReviewAccess(
  context: LocalMcpContext,
  authorization: string,
  toolName: "review_list" | "review_read" | "review_decide"
): Promise<
  | ({ ok: true } & ReviewAccess)
  | { ok: false; reason: string }
> {
  const auth = await authenticateLocalMcp({
    authorizationHeader: authorization,
    credentialStore: context.credentialStore,
    controlPlane: context.controlPlane,
    auditSink: context.auditSink,
    now: context.now
  });
  if (!auth.ok) return { ok: false, reason: auth.reason };
  if (!auth.authenticated.capability.operations.includes("read")
    || !auth.authenticated.capability.access_classes.includes("local-private")) {
    context.auditSink?.record(createLocalMcpAuditEvent({
      event_type: "tool.denied",
      client_id: auth.authenticated.client.client_id,
      profile: auth.authenticated.capability.profile,
      operation: "read",
      tool_name: toolName,
      reason_code: "review-read-not-authorized",
      summary: "Local review read denied"
    }));
    return { ok: false, reason: "review-read-not-authorized" };
  }
  const objects = context.graphStore
    ? context.graphStore.listObjects({ include_tombstones: false })
    : context.graphObjects.filter((object) => !object.visible_metadata.tombstone);
  const decryptPayload = context.decryptPayload
    ? async (object: (typeof objects)[number]) => {
      const payload = await context.decryptPayload!(object);
      return payload?.kind === "plaintext-json" ? payload.data : undefined;
    }
    : async (object: (typeof objects)[number]) => (
      object.payload.kind === "plaintext-json" ? object.payload.data : undefined
    );
  const objectTypeCounts = objects.reduce<Record<string, number>>((counts, object) => {
    counts[object.object_type] = (counts[object.object_type] ?? 0) + 1;
    return counts;
  }, {});
  const graphStatus = context.graphStore?.status();
  context.auditSink?.record(createLocalMcpAuditEvent({
    event_type: "tool.allowed",
    client_id: auth.authenticated.client.client_id,
    profile: auth.authenticated.capability.profile,
    operation: "read",
    tool_name: toolName,
    reason_code: "review-read-allowed",
    summary: "Local review projection read"
  }));
  return {
    ok: true,
    objects,
    decryptPayload,
    observatory: {
      object_count: objects.length,
      object_type_counts: objectTypeCounts,
      generation: graphStatus?.generation ?? 0,
      change_count: graphStatus?.journal_sequence ?? 0
    },
    client_id: auth.authenticated.client.client_id,
    profile: auth.authenticated.capability.profile
  };
}

async function authenticatedReviewProjection(
  context: LocalMcpContext,
  authorization: string,
  toolName: "review_read" | "review_decide",
  candidateIds: readonly string[]
): Promise<
  | {
      ok: true;
      projection: ReviewProjection;
      observatory: AtlasObservatorySummary;
      client_id: string;
      profile: string;
    }
  | { ok: false; reason: string }
> {
  const access = await authenticatedReviewAccess(context, authorization, toolName);
  if (!access.ok) return access;
  const projection = await projectLocalReviewQueue({
    objects: access.objects,
    decryptPayload: access.decryptPayload,
    candidateIds
  });
  return { ...access, projection };
}

function allReviewItems(projection: ReviewProjection): LocalReviewQueueItem[] {
  return [
    ...projection.owner_review,
    ...projection.research,
    ...projection.deferred,
    ...projection.automatic
  ];
}

function summary(item: LocalReviewQueueItem) {
  return {
    review_id: item.review_id,
    review_version: item.review_version,
    candidate_id: item.candidate_id,
    recommendation: item.recommendation,
    resolution_state: item.resolution_state,
    headline: item.headline,
    proposal_label: item.proposal_label,
    evidence_count: item.evidence.length,
    independence_group_count: item.recommendation_rationale.independence_group_count,
    graph_node_count: item.graph.nodes.length,
    graph_edge_count: item.graph.edges.length,
    context_unavailable: item.context_unavailable,
    exact_source_encrypted: item.exact_source_encrypted,
    resolution_mode: item.resolution_mode,
    bulk_compatibility_key: item.bulk_compatibility_key,
    recorded_at: item.review_record.recorded_at
  };
}

function reviewMatchesQueue(review: CanonicalReviewItemPayload, queue: LocalReviewListInput["queue"]) {
  if (queue === "owner-review") return review.resolution_state === "owner-review";
  if (queue === "research") return review.resolution_state === "research";
  if (queue === "deferred") return review.resolution_state === "deferred-unknown";
  if (queue === "automatic") return review.resolution_state === "auto-applied" || review.resolution_state === "resolved";
  if (queue === "all") return true;
  return review.resolution_state === "owner-review" || review.resolution_state === "research";
}

async function lightweightReviewSummaries(
  access: ReviewAccess,
  queue: LocalReviewListInput["queue"],
  limit: number
) {
  const payloads = new Map<string, CanonicalPayload>();
  const envelopes = new Map(access.objects.map((object) => [object.object_id, object]));
  const decryptObject = async (object: GraphObjectEnvelope | undefined) => {
    if (!object || object.visible_metadata.tombstone || payloads.has(object.object_id)) return;
    // A malformed or legacy oversized ciphertext must not make the entire
    // owner queue unreadable. Full review reads still fail closed for the exact
    // candidate; the bounded list skips an object it cannot safely project.
    try {
      const payload = await access.decryptPayload(object);
      if (!payload) return;
      const parsed = CanonicalPayloadSchema.safeParse(payload);
      if (parsed.success) payloads.set(canonicalPayloadObjectId(parsed.data), parsed.data);
    } catch {
      return;
    }
  };
  for (const object of access.objects) {
    if (object.object_type === "review") await decryptObject(object);
  }
  const allReviews = [...payloads.values()]
    .filter((payload): payload is CanonicalReviewItemPayload => payload.schema === "atlas.review-item:v1")
    .sort((left, right) => left.review_id.localeCompare(right.review_id));
  const reviews = allReviews.filter((review) => reviewMatchesQueue(review, queue)).slice(0, limit);
  const initiallyReferenced = new Set(reviews.flatMap((review) => [
    ...review.proposed_object_ids,
    ...(review.source_evidence_ids ?? [])
  ]));
  for (const id of initiallyReferenced) await decryptObject(envelopes.get(id));
  const linkedEvidenceIds = new Set<string>();
  for (const review of reviews) {
    for (const id of review.proposed_object_ids) {
      const payload = payloads.get(id);
      if (payload?.schema === "atlas.observation:v1") payload.evidence_refs.forEach((evidenceId) => linkedEvidenceIds.add(evidenceId));
      if (payload?.schema === "atlas.fact:v1" || payload?.schema === "atlas.relationship:v2") {
        payload.evidence_links.forEach((link) => linkedEvidenceIds.add(link.evidence_id));
      }
    }
  }
  for (const id of linkedEvidenceIds) await decryptObject(envelopes.get(id));
  const summaries = reviews.map((review) => {
    const proposed = review.proposed_object_ids.flatMap((id) => {
      const payload = payloads.get(id);
      return payload ? [payload] : [];
    });
    const evidenceIds = new Set(review.source_evidence_ids ?? []);
    for (const payload of proposed) {
      if (payload.schema === "atlas.observation:v1") payload.evidence_refs.forEach((id) => evidenceIds.add(id));
      if (payload.schema === "atlas.fact:v1" || payload.schema === "atlas.relationship:v2") {
        payload.evidence_links.forEach((link) => evidenceIds.add(link.evidence_id));
      }
    }
    const evidence = [...evidenceIds].flatMap((id) => {
      const payload = payloads.get(id);
      return payload?.schema === "atlas.evidence:v1" ? [payload] : [];
    });
    const observation = proposed.find((payload) => payload.schema === "atlas.observation:v1");
    const fallbackEvidence = evidence.find((item) => item.excerpt?.trim());
    const headline = observation?.schema === "atlas.observation:v1"
      && !observation.statement.startsWith("Imported source coverage ")
      ? observation.statement
      : fallbackEvidence?.excerpt?.trim().slice(0, 240) ?? "Review candidate";
    const graphNodeCount = proposed.filter((payload) => (
      payload.schema === "atlas.entity:v1"
        || payload.schema === "atlas.fact:v1"
        || payload.schema === "atlas.observation:v1"
    )).length;
    const graphEdgeCount = proposed.filter((payload) => (
      payload.schema === "atlas.relationship:v2"
        || payload.schema === "atlas.fact:v1"
        || payload.schema === "atlas.observation:v1"
    )).length;
    const sourceEvidence = evidence.filter((item) => (review.source_evidence_ids ?? []).includes(item.evidence_id));
    const descriptor = {
      recommendation: review.recommendation,
      resolution_state: review.resolution_state,
      proposed_object_ids: [...review.proposed_object_ids].sort(),
      evidence_ids: [...evidenceIds].sort(),
      independence_keys: [...new Set(evidence.map((item) => item.independence_key))].sort()
    };
    return {
      review_id: review.review_id,
      review_version: envelopes.get(review.review_id)?.version ?? 0,
      candidate_id: review.candidate_id,
      recommendation: review.recommendation,
      resolution_state: review.resolution_state,
      headline,
      proposal_label: observation ? "Observation" : "Atlas record",
      evidence_count: evidence.length,
      independence_group_count: new Set(evidence.map((item) => item.independence_key)).size,
      graph_node_count: graphNodeCount,
      graph_edge_count: graphEdgeCount,
      context_unavailable: sourceEvidence.length === 0,
      exact_source_encrypted: sourceEvidence.length > 0 && sourceEvidence.every((item: CanonicalEvidencePayload) => (
        envelopes.get(item.evidence_id)?.encryption_class === "client-encrypted"
      )),
      resolution_mode: proposed.length === review.proposed_object_ids.length ? "rich" : "incomplete",
      bulk_compatibility_key: `sha256:${digest(descriptor)}`,
      recorded_at: review.recorded_at
    };
  });
  return {
    summaries,
    total: allReviews.filter((review) => reviewMatchesQueue(review, queue)).length,
    review_counts: {
      owner_review: allReviews.filter((review) => review.resolution_state === "owner-review").length,
      research: allReviews.filter((review) => review.resolution_state === "research").length,
      deferred: allReviews.filter((review) => review.resolution_state === "deferred-unknown").length,
      automatic: allReviews.filter((review) => review.resolution_state === "auto-applied" || review.resolution_state === "resolved").length
    }
  };
}

export async function localReviewList(
  context: LocalMcpContext,
  input: LocalReviewListInput
): Promise<LocalGraphToolResult<unknown>> {
  const requested = input.queue ?? "actionable";
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
  const projected = await authenticatedReviewAccess(context, input.authorization, "review_list");
  if (!projected.ok) return projected;
  const projection = await lightweightReviewSummaries(projected, requested, limit);
  const visible = projection.summaries;
  const groups = new Map<string, string[]>();
  for (const item of visible) {
    const ids = groups.get(item.bulk_compatibility_key) ?? [];
    ids.push(item.candidate_id);
    groups.set(item.bulk_compatibility_key, ids);
  }
  return {
    ok: true,
    result: {
      schema: "living-atlas.review-list:v1",
      queue: requested,
      total: projection.total,
      observatory: {
        ...projected.observatory,
        review_counts: projection.review_counts
      },
      items: visible,
      compatible_groups: [...groups.entries()]
        .filter(([, candidateIds]) => candidateIds.length > 1)
        .map(([bulk_compatibility_key, candidate_ids]) => ({
          bulk_compatibility_key,
          candidate_ids,
          count: candidate_ids.length
        }))
    }
  };
}

export async function localReviewRead(
  context: LocalMcpContext,
  input: LocalReviewReadInput
): Promise<LocalGraphToolResult<unknown>> {
  const projected = await authenticatedReviewProjection(
    context,
    input.authorization,
    "review_read",
    [input.candidate_id]
  );
  if (!projected.ok) return projected;
  const item = allReviewItems(projected.projection)
    .find((candidate) => candidate.candidate_id === input.candidate_id);
  if (!item) return { ok: false, reason: "review-candidate-not-found" };
  return {
    ok: true,
    result: {
      schema: "living-atlas.review-detail:v1",
      item
    }
  };
}

function previewFor(context: LocalMcpContext, items: LocalReviewQueueItem[], action: LocalReviewDecisionAction) {
  if (!context.graphStore) return { ok: false as const, reason: "resolution-requires-durable-local-store" };
  if (items.length === 0 || items.length > 100) {
    return { ok: false as const, reason: "review-selection-invalid" };
  }
  if (new Set(items.map((item) => item.bulk_compatibility_key)).size !== 1 && items.length > 1) {
    return { ok: false as const, reason: "heterogeneous-bulk-selection" };
  }
  const store = {
    authority_id: context.controlPlane.authority.authority_id,
    generation: context.graphStore.status().generation,
    now: now(context),
    readObject: (objectId: string) => context.graphStore!.readObject(objectId)
  };
  const plans = items.map((item) => buildLocalReviewDecisionPlan({ store, item, action }));
  if (plans.some((plan) => !plan)) {
    return { ok: false as const, reason: "candidate-records-incomplete" };
  }
  const normalized = {
    action,
    candidate_ids: items.map((item) => item.candidate_id).sort(),
    generation: store.generation,
    review_versions: plans.map((plan) => ({
      candidate_id: plan!.candidate_id,
      review_id: plan!.review_id,
      version: plan!.expected_review_version
    })).sort((left, right) => left.candidate_id.localeCompare(right.candidate_id)),
    bulk_compatibility_key: items[0]!.bulk_compatibility_key,
    counts: {
      candidates: items.length,
      object_mutations: plans.reduce((count, plan) => count + plan!.objects.length, 0),
      evidence: items.reduce((count, item) => count + item.evidence.length, 0),
      independence_groups: items.reduce(
        (count, item) => count + item.recommendation_rationale.independence_group_count,
        0
      )
    }
  };
  return {
    ok: true as const,
    preview: {
      ...normalized,
      preview_token: `sha256:${digest(normalized)}`
    }
  };
}

export async function localReviewDecide(
  context: LocalMcpContext,
  input: LocalReviewDecideInput
): Promise<LocalGraphToolResult<unknown>> {
  const projected = await authenticatedReviewProjection(
    context,
    input.authorization,
    "review_decide",
    input.candidate_ids
  );
  if (!projected.ok) return projected;
  const ids = [...new Set(input.candidate_ids)].sort();
  if (ids.length !== input.candidate_ids.length) {
    return { ok: false, reason: "review-selection-invalid" };
  }
  const byId = new Map(allReviewItems(projected.projection).map((item) => [item.candidate_id, item]));
  const items = ids.flatMap((candidateId) => {
    const item = byId.get(candidateId);
    return item ? [item] : [];
  });
  if (items.length !== ids.length) return { ok: false, reason: "review-candidate-not-found" };
  const preview = previewFor(context, items, input.action);
  if (!preview.ok) return preview;
  if (input.preview_only !== false || !input.preview_token) {
    return { ok: true, result: { schema: "living-atlas.review-decision-preview:v1", ...preview.preview } };
  }
  if (input.preview_token !== preview.preview.preview_token) {
    return { ok: false, reason: "review-preview-stale", result: preview.preview };
  }

  const results: Array<{ candidate_id: string; ok: boolean; reason?: string; result?: unknown }> = [];
  for (const item of items) {
    const store = {
      authority_id: context.controlPlane.authority.authority_id,
      generation: context.graphStore!.status().generation,
      now: now(context),
      readObject: (objectId: string) => context.graphStore!.readObject(objectId)
    };
    const plan = buildLocalReviewDecisionPlan({ store, item, action: input.action });
    if (!plan) {
      results.push({ candidate_id: item.candidate_id, ok: false, reason: "candidate-records-incomplete" });
      continue;
    }
    const seed = `${preview.preview.preview_token}:${item.candidate_id}:${input.action}:${plan.expected_review_version}`;
    const applied = await localResolutionApply(context, {
      authorization: input.authorization,
      operation_id: `la_operation_${digest(`operation:${seed}`).slice(0, 24)}`,
      idempotency_key: `la_idem_${digest(`idempotency:${seed}`).slice(0, 24)}`,
      candidate_id: item.candidate_id,
      expected_generation: plan.expected_generation,
      expected_review_version: plan.expected_review_version,
      objects: plan.objects
    });
    results.push({
      candidate_id: item.candidate_id,
      ok: applied.ok,
      ...(applied.ok ? { result: applied.result } : { reason: applied.reason })
    });
  }
  const committed = results.filter((result) => result.ok).map((result) => result.candidate_id);
  const failed = results.filter((result) => !result.ok).map((result) => result.candidate_id);
  return failed.length
    ? {
      ok: false,
      reason: committed.length ? "review-decision-partial-failure" : "review-decision-failed",
      result: { committed_candidate_ids: committed, failed_candidate_ids: failed, results }
    }
    : {
      ok: true,
      result: {
        schema: "living-atlas.review-decision:v1",
        committed_candidate_ids: committed,
        results
      }
    };
}
