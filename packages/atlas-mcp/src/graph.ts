import type { AssertionLog, Entity, EntityId, Resolution } from "@living-atlas/atlas-core";
import type { PredicateEntry } from "./vocabulary.js";

/**
 * What the 12 consumer tools read and write through.
 *
 * A port rather than a direct dependency on `AssertionLog` + `EntityRegistry`,
 * for two reasons that both show up in the published contract:
 *
 *  - **`searchableEntities` and `encryptedUnsearchable` are separate on
 *    purpose.** `atlas.text.search.v1` must report what could NOT be scanned.
 *    The prior remote path filtered to plaintext with score > 0 and reported
 *    nothing, so an encrypted match and no match were indistinguishable. Making
 *    the unsearchable count an obligation of the port means a deployment that
 *    holds encrypted content cannot answer 0 by omission — it has to say what
 *    its number is.
 *
 *  - **`predicateRegistry` is data, not a hardcoded list.** Two live assertions
 *    on one FUNCTIONAL key are a contradiction Atlas must report rather than
 *    resolve; two overlapping multi-valued assertions are simply two facts.
 *    Which predicates are functional is graph vocabulary, so the graph supplies
 *    it — and `atlas.contract.describe.v1` publishes what it supplied, so a
 *    consumer validates against the LIVE registry rather than against the
 *    frozen `x-atlas-known-values` hint in the schema.
 */
export type GraphSource = {
  assertions: AssertionLog;
  entities: {
    read(entityId: EntityId): Entity | undefined;
    resolve(id: string): Resolution;
  };
  /** Entities the deterministic text scorer may scan. */
  searchableEntities(): Iterable<Entity>;
  /**
   * Records excluded from a text scan because their content is encrypted at
   * rest. Reported, never silently dropped.
   */
  encryptedUnsearchable(): number;
  /** The live predicate vocabulary, cardinality included. */
  predicateRegistry(): readonly PredicateEntry[];
};

/** The functional half of the registry, as the contested-group check needs it. */
export function functionalPredicates(graph: GraphSource): ReadonlySet<string> {
  return new Set(graph.predicateRegistry().filter((entry) => entry.cardinality === "functional").map((entry) => entry.predicate));
}
