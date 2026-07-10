import { createHash } from "node:crypto";
import {
  AuthorityIdSchema,
  CanonicalEvidencePayloadSchema,
  CanonicalPayloadSchema,
  canonicalObjectTypeForPayload,
  canonicalPayloadObjectId,
  parseCanonicalExport,
  type CanonicalExport,
  type CanonicalEvidencePayload,
  type CanonicalPayload
} from "@living-atlas/contracts";
import {
  MarkdownFileInputSchema,
  createMarkdownSourceRef,
  type MarkdownFileInput,
  type MarkdownPathRedactionOptions
} from "./markdown";
import { canonicalEntityPayloadFromEndpoint } from "./canonical";
import { extractLogseqTypedSemantics } from "./logseq-semantic";
import { accountSourceMeaning } from "./source-meaning";

const maxEvidenceExcerptLength = 4_096;

type UnitEvidenceProjection = {
  sourceText: string;
  atlasText: string;
  evidenceIds: string[];
};

export type CreateCanonicalMarkdownMigrationOptions = MarkdownPathRedactionOptions & {
  authority_id: string;
  created_at?: string;
};

export type CanonicalMarkdownMigration = {
  migration_schema: "living-atlas-canonical-markdown-migration:v1";
  authority_id: string;
  created_at: string;
  plaintext_policy: "canonical-evidence-in-memory-until-local-encryption";
  payloads: CanonicalPayload[];
};

/**
 * Preserves Markdown source content as lossless bounded evidence, represents
 * every meaningful unit as an observation, and adds only extractor-proven
 * typed projections. Every result remains unresolved for owner or research review.
 */
