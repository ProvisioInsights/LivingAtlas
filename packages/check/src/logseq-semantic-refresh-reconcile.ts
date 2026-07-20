import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { FileLocalGraphStore } from "@living-atlas/local-graph-store";
import {
  FileLocalKeyringStore,
  decryptGraphObjectPayload,
  resolveLocalSecret,
  type LocalKeyringState
} from "@living-atlas/local-keyring";

/**
 * Reconcile superseded semantic objects after a delta re-import.
 *
 * The semantic importer derives block/edge object ids from source content, so
 * a changed source file mints new object ids while the previous import's
 * objects stay live and stale. This tool tombstones live objects in the
 * per-path semantic namespaces whose source_path_ref was covered by an import
 * run (per its ledger) but whose object_id the run did not emit — i.e. the
 * source unit no longer exists in the current source.
 *
 * Shared, title-keyed objects (typed endpoints) and review-lane objects are
 * never touched: endpoints are referenced across source paths, and review
 * candidates carry resolution state that a refresh must not discard.
 *
 * Requires an explicit acknowledgement in CLI mode because it mutates the
 * real replica: LIVING_ATLAS_SEMANTIC_REFRESH_RECONCILE_ACK=tombstone-superseded-semantic-objects.
 * Without the ack it runs as a dry-run report.
 */

const ackEnv = "LIVING_ATLAS_SEMANTIC_REFRESH_RECONCILE_ACK";
const ackValue = "tombstone-superseded-semantic-objects";

const reconciledNamespaces = new Set([
  "import/logseq-semantic/block",
  "import/logseq-semantic/page",
  "import/logseq-semantic/source-capsule",
  "import/logseq-semantic/reference-index",
  "import/logseq-semantic/typed-edge"
]);

export type SemanticRefreshReconcileResult = {
  report_schema: "living-atlas-semantic-refresh-reconcile:v1";
  plaintext_policy: "counts-and-refs-only";
  dry_run: boolean;
  scanned: number;
  covered_source_refs: number;
  emitted_object_ids: number;
  stale: number;
  tombstoned: number;
  failed: number;
  failed_reasons: Record<string, number>;
  undecryptable_skipped: number;
  stale_by_namespace: Record<string, number>;
};

interface ImportLedgerSlice {
  object_refs: readonly { object_id: string }[];
  source_outcomes: readonly { source_path_ref: string }[];
}

function sourcePathRefFromPayload(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const record = data as Record<string, unknown>;
  if (typeof record.source_path_ref === "string") return record.source_path_ref;
  const edge = record.edge;
  if (edge && typeof edge === "object") {
    const attrs = (edge as Record<string, unknown>).attrs;
    if (attrs && typeof attrs === "object") {
      const ref = (attrs as Record<string, unknown>).source_path_ref;
      if (typeof ref === "string") return ref;
    }
  }
  return undefined;
}

