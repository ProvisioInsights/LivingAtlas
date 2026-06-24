import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { z } from "zod";

const ObjectRefSchema = z.object({
  candidate_id: z.string(),
  object_id: z.string(),
  object_type: z.string(),
  access_class: z.enum(["local-private", "quarantine"]),
  import_status: z.enum(["promoted", "quarantined", "updated-existing", "already-exists", "failed"]),
  source_id_hash: z.string(),
  evidence_hash: z.string()
}).passthrough();

const ConnectorImportLedgerSchema = z.object({
  record_schema: z.literal("living-atlas-connector-enrichment-local-import:v1"),
  recorded_at: z.string(),
  authority_id: z.string(),
  packet_hash: z.string(),
  packet_generated_at: z.string(),
  plaintext_policy: z.literal("hash-counts-refs-only"),
  sync: z.object({
    attempted: z.boolean()
  }).passthrough(),
  packet_totals: z.object({
    candidate_count: z.number().int().nonnegative(),
    promote_ready_count: z.number().int().nonnegative(),
    held_count: z.number().int().nonnegative(),
    duplicate_candidate_id_count: z.number().int().nonnegative()
  }),
  import_totals: z.object({
    created_objects: z.number().int().nonnegative(),
    updated_existing_objects: z.number().int().nonnegative().default(0),
    already_existing_objects: z.number().int().nonnegative(),
    promoted_objects: z.number().int().nonnegative(),
    quarantine_objects: z.number().int().nonnegative(),
    failed_objects: z.number().int().nonnegative()
  }),
  by_connector: z.record(z.string(), z.number().int().nonnegative()),
  by_fact_kind: z.record(z.string(), z.number().int().nonnegative()),
  by_decision: z.record(z.string(), z.number().int().nonnegative()),
  by_confidence: z.record(z.string(), z.number().int().nonnegative()),
  by_endpoint_type: z.record(z.string(), z.number().int().nonnegative()),
  by_predicate: z.record(z.string(), z.number().int().nonnegative()),
  graph_status: z.object({
    generation: z.number().int().nonnegative(),
    object_count: z.number().int().nonnegative(),
    active_object_count: z.number().int().nonnegative(),
    tombstone_count: z.number().int().nonnegative(),
    plaintext_persistence: z.enum(["redacted", "encrypted", "allowed"])
  }),
  object_refs: z.array(ObjectRefSchema)
});

type ConnectorImportLedger = z.infer<typeof ConnectorImportLedgerSchema>;

export type ConnectorEnrichmentCorpusReport = {
  report_schema: "living-atlas-connector-enrichment-corpus-report:v1";
  plaintext_policy: "hash-counts-refs-only";
  complete: boolean;
  failures: string[];
  record_count: number;
  deduped_packet_count: number;
  authority_ids: string[];
  packet_hashes: string[];
  sync_attempted_count: number;
  graph: {
    latest_generation: number;
    latest_object_count: number;
    latest_active_object_count: number;
    latest_tombstone_count: number;
    persistence_modes: string[];
  };
  packet_totals: {
    candidate_count: number;
    promote_ready_count: number;
    held_count: number;
    duplicate_candidate_id_count: number;
  };
  import_totals: {
    created_objects: number;
    updated_existing_objects: number;
    already_existing_objects: number;
    promoted_objects: number;
    quarantine_objects: number;
    failed_objects: number;
  };
  object_totals: {
    object_ref_count: number;
    unique_object_ref_count: number;
    promoted_refs: number;
    quarantine_refs: number;
    updated_existing_refs: number;
    already_existing_refs: number;
    failed_refs: number;
  };
  by_connector: Record<string, number>;
  by_fact_kind: Record<string, number>;
  by_decision: Record<string, number>;
  by_confidence: Record<string, number>;
  by_endpoint_type: Record<string, number>;
  by_predicate: Record<string, number>;
};

function envValue(key: string): string | undefined {
  const value = process.env[key]?.trim();
  return value ? value : undefined;
}

function requireEnv(key: string): string {
  const value = envValue(key);
  if (!value) {
    throw new Error(`missing ${key}`);
  }
  return value;
}

function parsePathList(value: string): string[] {
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function latestRecords(records: ConnectorImportLedger[]): ConnectorImportLedger[] {
  const byPacket = new Map<string, ConnectorImportLedger>();
  for (const record of records) {
    const previous = byPacket.get(record.packet_hash);
    if (!previous || Date.parse(record.recorded_at) >= Date.parse(previous.recorded_at)) {
      byPacket.set(record.packet_hash, record);
    }
  }
  return [...byPacket.values()].sort((left, right) => left.packet_hash.localeCompare(right.packet_hash));
}

function addCounts(target: Record<string, number>, source: Record<string, number>): void {
  for (const [key, value] of Object.entries(source)) {
    target[key] = (target[key] ?? 0) + value;
  }
}

function sortedRecord(source: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(source).sort(([left], [right]) => left.localeCompare(right)));
}

function sum(records: ConnectorImportLedger[], read: (record: ConnectorImportLedger) => number): number {
  return records.reduce((total, record) => total + read(record), 0);
}

