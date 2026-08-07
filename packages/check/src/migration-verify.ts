import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { GraphObjectEnvelope } from "@living-atlas/contracts";
import { decryptGraphObjectPayload, openLocalKeyring, resolveLocalSecret } from "@living-atlas/local-keyring";
import {
  RegistryTypeByEndpointType,
  buildProjectionPlan,
  readMigrationStore,
  type LegacyPayloadResolution,
  type MigrationStoreContents,
  type ProjectedRecord,
  type ProjectedRecordKind,
  type ProjectionPlan
} from "@living-atlas/atlas-migrate";

/**
 * DID THE NEW STORE FAITHFULLY CARRY THE OLD ONE?
 *
 * The apply path already reconciles, and that is not the same question. Its
 * equations are computed from the plan and checked against the store the same
 * run just wrote — so it proves the run did what it set out to do. It cannot
 * prove that what it set out to do was carry the old graph across, because both
 * sides of every equation come from the same plan.
 *
 * This reads BOTH STORES INDEPENDENTLY and compares them. The old store is
 * re-derived from the frozen replica; the new store is read back off its own
 * segment files. Nothing here consults the apply run's report, its audit events
 * or its counters: a migration that mis-attributed every edge would have
 * reconciled perfectly and be caught here, and that is the whole point.
 *
 * BOTH SIDES ARE OPENED READ-ONLY. `scanSegmentLog(..., { repair: false })`
 * leaves a torn tail reported and untouched, no writer is constructed over
 * either directory, and the replica is only ever read. A verifier that repaired
 * what it was measuring would destroy the evidence it exists to collect.
 *
 * THE OUTPUT IS CONTENT-FREE, AND THAT IS ENFORCED RATHER THAN INTENDED.
 * Findings carry ids, slots, record kinds, field NAMES and counts. They never
 * carry a display name, an alias, a description, a block's text or a refusal's
 * free-text detail. A private topic name reached a review surface once already,
 * through exactly the sort of "detail" string that looks harmless while it is
 * being written, so the finding type has no field a value could be put in and
 * `assertFindingIsContentFree` refuses one that tries.
 */

export const FaithfulnessCheckValues = [
  "legacy-id-resolution",
  "record-counts",
  "field-comparison",
  "provisional-blocks"
] as const;
export type FaithfulnessCheck = (typeof FaithfulnessCheckValues)[number];

export const FaithfulnessFindingCodeValues = [
  /** A source object the new store's alias ledger has no row for at all. */
  "legacy-id-unresolved",
  /** A row exists, but says something other than what the plan planned. */
  "alias-disposition-mismatch",
  /** The plan called for a record and the store holds none with its key. */
  "record-missing",
  /** The store holds a migration record the plan never called for. */
  "record-unplanned",
  /** Planned and present, but a field differs between the planes. */
  "field-mismatch",
  /** A sampled record could not be compared because its endpoint never minted. */
  "endpoint-unresolved",
  "block-count-mismatch",
  "block-text-length-mismatch"
] as const;
export type FaithfulnessFindingCode = (typeof FaithfulnessFindingCodeValues)[number];

/**
 * One actionable difference.
 *
 * Every field is an id, a closed-vocabulary word, a field NAME or a number.
 * There is deliberately no `detail` and no `message`: a free-text field on a
 * finding is where content leaks, because the value that explains the problem
 * best is usually the value you must not print.
 */
export type FaithfulnessFinding = {
  check: FaithfulnessCheck;
  code: FaithfulnessFindingCode;
  /** The source object, when the finding is about one. */
  legacy_object_id?: string;
  /** The new-plane record, when one exists. */
  object_id?: string;
  record_kind?: ProjectedRecordKind;
  slot?: string;
  /** The NAME of the field that differs. Never its value on either side. */
  field?: string;
  /** Closed-vocabulary words only — dispositions, types, predicates. */
  expected_word?: string;
  observed_word?: string;
  expected_count?: number;
  observed_count?: number;
};