export async function reconcileSupersededSemanticObjects(options: {
  store: FileLocalGraphStore;
  keyring: LocalKeyringState;
  ledger: ImportLedgerSlice;
  deletedSourceRefs?: readonly string[];
  actorId: string;
  dryRun: boolean;
  now?: string;
}): Promise<SemanticRefreshReconcileResult> {
  const emitted = new Set(options.ledger.object_refs.map((ref) => ref.object_id));
  const covered = new Set(options.ledger.source_outcomes.map((outcome) => outcome.source_path_ref));
  for (const ref of options.deletedSourceRefs ?? []) covered.add(ref);

  const live = options.store.listObjects().filter((object) => (
    reconciledNamespaces.has(object.visible_metadata.schema_namespace ?? "")
  ));

  const stale: typeof live = [];
  let undecryptableSkipped = 0;
  for (const object of live) {
    if (emitted.has(object.object_id)) continue;
    const payload = await decryptGraphObjectPayload(object, options.keyring).catch(() => undefined);
    const data = payload?.kind === "plaintext-json" ? payload.data : undefined;
    if (data === undefined) {
      undecryptableSkipped += 1;
      continue;
    }
    const sourceRef = sourcePathRefFromPayload(data);
    if (sourceRef && covered.has(sourceRef)) stale.push(object);
  }

  const staleByNamespace: Record<string, number> = {};
  for (const object of stale) {
    const namespace = object.visible_metadata.schema_namespace ?? "<none>";
    staleByNamespace[namespace] = (staleByNamespace[namespace] ?? 0) + 1;
  }

  let tombstoned = 0;
  let failed = 0;
  const failedReasons: Record<string, number> = {};
  if (!options.dryRun) {
    for (const object of stale) {
      const result = await options.store.tombstoneObject({
        object_id: object.object_id,
        expected_generation: options.store.status().generation,
        actor_id: options.actorId,
        recorded_at: options.now ?? new Date().toISOString()
      });
      if (result.ok) {
        tombstoned += 1;
      } else {
        failed += 1;
        failedReasons[result.reason] = (failedReasons[result.reason] ?? 0) + 1;
      }
    }
  }

  return {
    report_schema: "living-atlas-semantic-refresh-reconcile:v1",
    plaintext_policy: "counts-and-refs-only",
    dry_run: options.dryRun,
    scanned: live.length,
    covered_source_refs: covered.size,
    emitted_object_ids: emitted.size,
    stale: stale.length,
    tombstoned,
    failed,
    failed_reasons: failedReasons,
    undecryptable_skipped: undecryptableSkipped,
    stale_by_namespace: staleByNamespace
  };
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

async function main(): Promise<void> {
  const replicaDir = requireEnv("LIVING_ATLAS_LOCAL_REPLICA_DIR");
  const ledgerPath = requireEnv("LIVING_ATLAS_SEMANTIC_REFRESH_LEDGER_PATH");
  const keyringPath = process.env.LIVING_ATLAS_LOCAL_KEYRING?.trim() || join(replicaDir, "keyring.json");
  const graphDir = process.env.LIVING_ATLAS_LOCAL_GRAPH_DIR?.trim() || join(replicaDir, "graph");
  const passphrase = resolveLocalSecret("LIVING_ATLAS_LOCAL_KEYRING_PASSPHRASE");
  if (!passphrase) {
    throw new Error(
      "missing LIVING_ATLAS_LOCAL_KEYRING_PASSPHRASE (set it directly or via LIVING_ATLAS_LOCAL_KEYRING_PASSPHRASE_KEYCHAIN_SERVICE)"
    );
  }
  const deletedRefs = (process.env.LIVING_ATLAS_SEMANTIC_REFRESH_DELETED_REFS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const dryRun = process.env[ackEnv]?.trim() !== ackValue;

  const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as ImportLedgerSlice;
  if (!Array.isArray(ledger.object_refs) || !Array.isArray(ledger.source_outcomes)) {
    throw new Error("ledger is missing object_refs or source_outcomes");
  }

  const keyring = await new FileLocalKeyringStore(keyringPath).read(passphrase.value);
  const store = await FileLocalGraphStore.open({
    directory: graphDir,
    authorityId: keyring.authority_id,
    plaintextPersistence: "encrypt",
    keyring
  });

  const result = await reconcileSupersededSemanticObjects({
    store,
    keyring,
    ledger,
    deletedSourceRefs: deletedRefs,
    actorId: "logseq-semantic-refresh-reconcile",
    dryRun
  });

  const reportPath = process.env.LIVING_ATLAS_SEMANTIC_REFRESH_RECONCILE_REPORT_PATH?.trim();
  if (reportPath) {
    writeFileSync(reportPath, `${JSON.stringify(result, null, 2)}
`, { mode: 0o600 });
  }
  console.log(JSON.stringify(result, null, 2));
  if (result.failed > 0) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
