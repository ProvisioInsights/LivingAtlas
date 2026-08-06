import { createHash } from "node:crypto";
import { z } from "zod";
import { ProvenanceSchema } from "./assertion.js";
import { AssertionIdSchema, EntityIdSchema, stableStringify } from "./ids.js";
import { RecordedAtSchema } from "./time.js";

/**
 * The alias ledger: an append-only record of what happened to an id.
 *
 * It exists because of a promise Atlas cannot keep any other way — an id Atlas
 * has ever returned resolves forever, and no id is ever reused. Entities get
 * merged, split, and re-imported; the ids consumers wrote down do not get to
 * become meaningless when that happens. A row here is how an old id keeps
 * answering.
 *
 * **A ledger row is not an assertion, and that is load-bearing.** A mechanical
 * migration produces tens of thousands of redirects at once. Routing those
 * through the assertion path would mean inventing an evidence record for each
 * one — fabricated provenance, at scale, in the exact layer attribution depends
 * on. So redirects live here, and only an owner- or consumer-initiated decision
 * ALSO produces a resolution assertion, which carries the real evidence and is
 * named by `resolution_assertion_id`. The two record shapes are disjoint on
 * purpose: no alias row validates as an assertion, and `alias-ledger.test.ts`
 * checks exactly that.
 */

export const ALIAS_ROW_SCHEMA = "atlas.alias-row:v1";

/**
 * Why this row exists, and the discriminator that decides whether a resolution
 * assertion is required.
 *
 *  - `mechanical-migration` — a machine carried an id across a format change.
 *    No human judged anything, so there is no evidence to attach and none is
 *    invented.
 *  - `owner-resolution` — a person decided two ids name the same thing (or that
 *    one names two things). That is a knowledge claim, and it MUST be backed by
 *    a resolution assertion with real evidence.
 */
export const AliasBasisSchema = z.enum(["mechanical-migration", "owner-resolution", "other"]);

export type AliasBasis = z.infer<typeof AliasBasisSchema>;

const AliasRowCore = z.object({
  record_schema: z.literal(ALIAS_ROW_SCHEMA),

  /**
   * Position in the ledger: monotone, gapless, and the order the hash chain is
   * defined over. Not `seq` — that is the assertion change feed, and the two
   * counters must never be confused for one another.
   */
  row_seq: z.number().int().positive(),

  /**
   * A plain string, not `EntityIdSchema`, because the ids that most need to
   * keep resolving are the ones Atlas inherited rather than minted. A legacy
   * object id from the old store has to be presentable to `resolve()` forever.
   */
  old_id: z.string().min(1),

  /** Free text, required. A redirect nobody can explain later is a mystery. */
  reason: z.string().min(1),

  /** Belief time, stamped by Atlas when the row is appended. */
  recorded_at: RecordedAtSchema,

  basis: AliasBasisSchema,
  provenance: ProvenanceSchema,

  /**
   * The resolution assertion carrying the evidence for this decision, or null
   * when there is none to carry. Non-null exactly when `basis` is
   * `owner-resolution`; a mechanical row with an assertion id would mean
   * evidence was manufactured for a machine's bookkeeping.
   */
  resolution_assertion_id: AssertionIdSchema.nullable(),

  /**
   * Hash chain over the ledger as a whole. Each row commits to its predecessor,
   * so removing or back-dating a row invalidates every row after it. Without
   * this, "append-only" is a claim about the writer's behaviour; with it, it is
   * a property of the bytes that a reader can check.
   */
  prev_ledger_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable(),
  ledger_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/)
});

/**
 * What became of `old_id`.
 *
 * `ambiguous-split` is the one that matters most. When an entity turns out to
 * have been two things, the honest answer for every reference to the original
 * is "this is one of these, and Atlas will not guess which". Nominating a
 * primary would silently attribute every historical reference to it, which is
 * exactly the "silently combining different people" failure ADR 0007 rejects.
 * So the split refuses, by name, and lists the candidates.
 *
 * The three migration dispositions exist so that a legacy id resolves to a
 * stated outcome rather than a bare not-found: "we chose not to carry this",
 * "we could not decrypt it", and "we deliberately redacted it" are three
 * different answers, and a consumer that cannot tell them apart cannot tell a
 * dangling reference from a typo.
 */
