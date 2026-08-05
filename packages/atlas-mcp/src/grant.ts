import { CONTRACT_DISCOVERY_TOOLS } from "@living-atlas/atlas-contract";
import { z } from "zod";

/**
 * What a credential may do, stated without reference to how it connects.
 *
 * This replaces the transport-named profile model. The prior control plane's
 * `McpProfile` enum was literally a list of transports — `local-full`,
 * `local-readonly`, `remote-safe`, `sync-device` — and the local daemon then
 * rejected any capability whose profile did not start with `local-`. A
 * consumer's credential WAS its transport, with two consequences:
 *
 *  - transport parity was unreachable by construction. The same credential could
 *    not exist on two transports, so "the same client, same permissions, over
 *    HTTP instead of stdio" was not expressible, and every difference between
 *    the two surfaces was invisible rather than declared;
 *  - a correct consumer had to branch on its transport to know what it could do,
 *    which pushes an authorization decision into the caller.
 *
 * Nothing in this type names a transport, and nothing may. A grant is a set of
 * reachable tiers, a set of callable tools, a set of writable predicates, a set
 * of writable tiers, and numeric limits. Two credentials that differ are two
 * grants; the wire they arrive on is not part of the answer. `grant.test.ts`
 * scans this file and the other authorization sources and fails if a transport
 * word appears in one.
 *
 * Differences are discovered generically: `atlas.scope.describe.v1` publishes
 * the grant back to its holder, so a consumer asks what it may do rather than
 * inferring it from which binary it was launched by.
 */

export const SensitivityTierSchema = z
  .object({
    tier: z.string().min(1),
    /** Compare rank, never the tier name. A tier introduced in 2032 slots in by rank. */
    rank: z.number().int().min(0)
  })
  .strict();

export type SensitivityTier = z.infer<typeof SensitivityTierSchema>;

/**
 * Per-grant caps.
 *
 * Every member is optional because a grant that names no limit is not a grant
 * with no limit — the published contract's cap still applies. `effectiveLimit`
 * is the only reader, and it takes the minimum, so a grant can only ever narrow.
 */
export const GrantLimitsSchema = z
  .object({
    max_page_size: z.number().int().positive().optional(),
    max_ids_per_request: z.number().int().positive().optional(),
    max_batch_items: z.number().int().positive().optional()
  })
  .strict();

export type GrantLimits = z.infer<typeof GrantLimitsSchema>;

export const CapabilityGrantSchema = z
  .object({
    /** Names this grant in an audit event without naming the credential that carries it. */
    grant_id: z.string().min(1),
    /**
     * Tiers whose content this grant may read, BY NAME.
     *
     * A named set rather than a rank ceiling, and that is the security
     * difference: a ceiling admits any tier that happens to sort below it,
     * including one introduced after the grant was written and ranked low by
     * whoever introduced it. A set cannot silently widen — a tier nobody granted
     * is withheld, and a new tier reaches an existing credential only when
     * someone edits the grant.
     */
    sensitivity_reachable: z.array(SensitivityTierSchema).min(1),
    /**
     * Tools this grant may call. Explicit names, never a wildcard: a grant that
     * says "everything" describes nothing, and the tool set a credential can
     * reach is the first thing an audit of that credential has to answer.
     *
     * The plane's discovery tools are reachable regardless — see
     * `DISCOVERY_TOOLS`.
     */
    tools_permitted: z.array(z.string().min(1)),
    /** Predicates this grant may assert about. Empty is a legitimate read-only grant. */
    predicates_writable: z.array(z.string().min(1)),
    /** Sensitivity tiers this grant may write AT. Read reach and write reach are different questions. */
    write_tiers_permitted: z.array(z.string().min(1)),
    limits: GrantLimitsSchema,
    /**
     * Exact counts are a disclosure channel: repeated filter bisection against
     * an exact `withheld` localises a withheld record without ever reading it.
     */
    coverage_counts_basis: z.enum(["exact", "bucketed"]),
    /**
     * own-client-id: may supersede only assertions this credential authored. A
     * credential that can retract another's belief can rewrite attribution, and
     * attribution is the only thing that makes provenance mean anything.
     */
    supersession_scope: z.enum(["own-client-id", "any"]),
    /** Whether this credential could ever unlock a withheld record at all. */
    reveal_available: z.boolean()
  })
  .strict()
  .superRefine((grant, ctx) => {
    // One tier name, two ranks, is a grant whose ceiling depends on iteration
    // order. Refused at parse rather than resolved by picking one.
    const seen = new Set<string>();
    for (const entry of grant.sensitivity_reachable) {
      if (seen.has(entry.tier)) {
        ctx.addIssue({
          code: "custom",
          path: ["sensitivity_reachable"],
          message: `tier ${entry.tier} is named twice; a tier has one rank in a grant`
        });
      }
      seen.add(entry.tier);
    }
  });

