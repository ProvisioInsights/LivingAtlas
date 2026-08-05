import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

/**
 * Identity is the defect that made the old store unusable as a long-term
 * reference. `semanticObjectId` derived a block's id from
 * `sha256(sourcePathRef : lineIndex : text)`, so fixing a typo minted a new id
 * and inserting one bullet re-identified every block below it on the page —
 * across 51,811 of 65,091 objects. Two fallback paths made it worse: one
 * derived the path-redaction secret from the import run's own timestamp, the
 * other from `randomBytes(16)` per call, so a careless re-import produced a
 * completely disjoint id space for the entire corpus.
 *
 * The rule here is absolute: **ids are minted, never derived.** Nothing about
 * an assertion's content, position, or encoding may influence its id. That is
 * what lets Atlas promise that an id it once returned resolves forever.
 */

const OPAQUE = "[0-9a-z]{26}";

export const AssertionIdSchema = z.string().regex(new RegExp(`^la_assertion_${OPAQUE}$`));
export const EntityIdSchema = z.string().regex(new RegExp(`^la_entity_${OPAQUE}$`));
export const SubmissionIdSchema = z.string().regex(new RegExp(`^la_submission_${OPAQUE}$`));

export type AssertionId = z.infer<typeof AssertionIdSchema>;
export type EntityId = z.infer<typeof EntityIdSchema>;
export type SubmissionId = z.infer<typeof SubmissionIdSchema>;

/** `sha256:`-prefixed, matching the repo's existing `Sha256HashSchema`. */
export const ClaimDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export type ClaimDigest = z.infer<typeof ClaimDigestSchema>;

const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

function encodeTime(millis: number): string {
  let remaining = millis;
  let out = "";
  for (let index = 0; index < 10; index += 1) {
    out = CROCKFORD[remaining % 32] + out;
    remaining = Math.floor(remaining / 32);
  }
  return out;
}

function encodeRandom(): string {
  const bytes = randomBytes(16);
  let out = "";
  for (const byte of bytes) {
    out += CROCKFORD[byte % 32];
  }
  return out;
}

/**
 * ULID-shaped: 10 chars of millisecond timestamp then 16 of randomness, so ids
 * sort by mint time lexicographically. The sort order is a convenience for
 * debugging and index locality — it is NOT the change-feed order, which is
 * `seq`, and it is NOT belief time, which is `recorded_at`. Never infer
 * ordering semantics from an id.
 */
function mint(prefix: string, mintedAt: Date): string {
  return `la_${prefix}_${encodeTime(mintedAt.getTime())}${encodeRandom()}`;
}

export function mintAssertionId(mintedAt: Date): AssertionId {
  return mint("assertion", mintedAt) as AssertionId;
}

export function mintEntityId(mintedAt: Date): EntityId {
  return mint("entity", mintedAt) as EntityId;
}

export function mintSubmissionId(mintedAt: Date): SubmissionId {
  return mint("submission", mintedAt) as SubmissionId;
}

/**
 * A dedup hint and a contradiction key — **never an identity**.
 *
 * It covers the CLAIM CORE only: subject, predicate, value, and the world-time
 * bounds. It deliberately excludes `recorded_at`, provenance, confidence and
 * evidence, so that two consumers asserting the same fact at different moments
 * produce two assertions with the same digest and different ids. Those are two
 * distinct learning events about one claim, and both must survive.
 *
 * This is also why an assertion can never be content-addressed: its body
 * carries a server clock, so it could never hash the same twice.
 */
export function claimDigest(input: {
  subject_entity_id: string;
  predicate: string;
  value: unknown;
  valid_from?: unknown;
  valid_to?: unknown;
}): ClaimDigest {
  const core = stableStringify({
    subject_entity_id: input.subject_entity_id,
    predicate: input.predicate,
    value: input.value ?? null,
    valid_from: input.valid_from ?? null,
    valid_to: input.valid_to ?? null
  });
  return `sha256:${createHash("sha256").update(core, "utf8").digest("hex")}` as ClaimDigest;
}

/**
 * Key-ordered JSON so digests do not depend on property insertion order.
 *
 * Exported because the alias ledger's hash chain has to serialise a row the
 * same way every reader does. Two implementations of one canonical form is the
 * `submissionKey` bug again — that one was built with a NUL in a template on
 * one side and a space on the other, and the mismatch was silent.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}
