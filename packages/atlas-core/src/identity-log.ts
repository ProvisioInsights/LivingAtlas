import { existsSync, readFileSync, readdirSync, truncateSync } from "node:fs";
import { join } from "node:path";
import type { AliasRow } from "./alias-ledger.js";
import type { Entity, SourceObservation } from "./entity.js";
import { EntityRegistry, type EntityRegistryOptions, type RestoredIdentity } from "./entity-registry.js";
import type { EntityId } from "./ids.js";
import {
  IDENTITY_LOG_FORMAT,
  IdentityRecordSchema,
  isKnownIdentityRecordKind,
  opensIdentityGroup,
  type IdentityGroupMember,
  type IdentityHeaderRecord,
  type IdentityRecord
} from "./identity-record.js";
import { SegmentLogError, digestOf, splitLines, type RepairNote } from "./segment-reader.js";
import { SegmentWriter, segmentFileName, segmentOrdinalOf } from "./segment-writer.js";
import type { Clock } from "./store.js";
import { canonicalRecordedAt } from "./time.js";

/**
 * Durability for the entity registry and the alias ledger.
 *
 * The rules are the assertion log's rules, minus everything that exists there
 * to make deletion safe: header first so a zero-byte segment is detectable, the
 * group marker written last so a half-written group is discarded, repair only
 * at the tail of the final segment, and an unknown record kind refuses the load
 * rather than being skipped.
 *
 * What is deliberately missing is compaction. Identity is never reclaimed, so
 * there is no watermark to publish, no floor to advance, and no reclamation
 * note to resolve an id to. The promise — an id Atlas has ever returned
 * resolves forever — is kept by never having written the code that could break
 * it.
 */

export type IdentityScan = {
  restored: RestoredIdentity;
  /**
   * Continues the group numbering rather than restarting it. Two groups sharing
   * a number across a restart would make the redundancy check that catches
   * interleaved writes useless exactly where it is most needed.
   */
  next_group_seq: number;
  segments: { ordinal: number; path: string; bytes: number }[];
  /** The segment a writer should resume appending to, if any exists. */
  active: { ordinal: number; bytes: number; records: number } | undefined;
  repairs: RepairNote[];
  /** Files that are not segments. Reported, never silently skipped. */
  ignored_files: string[];
};

type ParsedLine = { record: IdentityRecord; offset: number };

function parseLine(line: string, ordinal: number, offset: number): IdentityRecord {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new SegmentLogError(
      "corrupt-record",
      `Identity segment ${ordinal} holds a line at byte ${offset} that is not JSON. ` +
        "It is not repaired, because only the tail of the final segment can be " +
        "damaged by a crash; damage anywhere else means the file was altered."
    );
  }

  const kind = (raw as { record?: unknown } | null)?.record;
  if (!isKnownIdentityRecordKind(kind)) {
    throw new SegmentLogError(
      "unknown-record-kind",
      `Identity segment ${ordinal} holds an unrecognised record kind ${JSON.stringify(kind)} at ` +
        `byte ${offset}. Refusing to load: a reader that skips what it does not understand would ` +
        "serve an incomplete ledger as if it were whole, and ids would resolve to the wrong thing. " +
        "An assertion-log record here means two logs were written into one directory."
    );
  }

  const parsed = IdentityRecordSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SegmentLogError(
      "corrupt-record",
      `Identity segment ${ordinal} holds a malformed ${kind} record at byte ${offset}: ${parsed.error.message}`
    );
  }
  return parsed.data;
}

