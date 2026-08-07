import { z } from "zod";
import {
  AuthorityIdSchema,
  EndpointRecordSchema,
  TemporalEdgeSchema,
  checkPredicateEndpoints,
  type EndpointType,
  type GraphObjectEnvelope,
  type OccurrenceSubtype,
  type Predicate
} from "@living-atlas/contracts";
import {
  LegacyTemporalEdgeSchema,
  resolveMigratedPredicate,
  type EdgeMigrationRefusalReason
} from "./edge-migration.js";
import {
  TravelEndpointCoverageKinds,
  mapLegacyNode,
  type TravelEndpointCoverage,
  type TravelEndpointCoverageKind,
  type UnplacedAttribute
} from "./node-mapping.js";
import {
  TRAVEL_DESTINATION_ATTRIBUTE,
  TRAVEL_ORIGIN_ATTRIBUTE,
  TRAVEL_ROUTE_ATTRIBUTE,
  normalizeTopicValue
} from "./legacy-vocabulary.js";
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
  LegacyEndpointPayloadSchema,
  endpointAttributes,
  isVenueLocation,
  legacyOccurrenceSubtype,
  legacyOccurredOn,
  legacyProviderName,
  legacyTypeWords,
  type EdgeDerivation,
  type LegacyEndpointPayload
} from "./legacy-endpoint.js";
import {
  DerivedAttributeNamespaces,
  DerivedNodeRegistry,
  HandReviewReasonValues,
  compareHandReviewItems,
  type DerivedNodeHandle,
  type HandReviewItem,
  type HandReviewReason
} from "./derived-nodes.js";
import {
  MigrationOrigin,
  MigrationRecordedAtFidelity,
  ProjectorVersion,
  ProvisionalBlockPayloadSchema,
  UnmodelledRecordKinds,
  canonicalDigest,
  entitySlotForLegacyObject,
  TopicSchemeValues,
  isLegacyObjectProvenance,
  isRelationshipRecord,
  legacyObjectIdOf,
  mintedClassificationIdempotencyKey,
  mintedTopicIdempotencyKey,
  mintedTopicSlot,
  projectionIdempotencyKey,
  worldTimeFidelity,
  type EntitySlot,
  type LegacyProvenance,
  type MigrationIdempotencyKey,
  type ProjectedEntityRecord,
  type ProjectedRecord,
  type ProjectedRecordKind,
  type ProjectedRelationshipRecord,
  type TopicScheme
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
  /**
   * Carried across whole, with its modelling deferred (ADR 0029). Its own
   * disposition rather than one of the `projected-as-*` above: those name what
   * the object BECAME in the ratified vocabulary, and this object became nothing
   * in it. Filing a block as `projected-as-entity` would put a number nobody can
   * act on into the row an operator reads to see how much of the graph arrived.
   */
  "projected-as-provisional",
  "unrecoverable-ciphertext",
  "redaction-stub",
  "refused",
  "other"
] as const;
/**
 * The vocabulary as a parser, not only as a type.
 *
 * The durable alias ledger stores a disposition inside a free-text reason and
 * has to read it back, and anything read back off disk is untrusted until it
 * has been parsed. Derived from the same array as the type so the two cannot
 * name different sets.
 */
export const SourceDispositionKindSchema = z.enum(SourceDispositionKindValues);
export type SourceDispositionKind = (typeof SourceDispositionKindValues)[number];

export type SourceDisposition =
  | { kind: Exclude<SourceDispositionKind, "refused"> }
  | { kind: "refused"; reason: MigrationRefusalReason; detail: string };

export type PlanAliasCandidate = {
  record_key: MigrationIdempotencyKey;
  record_kind: ProjectedRecordKind;
  entity_type: EndpointType;
  slot: EntitySlot;
};

/**
 * `ambiguous-split` is the answer for a legacy id that became more than one node.
 *
 * A venue was one row that meant two things — the place and the business — so
 * every reference to the old id is a reference to one of them and the migration
 * cannot tell which. Nominating a primary would silently attribute every
 * historical mention to whichever node won, which is the failure ADR 0007 names.
 * The split refuses BY NAME and lists the candidates, exactly as the entity
 * registry's own split path does.
 *
 * This is not in tension with edges landing deterministically on one side: an
 * edge carries a declared endpoint TYPE, so it says which of the two it meant. A
 * bare id does not, and inventing a discriminator it never had is the guess.
 */
export type PlanAliasTarget =
  | {
      kind: "record";
      record_key: MigrationIdempotencyKey;
      record_kind: ProjectedRecordKind;
      slot?: EntitySlot;
    }
  | { kind: "ambiguous-split"; candidates: [PlanAliasCandidate, PlanAliasCandidate, ...PlanAliasCandidate[]] }
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
  /**
   * Nodes minted rather than projected, and edges computed from an attribute
   * rather than carried from a legacy edge. Counted separately because they are
   * the part of the plan with no source row behind it: a reviewer comparing the
   * plan against the old store needs to know which records they will not find there.
   */
  entities_minted_from_attributes: number;
  relationships_derived_from_attributes: number;
  /**
   * Records this run carries whose kind nothing has modelled yet (ADR 0029).
   *
   * A row rather than a scalar because the question a reader has is "which
   * kinds", and because a second provisional kind must appear here without
   * anybody widening a field. Recomputed by the closure gate from the records
   * like every other row, so the plan cannot assert a deferral it did not make.
   *
   * The deferral is the whole reason this exists: an unmodelled record type
   * tends to stay unmodelled, and the only thing that reliably stops it is a
   * number an operator sees on every run. `renderProjectionPlanReport` prints
   * the total even when it is zero, because an absent count reads as "not
   * measured" and a zero reads as "nothing deferred".
   */
  unmodelled_records: Array<{ record_kind: ProjectedRecordKind; count: number }>;
  /**
   * How many topic nodes each concept scheme contributes.
   *
   * This replaced a count of topics REUSED from the corpus. That number could
   * only ever be zero once identity became scheme-scoped — nothing resolves
   * across a scheme, so no classification can land on a corpus topic — and a row
   * that structurally prints zero is a row people stop reading.
   *
   * The scheme census is the live equivalent: it is where an operator sees the
   * three vocabularies as three populations rather than as one flat namespace,
   * and a scheme that appears or vanishes between dry runs is visible before any
   * finding fires. Recomputed by the closure gate from the records like every
   * other row, so it is a number the plan cannot assert without having produced it.
   */
  topic_nodes_by_scheme: Array<{ scheme: TopicScheme; count: number }>;
  legacy_ids_split: number;
  hand_review_by_reason: Array<{ reason: HandReviewReason; count: number }>;
  /**
   * How many travel legs arrived with each endpoint shape, INCLUDING the ones
   * that arrived with nothing.
   *
   * The `none` row is the one that matters and it is why this is a breakdown
   * field rather than a count of hand-review rows: a leg with no origin has no
   * attribute to queue, so counting rows would report the largest group as zero.
   * Gate G3 measured the three shapes disjoint and incomplete, and the operator's
   * check on the dry run is that this row still says so — a `none` count that
   * fell to zero would mean somebody started synthesising endpoints.
   *
   * Recomputed by the closure gate from the records and the hand-review queue,
   * like every other row here, so a plan cannot assert a coverage it did not
   * produce.
   */
  travel_endpoint_coverage: Array<{ coverage: TravelEndpointCoverageKind; count: number }>;
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
  /**
   * Records the PLAN owns rather than any one source object.
   *
   * A minted topic node is asked for by every legacy node that carried the same
   * retired value, so no single outcome can claim it -- and the gate's rule that
   * every record is claimed by exactly one outcome would otherwise report the
   * whole controlled vocabulary as unaccounted. Listed here so the claim is
   * still explicit and still checked, just at the level that actually owns it.
   */
  minted_record_keys: MigrationIdempotencyKey[];
  /**
   * Legacy attributes the projector could not place mechanically. Never a
   * refusal — the object still projects — and never silence, which is what an
   * unplaced attribute would otherwise be.
   */
  hand_review: HandReviewItem[];
  breakdown: ProjectionBreakdown;
  plan_digest: `sha256:${string}`;
};

export type BuildProjectionPlanOptions = {
  authority_id: string;
  resolve_payload?: LegacyPayloadResolver;
};

