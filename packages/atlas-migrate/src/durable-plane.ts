import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  truncateSync
} from "node:fs";
import { join } from "node:path";
import type { EndpointType } from "@living-atlas/contracts";
import {
  DurableAssertionLog,
  DurableEntityRegistry,
  LocalPrivateDirectoryMode,
  LocalPrivateFileMode,
  digestOf,
  scanIdentityLog,
  scanSegmentLog,
  splitLines,
  writeAllSync,
  type AssertionDraft,
  type AssertionId,
  type EntityId,
  type EntityType,
  type TerminalDisposition,
  type WorldTimePoint
} from "@living-atlas/atlas-core";
import {
  AliasBasis,
  type AliasLedger,
  type AliasLedgerRow,
  type AliasLedgerTarget,
  type AssertionMintRequest,
  type CommitReceipt,
  type CommitRequest,
  type EntityMintRequest,
  type EntityRegistry,
  type MigrationApplyAudit,
  type MigrationAuditSink,
  type TargetPlaneSink
} from "./apply.js";
import { MigrationRefusalReasonSchema } from "./legacy-source.js";
import { SourceDispositionKindSchema, type SourceDispositionKind } from "./projection.js";
import {
  MigrationOrigin,
  MigrationRecordedAtFidelity,
  isLegacyObjectProvenance,
  isUnmodelledRecord,
  type MigrationIdempotencyKey,
  type ProjectedProvenance,
  type ProjectedRecord,
  type ProjectedRecordKind,
  type WorldTimeFidelity
} from "./target-plane.js";

/**
 * The migration's four ports, bound to the real durable core.
 *
 * `in-memory-plane.ts` is the reference implementation and it is what every
 * apply test used until now. That is precisely why this file exists: an
 * in-memory plane accepts any id shape, any timestamp and any sequence number,
 * so a projection could satisfy it completely while being unable to write a
 * single record into the store it is about to be pointed at. Everything below
 * is a place the two planes disagree, and each disagreement was a defect the
 * in-memory plane could not see.
 *
 * ATLAS-CORE WINS ON TIME AND SEQUENCE. `CommitRequest.recorded_at` and
 * `CommitRequest.seq` arrive from the planner and are IGNORED here. The
 * assertion log stamps `recorded_at` at commit and allocates `seq` itself, and
 * a migration that overrode either would reintroduce the exact defect the log
 * exists to prevent: belief time that a caller chose, and a change-feed position
 * that is not the store's own. The planned values stay in the request as
 * provenance about what the plan intended, and nothing durable is derived from
 * them.
 *
 * That is worth stating rather than leaving to be discovered, because
 * `applyProjectionPlan` accepts both fields and a reader can reasonably assume
 * they are honoured. They are not. A field that looks authoritative and is
 * decorative is how the next person builds on a guarantee that was never there.
 */

/**
 * The migration's identity to the store, and a CONSTANT.
 *
 * `client_id` and `idempotency_key` together are the assertion log's replay
 * key, so anything run-scoped or version-scoped here — a timestamp, a run id, a
 * package version — would make a resume miss every receipt the first run wrote
 * and commit a second copy of the entire corpus. The migration is one logical
 * writer across however many attempts it takes.
 */
export const MigrationClientId = "la_client_atlas_migrate" as const;

/**
 * The predicate an entity's legacy tombstone is recorded under.
 *
 * An entity is never deleted — that is the registry's whole promise — so a
 * legacy tombstone over an entity cannot be a retraction of anything. It is a
 * fact about the legacy record, asserted about the entity that record became.
 */
export const LegacyTombstonePredicate = "legacy-record-tombstoned" as const;

/**
 * Confidence on every imported assertion, stated once.
 *
 * Deliberately not `high`. Confidence is about the CLAIM, and a mechanical
 * import evaluated no claim: it read a row out of a store that predates the
 * assertion contract and carried it across. `high` would put the migration's
 * name behind assertions nobody assessed, which is the provenance failure the
 * whole rewrite exists to end.
 */
export const MigrationConfidence = {
  band: "medium",
  rationale: "carried from the pre-contract store; the migration evaluated no claim"
} as const;

/** Segment directories and the audit file, under the target root. */
export const MigrationAssertionLogDirectoryName = "assertions" as const;
export const MigrationIdentityLogDirectoryName = "identity" as const;
export const MigrationAuditFileName = "migration-apply.jsonl" as const;
/**
 * Where a record whose modelling is deferred is carried (ADR 0029).
 *
 * A FILE OF ITS OWN, beside the two logs rather than inside either. The
 * assertion log serialises `atlas.assertion:v1` and the identity log
 * `atlas.entity:v1`, both RELEASED and both uneditable; writing a provisional
 * block through either would freeze by accident the shape the deferral exists to
 * keep unfrozen. It is also not `absence`: an absence says content did NOT come
 * across, and this says content came across whole and unmodelled -- opposite
 * facts that must not share a count.
 *
 * The name says `provisional` so nobody mistakes it for a log the consumer
 * contract knows about, and the `.jsonl` so an operator can read it with the
 * tools already on the machine.
 */
export const MigrationProvisionalFileName = "provisional-blocks.jsonl" as const;
/**
 * The prefix a carried record's durable id takes.
 *
 * Deliberately NOT `la_entity_` or `la_assertion_`: `redirectRecordKindOf` reads
 * those two prefixes to recover what an alias redirect points at, and an id that
 * collided with either would let a carried record be read back as a record kind
 * it is not. It is also what tells `commitRetraction` that a tombstone names
 * something the published log does not hold.
 */
export const ProvisionalRecordIdPrefix = "la_provisional_" as const;

/**
 * What `mintAssertion` returns, and why it is not an assertion id.
 *
 * The port allocates an id BEFORE the record is resolved and written.
 * atlas-core cannot: `AssertionLog.commit` mints the id at commit, from a fully
 * resolved draft, because an id handed out before the bytes are durable is an
 * id that can be minted again for something else. So the adapter defers, and
 * the durable id is the one the receipt carries.
 *
 * The token is shaped so it CANNOT pass `AssertionIdSchema`. If a future change
 * ever let it reach a durable field, zod refuses the write instead of persisting
 * a plausible-looking id that resolves to nothing — a structural guarantee
 * rather than a promise that this file keeps its word.
 */
export const DeferredAssertionIdPrefix = "deferred-to-commit:" as const;

