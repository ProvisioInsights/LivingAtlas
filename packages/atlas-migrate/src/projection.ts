import {
  AuthorityIdSchema,
  EndpointRecordSchema,
  TemporalEdgeSchema,
  type EndpointType,
  type GraphObjectEnvelope
} from "@living-atlas/contracts";
import {
  LegacyRedirectPayloadSchema,
  classifyLegacySource,
  defaultLegacyPayloadResolver,
  tombstoneDisposition,
  type LegacyPayloadResolver,
  type LegacySourceCategory,
  type MigrationRefusalReason
} from "./legacy-source.js";
import {
  MigrationOrigin,
  MigrationRecordedAtFidelity,
  ProjectorVersion,
  canonicalDigest,
  entitySlotForLegacyObject,
  projectionIdempotencyKey,
  worldTimeFidelity,
  type EntitySlot,
  type LegacyProvenance,
  type MigrationIdempotencyKey,
  type ProjectedEntityRecord,
  type ProjectedRecord,
  type ProjectedRecordKind,
  type ProjectedRelationshipRecord
} from "./target-plane.js";

/**
 * One outcome per source object, and exactly one. The closure gate is built on
 * this being total: the old importer reported "N imported" with no denominator,
 * so nobody could tell a skipped object from an object that was never seen.
 */
export const SourceDispositionKindValues = [
  "projected-as-entity",
  "projected-as-relationship",
  "projected-as-retraction",
  "projected-as-alias-redirect",
  "unrecoverable-ciphertext",
  "redaction-stub",
  "refused",
  "other"
] as const;
export type SourceDispositionKind = (typeof SourceDispositionKindValues)[number];

export type SourceDisposition =
  | { kind: Exclude<SourceDispositionKind, "refused"> }
  | { kind: "refused"; reason: MigrationRefusalReason; detail: string };

export type PlanAliasTarget =
  | {
      kind: "record";
      record_key: MigrationIdempotencyKey;
      record_kind: ProjectedRecordKind;
      slot?: EntitySlot;
    }
  | { kind: "no-target"; disposition: SourceDispositionKind; reason?: MigrationRefusalReason; detail: string };

export type SourceOutcome = {
  legacy_object_id: string;
  legacy_object_type: string;
  category: LegacySourceCategory;
  disposition: SourceDisposition;
  record_keys: MigrationIdempotencyKey[];
  alias_target: PlanAliasTarget;
};

export type ProjectionBreakdown = {
  source_object_count: number;
  projected_count: number;
  refused_count: number;
  by_category: Array<{ category: LegacySourceCategory; count: number }>;
  by_disposition: Array<{ disposition: SourceDispositionKind; count: number }>;
  refusals_by_reason: Array<{ reason: MigrationRefusalReason; count: number }>;
  records_by_kind: Array<{ record_kind: ProjectedRecordKind; count: number }>;
};

export const ProjectionPlanSchemaName = "living-atlas-migration-projection-plan:v1" as const;

/**
 * The plan carries no clock and no minted id. That is what makes it diffable:
 * two runs over the same frozen source produce byte-identical plans, so a review
 * diff shows source drift rather than run-to-run noise. Time and identity are
 * assigned at commit, never at plan.
 */
export type ProjectionPlan = {
  plan_schema: typeof ProjectionPlanSchemaName;
  authority_id: string;
  projector_version: typeof ProjectorVersion;
  /**
   * Counted off the input array before any classification runs, so it is
   * independent of the outcome list. The closure gate needs a denominator the
   * projector cannot influence: if outcomes were their own denominator, a
   * projector that dropped an object on the floor would balance perfectly.
   */
  source_object_count: number;
  outcomes: SourceOutcome[];
  records: ProjectedRecord[];
  breakdown: ProjectionBreakdown;
  plan_digest: `sha256:${string}`;
};

export type BuildProjectionPlanOptions = {
  authority_id: string;
  resolve_payload?: LegacyPayloadResolver;
};

const MaxAliasChainDepth = 16;

