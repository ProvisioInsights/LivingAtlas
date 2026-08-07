import { z } from "zod";
import type { AuditCounts, AuditEvent } from "../audit.js";
import { effectiveLimit, mayCallTool, permittedTools, reachesTier, type CapabilityGrant } from "../grant.js";
import { ceilingOf, type Principal } from "../principal.js";
import { errorRecord, type ErrorRecord } from "../results.js";
import { OPERATOR_LIMITS } from "./limits.js";
import type { OperatorSource, ReconcileSubject } from "./source.js";
import { OPERATOR_ERROR_CODES } from "./vocabulary.js";

/**
 * The operator plane's tools.
 *
 * Operational concerns live HERE and leave the consumer contract entirely:
 * migration windows, replication state, usage and billing reconciliation, the
 * curation queue, reconcile, and the audit read path. None of them is published
 * in `manifest.json`, none is in `CONTRACT_TOOL_NAMES`, and nothing in the
 * consumer server imports this file — so an operational tool cannot arrive in a
 * consumer's `tools/list` by being added to the wrong table. `TOOL_HANDLERS` in
 * the consumer plane is `Record<ContractToolName, ToolHandler>`, which is total
 * over the published twelve and admits nothing else.
 *
 * Two shapes are deliberately NOT reused from the consumer plane:
 *
 *  - **Schemas are zod here, not published JSON Schema documents.** The consumer
 *    contract exists so a third party can fetch it, validate against it, and
 *    hold the server to it across revisions. The operator plane is the owner's
 *    own control surface; there is no third party to publish to, and publishing
 *    a fetchable catalogue of a deployment's operational tools is a disclosure
 *    with no corresponding benefit. Output is still validated before it leaves —
 *    see `server.ts` — so the shape is enforced, just not advertised.
 *  - **No `GraphSource`.** Operator tools answer questions about the system, not
 *    about the knowledge in it. See `source.ts`.
 */

export type OperatorContext = {
  principal: Principal;
  protocolVersion: string;
  now: Date;
  source: OperatorSource;
};

/** The counts and named subjects the dispatcher writes into the one event. */
export type OperatorAuditFacts = {
  outcome: "ok" | "refused" | "error";
  reasonCode?: string;
  counts: AuditCounts;
  /** Ids the CALLER named, never ids the source produced. Same rule as the consumer plane. */
  subjects?: readonly string[];
};

export type OperatorOutcome =
  | { kind: "complete"; structured: Record<string, unknown>; audit: OperatorAuditFacts }
  | { kind: "refusal"; error: ErrorRecord; audit: OperatorAuditFacts };

export type OperatorHandler = (
  args: Record<string, unknown>,
  context: OperatorContext
) => OperatorOutcome | Promise<OperatorOutcome>;

export type OperatorToolDefinition = {
  name: string;
  title: string;
  description: string;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
  input: z.ZodObject;
  output: z.ZodObject;
  handler: OperatorHandler;
};

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;


/** The plane string, in one place, so no tool spells it differently. */
const PLANE = "operator" as const;

