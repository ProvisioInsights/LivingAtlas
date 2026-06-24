import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  ConfidenceSchema,
  EndpointTypeSchema,
  IsoTimestampSchema,
  PredicateSchema
} from "@living-atlas/contracts";
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

const CandidateDecisionSchema = z.enum(["proposed", "promote", "defer", "reject"]);
type CandidateDecision = z.infer<typeof CandidateDecisionSchema>;

const ProposedFactKindSchema = z.enum(["endpoint", "edge", "occurrence", "topic", "source-note"]);
type ProposedFactKind = z.infer<typeof ProposedFactKindSchema>;

const EvidenceKindSchema = z.enum(["metadata", "snippet", "transcript", "attachment", "calendar-event", "manual-note"]);
type EvidenceKind = z.infer<typeof EvidenceKindSchema>;

const HashRefSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const CandidateIdSchema = z.string().regex(/^la_enrich_candidate_[A-Za-z0-9_-]{8,}$/);

const EnrichmentCandidateSchema = z
  .object({
    candidate_id: CandidateIdSchema,
    source: z
      .object({
        connector: ConnectorSourceSchema,
        source_id_hash: HashRefSchema,
        source_time: IsoTimestampSchema.optional(),
        fetched_at: IsoTimestampSchema,
        evidence_hash: HashRefSchema,
        evidence_kind: EvidenceKindSchema
      })
      .strict(),
    proposed_fact: z
      .object({
        kind: ProposedFactKindSchema,
        endpoint_type: EndpointTypeSchema.optional(),
        predicate: PredicateSchema.optional(),
        confidence: ConfidenceSchema
      })
      .strict(),
    decision: CandidateDecisionSchema,
    plaintext_evidence: z.string().optional(),
    rationale: z.string().optional()
  })
  .strict()
  .superRefine((candidate, ctx) => {
    if (candidate.decision === "promote" && candidate.proposed_fact.confidence !== "high") {
      ctx.addIssue({
        code: "custom",
        path: ["decision"],
        message: "promoted connector enrichment candidates must be high confidence"
      });
    }

    if ((candidate.proposed_fact.kind === "endpoint" || candidate.proposed_fact.kind === "occurrence" || candidate.proposed_fact.kind === "topic") && !candidate.proposed_fact.endpoint_type) {
      ctx.addIssue({
        code: "custom",
        path: ["proposed_fact", "endpoint_type"],
        message: `${candidate.proposed_fact.kind} candidates require endpoint_type`
      });
    }

    if (candidate.proposed_fact.kind === "edge" && !candidate.proposed_fact.predicate) {
      ctx.addIssue({
        code: "custom",
        path: ["proposed_fact", "predicate"],
        message: "edge candidates require predicate"
      });
    }
  });
export type EnrichmentCandidate = z.infer<typeof EnrichmentCandidateSchema>;

export const ConnectorEnrichmentPacketSchema = z
  .object({
    packet_schema: z.literal("living-atlas-connector-enrichment-packet:v1"),
    plaintext_policy: z.literal("local-private-connector-enrichment-packet"),
    source_path_policy: z.enum(["connector-id-hash-only", "redacted"]),
    generated_at: IsoTimestampSchema,
    connector_sources: z.array(ConnectorSourceSchema).min(1),
    candidates: z.array(EnrichmentCandidateSchema)
  })
  .strict()
  .superRefine((packet, ctx) => {
    const declaredSources = new Set(packet.connector_sources);
    for (const [index, candidate] of packet.candidates.entries()) {
      if (!declaredSources.has(candidate.source.connector)) {
        ctx.addIssue({
          code: "custom",
          path: ["candidates", index, "source", "connector"],
          message: "candidate connector must be declared in connector_sources"
        });
      }
    }
  });
export type ConnectorEnrichmentPacket = z.infer<typeof ConnectorEnrichmentPacketSchema>;

export type ConnectorEnrichmentReport = {
  report_schema: "living-atlas-connector-enrichment-report:v1";
  plaintext_policy: "hash-counts-refs-only";
  packet_schema: "living-atlas-connector-enrichment-packet:v1";
  generated_at: string;
  connector_sources: ConnectorSource[];
  candidate_count: number;
  duplicate_candidate_id_count: number;
  promote_ready_count: number;
  held_count: number;
  by_connector: Record<ConnectorSource, number>;
  by_fact_kind: Record<ProposedFactKind, number>;
  by_decision: Record<CandidateDecision, number>;
  by_confidence: Record<"high" | "medium" | "low", number>;
  by_endpoint_type: Record<string, number>;
  by_predicate: Record<string, number>;
  by_evidence_kind: Record<EvidenceKind, number>;
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

function duplicateCount(values: string[]): number {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }
  return duplicates.size;
}

export function buildConnectorEnrichmentReport(packet: ConnectorEnrichmentPacket): ConnectorEnrichmentReport {
  const byConnector = {} as Record<ConnectorSource, number>;
  const byFactKind = {} as Record<ProposedFactKind, number>;
  const byDecision = {} as Record<CandidateDecision, number>;
  const byConfidence = {} as Record<"high" | "medium" | "low", number>;
  const byEndpointType: Record<string, number> = {};
  const byPredicate: Record<string, number> = {};
  const byEvidenceKind = {} as Record<EvidenceKind, number>;

  for (const candidate of packet.candidates) {
    increment(byConnector, candidate.source.connector);
    increment(byFactKind, candidate.proposed_fact.kind);
    increment(byDecision, candidate.decision);
    increment(byConfidence, candidate.proposed_fact.confidence);
    increment(byEvidenceKind, candidate.source.evidence_kind);
    if (candidate.proposed_fact.endpoint_type) {
      byEndpointType[candidate.proposed_fact.endpoint_type] = (byEndpointType[candidate.proposed_fact.endpoint_type] ?? 0) + 1;
    }
    if (candidate.proposed_fact.predicate) {
      byPredicate[candidate.proposed_fact.predicate] = (byPredicate[candidate.proposed_fact.predicate] ?? 0) + 1;
    }
  }

  const promoteReadyCount = packet.candidates.filter((candidate) => candidate.decision === "promote" && candidate.proposed_fact.confidence === "high").length;

  return {
    report_schema: "living-atlas-connector-enrichment-report:v1",
    plaintext_policy: "hash-counts-refs-only",
    packet_schema: packet.packet_schema,
    generated_at: packet.generated_at,
    connector_sources: [...packet.connector_sources].sort(),
    candidate_count: packet.candidates.length,
    duplicate_candidate_id_count: duplicateCount(packet.candidates.map((candidate) => candidate.candidate_id)),
    promote_ready_count: promoteReadyCount,
    held_count: packet.candidates.length - promoteReadyCount,
    by_connector: sortedRecord(byConnector),
    by_fact_kind: sortedRecord(byFactKind),
    by_decision: sortedRecord(byDecision),
    by_confidence: sortedRecord(byConfidence),
    by_endpoint_type: sortedRecord(byEndpointType),
    by_predicate: sortedRecord(byPredicate),
    by_evidence_kind: sortedRecord(byEvidenceKind)
  };
}

export async function buildConnectorEnrichmentReportFromPath(packetPath: string): Promise<ConnectorEnrichmentReport> {
  const packet = ConnectorEnrichmentPacketSchema.parse(JSON.parse(await readFile(packetPath, "utf8")));
  return buildConnectorEnrichmentReport(packet);
}

async function main(): Promise<void> {
  const report = await buildConnectorEnrichmentReportFromPath(requireEnv("LIVING_ATLAS_CONNECTOR_ENRICHMENT_PACKET_PATH"));
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