export function createCanonicalMarkdownMigration(
  files: MarkdownFileInput[],
  options: CreateCanonicalMarkdownMigrationOptions
): CanonicalMarkdownMigration {
  const authorityId = AuthorityIdSchema.parse(options.authority_id);
  const createdAt = options.created_at ?? new Date().toISOString();
  const pathRedactionSecret = options.path_redaction_secret
    ?? createHash("sha256").update(`${authorityId}:${createdAt}:ephemeral-path-redaction`).digest("hex").slice(0, 32);
  const payloads: CanonicalPayload[] = [];
  const typed = extractLogseqTypedSemantics(files, {
    authority_id: authorityId,
    created_at: createdAt,
    path_redaction_secret: pathRedactionSecret,
    default_access_class: "local-private"
  });
  const entityById = new Map(typed.endpoints.map((item) => [
    item.endpoint.object_id,
    canonicalEntityPayloadFromEndpoint(item.endpoint)
  ]));
  const endpointsBySourceRef = new Map<string, typeof typed.endpoints>();
  const entityIdsByExactTitle = new Map<string, Set<string>>();
  for (const typedEndpoint of typed.endpoints) {
    const sourceEndpoints = endpointsBySourceRef.get(typedEndpoint.source_path_ref) ?? [];
    sourceEndpoints.push(typedEndpoint);
    endpointsBySourceRef.set(typedEndpoint.source_path_ref, sourceEndpoints);
    for (const title of [typedEndpoint.endpoint.name, ...typedEndpoint.endpoint.aliases]) {
      const normalized = normalizeExactTitle(title);
      if (!normalized) continue;
      const ids = entityIdsByExactTitle.get(normalized) ?? new Set<string>();
      ids.add(typedEndpoint.endpoint.object_id);
      entityIdsByExactTitle.set(normalized, ids);
    }
  }

  for (const input of files) {
    const file = MarkdownFileInputSchema.parse(input);
    const sourceRef = createMarkdownSourceRef(file.source_path, { path_redaction_secret: pathRedactionSecret });
    const stableBase = `${authorityId}:${sourceRef}:${sha256(file.markdown)}`;
    const coverageKey = stableIdentifier("la_coverage", `${stableBase}:coverage`);
    const sourceEndpoints = endpointsBySourceRef.get(sourceRef) ?? [];
    const sourceEdges = typed.edges.filter((item) => item.source_path_ref === sourceRef);
    const primaryEntityId = sourceEndpoints.length === 1 ? sourceEndpoints[0]!.endpoint.object_id : undefined;
    const resolutionState = sourceEndpoints.length > 0 || sourceEdges.length > 0 ? "owner-review" : "research";
    const evidence: CanonicalEvidencePayload[] = evidenceChunks(file.markdown).map((excerpt, index) => CanonicalEvidencePayloadSchema.parse({
      schema: "atlas.evidence:v1",
      evidence_id: stableIdentifier("la_object", `${stableBase}:evidence:${index}`),
      source_kind: "migration",
      locator: `migration:${sourceRef}:excerpt:${index + 1}`,
      content_hash: sha256(excerpt),
      retrieved_at: createdAt,
      independence_key: `migration:${sourceRef}`,
      excerpt,
      extraction_method: "canonical-markdown-lossless-v1"
    }));
    const occurrenceByUnitId = new Map<string, number>();
    const unitPayloads: CanonicalPayload[] = [];
    const observationIds: string[] = [];
    const unitEvidenceProjections: UnitEvidenceProjection[] = [];
    for (const unit of accountSourceMeaning(evidence).meaningful_units) {
      const occurrence = (occurrenceByUnitId.get(unit.unit_id) ?? 0) + 1;
      occurrenceByUnitId.set(unit.unit_id, occurrence);
      const unitBase = `${stableBase}:unit:${unit.unit_id}:occurrence:${occurrence}`;
      const unitEvidence = evidenceChunks(unit.source_text).map((excerpt, index) => CanonicalEvidencePayloadSchema.parse({
        schema: "atlas.evidence:v1",
        evidence_id: stableIdentifier("la_object", `${unitBase}:evidence:${index}`),
        source_kind: "migration",
        locator: `migration:${sourceRef}:unit:${unit.unit_id}:occurrence:${occurrence}:excerpt:${index + 1}`,
        content_hash: sha256(excerpt),
        retrieved_at: createdAt,
        independence_key: `migration:${sourceRef}`,
        excerpt,
        extraction_method: "canonical-source-unit-v1"
      }));
      unitEvidenceProjections.push({
        sourceText: unit.source_text,
        atlasText: unit.atlas_text,
        evidenceIds: unitEvidence.map((item) => item.evidence_id)
      });
      const candidateEntityIds = uniqueIds([
        ...(primaryEntityId ? [primaryEntityId] : []),
        ...unit.wiki_references.flatMap((reference) => {
          const ids = entityIdsByExactTitle.get(normalizeExactTitle(reference));
          return ids?.size === 1 ? [...ids] : [];
        })
      ]);
      unitPayloads.push(...unitEvidence);
      for (const [index, statement] of observationChunks(unit.atlas_text).entries()) {
        const observationId = stableIdentifier("la_object", `${unitBase}:observation:${index}`);
        const observation = CanonicalPayloadSchema.parse({
          schema: "atlas.observation:v1",
          assertion_id: observationId,
          statement,
          candidate_entity_ids: candidateEntityIds,
          resolution_state: resolutionState,
          recorded_at: createdAt,
          evidence_refs: [
            ...unitEvidence.map((item) => item.evidence_id),
            ...evidence.map((item) => item.evidence_id)
          ]
        });
        unitPayloads.push(observation);
        observationIds.push(observationId);
      }
      if (primaryEntityId) {
        const fact = measuredFactForUnit({
          unitBase,
          atlasText: unit.atlas_text,
          primaryEntityId,
          evidenceIds: unitEvidence.map((item) => item.evidence_id),
          createdAt
        });
        if (fact) unitPayloads.push(fact);
      }
    }
    for (const typedEdge of sourceEdges) {
      const edge = typedEdge.edge;
      const sourceEntity = entityById.get(edge.source_object_id);
      const targetEntity = entityById.get(edge.target_object_id);
      if (sourceEntity?.type !== edge.source_type || targetEntity?.type !== edge.target_type) continue;
      const relationshipEvidenceIds = evidenceIdsForRelationship(
        edge.attrs,
        unitEvidenceProjections,
        evidence.map((item) => item.evidence_id)
      );
      unitPayloads.push(CanonicalPayloadSchema.parse({
        schema: "atlas.relationship:v2",
        assertion_id: stableIdentifier("la_object", `${authorityId}:typed-edge-assertion:${edge.edge_id}`),
        edge_id: edge.edge_id,
        source_entity_id: edge.source_object_id,
        source_type: edge.source_type,
        target_entity_id: edge.target_object_id,
        target_type: edge.target_type,
        predicate: edge.predicate,
        valid_from: edge.valid_from,
        ...(edge.valid_to ? { valid_to: edge.valid_to } : {}),
        status: edge.status,
        attrs: canonicalRelationshipAttrs(edge.attrs),
        recorded_at: createdAt,
        lineage_action: "assert",
        supersedes: [],
        evidence_links: relationshipEvidenceIds.map((evidenceId) => ({ evidence_id: evidenceId, stance: "supports" })),
        confidence: {
          band: "high",
          assessment_kind: "assertion",
          method: relationshipEvidenceIds.some((id) => unitEvidenceProjections.some((unit) => unit.evidenceIds.includes(id)))
            ? "canonical-source-unit-v1"
            : "canonical-markdown-lossless-v1",
          assessed_at: createdAt,
          evidence_refs: relationshipEvidenceIds
        }
      }));
    }
    const proposedObjectIds = uniqueIds([
      ...observationIds,
      ...sourceEndpoints.map((item) => item.endpoint.object_id),
      ...unitPayloads.flatMap((payload) => payload.schema === "atlas.fact:v1" || payload.schema === "atlas.relationship:v2"
        ? [canonicalPayloadObjectId(payload)]
        : [])
    ]);
    const review = CanonicalPayloadSchema.parse({
      schema: "atlas.review-item:v1",
      review_id: stableIdentifier("la_object", `${stableBase}:review`),
      candidate_id: stableIdentifier("la_candidate", `${stableBase}:candidate`),
      source_coverage_keys: [coverageKey],
      recommendation: resolutionState,
      resolution_state: resolutionState,
      proposed_object_ids: proposedObjectIds,
      recorded_at: createdAt
    });
    const parity = CanonicalPayloadSchema.parse({
      schema: "atlas.parity-record:v1",
      parity_id: stableIdentifier("la_object", `${stableBase}:parity`),
      source_coverage_key: coverageKey,
      coverage_state: observationIds.length > 0 ? "represented" : "unrepresented",
      ...(observationIds.length > 0 ? { representation_kind: "observation" } : {}),
      canonical_object_ids: observationIds,
      idempotency_key: stableIdentifier("la_idem", `${stableBase}:parity`),
      recorded_at: createdAt
    });
    payloads.push(...evidence, ...unitPayloads, review, parity);
  }

  const existingIds = new Set(payloads.map((payload) => canonicalPayloadObjectId(payload)));
  for (const typedEndpoint of typed.endpoints) {
    const entity = entityById.get(typedEndpoint.endpoint.object_id)!;
    if (!existingIds.has(entity.entity_id)) {
      payloads.push(entity);
      existingIds.add(entity.entity_id);
    }
  }

  return {
    migration_schema: "living-atlas-canonical-markdown-migration:v1",
    authority_id: authorityId,
    created_at: createdAt,
    plaintext_policy: "canonical-evidence-in-memory-until-local-encryption",
    payloads
  };
}

