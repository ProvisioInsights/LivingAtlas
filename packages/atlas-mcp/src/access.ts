import { createHash } from "node:crypto";
import type { Assertion, Entity } from "@living-atlas/atlas-core";
import { reachesTier } from "./grant.js";
import { ceilingOf, type Principal } from "./principal.js";

/**
 * The access decision, in code.
 *
 * AGENTS.md: "Enforce access restrictions in MCP/tool code, not in AI prompts."
 * So this module is the only place that decides whether a record's content
 * reaches a caller, every tool routes its records through it, and the decision
 * is a value a test can assert on rather than a sentence in a description.
 *
 * The rule is one membership test: a record whose sensitivity tier the grant
 * does not name is WITHHELD. Withheld is not dropped — the record still
 * occupies its row as an `atlas.redaction:v1` stub, so a filtered graph is
 * never indistinguishable from a complete one. The prior surface's `search`,
 * `traverse`, `timeline` and `edge_read` each silently dropped rows the caller
 * could not detect.
 *
 * Membership, not a rank comparison. A ceiling admits any tier that happens to
 * sort below it — including one introduced after the grant was written — so a
 * new tier could reach an existing credential with nobody having granted it.
 * The ceiling still exists, as a REPORT of the reachable set (`ceilingOf`), and
 * is used only to size how much a stub may disclose about itself.
 */

export type Sensitivity = { tier: string; rank: number; withheld: boolean };

/** The redaction stub, as the published `atlas.redaction:v1` record. */
export type RedactionStub = {
  record_schema: "atlas.redaction:v1";
  redaction_id: string;
  withheld_record_schema: string;
  disclosure_level: "existence-only" | "shape" | "metadata";
  sensitivity: Sensitivity;
  reason_code: string;
  reveal_available: boolean;
  reveal_tool?: string;
  seq?: number;
};

export type AccessDecision<T> = { allowed: true; record: T } | { allowed: false; stub: RedactionStub };

export const REVEAL_TOOL = "atlas.sensitive.reveal.v1";

/**
 * The stub's id, derived from (record id, principal) and nothing else.
 *
 * Stable for this record and this credential, because `atlas.sensitive.reveal.v1`
 * has to have something to name and a caller has to be able to hold it across
 * calls. Derived rather than minted so no server-side table has to remember
 * which stub was handed to whom — a table that can be lost is a reveal that
 * stops working.
 *
 * It is a HASH rather than the id itself: an opaque stub whose id is the
 * withheld record's id discloses the identifier of the very thing being
 * withheld, and identifiers are frequently the sensitive part.
 */
export function redactionId(recordId: string, principal: Principal): string {
  const digest = createHash("sha256")
    .update(`${principal.client_id}\u0000${recordId}`, "utf8")
    .digest("hex")
    .slice(0, 32);
  return `la_redaction_${digest}`;
}

/**
 * `disclosure_level` follows from the ceiling gap, not from a per-record flag.
 *
 * A record one rank above the ceiling is near-miss: naming its record kind is
 * useful and costs little. A record far above it gets existence-only, because
 * the further a record is from what a credential may see, the more the SHAPE of
 * it is itself a signal about what kind of thing is being hidden.
 */
function disclosureLevel(gap: number): RedactionStub["disclosure_level"] {
  if (gap <= 1) return "shape";
  return "existence-only";
}

function stubFor(input: {
  recordId: string;
  recordSchema: string;
  sensitivity: Sensitivity;
  principal: Principal;
  seq?: number;
}): RedactionStub {
  const gap = input.sensitivity.rank - ceilingOf(input.principal).rank;
  const level = disclosureLevel(gap);
  return {
    record_schema: "atlas.redaction:v1",
    redaction_id: redactionId(input.recordId, input.principal),
    // At existence-only the caller is told a record is here and nothing about
    // its kind. The field is required by the contract, so it carries the
    // honest non-answer rather than being omitted or guessed.
    withheld_record_schema: level === "shape" ? input.recordSchema : "atlas.withheld:v1",
    disclosure_level: level,
    sensitivity: { ...input.sensitivity, withheld: true },
    reason_code: "sensitivity-withheld",
    reveal_available: input.principal.grant.reveal_available,
    ...(input.principal.grant.reveal_available ? { reveal_tool: REVEAL_TOOL } : {}),
    ...(input.seq === undefined ? {} : { seq: input.seq })
  };
}

/**
 * May this principal read this record's content?
 *
 * Two conditions, and both must hold. `sensitivity.withheld` is a property of
 * the RECORD — the graph itself says this content is not for the consumer
 * plane — and tier reachability is a property of the GRANT. Either one alone
 * withholds. An owner credential does not override `withheld`: a record marked
 * withheld is unlocked through the reveal path, which writes an audit event,
 * not through a grant broad enough to make the mark irrelevant.
 */
export function decideAssertion(assertion: Assertion, principal: Principal): AccessDecision<Assertion> {
  const sensitivity = assertion.sensitivity;
  if (!sensitivity.withheld && reachesTier(principal.grant, sensitivity.tier)) {
    return { allowed: true, record: assertion };
  }
  return {
    allowed: false,
    stub: stubFor({
      recordId: assertion.assertion_id,
      recordSchema: "atlas.assertion:v1",
      sensitivity,
      principal,
      seq: assertion.seq
    })
  };
}

export function decideEntity(entity: Entity, principal: Principal): AccessDecision<Entity> {
  const sensitivity = entity.sensitivity;
  if (!sensitivity.withheld && reachesTier(principal.grant, sensitivity.tier)) {
    return { allowed: true, record: entity };
  }
  return {
    allowed: false,
    stub: stubFor({
      recordId: entity.entity_id,
      recordSchema: "atlas.entity:v1",
      sensitivity,
      principal
    })
  };
}

/**
 * May this principal supersede this assertion?
 *
 * Enforced at propose time, against the assertion's recorded `provenance.client_id`
 * — which Atlas stamped and a caller cannot influence — and never against
 * anything in the request.
 */
export function maySupersede(target: Assertion, principal: Principal): boolean {
  if (principal.grant.supersession_scope === "any") return true;
  return target.provenance.client_id === principal.client_id;
}
