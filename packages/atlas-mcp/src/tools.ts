import {
  CONTRACT_HISTORY,
  CONTRACT_LIMITS,
  CONTRACT_POLICY_DOCUMENT,
  CONTRACT_PROTOCOL_VERSION,
  CONTRACT_REVISION,
  CONTRACT_TOOL_NAMES,
  type ContractToolName
} from "@living-atlas/atlas-contract";
import {
  DEFAULT_ASSERTION_SENSITIVITY,
  canonicalRecordedAt,
  validTimeFidelity,
  type Assertion,
  type EntityId,
  type RecordedAt
} from "@living-atlas/atlas-core";
import { decideAssertion, decideEntity, maySupersede, redactionId } from "./access.js";
import { effectiveLimit, mayWritePredicate, mayWriteTier, permittedTools } from "./grant.js";
import { functionalPredicates } from "./graph.js";
import { ceilingOf, type Principal } from "./principal.js";
import { ERROR_CODES } from "./vocabulary.js";
import type { ToolContext, ToolHandler, ToolOutcome } from "./tool-context.js";
import {
  cacheBlock,
  coverage,
  errorRecord,
  horizon,
  resolvePageSize,
  type CoverageTally,
  type PageBlock
} from "./results.js";

/**
 * The 12 consumer tools.
 *
 * Every handler ends the same way: it returns a structure and the counts for
 * the ONE audit event the dispatcher writes. No handler writes to a log, and no
 * handler decides on its own whether a record's content may leave — that is
 * `access.ts`, called per record, in code.
 */