function readSegment(
  directory: string,
  ordinal: number,
  isLast: boolean
): { lines: ParsedLine[]; complete: Buffer; torn: Buffer; header: IdentityHeaderRecord } {
  const raw = readFileSync(join(directory, segmentFileName(ordinal)));

  if (raw.length === 0) {
    throw new SegmentLogError(
      "empty-segment",
      `Identity segment ${ordinal} is zero bytes. Every segment is created with a header, so an ` +
        "empty one was truncated rather than written. If a crash landed between creating the " +
        "newest segment and writing its header, that file holds no records and can be removed; " +
        "anything else needs a restore, because the ids it held must keep resolving."
    );
  }

  const split = splitLines(raw);
  if (split.torn.length > 0 && !isLast) {
    throw new SegmentLogError(
      "torn-record-mid-log",
      `Identity segment ${ordinal} ends mid-record but is not the final segment. A sealed segment ` +
        "was fsynced and closed before the next one was created, so it cannot have been torn by a crash."
    );
  }

  const lines: ParsedLine[] = [];
  let offset = 0;
  for (const line of split.complete.toString("utf8").split("\n")) {
    if (line.length === 0) continue;
    lines.push({ record: parseLine(line, ordinal, offset), offset });
    offset += Buffer.byteLength(line, "utf8") + 1;
  }

  const first = lines[0];
  if (!first || first.record.record !== "header") {
    throw new SegmentLogError(
      "missing-header",
      `Identity segment ${ordinal} does not begin with a header record.`
    );
  }
  if (first.record.log_format !== IDENTITY_LOG_FORMAT) {
    throw new SegmentLogError(
      "format-mismatch",
      `Identity segment ${ordinal} declares log format ${first.record.log_format}, expected ` +
        `${IDENTITY_LOG_FORMAT}. The assertion log and the identity log are separate logs with ` +
        "separate retention rules and must not share a directory."
    );
  }
  if (first.record.segment_ordinal !== ordinal) {
    throw new SegmentLogError(
      "ordinal-mismatch",
      `Identity segment file ${segmentFileName(ordinal)} declares ordinal ${first.record.segment_ordinal}. ` +
        "A renamed segment would reorder the ledger, and the ledger's order is its hash chain."
    );
  }

  return { lines, complete: split.complete, torn: split.torn, header: first.record };
}

