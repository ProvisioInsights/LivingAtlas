import { scanIdentityLog, scanSegmentLog, type Assertion, type Entity } from "@living-atlas/atlas-core";
import {
  MigrationClientId,
  migrationPlaneDirectories,
  readProvisionalBlockFile
} from "./durable-plane.js";
import type { ProjectedRecord } from "./target-plane.js";

/**
 * READING A MIGRATED STORE BACK, WITHOUT WRITING TO IT.
 *
 * This lives beside the adapter that wrote the store rather than in the checker
 * that consumes it, for two reasons. The layout — two segment directories and a
 * carried file — is this package's decision, and a reader that re-derived it
 * elsewhere would be a second copy of that decision, free to drift. And the join
 * key is the migration idempotency key, which only this package mints.
 *
 * EVERY SCAN IS `repair: false`. A verifier is opened over a store precisely
 * when somebody doubts it, so a torn tail must be reported and left exactly
 * where it is. Repairing it would destroy the evidence the read exists to
 * collect, and would do it silently, on the operator's only copy.
 */
export type MigrationStoreContents = {
  entities: readonly Entity[];
  assertions: readonly Assertion[];
  /** Migration idempotency key -> the entity it minted. */
  entityByKey: Map<string, Entity>;
  /** Migration idempotency key -> the assertion ids its submission named. */
  assertionIdsByKey: Map<string, readonly string[]>;
  /** Legacy object id -> the alias row's disposition word. */
  aliasDispositionByLegacyId: Map<string, string>;
  provisionalBlocks: { object_id: string; idempotency_key: string; record: ProjectedRecord }[];
  provisionalRetractions: { object_id: string; idempotency_key: string }[];
  /**
   * Damage found while reading, reported rather than repaired.
   *
   * Counts the carried file's torn tail as well as the two segment logs'. The
   * verifier's verdict turns on this number, and a store whose most
   * content-bearing file ends mid-record is a store nobody should be told
   * carried the old one faithfully — the tear is damage wherever it is.
   */
  segment_repairs: number;
};

export function readMigrationStore(directory: string): MigrationStoreContents {
  const paths = migrationPlaneDirectories(directory);
  const identity = scanIdentityLog(paths.identity, { repair: false });
  const assertions = scanSegmentLog(paths.assertions, { repair: false });

  // Only what THIS migration wrote. A store that also holds records from another
  // client is not a reason to fail a faithfulness check about the migration, and
  // counting them would make every total disagree for a reason nobody could find.
  const entityByKey = new Map<string, Entity>();
  for (const entity of identity.restored.entities) {
    if (entity.provenance.client_id !== MigrationClientId) continue;
    const key = entity.provenance.basis;
    if (key !== undefined) entityByKey.set(key, entity);
  }

  const assertionIdsByKey = new Map<string, readonly string[]>();
  for (const receipt of assertions.restored.submissions.values()) {
    if (receipt.client_id !== MigrationClientId) continue;
    assertionIdsByKey.set(receipt.idempotency_key, receipt.assertion_ids);
  }

  const aliasDispositionByLegacyId = new Map<string, string>();
  for (const row of identity.restored.rows) aliasDispositionByLegacyId.set(row.old_id, row.disposition);

  // Read-only, like both scans above: no `repair`, so a torn tail is reported
  // and left exactly where it is. A verifier is opened over a store precisely
  // when somebody doubts it.
  const carried = readProvisionalBlockFile(directory);
  const provisionalBlocks: MigrationStoreContents["provisionalBlocks"] = [];
  const provisionalRetractions: MigrationStoreContents["provisionalRetractions"] = [];
  for (const line of carried.lines) {
    if (line.record.record_kind === "retraction") {
      provisionalRetractions.push({ object_id: line.object_id, idempotency_key: line.idempotency_key });
    } else {
      provisionalBlocks.push({
        object_id: line.object_id,
        idempotency_key: line.idempotency_key,
        record: line.record
      });
    }
  }

  return {
    entities: identity.restored.entities,
    assertions: assertions.restored.assertions,
    entityByKey,
    assertionIdsByKey,
    aliasDispositionByLegacyId,
    provisionalBlocks,
    provisionalRetractions,
    segment_repairs:
      assertions.repairs.length + identity.repairs.length + (carried.repair ? 1 : 0)
  };
}