export type FaithfulnessCheckResult = {
  check: FaithfulnessCheck;
  ok: boolean;
  /** What the check looked at, so a vacuous pass is visible as one. */
  examined: number;
  findings: FaithfulnessFinding[];
};

export type MigrationFaithfulnessReport = {
  ok: boolean;
  source_objects: number;
  /**
   * Damage the scan found in the new store's segment files and did not repair.
   *
   * Part of the verdict, not a footnote. A torn tail means the log may be short
   * of records that were written to it, so "faithful" is a claim this run is not
   * in a position to make -- and the store the operator is being asked to trust
   * is the one that is damaged.
   */
  segment_repairs: number;
  checks: FaithfulnessCheckResult[];
  /** Every finding, flattened, most structural first. */
  findings: FaithfulnessFinding[];
  /** Findings withheld from the enumeration because the list was capped. */
  truncated: number;
};

/**
 * How many findings of one code are enumerated before the rest become a count.
 *
 * A verifier that prints one line per record is the audit-fanout defect the old
 * daemon shipped: on a corpus this size a systematic failure would emit tens of
 * thousands of lines and eventually exceed Node's maximum string length, so the
 * report that was supposed to explain the failure is itself the second failure.
 * The count is never truncated; only the enumeration is.
 */
export const MaxFindingsPerCode = 20;

/** Records the identity log holds, rather than the assertion log. */
const EntityRecordKinds = new Set<ProjectedRecordKind>(["entity", "minted-entity"]);

export function assertFindingIsContentFree(finding: FaithfulnessFinding): void {
  for (const [key, value] of Object.entries(finding)) {
    if (typeof value !== "string") continue;
    if (key === "expected_word" || key === "observed_word") continue;
    if (key === "field" || key === "check" || key === "code") continue;
    if (key === "record_kind" || key === "slot") continue;
    if (key === "legacy_object_id" || key === "object_id") continue;
    throw new Error(
      `finding carries an unrecognised string field ${key}; every string on a finding must be an ` +
        "id, a closed-vocabulary word or a field name, because a free-text field is where content leaks"
    );
  }
}

function finding(input: FaithfulnessFinding): FaithfulnessFinding {
  assertFindingIsContentFree(input);
  return input;
}

/** The disposition class a planned alias target must land in. */
function plannedAliasClass(kind: "record" | "ambiguous-split" | "no-target"): string {
  if (kind === "record") return "redirect";
  if (kind === "ambiguous-split") return "ambiguous-split";
  return "terminal";
}

function observedAliasClass(disposition: string): string {
  if (disposition === "mapped" || disposition === "mapped-assertion") return "redirect";
  if (disposition === "ambiguous-split") return "ambiguous-split";
  return "terminal";
}

/**
 * CHECK 1. Every legacy object id resolves, or is accounted for by name.
 *
 * "Accounted for" means the ledger holds a row whose disposition class matches
 * what the plan decided. A missing row is the serious case: a lookup of that old
 * id answers nothing at all, which reads as "this never existed" rather than
 * "this did not come across, and here is why".
 */
export function checkLegacyIdResolution(
  plan: ProjectionPlan,
  store: MigrationStoreContents
): FaithfulnessCheckResult {
  const findings: FaithfulnessFinding[] = [];
  for (const outcome of plan.outcomes) {
    const disposition = store.aliasDispositionByLegacyId.get(outcome.legacy_object_id);
    if (disposition === undefined) {
      findings.push(
        finding({
          check: "legacy-id-resolution",
          code: "legacy-id-unresolved",
          legacy_object_id: outcome.legacy_object_id
        })
      );
      continue;
    }
    const expected = plannedAliasClass(outcome.alias_target.kind);
    const observed = observedAliasClass(disposition);
    if (expected !== observed) {
      findings.push(
        finding({
          check: "legacy-id-resolution",
          code: "alias-disposition-mismatch",
          legacy_object_id: outcome.legacy_object_id,
          expected_word: expected,
          observed_word: observed
        })
      );
    }
  }
  return {
    check: "legacy-id-resolution",
    ok: findings.length === 0,
    examined: plan.outcomes.length,
    findings
  };
}