/** Rebuild the registry from the segment files and nothing else. */
export function scanIdentityLog(
  directory: string,
  options: { repair?: boolean } = {}
): IdentityScan {
  const repair = options.repair ?? false;
  const entries = existsSync(directory) ? readdirSync(directory) : [];

  const ordinals: number[] = [];
  const ignoredFiles: string[] = [];
  for (const entry of entries) {
    const ordinal = segmentOrdinalOf(entry);
    if (ordinal === undefined) ignoredFiles.push(entry);
    else ordinals.push(ordinal);
  }
  ordinals.sort((left, right) => left - right);

  const entities = new Map<EntityId, Entity>();
  const order: EntityId[] = [];
  const rows: AliasRow[] = [];
  const rowsByOldId = new Map<string, AliasRow>();
  const conflictingAliasRows: string[] = [];
  const observations = new Map<EntityId, SourceObservation>();
  const segments: IdentityScan["segments"] = [];
  const repairs: RepairNote[] = [];

  let highRowSeq = 0;
  let highGroupSeq = 0;
  let lastRecordedMillis = 0;
  let active: IdentityScan["active"];

  const noteInstant = (instant: string): void => {
    const millis = new Date(instant).getTime();
    if (Number.isFinite(millis) && millis > lastRecordedMillis) lastRecordedMillis = millis;
  };

  for (let index = 0; index < ordinals.length; index += 1) {
    const ordinal = ordinals[index];
    if (ordinal === undefined) continue;
    const isLast = index === ordinals.length - 1;
    const segment = readSegment(directory, ordinal, isLast);
    noteInstant(segment.header.created_at);

    let openGroup: IdentityGroupMember[] = [];
    let openGroupOffset = 0;
    let records = 0;

    for (const line of segment.lines) {
      const record = line.record;
      if (record.record === "header") continue;
      records += 1;

      if (opensIdentityGroup(record)) {
        if (openGroup.length === 0) openGroupOffset = line.offset;
        openGroup.push(record);
        continue;
      }

      if (record.record === "group-commit") {
        // The marker names what the group contained, so a member that went
        // missing between the fsync and now is detectable. Without this the
        // marker would be decoration: a group whose entity line vanished would
        // still close cleanly, and an id the caller was handed would silently
        // stop existing.
        const claimedEntities = new Set(record.entity_ids);
        const claimedRows = new Set(record.row_seqs);
        let foundEntities = 0;
        let foundRows = 0;
        for (const member of openGroup) {
          if (member.group_seq !== record.group_seq) {
            throw new SegmentLogError(
              "corrupt-record",
              `Identity segment ${ordinal} closes group ${record.group_seq} over a record belonging ` +
                `to group ${member.group_seq}. Groups are written one call at a time and cannot ` +
                "interleave, so these bytes were not produced by a writer."
            );
          }
          if (member.record === "entity") {
            foundEntities += 1;
            if (!claimedEntities.has(member.entity.entity_id)) {
              throw new SegmentLogError(
                "corrupt-record",
                `Identity segment ${ordinal} holds entity ${member.entity.entity_id} in group ` +
                  `${record.group_seq}, which does not name it.`
              );
            }
          } else if (member.record === "alias") {
            foundRows += 1;
            if (!claimedRows.has(member.row.row_seq)) {
              throw new SegmentLogError(
                "corrupt-record",
                `Identity segment ${ordinal} holds alias row ${member.row.row_seq} in group ` +
                  `${record.group_seq}, which does not name it.`
              );
            }
          }
        }
        if (foundEntities !== claimedEntities.size || foundRows !== claimedRows.size) {
          throw new SegmentLogError(
            "corrupt-record",
            `Identity segment ${ordinal} closes group ${record.group_seq} naming ` +
              `${claimedEntities.size} entities and ${claimedRows.size} alias rows, but only ` +
              `${foundEntities} and ${foundRows} are present. A record was removed from a ` +
              "committed group; the ids it held would silently stop resolving."
          );
        }

        for (const member of openGroup) {
          if (member.record === "entity") {
            const entity = member.entity;
            // Latest version wins: a rename appends a new record rather than
            // editing the old one, so the earlier bytes stay put as evidence.
            if (!entities.has(entity.entity_id)) order.push(entity.entity_id);
            entities.set(entity.entity_id, entity);
            noteInstant(entity.updated_at);
          } else if (member.record === "alias") {
            const row = member.row;
            rows.push(row);
            if (rowsByOldId.has(row.old_id)) conflictingAliasRows.push(row.old_id);
            else rowsByOldId.set(row.old_id, row);
            if (row.row_seq > highRowSeq) highRowSeq = row.row_seq;
            noteInstant(row.recorded_at);
          } else if (member.record === "observation") {
            observations.set(member.entity_id, member.observation);
            noteInstant(member.observed_at);
          }
        }
        openGroup = [];
        if (record.group_seq > highGroupSeq) highGroupSeq = record.group_seq;
        noteInstant(record.committed_at);
        continue;
      }

      // Everything below stands alone, so an open group here means a group was
      // interleaved with something else — which the writer cannot do.
      if (openGroup.length > 0) {
        throw new SegmentLogError(
          "incomplete-commit-mid-log",
          `Identity segment ${ordinal} holds a group without its commit marker at byte ` +
            `${openGroupOffset}, followed by unrelated records. A group is written in one call, so ` +
            "this cannot be a torn write."
        );
      }

      if (record.record === "repair") noteInstant(record.repaired_at);
    }

    let liveBytes = segment.complete.length;

    // A group left open at end-of-file was never acknowledged to anyone, so it
    // never happened. Replaying it would make ids visible that no caller was
    // ever handed.
    if (openGroup.length > 0) {
      if (!isLast) {
        throw new SegmentLogError(
          "incomplete-commit-mid-log",
          `Identity segment ${ordinal} ends with an unclosed group, but it is not the final segment.`
        );
      }
      const discarded = segment.complete.subarray(openGroupOffset);
      repairs.push({
        segment_ordinal: ordinal,
        reason: "incomplete-commit",
        discarded_bytes: discarded.length,
        discarded_digest: digestOf(discarded)
      });
      liveBytes = openGroupOffset;
      records -= openGroup.length;
    }

    if (segment.torn.length > 0) {
      repairs.push({
        segment_ordinal: ordinal,
        reason: "torn-tail",
        discarded_bytes: segment.torn.length,
        discarded_digest: digestOf(segment.torn)
      });
    }

    if (repair && (liveBytes !== segment.complete.length || segment.torn.length > 0)) {
      // Truncate for real rather than skipping at read time: leaving the bytes
      // would weld garbage into the middle of the file as soon as the next
      // group appends past them.
      truncateSync(join(directory, segmentFileName(ordinal)), liveBytes);
    }

    segments.push({ ordinal, path: join(directory, segmentFileName(ordinal)), bytes: liveBytes });
    if (isLast) active = { ordinal, bytes: liveBytes, records };
  }

  return {
    restored: {
      entities: order.flatMap((entityId) => {
        const entity = entities.get(entityId);
        return entity ? [entity] : [];
      }),
      rows,
      observations,
      next_row_seq: highRowSeq + 1,
      last_recorded_millis: lastRecordedMillis,
      conflicting_alias_rows: conflictingAliasRows
    },
    next_group_seq: highGroupSeq + 1,
    segments,
    active,
    repairs,
    ignored_files: ignoredFiles
  };
}

