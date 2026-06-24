import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildConnectorCoverageReport,
  buildConnectorCoverageReportFromPath,
  ConnectorCoverageManifestSchema
} from "./connector-coverage-report";

const queryHash = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const baseManifest = {
  manifest_schema: "living-atlas-connector-coverage-manifest:v1",
  plaintext_policy: "counts-only-connector-coverage-manifest",
  source_path_policy: "connector-id-hash-only",
  generated_at: "2026-06-24T00:00:00.000Z",
  expected_connectors: ["outlook-calendar", "fireflies", "teams"],
  coverage_entries: [
    {
      connector: "outlook-calendar",
      status: "queried",
      query_kind: "calendar-window",
      window_start: "2026-06-01T00:00:00.000Z",
      window_end: "2026-06-24T00:00:00.000Z",
      fetched_at: "2026-06-24T00:01:00.000Z",
      limit: 20,
      result_count: 20,
      page_count: 1,
      query_hash: queryHash,
      evidence_kind: "calendar-event",
      mutation_attempted: false
    },
    {
      connector: "fireflies",
      status: "queried",
      query_kind: "transcript-window",
      window_start: "2026-06-01T00:00:00.000Z",
      window_end: "2026-06-24T00:00:00.000Z",
      fetched_at: "2026-06-24T00:02:00.000Z",
      limit: 10,
      result_count: 10,
      page_count: 1,
      evidence_kind: "transcript",
      mutation_attempted: false
    },
    {
      connector: "teams",
      status: "unavailable",
      query_kind: "tool-discovery",
      fetched_at: "2026-06-24T00:03:00.000Z",
      mutation_attempted: false,
      reason_code: "tool-not-exposed"
    }
  ]
} as const;

describe("connector coverage report", () => {
  it("summarizes connector availability without exposing private probe details", async () => {
    const root = await mkdtemp(join(tmpdir(), "living-atlas-connector-coverage-"));
    try {
      const manifestPath = join(root, "coverage.json");
      await writeFile(manifestPath, JSON.stringify(baseManifest, null, 2));

      const report = await buildConnectorCoverageReportFromPath(manifestPath);

      expect(report.report_schema).toBe("living-atlas-connector-coverage-report:v1");
      expect(report.plaintext_policy).toBe("hash-counts-refs-only");
      expect(report.complete).toBe(true);
      expect(report.entry_count).toBe(3);
      expect(report.connector_count).toBe(3);
      expect(report.queried_count).toBe(2);
      expect(report.unavailable_count).toBe(1);
      expect(report.total_result_count).toBe(30);
      expect(report.by_connector).toEqual({
        fireflies: 1,
        "outlook-calendar": 1,
        teams: 1
      });
      expect(report.by_status).toEqual({
        queried: 2,
        unavailable: 1
      });
      expect(report.by_reason_code).toEqual({
        "tool-not-exposed": 1
      });
      expect(report.by_connector_status).toEqual({
        fireflies: { queried: 1 },
        "outlook-calendar": { queried: 1 },
        teams: { unavailable: 1 }
      });
      expect(JSON.stringify(report)).not.toContain(root);
      expect(JSON.stringify(report)).not.toContain("Synthetic coverage bait alpha");
      expect(JSON.stringify(report)).not.toContain("Synthetic coverage bait beta");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects manifest entries with private query text", () => {
    const parsed = ConnectorCoverageManifestSchema.safeParse({
      ...baseManifest,
      coverage_entries: [
        {
          ...baseManifest.coverage_entries[0],
          private_query_text: "Synthetic coverage bait alpha"
        }
      ]
    });

    expect(parsed.success).toBe(false);
  });

  it("marks failed probes incomplete", () => {
    const manifest = ConnectorCoverageManifestSchema.parse({
      ...baseManifest,
      coverage_entries: [
        {
          connector: "outlook-email",
          status: "failed",
          query_kind: "message-window",
          fetched_at: "2026-06-24T00:04:00.000Z",
          mutation_attempted: false,
          reason_code: "connector-auth-denied"
        }
      ]
    });

    const report = buildConnectorCoverageReport(manifest);

    expect(report.complete).toBe(false);
    expect(report.failed_count).toBe(1);
    expect(report.mutation_attempted_count).toBe(0);
    expect(report.failures).toEqual([
      "missing coverage entry for expected connector fireflies",
      "missing coverage entry for expected connector outlook-calendar",
      "missing coverage entry for expected connector teams",
      "connector outlook-email coverage probe failed with reason connector-auth-denied"
    ]);
  });

  it("rejects mutating coverage probes", () => {
    const parsed = ConnectorCoverageManifestSchema.safeParse({
      ...baseManifest,
      coverage_entries: [
        {
          connector: "sharepoint",
          status: "skipped",
          query_kind: "tool-discovery",
          fetched_at: "2026-06-24T00:05:00.000Z",
          mutation_attempted: true,
          reason_code: "operator-error"
        }
      ]
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.some((issue) => issue.message.includes("read-only"))).toBe(true);
  });
});
