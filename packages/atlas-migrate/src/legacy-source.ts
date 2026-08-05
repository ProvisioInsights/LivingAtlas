import { z } from "zod";
import type { GraphObjectEnvelope } from "@living-atlas/contracts";

/**
 * The projector is key-blind by construction. It never opens ciphertext itself;
 * a keyholding caller supplies a resolver. That keeps the migration tooling
 * usable in a context that holds no keys, and it makes "we could not read this"
 * an explicit, reported outcome instead of an empty record.
 */
export type LegacyPayloadResolution =
  | { kind: "plaintext"; data: Record<string, unknown> }
  | { kind: "unrecoverable"; detail: string }
  | { kind: "unavailable"; detail: string };

export type LegacyPayloadResolver = (envelope: GraphObjectEnvelope) => LegacyPayloadResolution;

/**
 * Without a resolver every ciphertext object is "unavailable", never
 * "unrecoverable". The distinction matters: reporting content as permanently
 * lost when we simply never tried to open it would be a false statement about
 * absence, and absence is something this system reports, never performs.
 */
export const defaultLegacyPayloadResolver: LegacyPayloadResolver = (envelope) => {
  if (envelope.payload.kind === "plaintext-json") {
    return { kind: "plaintext", data: envelope.payload.data };
  }
  return {
    kind: "unavailable",
    detail: "no payload resolver configured; ciphertext was not attempted"
  };
};

/**
 * Closed set of legacy shapes this projector knows how to reason about. Like
 * every closed enum in the plane it carries "other" so the data model can always
 * describe what it saw — but the closure gate refuses to certify a run that put
 * anything in "other", because that means a shape arrived which the author never
 * decided a mapping for.
 */
export const LegacySourceCategoryValues = [
  "entity-record",
  "typed-edge",
  "legacy-redirect",
  "tombstoned-entity-record",
  "tombstoned-typed-edge",
  "tombstoned-opaque",
  "opaque-object",
  "quarantined-object",
  "narrative-object",
  "derived-index",
  "other"
] as const;
export const LegacySourceCategorySchema = z.enum(LegacySourceCategoryValues);
export type LegacySourceCategory = z.infer<typeof LegacySourceCategorySchema>;

export const LegacyRedirectSchemaNamespace = "legacy/redirect";

export const LegacyRedirectPayloadSchema = z
  .object({
    redirects_to: z.string().regex(/^la_object_[A-Za-z0-9_-]{8,}$/)
  })
  .strict();
export type LegacyRedirectPayload = z.infer<typeof LegacyRedirectPayloadSchema>;

/**
 * Object types that carry narrative text rather than a typed graph fact. v1 of
 * this projector has no typed target representation for them, so they are
 * refused with that named reason rather than dropped — a refusal is countable,
 * a drop is not.
 */
const NarrativeObjectTypes = new Set<string>(["page", "block", "attachment"]);

/**
 * `object_type` is the STORAGE shape; `schema_namespace` is what the record
 * means. Reading the first as if it were the second is what made the entity
 * branch unreachable: every typed endpoint in a real graph is stored as
 * `object_type: "page"`, so it fell straight through to the narrative check and
 * the whole node layer was refused as prose — taking every edge that referenced
 * it down as `endpoint-not-projected` one hop later.
 *
 * Namespace is therefore checked FIRST, and it wins. A node that happens to be
 * persisted as a page is still a node.
 */
const EntitySchemaNamespaces = new Set<string>([
  "import/logseq-semantic/typed-endpoint",
  "import/logseq-topic-review/promoted",
  "import/connector-enrichment/promoted"
]);

const TypedEdgeSchemaNamespaces = new Set<string>([
  "edge/temporal",
  "import/logseq-semantic/typed-edge"
]);

/**
 * Derived lookup tables rebuilt from the records they index. Migrating one would
 * copy a cache into a store that can regenerate it, and a stale copy of an index
 * is worse than no copy: it answers confidently and wrongly.
 */
const DerivedIndexSchemaNamespaces = new Set<string>([
  "import/logseq-semantic/reference-index"
]);

export type LegacySourceClassification = {
  category: LegacySourceCategory;
  resolution: LegacyPayloadResolution;
};

/**
 * Quarantine wins over every other signal. A quarantined object is under
 * suspicion; promoting its content into the new plane because it happened to be
 * readable would launder the quarantine away, so it is withheld whether or not
 * the bytes open.
 */