/** Where a record of this kind must be found in the new store. */
function storeHoldsRecord(record: ProjectedRecord, store: MigrationStoreContents): boolean {
  const key = record.idempotency_key;
  if (EntityRecordKinds.has(record.record_kind)) return store.entityByKey.has(key);
  if (record.record_kind === "provisional-block") {
    return store.provisionalBlocks.some((block) => block.idempotency_key === key);
  }
  if (store.assertionIdsByKey.has(key)) return true;
  // A retraction of a carried block has no published shape, so it went to the
  // carried file instead of the assertion log. Looked for in both rather than
  // assumed: a retraction that landed in neither is a real loss.
  return store.provisionalRetractions.some((retraction) => retraction.idempotency_key === key);
}

/**
 * CHECK 2. Counts reconcile per record kind, and by identity rather than tally.
 *
 * Every planned record is looked up by its own idempotency key, so a shortfall
 * names the records that are missing instead of reporting that two totals differ
 * by four. Equal totals with the wrong members is a real migration outcome —
 * one record dropped and another written twice — and a count comparison cannot
 * see it.
 */
export function checkRecordCounts(
  plan: ProjectionPlan,
  store: MigrationStoreContents
): FaithfulnessCheckResult {
  const findings: FaithfulnessFinding[] = [];
  const plannedKeys = new Set<string>();
  const missingByKind = new Map<ProjectedRecordKind, number>();

  for (const record of plan.records) {
    plannedKeys.add(record.idempotency_key);
    if (storeHoldsRecord(record, store)) continue;
    const seen = missingByKind.get(record.record_kind) ?? 0;
    missingByKind.set(record.record_kind, seen + 1);
    if (seen < MaxFindingsPerCode) {
      findings.push(
        finding({
          check: "record-counts",
          code: "record-missing",
          record_kind: record.record_kind,
          ...("provenance" in record && typeof record.provenance === "object"
            ? legacyObjectIdOfRecord(record)
            : {})
        })
      );
    }
  }

  // The other direction. A store holding a migration record the plan never
  // called for is a double-write or a stale run, and a plan-driven check that
  // only looked for what it expected would never see it.
  const unplanned =
    countUnplanned(store.entityByKey.keys(), plannedKeys) +
    countUnplanned(store.assertionIdsByKey.keys(), plannedKeys) +
    countUnplanned(
      store.provisionalBlocks.map((block) => block.idempotency_key),
      plannedKeys
    ) +
    countUnplanned(
      store.provisionalRetractions.map((retraction) => retraction.idempotency_key),
      plannedKeys
    );
  if (unplanned > 0) {
    findings.push(
      finding({
        check: "record-counts",
        code: "record-unplanned",
        expected_count: 0,
        observed_count: unplanned
      })
    );
  }

  return { check: "record-counts", ok: findings.length === 0, examined: plan.records.length, findings };
}

function countUnplanned(keys: Iterable<string>, planned: Set<string>): number {
  let count = 0;
  for (const key of keys) if (!planned.has(key)) count += 1;
  return count;
}

function legacyObjectIdOfRecord(record: ProjectedRecord): { legacy_object_id?: string } {
  const provenance = (record as { provenance?: { legacy_object_id?: unknown } }).provenance;
  const id = provenance?.legacy_object_id;
  return typeof id === "string" ? { legacy_object_id: id } : {};
}

/**
 * A deterministic spread across the corpus, not the first N.
 *
 * The plan is ordered by record kind and then by key, so the first N of anything
 * are all the same kind and often all from the same source file. A stride
 * samples the whole range, and taking it from a sorted list makes the same
 * corpus produce the same sample on every run — a verifier whose sample moves
 * cannot be used to confirm that yesterday's difference is gone.
 */