// ---------------------------------------------------------------------------
// small shared pieces
// ---------------------------------------------------------------------------

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function int(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function pageSizeFor(principal: Principal, requested: number | undefined): number {
  const maximum = effectiveLimit(OPERATOR_LIMITS.max_page_size, principal.grant.limits.max_page_size);
  if (requested === undefined) return Math.min(OPERATOR_LIMITS.default_page_size, maximum);
  return Math.min(Math.max(requested, 1), maximum);
}

const PageInput = {
  page_size: z.number().int().positive().max(OPERATOR_LIMITS.max_page_size).optional()
};

const PageOutput = {
  page: z.object({ page_size: z.number().int(), returned: z.number().int(), evaluated: z.number().int(), has_more: z.boolean() })
};

// ---------------------------------------------------------------------------
// atlas.ops.scope.describe.v1
// ---------------------------------------------------------------------------

const SensitivityTierOut = z.object({ tier: z.string(), rank: z.number().int() });

const describeOperatorScope: OperatorHandler = (_args, context) => {
  const principal = context.principal;
  const grant = principal.grant;
  return {
    kind: "complete",
    structured: {
      client_id: principal.client_id,
      credential_class: principal.credential_class,
      plane: principal.plane,
      grant_id: grant.grant_id,
      tools_available: permittedTools(grant, PLANE, OPERATOR_TOOL_NAMES),
      sensitivity_reachable: grant.sensitivity_reachable,
      sensitivity_ceiling: ceilingOf(principal),
      limits: {
        max_page_size: effectiveLimit(OPERATOR_LIMITS.max_page_size, grant.limits.max_page_size)
      },
      // The operator plane has no contract.describe, so its refusal vocabulary
      // is published here. An open vocabulary a caller cannot look up is one it
      // can only branch on by accident.
      error_codes: OPERATOR_ERROR_CODES.map((entry) => ({ ...entry }))
    },
    audit: { outcome: "ok", counts: {} }
  };
};

// ---------------------------------------------------------------------------
// atlas.ops.store.status.read.v1
// ---------------------------------------------------------------------------

/**
 * What store this server opened, and in what posture.
 *
 * The operator-plane answer to the question the consumer plane cannot be asked:
 * a consumer reading an empty page cannot tell a store that holds nothing from a
 * server that opened no store at all, and neither can an operator reading a
 * migration window. So the absent case is a REFUSAL with its own code rather
 * than a row of zeroes — the whole reason `store.ts` refuses an absent directory
 * is that zero and not-there must never be spelled the same way, and reporting
 * them the same way here would put the confusion back one layer up.
 *
 * `mode` is on this result because read-only and read-write are different
 * security postures, and which one a running server is in is not something an
 * operator should have to deduce from a refusal it happened to provoke.
 */
const readStoreStatus: OperatorHandler = (_args, context) => {
  const status = context.source.store?.();
  if (status === undefined) {
    return {
      kind: "refusal",
      error: errorRecord({
        code: "store-not-opened",
        message:
          "This server was not opened over a durable store, so there is no store state to report. " +
          "It is serving an in-memory graph.",
        retryable: false
      }),
      audit: { outcome: "refused", reasonCode: "store-not-opened", counts: {} }
    };
  }

  return {
    kind: "complete",
    structured: { store: { ...status } },
    audit: { outcome: "ok", counts: { evaluated: status.assertions, returned: 1 } }
  };
};

// ---------------------------------------------------------------------------
// atlas.ops.migration.window.read.v1
// ---------------------------------------------------------------------------

const readMigrationWindows: OperatorHandler = (args, context) => {
  const requested = str(args["window_id"]);
  const all = context.source.migrationWindows();
  const matched = requested === undefined ? all : all.filter((window) => window.window_id === requested);

  if (requested !== undefined && matched.length === 0) {
    return {
      kind: "refusal",
      error: errorRecord({
        code: "migration-window-unknown",
        message: `No migration window carries the id ${requested}.`,
        retryable: false
      }),
      audit: { outcome: "refused", reasonCode: "migration-window-unknown", counts: { evaluated: all.length }, subjects: [requested] }
    };
  }

  const pageSize = pageSizeFor(context.principal, undefined);
  const page = matched.slice(0, pageSize);
  return {
    kind: "complete",
    structured: {
      windows: page.map((window) => ({ ...window })),
      // Reported, never inferred from an empty list: "no window is open" and
      // "this credential is looking at a truncated page" are different answers.
      page: { page_size: pageSize, returned: page.length, evaluated: all.length, has_more: matched.length > page.length }
    },
    audit: {
      outcome: "ok",
      counts: { evaluated: all.length, returned: page.length },
      ...(requested === undefined ? {} : { subjects: [requested] })
    }
  };
};

// ---------------------------------------------------------------------------
// atlas.ops.replication.status.read.v1
// ---------------------------------------------------------------------------

const readReplicationStatus: OperatorHandler = (args, context) => {
  const targets = context.source.replicationTargets();
  const pageSize = pageSizeFor(context.principal, int(args["page_size"]));
  const page = targets.slice(0, pageSize);
  return {
    kind: "complete",
    structured: {
      targets: page.map((target) => ({
        ...target,
        // Derived here rather than stored, so it cannot disagree with the two
        // watermarks it is computed from — which is the whole reason both are
        // reported instead of a single lag number.
        lag_seq: Math.max(target.local_watermark_seq - target.acknowledged_seq, 0)
      })),
      page: { page_size: pageSize, returned: page.length, evaluated: targets.length, has_more: targets.length > page.length }
    },
    audit: { outcome: "ok", counts: { evaluated: targets.length, returned: page.length } }
  };
};

// ---------------------------------------------------------------------------
// atlas.ops.usage.read.v1
// ---------------------------------------------------------------------------

type UsageTally = {
  /** `null` for a call nobody authenticated — see the grouping key below. */
  client_id: string | null;
  grant_id: string | null;
  plane: string;
  calls: number;
  refusals: number;
  records_returned: number;
  records_withheld: number;
  records_committed: number;
  records_revealed: number;
};

function tallyUsage(events: readonly AuditEvent[]): UsageTally[] {
  const rows = new Map<string, UsageTally>();
  for (const event of events) {
    // A call nobody authenticated has no client to bill and no grant to name.
    // Counted under the null key rather than dropped: an unattributable call is
    // a fact a reconciliation has to be able to see.
    const key = event.client_id ?? "";
    let row = rows.get(key);
    if (row === undefined) {
      row = {
        // Carried through as `null`, exactly as the event carries it. Reporting
        // an unattributable call under an empty-string client would give it a
        // name that a real credential could also be issued.
        client_id: event.client_id,
        grant_id: event.grant_id,
        plane: event.plane,
        calls: 0,
        refusals: 0,
        records_returned: 0,
        records_withheld: 0,
        records_committed: 0,
        records_revealed: 0
      };
      rows.set(key, row);
    }
    row.calls += 1;
    if (event.outcome === "refused" || event.outcome === "error") row.refusals += 1;
    row.records_returned += event.counts.returned ?? 0;
    row.records_withheld += event.counts.withheld ?? 0;
    row.records_committed += event.counts.committed ?? 0;
    row.records_revealed += event.counts.revealed ?? 0;
  }
  // Deterministic order, with the unattributable row first so it is the first
  // thing a reconciliation sees rather than something it scrolls past.
  return [...rows.values()].sort((left, right) => (left.client_id ?? "").localeCompare(right.client_id ?? ""));
}

const readUsage: OperatorHandler = (_args, context) => {
  const events = context.source.audit.read();
  const tallies = tallyUsage(events);
  const metered = context.source.meteredUsage();

  const rows = tallies.map((tally) => {
    const meter = metered.find((entry) => entry.client_id === tally.client_id);
    const meteredCalls = meter?.metered_calls ?? null;
    return {
      ...tally,
      metered_calls: meteredCalls,
      // The DELTA, and no verdict. Reconciliation between a meter and a durable
      // log means reporting where they disagree; picking one as authoritative
      // here would erase the only signal that something is wrong with the other.
      delta_calls: meteredCalls === null ? null : meteredCalls - tally.calls,
      reconciled: meteredCalls !== null && meteredCalls === tally.calls
    };
  });

  return {
    kind: "complete",
    structured: {
      rows,
      unreconciled_clients: rows.filter((row) => !row.reconciled).map((row) => row.client_id),
      // Attribution is per credential and this is where it shows: one row per
      // client_id resolved from a credential, never one row for the daemon.
      client_count: rows.length,
      event_count: events.length
    },
    audit: { outcome: "ok", counts: { evaluated: events.length, returned: rows.length } }
  };
};

// ---------------------------------------------------------------------------
// atlas.ops.review.queue.read.v1
// ---------------------------------------------------------------------------

const readReviewQueue: OperatorHandler = (args, context) => {
  const state = str(args["state"]);
  const all = context.source.reviewQueue();
  const matched = state === undefined ? all : all.filter((item) => item.state === state);
  const pageSize = pageSizeFor(context.principal, int(args["page_size"]));
  const page = matched.slice(0, pageSize);

  let withheld = 0;
  const items = page.map((item) => {
    // The same rule as the consumer plane, applied on this plane too: a grant
    // limits sensitivity reach wherever content flows, and an operator
    // credential is not exempt for being an operator credential.
    if (item.sensitivity.withheld || !reachesTier(context.principal.grant, item.sensitivity.tier)) {
      withheld += 1;
      return {
        item_id: item.item_id,
        withheld: true,
        reason_code: "sensitivity-withheld",
        sensitivity: { ...item.sensitivity, withheld: true }
      };
    }
    return { ...item, withheld: false };
  });

  return {
    kind: "complete",
    structured: {
      items,
      // The withheld row still occupies its place and still counts, so a
      // filtered queue is never indistinguishable from a shorter one.
      page: { page_size: pageSize, returned: page.length, evaluated: all.length, has_more: matched.length > page.length },
      withheld
    },
    audit: { outcome: "ok", counts: { evaluated: all.length, returned: page.length, withheld } }
  };
};

// ---------------------------------------------------------------------------
// atlas.ops.reconcile.run.v1
// ---------------------------------------------------------------------------

const RECONCILE_SUBJECTS: readonly ReconcileSubject[] = ["migration-window", "replication", "usage"];

const runReconcile: OperatorHandler = (args, context) => {
  const subject = str(args["subject"]);
  const targetId = str(args["target_id"]);
  const dryRun = args["dry_run"] !== false;

  if (subject === undefined || !RECONCILE_SUBJECTS.includes(subject as ReconcileSubject) || targetId === undefined) {
    return {
      kind: "refusal",
      error: errorRecord({
        code: "reconcile-subject-unknown",
        message: `subject must be one of ${RECONCILE_SUBJECTS.join(", ")} and target_id is required. Refused rather than treated as a no-op, which would report success for work nobody did.`,
        retryable: false
      }),
      audit: { outcome: "refused", reasonCode: "reconcile-subject-unknown", counts: {} }
    };
  }

  const outcome = context.source.reconcile({ subject: subject as ReconcileSubject, targetId, dryRun });
  if (!outcome.ok) {
    return {
      kind: "refusal",
      error: errorRecord({ code: outcome.code, message: outcome.message, retryable: false, details: { subject, target_id: targetId } }),
      audit: { outcome: "refused", reasonCode: outcome.code, counts: {}, subjects: [targetId] }
    };
  }

  return {
    kind: "complete",
    structured: {
      subject,
      target_id: targetId,
      dry_run: dryRun,
      // What the store did, from the store. A preview computed here would be a
      // description of an operation this server did not perform.
      applied: outcome.applied,
      changes: outcome.changes.map((change) => ({ ...change }))
    },
    audit: {
      outcome: "ok",
      counts: { committed: outcome.applied ? outcome.changes.length : 0 },
      subjects: [targetId]
    }
  };
};

// ---------------------------------------------------------------------------
// atlas.ops.audit.read.v1
// ---------------------------------------------------------------------------

function matchesFilter(event: AuditEvent, filter: { clientId?: string; tool?: string; outcome?: string; subjectId?: string; since?: string }): boolean {
  if (filter.clientId !== undefined && event.client_id !== filter.clientId) return false;
  if (filter.tool !== undefined && event.tool !== filter.tool) return false;
  if (filter.outcome !== undefined && event.outcome !== filter.outcome) return false;
  if (filter.since !== undefined && event.recorded_at < filter.since) return false;
  if (filter.subjectId !== undefined && !event.subjects.includes(filter.subjectId)) return false;
  return true;
}

const readAudit: OperatorHandler = (args, context) => {
  const filter = {
    ...(str(args["client_id"]) === undefined ? {} : { clientId: str(args["client_id"]) as string }),
    ...(str(args["tool"]) === undefined ? {} : { tool: str(args["tool"]) as string }),
    ...(str(args["outcome"]) === undefined ? {} : { outcome: str(args["outcome"]) as string }),
    ...(str(args["subject_id"]) === undefined ? {} : { subjectId: str(args["subject_id"]) as string }),
    ...(str(args["since"]) === undefined ? {} : { since: str(args["since"]) as string })
  };

  const all = context.source.audit.read();
  const matched = all.filter((event) => matchesFilter(event, filter));
  const pageSize = pageSizeFor(context.principal, int(args["page_size"]));
  const page = matched.slice(0, pageSize);

  return {
    kind: "complete",
    structured: {
      events: page.map((event) => ({
        event_id: event.event_id,
        recorded_at: event.recorded_at,
        tool: event.tool,
        client_id: event.client_id,
        credential_class: event.credential_class,
        plane: event.plane,
        grant_id: event.grant_id,
        outcome: event.outcome,
        ...(event.reason_code === undefined ? {} : { reason_code: event.reason_code }),
        counts: { ...event.counts },
        /**
         * `subjects` is COUNTED and never returned.
         *
         * The subjects of an audit event are identifiers the caller named, and
         * a great many of them are graph identifiers. Returning them would make
         * the audit path a second read path for graph ids, with none of the
         * sensitivity machinery that governs the first one applied to it. An
         * operator investigating one id filters by it — `subject_id` matches
         * without disclosing, which answers "did this credential touch this id"
         * without enumerating everything it touched.
         */
        subjects_count: event.subjects.length,
        subjects_truncated: event.subjects_truncated,
        arguments_digest: event.arguments_digest,
        protocol_version: event.protocol_version
      })),
      page: { page_size: pageSize, returned: page.length, evaluated: all.length, has_more: matched.length > page.length }
    },
    audit: {
      outcome: "ok",
      counts: { evaluated: all.length, returned: page.length },
      // Only what the CALLER named. A filter value is a caller-supplied string
      // and is bounded by the input schema; the events found are not.
      ...(filter.subjectId === undefined ? {} : { subjects: [filter.subjectId] })
    }
  };
};

// ---------------------------------------------------------------------------
// the registry
// ---------------------------------------------------------------------------

const AuditEventOut = z.looseObject({
  event_id: z.string(),
  recorded_at: z.string(),
  tool: z.string(),
  client_id: z.string().nullable(),
  credential_class: z.string().nullable(),
  plane: z.string(),
  grant_id: z.string().nullable(),
  outcome: z.string(),
  reason_code: z.string().optional(),
  counts: z.looseObject({}),
  subjects_count: z.number().int(),
  subjects_truncated: z.boolean(),
  arguments_digest: z.string(),
  protocol_version: z.string()
});

export const OPERATOR_TOOLS: readonly OperatorToolDefinition[] = [
  {
    name: "atlas.ops.scope.describe.v1",
    title: "Describe this operator credential's grant",
    description:
      "Report the calling operator credential's client_id, the operational tools it may call, the sensitivity tiers it reaches, the limits that apply, and this plane's refusal vocabulary. Ask here rather than inferring scope from a refusal, and never from which transport you connected over.",
    annotations: READ_ONLY,
    input: z.strictObject({}),
    output: z.looseObject({
      client_id: z.string(),
      credential_class: z.string(),
      plane: z.string(),
      grant_id: z.string(),
      tools_available: z.array(z.string()).min(1),
      sensitivity_reachable: z.array(SensitivityTierOut).min(1),
      sensitivity_ceiling: SensitivityTierOut,
      limits: z.looseObject({ max_page_size: z.number().int() }),
      error_codes: z.array(z.looseObject({ code: z.string(), origin: z.string(), retryable: z.boolean(), summary: z.string() }))
    }),
    handler: describeOperatorScope
  },
  {
    name: "atlas.ops.store.status.read.v1",
    title: "Read the durable store this server opened",
    description:
      "Report which store this server is serving and in what posture: read-only or read-write, feed epoch, belief-time floor, published watermark, record and segment counts, and what the load found wrong. Refused when this server opened no store at all, because a store that is absent and a store that is empty need different responses. No graph content and no filesystem path is reported.",
    annotations: READ_ONLY,
    input: z.strictObject({}),
    output: z.looseObject({
      store: z.looseObject({
        mode: z.string(),
        feed_epoch: z.string(),
        bitemporal_since: z.string(),
        published_watermark: z.number().int(),
        assertions: z.number().int(),
        entities: z.number().int(),
        predicates: z.number().int(),
        assertion_segments: z.number().int(),
        identity_segments: z.number().int(),
        segment_repairs: z.number().int(),
        ignored_files: z.number().int(),
        conflicting_supersessions: z.number().int(),
        conflicting_alias_rows: z.number().int()
      })
    }),
    handler: readStoreStatus
  },
  {
    name: "atlas.ops.migration.window.read.v1",
    title: "Read migration window state",
    description:
      "Report the migration windows this deployment holds: phase, planned and migrated and refused record counts, and why a window cannot advance when it cannot. Reading only — opening or closing a window is a reconcile.",
    annotations: READ_ONLY,
    input: z.strictObject({ window_id: z.string().min(1).optional() }),
    output: z.looseObject({
      windows: z.array(
        z.looseObject({
          window_id: z.string(),
          phase: z.string(),
          opened_at: z.string().nullable(),
          closed_at: z.string().nullable(),
          source_label: z.string(),
          planned_records: z.number().int(),
          migrated_records: z.number().int(),
          refused_records: z.number().int(),
          blocked_reason: z.string().nullable()
        })
      ),
      ...PageOutput
    }),
    handler: readMigrationWindows
  },
  {
    name: "atlas.ops.replication.status.read.v1",
    title: "Read replication and sync state",
    description:
      "Report each replication target's feed epoch, local and acknowledged watermarks, derived lag, outbox depth and last contact. Both watermarks are reported because a single lag number cannot distinguish a replica that is behind from one whose epoch rolled.",
    annotations: READ_ONLY,
    input: z.strictObject({ ...PageInput }),
    output: z.looseObject({
      targets: z.array(
        z.looseObject({
          target_id: z.string(),
          direction: z.string(),
          feed_epoch: z.string(),
          local_watermark_seq: z.number().int(),
          acknowledged_seq: z.number().int(),
          lag_seq: z.number().int(),
          outbox_depth: z.number().int(),
          last_contact_at: z.string().nullable(),
          state: z.string()
        })
      ),
      ...PageOutput
    }),
    handler: readReplicationStatus
  },
  {
    name: "atlas.ops.usage.read.v1",
    title: "Reconcile usage against the durable events",
    description:
      "Report usage per client_id, derived from the audit log, alongside what the meter says, and the delta between them. One row per credential: attribution is per credential, so a deployment that collapsed every consumer onto one identity reports one row and that is the signal. This server reports the delta and does not decide which figure is right.",
    annotations: READ_ONLY,
    input: z.strictObject({}),
    output: z.looseObject({
      rows: z.array(
        z.looseObject({
          client_id: z.string().nullable(),
          grant_id: z.string().nullable(),
          plane: z.string(),
          calls: z.number().int(),
          refusals: z.number().int(),
          records_returned: z.number().int(),
          records_withheld: z.number().int(),
          records_committed: z.number().int(),
          records_revealed: z.number().int(),
          metered_calls: z.number().int().nullable(),
          delta_calls: z.number().int().nullable(),
          reconciled: z.boolean()
        })
      ),
      unreconciled_clients: z.array(z.string().nullable()),
      client_count: z.number().int(),
      event_count: z.number().int()
    }),
    handler: readUsage
  },
  {
    name: "atlas.ops.review.queue.read.v1",
    title: "Read the curation and review queue",
    description:
      "Report the items awaiting curation by id, kind, state and assignee. An item whose sensitivity tier this credential does not reach still occupies its row as a withheld stub, so a filtered queue is never indistinguishable from a shorter one.",
    annotations: READ_ONLY,
    input: z.strictObject({ state: z.string().min(1).optional(), ...PageInput }),
    output: z.looseObject({ items: z.array(z.looseObject({ item_id: z.string(), withheld: z.boolean() })), withheld: z.number().int(), ...PageOutput }),
    handler: readReviewQueue
  },
  {
    name: "atlas.ops.reconcile.run.v1",
    title: "Run a reconciliation",
    description:
      "Reconcile a migration window, a replication target, or a usage period. dry_run defaults to true: the default of a mutating operational tool is the one that changes nothing. Every call writes exactly one durable audit event whether or not anything was applied.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    input: z.strictObject({
      subject: z.enum(["migration-window", "replication", "usage"]),
      target_id: z.string().min(1),
      dry_run: z.boolean().optional()
    }),
    output: z.looseObject({
      subject: z.string(),
      target_id: z.string(),
      dry_run: z.boolean(),
      applied: z.boolean(),
      changes: z.array(z.looseObject({ field: z.string(), from: z.string(), to: z.string() }))
    }),
    handler: runReconcile
  },
  {
    name: "atlas.ops.audit.read.v1",
    title: "Read the audit log",
    description:
      "Read the one-event-per-tool-call audit log, filtered by client_id, tool, outcome, subject id or belief instant. Subjects are counted, never listed: they are caller-supplied identifiers, and returning them would make this a second read path into the graph. Filter by subject_id to ask whether a credential touched one id without enumerating what else it touched.",
    annotations: READ_ONLY,
    input: z.strictObject({
      client_id: z.string().min(1).optional(),
      tool: z.string().min(1).optional(),
      outcome: z.enum(["ok", "refused", "input-required", "error"]).optional(),
      subject_id: z.string().min(1).optional(),
      since: z.string().min(1).optional(),
      ...PageInput
    }),
    output: z.looseObject({ events: z.array(AuditEventOut), ...PageOutput }),
    handler: readAudit
  }
] as const;

export const OPERATOR_TOOL_NAMES: readonly string[] = OPERATOR_TOOLS.map((tool) => tool.name);

/** Whether this grant may call this operator tool. Exported so the listing and the dispatch agree. */
export function mayCallOperatorTool(grant: CapabilityGrant, tool: string): boolean {
  return mayCallTool(grant, PLANE, tool);
}