function provenanceFor(envelope: GraphObjectEnvelope): LegacyProvenance {
  return {
    legacy_object_id: envelope.object_id,
    legacy_object_type: envelope.object_type,
    legacy_version: envelope.version,
    legacy_content_hash: envelope.content_hash,
    legacy_access_class: envelope.access_class,
    legacy_tombstone: envelope.visible_metadata.tombstone,
    legacy_created_at: envelope.created_at,
    legacy_updated_at: envelope.updated_at
  };
}

type PreparedPrimary = {
  record_key: MigrationIdempotencyKey;
  record_kind: ProjectedRecordKind;
  slot?: EntitySlot;
  entity_type?: EndpointType;
};

type Draft = {
  envelope: GraphObjectEnvelope;
  category: LegacySourceCategory;
  /**
   * Payload content as the resolver produced it. Edges are resolved in a second
   * pass and must read the RESOLVED bytes, not the envelope: a decryptable
   * ciphertext edge is just as projectable as a plaintext one, and reaching back
   * into the envelope would silently refuse every encrypted edge in the corpus.
   */
  data?: Record<string, unknown>;
  disposition?: SourceDisposition;
  records: ProjectedRecord[];
  primary?: PreparedPrimary;
  alias_target?: PlanAliasTarget;
  redirects_to?: string;
};

function refuse(reason: MigrationRefusalReason, detail: string): SourceDisposition {
  return { kind: "refused", reason, detail };
}

function countBy<T extends string>(values: T[], universe: readonly T[]): Array<{ value: T; count: number }> {
  const counts = new Map<T, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return universe
    .filter((candidate) => (counts.get(candidate) ?? 0) > 0)
    .map((candidate) => ({ value: candidate, count: counts.get(candidate) ?? 0 }));
}

/**
 * Projects a frozen legacy graph into new-plane records. Pure: the same source
 * always yields the same plan, and nothing is written anywhere.
 */
