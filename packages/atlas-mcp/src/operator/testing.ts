import { PassThrough } from "node:stream";
import { StdioServerTransport, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import { MemoryAuditJournal } from "../audit.js";
import type { CapabilityGrant } from "../grant.js";
import type { Principal } from "../principal.js";
import { OPERATOR_TOOL_NAMES } from "./tools.js";
import { serveOperatorStdio, type ServeOperatorStdioOptions } from "./stdio.js";
import type {
  MeteredUsage,
  MigrationWindow,
  OperatorSource,
  ReconcileChange,
  ReconcileOutcome,
  ReplicationTarget,
  ReviewItem
} from "./source.js";

/**
 * The operator plane's synthetic harness.
 *
 * Every fixture is fabricated in memory. Nothing here reads a real graph, a
 * profile directory, a deployment's replication state, or any path outside the
 * repository — the repo's privacy boundary is that this behaviour is proven on
 * synthetic fixtures before real data exists, and an operational surface is
 * exactly where a convenient shortcut to real state would be tempting.
 */

export const OPERATOR_GRANT: CapabilityGrant = {
  grant_id: "grant-synthetic-operator",
  sensitivity_reachable: [{ tier: "open", rank: 0 }, { tier: "internal", rank: 10 }],
  tools_permitted: [...OPERATOR_TOOL_NAMES],
  // An operator credential writes operational state, never graph assertions.
  // Empty here is a statement, not an omission.
  predicates_writable: [],
  write_tiers_permitted: [],
  limits: {},
  coverage_counts_basis: "exact",
  supersession_scope: "own-client-id",
  reveal_available: false
};

export const OPERATOR_PRINCIPAL: Principal = {
  client_id: "synthetic-operator",
  credential_class: "operator",
  plane: "operator",
  grant: OPERATOR_GRANT
};

export type SyntheticOperatorSource = OperatorSource & {
  /** Reconciliations this source was asked to apply, in order. */
  applied: { subject: string; targetId: string; dryRun: boolean }[];
};

export function syntheticOperatorSource(
  overrides: {
    windows?: MigrationWindow[];
    targets?: ReplicationTarget[];
    metered?: MeteredUsage[];
    queue?: ReviewItem[];
    journal?: MemoryAuditJournal;
  } = {}
): SyntheticOperatorSource {
  const journal = overrides.journal ?? new MemoryAuditJournal();
  const windows: MigrationWindow[] = overrides.windows ?? [
    {
      window_id: "window-alpha",
      phase: "open",
      opened_at: "2026-08-01T00:00:00.000Z",
      closed_at: null,
      source_label: "synthetic-source-a",
      planned_records: 400,
      migrated_records: 120,
      refused_records: 3,
      blocked_reason: null
    },
    {
      window_id: "window-beta",
      phase: "blocked",
      opened_at: "2026-07-20T00:00:00.000Z",
      closed_at: null,
      source_label: "synthetic-source-b",
      planned_records: 90,
      migrated_records: 0,
      refused_records: 0,
      blocked_reason: "offline backup media not attached"
    }
  ];

  const targets: ReplicationTarget[] = overrides.targets ?? [
    {
      target_id: "replica-one",
      direction: "push",
      feed_epoch: "e-test",
      local_watermark_seq: 42,
      acknowledged_seq: 40,
      outbox_depth: 2,
      last_contact_at: "2026-08-04T11:59:00.000Z",
      state: "behind"
    }
  ];

  const queue: ReviewItem[] = overrides.queue ?? [
    {
      item_id: "review-open",
      kind: "entity-merge",
      subject_ref: "la_entity_00000000000000000000000001",
      opened_at: "2026-08-02T00:00:00.000Z",
      state: "waiting",
      assigned_to: null,
      sensitivity: { tier: "open", rank: 0, withheld: false }
    },
    {
      item_id: "review-sealed",
      kind: "entity-merge",
      subject_ref: "la_entity_00000000000000000000000002",
      opened_at: "2026-08-03T00:00:00.000Z",
      state: "waiting",
      assigned_to: null,
      sensitivity: { tier: "sealed", rank: 90, withheld: false }
    }
  ];

  const applied: SyntheticOperatorSource["applied"] = [];

  return {
    applied,
    migrationWindows: () => windows,
    replicationTargets: () => targets,
    meteredUsage: () => overrides.metered ?? [],
    reviewQueue: () => queue,
    audit: { read: () => journal.events },
    reconcile: ({ subject, targetId, dryRun }): ReconcileOutcome => {
      applied.push({ subject, targetId, dryRun });
      if (subject === "replication" && !targets.some((target) => target.target_id === targetId)) {
        return { ok: false, code: "replication-target-unknown", message: `No replication target carries the id ${targetId}.` };
      }
      if (subject === "migration-window" && !windows.some((window) => window.window_id === targetId)) {
        return { ok: false, code: "migration-window-unknown", message: `No migration window carries the id ${targetId}.` };
      }
      const changes: ReconcileChange[] = [{ field: "acknowledged_seq", from: "40", to: "42" }];
      return { ok: true, applied: !dryRun, changes };
    }
  };
}

export type OperatorHarness = {
  client: OperatorWireClient;
  handle: StdioServerHandle;
  source: SyntheticOperatorSource;
  auditJournal: MemoryAuditJournal;
};

export type OperatorWireResponse = {
  jsonrpc: "2.0";
  id: string | number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
};

export type OperatorWireClient = {
  send(message: Record<string, unknown>): void;
  await(id: string | number, timeoutMs?: number): Promise<OperatorWireResponse>;
  responses: OperatorWireResponse[];
};

export type OperatorHarnessOptions = Omit<ServeOperatorStdioOptions, "source" | "auditJournal"> &
  Partial<Pick<ServeOperatorStdioOptions, "source" | "auditJournal">>;

export function startOperatorHarness(options: OperatorHarnessOptions): OperatorHarness {
  const auditJournal = (options.auditJournal as MemoryAuditJournal | undefined) ?? new MemoryAuditJournal();
  const source = (options.source as SyntheticOperatorSource | undefined) ?? syntheticOperatorSource({ journal: auditJournal });

  const toServer = new PassThrough();
  const fromServer = new PassThrough();
  const transport = new StdioServerTransport(toServer, fromServer);

  const handle = serveOperatorStdio({ ...options, source, auditJournal, transport });

  const responses: OperatorWireResponse[] = [];
  const waiters = new Map<string | number, (response: OperatorWireResponse) => void>();
  let buffer = "";
  fromServer.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim().length > 0) {
        const parsed = JSON.parse(line) as OperatorWireResponse;
        responses.push(parsed);
        waiters.get(parsed.id)?.(parsed);
        waiters.delete(parsed.id);
      }
      index = buffer.indexOf("\n");
    }
  });

  const client: OperatorWireClient = {
    responses,
    send: (message) => {
      toServer.write(`${JSON.stringify(message)}\n`);
    },
    await: (id, timeoutMs = 4000) =>
      new Promise<OperatorWireResponse>((resolve, reject) => {
        const existing = responses.find((response) => response.id === id);
        if (existing) {
          resolve(existing);
          return;
        }
        const timer = setTimeout(() => {
          waiters.delete(id);
          reject(new Error(`no response for id ${String(id)} within ${timeoutMs}ms`));
        }, timeoutMs);
        waiters.set(id, (response) => {
          clearTimeout(timer);
          resolve(response);
        });
      })
  };

  return { client, handle, source, auditJournal };
}
