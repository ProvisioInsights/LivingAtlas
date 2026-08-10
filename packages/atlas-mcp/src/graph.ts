import type {
  AssertionLog,
  Entity,
  EntityContext,
  EntityDraft,
  EntityId,
  RenameResult,
  Resolution
} from "@living-atlas/atlas-core";
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
    /**
     * Mint a new entity, present only when the store was opened read-write.
     *
     * Optional for the same reason `readOnly` is: every in-memory `GraphSource`
     * that predates the durable store has no writer, and a required method would
     * mean editing each of them to throw. A read-write store sets it; a
     * read-only one leaves it absent and the handler refuses with
     * `store-read-only` before ever reaching for it.
     */
    register?(draft: EntityDraft, context: EntityContext): Entity;
    /** Rename an entity in place — no id moves. Present only when read-write. */
    rename?(entityId: EntityId, change: { display_name?: string; also_known_as?: string[] }, context: EntityContext): RenameResult;
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
  /**
   * True when this port was opened over a store nothing may write to.
   *
   * A property of the STORE and never of the credential, which is why it lives
   * here rather than in the grant: "no credential was granted this predicate"
   * and "this server cannot write at all" are different facts, and a caller told
   * the first when the second is true will go and ask for a wider grant that
   * cannot help it.
   *
   * Optional, and absent means writable. Every in-memory `GraphSource` in this
   * repository predates the durable one and accepts commits; making the field
   * required would have meant editing each of them to restate what they already
   * were, and a field nobody set would then read as "read-only" the first time
   * someone forgot.
   */
  readOnly?: boolean;
};

/** The functional half of the registry, as the contested-group check needs it. */
export function functionalPredicates(graph: GraphSource): ReadonlySet<string> {
  return new Set(graph.predicateRegistry().filter((entry) => entry.cardinality === "functional").map((entry) => entry.predicate));
}
