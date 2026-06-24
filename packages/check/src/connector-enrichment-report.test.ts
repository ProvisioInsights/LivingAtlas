import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildConnectorEnrichmentReport,
  buildConnectorEnrichmentReportFromPath,
  ConnectorEnrichmentPacketSchema
} from "./connector-enrichment-report";

const hashA = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const hashB = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const hashC = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const hashD = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

const basePacket = {
  packet_schema: "living-atlas-connector-enrichment-packet:v1",
  plaintext_policy: "local-private-connector-enrichment-packet",
  source_path_policy: "connector-id-hash-only",
  generated_at: "2026-06-24T00:00:00.000Z",
  connector_sources: ["outlook-email", "fireflies"],
  candidates: [
    {
      candidate_id: "la_enrich_candidate_fixture0001",
      source: {
        connector: "outlook-email",
        source_id_hash: hashA,
        source_time: "2026-06-23T18:00:00.000Z",
        fetched_at: "2026-06-24T00:00:00.000Z",
        evidence_hash: hashB,
        evidence_kind: "snippet"
      },
      proposed_fact: {
        kind: "endpoint",
        endpoint_type: "person",
        confidence: "high",
        local_private_payload: {
          name: "Fixture payload bait delta"
        }
      },
      decision: "promote",
      plaintext_evidence: "Fixture evidence bait alpha that must not be reported.",
      rationale: "Fixture review bait beta that must not be reported."
    },
    {
      candidate_id: "la_enrich_candidate_fixture0002",
      source: {
        connector: "fireflies",
        source_id_hash: hashC,
        fetched_at: "2026-06-24T00:00:00.000Z",
        evidence_hash: hashD,
        evidence_kind: "transcript"
      },
      proposed_fact: {
        kind: "edge",
        predicate: "discussed-at",
        confidence: "medium"
      },
      decision: "defer",
      plaintext_evidence: "Fixture evidence bait gamma that must not be reported."
    }
  ]
} as const;

describe("connector enrichment report", () => {
  it("summarizes a local-private connector packet without plaintext evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "living-atlas-connector-report-"));
    try {
      const packetPath = join(root, "packet.json");
      await writeFile(packetPath, JSON.stringify(basePacket, null, 2));

      const report = await buildConnectorEnrichmentReportFromPath(packetPath);

      expect(report.report_schema).toBe("living-atlas-connector-enrichment-report:v1");
      expect(report.plaintext_policy).toBe("hash-counts-refs-only");
      expect(report.candidate_count).toBe(2);
      expect(report.promote_ready_count).toBe(1);
      expect(report.held_count).toBe(1);
      expect(report.by_connector).toEqual({
        fireflies: 1,
        "outlook-email": 1
      });
      expect(report.by_fact_kind).toEqual({
        edge: 1,
        endpoint: 1
      });
      expect(report.by_decision).toEqual({
        defer: 1,
        promote: 1
      });
      expect(report.by_confidence).toEqual({
        high: 1,
        medium: 1
      });
      expect(report.by_endpoint_type).toEqual({ person: 1 });
      expect(report.by_predicate).toEqual({ "discussed-at": 1 });
      expect(report.by_evidence_kind).toEqual({
        snippet: 1,
        transcript: 1
      });
      expect(JSON.stringify(report)).not.toContain(root);
      expect(JSON.stringify(report)).not.toContain("Fixture evidence bait alpha");
      expect(JSON.stringify(report)).not.toContain("Fixture evidence bait gamma");
      expect(JSON.stringify(report)).not.toContain("Fixture review bait beta");
      expect(JSON.stringify(report)).not.toContain("Fixture payload bait delta");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects promoted connector candidates that are not high confidence", () => {
    const invalid = {
      ...basePacket,
      candidates: [
        {
          ...basePacket.candidates[1],
          decision: "promote"
        }
      ]
    };

    const parsed = ConnectorEnrichmentPacketSchema.safeParse(invalid);

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.some((issue) => issue.message.includes("must be high confidence"))).toBe(true);
  });

  it("counts duplicate candidate ids without exposing evidence", () => {
    const packet = ConnectorEnrichmentPacketSchema.parse({
      ...basePacket,
      candidates: [
        basePacket.candidates[0],
        {
          ...basePacket.candidates[1],
          candidate_id: basePacket.candidates[0].candidate_id
        }
      ]
    });

    const report = buildConnectorEnrichmentReport(packet);

    expect(report.duplicate_candidate_id_count).toBe(1);
    expect(JSON.stringify(report)).not.toContain("Synthetic");
  });

  it("rejects candidates from undeclared connector sources", () => {
    const parsed = ConnectorEnrichmentPacketSchema.safeParse({
      ...basePacket,
      connector_sources: ["outlook-email"],
      candidates: basePacket.candidates
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.some((issue) => issue.message.includes("must be declared"))).toBe(true);
  });
});