// ---------------------------------------------------------------------------
// small shared pieces
// ---------------------------------------------------------------------------

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function int(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function encodeToken(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeToken(token: string): unknown {
  try {
    return JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

type Snapshot = { r: RecordedAt; w: number; e: string; x: RecordedAt };

function isSnapshot(value: unknown): value is Snapshot {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["r"] === "string" &&
    typeof candidate["w"] === "number" &&
    typeof candidate["e"] === "string" &&
    typeof candidate["x"] === "string"
  );
}

/**
 * A page's snapshot pin: the belief instant, the seq watermark, and the epoch.
 *
 * Pages 2..N MUST echo it. Without it a later page is computed against newer
 * state, so the sequence silently skips and repeats rows — a defect that is
 * invisible to the consumer, which is why the pin is mandatory rather than
 * advisory and why expiry is a typed refusal rather than a fallback to fresh
 * state.
 */
function mintSnapshot(context: ToolContext, asOfRecorded: RecordedAt | undefined): Snapshot {
  const now = context.now.getTime();
  return {
    r: asOfRecorded ?? canonicalRecordedAt(context.now),
    w: highestSeq(context),
    e: context.graph.assertions.feedEpoch,
    x: canonicalRecordedAt(new Date(now + CONTRACT_LIMITS.snapshot_ttl_seconds * 1000))
  };
}

function highestSeq(context: ToolContext): number {
  const page = context.graph.assertions.query({});
  if (!page.ok) return 0;
  return page.hits.reduce((highest, hit) => Math.max(highest, hit.assertion.seq), 0);
}

type PagingState =
  | { ok: true; offset: number; snapshot: Snapshot }
  | { ok: false; code: "snapshot-expired" | "snapshot-invalid" | "cursor-invalid"; message: string };

/**
 * Resolve `{cursor, snapshot}` into an offset and a pin.
 *
 * A cursor without its snapshot is refused rather than served from current
 * state: serving it is the silent skip-and-repeat, and a caller cannot detect
 * that it happened.
 */
function resolvePaging(args: Record<string, unknown>, context: ToolContext, asOfRecorded: RecordedAt | undefined): PagingState {
  const cursor = str(args["cursor"]);
  const token = str(args["snapshot"]);

  if (!cursor && !token) return { ok: true, offset: 0, snapshot: mintSnapshot(context, asOfRecorded) };

  if (!token) {
    return {
      ok: false,
      code: "snapshot-invalid",
      message: "A cursor must be echoed together with the snapshot token page 1 returned. Without the pin, later pages are computed against newer state and the sequence silently skips and repeats rows."
    };
  }

  const decoded = decodeToken(token);
  if (!isSnapshot(decoded)) {
    return { ok: false, code: "snapshot-invalid", message: "The snapshot token is not one this server minted." };
  }
  if (decoded.x < canonicalRecordedAt(context.now)) {
    return {
      ok: false,
      code: "snapshot-expired",
      message: `The snapshot pin expired at ${decoded.x}. Restart the read; resuming against newer state would produce a page sequence that skips and repeats rows.`
    };
  }

  let offset = 0;
  if (cursor) {
    const parsed = decodeToken(cursor);
    const candidate =
      typeof parsed === "object" && parsed !== null ? int((parsed as Record<string, unknown>)["o"]) : undefined;
    if (candidate === undefined || candidate < 0) {
      return { ok: false, code: "cursor-invalid", message: "The cursor is not one this server issued." };
    }
    offset = candidate;
  }
  return { ok: true, offset, snapshot: decoded };
}

function pageBlock(input: {
  pageSize: number;
  offset: number;
  total: number;
  snapshot: Snapshot;
  feedHandoff?: { tool: string; cursor_seq: number };
}): PageBlock {
  const nextOffset = input.offset + input.pageSize;
  const hasMore = nextOffset < input.total;
  return {
    page_size: input.pageSize,
    has_more: hasMore,
    cursor: hasMore ? encodeToken({ o: nextOffset }) : null,
    snapshot: encodeToken(input.snapshot),
    snapshot_expires_at: input.snapshot.x,
    ...(input.feedHandoff && !hasMore ? { feed_handoff: input.feedHandoff } : {})
  };
}

function emptyTally(): CoverageTally {
  return { evaluated: 0, matched: 0, returned: 0, withheld: 0, with_valid_time: 0, unknown_or_absent_valid_time: 0 };
}

function horizonFor(context: ToolContext, input: { asOfRecorded?: RecordedAt; asOfValid?: string; fidelityMixed: boolean; status?: "complete" | "partial" | "unknowable" }) {
  return horizon({
    ...(input.status === undefined ? {} : { status: input.status }),
    bitemporalSince: context.graph.assertions.bitemporalSince,
    feedEpoch: context.graph.assertions.feedEpoch,
    seqWatermark: highestSeq(context),
    ...(input.asOfRecorded === undefined ? {} : { asOfRecorded: input.asOfRecorded }),
    ...(input.asOfValid === undefined ? {} : { asOfValid: input.asOfValid }),
    fidelityMixed: input.fidelityMixed,
    now: context.now
  });
}

/** A read that hit the belief-time floor. Refused, never answered from present state. */
function historyFloorRefusal(context: ToolContext, asOf: string): ToolOutcome {
  return {
    kind: "refusal",
    error: errorRecord({
      code: "as-of-before-history-floor",
      message: `Atlas retains no belief-time history before ${context.graph.assertions.bitemporalSince}, so ${asOf} cannot be answered. This is refused rather than answered from present state.`,
      retryable: false,
      details: { bitemporal_since: context.graph.assertions.bitemporalSince, requested: asOf }
    }),
    audit: { outcome: "refused", reasonCode: "as-of-before-history-floor", counts: {} }
  };
}

/** Merge the read-context fields onto an assertion record without mutating the stored one. */
function assertionRecord(hit: {
  assertion: Assertion;
  valid_time_fidelity: string;
  match_quality?: string | undefined;
}): Record<string, unknown> {
  return {
    ...hit.assertion,
    valid_time_fidelity: hit.valid_time_fidelity,
    ...(hit.match_quality === undefined ? {} : { match_quality: hit.match_quality })
  };
}

// ---------------------------------------------------------------------------
// atlas.contract.describe.v1
// ---------------------------------------------------------------------------

const describeContract: ToolHandler = (args, context) => {
  const asked = str(args["revision"]);
  if (asked !== undefined && asked !== CONTRACT_REVISION) {
    // A revision this server does not serve is a typed refusal, never a silent
    // substitution: answering the current revision to a caller that named an
    // older one is how a consumer validates against a document it never read.
    return {
      kind: "refusal",
      error: errorRecord({
        code: "revision-not-served",
        message: `This server serves contract revision ${CONTRACT_REVISION}, not ${asked}.`,
        retryable: false,
        remedy: { tool: "atlas.contract.describe.v1", note: "Call with no revision to get the one this server serves." },
        details: { revisions_served: [CONTRACT_REVISION] }
      }),
      audit: { outcome: "refused", reasonCode: "revision-not-served", counts: {} }
    };
  }

  const manifest = context.contract.manifest;
  return {
    kind: "complete",
    structured: {
      revision: manifest.contract_revision,
      revisions_served: [CONTRACT_REVISION],
      protocol_version: CONTRACT_PROTOCOL_VERSION,
      policy_document: CONTRACT_POLICY_DOCUMENT,
      history: {
        ...CONTRACT_HISTORY,
        bitemporal_since: context.graph.assertions.bitemporalSince,
        feed_epoch: context.graph.assertions.feedEpoch,
        retention_floor_seq: context.graph.assertions.changesSince(Number.MAX_SAFE_INTEGER, 0).retention_floor_seq,
        change_feed_floor_days: CONTRACT_LIMITS.change_feed_floor_days
      },
      limits: { ...CONTRACT_LIMITS },
      tools: manifest.tools.map((tool) => ({
        name: tool.name,
        title: tool.title,
        input_schema_id: tool.input_schema_id,
        output_schema_id: tool.output_schema_id,
        requires_capabilities: [...tool.requires_capabilities],
        deprecation: tool.deprecation === null ? null : { ...tool.deprecation, replacement_tool: tool.deprecation.replacement }
      })),
      record_schemas: manifest.record_schemas.map((entry) => ({
        name: entry.name,
        schema_id: entry.schema_id,
        // The path a consumer fetches, alongside the id it resolves. Publishing
        // only the id would leave a consumer holding a `urn:` it cannot
        // dereference — which is the whole point of the URN, and exactly why
        // the path has to be published next to it.
        schema_path: entry.schema
      })),
      // The LIVE registries. A consumer validates against this answer, not
      // against the `x-atlas-known-values` hint frozen into the schema when the
      // contract shipped: an open vocabulary is the graph's to grow.
      vocabularies: {
        predicate: context.graph.predicateRegistry().map((entry) => ({ ...entry })),
        entity_subtype: entitySubtypes(context),
        error_code: ERROR_CODES.map((entry) => ({ ...entry }))
      },
      deprecations: manifest.deprecations,
      cache: cacheBlock(cacheTtl(context, "atlas.contract.describe.v1"))
    },
    audit: { outcome: "ok", counts: {} }
  };
};

/**
 * The open half of the two-layer entity typing scheme.
 *
 * A kind of thing added in 2031 reaches a 2026 consumer as type `other` plus a
 * label it can display, never as a token it might branch on by accident. The
 * labels in use are a property of the graph, so they are read from it rather
 * than listed anywhere.
 */
function entitySubtypes(context: ToolContext): string[] {
  const labels = new Set<string>();
  for (const entity of context.graph.searchableEntities()) {
    if (entity.type_label !== undefined) labels.add(entity.type_label);
  }
  return [...labels].sort();
}

function cacheTtl(context: ToolContext, name: ContractToolName): number {
  return context.contract.manifest.tools.find((tool) => tool.name === name)?.cache.ttl_ms ?? 0;
}

/**
 * The limits that apply to one credential: the published caps, narrowed.
 *
 * Computed in ONE place and both published (`atlas.scope.describe.v1`) and
 * enforced (`resolvePageSize`) from it. The old surface's defect was two
 * numbers for the same limit — `LocalBatchMaxItems = 100` against
 * `RemoteBatchMaxItems = 10` — with no way for a caller to discover which
 * applied. A grant that narrows is fine; a narrowing a caller cannot read back
 * is the same defect wearing a different name.
 */
export function effectiveLimits(principal: Principal): {
  max_page_size: number;
  max_ids_per_request: number;
  max_batch_items: number;
} {
  const limits = principal.grant.limits;
  return {
    max_page_size: effectiveLimit(CONTRACT_LIMITS.max_page_size, limits.max_page_size),
    max_ids_per_request: effectiveLimit(CONTRACT_LIMITS.max_ids_per_request, limits.max_ids_per_request),
    max_batch_items: effectiveLimit(CONTRACT_LIMITS.max_batch_items, limits.max_batch_items)
  };
}

// ---------------------------------------------------------------------------
// atlas.scope.describe.v1
// ---------------------------------------------------------------------------

const describeScope: ToolHandler = (_args, context) => {
  const principal = context.principal;
  const grant = principal.grant;
  return {
    kind: "complete",
    structured: {
      client_id: principal.client_id,
      credential_class: principal.credential_class,
      plane: principal.plane,
      grant_id: grant.grant_id,
      // The same computation `tools/list` runs, from the same grant against the
      // same published order. Two answers that could disagree about what this
      // credential may call would leave a consumer with no way to tell which
      // one to believe.
      tools_available: permittedTools(grant, principal.plane, CONTRACT_TOOL_NAMES),
      sensitivity_reachable: grant.sensitivity_reachable,
      sensitivity_ceiling: ceilingOf(principal),
      predicates_writable: grant.predicates_writable,
      write_tiers_permitted: grant.write_tiers_permitted,
      limits: effectiveLimits(principal),
      coverage_counts_basis: grant.coverage_counts_basis,
      supersession_scope: grant.supersession_scope,
      reveal_available: grant.reveal_available,
      // Echoed from the request envelope, not from a server-side guess. A
      // consumer debugging a capability refusal needs to see what the server
      // actually received, which is frequently not what the harness intended.
      declared_client_capabilities: Object.keys(context.clientCapabilities).sort(),
      horizon: horizonFor(context, { fidelityMixed: false }),
      cache: cacheBlock(cacheTtl(context, "atlas.scope.describe.v1"))
    },
    audit: { outcome: "ok", counts: {} }
  };
};

// ---------------------------------------------------------------------------
// atlas.entity.resolve.v1
// ---------------------------------------------------------------------------

const resolveEntities: ToolHandler = (args, context) => {
  const ids = strArray(args["ids"]);
  const asOfRecorded = str(args["as_of_recorded"]);
  if (asOfRecorded && asOfRecorded < context.graph.assertions.bitemporalSince) {
    return historyFloorRefusal(context, asOfRecorded);
  }

  const tally = emptyTally();
  const resolutions = ids.map((requested) => {
    tally.evaluated += 1;
    const resolution = context.graph.entities.resolve(requested);
    if (resolution.ok) {
      const decision = decideEntity(resolution.entity, context.principal);
      tally.matched += 1;
      tally.returned += 1;
      if (!decision.allowed) tally.withheld += 1;
      return {
        requested_id: requested,
        outcome: "resolved",
        entity: decision.allowed ? decision.record : decision.stub,
        redirect_chain: resolution.redirect_chain,
        ...(resolution.redirect_reason === undefined ? {} : { redirect_reason: resolution.redirect_reason })
      };
    }

    tally.returned += 1;
    const chain = "redirect_chain" in resolution ? resolution.redirect_chain : [requested];
    return {
      requested_id: requested,
      outcome: resolution.code,
      redirect_chain: chain,
      // An id that split names its candidates and no primary. Nominating one
      // would silently reattribute every historical reference to it.
      ...("candidate_ids" in resolution ? { candidate_ids: resolution.candidate_ids } : {}),
      ...("disposition" in resolution ? { disposition: resolution.disposition } : {}),
      error: errorRecord({ code: resolution.code, message: resolution.message, retryable: false })
    };
  });

  return {
    kind: "complete",
    structured: {
      resolutions,
      coverage: coverage(context.principal, tally),
      horizon: horizonFor(context, {
        ...(asOfRecorded === undefined ? {} : { asOfRecorded: asOfRecorded as RecordedAt }),
        fidelityMixed: false
      }),
      cache: cacheBlock(cacheTtl(context, "atlas.entity.resolve.v1"))
    },
    audit: { outcome: "ok", counts: { evaluated: tally.evaluated, returned: tally.returned, withheld: tally.withheld }, subjects: ids }
  };
};

// ---------------------------------------------------------------------------
// atlas.entity.read.v1
// ---------------------------------------------------------------------------

const readEntities: ToolHandler = (args, context) => {
  const ids = strArray(args["entity_ids"]);
  const asOfRecorded = str(args["as_of_recorded"]);
  if (asOfRecorded && asOfRecorded < context.graph.assertions.bitemporalSince) {
    return historyFloorRefusal(context, asOfRecorded);
  }

  const tally = emptyTally();
  const results = ids.map((id) => {
    tally.evaluated += 1;
    tally.returned += 1;
    const entity = context.graph.entities.read(id as EntityId);
    if (!entity) {
      // A redirect is NOT followed here. Conflating read with resolve is how a
      // consumer stops noticing that the thing it asked about was merged away.
      return errorRecord({
        code: "unknown-id",
        message: `No entity is registered under ${id}. If this id may have been merged or split, ask atlas.entity.resolve.v1 — this tool deliberately does not follow redirects.`,
        retryable: false,
        remedy: { tool: "atlas.entity.resolve.v1", arguments_hint: { ids: [id] } }
      });
    }
    tally.matched += 1;
    const decision = decideEntity(entity, context.principal);
    if (decision.allowed) return decision.record;
    tally.withheld += 1;
    return decision.stub;
  });

  return {
    kind: "complete",
    structured: {
      results,
      coverage: coverage(context.principal, tally),
      horizon: horizonFor(context, {
        ...(asOfRecorded === undefined ? {} : { asOfRecorded: asOfRecorded as RecordedAt }),
        fidelityMixed: false
      }),
      cache: cacheBlock(cacheTtl(context, "atlas.entity.read.v1"))
    },
    audit: { outcome: "ok", counts: { evaluated: tally.evaluated, returned: tally.returned, withheld: tally.withheld }, subjects: ids }
  };
};

// ---------------------------------------------------------------------------
// atlas.assertion.query.v1
// ---------------------------------------------------------------------------

const queryAssertions: ToolHandler = (args, context) => {
  const asOfRecorded = str(args["as_of_recorded"]);
  const asOfValid = str(args["as_of_valid"]);
  const page = context.graph.assertions.query({
    ...(str(args["subject_entity_id"]) === undefined ? {} : { subject_entity_id: str(args["subject_entity_id"]) as string }),
    ...(str(args["predicate"]) === undefined ? {} : { predicate: str(args["predicate"]) as string }),
    ...(asOfRecorded === undefined ? {} : { as_of_recorded: asOfRecorded as RecordedAt }),
    ...(asOfValid === undefined ? {} : { as_of_valid: asOfValid }),
    // Passed through rather than ignored. It is a PUBLISHED input on this tool,
    // and a declared parameter the handler silently drops is worse than one that
    // was never offered: the caller receives an answer to a question it did not
    // ask and has no way to tell.
    include_superseded: bool(args["include_superseded"], false)
  });

  if (!page.ok) return historyFloorRefusal(context, asOfRecorded ?? "");

  const targetFilter = str(args["target_entity_id"]);
  const kindFilter = str(args["kind"]);
  const hits = page.hits.filter((hit) => {
    if (targetFilter && hit.assertion.target_entity_id !== targetFilter) return false;
    if (kindFilter && hit.assertion.kind !== kindFilter) return false;
    return true;
  });

  const paging = resolvePaging(args, context, asOfRecorded as RecordedAt | undefined);
  if (!paging.ok) {
    return {
      kind: "refusal",
      error: errorRecord({
        code: paging.code,
        message: paging.message,
        retryable: false,
        remedy: { tool: "atlas.assertion.query.v1", note: "Restart the read from page 1." }
      }),
      audit: { outcome: "refused", reasonCode: paging.code, counts: {} }
    };
  }

  const pageSize = resolvePageSize(int(args["page_size"]), effectiveLimits(context.principal).max_page_size);
  const slice = hits.slice(paging.offset, paging.offset + pageSize);

  const tally = emptyTally();
  tally.evaluated = page.coverage.evaluated;
  tally.matched = hits.length;
  const results = slice.map((hit) => {
    tally.returned += 1;
    const fidelity = hit.valid_time_fidelity;
    if (fidelity === "exact" || fidelity === "approximate") tally.with_valid_time += 1;
    else tally.unknown_or_absent_valid_time += 1;
    const decision = decideAssertion(hit.assertion, context.principal);
    if (decision.allowed) return assertionRecord(hit);
    tally.withheld += 1;
    return decision.stub;
  });

  return {
    kind: "complete",
    structured: {
      results,
      contested: contestedGroups(slice.map((hit) => hit.assertion), context),
      page: pageBlock({
        pageSize,
        offset: paging.offset,
        total: hits.length,
        snapshot: paging.snapshot,
        // Bootstrap-then-follow with no gap and no overlap: the last page of a
        // full scan names the exact seq the scan covered.
        ...(bool(args["full_scan"], false)
          ? { feedHandoff: { tool: "atlas.changes.read.v1", cursor_seq: paging.snapshot.w } }
          : {})
      }),
      coverage: coverage(context.principal, tally),
      horizon: horizonFor(context, {
        ...(asOfRecorded === undefined ? {} : { asOfRecorded: asOfRecorded as RecordedAt }),
        ...(asOfValid === undefined ? {} : { asOfValid }),
        fidelityMixed: page.recorded_at_fidelity_mixed
      }),
      cache: cacheBlock(cacheTtl(context, "atlas.assertion.query.v1"))
    },
    audit: {
      outcome: "ok",
      counts: { evaluated: tally.evaluated, returned: tally.returned, withheld: tally.withheld }
      // No `subjects`: a query names filters, not ids. Listing what the query
      // FOUND is the unbounded-log defect.
    }
  };
};

/**
 * Two live assertions on one FUNCTIONAL key are a contradiction.
 *
 * Both are returned, neither is superseded, and Atlas does not pick. Two
 * overlapping multi-valued assertions are two facts and never appear here,
 * which is why the functional set comes from the graph rather than being
 * assumed.
 */
function contestedGroups(assertions: Assertion[], context: ToolContext): Record<string, unknown>[] {
  const functional = functionalPredicates(context.graph);
  const groups = new Map<string, Assertion[]>();
  for (const assertion of assertions) {
    if (assertion.superseded_at !== null) continue;
    if (!functional.has(assertion.predicate)) continue;
    const key = `${assertion.subject_entity_id}\u0000${assertion.predicate}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(assertion);
    else groups.set(key, [assertion]);
  }

  const contested: Record<string, unknown>[] = [];
  for (const bucket of groups.values()) {
    if (bucket.length < 2) continue;
    const first = bucket[0];
    if (!first) continue;
    contested.push({
      subject_entity_id: first.subject_entity_id,
      predicate: first.predicate,
      cardinality: "functional",
      assertion_ids: bucket.map((assertion) => assertion.assertion_id),
      claim_digests: [...new Set(bucket.map((assertion) => assertion.claim_digest))]
    });
  }
  return contested;
}

// ---------------------------------------------------------------------------
// atlas.assertion.read.v1
// ---------------------------------------------------------------------------

const readAssertions: ToolHandler = (args, context) => {
  const ids = strArray(args["assertion_ids"]);
  const includeLineage = bool(args["include_lineage"], false);

  const tally = emptyTally();
  const results: unknown[] = [];
  const lineage: Record<string, unknown>[] = [];
  const reclamations: Record<string, unknown>[] = [];

  for (const id of ids) {
    tally.evaluated += 1;
    tally.returned += 1;
    const assertion = context.graph.assertions.read(id);
    if (!assertion) {
      const note = context.graph.assertions.readReclamation(id);
      if (note) {
        // A reclaimed id resolves to its note, never to a bare not-found:
        // otherwise a dangling reference and a typo look the same.
        reclamations.push({ assertion_id: id, note });
        results.push(
          errorRecord({
            code: "assertion-reclaimed",
            message: `Assertion ${id} was reclaimed by compaction at ${note.reclaimed_at}. It existed; its content is no longer retained.`,
            retryable: false,
            details: note
          })
        );
        continue;
      }
      results.push(errorRecord({ code: "unknown-id", message: `No assertion was ever minted under ${id}.`, retryable: false }));
      continue;
    }

    tally.matched += 1;
    const fidelity = validTimeFidelity({ from: assertion.valid_from, to: assertion.valid_to });
    if (fidelity === "exact" || fidelity === "approximate") tally.with_valid_time += 1;
    else tally.unknown_or_absent_valid_time += 1;

    const decision = decideAssertion(assertion, context.principal);
    if (decision.allowed) results.push(assertionRecord({ assertion, valid_time_fidelity: fidelity }));
    else {
      tally.withheld += 1;
      results.push(decision.stub);
    }

    // Lineage is structure, not content: it is reported for a withheld record
    // too, because "this was superseded by something" is exactly what a
    // consumer needs to stop trusting a stale id, and it discloses no value.
    if (includeLineage) {
      lineage.push({
        assertion_id: assertion.assertion_id,
        supersedes: assertion.supersedes,
        superseded_by: assertion.superseded_by,
        lineage_action: assertion.lineage_action
      });
    }
  }

  return {
    kind: "complete",
    structured: {
      results,
      ...(includeLineage ? { lineage } : {}),
      ...(reclamations.length > 0 ? { reclamations } : {}),
      coverage: coverage(context.principal, tally),
      horizon: horizonFor(context, { fidelityMixed: false }),
      cache: cacheBlock(cacheTtl(context, "atlas.assertion.read.v1"))
    },
    audit: { outcome: "ok", counts: { evaluated: tally.evaluated, returned: tally.returned, withheld: tally.withheld }, subjects: ids }
  };
};

// ---------------------------------------------------------------------------
// atlas.graph.neighbors.v1
// ---------------------------------------------------------------------------

const walkNeighbors: ToolHandler = (args, context) => {
  const origin = str(args["entity_id"]);
  if (!origin) {
    return {
      kind: "refusal",
      error: errorRecord({ code: "invalid-argument", message: "entity_id is required.", retryable: false }),
      audit: { outcome: "refused", reasonCode: "invalid-argument", counts: {} }
    };
  }
  const asOfRecorded = str(args["as_of_recorded"]);
  if (asOfRecorded && asOfRecorded < context.graph.assertions.bitemporalSince) {
    return historyFloorRefusal(context, asOfRecorded);
  }

  const direction = (str(args["direction"]) ?? "outbound") as "outbound" | "inbound" | "both";
  const maxDepth = Math.min(int(args["max_depth"]) ?? 1, CONTRACT_LIMITS.max_traversal_depth);
  const predicates = new Set(strArray(args["predicates"]));
  const asOfValid = str(args["as_of_valid"]);

  const page = context.graph.assertions.query({
    ...(asOfRecorded === undefined ? {} : { as_of_recorded: asOfRecorded as RecordedAt }),
    ...(asOfValid === undefined ? {} : { as_of_valid: asOfValid })
  });
  if (!page.ok) return historyFloorRefusal(context, asOfRecorded ?? "");

  const relationships = page.hits.filter((hit) => hit.assertion.kind === "relationship" && hit.assertion.target_entity_id);

  const tally = emptyTally();
  tally.evaluated = page.coverage.evaluated;
  const nodes: unknown[] = [];
  const edges: unknown[] = [];
  const seenNodes = new Set<string>();
  const seenEdges = new Set<string>();
  let deepest = 0;
  let truncatedBy: "max_depth" | "page_size" | "policy" | null = null;

  const pushNode = (entityId: string): void => {
    if (seenNodes.has(entityId)) return;
    seenNodes.add(entityId);
    const entity = context.graph.entities.read(entityId as EntityId);
    if (!entity) return;
    const decision = decideEntity(entity, context.principal);
    if (decision.allowed) nodes.push(decision.record);
    else {
      tally.withheld += 1;
      // A skipped node still occupies a row, so the shape of what was not
      // reachable stays visible rather than the walk looking smaller than it is.
      truncatedBy = truncatedBy ?? "policy";
      nodes.push(decision.stub);
    }
  };

  pushNode(origin);
  let frontier: string[] = [origin];
  const pageSize = resolvePageSize(int(args["page_size"]), effectiveLimits(context.principal).max_page_size);

  for (let depth = 1; depth <= maxDepth; depth += 1) {
    const next: string[] = [];
    for (const current of frontier) {
      for (const hit of relationships) {
        const assertion = hit.assertion;
        const target = assertion.target_entity_id;
        if (!target) continue;
        if (predicates.size > 0 && !predicates.has(assertion.predicate)) continue;

        const outbound = assertion.subject_entity_id === current;
        const inbound = target === current;
        if (direction === "outbound" && !outbound) continue;
        if (direction === "inbound" && !inbound) continue;
        if (direction === "both" && !outbound && !inbound) continue;
        if (seenEdges.has(assertion.assertion_id)) continue;

        if (edges.length >= pageSize) {
          truncatedBy = truncatedBy ?? "page_size";
          break;
        }

        seenEdges.add(assertion.assertion_id);
        tally.matched += 1;
        tally.returned += 1;
        const decision = decideAssertion(assertion, context.principal);
        if (decision.allowed) edges.push(assertionRecord(hit));
        else {
          tally.withheld += 1;
          truncatedBy = truncatedBy ?? "policy";
          edges.push(decision.stub);
        }

        const other = outbound ? target : assertion.subject_entity_id;
        pushNode(other);
        next.push(other);
      }
    }
    if (next.length === 0) break;
    deepest = depth;
    frontier = next;
  }

  if (truncatedBy === null && deepest >= maxDepth && frontier.length > 0) truncatedBy = "max_depth";

  return {
    kind: "complete",
    structured: {
      nodes,
      edges,
      traversal: {
        origin_entity_id: origin,
        direction,
        max_depth: maxDepth,
        deepest_reached: deepest,
        truncated_by: truncatedBy
      },
      page: pageBlock({ pageSize, offset: 0, total: edges.length, snapshot: mintSnapshot(context, asOfRecorded as RecordedAt | undefined) }),
      coverage: coverage(context.principal, tally),
      horizon: horizonFor(context, {
        ...(asOfRecorded === undefined ? {} : { asOfRecorded: asOfRecorded as RecordedAt }),
        ...(asOfValid === undefined ? {} : { asOfValid }),
        fidelityMixed: page.recorded_at_fidelity_mixed,
        status: truncatedBy === null ? "complete" : "partial"
      }),
      cache: cacheBlock(cacheTtl(context, "atlas.graph.neighbors.v1"))
    },
    audit: {
      outcome: "ok",
      counts: { evaluated: tally.evaluated, returned: tally.returned, withheld: tally.withheld },
      subjects: [origin]
    }
  };
};

// ---------------------------------------------------------------------------
// atlas.text.search.v1
// ---------------------------------------------------------------------------

/**
 * A deterministic scorer: substring hits, weighted by where they landed.
 *
 * Deterministic rather than ranked-by-model because the contract publishes
 * `scorer: "deterministic-text"` and a consumer is entitled to a repeatable
 * order. Two runs over unchanged data return the same list.
 */
function scoreText(haystack: string, needle: string): number {
  const hay = haystack.toLowerCase();
  const query = needle.toLowerCase();
  if (hay === query) return 1;
  if (hay.startsWith(query)) return 0.8;
  if (hay.includes(query)) return 0.5;
  return 0;
}

const searchText: ToolHandler = (args, context) => {
  const query = str(args["query"]);
  if (!query) {
    return {
      kind: "refusal",
      error: errorRecord({ code: "invalid-argument", message: "query is required and must be non-empty.", retryable: false }),
      audit: { outcome: "refused", reasonCode: "invalid-argument", counts: {} }
    };
  }
  const types = new Set(strArray(args["entity_types"]));

  const tally = emptyTally();
  const scored: { score: number; match_basis: string; record: unknown; withheld: boolean }[] = [];

  for (const entity of context.graph.searchableEntities()) {
    tally.evaluated += 1;
    if (types.size > 0 && !types.has(entity.type)) continue;

    const nameScore = scoreText(entity.display_name, query);
    const akaScore = Math.max(0, ...entity.also_known_as.map((alias) => scoreText(alias, query)));
    const score = Math.max(nameScore, akaScore);
    if (score === 0) continue;

    tally.matched += 1;
    const decision = decideEntity(entity, context.principal);
    scored.push({
      score,
      match_basis: nameScore >= akaScore ? "display-name" : "also-known-as",
      record: decision.allowed ? decision.record : decision.stub,
      withheld: !decision.allowed
    });
  }

  // Ties break on a stable key so two runs over unchanged data agree.
  scored.sort((left, right) => right.score - left.score || rank(left.record) - rank(right.record));

  const paging = resolvePaging(args, context, undefined);
  if (!paging.ok) {
    return {
      kind: "refusal",
      error: errorRecord({ code: paging.code, message: paging.message, retryable: false }),
      audit: { outcome: "refused", reasonCode: paging.code, counts: {} }
    };
  }
  const pageSize = resolvePageSize(int(args["page_size"]), effectiveLimits(context.principal).max_page_size);
  const slice = scored.slice(paging.offset, paging.offset + pageSize);
  for (const entry of slice) {
    tally.returned += 1;
    if (entry.withheld) tally.withheld += 1;
  }

  return {
    kind: "complete",
    structured: {
      results: slice.map((entry) => ({ score: entry.score, match_basis: entry.match_basis, record: entry.record })),
      search_scope: {
        scorer: "deterministic-text",
        plaintext_candidates: tally.evaluated,
        // Reported, never silently excluded. The prior remote path filtered to
        // plaintext with score > 0 and reported nothing, so an encrypted match
        // was indistinguishable from no match.
        encrypted_unsearchable: context.graph.encryptedUnsearchable(),
        counts_basis: context.principal.grant.coverage_counts_basis
      },
      page: pageBlock({ pageSize, offset: paging.offset, total: scored.length, snapshot: paging.snapshot }),
      coverage: coverage(context.principal, tally),
      horizon: horizonFor(context, { fidelityMixed: false }),
      cache: cacheBlock(cacheTtl(context, "atlas.text.search.v1"))
    },
    // The query string is NOT a subject: it is frequently the most sensitive
    // string in the request, and it is already covered by arguments_digest.
    audit: { outcome: "ok", counts: { evaluated: tally.evaluated, returned: tally.returned, withheld: tally.withheld } }
  };
};

function rank(record: unknown): number {
  if (typeof record !== "object" || record === null) return 0;
  const id = (record as Record<string, unknown>)["entity_id"];
  return typeof id === "string" ? id.charCodeAt(id.length - 1) : 0;
}

// ---------------------------------------------------------------------------
// atlas.changes.read.v1
// ---------------------------------------------------------------------------

const readChanges: ToolHandler = (args, context) => {
  const cursorSeq = int(args["cursor_seq"]) ?? 0;
  const requestedEpoch = str(args["feed_epoch"]);
  const limit = resolvePageSize(int(args["limit"]), effectiveLimits(context.principal).max_page_size);
  const includeRecords = bool(args["include_records"], false);

  if (requestedEpoch !== undefined && requestedEpoch !== context.graph.assertions.feedEpoch) {
    // A mismatch fails loudly rather than resuming into a different total order.
    return {
      kind: "refusal",
      error: errorRecord({
        code: "feed-epoch-mismatch",
        message: `Your cursor is from feed epoch ${requestedEpoch}; this feed is on ${context.graph.assertions.feedEpoch}. Every cursor from the prior epoch is invalid.`,
        retryable: false,
        remedy: { tool: "atlas.assertion.query.v1", arguments_hint: { full_scan: true }, note: "Re-scan, then resume from the handoff seq on the final page." }
      }),
      audit: { outcome: "refused", reasonCode: "feed-epoch-mismatch", counts: {} }
    };
  }

  const feed = context.graph.assertions.changesSince(cursorSeq, limit);
  let withheld = 0;
  const changes = feed.changes.map((assertion) => {
    const base = {
      record_schema: "atlas.change:v1" as const,
      // Stable across redeliveries of the same change: seq and epoch identify
      // it, and both are immutable once written.
      change_id: `la_change_${assertion.feed_epoch}_${assertion.seq}`,
      seq: assertion.seq,
      feed_epoch: assertion.feed_epoch,
      recorded_at: assertion.recorded_at,
      change_kind: "assertion-committed" as const,
      assertion_id: assertion.assertion_id
    };
    if (!includeRecords) return base;
    const decision = decideAssertion(assertion, context.principal);
    if (decision.allowed) return { ...base, record: assertion };
    withheld += 1;
    // A record this credential may not read arrives as a stub, so the feed's
    // seq sequence stays gapless.
    return { ...base, record: decision.stub };
  });

  return {
    kind: "complete",
    structured: {
      changes,
      next_cursor_seq: feed.next_cursor,
      has_more: feed.has_more,
      feed_epoch: feed.feed_epoch,
      retention_floor_seq: feed.retention_floor_seq,
      cursor_before_retention_floor: feed.cursor_before_retention_floor,
      ...(feed.cursor_before_retention_floor
        ? {
            error: errorRecord({
              code: "cursor-before-retention-floor",
              message: `Cursor ${cursorSeq} predates retained history (floor ${feed.retention_floor_seq}), so this page is missing changes that once existed.`,
              retryable: false,
              remedy: { tool: "atlas.assertion.query.v1", arguments_hint: { full_scan: true } }
            })
          }
        : {}),
      horizon: horizonFor(context, { fidelityMixed: false }),
      cache: cacheBlock(cacheTtl(context, "atlas.changes.read.v1"))
    },
    audit: { outcome: "ok", counts: { returned: changes.length, withheld } }
  };
};

// ---------------------------------------------------------------------------
// atlas.assertion.propose.v1
// ---------------------------------------------------------------------------

/**
 * The sensitivity tier a consumer submission is stamped with.
 *
 * READ from atlas-core's default rather than restated, because the store is
 * what actually stamps it: a constant here that said `open` while `commit`
 * wrote `local-private` would make this grant check enforce a tier nothing is
 * ever written at. That is the shape of the defect, not a hypothetical — the
 * two were `open` here and `open` there, both contradicting AGENTS.md's
 * "default new content to `local-private`", with nothing tying them together.
 *
 * The published input schema gives a consumer no way to name a tier, so this is
 * the only tier this plane can write at today. Named so the grant check has
 * something concrete to enforce, and so a later revision that lets a caller
 * choose finds the refusal already in place.
 */
const COMMIT_TIER: string = DEFAULT_ASSERTION_SENSITIVITY.tier;

const proposeAssertions: ToolHandler = (args, context) => {
  const idempotencyKey = str(args["idempotency_key"]);
  const proposals = Array.isArray(args["proposals"]) ? (args["proposals"] as Record<string, unknown>[]) : [];
  if (!idempotencyKey || proposals.length === 0) {
    return {
      kind: "refusal",
      error: errorRecord({ code: "invalid-argument", message: "idempotency_key and a non-empty proposals[] are both required.", retryable: false }),
      audit: { outcome: "refused", reasonCode: "invalid-argument", counts: {} }
    };
  }

  const expectedEpoch = str(args["expected_feed_epoch"]);
  if (expectedEpoch !== undefined && expectedEpoch !== context.graph.assertions.feedEpoch) {
    return {
      kind: "refusal",
      error: errorRecord({
        code: "feed-epoch-mismatch",
        message: `The feed epoch has rolled to ${context.graph.assertions.feedEpoch} since you read at ${expectedEpoch}. The commit is refused rather than applied against a different total order.`,
        retryable: false
      }),
      audit: { outcome: "refused", reasonCode: "feed-epoch-mismatch", counts: { refused: proposals.length } }
    };
  }

  /**
   * Write reach, enforced BEFORE the commit and per proposal.
   *
   * Read reach and write reach are separate grants, so a credential that may
   * read every predicate in the graph still writes only what it was granted.
   * Checked here and not at the schema, because the published input schema is
   * one document for every credential — the predicate vocabulary is open and a
   * grant is per credential.
   */
  const grant = context.principal.grant;
  for (const [index, proposal] of proposals.entries()) {
    const predicate = str(proposal["predicate"]);
    if (predicate !== undefined && !mayWritePredicate(grant, predicate)) {
      return {
        kind: "refusal",
        error: errorRecord({
          code: "predicate-not-writable",
          message: `This credential's grant does not permit writing ${predicate}. proposals[${index}] asserts it. atlas.scope.describe.v1 publishes predicates_writable.`,
          retryable: false,
          remedy: { tool: "atlas.scope.describe.v1" },
          details: { index, predicate }
        }),
        audit: { outcome: "refused", reasonCode: "predicate-not-writable", counts: { refused: proposals.length } }
      };
    }
  }

  // The tier this submission will actually be stamped with. Enforced against
  // what WILL be written rather than against what was asked for: the published
  // input carries no tier, so `commit` stamps its default, and a check against
  // a caller-supplied value would be checking a field nobody can send.
  if (!mayWriteTier(grant, COMMIT_TIER)) {
    return {
      kind: "refusal",
      error: errorRecord({
        code: "write-tier-not-permitted",
        message: `This credential's grant does not permit commits at the ${COMMIT_TIER} tier, which is the tier Atlas stamps on a submission that names none.`,
        retryable: false,
        remedy: { tool: "atlas.scope.describe.v1" },
        details: { tier: COMMIT_TIER }
      }),
      audit: { outcome: "refused", reasonCode: "write-tier-not-permitted", counts: { refused: proposals.length } }
    };
  }

  // Supersession scope, enforced BEFORE the commit and against the target's
  // recorded provenance — which Atlas stamped and a caller cannot influence. A
  // consumer that can retract another consumer's belief can rewrite attribution.
  for (const [index, proposal] of proposals.entries()) {
    for (const supersededId of strArray(proposal["supersedes"])) {
      const target = context.graph.assertions.read(supersededId);
      if (!target) continue;
      if (maySupersede(target, context.principal)) continue;
      return {
        kind: "refusal",
        error: errorRecord({
          code: "supersession-not-permitted",
          message: `This credential may supersede only assertions it authored. proposals[${index}] names ${supersededId}, authored by another client.`,
          retryable: false,
          details: { index, assertion_id: supersededId }
        }),
        audit: { outcome: "refused", reasonCode: "supersession-not-permitted", counts: { refused: proposals.length } }
      };
    }
  }

  let outcome;
  try {
    outcome = context.graph.assertions.commit({
      client_id: context.principal.client_id,
      idempotency_key: idempotencyKey,
      drafts: proposals as never
    });
  } catch (cause) {
    return {
      kind: "refusal",
      error: errorRecord({
        code: "invalid-argument",
        message: cause instanceof Error ? cause.message : "The submission was refused.",
        retryable: false
      }),
      audit: { outcome: "refused", reasonCode: "invalid-argument", counts: { refused: proposals.length } }
    };
  }

  if (!outcome.ok) {
    return {
      kind: "refusal",
      error: errorRecord({
        code: outcome.code,
        message: outcome.message,
        retryable: false,
        details: { original_submission_id: outcome.original.submission_id }
      }),
      audit: { outcome: "refused", reasonCode: outcome.code, counts: { refused: proposals.length } }
    };
  }

  const receipt = outcome.receipt;
  const results = receipt.assertion_ids.map((assertionId, index) => {
    const assertion = context.graph.assertions.read(assertionId);
    return {
      index,
      outcome: outcome.replayed ? "replayed" : "committed",
      assertion_id: assertionId,
      ...(assertion ? { seq: assertion.seq, claim_digest: assertion.claim_digest } : {})
    };
  });

  return {
    kind: "complete",
    structured: {
      submission: { ...receipt, state: outcome.replayed ? "replayed" : "committed" },
      results,
      committed: outcome.replayed ? 0 : receipt.assertion_ids.length,
      refused: 0,
      horizon: horizonFor(context, { fidelityMixed: false })
    },
    audit: {
      outcome: "ok",
      counts: { committed: outcome.replayed ? 0 : receipt.assertion_ids.length, refused: 0 },
      // The submission id is minted from the caller's own key, so it names the
      // request rather than the graph. Bounded by max_batch_items either way.
      subjects: [receipt.submission_id]
    }
  };
};

