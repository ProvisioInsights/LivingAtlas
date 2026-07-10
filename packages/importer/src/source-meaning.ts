import { createHash } from "node:crypto";
import type { CanonicalEvidencePayload } from "@living-atlas/contracts";

export type SourceMeaningKind = "entity" | "attribute" | "fact" | "relationship" | "observation" | "provenance";

export type SourceMeaningUnit = {
  unit_id: `sha256:${string}`;
  source_text: string;
  atlas_text: string;
  kind: SourceMeaningKind;
  wiki_references: string[];
};

export type SourceMeaningAccounting = {
  exact_source_preserved: boolean;
  meaningful_units: SourceMeaningUnit[];
  excluded_units: Array<{
    source_text: string;
    reason: "editorial migration commentary" | "source organization" | "source-system instruction";
  }>;
};

type ParsedMeaningUnit = Pick<SourceMeaningUnit, "atlas_text" | "kind">;

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
      .replace(/^[-*+]\s*(?:·\s*)?$/, "")
      .trim();
    const unit = meaningUnit(withoutEditorial);
    if (unit && /^[-*+]\s+\*\*/.test(withoutEditorial) && /\*\*\s*$/.test(withoutEditorial) && !unit.atlas_text.includes(":")) {
      excludedUnits.push({ source_text: segment, reason: "source organization" });
    } else if (unit) {
      meaningfulUnits.push({
        ...unit,
        unit_id: sourceUnitId(unit),
        source_text: segment,
        wiki_references: wikiReferences(withoutEditorial)
      });
    }
  }

  return {
    exact_source_preserved: sourceContext.length > 0
      && sourceContext.every((item) => item.extraction_method === "canonical-markdown-lossless-v1"),
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

function meaningUnit(sourceText: string): ParsedMeaningUnit | undefined {
  if (!sourceText) return undefined;
  const property = /^([A-Za-z][A-Za-z0-9_-]*)::\s*(.+)$/.exec(sourceText);
  if (property) {
    const key = property[1]!;
    const value = cleanKnowledgeText(property[2]!);
    if (!value) return undefined;
    return {
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
    return value ? { atlas_text: value, kind: "entity" } : undefined;
  }
  const labeled = /^[-*+]\s+\*\*([^*]+?):\*\*\s*(.+)$/.exec(sourceText)
    ?? /^[-*+]\s+([A-Za-z][A-Za-z /&-]{0,48}):\s*(.+)$/.exec(sourceText);
  if (labeled) {
    const label = cleanKnowledgeText(labeled[1]!);
    const value = cleanKnowledgeText(labeled[2]!);
    if (!label || !value) return undefined;
    return {
      atlas_text: `${label}: ${value}`,
      kind: /relationship|role|member|friend|family|works? (?:at|with)|reports? to/i.test(label) ? "relationship"
        : /source|evidence|confirmed|verified/i.test(label) ? "provenance"
          : /phone|email|address|birthday|date|website|url|location/i.test(label) ? "fact"
            : "observation"
    };
  }
  const value = cleanKnowledgeText(sourceText.replace(/^[-*+]\s+/, ""));
  return value ? { atlas_text: value, kind: "observation" } : undefined;
}

function sourceUnitId(unit: ParsedMeaningUnit): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(`${unit.kind}:${unit.atlas_text}`).digest("hex")}`;
}

function wikiReferences(sourceText: string): string[] {
  const references: string[] = [];
  const seen = new Set<string>();
  for (const match of sourceText.matchAll(/\[\[([^\]\n]+)\]\]/g)) {
    const target = match[1]?.split("|", 1)[0]?.split("#", 1)[0]?.trim();
    if (!target || seen.has(target)) continue;
    seen.add(target);
    references.push(target);
  }
  return references;
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