/**
 * How an endpoint type is expressed in the registry's own type vocabulary.
 *
 * Five of the eight have a member that means exactly them. The other three do
 * not, and they take the reserved `other` plus a label naming what they are —
 * which is what `other` is FOR. Mapping `project` onto `concept` because both
 * are abstract, or onto `event` because both have dates, would file three
 * distinct kinds of thing under words that already mean something else, and no
 * consumer could tell afterwards which it had.
 *
 * A total `Record` so a ninth endpoint type fails to compile until somebody
 * decides how it is expressed, rather than falling through to a default.
 */
export const RegistryTypeByEndpointType: Record<
  EndpointType,
  { type: EntityType; type_label?: string }
> = {
  person: { type: "person" },
  organization: { type: "organization" },
  location: { type: "place" },
  occurrence: { type: "event" },
  topic: { type: "concept" },
  project: { type: "other", type_label: "project" },
  offering: { type: "other", type_label: "offering" },
  item: { type: "other", type_label: "item" }
};

/**
 * The ledger disposition each source disposition becomes when a legacy id
 * carried nothing across.
 *
 * Three of them map onto a disposition that says the same thing the plan says.
 * The four `projected-as-*` rows do not: a `no-target` row for an object the
 * plan says DID project means the record it should have redirected to was not
 * committed, which is an integrity failure rather than a decision. `other`
 * carries it, and `resolve()` answers with the detail — "not carried forward,
 * disposition other, and here is what went wrong" — instead of `never-migrated`,
 * which would claim the migration chose to drop it.
 *
 * Total over the source vocabulary, so a new source disposition fails to compile
 * until somebody decides what an unresolvable id should be told.
 */
export const TerminalDispositionBySourceDisposition: Record<
  SourceDispositionKind,
  TerminalDisposition
> = {
  "unrecoverable-ciphertext": "content-unrecoverable",
  "redaction-stub": "redacted-in-place",
  refused: "never-migrated",
  "projected-as-entity": "other",
  "projected-as-relationship": "other",
  "projected-as-retraction": "other",
  "projected-as-alias-redirect": "other",
  // A provisional block never had a redirect to lose: the published ledger has
  // no disposition that can name an unmodelled record, so the projector plans a
  // terminal row for it in the first place (see `projection.ts`). `other` is
  // what that row says, and the detail says the rest.
  "projected-as-provisional": "other",
  other: "other"
};

/**
 * The record kind an alias redirect names, recovered from the id it points at.
 *
 * The migration's ledger row carries a `record_kind` that atlas-core's row has
 * no field for, and `applyProjectionPlan` compares a re-read row against the
 * planned one to detect a conflict — so a row that cannot be read back exactly
 * would report a phantom conflict on every resume. Today the projector points a
 * redirect at exactly two kinds of record and each mints a differently-prefixed
 * id, so the recovery is exact.
 *
 * `appendAliasRow` checks the round trip on every write. If the projector ever
 * points a redirect at a third kind, the migration refuses at the append rather
 * than writing a row that reads back as one of these two.
 */
export const RedirectRecordKindByIdPrefix: Record<string, ProjectedRecordKind> = {
  la_entity_: "entity",
  la_assertion_: "relationship"
};

function redirectRecordKindOf(objectId: string): ProjectedRecordKind | undefined {
  for (const [prefix, recordKind] of Object.entries(RedirectRecordKindByIdPrefix)) {
    if (objectId.startsWith(prefix)) return recordKind;
  }
  return undefined;
}

/**
 * World time, carried at the fidelity the legacy value actually had.
 *
 * `unknown` becomes the point that matches no interval query rather than a
 * date. The old store mapped unknown onto the literal string "9999", so an
 * unknown start sorted to the far future and satisfied every "before X" filter;
 * nothing here may turn an absence of knowledge into a large number.
 */
export function migrationWorldTimePoint(value: string, fidelity: WorldTimeFidelity): WorldTimePoint {
  if (fidelity === "unknown" || value === "unknown") return { kind: "unknown" };
  const bare = value.startsWith("~") ? value.slice(1) : value;
  return { kind: fidelity === "approximate" ? "approximate" : "exact", value: bare };
}

/**
 * Everything the legacy row said that the assertion spine has no field for.
 *
 * The spine holds subject, predicate, target and the two world-time bounds. A
 * legacy edge also carried a status, its own attributes, and a provenance
 * envelope naming the version, content hash and access class it was read at.
 * None of that has a home on `Assertion`, and dropping it would make the import
 * lossy in exactly the places an auditor later needs — so it rides in `value`,
 * verbatim.
 *
 * This does put provenance inside the `claim_digest`, which is otherwise a
 * contradiction key over the claim core alone. That is accepted rather than
 * overlooked: an imported record already carries
 * `recorded_at_fidelity: "import-artifact"`, and the store reports a page that
 * mixes fidelities precisely because comparing an import against an authored
 * claim is not meaningful. Losing the evidence to protect a comparison nobody
 * can make would be the wrong trade.
 */
export function migrationAssertionValue(input: {
  provenance: ProjectedProvenance;
  status?: string;
  attrs?: Record<string, unknown>;
  detail?: string;
}): Record<string, unknown> {
  return {
    legacy: input.provenance,
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.attrs && Object.keys(input.attrs).length > 0 ? { attrs: input.attrs } : {}),
    ...(input.detail === undefined ? {} : { detail: input.detail })
  };
}

/**
 * The one evidence link an imported assertion can honestly carry.
 *
 * `AssertionDraftSchema` requires at least one, and a migration has exactly one
 * thing to offer: the legacy object it read. Minting a plausible-looking
 * evidence record per assertion would be fabricated provenance at corpus scale,
 * in the layer attribution depends on. A node the migration minted has no
 * legacy object at all, so it points at the authority instead of inventing one.
 */
function migrationEvidence(provenance: ProjectedProvenance, authorityId: string) {
  return [
    {
      evidence_id: isLegacyObjectProvenance(provenance)
        ? provenance.legacy_object_id
        : `${authorityId}:derived:${provenance.legacy_attribute}`,
      stance: "supports" as const
    }
  ];
}

/**
 * Legacy bookkeeping time, carried where it cannot be mistaken for a time axis.
 *
 * `proposed_at` is documented as advisory and explicitly not an axis, which is
 * the only correct home for a value that says when the OLD store last touched a
 * row. Putting it in `valid_from` would claim the world changed then; putting it
 * in `recorded_at` would claim Atlas learned it then.
 */
function legacyProposedAt(provenance: ProjectedProvenance): string | undefined {
  return isLegacyObjectProvenance(provenance) ? provenance.legacy_updated_at : undefined;
}

