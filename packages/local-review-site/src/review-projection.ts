import { createHash } from "node:crypto";
import {
  CanonicalPayloadSchema,
  canonicalPayloadObjectId,
  type CanonicalPayload,
  type CanonicalEvidencePayload,
  type CanonicalParityRecordPayload,
  type CanonicalReviewItemPayload,
  type GraphObjectEnvelope
} from "@living-atlas/contracts";
import type { CanonicalPayloadDecryptor } from "@living-atlas/graph-service";

export type LocalReviewQueueItem = {
  review_id: string;
  candidate_id: string;
  review_record: CanonicalReviewItemPayload;
  recommendation: CanonicalReviewItemPayload["recommendation"];
  resolution_state: CanonicalReviewItemPayload["resolution_state"];
  research_requested: boolean;
  research_requested_all: boolean;
  research_requested_units: SourceMeaningUnit[];
  headline: string;
  proposal_label: string;
  proposed_object_ids: string[];
  proposed_records: CanonicalPayload[];
  evidence_ids: string[];
  evidence: CanonicalEvidencePayload[];
  source_context: CanonicalEvidencePayload[];
  parity_ids: string[];
  parity_records: CanonicalParityRecordPayload[];
  source_accounting: SourceMeaningAccounting;
  missing_references: string[];
  context_unavailable: boolean;
};

export type SourceMeaningKind = "entity" | "attribute" | "fact" | "relationship" | "context" | "provenance";

export type SourceMeaningUnit = {
  unit_id: `sha256:${string}`;
  source_text: string;
  atlas_text: string;
  kind: SourceMeaningKind;
};

export type SourceMeaningAccounting = {
  exact_source_preserved: boolean;
  meaningful_units: SourceMeaningUnit[];
  excluded_units: Array<{
    source_text: string;
    reason: "editorial migration commentary" | "source organization" | "source-system instruction";
  }>;
};

export type LocalReviewQueue = {
  owner_review: LocalReviewQueueItem[];
  research: LocalReviewQueueItem[];
  deferred: LocalReviewQueueItem[];
  automatic: LocalReviewQueueItem[];
};

const DecryptableTypes = new Set<GraphObjectEnvelope["object_type"]>([
  "review", "evidence", "assertion", "edge", "entity", "manifest"
]);

