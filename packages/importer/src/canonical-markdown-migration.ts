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

const maxEvidenceExcerptLength = 4_096;

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
 * Losslessly preserves Markdown source content as bounded canonical evidence
 * excerpts. It deliberately makes no entity, fact, or relationship inference:
 * unknown semantics remain a reviewable canonical observation.
 */
export function createCanonicalMarkdownMigration(
  files: MarkdownFileInput[],
  options: CreateCanonicalMarkdownMigrationOptions
): CanonicalMarkdownMigration {
  const authorityId = AuthorityIdSchema.parse(options.authority_id);
  const createdAt = options.created_at ?? new Date().toISOString();
  const payloads: CanonicalPayload[] = [];

  for (const input of files) {
    const file = MarkdownFileInputSchema.parse(input);
    const sourceRef = createMarkdownSourceRef(file.source_path, options);
    const stableBase = `${authorityId}:${sourceRef}:${sha256(file.markdown)}`;
    const coverageKey = stableIdentifier("la_coverage", `${stableBase}:coverage`);
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
    const observationId = stableIdentifier("la_object", `${stableBase}:observation`);
    const observation = CanonicalPayloadSchema.parse({
      schema: "atlas.observation:v1",
      assertion_id: observationId,
      statement: `Imported source coverage ${coverageKey} without inferred entities, claims, relationships, or dates.`,
      candidate_entity_ids: [],
      resolution_state: "research",
      recorded_at: createdAt,
      evidence_refs: evidence.map((item) => item.evidence_id)
    });
    const review = CanonicalPayloadSchema.parse({
      schema: "atlas.review-item:v1",
      review_id: stableIdentifier("la_object", `${stableBase}:review`),
      candidate_id: stableIdentifier("la_candidate", `${stableBase}:candidate`),
      source_coverage_keys: [coverageKey],
      recommendation: "research",
      resolution_state: "research",
      proposed_object_ids: [observationId],
      recorded_at: createdAt
    });
    const parity = CanonicalPayloadSchema.parse({
      schema: "atlas.parity-record:v1",
      parity_id: stableIdentifier("la_object", `${stableBase}:parity`),
      source_coverage_key: coverageKey,
      coverage_state: "represented",
      representation_kind: "observation",
      canonical_object_ids: [observationId],
      idempotency_key: stableIdentifier("la_idem", `${stableBase}:parity`),
      recorded_at: createdAt
    });
    payloads.push(...evidence, observation, review, parity);
  }

  const typed = extractLogseqTypedSemantics(files, {
    authority_id: authorityId,
    created_at: createdAt,
    path_redaction_secret: options.path_redaction_secret,
    default_access_class: "local-private"
  });
  const existingIds = new Set(payloads.map((payload) => canonicalPayloadObjectId(payload)));
  for (const endpoint of typed.endpoints) {
    const entity = canonicalEntityPayloadFromEndpoint(endpoint);
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

function stableIdentifier(prefix: "la_object" | "la_candidate" | "la_coverage" | "la_idem", input: string): string {
  return `${prefix}_${sha256(input).slice("sha256:".length, "sha256:".length + 24)}`;
}

function sha256(input: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`;
}