export function buildProjectionPlan(
  envelopes: GraphObjectEnvelope[],
  options: BuildProjectionPlanOptions
): ProjectionPlan {
  const authorityId = AuthorityIdSchema.parse(options.authority_id);
  const resolvePayload = options.resolve_payload ?? defaultLegacyPayloadResolver;
  const sourceObjectCount = envelopes.length;

  const drafts: Draft[] = [];
  const draftsById = new Map<string, Draft>();

  for (const envelope of envelopes) {
    const { category, resolution } = classifyLegacySource(envelope, resolvePayload);
    const draft: Draft = { envelope, category, records: [] };

    if (draftsById.has(envelope.object_id)) {
      // Two snapshots concatenated by hand would otherwise mint two entities for
      // one legacy object. Refusing the later copy keeps the identity map single-valued.
      draft.disposition = refuse(
        "duplicate-legacy-object-id",
        "a source object with this legacy id was already accounted for in this plan"
      );
      drafts.push(draft);
      continue;
    }
    draftsById.set(envelope.object_id, draft);
    drafts.push(draft);

    const provenance = provenanceFor(envelope);
    const tombstone = envelope.visible_metadata.tombstone;

    if (resolution.kind === "plaintext") {
      draft.data = resolution.data;
    }

    if (category === "quarantined-object" || category === "tombstoned-opaque" || category === "narrative-object") {
      applyNonProjectableDisposition(draft, authorityId, provenance, { category, resolution });
      continue;
    }

    if (category === "opaque-object") {
      if (resolution.kind === "unrecoverable") {
        draft.disposition = { kind: "unrecoverable-ciphertext" };
        pushAbsenceRecord(draft, authorityId, provenance, "unrecoverable-ciphertext", resolution.detail);
        continue;
      }
      draft.disposition = refuse(
        "ciphertext-not-attempted",
        resolution.kind === "unavailable" ? resolution.detail : "ciphertext was not resolved"
      );
      continue;
    }

    if (category === "other") {
      draft.disposition = refuse(
        "unclassified-source-category",
        `no projection mapping is declared for legacy object_type ${envelope.object_type}`
      );
      continue;
    }

    if (resolution.kind !== "plaintext") {
      draft.disposition = refuse("invalid-legacy-payload", "expected a readable payload for this category");
      continue;
    }

    if (category === "legacy-redirect") {
      const redirect = LegacyRedirectPayloadSchema.safeParse(resolution.data);
      if (!redirect.success) {
        draft.disposition = refuse("invalid-legacy-payload", "legacy redirect payload did not parse");
        continue;
      }
      draft.redirects_to = redirect.data.redirects_to;
      continue;
    }

    if (category === "entity-record" || category === "tombstoned-entity-record") {
      const endpoint = EndpointRecordSchema.safeParse(resolution.data);
      if (!endpoint.success) {
        draft.disposition = refuse("invalid-legacy-payload", "legacy entity payload did not parse as an endpoint record");
        continue;
      }
      const slot = entitySlotForLegacyObject(authorityId, envelope.object_id);
      const entityKey = projectionIdempotencyKey({
        authority_id: authorityId,
        legacy_object_id: envelope.object_id,
        record_kind: "entity",
        ordinal: 0
      });
      const entityRecord: ProjectedEntityRecord = {
        record_kind: "entity",
        idempotency_key: entityKey,
        origin: MigrationOrigin,
        recorded_at_fidelity: MigrationRecordedAtFidelity,
        provenance,
        slot,
        entity_type: endpoint.data.type,
        entity_subtype: endpoint.data.subtype,
        name: endpoint.data.name,
        aliases: [...endpoint.data.aliases],
        ...(endpoint.data.description ? { description: endpoint.data.description } : {})
      };
      draft.records.push(entityRecord);
      draft.primary = { record_key: entityKey, record_kind: "entity", slot, entity_type: endpoint.data.type };
      if (tombstone) {
        draft.records.push({
          record_kind: "retraction",
          idempotency_key: projectionIdempotencyKey({
            authority_id: authorityId,
            legacy_object_id: envelope.object_id,
            record_kind: "retraction",
            ordinal: 1
          }),
          origin: MigrationOrigin,
          recorded_at_fidelity: MigrationRecordedAtFidelity,
          provenance,
          retracts_idempotency_key: entityKey,
          retraction_basis: "legacy-tombstone"
        });
        draft.disposition = { kind: "projected-as-retraction" };
      } else {
        draft.disposition = { kind: "projected-as-entity" };
      }
      continue;
    }

    // Edges are resolved in a second pass, once every entity slot is known.
  }

  // Three phases, in this order: chains must be flattened before edges resolve
  // (an edge that names a redirected id has to land on the object the chain ends
  // at, not be refused), and a redirect can only claim its alias target once the
  // terminal object has produced a record.
  const redirectTargets = resolveRedirectTargets(drafts, draftsById);
  resolveEdges(drafts, draftsById, redirectTargets, authorityId);
  assignRedirectAliasTargets(drafts, draftsById, redirectTargets);
  finalizeAliasTargets(drafts);

  const outcomes: SourceOutcome[] = drafts
    .map((draft) => {
      const disposition = draft.disposition ?? {
        kind: "refused" as const,
        reason: "unclassified-source-category" as const,
        detail: "the projector produced no disposition for this source object"
      };
      const aliasTarget: PlanAliasTarget = draft.alias_target ?? {
        kind: "no-target",
        disposition: disposition.kind,
        ...(disposition.kind === "refused" ? { reason: disposition.reason } : {}),
        detail: "no new-plane record carries this legacy id"
      };
      return {
        legacy_object_id: draft.envelope.object_id,
        legacy_object_type: draft.envelope.object_type,
        category: draft.category,
        disposition,
        record_keys: draft.records.map((record) => record.idempotency_key).sort(),
        alias_target: aliasTarget
      };
    })
    .sort((left, right) => compareOutcomes(left, right));

  const records = drafts
    .flatMap((draft) => draft.records)
    .sort((left, right) => (left.idempotency_key < right.idempotency_key ? -1 : left.idempotency_key > right.idempotency_key ? 1 : 0));

  const breakdown = recomputeProjectionBreakdown(outcomes, records);
  const plan: ProjectionPlanContent = {
    plan_schema: ProjectionPlanSchemaName,
    authority_id: authorityId,
    projector_version: ProjectorVersion,
    source_object_count: sourceObjectCount,
    outcomes,
    records,
    breakdown
  };

  return { ...plan, plan_digest: projectionPlanDigest(plan) };
}

export type ProjectionPlanContent = Omit<ProjectionPlan, "plan_digest">;