// ---------------------------------------------------------------------------
// atlas.submission.read.v1
// ---------------------------------------------------------------------------

const readSubmission: ToolHandler = (args, context) => {
  const submissionId = str(args["submission_id"]);
  const idempotencyKey = str(args["idempotency_key"]);

  // Exactly one. Guessing which the caller meant is how a client silently reads
  // the wrong submission.
  if ((submissionId === undefined) === (idempotencyKey === undefined)) {
    return {
      kind: "refusal",
      error: errorRecord({
        code: "invalid-argument",
        message: "Supply exactly one of submission_id or idempotency_key.",
        retryable: false
      }),
      audit: { outcome: "refused", reasonCode: "invalid-argument", counts: {} }
    };
  }

  const named = submissionId ?? idempotencyKey;
  return {
    kind: "complete",
    structured: {
      // Receipts are scoped to the calling credential; a lookup that found
      // another client's receipt would be a cross-credential read, so the store
      // is asked only under this principal's own client_id.
      ...lookupReceipt(context, { submissionId, idempotencyKey }),
      horizon: horizonFor(context, { fidelityMixed: false })
    },
    audit: { outcome: "ok", counts: {}, subjects: named === undefined ? [] : [named] }
  };
};

function lookupReceipt(
  context: ToolContext,
  query: { submissionId?: string | undefined; idempotencyKey?: string | undefined }
): Record<string, unknown> {
  if (query.idempotencyKey !== undefined) {
    const receipt = context.graph.assertions.readSubmission(context.principal.client_id, query.idempotencyKey);
    if (!receipt) {
      return {
        error: errorRecord({
          code: "unknown-submission",
          message: `No receipt for idempotency key ${query.idempotencyKey} under this credential. It may never have committed, or the ${CONTRACT_LIMITS.idempotency_ttl_days}-day idempotency window may have closed.`,
          retryable: false
        }),
        idempotency_expires_at: null
      };
    }
    return receiptPayload(receipt);
  }

  const receipt = context.graph.assertions.readSubmissionById(query.submissionId ?? "");
  if (!receipt || receipt.client_id !== context.principal.client_id) {
    return {
      error: errorRecord({
        code: "unknown-submission",
        message: "No such submission under this credential. You cannot read another credential's receipts.",
        retryable: false
      }),
      idempotency_expires_at: null
    };
  }
  return receiptPayload(receipt);
}