export type CapabilityGrant = z.infer<typeof CapabilityGrantSchema>;

/**
 * Tools every grant on a plane may call, whatever `tools_permitted` says.
 *
 * Both are pure descriptions of the caller's own situation and of the published
 * contract — neither reads graph content. A credential that cannot ask what it
 * may do can only learn by probing, and probing is exactly the behaviour
 * `atlas.scope.describe.v1` exists to remove. Withholding the answer does not
 * protect anything; it only makes the refusals harder to interpret.
 *
 * Keyed by plane, so the operator plane's discovery tool is not reachable from a
 * consumer grant by inheriting a shared list.
 */
export const DISCOVERY_TOOLS: Readonly<Record<"consumer" | "operator", readonly string[]>> = {
  // Imported, never restated. The consumer plane's discovery set is a property
  // of the published contract; a copy here would be a second list that agrees
  // with the first only until somebody edits one of them.
  consumer: CONTRACT_DISCOVERY_TOOLS,
  operator: ["atlas.ops.scope.describe.v1"]
};

/** May this grant call this tool, on this plane? */
export function mayCallTool(grant: CapabilityGrant, plane: "consumer" | "operator", tool: string): boolean {
  if (DISCOVERY_TOOLS[plane].includes(tool)) return true;
  return grant.tools_permitted.includes(tool);
}

/**
 * The tools a grant may call, in the order the plane published them.
 *
 * Order comes from `published` and never from the grant, because the spec asks
 * for a deterministic `tools/list` and a grant is an unordered set of names.
 */
export function permittedTools(
  grant: CapabilityGrant,
  plane: "consumer" | "operator",
  published: readonly string[]
): string[] {
  return published.filter((tool) => mayCallTool(grant, plane, tool));
}

/**
 * May this grant read content at this tier?
 *
 * Membership by tier NAME. A tier the grant does not name is unreachable even
 * when its rank is low — see `sensitivity_reachable`.
 */
export function reachesTier(grant: CapabilityGrant, tier: string): boolean {
  return grant.sensitivity_reachable.some((entry) => entry.tier === tier);
}

/**
 * The highest-ranked tier this grant reaches.
 *
 * Published as `sensitivity_ceiling` and used for the redaction stub's
 * `disclosure_level` gap. It is a REPORT of the reachable set, never the rule:
 * the rule is `reachesTier`. Deriving the ceiling from the set rather than
 * storing it separately is what stops the two from disagreeing.
 *
 * The schema requires at least one member, so there is always an answer.
 */
export function sensitivityCeiling(grant: CapabilityGrant): SensitivityTier {
  let highest = grant.sensitivity_reachable[0];
  if (highest === undefined) {
    // Unreachable: `sensitivity_reachable` is `.min(1)`. Stated as a refusal
    // rather than a non-null assertion so a schema loosened in future fails
    // here instead of silently producing rank 0 — which would read as "this
    // credential reaches the lowest tier" rather than as a bug.
    throw new Error("a capability grant must name at least one reachable sensitivity tier");
  }
  for (const entry of grant.sensitivity_reachable) {
    if (entry.rank > highest.rank) highest = entry;
  }
  return highest;
}

/** May this grant assert about this predicate? */
export function mayWritePredicate(grant: CapabilityGrant, predicate: string): boolean {
  return grant.predicates_writable.includes(predicate);
}

/** May this grant commit at this sensitivity tier? */
export function mayWriteTier(grant: CapabilityGrant, tier: string): boolean {
  return grant.write_tiers_permitted.includes(tier);
}

/**
 * The limit that actually applies: the published cap, narrowed by the grant.
 *
 * `Math.min` and nothing else. A grant naming a LARGER number than the contract
 * publishes does not widen anything — the published caps are transport-invariant
 * and a credential is not a way around them. Expressed as one function with one
 * reader so there is no second place where a limit could be resolved
 * differently; a parse-time refusal of an over-large grant would be a second
 * rule that could disagree with this one.
 */
export function effectiveLimit(published: number, granted: number | undefined): number {
  return granted === undefined ? published : Math.min(published, granted);
}