function migrationBasis(provenance: ProjectedProvenance): string {
  return isLegacyObjectProvenance(provenance)
    ? `pre-contract-import ${provenance.legacy_object_id} v${provenance.legacy_version}`
    : `pre-contract-import derived from ${provenance.legacy_attribute}`;
}

/**
 * The no-target ledger reason, written so it reads as a sentence AND parses
 * back exactly.
 *
 * `applyProjectionPlan` decides a run has conflicted by comparing a re-read
 * alias target against the planned one, so a row this adapter writes must read
 * back byte-identical or every resume reports a conflict over rows it wrote
 * itself. atlas-core's row has one free-text `reason` and no structured field,
 * so the three parts live in it, separated by tokens neither closed enum can
 * contain: the disposition and the optional refusal reason are kebab-case enum
 * members, and everything after the first `": "` is the detail, verbatim.
 *
 * A row that does NOT parse is not normalised into one that does — it is
 * returned as-is and reported as a conflict, which is the right answer for a
 * row this migration did not write.
 */
export function encodeNoTargetReason(target: Extract<AliasLedgerTarget, { kind: "no-target" }>): string {
  const head = target.reason ? `${target.disposition}/${target.reason}` : target.disposition;
  return `${head}: ${target.detail}`;
}

export function decodeNoTargetReason(reason: string): Extract<AliasLedgerTarget, { kind: "no-target" }> | undefined {
  const separator = reason.indexOf(": ");
  if (separator < 0) return undefined;
  const head = reason.slice(0, separator);
  const detail = reason.slice(separator + 2);
  const [dispositionWord, reasonWord, ...rest] = head.split("/");
  if (rest.length > 0) return undefined;
  const disposition = SourceDispositionKindSchema.safeParse(dispositionWord);
  if (!disposition.success) return undefined;
  if (reasonWord === undefined) {
    return { kind: "no-target", disposition: disposition.data, detail };
  }
  const refusal = MigrationRefusalReasonSchema.safeParse(reasonWord);
  if (!refusal.success) return undefined;
  // Key order matches `plannedAliasTarget` exactly. The comparison in
  // `applyProjectionPlan` is `JSON.stringify` on both sides, so a reconstruction
  // that carried the same fields in a different order would be reported as a
  // conflict with itself.
  return { kind: "no-target", disposition: disposition.data, reason: refusal.data, detail };
}

/**
 * WHAT AN ENTITY RECORD CARRIES THAT THE REGISTRY HAS NO FIELD FOR — counted,
 * on every run, because a deferral nobody can see is indistinguishable from a
 * loss nobody noticed.
 *
 * `atlas.entity:v1` is identity and names: type, `type_label`, `display_name`,
 * `also_known_as`, provenance, sensitivity. Everything else Atlas believes about
 * an entity is an ASSERTION. So a projected entity record's `attrs`
 * (`founded_year`, `geo`, `timezone`, `homepage_ref`, `occurred_on`), its
 * `description`, its occurrence `entity_subtype` and its `topic_scheme` have no
 * slot on the entity — and the reconciliation this run is measured against says
 * an entity record produces exactly one entity and no assertion.
 *
 * This adapter therefore does NOT carry them, and it does not invent an
 * assertion shape to hold them either: what predicate an imported
 * `founded_year` becomes is a modelling decision, and inventing one here would
 * publish a shape by accident in the same move that ADR 0027 was cut to avoid.
 *
 * The deferral is structural rather than aspirational, on the terms the owner
 * set for the unmodelled Logseq blocks:
 *  - NOTHING IS LOST. The replica is frozen and never written after the freeze,
 *    so every value counted here is still readable at its source.
 *  - IT IS VISIBLE. This number is printed by `real-data:migration-apply` on
 *    every run, zero or not, so it cannot decay into silence.
 *  - AN ADR STATES IT. See ADR 0030, which also names what a later modelling
 *    pass has to decide.
 */
export type DeferredEntityContent = {
  entity_records: number;
  with_attributes: number;
  with_a_description: number;
  with_a_subtype: number;
  with_a_topic_scheme: number;
  /** Distinct attribute KEYS only. The values are graph content and stay out. */
  attribute_keys: string[];
};

export function countDeferredEntityContent(records: readonly ProjectedRecord[]): DeferredEntityContent {
  const attributeKeys = new Set<string>();
  let entityRecords = 0;
  let withAttributes = 0;
  let withDescription = 0;
  let withSubtype = 0;
  let withTopicScheme = 0;

  for (const record of records) {
    if (record.record_kind !== "entity" && record.record_kind !== "minted-entity") continue;
    entityRecords += 1;
    if ("attrs" in record) {
      const keys = Object.keys(record.attrs);
      if (keys.length > 0) {
        withAttributes += 1;
        for (const key of keys) attributeKeys.add(key);
      }
    }
    if ("description" in record && record.description !== undefined) withDescription += 1;
    if ("entity_subtype" in record && record.entity_subtype !== undefined) withSubtype += 1;
    if (record.topic_scheme !== undefined) withTopicScheme += 1;
  }

  return {
    entity_records: entityRecords,
    with_attributes: withAttributes,
    with_a_description: withDescription,
    with_a_subtype: withSubtype,
    with_a_topic_scheme: withTopicScheme,
    attribute_keys: [...attributeKeys].sort()
  };
}

export type DurableMigrationPlaneOptions = {
  /**
   * The target root. The two logs live in named subdirectories of it and the
   * audit file beside them, so one path names the whole new store and the
   * caller cannot wire the identity log at the assertion log's directory —
   * which the identity reader refuses at load, but only after the damage.
   */
  directory: string;
  clock?: () => Date;
};

/**
 * What the target root holds, counted by RE-READING the segment files.
 *
 * Never from the counters the run kept: a reconciliation computed from the
 * process's own bookkeeping proves that the process is self-consistent, which is
 * the one thing it is guaranteed to be. Compaction in this repo already reasons
 * about the bytes that exist rather than about what the writer believes it
 * wrote, and a migration's final tally has the same standard to meet.
 */
export type MigrationPlaneCensus = {
  entities: number;
  assertions: number;
  alias_rows: number;
  /**
   * Submissions naming no assertion — one per absence record. An absence
   * reports that an object existed and did not come across, so it must produce
   * no assertion and no entity; the receipt is how the run proves it saw the
   * record and deliberately wrote nothing, instead of proving it by silence.
   */
  empty_submissions: number;
  /**
   * Records carried with their modelling deferred (ADR 0029). Counted like
   * everything else here -- by re-reading the file -- because a deferral that
   * only the writer's own counter can see is the silence the owner was warned
   * about, wearing a number.
   */
  provisional_blocks: number;
  /**
   * Retractions of carried records. Counted apart from `assertions` because
   * that is where they would otherwise have gone: a deleted block's tombstone
   * has no published shape to live in, so it lands beside the block, and folding
   * the two counts together would hide a retraction that went to the wrong file.
   */
  provisional_retractions: number;
};

