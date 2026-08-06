import type { CredentialRecord } from "@living-atlas/atlas-mcp";
import { CONTRACT_TOOL_NAMES } from "@living-atlas/atlas-contract";

/**
 * The synthetic world this harness runs against, and the credentials that reach
 * it.
 *
 * EVERYTHING here is fabricated. No test in this package reads a real graph, a
 * real profile directory, or any path outside `os.tmpdir()`: the repository's
 * privacy boundary is that policy, leakage, sync, key and audit behaviour is
 * proven on synthetic fixtures BEFORE real data is imported, and an end-to-end
 * harness that reached for real data would be on the wrong side of that line
 * while looking more convincing than any other test in the tree.
 *
 * Shared between the parent (which holds the secrets) and the child (which holds
 * only their hashes), so the two cannot drift about what a credential may do.
 */

/** The belief-time floor the fixture graph is created with. Reads below it are refused. */
export const FIXTURE_HISTORY_FLOOR = "2026-06-01T00:00:00.000Z";

/** An instant below the floor, for the refusal path. Named so the test reads as intent. */
export const BEFORE_FIXTURE_HISTORY_FLOOR = "2026-01-01T00:00:00.000Z";

export const FIXTURE_FEED_EPOCH = "e-e2e";

/** The predicate a consumer credential is granted the right to write. */
export const WRITABLE_PREDICATE = "worked-at";

/** The predicate the sealed fixture record uses. Readable by nobody in this harness. */
export const SEALED_PREDICATE = "medical-note";

/**
 * The tier `AssertionLog.commit` stamps on unclassified content, and therefore
 * the tier a consumer must be granted BOTH the reach to read and the permission
 * to write. Named rather than assumed: a tier nobody granted is unreachable,
 * including this one, and that is the grant model working as designed.
 */
export const CONSUMER_WRITE_TIER = "local-private";

export const FIXTURE_ENTITY_NAMES = ["Synthetic Person Alpha", "Synthetic Person Beta"] as const;

/** How many open assertions the fixture seeds. Small on purpose: this suite runs in `npm test`. */
export const FIXTURE_OPEN_ASSERTIONS = 3;

export type HarnessPrincipalName = "consumer" | "operator";

/**
 * The principals the child's credential directory holds.
 *
 * Two, and the second is the point: a credential bound to the OPERATOR plane
 * exists so the consumer server can be shown refusing it. A harness with only a
 * consumer credential can prove that an operator TOOL is absent, which is a
 * weaker claim — a tool can be absent because nobody registered it, while a
 * plane refusal is the authorization boundary doing its job.
 */
export function harnessPrincipals(): Record<HarnessPrincipalName, CredentialRecord["principal"]> {
  return {
    consumer: {
      client_id: "e2e-consumer",
      credential_class: "consumer",
      plane: "consumer",
      grant: {
        grant_id: "grant-e2e-consumer",
        sensitivity_reachable: [
          { tier: "open", rank: 0 },
          { tier: CONSUMER_WRITE_TIER, rank: 10 }
        ],
        tools_permitted: [...CONTRACT_TOOL_NAMES],
        predicates_writable: [WRITABLE_PREDICATE],
        write_tiers_permitted: [CONSUMER_WRITE_TIER],
        limits: {},
        // Exact, so the journey can assert that a withheld row is counted as
        // exactly one. Bucketing is the right default for a real credential and
        // the wrong one for a test that has to see the number.
        coverage_counts_basis: "exact",
        supersession_scope: "own-client-id",
        reveal_available: true
      }
    },
    operator: {
      client_id: "e2e-operator",
      credential_class: "operator",
      plane: "operator",
      grant: {
        grant_id: "grant-e2e-operator",
        sensitivity_reachable: [{ tier: "open", rank: 0 }],
        tools_permitted: [],
        predicates_writable: [],
        write_tiers_permitted: [],
        limits: {},
        coverage_counts_basis: "bucketed",
        supersession_scope: "own-client-id",
        reveal_available: false
      }
    }
  };
}

/** The live predicate vocabulary this fixture graph publishes. */
export function fixturePredicateRegistry(): { predicate: string; cardinality: "functional" | "multi-valued"; functional_key?: string[]; relational: boolean }[] {
  return [
    { predicate: WRITABLE_PREDICATE, cardinality: "multi-valued", relational: false },
    { predicate: SEALED_PREDICATE, cardinality: "multi-valued", relational: false },
    { predicate: "reports-to", cardinality: "functional", functional_key: ["subject_entity_id"], relational: true }
  ];
}