export type DurableEntityRegistryOptions = {
  directory: string;
  clock?: Clock;
  resolutions?: EntityRegistryOptions["resolutions"];
  maxRedirectDepth?: number;
  maxSegmentBytes?: number;
};

/** What the load found and had to do about it. Surfaced, never swallowed. */
export type IdentityLoadReport = {
  segments: number;
  entities: number;
  alias_rows: number;
  observations: number;
  repairs: RepairNote[];
  ignored_files: string[];
  conflicting_alias_rows: string[];
};

/**
 * An `EntityRegistry` whose every minted id is on disk before it is returned,
 * and which can be reopened without a consumer noticing.
 */
export class DurableEntityRegistry {
  readonly registry: EntityRegistry;
  readonly directory: string;
  readonly report: IdentityLoadReport;

  private readonly writer: SegmentWriter<IdentityRecord>;
  private closed = false;

  private constructor(input: {
    registry: EntityRegistry;
    writer: SegmentWriter<IdentityRecord>;
    directory: string;
    report: IdentityLoadReport;
  }) {
    this.registry = input.registry;
    this.writer = input.writer;
    this.directory = input.directory;
    this.report = input.report;
  }

  static open(options: DurableEntityRegistryOptions): DurableEntityRegistry {
    const clock = options.clock ?? (() => new Date());
    // Repair on open, and only on open: this is the one moment a torn tail can
    // exist and the one moment no writer is appending.
    const scan = scanIdentityLog(options.directory, { repair: true });

    const writer = new SegmentWriter<IdentityRecord>({
      directory: options.directory,
      makeHeader: (ordinal) => ({
        record: "header",
        log_format: IDENTITY_LOG_FORMAT,
        segment_ordinal: ordinal,
        created_at: canonicalRecordedAt(clock())
      }),
      maxSegmentBytes: options.maxSegmentBytes,
      resume: scan.active
    });

    let groupSeq = scan.next_group_seq;
    const registry = new EntityRegistry({
      clock,
      resolutions: options.resolutions,
      maxRedirectDepth: options.maxRedirectDepth,
      restored: scan.restored,
      journal: {
        appendIdentityGroup(group) {
          const records: IdentityRecord[] = [];
          for (const entity of group.entities) {
            records.push({ record: "entity", group_seq: groupSeq, entity });
          }
          for (const row of group.rows) {
            records.push({ record: "alias", group_seq: groupSeq, row });
          }
          for (const observation of group.observations) {
            records.push({
              record: "observation",
              group_seq: groupSeq,
              entity_id: observation.entity_id,
              observation: observation.observation,
              observed_at: observation.observed_at
            });
          }
          if (records.length === 0) return;
          // The marker goes LAST and closes the group. A crash that lands
          // anywhere earlier leaves records with no marker, which the reader
          // discards — all-or-nothing without a two-phase dance.
          records.push({
            record: "group-commit",
            group_seq: groupSeq,
            committed_at: canonicalRecordedAt(clock()),
            entity_ids: group.entities.map((entity) => entity.entity_id),
            row_seqs: group.rows.map((row) => row.row_seq)
          });
          writer.appendGroup(records);
          groupSeq += 1;
        }
      }
    });

    // The truncation already happened; this records that it happened, so the
    // file carries its own repair history instead of relying on whoever read
    // the return value at the time.
    for (const repairNote of scan.repairs) {
      writer.appendGroup([
        {
          record: "repair",
          repaired_at: canonicalRecordedAt(clock()),
          segment_ordinal: repairNote.segment_ordinal,
          reason: repairNote.reason,
          discarded_bytes: repairNote.discarded_bytes,
          discarded_digest: repairNote.discarded_digest
        }
      ]);
    }

    return new DurableEntityRegistry({
      registry,
      writer,
      directory: options.directory,
      report: {
        segments: scan.segments.length,
        entities: scan.restored.entities.length,
        alias_rows: scan.restored.rows.length,
        observations: scan.restored.observations.size,
        repairs: scan.repairs,
        ignored_files: scan.ignored_files,
        conflicting_alias_rows: scan.restored.conflicting_alias_rows
      }
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.writer.close();
  }
}