export function migrationPlaneDirectories(directory: string): {
  assertions: string;
  identity: string;
  audit: string;
  provisional: string;
} {
  return {
    assertions: join(directory, MigrationAssertionLogDirectoryName),
    identity: join(directory, MigrationIdentityLogDirectoryName),
    audit: join(directory, MigrationAuditFileName),
    provisional: join(directory, MigrationProvisionalFileName)
  };
}

/**
 * One carried block, as it sits on disk.
 *
 * The whole projected record is stored, not a summary of it: the point of the
 * carry-over is that a later modelling pass reads what the source held without
 * going back to a replica that may by then be gone.
 */
export type ProvisionalBlockLine = {
  idempotency_key: string;
  object_id: string;
  recorded_at: string;
  record: ProjectedRecord;
};

/**
 * Bytes at the end of the carried file that no newline closed.
 *
 * Shaped like atlas-core's `RepairNote` — byte count and digest — for the reason
 * that type gives: a digest is how a human confirms WHICH bytes were dropped
 * against a backup, and two files computing it two ways would make that
 * comparison useless.
 */
export type ProvisionalTailRepair = {
  reason: "torn-tail";
  discarded_bytes: number;
  discarded_digest: string;
};

export type ProvisionalBlockFileContents = {
  lines: ProvisionalBlockLine[];
  /** Present only when the final line was torn. */
  repair?: ProvisionalTailRepair;
};

/**
 * Every carried block, re-read from the file, under the SEGMENT LOG'S TAIL RULE.
 *
 * A malformed COMPLETE line throws, exactly as before: a line the writer closed
 * with a newline was fsynced before anything followed it, so damage there is
 * corruption or tampering and a reader that shrugged at it would turn a corrupt
 * carry-over into a smaller carry-over.
 *
 * A TORN FINAL LINE is different, and this file used to throw on it too. That
 * was the one damage a crash can actually cause here — the process died between
 * `writeAllSync` and `fsyncSync`, or the disk filled mid-record — and throwing on
 * it made the store unopenable and the migration unresumable: the census could
 * not count, the plane could not construct, so the operator could neither finish
 * the run nor find out what it had done. atlas-core states the rule the other
 * way round for exactly this reason: "Damage is only ever repaired where damage
 * is POSSIBLE — the tail of the final segment." The file that takes the
 * overwhelming majority of the writes now follows it.
 *
 * Tolerating is not forgetting. The torn bytes come back as a `repair` note, the
 * writer records it durably before it appends anything, and the read-only
 * verifier counts it as damage — so the tear is evidence rather than silence.
 *
 * `repair: true` TRUNCATES, and only a writer passes it. Leaving the torn bytes
 * in place would weld them into the middle of the file the moment the next
 * append lands past them, turning a repairable tail into permanent mid-file
 * corruption; every read-only caller leaves the evidence exactly where it is.
 */
export function readProvisionalBlockFile(
  directory: string,
  options: { repair?: boolean } = {}
): ProvisionalBlockFileContents {
  const path = migrationPlaneDirectories(directory).provisional;
  if (!existsSync(path)) return { lines: [] };
  const raw = readFileSync(path);
  // Split on the byte rather than on a decoded string: a write that died partway
  // through a multi-byte character decodes to a replacement character, and the
  // torn bytes then look like a legitimate — if strange — line.
  const split = splitLines(raw);

  const lines: ProvisionalBlockLine[] = [];
  for (const [index, line] of split.complete.toString("utf8").split("\n").entries()) {
    if (line.trim() === "") continue;
    try {
      lines.push(JSON.parse(line) as ProvisionalBlockLine);
    } catch (cause) {
      throw new Error(
        `${MigrationProvisionalFileName} line ${index + 1} is not readable JSON; the carried blocks ` +
          "cannot be counted, and a partial count would be reported as records that never arrived",
        { cause }
      );
    }
  }

  if (split.torn.length === 0) return { lines };
  const repair: ProvisionalTailRepair = {
    reason: "torn-tail",
    discarded_bytes: split.torn.length,
    discarded_digest: digestOf(split.torn)
  };
  if (options.repair === true) truncateSync(path, split.complete.length);
  return { lines, repair };
}

/** The carried blocks alone, read-only: nothing is repaired by asking. */
export function readProvisionalBlockLines(directory: string): ProvisionalBlockLine[] {
  return readProvisionalBlockFile(directory).lines;
}

export function readMigrationPlaneCensus(directory: string): MigrationPlaneCensus {
  const paths = migrationPlaneDirectories(directory);
  const identity = scanIdentityLog(paths.identity);
  const assertions = scanSegmentLog(paths.assertions);
  const provisional = readProvisionalBlockLines(directory);
  let emptySubmissions = 0;
  for (const receipt of assertions.restored.submissions.values()) {
    if (receipt.assertion_ids.length === 0) emptySubmissions += 1;
  }
  return {
    entities: identity.restored.entities.length,
    assertions: assertions.restored.assertions.length,
    alias_rows: identity.restored.rows.length,
    empty_submissions: emptySubmissions,
    provisional_blocks: provisional.filter((line) => isUnmodelledRecord(line.record)).length,
    provisional_retractions: provisional.filter((line) => line.record.record_kind === "retraction").length
  };
}

export type DurableMigrationPlane = {
  registry: EntityRegistry;
  alias_ledger: AliasLedger;
  sink: TargetPlaneSink;
  audit: MigrationAuditSink;
  directory: string;
  /**
   * Damage this plane found in the carried file and truncated on the way in.
   *
   * Surfaced to the caller as well as written durably, because the operator
   * reading the apply report is the person who has to decide whether the
   * discarded bytes matter, and a note only the file knows about is a note
   * nobody reads.
   */
  repairs: ProvisionalTailRepair[];
  /** Counts read back off the segment files, after the run. */
  census(): MigrationPlaneCensus;
  close(): void;
};

/**
 * The event a truncated tail leaves behind.
 *
 * A separate schema from the apply audit rather than a field on it: this is
 * written at construction, before the run has done anything, and folding it into
 * the one-per-run apply event would mean a run that died before its audit event
 * lost the record of the repair as well.
 */
export const MigrationProvisionalRepairSchemaName =
  "living-atlas-migration-provisional-repair:v1" as const;