function receiptPayload(receipt: {
  submission_id: string;
  client_id: string;
  idempotency_key: string;
  committed_at: RecordedAt;
  request_digest: string;
  assertion_ids: string[];
}): Record<string, unknown> {
  const expires = new Date(new Date(receipt.committed_at).getTime() + CONTRACT_LIMITS.idempotency_ttl_days * 86400000);
  return {
    submission: { ...receipt, state: "committed" },
    results: receipt.assertion_ids.map((assertionId, index) => ({ index, outcome: "committed", assertion_id: assertionId })),
    idempotency_expires_at: canonicalRecordedAt(expires)
  };
}

// ---------------------------------------------------------------------------
// atlas.sensitive.reveal.v1
// ---------------------------------------------------------------------------

const REVEAL_PROMPT_LIMIT = 400;

/**
 * The audit receipt slot the dispatcher fills in.
 *
 * `atlas.sensitive.reveal.v1` must return `{event_id, recorded_at}` on EVERY
 * outcome, including a refusal — a caller has to know the attempt was recorded.
 * The handler cannot know the id, because the one event is written by the
 * dispatcher after the handler returns, so it leaves the slot and the
 * dispatcher patches it. The placeholder is empty rather than plausible: a
 * fabricated id that failed to be replaced would validate and name nothing.
 */