const MaxAliasChainDepth = 16;

/**
 * The scheme a `topic` node projected from the corpus belongs to. Named here
 * rather than written inline so the one place that assigns it is greppable
 * beside the two other producers.
 */
const CorpusTopicScheme = "subject-matter" as const satisfies TopicScheme;

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
  /** The parsed legacy endpoint, kept so the attribute passes need not re-parse. */
  payload?: LegacyEndpointPayload;
  disposition?: SourceDisposition;
  records: ProjectedRecord[];
  primary?: PreparedPrimary;
  /**
   * Every entity this object became, keyed by endpoint type.
   *
   * This is what routes an edge after a venue split: the edge declared which type
   * it meant, so it lands on the node of that type without anybody guessing. For
   * an object that did not split the map holds one entry and behaviour is
   * unchanged.
   */
  entitiesByType: Map<EndpointType, PreparedPrimary>;
  /** Present only for a split, in a stable order, and the basis of the alias row. */
  splitEntities?: PlanAliasCandidate[];
  alias_target?: PlanAliasTarget;
  redirects_to?: string;
  /**
   * Retired subtype values this node carried, normalised. Collected during the
   * entity pass and spent by the minting pass, because the minting pass has to
   * see the WHOLE run before it knows how many nodes share a value.
   */
  classifications?: string[];
  /** Next free ordinal for a relationship keyed to this legacy object. */
  nextRelationshipOrdinal: number;
};

function refuse(reason: MigrationRefusalReason, detail: string): SourceDisposition {
  return { kind: "refused", reason, detail };
}

/**
 * The Logseq importer writes a record WRAPPED: `{kind, source_path_ref, endpoint}`
 * for a node and `{kind, source_path_ref, edge}` for a typed edge, while the
 * connector-written `edge/temporal` records are flat. Parsing the payload
 * directly therefore succeeded for one shape and failed for the other, and every
 * wrapped record was refused as `invalid-legacy-payload` — a real record turned
 * away for being one level deeper than the parser expected.
 *
 * Unwrap when the key is present, otherwise pass the payload through, so both
 * generations parse without the caller needing to know which wrote the record.
 */
function unwrapLegacyRecord(data: unknown, key: "endpoint" | "edge"): unknown {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const inner = (data as Record<string, unknown>)[key];
    if (inner && typeof inner === "object") return inner;
  }
  return data;
}

type ResolvedLegacyEntity = {
  ok: true;
  entity_type: EndpointType;
  entity_subtype?: OccurrenceSubtype;
  name: string;
  aliases: string[];
  description?: string;
  /** Retired subtype values this node is classified by, as `has-type` topics. */
  has_type_topics: string[];
  /**
   * Everything the mapper decided that the ENTITY RECORD has no room for.
   *
   * Carried out of the mapper rather than left behind it, because the record is
   * not the only artifact the plan owes a reviewer. The mapper computed these,
   * the projector dropped them on the floor, and the report the mapper builds
   * for them has no production caller — so `mode` on every travel leg, every
   * `route`, every `origin`, and both `project` nodes the table declined to
   * decide left the migration with no row, no count and no trace. That is the
   * silent drop the mapper's own comment says it exists to prevent.
   */
  unplaced_attributes: UnplacedAttribute[];
  travel_endpoints?: TravelEndpointCoverage;
  hand_review?: string;
};

/**
 * Reads a legacy entity payload, in the ratified vocabulary FIRST.
 *
 * The order matters and is a strict widening, never a relaxation. A payload that
 * already satisfies an endpoint schema is accepted exactly as it was before this
 * lane existed -- same fields, same strictness, no chance for a legacy reading to
 * quietly reinterpret a record the contract already accepts. Only a payload the
 * contract REFUSES reaches the legacy mapper, which is precisely the population
 * the mapper is for: `organization/airline` is refused by the strict schema
 * because organizations no longer carry a subtype, and refusing it outright
 * would strand every classified node in the corpus.
 *
 * The mapper never rescues a payload by loosening a rule the contract enforces
 * on the same shape; it answers a different question -- what does this retired
 * word map onto -- and it refuses by name when it has no answer.
 */
function resolveLegacyEntity(
  payload: unknown
): ResolvedLegacyEntity | { ok: false; reason: MigrationRefusalReason; detail: string } {
  const canonical = EndpointRecordSchema.safeParse(payload);
  if (canonical.success) {
    return {
      ok: true,
      entity_type: canonical.data.type,
      ...(canonical.data.type === "occurrence" ? { entity_subtype: canonical.data.subtype } : {}),
      name: canonical.data.name,
      aliases: [...canonical.data.aliases],
      ...(canonical.data.description ? { description: canonical.data.description } : {}),
      has_type_topics: [],
      unplaced_attributes: []
    };
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, reason: "invalid-legacy-payload", detail: "legacy entity payload is not an object" };
  }

  const mapping = mapLegacyNode(payload as Record<string, unknown>);
  if (mapping.outcome.kind === "refused") {
    return {
      ok: false,
      reason: mapping.outcome.reason === "unmapped-legacy-subtype" ? "unmapped-legacy-subtype" : "invalid-legacy-payload",
      detail: mapping.outcome.detail
    };
  }

  const loose = payload as Record<string, unknown>;
  const name = typeof loose["name"] === "string" ? loose["name"] : undefined;
  if (name === undefined || name.length === 0) {
    return { ok: false, reason: "invalid-legacy-payload", detail: "legacy entity payload carries no name" };
  }
  const aliases = Array.isArray(loose["aliases"])
    ? loose["aliases"].filter((alias): alias is string => typeof alias === "string" && alias.length > 0)
    : [];
  const description = typeof loose["description"] === "string" && loose["description"].length > 0 ? loose["description"] : undefined;

  return {
    ok: true,
    entity_type: mapping.outcome.entity_type,
    ...(mapping.outcome.entity_subtype === undefined ? {} : { entity_subtype: mapping.outcome.entity_subtype }),
    name,
    aliases,
    ...(description === undefined ? {} : { description }),
    has_type_topics: mapping.outcome.has_type_topics,
    unplaced_attributes: mapping.outcome.unplaced_attributes,
    ...(mapping.outcome.travel_endpoints === undefined ? {} : { travel_endpoints: mapping.outcome.travel_endpoints }),
    ...(mapping.outcome.hand_review === undefined ? {} : { hand_review: mapping.outcome.hand_review })
  };
}

/**
 * The travel-leg attributes that carry an endpoint, by the coverage shape that
 * produced them. Keyed off the shape rather than read off the payload so the
 * hand-review rows and `readTravelEndpoints` cannot disagree about which
 * attributes a leg actually held — and so a `partial` leg reports exactly the
 * one end it knows, which is the whole reason `partial` is a separate answer.
 */
