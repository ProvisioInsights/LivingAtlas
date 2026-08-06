import { CONTRACT_LIMITS } from "@living-atlas/atlas-contract";
import { canonicalRecordedAt, type RecordedAt } from "@living-atlas/atlas-core";
import { reportCount, type Principal } from "./principal.js";

/**
 * The blocks every read result carries, built in one place.
 *
 * `coverage`, `horizon` and `cache` are required by the published output
 * schemas on every read, and that is the point: the honesty block is not
 * optional and not conditional on something having gone wrong. Building them
 * per handler would let one handler quietly report a different truth from
 * another — which is how the prior surface ended up with four read paths that
 * each dropped rows in a different way.
 */

export type Horizon = {
  record_schema: "atlas.horizon:v1";
  status: "complete" | "partial" | "unknowable";
  bitemporal_since: RecordedAt;
  feed_epoch: string;
  seq_watermark: number;
  as_of_recorded: RecordedAt;
  as_of_valid?: string;
  recorded_at_fidelity_mixed: boolean;
  retention_floor_seq?: number;
  migration_window_open?: boolean;
};

export type Coverage = {
  evaluated: number;
  matched: number;
  returned: number;
  withheld: number;
  with_valid_time: number;
  unknown_or_absent_valid_time: number;
  counts_basis: "exact" | "bucketed";
  bucket_width?: number;
};

export type CacheBlock = { ttl_ms: number; cache_scope: "private" | "public" };

export type ErrorRecord = {
  record_schema: "atlas.error:v1";
  code: string;
  message: string;
  retryable: boolean;
  jsonrpc_code?: number;
  required_capabilities?: string[];
  remedy?: { tool?: string; arguments_hint?: unknown; note?: string };
  details?: unknown;
};

/**
 * Every result in this revision is `private`.
 *
 * Not a default that a tool may override: results vary by credential because
 * policy filtering varies by credential, so a shared cache would serve one
 * consumer's permitted view to another. The function takes no scope argument,
 * which is what makes that unoverridable rather than merely conventional.
 */
export function cacheBlock(ttlMs: number): CacheBlock {
  return { ttl_ms: ttlMs, cache_scope: "private" };
}

export type CoverageTally = {
  evaluated: number;
  matched: number;
  returned: number;
  withheld: number;
  with_valid_time: number;
  unknown_or_absent_valid_time: number;
};

/**
 * Report a tally through the principal's counting basis.
 *
 * `returned` is NEVER bucketed: it is the length of an array the caller is
 * holding, so rounding it would produce a result that contradicts itself. The
 * other counts are the ones a bisection attack reads, and those are the ones
 * the basis applies to.
 */
export function coverage(principal: Principal, tally: CoverageTally): Coverage {
  const basis = principal.grant.coverage_counts_basis;
  return {
    evaluated: reportCount(principal, tally.evaluated),
    matched: reportCount(principal, tally.matched),
    returned: tally.returned,
    withheld: reportCount(principal, tally.withheld),
    with_valid_time: reportCount(principal, tally.with_valid_time),
    unknown_or_absent_valid_time: reportCount(principal, tally.unknown_or_absent_valid_time),
    counts_basis: basis,
    ...(basis === "bucketed" ? { bucket_width: 10 } : {})
  };
}

export type HorizonInput = {
  status?: Horizon["status"];
  bitemporalSince: RecordedAt;
  feedEpoch: string;
  seqWatermark: number;
  asOfRecorded?: RecordedAt;
  asOfValid?: string;
  fidelityMixed: boolean;
  retentionFloorSeq?: number;
  now: Date;
};

/**
 * `as_of_recorded` is echoed even when the caller did not supply one.
 *
 * A read with no as-of is still a read AT an instant; leaving the field off
 * would make a present-tense answer and a past-tense answer look like different
 * kinds of answer, and only one of them replayable.
 */
export function horizon(input: HorizonInput): Horizon {
  return {
    record_schema: "atlas.horizon:v1",
    status: input.status ?? "complete",
    bitemporal_since: input.bitemporalSince,
    feed_epoch: input.feedEpoch,
    seq_watermark: input.seqWatermark,
    as_of_recorded: input.asOfRecorded ?? canonicalRecordedAt(input.now),
    ...(input.asOfValid === undefined ? {} : { as_of_valid: input.asOfValid }),
    recorded_at_fidelity_mixed: input.fidelityMixed,
    ...(input.retentionFloorSeq === undefined ? {} : { retention_floor_seq: input.retentionFloorSeq }),
    migration_window_open: false
  };
}

export function errorRecord(input: {
  code: string;
  message: string;
  retryable: boolean;
  jsonrpcCode?: number;
  requiredCapabilities?: string[];
  remedy?: ErrorRecord["remedy"];
  details?: unknown;
}): ErrorRecord {
  return {
    record_schema: "atlas.error:v1",
    code: input.code,
    message: input.message,
    retryable: input.retryable,
    ...(input.jsonrpcCode === undefined ? {} : { jsonrpc_code: input.jsonrpcCode }),
    ...(input.requiredCapabilities === undefined ? {} : { required_capabilities: input.requiredCapabilities }),
    ...(input.remedy === undefined ? {} : { remedy: input.remedy }),
    ...(input.details === undefined ? {} : { details: input.details })
  };
}

export type PageBlock = {
  page_size: number;
  has_more: boolean;
  cursor: string | null;
  snapshot?: string;
  snapshot_expires_at?: RecordedAt;
  feed_handoff?: { tool: string; cursor_seq: number };
};

/**
 * Clamp to the cap that applies to this call.
 *
 * `maximum` is the published cap narrowed by the caller's grant, and it is a
 * required argument rather than a default: a default would let a new call site
 * silently answer with the contract's cap for a credential granted less. A
 * transport may not narrow the published cap and a caller may not raise it —
 * only a grant narrows, and only through this number.
 *
 * The default page size is clamped too. A grant capping pages at 5 must not
 * yield 50 just because the caller said nothing.
 */
export function resolvePageSize(requested: number | undefined, maximum: number): number {
  if (requested === undefined) return Math.min(CONTRACT_LIMITS.default_page_size, maximum);
  return Math.min(Math.max(requested, 1), maximum);
}