export const AUDIT_RECEIPT_SLOT = { event_id: "", recorded_at: "" } as const;

/** A reveal refusal that still carries its receipt, per the tool's own contract. */
function revealRefusal(input: {
  context: ToolContext;
  code: string;
  message: string;
  retryable: boolean;
  subjects: string[];
}): ToolOutcome {
  return {
    kind: "complete",
    isError: true,
    structured: {
      outcome: "refused",
      error: errorRecord({
        code: input.code,
        message: input.message,
        retryable: input.retryable
      }),
      audit: { ...AUDIT_RECEIPT_SLOT },
      horizon: horizonFor(input.context, { fidelityMixed: false })
    },
    audit: { outcome: "refused", reasonCode: input.code, counts: {}, subjects: input.subjects }
  };
}

const revealSensitive: ToolHandler = (args, context) => {
  const redaction = str(args["redaction_id"]);
  const reason = str(args["reason"]);
  if (!redaction || !reason) {
    return revealRefusal({
      context,
      code: "invalid-argument",
      message: "redaction_id and reason are both required. An unattributed disclosure request is one the owner cannot judge.",
      retryable: false,
      subjects: redaction === undefined ? [] : [redaction]
    });
  }

  if (!context.principal.grant.reveal_available) {
    return revealRefusal({
      context,
      code: "reveal-not-available",
      message: "This credential cannot unlock withheld records at all. The refusal is a property of the credential, not of this record.",
      retryable: false,
      subjects: [redaction]
    });
  }

  const target = findWithheld(context, redaction);
  if (!target) {
    return revealRefusal({
      context,
      code: "unknown-redaction",
      message: "No withheld record for this credential carries that redaction_id. Stub ids are per-credential; one issued to another credential will not resolve here.",
      retryable: false,
      subjects: [redaction]
    });
  }

  const verified = context.requestState;
  if (verified) {
    // The state's integrity was proven before this handler ran. What remains is
    // the check the signature cannot make: that the object it names is the
    // object this call is about. A state moved from one redaction to another
    // verifies cleanly and authorises the wrong disclosure.
    if (verified.redaction_id !== redaction) {
      return revealRefusal({
        context,
        code: "request-state-object-mismatch",
        message: "The echoed request_state was issued for a different record. It is refused rather than honoured against this one.",
        retryable: false,
        subjects: [redaction]
      });
    }

    const decision = readElicitationDecision(context, verified.request_id);
    if (decision !== "accept") {
      return revealRefusal({
        context,
        code: decision === "missing" ? "owner-decision-missing" : "reveal-declined",
        message:
          decision === "missing"
            ? "The retry carried no answer for the owner-decision request, so nothing was disclosed."
            : "The owner did not approve this disclosure.",
        retryable: decision === "missing",
        subjects: [redaction]
      });
    }

    return {
      kind: "complete",
      structured: {
        outcome: "revealed",
        record: target.record,
        audit: { ...AUDIT_RECEIPT_SLOT },
        horizon: horizonFor(context, { fidelityMixed: false })
      },
      audit: { outcome: "ok", counts: { revealed: 1 }, subjects: [redaction] }
    };
  }

  // The escalation. A server MUST NOT send an inputRequest type the client did
  // not declare: issuing an elicitation to a client with no elicitation
  // capability is a request nobody can answer, and the caller would wait on it.
  //
  // The spec is equally explicit about the SHAPE of the refusal: a request
  // needing an undeclared capability MUST be answered with a
  // MissingRequiredClientCapability error (-32021) whose
  // `data.requiredCapabilities` names what is missing. A tool RESULT carrying
  // the number in a field cannot be branched on by a conformant client, so this
  // outcome is raised at the dispatch seam — see `ToolOutcome`. The typed
  // record travels with it rather than being dropped.
  if (context.clientCapabilities["elicitation"] === undefined) {
    const message =
      "Disclosing this record needs an owner decision, which is asked through an elicitation. This client declared no elicitation capability, so the refusal names the capability rather than issuing a request nobody can answer.";
    return {
      kind: "capability-required",
      requiredCapabilities: { elicitation: {} },
      message,
      structured: {
        outcome: "refused",
        error: errorRecord({
          code: "capability-required",
          message,
          // Retryable would say the identical bytes could succeed later. They
          // cannot: the client has to declare the capability first, and that is
          // the caller changing the request.
          retryable: false,
          jsonrpcCode: -32021,
          requiredCapabilities: ["elicitation"]
        }),
        audit: { ...AUDIT_RECEIPT_SLOT },
        horizon: horizonFor(context, { fidelityMixed: false })
      },
      audit: { outcome: "refused", reasonCode: "capability-required", counts: {}, subjects: [redaction] }
    };
  }

  const requestId = `la_reveal_${redaction.slice(-16)}`;
  const prompt = `Disclose the withheld ${target.kind} to ${context.principal.client_id}? Stated reason: ${reason.slice(0, REVEAL_PROMPT_LIMIT)}`;
  return {
    kind: "escalate",
    prompt,
    requestId,
    payload: { request_id: requestId, redaction_id: redaction },
    inBand: (state) => ({
      outcome: "input-required",
      input_request: {
        request_id: requestId,
        request_state: state.requestState,
        expires_at: state.expiresAt,
        prompt,
        required_capabilities: ["elicitation"]
      },
      audit: { ...AUDIT_RECEIPT_SLOT },
      horizon: horizonFor(context, { fidelityMixed: false })
    }),
    audit: { outcome: "input-required", counts: {}, subjects: [redaction] }
  };
};