export function createCanonicalMarkdownMigrationExport(input: CanonicalMarkdownMigration, exportedAt = input.created_at): CanonicalExport {
  return parseCanonicalExport({
    export_schema: "living-atlas-canonical-export:v1",
    plaintext_policy: "local-keyholding-canonical-export",
    authority_id: input.authority_id,
    exported_at: exportedAt,
    records: input.payloads.map((payload) => ({
      authority_id: input.authority_id,
      object_id: canonicalPayloadObjectId(payload),
      object_type: canonicalObjectTypeForPayload(payload),
      version: 1,
      access_class: "local-private",
      content_hash: sha256(JSON.stringify(payload)),
      payload
    })).sort((left, right) => left.object_id.localeCompare(right.object_id))
  });
}

function evidenceChunks(markdown: string): string[] {
  if (markdown.length === 0) return ["[empty source]"];
  const chunks: string[] = [];
  let start = 0;
  while (start < markdown.length) {
    let end = Math.min(start + maxEvidenceExcerptLength, markdown.length);
    if (end < markdown.length) {
      const newline = markdown.lastIndexOf("\n", end - 1);
      if (newline >= start) end = newline + 1;
    }
    if (end === start) end = Math.min(start + maxEvidenceExcerptLength, markdown.length);
    chunks.push(markdown.slice(start, end));
    start = end;
  }
  return chunks;
}

