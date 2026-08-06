import { z } from "zod";
import type { EndpointType } from "@living-atlas/contracts";
import type { DerivedNodeOrigin } from "./legacy-endpoint.js";
import { normalizeTopicValue } from "./legacy-vocabulary.js";
import {
  MigrationOrigin,
  MigrationRecordedAtFidelity,
  derivedEntitySlot,
  derivedIdempotencyKey,
  type EntitySlot,
  type MigrationIdempotencyKey,
  type ProjectedEntityRecord,
  type TopicScheme
} from "./target-plane.js";

/**
 * The attribute namespaces minted nodes are keyed under.
 *
 * `counterparty` deliberately covers `provider`, `airline`, `merchant` AND
 * `company_current`: those four attributes all name an organization by name, and
 * keying them separately would mint four nodes for one company that happened to
 * fly you somewhere, sell you the ticket and employ you. One namespace means one
 * node per distinct name, reused — which is the rule the venue split follows too.
 *
 * `subtype` and `job_title` stay APART even though both mint topics and both can
 * hold the same word. Collapsing them would be an identity decision made on a
 * string match, which is the exact move ADR 0012 exists to prevent: a curator can
 * later merge them through the alias ledger with evidence, and that is a decision
 * with a record behind it rather than a coincidence of spelling.
 */
export const DerivedAttributeNamespaces = {
  subtype: "subtype",
  counterparty: "counterparty",
  jobTitle: "job_title"
} as const;

export type DerivedNodeRequest = {
  origin: DerivedNodeOrigin;
  /** The namespace above, not the raw legacy key — that is what makes nodes shared. */
  attribute: string;
  value: string;
  entity_type: Extract<EndpointType, "topic" | "organization">;
};

export type DerivedNodeHandle = {
  slot: EntitySlot;
  idempotency_key: MigrationIdempotencyKey;
  entity_type: DerivedNodeRequest["entity_type"];
};

/**
 * Collects the nodes a plan mints, one per distinct (namespace, value), counting
 * how many legacy objects asked for each.
 *
 * The count is what makes the provenance honest — the node reports that it stands
 * for N mentions rather than borrowing the identity of whichever one happened to
 * come first — and it is deliberately NOT part of the idempotency key, so a later
 * batch that grows the population replays the node instead of committing a second.
 */
/**
 * The value a derived node is keyed and named by.
 *
 * A TOPIC is a vocabulary word, so it takes the same canonical key every other
 * topic in the plan takes: `job_title: "Investor"` and `job_title: "investor"`
 * are one occupation, and keying them raw minted two nodes for it — a duplicate
 * inside a single namespace, which no cross-namespace policy question excuses
 * and which fails the closure gate like any other duplicate this migration
 * creates.
 *
 * An ORGANIZATION name is deliberately left alone. A counterparty's name is an
 * IDENTITY, not a word from a controlled vocabulary, and case-folding two
 * companies together would be exactly the identity decision on a string match
 * that the counterparty namespace refuses to make — the same rule that stops it
 * matching a minted organization onto a same-named legacy one.
 */
function derivedNodeValue(request: DerivedNodeRequest): string {
  return request.entity_type === "topic" ? normalizeTopicValue(request.value) : request.value;
}

/**
 * The concept scheme a DERIVED topic belongs to, read off the attribute
 * namespace that produced it. Only `job_title` mints topics here today; anything
 * else that starts to is a scheme nobody has named, and it lands in `other`
 * where the closure gate refuses to certify it rather than quietly joining an
 * existing vocabulary and colliding with its labels.
 */
export function topicSchemeForDerivedAttribute(attribute: string): TopicScheme {
  return attribute === DerivedAttributeNamespaces.jobTitle ? "occupation" : "other";
}

export class DerivedNodeRegistry {
  private readonly entries = new Map<
    string,
    { request: DerivedNodeRequest; value: string; handle: DerivedNodeHandle; count: number }
  >();

  constructor(private readonly authorityId: string) {}