export function projectionPlanDigest(plan: ProjectionPlanContent): `sha256:${string}` {
  return canonicalDigest({
    plan_schema: plan.plan_schema,
    authority_id: plan.authority_id,
    projector_version: plan.projector_version,
    source_object_count: plan.source_object_count,
    outcomes: plan.outcomes,
    records: plan.records,
    breakdown: plan.breakdown
  });
}

function compareOutcomes(left: SourceOutcome, right: SourceOutcome): number {
  if (left.legacy_object_id !== right.legacy_object_id) {
    return left.legacy_object_id < right.legacy_object_id ? -1 : 1;
  }
  // Duplicate legacy ids are refused, but they still need a stable print order.
  return left.disposition.kind < right.disposition.kind ? -1 : left.disposition.kind > right.disposition.kind ? 1 : 0;
}

/**
 * An absence record still gets an identity in the new plane, so an old link to a
 * deleted or withheld object resolves to "this existed and did not come across,
 * for this reason" instead of a bare miss.
 */
function pushAbsenceRecord(
  draft: Draft,
  authorityId: string,
  provenance: LegacyProvenance,
  absenceKind: "unrecoverable-ciphertext" | "redaction-stub",
  detail: string
): void {
  const key = projectionIdempotencyKey({
    authority_id: authorityId,
    legacy_object_id: provenance.legacy_object_id,
    record_kind: "absence",
    ordinal: 0
  });
  draft.records.push({
    record_kind: "absence",
    idempotency_key: key,
    origin: MigrationOrigin,
    recorded_at_fidelity: MigrationRecordedAtFidelity,
    provenance,
    absence_kind: absenceKind,
    detail: detail.slice(0, 512)
  });
  draft.primary = { record_key: key, record_kind: "absence" };
}

function applyNonProjectableDisposition(
  draft: Draft,
  authorityId: string,
  provenance: LegacyProvenance,
  classification: Parameters<typeof tombstoneDisposition>[0]
): void {
  const disposition = tombstoneDisposition(classification);

  if (disposition.kind === "projected-as-retraction") {
    // Reachable only if the category table and the tombstone table disagree.
    draft.disposition = refuse(
      "unclassified-source-category",
      "tombstone disposition and source category disagree for this object"
    );
    return;
  }

  if (disposition.kind === "refused") {
    draft.disposition = refuse(disposition.reason, disposition.detail);
    return;
  }

  draft.disposition = { kind: disposition.kind };
  pushAbsenceRecord(draft, authorityId, provenance, disposition.kind, disposition.detail);
}