export function sampleEvenly<T>(items: T[], size: number): T[] {
  if (size <= 0 || items.length === 0) return [];
  if (items.length <= size) return [...items];
  const stride = items.length / size;
  const sample: T[] = [];
  for (let index = 0; index < size; index += 1) {
    const item = items[Math.floor(index * stride)];
    if (item !== undefined) sample.push(item);
  }
  return sample;
}

/**
 * CHECK 3. A sample of entities and relationships, field by field.
 *
 * Counts prove arrival, not fidelity: a run that carried every record and put
 * the wrong endpoint on each edge passes every count in this file. So a sample
 * is opened on both sides and compared field by field, including the two
 * endpoint ids, which is where a mis-projection actually shows up.
 *
 * Only the FIELD NAME is reported. Whether the name matched is the finding;
 * what the name was is content.
 */
export function checkSampledFields(
  plan: ProjectionPlan,
  store: MigrationStoreContents,
  sampleSize: number
): FaithfulnessCheckResult {
  const findings: FaithfulnessFinding[] = [];

  // slot -> the entity the store minted for it, so an edge's endpoints can be
  // resolved the same way the apply path resolved them.
  const entityIdBySlot = new Map<string, string>();
  for (const record of plan.records) {
    if (!EntityRecordKinds.has(record.record_kind)) continue;
    const slot = (record as { slot?: string }).slot;
    const entity = store.entityByKey.get(record.idempotency_key);
    if (slot !== undefined && entity) entityIdBySlot.set(slot, entity.entity_id);
  }

  const entityRecords = plan.records
    .filter((record) => EntityRecordKinds.has(record.record_kind))
    .sort((left, right) => (left.idempotency_key < right.idempotency_key ? -1 : 1));
  const relationshipRecords = plan.records
    .filter(
      (record) =>
        record.record_kind === "relationship" || record.record_kind === "minted-relationship"
    )
    .sort((left, right) => (left.idempotency_key < right.idempotency_key ? -1 : 1));

  const entitySample = sampleEvenly(entityRecords, sampleSize);
  const relationshipSample = sampleEvenly(relationshipRecords, sampleSize);

  for (const record of entitySample) {
    const entity = store.entityByKey.get(record.idempotency_key);
    if (!entity) continue; // Already reported by the count check.
    const expected = RegistryTypeByEndpointType[(record as { entity_type: keyof typeof RegistryTypeByEndpointType }).entity_type];
    const name = (record as { name?: string }).name;
    const aliases = (record as { aliases?: string[] }).aliases ?? [];
    const slot = (record as { slot?: string }).slot;

    const mismatch = (field: string, expectedWord?: string, observedWord?: string): void => {
      findings.push(
        finding({
          check: "field-comparison",
          code: "field-mismatch",
          record_kind: record.record_kind,
          object_id: entity.entity_id,
          field,
          ...(slot === undefined ? {} : { slot }),
          ...(expectedWord === undefined ? {} : { expected_word: expectedWord }),
          ...(observedWord === undefined ? {} : { observed_word: observedWord })
        })
      );
    };

    // `type` and `type_label` are closed vocabularies, so both sides may be
    // named. `display_name` and `also_known_as` are compared and NOT named.
    if (entity.type !== expected.type) mismatch("type", expected.type, entity.type);
    if ((entity.type_label ?? undefined) !== expected.type_label) {
      mismatch("type_label", expected.type_label ?? "absent", entity.type_label ?? "absent");
    }
    if (name !== undefined && entity.display_name !== name) mismatch("display_name");
    // Joined on NUL, written as the escape so the file stays a reviewable text
    // diff. A separator that can occur inside an alias would make ["a b"] and
    // ["a", "b"] compare equal, and an alias list silently merged into one
    // string is exactly the kind of difference this check exists to catch.
    const aliasKey = (values: readonly string[]): string => [...values].sort().join("\u0000");
    if (aliasKey(entity.also_known_as) !== aliasKey(aliases)) {
      mismatch("also_known_as");
    }
  }

  const assertionById = new Map(store.assertions.map((assertion) => [assertion.assertion_id, assertion]));
  for (const record of relationshipSample) {
    const assertionIds = store.assertionIdsByKey.get(record.idempotency_key);
    const assertion = assertionIds?.[0] === undefined ? undefined : assertionById.get(assertionIds[0]);
    if (!assertion) continue; // Already reported by the count check.

    const sourceSlot = (record as { source_slot: string }).source_slot;
    const targetSlot = (record as { target_slot: string }).target_slot;
    const predicate = (record as { predicate: string }).predicate;
    const expectedSource = entityIdBySlot.get(sourceSlot);
    const expectedTarget = entityIdBySlot.get(targetSlot);

    if (expectedSource === undefined || expectedTarget === undefined) {
      findings.push(
        finding({
          check: "field-comparison",
          code: "endpoint-unresolved",
          record_kind: record.record_kind,
          object_id: assertion.assertion_id,
          slot: expectedSource === undefined ? sourceSlot : targetSlot
        })
      );
      continue;
    }

    if (assertion.predicate !== predicate) {
      findings.push(
        finding({
          check: "field-comparison",
          code: "field-mismatch",
          record_kind: record.record_kind,
          object_id: assertion.assertion_id,
          field: "predicate",
          expected_word: predicate,
          observed_word: assertion.predicate
        })
      );
    }
    // THE ENDPOINTS. An edge landing on the wrong node is the migration failure
    // with no other symptom: every count is right, every field parses, and the
    // graph says something nobody said.
    if (assertion.subject_entity_id !== expectedSource) {
      findings.push(
        finding({
          check: "field-comparison",
          code: "field-mismatch",
          record_kind: record.record_kind,
          object_id: assertion.assertion_id,
          field: "subject_entity_id",
          slot: sourceSlot
        })
      );
    }
    if (assertion.target_entity_id !== expectedTarget) {
      findings.push(
        finding({
          check: "field-comparison",
          code: "field-mismatch",
          record_kind: record.record_kind,
          object_id: assertion.assertion_id,
          field: "target_entity_id",
          slot: targetSlot
        })
      );
    }
  }

  return {
    check: "field-comparison",
    ok: findings.length === 0,
    examined: entitySample.length + relationshipSample.length,
    findings
  };
}