  /**
   * Registers one mention and returns the shared node. Called once per legacy
   * object that names the value, so the count ends up being the population.
   */
  register(request: DerivedNodeRequest): DerivedNodeHandle {
    const value = derivedNodeValue(request);
    const key = `${request.attribute}\n${value}`;
    const existing = this.entries.get(key);
    if (existing) {
      existing.count += 1;
      return existing.handle;
    }
    const handle: DerivedNodeHandle = {
      slot: derivedEntitySlot(this.authorityId, request.attribute, value),
      idempotency_key: derivedIdempotencyKey({
        authority_id: this.authorityId,
        attribute: request.attribute,
        value,
        record_kind: "entity"
      }),
      entity_type: request.entity_type
    };
    this.entries.set(key, { request, value, handle, count: 1 });
    return handle;
  }

  /**
   * The minted entity records, in a stable order. Sorted by idempotency key so
   * the plan is byte-identical across runs regardless of the order the source
   * happened to mention each value in.
   */
  records(): ProjectedEntityRecord[] {
    return [...this.entries.values()]
      .map(({ request, value, handle, count }) => ({
        record_kind: "entity" as const,
        idempotency_key: handle.idempotency_key,
        origin: MigrationOrigin,
        recorded_at_fidelity: MigrationRecordedAtFidelity,
        provenance: {
          derived_from: request.origin,
          legacy_attribute: request.attribute,
          // The value the node was keyed by, so provenance and identity cannot
          // disagree: a record naming one spelling while its slot was derived
          // from another sends an auditor looking for a node that is not there.
          legacy_value: value,
          source_object_count: count
        },
        slot: handle.slot,
        entity_type: request.entity_type,
        ...(request.entity_type === "topic"
          ? { topic_scheme: topicSchemeForDerivedAttribute(request.attribute) }
          : {}),
        name: value,
        aliases: [],
        attrs: {}
      }))
      .sort((left, right) =>
        left.idempotency_key < right.idempotency_key ? -1 : left.idempotency_key > right.idempotency_key ? 1 : 0
      );
  }
}

/**
 * Why a legacy attribute could not be carried across mechanically.
 *
 * These are NOT refusals: the object itself projects fine, and refusing it would
 * throw away a whole node over one attribute. They are also not silence, which is
 * the outcome that actually loses data — `company_current` simply has no field in
 * the target person schema, so an attribute nobody placed and nobody counted
 * would vanish with no trace that it had ever been there.
 */
export const HandReviewReasonValues = [
  "ambiguous-employer",
  "attribute-conflict",
  "unresolvable-attribute-reference",
  "unplaced-attribute",
  /**
   * An attribute the ratified table says survives and the frozen endpoint
   * revision has no key for. `mode`, `route`, `origin` and `destination` on a
   * travel leg are the whole population: the table says the mode of travel stays
   * an attribute, the 2026.08.1 occurrence endpoint is `.strict()` and declares
   * none of them, and both statements cannot be satisfied today.
   *
   * Distinct from `unplaced-attribute`, which means the projector had a slot and
   * could not decide which one. This means there is NO slot, so the remedy is a
   * contract change rather than a curator's judgement — and the two must not be
   * counted together or the contract gap hides inside the judgement queue.
   */
  "no-contract-slot",
  /**
   * The ratified retype table looked at this node and declined to decide.
   * `project/tool` and `project/product` are probably offerings; "probably" is
   * not a mapping, so the node projects unchanged and a human is shown the row.
   * Without this the decline was recorded in a report no production path builds,
   * and the two nodes projected as ordinary projects with nobody told.
   */
  "ratified-table-declined"
] as const;
export const HandReviewReasonSchema = z.enum(HandReviewReasonValues);
export type HandReviewReason = z.infer<typeof HandReviewReasonSchema>;

/**
 * Names the object and the attribute, never the value. A reviewer needs to know
 * where to look; putting the value here would make the plan file a partial copy
 * of the corpus, and the plan is written to whatever directory a dry run happens
 * to be reviewed in.
 */
export type HandReviewItem = {
  legacy_object_id: string;
  attribute: string;
  reason: HandReviewReason;
  detail: string;
};

export function compareHandReviewItems(left: HandReviewItem, right: HandReviewItem): number {
  if (left.legacy_object_id !== right.legacy_object_id) {
    return left.legacy_object_id < right.legacy_object_id ? -1 : 1;
  }
  if (left.attribute !== right.attribute) {
    return left.attribute < right.attribute ? -1 : 1;
  }
  return left.reason < right.reason ? -1 : left.reason > right.reason ? 1 : 0;
}