function meaningfulHeadline(
  observation: Extract<CanonicalPayload, { schema: "atlas.observation:v1" }> | undefined,
  sourceContext: CanonicalEvidencePayload[]
): string {
  if (observation && !observation.statement.startsWith("Imported source coverage ")) {
    return observation.statement;
  }
  const lines = sourceContext.flatMap((evidence) => evidence.excerpt?.split(/\r?\n/) ?? []);
  for (const key of ["title", "name", "description", "summary"]) {
    const value = lines
      .map((line) => new RegExp(`^${key}::\\s*(.+)$`, "i").exec(line.trim())?.[1]?.trim())
      .find(Boolean);
    if (value) return value;
  }
  const contextual = lines
    .filter((line) => !/^[A-Za-z0-9_-]+::/.test(line.trim()))
    .map((line) => line.trim().replace(/^[-#>*\s]+/, "").replaceAll("**", "").trim())
    .find((line) => line.length > 12 && !/^(context|notes?|details?)[:.]?$/i.test(line));
  return contextual ?? observation?.statement ?? sourceContext[0]?.excerpt ?? "Review candidate";
}

const editorialParenthetical = /\(([^()]*(?:initial stub|migration note|migration pass|enrichment pass|no web enrichment performed|no web research performed)[^()]*)\)/gi;

export function accountSourceMeaning(sourceContext: CanonicalEvidencePayload[]): SourceMeaningAccounting {
  const source = sourceContext.map((item) => item.excerpt ?? "").join("");
  const segments = sourceSegments(source);
  const meaningfulUnits: SourceMeaningUnit[] = [];
  const excludedUnits: SourceMeaningAccounting["excluded_units"] = [];

  for (const segment of segments) {
    const excludedReason = sourceExclusionReason(segment);
    if (excludedReason) {
      excludedUnits.push({ source_text: segment, reason: excludedReason });
      continue;
    }
    let withoutEditorial = segment;
    for (const match of segment.matchAll(editorialParenthetical)) {
      const sourceText = match[1]?.trim();
      if (sourceText) excludedUnits.push({ source_text: sourceText, reason: "editorial migration commentary" });
    }
    withoutEditorial = withoutEditorial.replace(editorialParenthetical, "").replace(/\s+([,.;:])/g, "$1").replace(/\s{2,}/g, " ").trim();
    for (const match of withoutEditorial.matchAll(/\bno web (?:enrichment|research) performed\b/gi)) {
      excludedUnits.push({ source_text: match[0], reason: "editorial migration commentary" });
    }
    withoutEditorial = withoutEditorial
      .replace(/(?:·\s*)?\bno web (?:enrichment|research) performed\b(?:\s*·)?/gi, " · ")
      .replace(/\s*·\s*·\s*/g, " · ")
      .replace(/^\s*·\s*|\s*·\s*$/g, "")
      .trim();
    const unit = meaningUnit(withoutEditorial);
    if (unit && /^[-*+]\s+\*\*/.test(unit.source_text) && /\*\*\s*$/.test(unit.source_text) && !unit.atlas_text.includes(":")) {
      excludedUnits.push({ source_text: unit.source_text, reason: "source organization" });
    } else if (unit) {
      meaningfulUnits.push({ ...unit, unit_id: sourceUnitId(unit) });
    }
  }

  return {
    exact_source_preserved: sourceContext.some((item) => item.extraction_method === "canonical-markdown-lossless-v1"),
    meaningful_units: meaningfulUnits,
    excluded_units: excludedUnits
  };
}

function sourceExclusionReason(segment: string): SourceMeaningAccounting["excluded_units"][number]["reason"] | undefined {
  const bulletBody = /^[-*+]\s+(.+)$/.exec(segment)?.[1]?.trim();
  if (bulletBody?.startsWith("**") && bulletBody.endsWith("**") && !/:\*\*\s*\S/.test(bulletBody)) return "source organization";
  if (/^type::\s*query$/i.test(segment)
    || /\bLogseq\b/i.test(segment)
    || /\{\{query\b/i.test(segment)
    || /\bgrep\s+-[A-Za-z]*n[A-Za-z]*\b/i.test(segment)
    || /\bpages\/\*\.md\b/i.test(segment)) return "source-system instruction";
  return undefined;
}

function sourceSegments(source: string): string[] {
  const expanded = source
    .replace(/\s+-\s+(?=\*\*[^*]+:\*\*)/g, "\n- ")
    .replace(/\s+(?=[A-Za-z][A-Za-z0-9_-]*::\s)/g, "\n");
  const segments: string[] = [];
  let current = "";
  const flush = () => {
    if (current.trim()) segments.push(current.trim());
    current = "";
  };
  for (const rawLine of expanded.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      flush();
      continue;
    }
    const startsUnit = /^[-*+]\s+/.test(line) || /^#{1,6}\s+/.test(line) || /^[A-Za-z][A-Za-z0-9_-]*::\s*/.test(line);
    if (startsUnit) flush();
    current = current ? `${current} ${line}` : line;
  }
  flush();
  return segments;
}

function meaningUnit(sourceText: string): Omit<SourceMeaningUnit, "unit_id"> | undefined {
  if (!sourceText) return undefined;
  const property = /^([A-Za-z][A-Za-z0-9_-]*)::\s*(.+)$/.exec(sourceText);
  if (property) {
    const key = property[1]!;
    const value = cleanKnowledgeText(property[2]!);
    if (!value) return undefined;
    return {
      source_text: sourceText,
      atlas_text: `${humanLabel(key)}: ${value}`,
      kind: /^source$/i.test(key) ? "provenance"
        : /^(?:org|organization|employer|role|relationship|manager|member|affiliation)$/i.test(key) ? "relationship"
          : /^(?:phone|email|address|birthday|date|website|url|location|last-contacted|full-name|alias|also-known-as)$/i.test(key) ? "fact"
            : "attribute"
    };
  }
  const heading = /^#{1,6}\s+(.+)$/.exec(sourceText);
  if (heading) {
    const value = cleanKnowledgeText(heading[1]!);
    return value ? { source_text: sourceText, atlas_text: value, kind: "entity" } : undefined;
  }
  const labeled = /^[-*+]\s+\*\*([^*]+?):\*\*\s*(.+)$/.exec(sourceText)
    ?? /^[-*+]\s+([A-Za-z][A-Za-z /&-]{0,48}):\s*(.+)$/.exec(sourceText);
  if (labeled) {
    const label = cleanKnowledgeText(labeled[1]!);
    const value = cleanKnowledgeText(labeled[2]!);
    if (!label || !value) return undefined;
    return {
      source_text: sourceText,
      atlas_text: `${label}: ${value}`,
      kind: /relationship|role|member|friend|family|works? (?:at|with)|reports? to/i.test(label) ? "relationship"
        : /source|evidence|confirmed|verified/i.test(label) ? "provenance"
          : /phone|email|address|birthday|date|website|url|location/i.test(label) ? "fact"
            : "context"
    };
  }
  const value = cleanKnowledgeText(sourceText.replace(/^[-*+]\s+/, ""));
  return value ? { source_text: sourceText, atlas_text: value, kind: "context" } : undefined;
}

function sourceUnitId(unit: Omit<SourceMeaningUnit, "unit_id">): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(`${unit.kind}:${unit.atlas_text}`).digest("hex")}`;
}

function cleanKnowledgeText(value: string): string {
  return value
    .replaceAll("**", "")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/\s+-\s*$/, "")
    .trim();
}

function humanLabel(value: string): string {
  const spaced = value.replaceAll("-", " ").replaceAll("_", " ");
  return `${spaced[0]?.toUpperCase() ?? ""}${spaced.slice(1)}`;
}

export async function projectLocalReviewQueue(input: {
  objects: GraphObjectEnvelope[];
  decryptPayload: CanonicalPayloadDecryptor;
}): Promise<LocalReviewQueue> {
  const payloads = new Map<string, CanonicalPayload>();
  for (const object of input.objects.filter((item) => DecryptableTypes.has(item.object_type) && !item.visible_metadata.tombstone)) {
    const payload = await input.decryptPayload(object);
    if (!payload) continue;
    const parsed = CanonicalPayloadSchema.safeParse(payload);
    if (parsed.success) payloads.set(canonicalPayloadObjectId(parsed.data), parsed.data);
  }
  const reviews = [...payloads.values()].filter((payload): payload is CanonicalReviewItemPayload => payload.schema === "atlas.review-item:v1");
  const itemFor = (review: CanonicalReviewItemPayload): LocalReviewQueueItem => {
    const proposed = review.proposed_object_ids;
    const evidenceIds = new Set<string>();
    for (const id of proposed) {
      const payload = payloads.get(id);
      if (payload?.schema === "atlas.observation:v1") payload.evidence_refs.forEach((evidence) => evidenceIds.add(evidence));
      if (payload?.schema === "atlas.fact:v1" || payload?.schema === "atlas.relationship:v2") payload.evidence_links.forEach((link) => evidenceIds.add(link.evidence_id));
    }
    const parityIds = [...payloads.values()]
      .filter((payload): payload is Extract<CanonicalPayload, { schema: "atlas.parity-record:v1" }> => payload.schema === "atlas.parity-record:v1" && review.source_coverage_keys.includes(payload.source_coverage_key))
      .map((payload) => payload.parity_id);
    const proposedRecords = proposed.flatMap((id) => {
      const payload = payloads.get(id);
      return payload ? [payload] : [];
    });
    const evidence = [...evidenceIds].flatMap((id) => {
      const payload = payloads.get(id);
      return payload?.schema === "atlas.evidence:v1" ? [payload] : [];
    });
    const parityRecords = [...payloads.values()].filter((payload): payload is CanonicalParityRecordPayload => payload.schema === "atlas.parity-record:v1" && parityIds.includes(payload.parity_id));
    const sourceContext = evidence.filter((item) => item.source_kind === "migration");
    const referenced = [...proposed, ...evidenceIds, ...parityIds];
    const observation = proposedRecords.find((payload) => payload.schema === "atlas.observation:v1");
    const sourceAccounting = accountSourceMeaning(sourceContext);
    const requestedUnitHashes = new Set(review.research_requested_unit_hashes ?? []);
    const researchRequestedUnits = sourceAccounting.meaningful_units.filter((unit) => requestedUnitHashes.has(unit.unit_id));
    return {
      review_id: review.review_id,
      candidate_id: review.candidate_id,
      review_record: review,
      recommendation: review.recommendation,
      resolution_state: review.resolution_state,
      research_requested: Boolean(review.research_requested_at) || Boolean(review.research_requested_all) || researchRequestedUnits.length > 0,
      research_requested_all: Boolean(review.research_requested_all),
      research_requested_units: researchRequestedUnits,
      headline: meaningfulHeadline(observation, sourceContext),
      proposal_label: observation ? "Observation" : "Atlas record",
      proposed_object_ids: proposed,
      proposed_records: proposedRecords,
      evidence_ids: [...evidenceIds].sort(),
      evidence,
      source_context: sourceContext,
      parity_ids: parityIds.sort(),
      parity_records: parityRecords,
      source_accounting: sourceAccounting,
      missing_references: referenced.filter((id) => !payloads.has(id)).sort(),
      context_unavailable: sourceContext.length === 0
    };
  };
  const items = reviews.map(itemFor).sort((left, right) => left.review_id.localeCompare(right.review_id));
  return {
    owner_review: items.filter((item) => item.resolution_state === "owner-review"),
    research: items.filter((item) => item.resolution_state === "research"),
    deferred: items.filter((item) => item.resolution_state === "deferred-unknown"),
    automatic: items.filter((item) => item.resolution_state === "auto-applied" || item.resolution_state === "resolved")
  };
}