export type MigrationProvisionalRepairEvent = ProvisionalTailRepair & {
  event_schema: typeof MigrationProvisionalRepairSchemaName;
  authority_id: string;
  recorded_at: string;
};

/**
 * A directory this store owns, at owner-only permissions.
 *
 * `mkdirSync` applies its `mode` only to directories it CREATES, so a store root
 * that already exists keeps whatever bits it was made with — which is how the
 * two log directories landed at 0755 while `SegmentWriter` was passing 0700 into
 * a `mkdirSync` that had nothing left to create. An existing directory is
 * therefore tightened rather than trusted.
 */
function ensureLocalPrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: LocalPrivateDirectoryMode });
  const mode = statSync(path).mode & 0o777;
  if ((mode & ~LocalPrivateDirectoryMode) !== 0) chmodSync(path, LocalPrivateDirectoryMode);
}

/**
 * Append one line to a sidecar file, owner-only, and return once it is durable.
 *
 * The mode argument matters on CREATION only, so an existing file is tightened
 * the same way a directory is: these two files carry the owner's outline prose
 * and the run's audit trail, and a store where every segment is 0600 and the
 * most content-bearing file is 0644 is not a local-private store.
 */
function appendLocalPrivateLine(path: string, line: string): void {
  const handle = openSync(path, "a", LocalPrivateFileMode);
  try {
    const mode = statSync(path).mode & 0o777;
    if ((mode & ~LocalPrivateFileMode) !== 0) chmodSync(path, LocalPrivateFileMode);
    writeAllSync(handle, line);
    // fsync before the caller is told anything: a receipt is a statement that
    // the bytes are on disk, not that they are in a buffer.
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}

class MigrationPlane {
  private readonly log: DurableAssertionLog;
  private readonly identity: DurableEntityRegistry;
  private readonly root: string;
  private readonly auditPath: string;
  private readonly provisionalPath: string;
  private readonly now: () => Date;
  private readonly authorityId: string;
  /**
   * Migration idempotency key -> the receipt that key's carried block already
   * has. Rebuilt from the file in the constructor, never from a sidecar, for the
   * same reason `entityByKey` is rebuilt from the identity log: a second copy of
   * a fact is a thing that can disagree with it.
   */
  private readonly provisionalByKey = new Map<string, CommitReceipt>();
  /** Migration idempotency key -> the entity that key already minted. */
  private readonly entityByKey = new Map<string, { entity_id: EntityId; registered_at: string }>();
  /**
   * Only makes the deferred handle unique within a run. Nothing durable is
   * derived from it — see `DeferredAssertionIdPrefix`.
   */
  private deferredAssertions = 0;
  private closed = false;
  /** Torn tails this plane truncated on the way in. Empty on a healthy store. */
  readonly repairs: ProvisionalTailRepair[] = [];

  constructor(options: DurableMigrationPlaneOptions & { authority_id: string }) {
    const paths = migrationPlaneDirectories(options.directory);
    // The ROOT too, and at 0700 like everything under it. The two logs were
    // created here without a mode and landed at 0755, which made
    // `SegmentWriter`'s own 0700 a no-op: `mkdirSync` does not chmod a directory
    // that already exists.
    ensureLocalPrivateDirectory(options.directory);
    ensureLocalPrivateDirectory(paths.assertions);
    ensureLocalPrivateDirectory(paths.identity);
    this.root = options.directory;
    this.authorityId = options.authority_id;
    this.auditPath = paths.audit;
    this.provisionalPath = paths.provisional;
    this.now = options.clock ?? (() => new Date());
    this.log = DurableAssertionLog.open({
      directory: paths.assertions,
      ...(options.clock ? { clock: options.clock } : {})
    });
    this.identity = DurableEntityRegistry.open({
      directory: paths.identity,
      ...(options.clock ? { clock: options.clock } : {})
    });

    // Entity resumability, rebuilt from the identity log rather than from a
    // sidecar. A file beside the log recording "key K became entity E" is a
    // second copy of a fact the log already holds, and a second copy is a thing
    // that can disagree — including by being deleted while the entities it
    // named survive, at which point the resume mints every one of them again.
    for (const entity of scanIdentityLog(paths.identity).restored.entities) {
      const key = entity.provenance.basis;
      if (key === undefined || entity.provenance.client_id !== MigrationClientId) continue;
      const existing = this.entityByKey.get(key);
      if (existing && existing.entity_id !== entity.entity_id) {
        throw new Error(
          `identity log holds two entities for migration key ${key} (${existing.entity_id} and ` +
            `${entity.entity_id}); one legacy record minted two identities and a resume cannot ` +
            "choose between them"
        );
      }
      this.entityByKey.set(key, { entity_id: entity.entity_id, registered_at: entity.registered_at });
    }

    // Block resumability, rebuilt from the carried file for the same reason.
    // Without it a resumed run appends every block a second time and the
    // reconciliation reports more records than the source ever held.
    //
    // `repair: true` because this IS the writer. A torn tail left in place would
    // be welded into the middle of the file by the first append of this run;
    // truncating it here is what keeps the damage confined to the tail, where a
    // crash can put it. The note is written durably before any record is, so a
    // run that dies immediately afterwards still leaves the evidence.
    const carried = readProvisionalBlockFile(options.directory, { repair: true });
    if (carried.repair) {
      this.repairs.push(carried.repair);
      const event: MigrationProvisionalRepairEvent = {
        event_schema: MigrationProvisionalRepairSchemaName,
        authority_id: this.authorityId,
        recorded_at: this.now().toISOString(),
        ...carried.repair
      };
      appendLocalPrivateLine(this.auditPath, `${JSON.stringify(event)}\n`);
    }
    for (const line of carried.lines) {
      const existing = this.provisionalByKey.get(line.idempotency_key);
      if (existing && existing.object_id !== line.object_id) {
        throw new Error(
          `${MigrationProvisionalFileName} holds two carried blocks for migration key ` +
            `${line.idempotency_key} (${existing.object_id} and ${line.object_id}); a resume cannot ` +
            "choose between them"
        );
      }
      this.provisionalByKey.set(line.idempotency_key, {
        idempotency_key: line.idempotency_key as MigrationIdempotencyKey,
        object_id: line.object_id,
        recorded_at: line.recorded_at,
        seq: 0
      });
    }
  }

  // -------------------------------------------------------------------------
  // EntityRegistry
  // -------------------------------------------------------------------------

  async mintEntity(request: EntityMintRequest): Promise<{ entity_id: string }> {
    const registryType = RegistryTypeByEndpointType[request.entity_type];
    const entity = this.identity.registry.register(
      {
        type: registryType.type,
        ...(registryType.type_label ? { type_label: registryType.type_label } : {}),
        display_name: request.name,
        also_known_as: [...request.aliases],
        // THE RESUME HANDLE. `basis` carries the migration's idempotency key, so
        // the question "did this record already mint an entity?" is answered by
        // the identity log itself. The alternative — a sidecar map — is a file
        // that can be lost or copied out of step with the log it describes,
        // and losing it means minting the whole corpus a second time.
        basis: request.idempotency_key,
        ...(request.provenance && isLegacyObjectProvenance(request.provenance)
          ? { proposed_at: request.provenance.legacy_updated_at }
          : {})
      },
      {
        client_id: MigrationClientId,
        origin: MigrationOrigin,
        recorded_at_fidelity: MigrationRecordedAtFidelity
      }
    );
    this.entityByKey.set(request.idempotency_key, {
      entity_id: entity.entity_id,
      registered_at: entity.registered_at
    });
    return { entity_id: entity.entity_id };
  }

  async mintAssertion(_request: AssertionMintRequest): Promise<{ assertion_id: string }> {
    // See `DeferredAssertionIdPrefix`. The durable id comes back on the receipt.
    this.deferredAssertions += 1;
    return { assertion_id: `${DeferredAssertionIdPrefix}${this.deferredAssertions}` };
  }

  // -------------------------------------------------------------------------
  // TargetPlaneSink
  // -------------------------------------------------------------------------

  async receiptFor(idempotencyKey: MigrationIdempotencyKey): Promise<CommitReceipt | undefined> {
    const submission = this.log.log.readSubmission(MigrationClientId, idempotencyKey);
    if (submission) {
      const assertionId = submission.assertion_ids[0];
      const assertion = assertionId === undefined ? undefined : this.log.read(assertionId);
      return {
        idempotency_key: idempotencyKey,
        // A submission naming no assertion is an absence record. Its object id
        // is the submission that recorded it: a real, durable id naming exactly
        // what happened, rather than an empty string standing in for a record
        // that was never meant to exist. Nothing resolves through it — the
        // projector never points an alias or a retraction at an absence.
        object_id: assertionId ?? submission.submission_id,
        recorded_at: submission.committed_at,
        seq: assertion?.seq ?? 0
      };
    }

    const entity = this.entityByKey.get(idempotencyKey);
    if (entity) {
      return {
        idempotency_key: idempotencyKey,
        object_id: entity.entity_id,
        recorded_at: entity.registered_at,
        // Identity is not on the assertion change feed: it is never reclaimed,
        // so there is no watermark and no position to publish. Zero says "this
        // record produced no assertion" and cannot be mistaken for one, because
        // an assertion's seq is always positive.
        seq: 0
      };
    }

    // Checked last, and it must be checked: a carried block leaves no submission
    // and no entity, so without this every resumed run re-appends the lot.
    const provisional = this.provisionalByKey.get(idempotencyKey);
    if (provisional) return { ...provisional, idempotency_key: idempotencyKey };

    return undefined;
  }

  async commit(request: CommitRequest): Promise<CommitReceipt> {
    switch (request.resolved.record_kind) {
      case "entity":
        return this.commitEntity(request);
      case "relationship":
        return this.commitRelationship(request, request.resolved);
      case "retraction":
        return this.commitRetraction(request, request.resolved);
      case "absence":
        return this.commitAbsence(request);
      case "provisional-block":
        return this.commitProvisionalBlock(request);
    }
  }

  /**
   * Carries a record whose modelling is deferred, into a file the consumer
   * contract does not know about (ADR 0029).
   *
   * IT MUST NOT REACH `commitDrafts`. That writes `atlas.assertion:v1`, a
   * released and uneditable shape, and mapping an unmodelled record onto it
   * would freeze the shape this deferral exists to keep unfrozen. The guard is
   * `UnmodelledRecordKinds` rather than a comment, so a second deferred kind
   * added later is refused here instead of quietly taking the assertion path.
   */
  private commitProvisionalBlock(request: CommitRequest): CommitReceipt {
    const record = request.record;
    if (!isUnmodelledRecord(record)) {
      throw new Error(
        `commit resolved ${record.record_kind} as a provisional block; the resolution and the ` +
          "record must agree about what is being written"
      );
    }
    return this.commitProvisional(request);
  }

  /**
   * Appends one line to the carried file: a block, or the retraction of one.
   *
   * Both go here for the same reason -- neither has a published shape that can
   * hold it -- and they are told apart on the way out by `record.record_kind`
   * rather than by a second file, so a reader cannot see one and miss the other.
   */
  private commitProvisional(request: CommitRequest): CommitReceipt {
    const record = request.record;
    const existing = this.provisionalByKey.get(request.idempotency_key);
    // A replayed key returns the receipt the file already justifies. Appending a
    // second line would double the count that the reconciliation checks, and the
    // run would report records the source never held.
    if (existing) return { ...existing, idempotency_key: request.idempotency_key };

    const recordedAt = this.now().toISOString();
    // Derived from the idempotency key, which is itself deterministic over
    // (authority, legacy id, kind, ordinal). A counter would hand the same block
    // a different id on a resumed run.
    const objectId = `${ProvisionalRecordIdPrefix}${request.idempotency_key}`;
    const line: ProvisionalBlockLine = {
      idempotency_key: request.idempotency_key,
      object_id: objectId,
      recorded_at: recordedAt,
      record
    };
    // Owner-only, and every byte written before the receipt is returned. This
    // file holds the source's prose verbatim; it was opened without a mode and
    // landed at 0644, the only file in the store anybody on the machine could
    // read.
    appendLocalPrivateLine(this.provisionalPath, `${JSON.stringify(line)}\n`);
    const receipt = {
      idempotency_key: request.idempotency_key,
      object_id: objectId,
      recorded_at: recordedAt,
      // Not on the assertion change feed -- it is not an assertion. Zero cannot
      // be mistaken for a position, because an assertion's seq is always
      // positive. Same convention as an entity receipt.
      seq: 0
    };
    this.provisionalByKey.set(request.idempotency_key, receipt);
    return receipt;
  }

  /**
   * An entity record is already durable when it gets here: the registry wrote
   * it to the identity log before returning the id. There is nothing left to
   * commit, so this writes nothing and returns the receipt the identity log
   * already justifies.
   *
   * `request.object_id` is authoritative HERE and only here — it is the id
   * `mintEntity` minted, unlike the deferred token every other branch is handed.
   */
  private commitEntity(request: CommitRequest): CommitReceipt {
    const entity = this.identity.registry.read(request.object_id as EntityId);
    if (!entity) {
      throw new Error(
        `commit names entity ${request.object_id}, which the registry does not hold; an entity ` +
          "record must be minted before it is committed"
      );
    }
    return {
      idempotency_key: request.idempotency_key,
      object_id: entity.entity_id,
      recorded_at: entity.registered_at,
      seq: 0
    };
  }

  private commitRelationship(
    request: CommitRequest,
    resolved: Extract<CommitRequest["resolved"], { record_kind: "relationship" }>
  ): CommitReceipt {
    const record = request.record;
    if (record.record_kind !== "relationship" && record.record_kind !== "minted-relationship") {
      throw new Error(
        `commit resolved ${record.record_kind} as a relationship; the resolution and the record ` +
          "must agree about what is being written"
      );
    }
    const draft: AssertionDraft = {
      kind: "relationship",
      lineage_action: "assert",
      subject_entity_id: resolved.source_entity_id as EntityId,
      predicate: record.predicate,
      target_entity_id: resolved.target_entity_id as EntityId,
      value: migrationAssertionValue({
        provenance: record.provenance,
        status: record.status,
        ...("attrs" in record ? { attrs: record.attrs } : {})
      }),
      valid_from: migrationWorldTimePoint(record.valid_from, record.valid_from_fidelity),
      ...("valid_to" in record && record.valid_to !== undefined
        ? { valid_to: migrationWorldTimePoint(record.valid_to, record.valid_to_fidelity) }
        : {}),
      supersedes: [],
      confidence: { ...MigrationConfidence },
      evidence_links: migrationEvidence(record.provenance, this.authorityId),
      basis:
        "legacy_edge_id" in record && record.legacy_edge_id !== undefined
          ? `pre-contract-import edge ${record.legacy_edge_id}`
          : migrationBasis(record.provenance),
      ...(legacyProposedAt(record.provenance) === undefined
        ? {}
        : { proposed_at: legacyProposedAt(record.provenance) })
    };
    return this.commitDrafts(request, [draft]);
  }

  /**
   * A legacy tombstone, dispatched on what the deleted record actually became.
   *
   * An ASSERTION target retracts natively: a new assertion with
   * `lineage_action: "retract"` naming the original in `supersedes`, which is
   * the one mechanism in the store that expresses "we should never have said
   * this" while leaving the original bytes readable.
   *
   * An ENTITY target cannot. Entities are never deleted — an id Atlas has
   * returned resolves forever — so there is nothing to retract, and a retraction
   * assertion over an entity would name a claim that was never made. What the
   * legacy store recorded is a fact ABOUT that record, and it is asserted as
   * one.
   *
   * The legacy tombstone was a bare boolean with no actor and no reason, so the
   * migration genuinely cannot tell a belief error (`retract`) from a world
   * change (`invalidate`). It follows the plan, which names the record a
   * retraction, and says so here rather than choosing silently.
   */
  private commitRetraction(
    request: CommitRequest,
    resolved: Extract<CommitRequest["resolved"], { record_kind: "retraction" }>
  ): CommitReceipt {
    const record = request.record;
    if (record.record_kind !== "retraction") {
      throw new Error(
        `commit resolved ${record.record_kind} as a retraction; the resolution and the record must ` +
          "agree about what is being written"
      );
    }
    const targetId = resolved.retracts_object_id;
    const value = migrationAssertionValue({
      provenance: record.provenance,
      detail: record.retraction_basis
    });
    const shared = {
      supersedes: [],
      confidence: { ...MigrationConfidence },
      evidence_links: migrationEvidence(record.provenance, this.authorityId),
      basis: migrationBasis(record.provenance),
      ...(legacyProposedAt(record.provenance) === undefined
        ? {}
        : { proposed_at: legacyProposedAt(record.provenance) })
    };

    if (targetId.startsWith("la_assertion_")) {
      const superseded = this.log.read(targetId as AssertionId);
      if (!superseded) {
        throw new Error(
          `retraction ${request.idempotency_key} names assertion ${targetId}, which this log does ` +
            "not hold"
        );
      }
      const draft: AssertionDraft = {
        ...shared,
        kind: superseded.kind,
        lineage_action: "retract",
        subject_entity_id: superseded.subject_entity_id,
        predicate: superseded.predicate,
        ...(superseded.target_entity_id === undefined
          ? {}
          : { target_entity_id: superseded.target_entity_id }),
        value,
        // World time is copied, not closed. A retraction is a belief error and
        // the world did not change, so narrowing the interval would assert that
        // something stopped being true on the day we ran the migration.
        ...(superseded.valid_from === undefined ? {} : { valid_from: superseded.valid_from }),
        ...(superseded.valid_to === undefined ? {} : { valid_to: superseded.valid_to }),
        supersedes: [superseded.assertion_id]
      };
      return this.commitDrafts(request, [draft]);
    }

    if (targetId.startsWith("la_entity_")) {
      const draft: AssertionDraft = {
        ...shared,
        kind: "observation",
        lineage_action: "assert",
        subject_entity_id: targetId as EntityId,
        predicate: LegacyTombstonePredicate,
        value
      };
      return this.commitDrafts(request, [draft]);
    }

    // A DELETED BLOCK STAYS DELETED, and its retraction goes where the block
    // went. A retraction is an `atlas.assertion:v1`, and the assertion log holds
    // no record with this id to name -- so the published shapes cannot express
    // "the unmodelled thing over there was deleted" at all. Dropping it would
    // turn a recorded deletion into an absence of history, which an append-only
    // plane must never do, so it is carried beside the block instead.
    if (targetId.startsWith(ProvisionalRecordIdPrefix)) {
      return this.commitProvisional(request);
    }

    throw new Error(
      `retraction ${request.idempotency_key} names ${targetId}, which is neither an assertion nor ` +
        "an entity; a tombstone must say what it deletes"
    );
  }

  /**
   * An absence commits no assertion and no entity, and records that it did.
   *
   * A submission naming zero assertions is the only mechanism atlas-core offers
   * that is durable, idempotent and produces no record — which is exactly the
   * shape of "this object existed, it did not come across, and here is the proof
   * we looked at it". Without the receipt a resume would re-enter this branch
   * every run and report having committed records it did not write, so the one
   * number an operator uses to decide the migration is finished would never
   * settle.
   */
  private commitAbsence(request: CommitRequest): CommitReceipt {
    return this.commitDrafts(request, []);
  }

  private commitDrafts(request: CommitRequest, drafts: AssertionDraft[]): CommitReceipt {
    const result = this.log.commit({
      client_id: MigrationClientId,
      idempotency_key: request.idempotency_key,
      origin: MigrationOrigin,
      recorded_at_fidelity: MigrationRecordedAtFidelity,
      drafts
    });
    if (!result.ok) {
      throw new Error(
        `${request.idempotency_key} was already committed with a different payload: ${result.message}`
      );
    }
    const assertionId = result.receipt.assertion_ids[0];
    const assertion = assertionId === undefined ? undefined : this.log.read(assertionId);
    return {
      idempotency_key: request.idempotency_key,
      object_id: assertionId ?? result.receipt.submission_id,
      // atlas-core's instant, not the planner's. See the file header.
      recorded_at: result.receipt.committed_at,
      seq: assertion?.seq ?? 0
    };
  }

  // -------------------------------------------------------------------------
  // AliasLedger
  // -------------------------------------------------------------------------

  async resolveAlias(legacyObjectId: string): Promise<AliasLedgerRow | undefined> {
    const row = this.identity.registry.ledger.find((candidate) => candidate.old_id === legacyObjectId);
    if (!row) return undefined;

    const target = ((): AliasLedgerTarget => {
      if (row.disposition === "mapped" || row.disposition === "mapped-assertion") {
        const objectId = row.disposition === "mapped" ? row.new_id : row.new_assertion_id;
        const recordKind = redirectRecordKindOf(objectId);
        if (recordKind) return { kind: "redirect", object_id: objectId, record_kind: recordKind };
      }
      if (row.disposition === "ambiguous-split") {
        const [first, second, ...rest] = row.candidate_ids;
        if (first && second) {
          return { kind: "ambiguous-split", candidate_object_ids: [first, second, ...rest] };
        }
      }
      const decoded = decodeNoTargetReason(row.reason);
      if (decoded) return decoded;
      // A row this migration did not write, or wrote in another format. It is
      // returned as it stands rather than normalised into something that
      // compares equal, so the run reports a conflict instead of overwriting a
      // decision somebody else made.
      return { kind: "no-target", disposition: "other", detail: row.reason };
    })();

    return {
      legacy_object_id: row.old_id,
      basis: AliasBasis,
      target,
      recorded_at: row.recorded_at
    };
  }

  async appendAlias(row: AliasLedgerRow): Promise<void> {
    const target = row.target;
    const context = {
      client_id: MigrationClientId,
      origin: MigrationOrigin,
      recorded_at_fidelity: MigrationRecordedAtFidelity
    } as const;

    if (target.kind === "redirect") {
      const recovered = redirectRecordKindOf(target.object_id);
      if (recovered !== target.record_kind) {
        throw new Error(
          `alias redirect for ${row.legacy_object_id} names a ${target.record_kind} record as ` +
            `${target.object_id}, which reads back as ${recovered ?? "no known record kind"}. The ` +
            "ledger has no field for the record kind, so a row that cannot be read back exactly " +
            "would report a conflict with itself on the next run."
        );
      }
      const outcome = target.object_id.startsWith("la_entity_")
        ? this.identity.registry.merge({
            ...context,
            basis: "mechanical-migration",
            from: row.legacy_object_id,
            into: target.object_id as EntityId,
            reason: "carried across by the pre-contract migration"
          })
        : // A legacy EDGE id became an assertion, not an entity. `mapped` cannot
          // hold it and every terminal disposition would say the id was not
          // carried forward, which is the opposite of what happened. See ADR 0027.
          this.identity.registry.recordMigrationAssertionMapping({
            ...context,
            old_id: row.legacy_object_id,
            new_assertion_id: target.object_id as AssertionId,
            reason: "the legacy edge was carried across as an assertion"
          });
      if (!outcome.ok) {
        throw new Error(`alias row for ${row.legacy_object_id} was refused: ${outcome.message}`);
      }
      return;
    }

    if (target.kind === "ambiguous-split") {
      const outcome = this.identity.registry.recordAmbiguousSplit({
        ...context,
        old_id: row.legacy_object_id,
        candidate_ids: target.candidate_object_ids as EntityId[],
        reason: "one legacy record meant more than one thing and both were carried across"
      });
      if (!outcome.ok) {
        throw new Error(`alias row for ${row.legacy_object_id} was refused: ${outcome.message}`);
      }
      return;
    }

    const outcome = this.identity.registry.recordMigrationDisposition({
      ...context,
      old_id: row.legacy_object_id,
      disposition: TerminalDispositionBySourceDisposition[target.disposition],
      reason: encodeNoTargetReason(target)
    });
    if (!outcome.ok) {
      throw new Error(`alias row for ${row.legacy_object_id} was refused: ${outcome.message}`);
    }
  }

  // -------------------------------------------------------------------------
  // MigrationAuditSink
  // -------------------------------------------------------------------------

  /**
   * One event per apply call, appended and fsynced before it returns.
   *
   * A file rather than the assertion log: an audit event is not a claim about
   * the world and routing it through the log would put migration bookkeeping on
   * the consumer change feed. Aggregate counts only — a per-record audit would
   * be a second copy of the graph and would leak the shape of the corpus to
   * anyone allowed to read audit.
   */
  async recordAudit(event: MigrationApplyAudit): Promise<void> {
    appendLocalPrivateLine(this.auditPath, `${JSON.stringify(event)}\n`);
  }

  census(): MigrationPlaneCensus {
    return readMigrationPlaneCensus(this.root);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.log.close();
    this.identity.close();
  }
}

/**
 * Open the real target plane at `directory`, creating the two logs if they are
 * not there yet.
 *
 * Shaped like `createInMemoryTargetPlane()` on purpose: `applyProjectionPlan`
 * takes the same four ports either way, so a test can run the identical apply
 * against the reference plane and against this one and compare. The point of
 * the pair is that the comparison is possible at all.
 */
export function openDurableMigrationPlane(
  options: DurableMigrationPlaneOptions & { authority_id: string }
): DurableMigrationPlane {
  const plane = new MigrationPlane(options);
  return {
    registry: {
      mintEntity: (request) => plane.mintEntity(request),
      mintAssertion: (request) => plane.mintAssertion(request)
    },
    alias_ledger: {
      resolve: (legacyObjectId) => plane.resolveAlias(legacyObjectId),
      append: (row) => plane.appendAlias(row)
    },
    sink: {
      receiptFor: (key) => plane.receiptFor(key),
      commit: (request) => plane.commit(request)
    },
    audit: {
      record: (event) => plane.recordAudit(event)
    },
    directory: options.directory,
    repairs: plane.repairs,
    census: () => plane.census(),
    close: () => plane.close()
  };
}