/**
 * CHECK 4. The carried blocks, by count and by total text length.
 *
 * Length rather than the text, and a TOTAL rather than a per-block list. It is
 * the strongest statement that can be made about 2.5 MB of somebody's private
 * prose without reproducing any of it: a truncation, a dropped block or an
 * encoding change moves the total, and the total names nobody.
 */
export function checkProvisionalBlocks(
  plan: ProjectionPlan,
  store: MigrationStoreContents
): FaithfulnessCheckResult {
  const planned = plan.records.filter((record) => record.record_kind === "provisional-block");
  const expectedLength = planned.reduce(
    (total, record) => total + ((record as { block: { text: string } }).block.text.length ?? 0),
    0
  );
  const observedLength = store.provisionalBlocks.reduce(
    (total, block) => total + ((block.record as { block?: { text?: string } }).block?.text?.length ?? 0),
    0
  );

  const findings: FaithfulnessFinding[] = [];
  if (planned.length !== store.provisionalBlocks.length) {
    findings.push(
      finding({
        check: "provisional-blocks",
        code: "block-count-mismatch",
        expected_count: planned.length,
        observed_count: store.provisionalBlocks.length
      })
    );
  }
  if (expectedLength !== observedLength) {
    findings.push(
      finding({
        check: "provisional-blocks",
        code: "block-text-length-mismatch",
        expected_count: expectedLength,
        observed_count: observedLength
      })
    );
  }

  return {
    check: "provisional-blocks",
    ok: findings.length === 0,
    examined: planned.length,
    findings
  };
}

