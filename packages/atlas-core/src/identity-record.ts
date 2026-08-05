import { z } from "zod";
import { AliasRowSchema } from "./alias-ledger.js";
import { EntitySchema, SourceObservationSchema } from "./entity.js";
import { EntityIdSchema } from "./ids.js";
import { RecordedAtSchema } from "./time.js";

/**
 * The identity log's on-disk format — a SECOND log, in its own directory, with
 * its own record vocabulary.
 *
 * It is separate from the assertion log because their retention rules are
 * opposites, and a segment is the unit of reclamation. The assertion log
 * reclaims whole segments once everything in them has fallen below the history
 * floor; the identity log is never reclaimed at all, because an id Atlas has
 * ever returned has to resolve forever. Mixing them would mean either that one
 * alias row pins a segment permanently — which makes compaction useless once
 * 65,091 migration rows exist — or that a bug in a retention guard deletes
 * identity. Neither is acceptable, so they do not share a directory.
 *
 * The separation is enforced, not documented. Each reader refuses the other's
 * records as an unknown kind, and each header declares a different
 * `log_format`, so a file that ends up in the wrong directory fails to load
 * instead of being half-understood.
 *
 * Note what is absent, and why: no watermark, no history floor, no compaction
 * record. Every one of those exists in the assertion log to make deletion safe.
 * There is no deletion here to make safe.
 */
export const IDENTITY_LOG_FORMAT = "atlas.identity-log:v1";

/**
 * As in the assertion log, a header is what makes a zero-byte segment
 * DETECTABLE. It carries no epoch and no floor because the identity log has
 * neither — an entity's belief time lives on the entity.
 */
export const IdentityHeaderRecordSchema = z
  .object({
    record: z.literal("header"),
    /**
     * A string the reader compares, NOT a literal the schema enforces.
     *
     * Today the two logs' headers also differ in shape, so a misfiled segment
     * happens to fail as a malformed record. That is luck, not a guarantee: the
     * moment the shapes converge, two logs with two retention policies would
     * silently accept each other's files. Parsing the field and checking it by
     * name is what makes the refusal be ABOUT the format.
     */
    log_format: z.string().min(1),
    segment_ordinal: z.number().int().positive(),
    created_at: RecordedAtSchema
  })
  .strict();

/**
 * `group_seq` on every member is what makes an atomic boundary expressible in
 * an append-only file: the `group-commit` marker is written LAST and closes the
 * group, so members without their marker are a write that died and was never
 * acknowledged.
 */
export const EntityRecordSchema = z
  .object({
    record: z.literal("entity"),
    group_seq: z.number().int().positive(),
    entity: EntitySchema
  })
  .strict();

export const AliasRecordSchema = z
  .object({
    record: z.literal("alias"),
    group_seq: z.number().int().positive(),
    row: AliasRowSchema
  })
  .strict();

/**
 * Where an import last saw an entity. Journalled rather than derived, because
 * losing it means the next re-import cannot find the entity it already minted
 * an id for — and mints a second one. That is the duplicate explosion the
 * registry exists to prevent, so the index has to survive a restart.
 */
export const ObservationRecordSchema = z
  .object({
    record: z.literal("observation"),
    group_seq: z.number().int().positive(),
    entity_id: EntityIdSchema,
    observation: SourceObservationSchema,
    observed_at: RecordedAtSchema
  })
  .strict();

/** The commit marker. Its presence is what makes the preceding records real. */
export const GroupCommitRecordSchema = z
  .object({
    record: z.literal("group-commit"),
    group_seq: z.number().int().positive(),
    committed_at: RecordedAtSchema,
    entity_ids: z.array(EntityIdSchema),
    row_seqs: z.array(z.number().int().positive())
  })
  .strict();

/**
 * A torn tail that was truncated on load. The digest lets a human confirm which
 * bytes were dropped against a backup without copying a possibly-sensitive
 * record's plaintext into the audit trail a second time.
 */
export const IdentityRepairRecordSchema = z
  .object({
    record: z.literal("repair"),
    repaired_at: RecordedAtSchema,
    segment_ordinal: z.number().int().positive(),
    reason: z.enum(["torn-tail", "incomplete-commit", "other"]),
    discarded_bytes: z.number().int().nonnegative(),
    discarded_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/)
  })
  .strict();

export const IdentityRecordSchema = z.discriminatedUnion("record", [
  IdentityHeaderRecordSchema,
  EntityRecordSchema,
  AliasRecordSchema,
  ObservationRecordSchema,
  GroupCommitRecordSchema,
  IdentityRepairRecordSchema
]);

export type IdentityRecord = z.infer<typeof IdentityRecordSchema>;
export type IdentityHeaderRecord = z.infer<typeof IdentityHeaderRecordSchema>;

export const IDENTITY_RECORD_KINDS = [
  "header",
  "entity",
  "alias",
  "observation",
  "group-commit",
  "repair"
] as const;

export type IdentityRecordKind = (typeof IDENTITY_RECORD_KINDS)[number];

/**
 * Records that leave a group OPEN, versus records that stand alone. At
 * end-of-file an open group is a write that never completed, and it is
 * discarded rather than replayed — replaying it would resurrect entity ids
 * nobody was ever told about.
 */
export type IdentityGroupMember = Extract<
  IdentityRecord,
  { record: "entity" | "alias" | "observation" }
>;

/** A type predicate, so a member's `group_seq` is reachable without a cast. */
export function opensIdentityGroup(record: IdentityRecord): record is IdentityGroupMember {
  return record.record === "entity" || record.record === "alias" || record.record === "observation";
}

export function isKnownIdentityRecordKind(kind: unknown): kind is IdentityRecordKind {
  return typeof kind === "string" && (IDENTITY_RECORD_KINDS as readonly string[]).includes(kind);
}