function resolveEdges(
  drafts: Draft[],
  draftsById: Map<string, Draft>,
  redirectTargets: Map<string, string>,
  authorityId: string
): void {
  for (const draft of drafts) {
    if (draft.disposition || (draft.category !== "typed-edge" && draft.category !== "tombstoned-typed-edge")) {
      continue;
    }

    const envelope = draft.envelope;
    const edge = TemporalEdgeSchema.safeParse(draft.data);
    if (!edge.success) {
      draft.disposition = refuse("invalid-legacy-payload", "legacy edge payload did not parse as a temporal edge");
      continue;
    }

    const endpoints = [
      { role: "source", legacyId: edge.data.source_object_id, declaredType: edge.data.source_type },
      { role: "target", legacyId: edge.data.target_object_id, declaredType: edge.data.target_type }
    ] as const;

    const resolved: Array<{ slot: EntitySlot }> = [];
    let failure: SourceDisposition | undefined;
    for (const endpoint of endpoints) {
      // An edge that names an id the legacy store itself redirected must attach
      // to the object the chain ends at. Refusing it instead would drop a real
      // edge for a bookkeeping reason the old store had already resolved.
      const endpointLegacyId = redirectTargets.get(endpoint.legacyId) ?? endpoint.legacyId;
      const endpointDraft = draftsById.get(endpointLegacyId);
      if (!endpointDraft) {
        failure = refuse(
          "dangling-edge-endpoint",
          `edge ${endpoint.role} endpoint is not present in the source set`
        );
        break;
      }
      const primary = endpointDraft.primary;
      if (!primary?.slot) {
        failure = refuse(
          "endpoint-not-projected",
          `edge ${endpoint.role} endpoint is present in the source but did not project to an entity`
        );
        break;
      }
      if (primary.entity_type !== endpoint.declaredType) {
        // The legacy edge asserted an endpoint type; the endpoint record says
        // otherwise. Guessing which one is right is how the old importer created
        // edges that no traversal could satisfy.
        failure = refuse(
          "endpoint-type-mismatch",
          `edge ${endpoint.role} endpoint type does not match the projected entity type`
        );
        break;
      }
      resolved.push({ slot: primary.slot });
    }

    if (failure) {
      draft.disposition = failure;
      continue;
    }

    const sourceSlot = resolved[0]?.slot;
    const targetSlot = resolved[1]?.slot;
    if (!sourceSlot || !targetSlot) {
      draft.disposition = refuse("dangling-edge-endpoint", "edge endpoints did not both resolve");
      continue;
    }

    const provenance = provenanceFor(envelope);
    const relationshipKey = projectionIdempotencyKey({
      authority_id: authorityId,
      legacy_object_id: envelope.object_id,
      record_kind: "relationship",
      ordinal: 0
    });
    // Legacy `source` is free text that may embed a private file locator, and
    // legacy `confidence` is a bare band with no evidence behind it. Carrying
    // either across would either leak a locator or fabricate an assessment, so
    // neither is projected.
    const relationship: ProjectedRelationshipRecord = {
      record_kind: "relationship",
      idempotency_key: relationshipKey,
      origin: MigrationOrigin,
      recorded_at_fidelity: MigrationRecordedAtFidelity,
      provenance,
      legacy_edge_id: edge.data.edge_id,
      source_slot: sourceSlot,
      source_type: edge.data.source_type,
      target_slot: targetSlot,
      target_type: edge.data.target_type,
      predicate: edge.data.predicate,
      valid_from: edge.data.valid_from,
      ...(edge.data.valid_to ? { valid_to: edge.data.valid_to } : {}),
      valid_from_fidelity: worldTimeFidelity(edge.data.valid_from),
      valid_to_fidelity: worldTimeFidelity(edge.data.valid_to),
      status: edge.data.status,
      attrs: { ...edge.data.attrs }
    };
    draft.records.push(relationship);
    draft.primary = { record_key: relationshipKey, record_kind: "relationship" };

    if (envelope.visible_metadata.tombstone) {
      draft.records.push({
        record_kind: "retraction",
        idempotency_key: projectionIdempotencyKey({
          authority_id: authorityId,
          legacy_object_id: envelope.object_id,
          record_kind: "retraction",
          ordinal: 1
        }),
        origin: MigrationOrigin,
        recorded_at_fidelity: MigrationRecordedAtFidelity,
        provenance,
        retracts_idempotency_key: relationshipKey,
        retraction_basis: "legacy-tombstone"
      });
      draft.disposition = { kind: "projected-as-retraction" };
      continue;
    }

    draft.disposition = { kind: "projected-as-relationship" };
  }
}

/**
 * Flattens every legacy redirect chain to the id it ends at. Leaving the chain
 * intact would force every later lookup of an old id to walk N hops and would
 * let a cycle hang the reader; both were real failure modes of the old id-rewrite
 * scripts. Chains are walked before anything reads them, so a redirected id
 * resolves identically for an alias row and for an edge endpoint.
 */
function resolveRedirectTargets(drafts: Draft[], draftsById: Map<string, Draft>): Map<string, string> {
  const terminals = new Map<string, string>();

  for (const draft of drafts) {
    if (draft.disposition || draft.category !== "legacy-redirect") {
      continue;
    }

    const seen = new Set<string>([draft.envelope.object_id]);
    let cursor = draft.redirects_to;
    let hops = 0;

    while (cursor !== undefined) {
      if (seen.has(cursor)) {
        draft.disposition = refuse("alias-cycle", "legacy redirect chain revisits an id it already passed through");
        break;
      }
      if (hops >= MaxAliasChainDepth) {
        draft.disposition = refuse("alias-cycle", `legacy redirect chain exceeded ${MaxAliasChainDepth} hops`);
        break;
      }
      seen.add(cursor);
      hops += 1;

      const next = draftsById.get(cursor);
      if (!next) {
        draft.disposition = refuse("dangling-alias-target", "legacy redirect points at an id outside the source set");
        break;
      }
      if (next.category !== "legacy-redirect") {
        terminals.set(draft.envelope.object_id, cursor);
        break;
      }
      cursor = next.redirects_to;
      if (cursor === undefined) {
        draft.disposition = refuse("invalid-legacy-payload", "legacy redirect chain reached a redirect with no target");
      }
    }
  }

  return terminals;
}