export type VerifyMigrationInput = {
  plan: ProjectionPlan;
  store_directory: string;
  /** Records of each kind opened field by field. */
  sample_size?: number;
};

export const DefaultSampleSize = 25;

export function verifyMigrationFaithfulness(input: VerifyMigrationInput): MigrationFaithfulnessReport {
  const store = readMigrationStore(input.store_directory);
  const checks = [
    checkLegacyIdResolution(input.plan, store),
    checkRecordCounts(input.plan, store),
    checkSampledFields(input.plan, store, input.sample_size ?? DefaultSampleSize),
    checkProvisionalBlocks(input.plan, store)
  ];

  const all = checks.flatMap((check) => check.findings);
  const kept: FaithfulnessFinding[] = [];
  const seenByCode = new Map<FaithfulnessFindingCode, number>();
  for (const item of all) {
    const seen = seenByCode.get(item.code) ?? 0;
    seenByCode.set(item.code, seen + 1);
    if (seen < MaxFindingsPerCode) kept.push(item);
  }

  return {
    ok: checks.every((check) => check.ok) && store.segment_repairs === 0,
    source_objects: input.plan.outcomes.length,
    segment_repairs: store.segment_repairs,
    checks,
    findings: kept,
    truncated: all.length - kept.length
  };
}

function pad(label: string): string {
  return label.padEnd(26, " ");
}

function renderFinding(item: FaithfulnessFinding): string {
  const parts: string[] = [item.code];
  if (item.record_kind) parts.push(`kind=${item.record_kind}`);
  if (item.field) parts.push(`field=${item.field}`);
  if (item.slot) parts.push(`slot=${item.slot}`);
  if (item.legacy_object_id) parts.push(`legacy=${item.legacy_object_id}`);
  if (item.object_id) parts.push(`object=${item.object_id}`);
  if (item.expected_word !== undefined || item.observed_word !== undefined) {
    parts.push(`expected=${item.expected_word ?? "-"} observed=${item.observed_word ?? "-"}`);
  }
  if (item.expected_count !== undefined || item.observed_count !== undefined) {
    parts.push(`expected=${item.expected_count ?? "-"} observed=${item.observed_count ?? "-"}`);
  }
  return `    ${parts.join(" ")}`;
}