export const AliasRowSchema = z.discriminatedUnion("disposition", [
  AliasRowCore.extend({
    disposition: z.literal("mapped"),
    new_id: EntityIdSchema
  }).strict(),
  AliasRowCore.extend({
    disposition: z.literal("ambiguous-split"),
    candidate_ids: z.array(EntityIdSchema).min(2)
  }).strict(),
  AliasRowCore.extend({ disposition: z.literal("never-migrated") }).strict(),
  AliasRowCore.extend({ disposition: z.literal("content-unrecoverable") }).strict(),
  AliasRowCore.extend({ disposition: z.literal("redacted-in-place") }).strict(),
  AliasRowCore.extend({ disposition: z.literal("other") }).strict()
]);

export type AliasRow = z.infer<typeof AliasRowSchema>;
export type AliasDisposition = AliasRow["disposition"];

/** Dispositions that end a redirect walk without producing an entity. */
export const TERMINAL_DISPOSITIONS = [
  "never-migrated",
  "content-unrecoverable",
  "redacted-in-place",
  "other"
] as const;

export type TerminalDisposition = (typeof TERMINAL_DISPOSITIONS)[number];

export function isTerminalDisposition(disposition: AliasDisposition): disposition is TerminalDisposition {
  return (TERMINAL_DISPOSITIONS as readonly string[]).includes(disposition);
}

/**
 * A row before it is sealed.
 *
 * The indirection through a type parameter is load-bearing: a conditional type
 * distributes over a union only when it tests a NAKED parameter, so the plain
 * `Omit<AliasRow, "ledger_digest">` collapses to the keys every disposition
 * shares — silently dropping `new_id` and `candidate_ids` from the type of what
 * the digest is required to cover.
 */
type Unsealed<T> = T extends unknown ? Omit<T, "ledger_digest"> : never;

export type UnsealedAliasRow = Unsealed<AliasRow>;

/**
 * The chain link. Computed over the row minus its own digest — which includes
 * `prev_ledger_digest`, so the digest covers the row's content AND its position
 * in the ledger.
 */
export function aliasLedgerDigest(row: UnsealedAliasRow): string {
  return `sha256:${createHash("sha256").update(stableStringify(row), "utf8").digest("hex")}`;
}

/** Strip the seal so a row read back can be re-hashed exactly as it was written. */
export function unsealAliasRow(row: AliasRow): UnsealedAliasRow {
  const { ledger_digest: _sealed, ...rest } = row;
  return rest as UnsealedAliasRow;
}

export type LedgerIntegrity =
  | { ok: true; rows: number; head_digest: string | null }
  | {
      ok: false;
      code: "ledger-chain-broken" | "ledger-seq-broken";
      at_row_seq: number;
      expected: string | number;
      found: string | number;
      message: string;
    };

/**
 * Walk the chain and recompute it. This is the executable form of "append-only"
 * — the property is proven from the rows rather than asserted by the component
 * that wrote them.
 *
 * It checks `row_seq` too, because a chain that is intact across a GAP still
 * hides a deletion if the reader never notices the missing position.
 */
export function verifyAliasLedger(rows: readonly AliasRow[]): LedgerIntegrity {
  let previous: string | null = null;

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row) continue;
    const expectedSeq = index + 1;
    if (row.row_seq !== expectedSeq) {
      return {
        ok: false,
        code: "ledger-seq-broken",
        at_row_seq: row.row_seq,
        expected: expectedSeq,
        found: row.row_seq,
        message:
          `The alias ledger jumps to row ${row.row_seq} where row ${expectedSeq} was expected. ` +
          "A gap means a row was removed, and the ids it spoke for now resolve to nothing."
      };
    }
    if (row.prev_ledger_digest !== previous) {
      return {
        ok: false,
        code: "ledger-chain-broken",
        at_row_seq: row.row_seq,
        expected: previous ?? "null",
        found: row.prev_ledger_digest ?? "null",
        message:
          `Row ${row.row_seq} does not follow the row before it. The ledger was ` +
          "altered after it was written, so no redirect in or after this row can be trusted."
      };
    }
    const recomputed = aliasLedgerDigest(unsealAliasRow(row));
    if (recomputed !== row.ledger_digest) {
      return {
        ok: false,
        code: "ledger-chain-broken",
        at_row_seq: row.row_seq,
        expected: recomputed,
        found: row.ledger_digest,
        message:
          `Row ${row.row_seq} does not hash to the digest it carries; its contents were edited in place.`
      };
    }
    previous = row.ledger_digest;
  }

  return { ok: true, rows: rows.length, head_digest: previous };
}
