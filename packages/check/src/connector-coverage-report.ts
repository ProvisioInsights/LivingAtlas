import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { IsoTimestampSchema } from "@living-atlas/contracts";
import { z } from "zod";

const ConnectorSourceSchema = z.enum([
  "outlook-email",
  "outlook-calendar",
  "fireflies",
  "teams",
  "sharepoint",
  "manual-file",
  "other"
]);
type ConnectorSource = z.infer<typeof ConnectorSourceSchema>;

const ConnectorCoverageStatusSchema = z.enum(["queried", "limited", "unavailable", "skipped", "failed"]);
type ConnectorCoverageStatus = z.infer<typeof ConnectorCoverageStatusSchema>;

const QueryKindSchema = z.enum([
  "calendar-window",
  "transcript-window",
  "message-window",
  "file-window",
  "tool-discovery",
  "manual-review",
  "other"
]);
type QueryKind = z.infer<typeof QueryKindSchema>;

const EvidenceKindSchema = z.enum(["metadata", "snippet", "transcript", "attachment", "calendar-event", "manual-note"]);
type EvidenceKind = z.infer<typeof EvidenceKindSchema>;

const HashRefSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const ReasonCodeSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{2,80}$/);

const ConnectorCoverageEntrySchema = z
  .object({
    connector: ConnectorSourceSchema,
    status: ConnectorCoverageStatusSchema,
    query_kind: QueryKindSchema,
    window_start: IsoTimestampSchema.optional(),
    window_end: IsoTimestampSchema.optional(),
    fetched_at: IsoTimestampSchema.optional(),
    limit: z.number().int().nonnegative().optional(),
    result_count: z.number().int().nonnegative().optional(),
    page_count: z.number().int().nonnegative().optional(),
    query_hash: HashRefSchema.optional(),
    evidence_kind: EvidenceKindSchema.optional(),
    mutation_attempted: z.boolean().default(false),
    reason_code: ReasonCodeSchema.optional()
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (entry.status === "queried" && entry.result_count === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["result_count"],
        message: "queried connector coverage entries require result_count"
      });
    }

    if (entry.status !== "queried" && !entry.reason_code) {
      ctx.addIssue({
        code: "custom",
        path: ["reason_code"],
        message: "non-queried connector coverage entries require a terminal reason_code"
      });
    }

    if (entry.mutation_attempted) {
      ctx.addIssue({
        code: "custom",
        path: ["mutation_attempted"],
        message: "connector coverage probes must be read-only"
      });
    }
  });
type ConnectorCoverageEntry = z.infer<typeof ConnectorCoverageEntrySchema>;

export const ConnectorCoverageManifestSchema = z
  .object({
    manifest_schema: z.literal("living-atlas-connector-coverage-manifest:v1"),
    plaintext_policy: z.literal("counts-only-connector-coverage-manifest"),
    source_path_policy: z.enum(["connector-id-hash-only", "redacted"]),
    generated_at: IsoTimestampSchema,
    expected_connectors: z.array(ConnectorSourceSchema).optional(),
    coverage_entries: z.array(ConnectorCoverageEntrySchema).min(1)
  })
  .strict();
export type ConnectorCoverageManifest = z.infer<typeof ConnectorCoverageManifestSchema>;

export type ConnectorCoverageReport = {
  report_schema: "living-atlas-connector-coverage-report:v1";
  plaintext_policy: "hash-counts-refs-only";
  manifest_schema: "living-atlas-connector-coverage-manifest:v1";
  generated_at: string;
  complete: boolean;
  failures: string[];
  expected_connectors: ConnectorSource[];
  connector_count: number;
  entry_count: number;
  queried_count: number;
  limited_count: number;
  unavailable_count: number;
  skipped_count: number;
  failed_count: number;
  mutation_attempted_count: number;
  total_result_count: number;
  by_connector: Record<ConnectorSource, number>;
  by_status: Record<ConnectorCoverageStatus, number>;
  by_query_kind: Record<QueryKind, number>;
  by_evidence_kind: Record<EvidenceKind, number>;
  by_reason_code: Record<string, number>;
  by_connector_status: Record<string, Record<ConnectorCoverageStatus, number>>;
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

function increment<T extends string>(counts: Record<T, number>, key: T): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function sortedRecord<T extends string>(counts: Record<T, number>): Record<T, number> {
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right))) as Record<T, number>;
}