export function classifyLegacySource(
  envelope: GraphObjectEnvelope,
  resolvePayload: LegacyPayloadResolver
): LegacySourceClassification {
  const resolution = resolvePayload(envelope);

  if (envelope.access_class === "quarantine") {
    return { category: "quarantined-object", resolution };
  }

  const tombstone = envelope.visible_metadata.tombstone;

  if (resolution.kind !== "plaintext") {
    return { category: tombstone ? "tombstoned-opaque" : "opaque-object", resolution };
  }

  if (envelope.visible_metadata.schema_namespace === LegacyRedirectSchemaNamespace) {
    return { category: "legacy-redirect", resolution };
  }

  const namespace = envelope.visible_metadata.schema_namespace;

  // Meaning before storage shape — see EntitySchemaNamespaces.
  if (namespace !== undefined && DerivedIndexSchemaNamespaces.has(namespace)) {
    return { category: "derived-index", resolution };
  }

  if (
    envelope.object_type === "entity" ||
    (namespace !== undefined && EntitySchemaNamespaces.has(namespace))
  ) {
    return { category: tombstone ? "tombstoned-entity-record" : "entity-record", resolution };
  }

  if (
    envelope.object_type === "edge" ||
    (namespace !== undefined && TypedEdgeSchemaNamespaces.has(namespace))
  ) {
    return { category: tombstone ? "tombstoned-typed-edge" : "typed-edge", resolution };
  }

  if (NarrativeObjectTypes.has(envelope.object_type)) {
    return { category: "narrative-object", resolution };
  }

  return { category: "other", resolution };
}

export const MigrationRefusalReasonValues = [
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
  /**
   * A derived lookup table the new plane rebuilds for itself. Distinct from
   * `unclassified-source-category` on purpose: that one means "nobody decided
   * what this is" and must fail the gate, this one means "we decided, and the
   * decision is not to carry it". Collapsing them would let a real unmapped
   * shape hide behind a deliberate omission.
   */
  "derived-index-not-migrated",
  /**
   * A retired subtype word that Rule A's closed table does not name. Also
   * distinct from `unclassified-source-category`: the source category WAS
   * decided (it is an entity record), and only the vocabulary word inside it is
   * unaccounted for. Refusing under the generic reason would report the whole
   * classifier as undecided when one word is.
   */
  "unmapped-legacy-subtype",
  "other"
] as const;
export const MigrationRefusalReasonSchema = z.enum(MigrationRefusalReasonValues);
export type MigrationRefusalReason = z.infer<typeof MigrationRefusalReasonSchema>;

/**
 * A legacy tombstone is not one thing, and collapsing the four cases into a
 * single "deleted" flag is what made the old store's deletions unauditable.
 * Each tombstone lands on exactly one of these dispositions.
 */
export type TombstoneDisposition =
  | { kind: "projected-as-retraction" }
  | { kind: "unrecoverable-ciphertext"; detail: string }
  | { kind: "redaction-stub"; detail: string }
  | { kind: "refused"; reason: MigrationRefusalReason; detail: string };

export function tombstoneDisposition(
  classification: LegacySourceClassification
): TombstoneDisposition {
  const { category, resolution } = classification;

  if (category === "quarantined-object") {
    return {
      kind: "redaction-stub",
      detail: "legacy object was quarantined; content is withheld from the new plane by policy"
    };
  }

  if (category === "tombstoned-entity-record" || category === "tombstoned-typed-edge") {
    return { kind: "projected-as-retraction" };
  }

  if (category === "tombstoned-opaque") {
    if (resolution.kind === "unrecoverable") {
      return { kind: "unrecoverable-ciphertext", detail: resolution.detail };
    }
    return {
      kind: "refused",
      reason: "ciphertext-not-attempted",
      detail: resolution.kind === "unavailable"
        ? resolution.detail
        : "tombstoned ciphertext was not resolved"
    };
  }

  if (category === "narrative-object") {
    return {
      kind: "refused",
      reason: "no-typed-target-representation",
      detail: "narrative objects have no typed target representation in this projector"
    };
  }

  return {
    kind: "refused",
    reason: "unclassified-source-category",
    detail: `no tombstone mapping is declared for category ${category}`
  };
}