function assignRedirectAliasTargets(
  drafts: Draft[],
  draftsById: Map<string, Draft>,
  redirectTargets: Map<string, string>
): void {
  for (const draft of drafts) {
    if (draft.disposition || draft.category !== "legacy-redirect") {
      continue;
    }

    const terminalId = redirectTargets.get(draft.envelope.object_id);
    const terminal = terminalId === undefined ? undefined : draftsById.get(terminalId);
    if (!terminal?.primary) {
      draft.disposition = refuse(
        "endpoint-not-projected",
        "legacy redirect resolves to an object that did not project to a new-plane record"
      );
      continue;
    }

    draft.disposition = { kind: "projected-as-alias-redirect" };
    draft.alias_target = {
      kind: "record",
      record_key: terminal.primary.record_key,
      record_kind: terminal.primary.record_kind,
      ...(terminal.primary.slot ? { slot: terminal.primary.slot } : {})
    };
  }
}

/**
 * Every legacy id ends up with an alias row, including the ones that carried
 * nothing across. A lookup of a refused id must answer "not carried across, and
 * here is why" — a bare miss would read as "never existed".
 */
function finalizeAliasTargets(drafts: Draft[]): void {
  for (const draft of drafts) {
    if (draft.alias_target) {
      continue;
    }
    if (draft.primary) {
      draft.alias_target = {
        kind: "record",
        record_key: draft.primary.record_key,
        record_kind: draft.primary.record_kind,
        ...(draft.primary.slot ? { slot: draft.primary.slot } : {})
      };
    }
  }
}

export function recomputeProjectionBreakdown(outcomes: SourceOutcome[], records: ProjectedRecord[]): ProjectionBreakdown {
  const categories = outcomes.map((outcome) => outcome.category);
  const dispositions = outcomes.map((outcome) => outcome.disposition.kind);
  const refusalReasons = outcomes
    .map((outcome) => (outcome.disposition.kind === "refused" ? outcome.disposition.reason : undefined))
    .filter((reason): reason is MigrationRefusalReason => reason !== undefined);
  const refusedCount = refusalReasons.length;

  return {
    source_object_count: outcomes.length,
    projected_count: outcomes.length - refusedCount,
    refused_count: refusedCount,
    by_category: countBy(categories, LegacySourceCategoryUniverse).map(({ value, count }) => ({ category: value, count })),
    by_disposition: countBy(dispositions, SourceDispositionKindValues).map(({ value, count }) => ({
      disposition: value,
      count
    })),
    refusals_by_reason: countBy(refusalReasons, MigrationRefusalReasonUniverse).map(({ value, count }) => ({
      reason: value,
      count
    })),
    records_by_kind: countBy(
      records.map((record) => record.record_kind),
      ProjectedRecordKindUniverse
    ).map(({ value, count }) => ({ record_kind: value, count }))
  };
}

const LegacySourceCategoryUniverse = [
  "entity-record",
  "typed-edge",
  "legacy-redirect",
  "tombstoned-entity-record",
  "tombstoned-typed-edge",
  "tombstoned-opaque",
  "opaque-object",
  "quarantined-object",
  "narrative-object",
  "other"
] as const satisfies readonly LegacySourceCategory[];

const MigrationRefusalReasonUniverse = [
  "ciphertext-not-attempted",
  "no-typed-target-representation",
  "invalid-legacy-payload",
  "dangling-edge-endpoint",
  "endpoint-not-projected",
  "endpoint-type-mismatch",
  "duplicate-legacy-object-id",
  "alias-cycle",
  "dangling-alias-target",
  "unclassified-source-category",
  "other"
] as const satisfies readonly MigrationRefusalReason[];

const ProjectedRecordKindUniverse = [
  "entity",
  "relationship",
  "retraction",
  "absence"
] as const satisfies readonly ProjectedRecordKind[];