function sortedNestedStatusRecord(
  counts: Record<string, Record<ConnectorCoverageStatus, number>>
): Record<string, Record<ConnectorCoverageStatus, number>> {
  return Object.fromEntries(
    Object.entries(counts)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([connector, statuses]) => [connector, sortedRecord(statuses)])
  );
}

function connectorSet(entries: ConnectorCoverageEntry[]): Set<ConnectorSource> {
  return new Set(entries.map((entry) => entry.connector));
}

export function buildConnectorCoverageReport(manifest: ConnectorCoverageManifest): ConnectorCoverageReport {
  const byConnector = {} as Record<ConnectorSource, number>;
  const byStatus = {} as Record<ConnectorCoverageStatus, number>;
  const byQueryKind = {} as Record<QueryKind, number>;
  const byEvidenceKind = {} as Record<EvidenceKind, number>;
  const byReasonCode: Record<string, number> = {};
  const byConnectorStatus: Record<string, Record<ConnectorCoverageStatus, number>> = {};
  const expectedConnectors = [...(manifest.expected_connectors ?? connectorSet(manifest.coverage_entries))].sort();
  const coveredConnectors = connectorSet(manifest.coverage_entries);
  const failures: string[] = [];

  for (const connector of expectedConnectors) {
    if (!coveredConnectors.has(connector)) {
      failures.push(`missing coverage entry for expected connector ${connector}`);
    }
  }

  for (const entry of manifest.coverage_entries) {
    increment(byConnector, entry.connector);
    increment(byStatus, entry.status);
    increment(byQueryKind, entry.query_kind);

    byConnectorStatus[entry.connector] ??= {} as Record<ConnectorCoverageStatus, number>;
    increment(byConnectorStatus[entry.connector]!, entry.status);

    if (entry.evidence_kind) {
      increment(byEvidenceKind, entry.evidence_kind);
    }
    if (entry.reason_code) {
      byReasonCode[entry.reason_code] = (byReasonCode[entry.reason_code] ?? 0) + 1;
    }
    if (entry.mutation_attempted) {
      failures.push(`connector ${entry.connector} attempted mutation during coverage probe`);
    }
    if (entry.status === "failed") {
      failures.push(`connector ${entry.connector} coverage probe failed with reason ${entry.reason_code ?? "missing-reason"}`);
    }
  }

  const mutationAttemptedCount = manifest.coverage_entries.filter((entry) => entry.mutation_attempted).length;
  const failedCount = manifest.coverage_entries.filter((entry) => entry.status === "failed").length;

  return {
    report_schema: "living-atlas-connector-coverage-report:v1",
    plaintext_policy: "hash-counts-refs-only",
    manifest_schema: manifest.manifest_schema,
    generated_at: manifest.generated_at,
    complete: failures.length === 0,
    failures,
    expected_connectors: expectedConnectors,
    connector_count: connectorSet(manifest.coverage_entries).size,
    entry_count: manifest.coverage_entries.length,
    queried_count: manifest.coverage_entries.filter((entry) => entry.status === "queried").length,
    limited_count: manifest.coverage_entries.filter((entry) => entry.status === "limited").length,
    unavailable_count: manifest.coverage_entries.filter((entry) => entry.status === "unavailable").length,
    skipped_count: manifest.coverage_entries.filter((entry) => entry.status === "skipped").length,
    failed_count: failedCount,
    mutation_attempted_count: mutationAttemptedCount,
    total_result_count: manifest.coverage_entries.reduce((total, entry) => total + (entry.result_count ?? 0), 0),
    by_connector: sortedRecord(byConnector),
    by_status: sortedRecord(byStatus),
    by_query_kind: sortedRecord(byQueryKind),
    by_evidence_kind: sortedRecord(byEvidenceKind),
    by_reason_code: sortedRecord(byReasonCode),
    by_connector_status: sortedNestedStatusRecord(byConnectorStatus)
  };
}

export async function buildConnectorCoverageReportFromPath(manifestPath: string): Promise<ConnectorCoverageReport> {
  const manifest = ConnectorCoverageManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
  return buildConnectorCoverageReport(manifest);
}

async function main(): Promise<void> {
  const report = await buildConnectorCoverageReportFromPath(requireEnv("LIVING_ATLAS_CONNECTOR_COVERAGE_MANIFEST_PATH"));
  if (envValue("LIVING_ATLAS_CONNECTOR_COVERAGE_REQUIRE_COMPLETE") === "1" && !report.complete) {
    throw new Error(`connector coverage incomplete: ${report.failures.join(", ")}`);
  }
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