/** The owner's answer, read from the untrusted `inputResponses` map. */
function readElicitationDecision(context: ToolContext, key: string): "accept" | "decline" | "missing" {
  const response = context.inputResponses?.[key];
  if (typeof response !== "object" || response === null) return "missing";
  const action = (response as Record<string, unknown>)["action"];
  if (action === "accept") return "accept";
  if (action === "decline" || action === "cancel") return "decline";
  return "missing";
}

/**
 * Find the withheld record a stub id names, by RE-DERIVING the id.
 *
 * No server-side table maps a stub to a record: a table can be lost, and a lost
 * table is a reveal that silently stops working. The id is a function of
 * (record id, principal), so the same walk that produced it finds it again.
 */
function findWithheld(
  context: ToolContext,
  stubId: string
): { record: Record<string, unknown>; kind: string } | undefined {
  const page = context.graph.assertions.query({});
  if (page.ok) {
    for (const hit of page.hits) {
      if (!decideAssertion(hit.assertion, context.principal).allowed) {
        if (redactionId(hit.assertion.assertion_id, context.principal) === stubId) {
          return { record: assertionRecord(hit), kind: "assertion" };
        }
      }
    }
  }
  for (const entity of context.graph.searchableEntities()) {
    if (!decideEntity(entity, context.principal).allowed) {
      if (redactionId(entity.entity_id, context.principal) === stubId) {
        return { record: entity as unknown as Record<string, unknown>, kind: "entity" };
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// the registry
// ---------------------------------------------------------------------------

/**
 * Every published tool name maps to exactly one handler.
 *
 * `Record<ContractToolName, ToolHandler>` is total by type: a name added to the
 * contract with no handler here fails to compile, and a handler for a name the
 * contract does not publish is not expressible. The old surface's 30 tools and
 * its documentation drifted apart precisely because nothing connected them.
 */
export const TOOL_HANDLERS: Record<ContractToolName, ToolHandler> = {
  "atlas.contract.describe.v1": describeContract,
  "atlas.scope.describe.v1": describeScope,
  "atlas.entity.resolve.v1": resolveEntities,
  "atlas.entity.read.v1": readEntities,
  "atlas.assertion.query.v1": queryAssertions,
  "atlas.assertion.read.v1": readAssertions,
  "atlas.graph.neighbors.v1": walkNeighbors,
  "atlas.text.search.v1": searchText,
  "atlas.changes.read.v1": readChanges,
  "atlas.assertion.propose.v1": proposeAssertions,
  "atlas.submission.read.v1": readSubmission,
  "atlas.sensitive.reveal.v1": revealSensitive
};