async function readLedger(path: string): Promise<ConnectorImportLedger> {
  return ConnectorImportLedgerSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

export async function buildConnectorEnrichmentCorpusReport(input: {
  ledgerPaths: string[];
  requireComplete?: boolean;
}): Promise<ConnectorEnrichmentCorpusReport> {
  const records = await Promise.all(input.ledgerPaths.map(readLedger));
  const latest = latestRecords(records);
  const failures: string[] = [];
  const objectRefs = latest.flatMap((record) => record.object_refs);
  const uniqueObjectRefs = new Set(objectRefs.map((ref) => ref.object_id));
  const byConnector: Record<string, number> = {};
  const byFactKind: Record<string, number> = {};
  const byDecision: Record<string, number> = {};
  const byConfidence: Record<string, number> = {};
  const byEndpointType: Record<string, number> = {};
  const byPredicate: Record<string, number> = {};

  for (const record of latest) {
    addCounts(byConnector, record.by_connector);
    addCounts(byFactKind, record.by_fact_kind);
    addCounts(byDecision, record.by_decision);
    addCounts(byConfidence, record.by_confidence);
    addCounts(byEndpointType, record.by_endpoint_type);
    addCounts(byPredicate, record.by_predicate);
    if (record.sync.attempted) {
      failures.push(`packet ${record.packet_hash} attempted sync`);
    }
    if (record.import_totals.failed_objects > 0 || record.object_refs.some((ref) => ref.import_status === "failed")) {
      failures.push(`packet ${record.packet_hash} has failed connector imports`);
    }
    if (record.graph_status.plaintext_persistence !== "encrypted") {
      failures.push(`packet ${record.packet_hash} was not written with encrypted local persistence`);
    }
  }

  const latestGraph = latest
    .map((record) => record.graph_status)
    .sort((left, right) => right.generation - left.generation)[0];

  const report: ConnectorEnrichmentCorpusReport = {
    report_schema: "living-atlas-connector-enrichment-corpus-report:v1",
    plaintext_policy: "hash-counts-refs-only",
    complete: failures.length === 0,
    failures,
    record_count: records.length,
    deduped_packet_count: latest.length,
    authority_ids: [...new Set(latest.map((record) => record.authority_id))].sort(),
    packet_hashes: latest.map((record) => record.packet_hash).sort(),
    sync_attempted_count: latest.filter((record) => record.sync.attempted).length,
    graph: {
      latest_generation: latestGraph?.generation ?? 0,
      latest_object_count: latestGraph?.object_count ?? 0,
      latest_active_object_count: latestGraph?.active_object_count ?? 0,
      latest_tombstone_count: latestGraph?.tombstone_count ?? 0,
      persistence_modes: [...new Set(latest.map((record) => record.graph_status.plaintext_persistence))].sort()
    },
    packet_totals: {
      candidate_count: sum(latest, (record) => record.packet_totals.candidate_count),
      promote_ready_count: sum(latest, (record) => record.packet_totals.promote_ready_count),
      held_count: sum(latest, (record) => record.packet_totals.held_count),
      duplicate_candidate_id_count: sum(latest, (record) => record.packet_totals.duplicate_candidate_id_count)
    },
    import_totals: {
      created_objects: sum(latest, (record) => record.import_totals.created_objects),
      updated_existing_objects: sum(latest, (record) => record.import_totals.updated_existing_objects),
      already_existing_objects: sum(latest, (record) => record.import_totals.already_existing_objects),
      promoted_objects: sum(latest, (record) => record.import_totals.promoted_objects),
      quarantine_objects: sum(latest, (record) => record.import_totals.quarantine_objects),
      failed_objects: sum(latest, (record) => record.import_totals.failed_objects)
    },
    object_totals: {
      object_ref_count: objectRefs.length,
      unique_object_ref_count: uniqueObjectRefs.size,
      promoted_refs: objectRefs.filter((ref) => ref.import_status === "promoted").length,
      quarantine_refs: objectRefs.filter((ref) => ref.import_status === "quarantined").length,
      updated_existing_refs: objectRefs.filter((ref) => ref.import_status === "updated-existing").length,
      already_existing_refs: objectRefs.filter((ref) => ref.import_status === "already-exists").length,
      failed_refs: objectRefs.filter((ref) => ref.import_status === "failed").length
    },
    by_connector: sortedRecord(byConnector),
    by_fact_kind: sortedRecord(byFactKind),
    by_decision: sortedRecord(byDecision),
    by_confidence: sortedRecord(byConfidence),
    by_endpoint_type: sortedRecord(byEndpointType),
    by_predicate: sortedRecord(byPredicate)
  };

  if (input.requireComplete && !report.complete) {
    throw new Error(`connector enrichment corpus incomplete: ${report.failures.join(", ")}`);
  }

  return report;
}

async function main(): Promise<void> {
  const report = await buildConnectorEnrichmentCorpusReport({
    ledgerPaths: parsePathList(requireEnv("LIVING_ATLAS_CONNECTOR_ENRICHMENT_LEDGER_PATHS")),
    requireComplete: envValue("LIVING_ATLAS_CONNECTOR_ENRICHMENT_REQUIRE_COMPLETE") === "1"
  });
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