function observationChunks(statement: string): string[] {
  const chunks: string[] = [];
  for (let start = 0; start < statement.length; start += 8_192) {
    chunks.push(statement.slice(start, start + 8_192));
  }
  return chunks;
}

function normalizeExactTitle(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids)];
}

function measuredFactForUnit(input: {
  unitBase: string;
  atlasText: string;
  primaryEntityId: string;
  evidenceIds: string[];
  createdAt: string;
}): CanonicalPayload | undefined {
  const field = directField(input.atlasText);
  if (!field) return undefined;
  const predicate = field.label === "birthday" ? "birth-date" : field.label;
  if (!(["phone", "email", "address", "birth-date", "last-contacted"] as const).includes(
    predicate as "phone" | "email" | "address" | "birth-date" | "last-contacted"
  )) return undefined;
  const value = field.value;
  if (!value || value.toLocaleLowerCase("en-US") === "unknown") return undefined;
  const values: Array<Record<string, unknown>> = predicate === "birth-date"
    ? [{ kind: "date", value }]
    : predicate === "last-contacted"
      ? [{ kind: "timestamp", value }, { kind: "date", value }]
      : [{ kind: "text", value }];
  for (const factValue of values) {
    const parsed = CanonicalPayloadSchema.safeParse({
      schema: "atlas.fact:v1",
      assertion_id: stableIdentifier("la_object", `${input.unitBase}:fact:${predicate}`),
      subject_entity_id: input.primaryEntityId,
      predicate,
      value: factValue,
      recorded_at: input.createdAt,
      lineage_action: "assert",
      supersedes: [],
      evidence_links: input.evidenceIds.map((evidenceId) => ({ evidence_id: evidenceId, stance: "supports" })),
      confidence: {
        band: "high",
        assessment_kind: "extraction",
        method: "canonical-source-unit-v1",
        assessed_at: input.createdAt,
        evidence_refs: input.evidenceIds
      }
    });
    if (parsed.success && parsed.data.schema === "atlas.fact:v1") return parsed.data;
  }
  return undefined;
}

function evidenceIdsForRelationship(
  attrs: Record<string, unknown>,
  units: UnitEvidenceProjection[],
  losslessEvidenceIds: string[]
): string[] {
  if (typeof attrs.source_text_hash === "string") {
    const matches = units.filter((unit) => sha256(unit.sourceText.replace(/^[-*+]\s+/, "")) === attrs.source_text_hash);
    if (matches.length === 1) return matches[0]!.evidenceIds;
  }
  if (typeof attrs.property_key === "string") {
    const propertyKey = normalizeDirectFieldLabel(attrs.property_key);
    const candidates = units.filter((unit) => directField(unit.atlasText)?.label === propertyKey);
    if (typeof attrs.source_value_hash === "string") {
      const exact = candidates.filter((unit) => {
        const field = directField(unit.atlasText);
        return field ? sha256(`${attrs.property_key}:${field.value}`) === attrs.source_value_hash : false;
      });
      if (exact.length === 1) return exact[0]!.evidenceIds;
    }
    if (candidates.length === 1) return candidates[0]!.evidenceIds;
  }
  return losslessEvidenceIds;
}

function directField(atlasText: string): { label: string; value: string } | undefined {
  const separator = atlasText.indexOf(":");
  if (separator < 1) return undefined;
  const label = normalizeDirectFieldLabel(atlasText.slice(0, separator));
  const value = atlasText.slice(separator + 1).trim();
  return label && value ? { label, value } : undefined;
}

function normalizeDirectFieldLabel(value: string): string {
  return value.trim().toLocaleLowerCase("en-US").replace(/[_\s]+/g, "-");
}

function canonicalRelationshipAttrs(attrs: Record<string, unknown>): Record<string, unknown> {
  const canonicalAttrs = { ...attrs };
  for (const key of [
    "source_path_ref",
    "source_capsule_object_id",
    "source_content_hash",
    "source_text_hash",
    "source_value_hash",
    "property_key",
    "canonicalization",
    "target_resolution",
    "review_target_hash",
    "review_decision"
  ]) delete canonicalAttrs[key];
  return canonicalAttrs;
}

function stableIdentifier(prefix: "la_object" | "la_candidate" | "la_coverage" | "la_idem", input: string): string {
  return `${prefix}_${sha256(input).slice("sha256:".length, "sha256:".length + 24)}`;
}

function sha256(input: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`;
}