export function renderFaithfulnessReport(report: MigrationFaithfulnessReport): string {
  const lines = [
    "migration faithfulness",
    `  ${pad("verdict")}${report.ok ? "pass" : "FAIL"}`,
    `  ${pad("source objects")}${report.source_objects}`,
    // Printed at zero too. A line that only appears when there is damage is a
    // line nobody learns to look for, and its absence reads as reassurance.
    `  ${pad("log damage")}${report.segment_repairs}`
  ];
  for (const check of report.checks) {
    // `examined` is printed for a passing check too. A check that passed
    // because it looked at nothing is the failure mode a bare "pass" hides.
    lines.push(
      `  ${pad(check.check)}${check.ok ? "pass" : "FAIL"} (examined=${check.examined} findings=${check.findings.length})`
    );
  }
  if (report.findings.length > 0) {
    lines.push("  findings");
    for (const item of report.findings) lines.push(renderFinding(item));
  }
  if (report.truncated > 0) {
    lines.push(`  ${pad("findings withheld")}${report.truncated} (per-code cap ${MaxFindingsPerCode})`);
  }
  return `${lines.join("\n")}\n`;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

/**
 * Rebuilds the old store's plan from the frozen replica, read-only.
 *
 * Identical resolver semantics to the apply path on purpose: a decrypt that
 * FAILED is `unrecoverable` and a payload kind never attempted is `unavailable`.
 * If the verifier classified them differently from the run it is checking, every
 * absence record would look like a difference between the planes.
 */
async function planFromReplica(graphDir: string, keyringPath: string, authorityId: string): Promise<ProjectionPlan> {
  const passphrase = resolveLocalSecret("LIVING_ATLAS_LOCAL_KEYRING_PASSPHRASE");
  if (!passphrase) throw new Error("keyring passphrase not resolvable");
  const keyring = await openLocalKeyring(JSON.parse(readFileSync(keyringPath, "utf8")), passphrase.value);

  const snapshot = JSON.parse(readFileSync(join(graphDir, "snapshot.json"), "utf8")) as {
    objects: GraphObjectEnvelope[];
  };
  const objects = snapshot.objects;

  const resolved = new Map<string, Record<string, unknown>>();
  const failed = new Map<string, string>();
  for (const envelope of objects) {
    if (envelope.payload.kind !== "ciphertext-inline") continue;
    try {
      const payload = await decryptGraphObjectPayload(envelope, keyring);
      if (payload && payload.kind === "plaintext-json") {
        resolved.set(envelope.object_id, payload.data as Record<string, unknown>);
      } else {
        failed.set(envelope.object_id, "decrypt returned no plaintext payload");
      }
    } catch (error) {
      failed.set(envelope.object_id, (error as Error).message.slice(0, 120));
    }
  }

  const resolvePayload = (envelope: GraphObjectEnvelope): LegacyPayloadResolution => {
    if (envelope.payload.kind === "plaintext-json") {
      return { kind: "plaintext", data: envelope.payload.data as Record<string, unknown> };
    }
    const data = resolved.get(envelope.object_id);
    if (data) return { kind: "plaintext", data };
    const detail = failed.get(envelope.object_id);
    if (detail) return { kind: "unrecoverable", detail };
    return { kind: "unavailable", detail: `payload kind ${envelope.payload.kind} not attempted` };
  };

  return buildProjectionPlan(objects, { authority_id: authorityId, resolve_payload: resolvePayload });
}

/**
 * Env contract:
 *   LIVING_ATLAS_LOCAL_GRAPH_DIR       (required) the OLD store: frozen replica
 *   LIVING_ATLAS_LOCAL_KEYRING         (required) sealed keyring file path
 *   LIVING_ATLAS_BACKUP_AUTHORITY_ID   (required) authority id the plan was stamped with
 *   MIGRATION_TARGET_DIR               (required) the NEW store directory
 *   MIGRATION_VERIFY_REPORT_OUT        (optional) where the report is written
 *   MIGRATION_VERIFY_SAMPLE_SIZE       (optional) records per kind opened field by field
 */
async function main(): Promise<void> {
  const graphDir = requireEnv("LIVING_ATLAS_LOCAL_GRAPH_DIR");
  const keyringPath = requireEnv("LIVING_ATLAS_LOCAL_KEYRING");
  const authorityId = requireEnv("LIVING_ATLAS_BACKUP_AUTHORITY_ID");
  const storeDir = requireEnv("MIGRATION_TARGET_DIR");
  const reportOut = process.env.MIGRATION_VERIFY_REPORT_OUT;
  const sampleSize = Number(process.env.MIGRATION_VERIFY_SAMPLE_SIZE ?? DefaultSampleSize);

  if (!isAbsolute(storeDir)) throw new Error("MIGRATION_TARGET_DIR must be an absolute path");
  if (!Number.isFinite(sampleSize) || sampleSize < 0) {
    throw new Error("MIGRATION_VERIFY_SAMPLE_SIZE must be a non-negative number");
  }

  const plan = await planFromReplica(graphDir, keyringPath, authorityId);
  const report = verifyMigrationFaithfulness({
    plan,
    store_directory: storeDir,
    sample_size: sampleSize
  });
  const rendered = renderFaithfulnessReport(report);
  if (reportOut) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(reportOut, rendered, "utf8");
  }
  process.stdout.write(rendered);
  if (!report.ok) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
    process.exit(1);
  });
}