function travelEndpointAttributes(coverage: TravelEndpointCoverage): string[] {
  switch (coverage.kind) {
    case "route":
      return [TRAVEL_ROUTE_ATTRIBUTE];
    case "origin-destination":
      return [TRAVEL_ORIGIN_ATTRIBUTE, TRAVEL_DESTINATION_ATTRIBUTE];
    case "partial":
      return [
        ...(coverage.origin === undefined ? [] : [TRAVEL_ORIGIN_ATTRIBUTE]),
        ...(coverage.destination === undefined ? [] : [TRAVEL_DESTINATION_ATTRIBUTE])
      ];
    case "none":
      // A leg with no endpoint data holds no attribute to report. Its absence is
      // counted by `travel_endpoint_coverage`, which is the honest place for it:
      // "we know nothing about where this went" is a fact about the corpus, not
      // an attribute a reviewer can be asked to re-home.
      return [];
  }
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
  const derivedNodes = new DerivedNodeRegistry(authorityId);
  const handReview: HandReviewItem[] = [];

  for (const envelope of envelopes) {
    const { category, resolution } = classifyLegacySource(envelope, resolvePayload);
    const draft: Draft = {
      envelope,
      category,
      records: [],
      entitiesByType: new Map(),
      nextRelationshipOrdinal: 0
    };

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

    if (category === "derived-index") {
      // A lookup table the new plane rebuilds for itself. Refused under its OWN
      // reason rather than the generic one: `unclassified-source-category` means
      // nobody decided what this is and must fail the gate, while this means we
      // decided and the decision is not to carry it. Without this branch the
      // draft left the loop with no disposition at all, took the fall-through
      // default, and reported a deliberate omission as an undecided shape —
      // failing the closure gate on arithmetic for an object nobody had lost.
      draft.disposition = refuse(
        "derived-index-not-migrated",
        "derived lookup tables are rebuilt by the new plane; a stale copy answers confidently and wrongly"
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

    if (category === "outline-block" || category === "tombstoned-outline-block") {
      const blockNamespace = envelope.visible_metadata.schema_namespace;
      if (blockNamespace === undefined) {
        // Unreachable while the classifier reaches this category only through a
        // namespace it recognises. Refused rather than defaulted: a default
        // would put a record into the plan claiming a namespace nothing
        // measured, which is worse than refusing an object nobody can classify.
        draft.disposition = refuse(
          "unmeasured-block-shape",
          "a block reached the carry-over with no schema namespace to have measured it against"
        );
        continue;
      }

      const block = ProvisionalBlockPayloadSchema.safeParse(resolution.data);
      if (!block.success) {
        // Named for what actually happened. `invalid-legacy-payload` would send
        // the operator looking for corrupt bytes; the bytes are fine and this
        // projector's description of them is short by a key.
        draft.disposition = refuse(
          "unmeasured-block-shape",
          "this block's payload does not match the measured block shape; it is refused by name and left " +
            "readable in the frozen replica rather than carried with a key dropped"
        );
        continue;
      }

      const blockKey = projectionIdempotencyKey({
        authority_id: authorityId,
        legacy_object_id: envelope.object_id,
        record_kind: "provisional-block",
        ordinal: 0
      });
      draft.records.push({
        record_kind: "provisional-block",
        idempotency_key: blockKey,
        origin: MigrationOrigin,
        recorded_at_fidelity: MigrationRecordedAtFidelity,
        provenance,
        source_schema_namespace: blockNamespace,
        // The PARSED payload, not the raw map. Parsing is what proves the shape,
        // and re-reading `resolution.data` here would carry whatever arrived
        // whether or not it satisfied the schema the gate later validates.
        block: block.data
      });
      // The legacy id now redirects at a real record, so it resolves to the
      // block instead of answering "nothing carried this across". It claims NO
      // entity slot: a block is not an endpoint, and an edge that names one must
      // still refuse rather than land on a record with no type.
      draft.primary = { record_key: blockKey, record_kind: "provisional-block" };
      // A deleted block is carried AND retracted, exactly like a deleted node.
      // Importing nothing would turn a recorded deletion into an absence of
      // history; `retractTombstonedDrafts` emits the retraction once every pass
      // has run.
      draft.disposition = tombstone ? { kind: "projected-as-retraction" } : { kind: "projected-as-provisional" };
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
      const rawEndpoint = unwrapLegacyRecord(resolution.data, "endpoint");
      const endpoint = LegacyEndpointPayloadSchema.safeParse(rawEndpoint);
      if (!endpoint.success) {
        draft.disposition = refuse("invalid-legacy-payload", "legacy entity payload did not parse as an endpoint record");
        continue;
      }
      const payload = endpoint.data;
      draft.payload = payload;

      /**
       * THE RATIFIED VOCABULARY DECIDES THE TYPE, and it decides before anything
       * else reads one. A travel leg is stored as an `item` and becomes an
       * `occurrence/segment`, so a venue test or an attribute allocation keyed
       * off `payload.type` would be keyed off the word the node is losing rather
       * than the word it ends up carrying.
       *
       * This is also the join the two lanes each left open. Asking
       * `legacyOccurrenceSubtype` alone refused every occurrence whose legacy
       * word is outside the four survivors and deferred the mapping to "the
       * retype lane" -- on the measured corpus that is every travel segment.
       * `resolveLegacyEntity` IS that lane: it applies the closed retype table
       * and hands back the retired words as `has_type_topics`.
       */
      const resolved = resolveLegacyEntity(rawEndpoint);
      if (!resolved.ok) {
        draft.disposition = refuse(resolved.reason, resolved.detail);
        continue;
      }
      const subtype: ProjectedEntityRecord["entity_subtype"] = resolved.entity_subtype;

      // EVERYTHING THE MAPPER DECIDED THAT THE RECORD CANNOT HOLD, into the one
      // queue the plan digests, reports and hands to a reviewer. The attribute
      // NAME travels and the value never does: derived-nodes.ts sets that rule
      // because a plan is written to whatever directory a dry run is read in.
      for (const unplaced of resolved.unplaced_attributes) {
        flagForHandReview(
          handReview,
          draft,
          unplaced.attribute,
          "no-contract-slot",
          "the ratified table keeps this as an attribute and the frozen endpoint revision declares no key for it"
        );
      }
      if (resolved.travel_endpoints) {
        for (const attribute of travelEndpointAttributes(resolved.travel_endpoints)) {
          flagForHandReview(
            handReview,
            draft,
            attribute,
            "no-contract-slot",
            "a travel endpoint the frozen occurrence endpoint revision declares no key for; it is reported, never synthesised"
          );
        }
      }
      if (resolved.hand_review !== undefined) {
        flagForHandReview(handReview, draft, "subtype", "ratified-table-declined", resolved.hand_review);
      }

      // THE VENUE SPLIT. A restaurant row was one node standing for two things,
      // so it becomes two: the place it is and the business that runs it, joined
      // by operated-by. The attributes divide by which node they are a property
      // OF — geography stays with the place, because a business that moves
      // premises is the same business and a different location.
      const split = isVenueLocation(payload);
      const entityTypes: EndpointType[] = split ? ["location", "organization"] : [resolved.entity_type];

      const attributesByType = new Map<EndpointType, Record<string, unknown>>();
      for (const entityType of entityTypes) {
        const allocated = endpointAttributes(payload, entityType);
        attributesByType.set(entityType, allocated.attrs);
        if (allocated.conflict) {
          // An attribute-level problem gets an attribute-level outcome. Refusing
          // the object would be an object-level answer to a question about one
          // field, and it would throw away every other fact the row carried.
          flagForHandReview(
            handReview,
            draft,
            allocated.conflict.attribute,
            "attribute-conflict",
            allocated.conflict.detail
          );
        }
      }

      entityTypes.forEach((entityType, ordinal) => {
        const slot = entitySlotForLegacyObject(authorityId, envelope.object_id, ordinal);
        const entityKey = projectionIdempotencyKey({
          authority_id: authorityId,
          legacy_object_id: envelope.object_id,
          record_kind: "entity",
          ordinal
        });
        const entityRecord: ProjectedEntityRecord = {
          record_kind: "entity",
          idempotency_key: entityKey,
          origin: MigrationOrigin,
          recorded_at_fidelity: MigrationRecordedAtFidelity,
          provenance,
          slot,
          entity_type: entityType,
          ...(entityType === "occurrence" && subtype ? { entity_subtype: subtype } : {}),
          // A `topic` node the corpus itself holds is the owner's own
          // vocabulary — what `about` edges point at — and the migration says
          // only that. Filing it under the kinds vocabulary would claim the
          // owner meant it as a classification, which no legacy field records.
          ...(entityType === "topic" ? { topic_scheme: CorpusTopicScheme } : {}),
          // Name, aliases and description go to BOTH halves of a split. That is
          // not duplication: a venue genuinely has one name that belongs to the
          // place and to the business alike, and it is precisely why a bare id
          // cannot say which was meant.
          name: payload.name,
          aliases: [...payload.aliases],
          ...(payload.description ? { description: payload.description } : {}),
          attrs: attributesByType.get(entityType) ?? {}
        };
        draft.records.push(entityRecord);
        const prepared: PreparedPrimary = {
          record_key: entityKey,
          record_kind: "entity",
          slot,
          entity_type: entityType
        };
        draft.entitiesByType.set(entityType, prepared);
        if (ordinal === 0) {
          draft.primary = prepared;
        }
      });

      // The ratified table's NORMALISED words, collected here and spent by the
      // minting pass once it can see how many nodes shared each one.
      draft.classifications = resolved.has_type_topics;

      if (split) {
        draft.splitEntities = entityTypes.map((entityType) => {
          const prepared = draft.entitiesByType.get(entityType);
          if (!prepared?.slot) {
            throw new Error(`venue split for ${envelope.object_id} produced no ${entityType} entity`);
          }
          return {
            record_key: prepared.record_key,
            record_kind: prepared.record_kind,
            entity_type: entityType,
            slot: prepared.slot
          };
        });
      }

      // The retractions themselves are emitted AFTER every pass has run — see
      // `retractTombstonedDrafts`. Emitting them here covered only the records
      // that existed at this point, which is the entity records and nothing the
      // attribute, job-title and minting passes were about to add.
      draft.disposition = tombstone ? { kind: "projected-as-retraction" } : { kind: "projected-as-entity" };
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
  // Attribute-derived edges come AFTER legacy edges, because the job-title pass
  // has to see every employer a person already had before deciding whether the
  // title has exactly one edge to land on.
  deriveAttributeEdges(drafts, draftsById, redirectTargets, authorityId, derivedNodes, handReview);
  placeJobTitles(drafts, authorityId, derivedNodes, handReview);
  // Topic minting comes last of the record-producing passes: it needs every
  // draft's classifications collected AND its primary slot assigned, and a node
  // whose entity record was refused must contribute no classification.
  const mintedRecords = mintClassificationTopics(drafts, authorityId);
  // LAST of the record-producing passes, so it can see every record the drafts
  // ended up holding rather than only the ones that existed when the entity was
  // drafted.
  retractTombstonedDrafts(drafts, authorityId);
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

  const records = [
    ...drafts.flatMap((draft) => draft.records),
    ...derivedNodes.records(),
    ...mintedRecords
  ].sort((left, right) =>
    left.idempotency_key < right.idempotency_key ? -1 : left.idempotency_key > right.idempotency_key ? 1 : 0
  );

  const sortedHandReview = [...handReview].sort(compareHandReviewItems);
  const breakdown = recomputeProjectionBreakdown(outcomes, records, sortedHandReview);
  const plan: ProjectionPlanContent = {
    plan_schema: ProjectionPlanSchemaName,
    authority_id: authorityId,
    projector_version: ProjectorVersion,
    source_object_count: sourceObjectCount,
    outcomes,
    records,
    minted_record_keys: mintedRecords.map((record) => record.idempotency_key).sort(),
    hand_review: sortedHandReview,
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
    minted_record_keys: plan.minted_record_keys,
    // Covered by the digest like everything else: a plan whose hand-review queue
    // was edited between the dry run and the commit is a different plan, and the
    // queue is exactly the part a reviewer is tempted to "just clear".
    hand_review: plan.hand_review,
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
 * An absence record reports that an object existed and did not come across.
 *
 * IT DELIBERATELY CLAIMS NO ALIAS TARGET. `draft.primary` is what makes a
 * legacy id redirect to a record, and an absence record is not something an id
 * can redirect TO: there is no entity, no assertion, nothing to resolve to. The
 * outcome therefore falls through to `no-target`, carrying the disposition and
 * the reason — which is the answer the durable ledger already models as
 * `content-unrecoverable` and `redacted-in-place`.
 *
 * Setting `primary` here made the id redirect at the record, and the two write
 * paths then competed for one ledger row: the sink wrote the terminal
 * disposition and the alias pass tried to write a redirect to the same legacy
 * id, which the ledger refuses. One writer, one row.
 *
 * The id still resolves — that is the whole point, and it is why this is a
 * `no-target` row rather than no row at all. "This existed and here is why you
 * cannot read it" is a different answer from "no such thing", and on this corpus
 * it is the answer for the large majority of source objects.
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

/**
 * Restates an edge-migration refusal in the projector's vocabulary.
 *
 * The body is the identity function and the SIGNATURE is the entire point: it
 * compiles only while every `EdgeMigrationRefusalReason` is also a
 * `MigrationRefusalReason`. Add a reason to one enum and forget the other and
 * the build fails here, which is the only way two enums describing one set of
 * failures stay in step — the alternative is a `default:` arm that files a new,
 * unnamed refusal under `other` and hides it from the closure gate.
 */
function projectorRefusalFor(reason: EdgeMigrationRefusalReason): MigrationRefusalReason {
  return reason;
}

type ResolvedEdgeEndpoint = { slot: EntitySlot; entity_type: EndpointType };

/**
 * Picks the entity an edge endpoint lands on, AFTER the retype.
 *
 * Two rules, in this order, and the order is what makes them compatible:
 *
 * 1. THE SPLIT ROUTING RULE. The edge's declared endpoint type picks which node
 *    it lands on. A venue became a location and an organization, and an edge
 *    that said `location` said which one it meant — nothing is guessed and
 *    nothing needs "both".
 *
 * 2. THE RETYPE JOIN. A travel leg was stored as an `item` and projects as an
 *    `occurrence`, so an edge that faithfully said `item` finds no `item`
 *    entity. Refusing it is what the projector used to do, and on the measured
 *    corpus that withdrew every travel-participation edge while the retype
 *    shipped — the exact intermediate state gate G1a exists to forbid, reached
 *    by dropping the edges instead of rewriting them. The fallback fires only
 *    when the edge AGREED with the legacy node's own type and the node produced
 *    exactly one entity, so it can never paper over rule 1: an edge that said
 *    `person` about an `item` still mismatches, and a split still routes by
 *    declared type because both halves are present in the map.
 */
function resolveEdgeEndpoint(endpointDraft: Draft, declaredType: EndpointType): ResolvedEdgeEndpoint | undefined {
  const declared = endpointDraft.entitiesByType.get(declaredType);
  if (declared?.slot && declared.entity_type) {
    return { slot: declared.slot, entity_type: declared.entity_type };
  }

  if (endpointDraft.payload?.type !== declaredType || endpointDraft.entitiesByType.size !== 1) {
    return undefined;
  }
  const [only] = [...endpointDraft.entitiesByType.values()];
  return only?.slot && only.entity_type ? { slot: only.slot, entity_type: only.entity_type } : undefined;
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
    // Parsed in the LEGACY vocabulary. Parsing with the ratified schema refused
    // every retired name and every safe alias before the absorption table could
    // see them, and reported all of it as a malformed payload.
    const edge = LegacyTemporalEdgeSchema.safeParse(unwrapLegacyRecord(draft.data, "edge"));
    if (!edge.success) {
      draft.disposition = refuse("invalid-legacy-payload", "legacy edge payload did not parse as a temporal edge");
      continue;
    }

    const endpoints = [
      { role: "source", legacyId: edge.data.source_object_id, declaredType: edge.data.source_type },
      { role: "target", legacyId: edge.data.target_object_id, declaredType: edge.data.target_type }
    ] as const;

    const resolved: ResolvedEdgeEndpoint[] = [];
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
      if (endpointDraft.entitiesByType.size === 0) {
        failure = refuse(
          "endpoint-not-projected",
          `edge ${endpoint.role} endpoint is present in the source but did not project to an entity`
        );
        break;
      }
      const landed = resolveEdgeEndpoint(endpointDraft, endpoint.declaredType);
      if (!landed) {
        failure = refuse(
          "endpoint-type-mismatch",
          `edge ${endpoint.role} endpoint type does not match the projected entity type`
        );
        break;
      }
      resolved.push(landed);
    }

    if (failure) {
      draft.disposition = failure;
      continue;
    }

    const source = resolved[0];
    const target = resolved[1];
    if (!source || !target) {
      draft.disposition = refuse("dangling-edge-endpoint", "edge endpoints did not both resolve");
      continue;
    }

    // THE TYPES ARE THE PROJECTED ONES, never the edge's own copy. The legacy
    // plane stored a copy of the endpoint type on the edge; trusting it here is
    // precisely what would let the retype and the rewrite drift apart, with the
    // node table saying `occurrence` while the edge still said `item`.
    const types = { source: source.entity_type, target: target.entity_type };

    const predicate = resolveMigratedPredicate(edge.data, types);
    if (!predicate.ok) {
      draft.disposition = refuse(projectorRefusalFor(predicate.reason), predicate.detail);
      continue;
    }

    // The domain rule, on the types the entities actually have. Runs for every
    // edge including the ones that kept their name: a legacy `based-in` written
    // location -> organization is wrong in the new vocabulary no matter that its
    // spelling survived.
    const domain = checkPredicateEndpoints(predicate.predicate, types.source, types.target);
    if (!domain.ok) {
      draft.disposition = refuse(
        projectorRefusalFor(domain.violations[0].code),
        domain.violations.map((violation) => violation.message).join("; ")
      );
      continue;
    }

    const validTo = predicate.valid_to ?? edge.data.valid_to;
    const status = predicate.status ?? edge.data.status;
    // Re-parsed as a CONTRACT edge, so a relationship in the plan is valid by
    // construction rather than by inspection. This is what catches the rules the
    // predicate resolution does not speak about — a required attr the successor
    // needs, a spine field smuggled into attrs, a structured attr with the wrong
    // shape — and it catches them with their own named refusal.
    const migrated = TemporalEdgeSchema.safeParse({
      edge_id: edge.data.edge_id,
      source_object_id: edge.data.source_object_id,
      source_type: types.source,
      target_object_id: edge.data.target_object_id,
      target_type: types.target,
      predicate: predicate.predicate,
      valid_from: edge.data.valid_from,
      ...(validTo === undefined ? {} : { valid_to: validTo }),
      status,
      source: edge.data.source,
      attrs: predicate.attrs
    });
    if (!migrated.success) {
      draft.disposition = refuse(
        projectorRefusalFor("invalid-migrated-edge"),
        migrated.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")
      );
      continue;
    }

    const provenance = provenanceFor(envelope);
    const relationshipOrdinal = draft.nextRelationshipOrdinal;
    draft.nextRelationshipOrdinal += 1;
    const relationshipKey = projectionIdempotencyKey({
      authority_id: authorityId,
      legacy_object_id: envelope.object_id,
      record_kind: "relationship",
      ordinal: relationshipOrdinal
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
      legacy_edge_id: migrated.data.edge_id,
      source_slot: source.slot,
      source_type: types.source,
      target_slot: target.slot,
      target_type: types.target,
      predicate: migrated.data.predicate,
      valid_from: migrated.data.valid_from,
      ...(migrated.data.valid_to ? { valid_to: migrated.data.valid_to } : {}),
      valid_from_fidelity: worldTimeFidelity(migrated.data.valid_from),
      valid_to_fidelity: worldTimeFidelity(migrated.data.valid_to),
      status: migrated.data.status,
      attrs: { ...migrated.data.attrs }
    };
    draft.records.push(relationship);
    draft.primary = { record_key: relationshipKey, record_kind: "relationship" };

    draft.disposition = envelope.visible_metadata.tombstone
      ? { kind: "projected-as-retraction" }
      : { kind: "projected-as-relationship" };
  }
}

/**
 * Retracts EVERY record a tombstoned source object produced, and does it after
 * every producing pass has run.
 *
 * The argument was already written down for the second half of a venue split:
 * retracting only the primary would leave the organization live after its source
 * row was deleted. It extends unchanged to the records the later passes add. A
 * tombstoned venue produces an `operated-by` edge, a `contained-in` edge and a
 * `has-type` edge per half, and the old placement — inside the entity branch,
 * before `deriveAttributeEdges`, `placeJobTitles` and `mintClassificationTopics`
 * had run — could not see any of them. Those edges survived into the plane with
 * nothing to retract them, pointing at nodes that were themselves retracted.
 *
 * Minted topic NODES are deliberately not retracted here. A topic is shared by
 * every carrier of the word; deleting it because one carrier was deleted would
 * take the concept away from all the others. The `has-type` edge is what belongs
 * to this object, and that is what goes.
 *
 * Ordinals are assigned by position in the draft's own record list, so an object
 * that produces one entity still retracts at ordinal 1 and a split still uses 1
 * and 2 — the keys an earlier run committed do not move.
 */
function retractTombstonedDrafts(drafts: Draft[], authorityId: string): void {
  for (const draft of drafts) {
    if (!draft.envelope.visible_metadata.tombstone || draft.disposition?.kind !== "projected-as-retraction") {
      continue;
    }
    const provenance = provenanceFor(draft.envelope);
    const retractable = draft.records.filter(
      (record) => record.record_kind !== "retraction" && record.record_kind !== "absence"
    );
    retractable.forEach((record, index) => {
      draft.records.push({
        record_kind: "retraction",
        idempotency_key: projectionIdempotencyKey({
          authority_id: authorityId,
          legacy_object_id: draft.envelope.object_id,
          record_kind: "retraction",
          ordinal: index + 1
        }),
        origin: MigrationOrigin,
        recorded_at_fidelity: MigrationRecordedAtFidelity,
        provenance,
        retracts_idempotency_key: record.idempotency_key,
        retraction_basis: "legacy-tombstone"
      });
    });
  }
}

/**
 * THE PLAN'S TOPIC NAMESPACE: one slot per (SCHEME, canonical word), and the
 * only place a classification topic slot is issued.
 *
 * This is a CONSTRAINT rather than a check, and the difference is the point. A
 * "does a node for this word already exist?" test at the mint site has to be
 * remembered by whoever writes the next mint site, and the last one that was not
 * remembered put two nodes for one concept into a real plan. A Map cannot hold
 * two entries for one key, so the second request for a key returns the first
 * request's slot and there is no branch to forget.
 *
 * THE KEY CARRIES THE SCHEME, and that is what makes both answers possible at
 * once. Within `entity-kind`, nine organizations that each said `airline`
 * resolve to one node — nine nodes would leave nine unrelated concepts sharing a
 * spelling, and "which of these are airlines" would answer with a ninth of the
 * truth. Across schemes, an occupation and an entity kind spelled the same
 * resolve to two nodes, because a person who IS an investor and a firm that IS
 * an investment firm are two concepts, and one node would force one word onto
 * both. Keying on the word alone can only give one of those answers.
 *
 * Nothing resolves ACROSS a scheme, including onto a topic the corpus already
 * holds. That is deliberate and it is the same rule: the corpus's own topic is a
 * `subject-matter` concept, and landing a `has-type` classification on it would
 * assert that the owner's subject and this retired subtype word are one thing —
 * an identity decision on a string match, made by a migration. The closure gate
 * reports the pair as a cross-scheme homonym instead, which is a curator's
 * decision with a record behind it.
 */
class PlanTopicVocabulary {
  private readonly slotsByKey = new Map<string, EntitySlot>();

  constructor(private readonly authorityId: string) {}

  /**
   * The slot a value resolves to within its scheme, minting one only when the
   * key is unclaimed. `minted` says whether the caller owes the plan a
   * `minted-entity` record — the caller cannot get that wrong in the duplicating
   * direction, because a claimed key never reports `minted` twice.
   */
  resolve(scheme: TopicScheme, value: string): { slot: EntitySlot; minted: boolean } {
    // Scheme and word joined by a newline, which neither can contain: the
    // canonical key collapses whitespace runs to single spaces, and the scheme
    // is a closed enum of kebab-case words. A separator either half could hold
    // would let `(a, b-c)` and `(a-b, c)` become one map key.
    const word = normalizeTopicValue(value);
    const key = `${scheme}\n${word}`;
    const existing = this.slotsByKey.get(key);
    if (existing !== undefined) {
      return { slot: existing, minted: false };
    }
    const slot = mintedTopicSlot(this.authorityId, scheme, word);
    this.slotsByKey.set(key, slot);
    return { slot, minted: true };
  }
}

/**
 * The scheme a minted classification topic belongs to. `has-type` says what the
 * subject IS, so the vocabulary its targets form is the kinds of thing — not the
 * subjects the corpus writes about, and not the occupations people hold.
 */
const ClassificationTopicScheme = "entity-kind" as const satisfies TopicScheme;

/**
 * Resolves the retired subtype values the entity pass collected to ONE topic
 * node each WITHIN THE ENTITY-KIND SCHEME, plus a `has-type` edge from every
 * node that carried the value.
 *
 * Resolving once per VALUE rather than once per carrier is what makes the topic
 * set a controlled vocabulary rather than a bag of spellings, and the slot is
 * derived from the value, so a second run resolves to the same node instead of
 * minting another.
 *
 * REUSE CHANGES WHICH NODE THE EDGE POINTS AT, NEVER WHETHER THERE IS ONE. Every
 * carrier still gets its classification edge, with the same idempotency key it
 * had before — that key names the carrier and the value, not the target.
 *
 * Runs AFTER edge resolution so the `has-type` edges cannot be mistaken for
 * legacy edges by anything that walks the drafts, and so a node whose entity
 * record was refused contributes no classification.
 */
function mintClassificationTopics(drafts: Draft[], authorityId: string): ProjectedRecord[] {
  const vocabulary = new PlanTopicVocabulary(authorityId);

  const carriers = new Map<string, Draft[]>();

  for (const draft of drafts) {
    if (!draft.classifications || draft.classifications.length === 0 || draft.entitiesByType.size === 0) {
      continue;
    }
    for (const topic of draft.classifications) {
      const bucket = carriers.get(topic) ?? [];
      bucket.push(draft);
      carriers.set(topic, bucket);
    }
  }

  const minted: ProjectedRecord[] = [];

  for (const topic of [...carriers.keys()].sort()) {
    const bucket = carriers.get(topic) ?? [];
    const { slot, minted: needsRecord } = vocabulary.resolve(ClassificationTopicScheme, topic);
    const basis = { kind: "retired-subtype-value" as const, legacy_value: topic };

    if (needsRecord) {
      minted.push({
        record_kind: "minted-entity",
        idempotency_key: mintedTopicIdempotencyKey(authorityId, ClassificationTopicScheme, topic),
        origin: MigrationOrigin,
        recorded_at_fidelity: MigrationRecordedAtFidelity,
        minted_basis: basis,
        slot,
        entity_type: "topic",
        topic_scheme: ClassificationTopicScheme,
        // The legacy word verbatim. A prettier label would be a curator's choice,
        // and a migration that renames the vocabulary it carries makes the old
        // corpus unsearchable by the words it was written with.
        name: topic,
        classified_node_count: bucket.length
      });
    }

    for (const draft of bucket) {
      // EVERY entity the draft produced, not just the primary. A split venue is
      // a location and an organization, and the word classifies both: the place
      // is a restaurant and so is the business that runs it.
      for (const [sourceType, entity] of draft.entitiesByType) {
      const sourceSlot = entity.slot;
      if (sourceSlot === undefined) {
        continue;
      }
      const key = mintedClassificationIdempotencyKey(authorityId, draft.envelope.object_id, sourceSlot, topic);
      draft.records.push({
        record_kind: "minted-relationship",
        idempotency_key: key,
        origin: MigrationOrigin,
        recorded_at_fidelity: MigrationRecordedAtFidelity,
        minted_basis: basis,
        provenance: provenanceFor(draft.envelope),
        source_slot: sourceSlot,
        source_type: sourceType,
        target_slot: slot,
        target_type: "topic",
        predicate: "has-type",
        // A subtype string carried no time. Stamping today's date would assert
        // that the organization became an airline when we ran the migration.
        valid_from: "unknown",
        valid_from_fidelity: "unknown",
        status: "active"
      });
      }
    }
  }

  return minted;
}

/**
 * World time for an edge computed from an attribute.
 *
 * Always unknown, and deliberately so. The attribute it came from carried no
 * validity — a `subtype` string never said when the classification started being
 * true — and inventing one from a neighbouring field would manufacture a fact
 * that reads exactly like a recorded one. Closing that gap honestly is what
 * attribute valid time (D4) is for, and it is sequenced separately; synthesising
 * a date here would prejudge it and leave 300 fabricated intervals to unpick.
 */
const DerivedEdgeValidFrom = "unknown";

function pushDerivedRelationship(
  draft: Draft,
  authorityId: string,
  input: {
    predicate: Predicate;
    derivation: EdgeDerivation;
    source_slot: EntitySlot;
    source_type: EndpointType;
    target_slot: EntitySlot;
    target_type: EndpointType;
    attrs?: Record<string, unknown>;
  }
): ProjectedRelationshipRecord | undefined {
  // The contract's own domain rule decides whether this edge may exist. A
  // derivation is code the author wrote by hand against a table of predicates, so
  // it is exactly the place a wrong-direction edge gets introduced; checking here
  // means the projector cannot emit an edge the plane's validator would refuse.
  if (!checkPredicateEndpoints(input.predicate, input.source_type, input.target_type).ok) {
    return undefined;
  }

  const ordinal = draft.nextRelationshipOrdinal;
  draft.nextRelationshipOrdinal += 1;
  const record: ProjectedRelationshipRecord = {
    record_kind: "relationship",
    idempotency_key: projectionIdempotencyKey({
      authority_id: authorityId,
      legacy_object_id: draft.envelope.object_id,
      record_kind: "relationship",
      ordinal
    }),
    origin: MigrationOrigin,
    recorded_at_fidelity: MigrationRecordedAtFidelity,
    provenance: provenanceFor(draft.envelope),
    derivation: input.derivation,
    source_slot: input.source_slot,
    source_type: input.source_type,
    target_slot: input.target_slot,
    target_type: input.target_type,
    predicate: input.predicate,
    valid_from: DerivedEdgeValidFrom,
    valid_from_fidelity: worldTimeFidelity(DerivedEdgeValidFrom),
    valid_to_fidelity: worldTimeFidelity(undefined),
    status: "active",
    attrs: input.attrs ?? {}
  };
  draft.records.push(record);
  return record;
}

function flagForHandReview(
  handReview: HandReviewItem[],
  draft: Draft,
  attribute: string,
  reason: HandReviewReason,
  detail: string
): void {
  handReview.push({ legacy_object_id: draft.envelope.object_id, attribute, reason, detail });
}

/**
 * Resolves an attribute that names another legacy object, following the same
 * redirect chain an edge endpoint would. An attribute reference is a reference;
 * it has no business resolving differently from the edge beside it.
 */
function entityByRef(
  draftsById: Map<string, Draft>,
  redirectTargets: Map<string, string>,
  ref: string,
  wanted: readonly EndpointType[]
): PreparedPrimary | undefined {
  const target = draftsById.get(redirectTargets.get(ref) ?? ref);
  if (!target) {
    return undefined;
  }
  for (const type of wanted) {
    const candidate = target.entitiesByType.get(type);
    if (candidate?.slot) {
      return candidate;
    }
  }
  return undefined;
}

const AgentTypes = ["person", "organization"] as const satisfies readonly EndpointType[];

/**
 * Turns the deduplicated legacy attributes into edges.
 *
 * Every case here is one fact that used to live in a column: a classification, a
 * parent place, a provider, a participant list. They became edges because an
 * attribute cannot be bitemporal, cannot be identity-checked, and cannot hold
 * more than one value — and each of those limits produced a measured defect.
 */
function deriveAttributeEdges(
  drafts: Draft[],
  draftsById: Map<string, Draft>,
  redirectTargets: Map<string, string>,
  authorityId: string,
  derivedNodes: DerivedNodeRegistry,
  handReview: HandReviewItem[]
): void {
  const counterpartyNode = (value: string): DerivedNodeHandle =>
    derivedNodes.register({
      origin: "legacy-counterparty-name",
      attribute: DerivedAttributeNamespaces.counterparty,
      value,
      entity_type: "organization"
    });

  for (const draft of drafts) {
    const payload = draft.payload;
    if (!payload || draft.entitiesByType.size === 0) {
      continue;
    }

    // CLASSIFICATION IS NOT DONE HERE. It was, from the raw `subtype` string —
    // but the ratified retype table classifies the same words, normalised and
    // with `absorbed`/`vacuous` honoured, and two classifiers reading one
    // attribute mint two topic nodes for one concept. That is the exact failure
    // a controlled vocabulary exists to prevent, and it would not have shown up
    // in either lane's own fixture. `mintClassificationTopics` owns the subtype
    // namespace; this function keeps the counterparty and job-title namespaces.

    // THE VENUE JOIN. operated-by launches with zero existing warrant by design:
    // gate G6 found no venue with a matching organization, so there was no edge
    // to migrate — this migration creates both the other end and the link.
    const venueLocation = draft.entitiesByType.get("location");
    const venueOrganization = draft.entitiesByType.get("organization");
    if (draft.splitEntities && venueLocation?.slot && venueOrganization?.slot) {
      pushDerivedRelationship(draft, authorityId, {
        predicate: "operated-by",
        derivation: "venue-split",
        source_slot: venueLocation.slot,
        source_type: "location",
        target_slot: venueOrganization.slot,
        target_type: "organization"
      });
    }

    // parent_location_ref becomes contained-in, the rung-by-rung ladder an
    // attribute could only ever hold one step of.
    if (payload.parent_location_ref !== undefined && venueLocation?.slot) {
      const parent = entityByRef(draftsById, redirectTargets, payload.parent_location_ref, ["location"]);
      if (parent?.slot) {
        pushDerivedRelationship(draft, authorityId, {
          predicate: "contained-in",
          derivation: "parent-location-ref",
          source_slot: venueLocation.slot,
          source_type: "location",
          target_slot: parent.slot,
          target_type: "location"
        });
      } else {
        flagForHandReview(
          handReview,
          draft,
          "parent_location_ref",
          "unresolvable-attribute-reference",
          "parent_location_ref names an id that did not project to a location"
        );
      }
    }

    // provider and airline are one attribute (G8), and it becomes offered-by.
    const provider = legacyProviderName(payload);
    if (!provider.ok) {
      flagForHandReview(handReview, draft, provider.conflict.attribute, "attribute-conflict", provider.conflict.detail);
    } else if (provider.provider !== undefined) {
      const subject = draft.entitiesByType.get("offering") ?? draft.entitiesByType.get("occurrence");
      if (subject?.slot && subject.entity_type) {
        const organization = counterpartyNode(provider.provider);
        pushDerivedRelationship(draft, authorityId, {
          predicate: "offered-by",
          derivation: "provider-attr",
          source_slot: subject.slot,
          source_type: subject.entity_type,
          target_slot: organization.slot,
          target_type: "organization"
        });
      } else {
        flagForHandReview(
          handReview,
          draft,
          "provider",
          "unplaced-attribute",
          "provider is only an offered-by edge from an offering or an occurrence"
        );
      }
    }

    // merchant is the counterparty of a sale, which is sold-by.
    if (payload.merchant !== undefined) {
      const subject =
        draft.entitiesByType.get("item") ??
        draft.entitiesByType.get("offering") ??
        draft.entitiesByType.get("occurrence");
      if (subject?.slot && subject.entity_type) {
        const organization = counterpartyNode(payload.merchant);
        pushDerivedRelationship(draft, authorityId, {
          predicate: "sold-by",
          derivation: "merchant-attr",
          source_slot: subject.slot,
          source_type: subject.entity_type,
          target_slot: organization.slot,
          target_type: "organization"
        });
      } else {
        flagForHandReview(
          handReview,
          draft,
          "merchant",
          "unplaced-attribute",
          "merchant is only a sold-by edge from an item, offering or occurrence"
        );
      }
    }

    // participant_refs and organizer_refs are one relation. An organizer is a
    // participant with a job, so the distinction moves onto attrs.role rather
    // than staying a second list nobody joined against.
    const occurrence = draft.entitiesByType.get("occurrence");
    if (occurrence?.slot) {
      const participantRoles: Array<{ refs: string[]; derivation: EdgeDerivation; attrs?: Record<string, unknown> }> = [
        { refs: payload.participant_refs, derivation: "participant-refs" },
        { refs: payload.organizer_refs, derivation: "organizer-refs", attrs: { role: "organizer" } }
      ];
      for (const { refs, derivation, attrs } of participantRoles) {
        for (const ref of refs) {
          const agent = entityByRef(draftsById, redirectTargets, ref, AgentTypes);
          if (!agent?.slot || !agent.entity_type) {
            flagForHandReview(
              handReview,
              draft,
              derivation === "organizer-refs" ? "organizer_refs" : "participant_refs",
              "unresolvable-attribute-reference",
              "a referenced participant did not project to a person or organization"
            );
            continue;
          }
          pushDerivedRelationship(draft, authorityId, {
            predicate: "participant-in",
            derivation,
            source_slot: agent.slot,
            source_type: agent.entity_type,
            target_slot: occurrence.slot,
            target_type: "occurrence",
            ...(attrs ? { attrs } : {})
          });
        }
      }
    }
  }

  backfillEmploymentFromCompanyCurrent(drafts, authorityId, handReview, counterpartyNode);
}

function employedByEdgesFor(drafts: Draft[], slot: EntitySlot): ProjectedRelationshipRecord[] {
  return drafts
    .flatMap((draft) => draft.records)
    .filter(isRelationshipRecord)
    .filter((record) => record.predicate === "employed-by" && record.source_slot === slot);
}

/**
 * `company_current` is deleted by construction — the target person schema
 * has no such field — so the only question is whether the fact it carried
 * survives the deletion. Backfilling FIRST is what makes the deletion lossless
 * rather than merely defensible.
 *
 * The organization is MINTED from the name and deliberately not matched against a
 * same-named legacy organization. Matching would be an identity decision taken on
 * a string, which is the "id = hash(title)" shortcut that merged two different
 * people in the old store. A curator can merge the two later through the alias
 * ledger, where the decision carries evidence and a record.
 */
function backfillEmploymentFromCompanyCurrent(
  drafts: Draft[],
  authorityId: string,
  handReview: HandReviewItem[],
  counterpartyNode: (value: string) => DerivedNodeHandle
): void {
  for (const draft of drafts) {
    const payload = draft.payload;
    const person = draft.entitiesByType.get("person");
    if (!payload?.company_current || !person?.slot) {
      continue;
    }
    if (employedByEdgesFor(drafts, person.slot).length > 0) {
      // The person already has an employer edge, and nothing here can tell
      // whether the string names that same organization. Asserting a second
      // employment would invent a job; dropping it silently would lose a fact.
      flagForHandReview(
        handReview,
        draft,
        "company_current",
        "unplaced-attribute",
        "company_current sits alongside an explicit employed-by edge and may or may not name the same organization"
      );
      continue;
    }
    const organization = counterpartyNode(payload.company_current);
    pushDerivedRelationship(draft, authorityId, {
      predicate: "employed-by",
      derivation: "company-current-attr",
      source_slot: person.slot,
      source_type: "person",
      target_slot: organization.slot,
      target_type: "organization"
    });
  }
}

/**
 * `job_title` is a fact about a RELATIONSHIP that was stored on a node. A
 * title with no employer is not a fact about anybody, which is why it moves onto
 * the employed-by edge as `attrs.role`.
 *
 * Three populations, three different answers, and the middle one is the reason
 * this cannot be a one-liner: with exactly one employer the title has an
 * unambiguous edge to land on; with none there is no edge at all and the title is
 * an occupation, which is a classification and therefore a has-type topic; with
 * more than one, choosing an edge would attach a real job to a possibly wrong
 * employer, so it goes to a human instead.
 */
function placeJobTitles(
  drafts: Draft[],
  authorityId: string,
  derivedNodes: DerivedNodeRegistry,
  handReview: HandReviewItem[]
): void {
  for (const draft of drafts) {
    const payload = draft.payload;
    const person = draft.entitiesByType.get("person");
    if (!payload?.job_title || !person?.slot) {
      continue;
    }

    const employments = employedByEdgesFor(drafts, person.slot);
    if (employments.length > 1) {
      flagForHandReview(
        handReview,
        draft,
        "job_title",
        "ambiguous-employer",
        `job_title cannot be placed on one of ${employments.length} employed-by edges without choosing an employer`
      );
      continue;
    }

    const employment = employments[0];
    if (employment) {
      if (employment.attrs.role === undefined) {
        employment.attrs = { ...employment.attrs, role: payload.job_title };
      } else if (employment.attrs.role !== payload.job_title) {
        // The edge already states a role and the person states another. Both are
        // real; overwriting either would decide which without grounds.
        flagForHandReview(
          handReview,
          draft,
          "job_title",
          "attribute-conflict",
          "job_title disagrees with the role the employed-by edge already carries"
        );
      }
      continue;
    }

    const occupation = derivedNodes.register({
      origin: "legacy-occupation-name",
      attribute: DerivedAttributeNamespaces.jobTitle,
      value: payload.job_title,
      entity_type: "topic"
    });
    pushDerivedRelationship(draft, authorityId, {
      predicate: "has-type",
      derivation: "job-title-attr",
      source_slot: person.slot,
      source_type: "person",
      target_slot: occupation.slot,
      target_type: "topic"
    });
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
    // A redirect that lands on a split inherits the ambiguity. Resolving the old
    // id to the split's first half would answer a question the terminal object
    // itself refuses to answer, and the caller would never learn the id had two
    // meanings.
    draft.alias_target = aliasTargetFor(terminal);
  }
}

function aliasTargetFor(draft: Draft): PlanAliasTarget | undefined {
  if (draft.splitEntities) {
    const [first, second, ...rest] = draft.splitEntities;
    if (first && second) {
      return { kind: "ambiguous-split", candidates: [first, second, ...rest] };
    }
  }
  if (draft.primary) {
    return {
      kind: "record",
      record_key: draft.primary.record_key,
      record_kind: draft.primary.record_kind,
      ...(draft.primary.slot ? { slot: draft.primary.slot } : {})
    };
  }
  return undefined;
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
    const target = aliasTargetFor(draft);
    if (target) {
      draft.alias_target = target;
    }
  }
}

export function recomputeProjectionBreakdown(
  outcomes: SourceOutcome[],
  records: ProjectedRecord[],
  handReview: HandReviewItem[] = []
): ProjectionBreakdown {
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
    ).map(({ value, count }) => ({ record_kind: value, count })),
    entities_minted_from_attributes: records.filter(
      (record) => record.record_kind === "entity" && !isLegacyObjectProvenance(record.provenance)
    ).length,
    relationships_derived_from_attributes: records.filter(
      (record) => record.record_kind === "relationship" && record.derivation !== undefined
    ).length,
    // Counted off `UnmodelledRecordKinds` rather than off a literal list of
    // kinds, so the row cannot fall behind the set that declares what is
    // deferred. The universe keeps the print order stable.
    unmodelled_records: countBy(
      records.map((record) => record.record_kind).filter((kind) => UnmodelledRecordKinds.has(kind)),
      ProjectedRecordKindUniverse
    ).map(({ value, count }) => ({ record_kind: value, count })),
    topic_nodes_by_scheme: countBy(topicSchemesOf(records), TopicSchemeValues).map(({ value, count }) => ({
      scheme: value,
      count
    })),
    legacy_ids_split: outcomes.filter((outcome) => outcome.alias_target.kind === "ambiguous-split").length,
    hand_review_by_reason: countBy(
      handReview.map((item) => item.reason),
      HandReviewReasonValues
    ).map(({ value, count }) => ({ reason: value, count })),
    travel_endpoint_coverage: countBy(travelEndpointCoverages(records, handReview), TravelEndpointCoverageKinds).map(
      ({ value, count }) => ({ coverage: value, count })
    )
  };
}

/**
 * The scheme of every topic node in the plan, one entry per node.
 *
 * Read off the records rather than recomputed from the mechanism that made
 * them: the scheme is what the plane will carry, so a census that derived it
 * independently could agree with the mechanism while disagreeing with the field
 * an apply actually commits.
 */
function topicSchemesOf(records: ProjectedRecord[]): TopicScheme[] {
  const schemes: TopicScheme[] = [];
  for (const record of records) {
    if (record.record_kind !== "entity" && record.record_kind !== "minted-entity") {
      continue;
    }
    if (record.entity_type !== "topic" || record.topic_scheme === undefined) {
      continue;
    }
    schemes.push(record.topic_scheme);
  }
  return schemes;
}

/**
 * Reconstructs each segment's endpoint coverage from the plan alone.
 *
 * Deliberately derived rather than carried: the closure gate recomputes the
 * whole breakdown and compares it against the plan's own copy, and a field it
 * could not recompute would be a number the plan asserts and nothing checks.
 * The reconstruction is exact because `travelEndpointAttributes` queues one row
 * per endpoint attribute the leg actually held, so the row set IS the shape.
 */
function travelEndpointCoverages(
  records: ProjectedRecord[],
  handReview: HandReviewItem[]
): TravelEndpointCoverageKind[] {
  const endpointAttributesById = new Map<string, Set<string>>();
  for (const item of handReview) {
    if (item.reason !== "no-contract-slot" || !TravelEndpointAttributes.has(item.attribute)) {
      continue;
    }
    const bucket = endpointAttributesById.get(item.legacy_object_id) ?? new Set<string>();
    bucket.add(item.attribute);
    endpointAttributesById.set(item.legacy_object_id, bucket);
  }

  const coverages: TravelEndpointCoverageKind[] = [];
  for (const record of records) {
    if (record.record_kind !== "entity" || record.entity_subtype !== "segment") {
      continue;
    }
    const legacyObjectId = legacyObjectIdOf(record);
    if (legacyObjectId === undefined) {
      continue;
    }
    const held = endpointAttributesById.get(legacyObjectId) ?? new Set<string>();
    if (held.has(TRAVEL_ROUTE_ATTRIBUTE)) {
      coverages.push("route");
      continue;
    }
    const origin = held.has(TRAVEL_ORIGIN_ATTRIBUTE);
    const destination = held.has(TRAVEL_DESTINATION_ATTRIBUTE);
    coverages.push(origin && destination ? "origin-destination" : origin || destination ? "partial" : "none");
  }
  return coverages;
}

const TravelEndpointAttributes = new Set<string>([
  TRAVEL_ROUTE_ATTRIBUTE,
  TRAVEL_ORIGIN_ATTRIBUTE,
  TRAVEL_DESTINATION_ATTRIBUTE
]);

/**
 * These two lists exist to give the breakdown a stable print order, and the
 * `satisfies` is what keeps them honest: a value here that the source vocabulary
 * does not declare fails to compile.
 *
 * The check runs one way only, and that is what let `derived-index` go missing.
 * `classifyLegacySource` returns it for a reference-index namespace and
 * `LegacySourceCategoryValues` declares it, but omitting it HERE compiles fine —
 * so `countBy` silently dropped every such object out of `by_category`, the
 * projector had no branch for it, and the fall-through default refused it as an
 * undecided shape. One real index object would have failed the closure gate on
 * arithmetic while nothing had actually been lost. `everyLegacySourceCategory`
 * closes the other direction; an `index` object with no namespace still lands in
 * `other` and still fails the gate, which is what the seeded control asserts.
 */
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
  "outline-block",
  "tombstoned-outline-block",
  "derived-index",
  "other"
] as const satisfies readonly LegacySourceCategory[];

/**
 * The reverse containment, as a compile-time obligation with no runtime cost.
 * `satisfies` proves the list holds nothing extra; this proves it is missing
 * nothing. A category the source vocabulary declares and this file forgets is a
 * category that vanishes from every count the operator reads.
 */
type AssertNothingLeftOver<T extends never> = T;
type EveryLegacySourceCategoryIsPrinted = AssertNothingLeftOver<
  Exclude<LegacySourceCategory, (typeof LegacySourceCategoryUniverse)[number]>
>;
type EveryRefusalReasonIsPrinted = AssertNothingLeftOver<
  Exclude<MigrationRefusalReason, (typeof MigrationRefusalReasonUniverse)[number]>
>;
type EveryRecordKindIsPrinted = AssertNothingLeftOver<
  Exclude<ProjectedRecordKind, (typeof ProjectedRecordKindUniverse)[number]>
>;
export type ProjectionUniverseCoverage = [
  EveryLegacySourceCategoryIsPrinted,
  EveryRefusalReasonIsPrinted,
  EveryRecordKindIsPrinted
];

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
  "derived-index-not-migrated",
  "unmeasured-block-shape",
  "unmapped-legacy-subtype",
  "predicate-domain-violation",
  "predicate-range-violation",
  "retired-predicate-without-absorption",
  "direction-unsafe-alias",
  "unknown-predicate",
  "absorption-requires-valid-to",
  "absorption-endpoints-unavailable",
  "absorption-attr-conflict",
  "invalid-migrated-edge",
  "other"
] as const satisfies readonly MigrationRefusalReason[];

const ProjectedRecordKindUniverse = [
  "entity",
  "relationship",
  "retraction",
  "absence",
  "minted-entity",
  "minted-relationship",
  "provisional-block"
] as const satisfies readonly ProjectedRecordKind[];
