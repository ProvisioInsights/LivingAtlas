import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import {
  accountSourceMeaning,
  createCanonicalMarkdownMigration,
  createCanonicalMarkdownMigrationExport,
  createMarkdownSourceRef,
  type MarkdownImportSourceKind,
  type MarkdownSourceMode
} from "@living-atlas/importer";
import type { CanonicalEvidencePayload, CanonicalExportRecord, CanonicalPayload } from "@living-atlas/contracts";
import { fixtureLocalClientId } from "@living-atlas/fixtures";
import { FileLocalGraphStore } from "@living-atlas/local-graph-store";
import {
  createDefaultLocalKeyring,
  decryptGraphObjectPayload,
  FileLocalKeyringStore
} from "@living-atlas/local-keyring";
import { createLocalCanonicalAtlasClient } from "@living-atlas/atlas-client";
import { walkImportableSemanticSourceFiles } from "./logseq-semantic-source-files";

export const canonicalIsolatedCopyAcknowledgement = "run-canonical-isolated-copy";

export type CanonicalIsolatedCopyRun = {
  copy_dir: string;
  source_dir: string;
  acknowledgement: string;
  live_paths: string[];
};

const canonicalSchemas = [
  "atlas.entity:v1",
  "atlas.fact:v1",
  "atlas.observation:v1",
  "atlas.relationship:v2",
  "atlas.evidence:v1",
  "atlas.entity-resolution:v1",
  "atlas.review-item:v1",
  "atlas.parity-record:v1"
] as const satisfies readonly CanonicalPayload["schema"][];

type CanonicalManifestEntry = Pick<CanonicalExportRecord, "object_id" | "object_type" | "content_hash">;

export type CanonicalConversionReport = {
  sources: { files: number; bytes: number };
  schemas: Record<CanonicalPayload["schema"], number>;
  objects: {
    total: number;
    meaningful_unit_occurrences: number;
    unit_evidence: number;
    observations: number;
    facts: number;
    relationships: number;
    entities: number;
    entity_resolutions: number;
    reviews: number;
    parity_records: number;
  };
  review_queue: { owner_review: number; research: number; incomplete: number };
  integrity: {
    duplicate_object_ids: number;
    missing_evidence_references: number;
    missing_entity_references: number;
    missing_proposed_object_references: number;
    missing_review_coverage_references: number;
    missing_parity_object_references: number;
    missing_lineage_references: number;
    missing_snapshot_references: number;
    unrepresented_meaningful_units: number;
    unrepresented_source_parity: number;
    reopened_manifest_mismatches: number;
  };
};

export function validateCanonicalIsolatedCopyRun(input: CanonicalIsolatedCopyRun): Pick<CanonicalIsolatedCopyRun, "copy_dir" | "source_dir"> {
  if (input.acknowledgement !== canonicalIsolatedCopyAcknowledgement) {
    throw new Error("canonical isolated-copy acknowledgement is required");
  }
  const copyDir = resolve(input.copy_dir);
  const sourceDir = resolve(input.source_dir);
  if (basename(copyDir) !== ".atlas-isolated-copy") {
    throw new Error("canonical isolated-copy output requires the .atlas-isolated-copy marker");
  }
  if (pathsOverlap(copyDir, sourceDir)) {
    throw new Error("canonical isolated-copy source and output paths must not overlap");
  }
  for (const livePath of input.live_paths.map((path) => resolve(path))) {
    if (isWithin(copyDir, livePath) || isWithin(sourceDir, livePath)) {
      throw new Error("canonical isolated-copy path is a configured live path");
    }
  }
  return { copy_dir: copyDir, source_dir: sourceDir };
}

export async function runCanonicalIsolatedCopy(input: CanonicalIsolatedCopyRun & {
  authority_id: string;
  keyring_passphrase: string;
  path_redaction_secret?: string;
  source_kind: MarkdownImportSourceKind;
  source_mode: MarkdownSourceMode;
}): Promise<{ source_file_count: number; canonical_object_count: number; generation: number }> {
  const paths = validateCanonicalIsolatedCopyRun(input);
  await mkdir(paths.copy_dir, { recursive: true, mode: 0o700 });
  if ((await readdir(paths.copy_dir)).length > 0) throw new Error("canonical isolated-copy output must be empty");
  const sourcePaths = await walkImportableSemanticSourceFiles({ root: paths.source_dir, sourceKind: input.source_kind, mode: input.source_mode, maxFiles: 100_000, offset: 0, maxFileBytes: 16 * 1024 * 1024 });
  const files = await Promise.all(sourcePaths.map(async (path) => {
    const bytes = await readFile(path);
    return {
      source_path: relative(paths.source_dir, path),
      markdown: bytes.toString("utf8"),
      source_kind: input.source_kind,
      byte_count: bytes.byteLength
    };
  }));
  const migration = createCanonicalMarkdownMigration(files.map(({ byte_count: _byteCount, ...file }) => file), {
    authority_id: input.authority_id,
    path_redaction_secret: input.path_redaction_secret ?? input.keyring_passphrase
  });
  const exported = createCanonicalMarkdownMigrationExport(migration);
  const keyring = createDefaultLocalKeyring({ authorityId: input.authority_id, createdAt: migration.created_at });
  const keyringStore = new FileLocalKeyringStore(join(paths.copy_dir, "keyring.json"));
  await keyringStore.write(keyring, input.keyring_passphrase);
  const store = await FileLocalGraphStore.open({ directory: join(paths.copy_dir, "graph"), authorityId: input.authority_id, plaintextPersistence: "encrypt", keyring });
  const client = createLocalCanonicalAtlasClient({ graphStore: store, decryptPayload: async () => undefined, now: migration.created_at });
  const result = await client.importCanonical({ exported, expected_generation: 0, actor_id: fixtureLocalClientId, operation_id: "la_operation_isolatedcopy0001", idempotency_key: "la_idem_isolatedcopy0001", recorded_at: migration.created_at });
  if (!result.ok) throw new Error(`canonical isolated-copy import failed: ${result.reason}`);

  const manifest = canonicalManifest(exported.records);
  const persistedKeyring = await keyringStore.read(input.keyring_passphrase);
  const reopenedStore = await FileLocalGraphStore.open({
    directory: join(paths.copy_dir, "graph"),
    authorityId: input.authority_id,
    plaintextPersistence: "encrypt",
    keyring: persistedKeyring
  });
  const reopenedClient = createLocalCanonicalAtlasClient({
    graphStore: reopenedStore,
    decryptPayload: async (object) => {
      const payload = await decryptGraphObjectPayload(object, persistedKeyring);
      return payload?.kind === "plaintext-json" ? payload.data : undefined;
    },
    now: migration.created_at
  });
  const reopenedManifest = canonicalManifest((await reopenedClient.exportCanonical({ exported_at: migration.created_at })).records);
  const reopenedManifestMismatches = manifestMismatchCount(manifest, reopenedManifest);
  if (reopenedManifestMismatches > 0) throw new Error("canonical isolated-copy reopened manifest mismatch");

  const report = analyzeCanonicalConversion({
    records: exported.records,
    sources: files.map(({ source_path, markdown, byte_count }) => ({ source_path, markdown, byte_count })),
    path_redaction_secret: input.path_redaction_secret ?? input.keyring_passphrase,
    reopened_manifest_mismatches: reopenedManifestMismatches
  });
  assertCanonicalConversionIntegrity(report);
  await writePrivateJson(join(paths.copy_dir, "conversion-report.json"), report);
  await writePrivateJson(join(paths.copy_dir, "canonical-manifest.json"), manifest);
  return { source_file_count: files.length, canonical_object_count: result.objects.length, generation: result.generation };
}

function canonicalManifest(records: CanonicalExportRecord[]): CanonicalManifestEntry[] {
  return records
    .map(({ object_id, object_type, content_hash }) => ({ object_id, object_type, content_hash }))
    .sort((left, right) => left.object_id.localeCompare(right.object_id));
}

export function analyzeCanonicalConversion(input: {
  records: CanonicalExportRecord[];
  sources: Array<{ source_path: string; markdown: string; byte_count: number }>;
  path_redaction_secret: string;
  reopened_manifest_mismatches: number;
}): CanonicalConversionReport {
  const payloads = input.records.map((record) => record.payload);
  const objectIds = new Set(input.records.map((record) => record.object_id));
  const evidenceIds = new Set(payloads
    .filter((payload) => payload.schema === "atlas.evidence:v1")
    .map((payload) => payload.evidence_id));
  const entityIds = new Set(payloads
    .filter((payload) => payload.schema === "atlas.entity:v1")
    .map((payload) => payload.entity_id));
  const observationIds = new Set(payloads
    .filter((payload) => payload.schema === "atlas.observation:v1")
    .map((payload) => payload.assertion_id));
  const parityRecords = payloads.filter((payload) => payload.schema === "atlas.parity-record:v1");
  const representedParity = parityRecords.filter((payload) => payload.coverage_state === "represented");
  const parityByCoverage = new Map(parityRecords.map((payload) => [payload.source_coverage_key, payload]));
  const parityBackedObservationIds = new Set(representedParity
    .filter((payload) => payload.representation_kind === "observation")
    .flatMap((payload) => payload.canonical_object_ids.filter((id) => observationIds.has(id))));
  const reviews = payloads.filter((payload) => payload.schema === "atlas.review-item:v1");
  const evidenceReferences: string[] = [];
  const entityReferences: string[] = [];
  const proposedReferences: string[] = [];
  const reviewCoverageReferences: string[] = [];
  const parityObjectReferences: string[] = [];
  const lineageReferences: string[] = [];
  const snapshotReferences: string[] = [];

  for (const payload of payloads) {
    switch (payload.schema) {
      case "atlas.fact:v1":
        entityReferences.push(payload.subject_entity_id);
        if (payload.value.kind === "entity-ref") entityReferences.push(payload.value.entity_id);
        evidenceReferences.push(...payload.evidence_links.map((link) => link.evidence_id), ...payload.confidence.evidence_refs);
        lineageReferences.push(...payload.supersedes);
        break;
      case "atlas.observation:v1":
        entityReferences.push(...payload.candidate_entity_ids);
        evidenceReferences.push(...payload.evidence_refs);
        break;
      case "atlas.relationship:v2":
        entityReferences.push(payload.source_entity_id, payload.target_entity_id);
        evidenceReferences.push(...payload.evidence_links.map((link) => link.evidence_id), ...payload.confidence.evidence_refs);
        lineageReferences.push(...payload.supersedes);
        break;
      case "atlas.evidence:v1":
        if (payload.snapshot_ref) snapshotReferences.push(payload.snapshot_ref);
        break;
      case "atlas.entity-resolution:v1":
        entityReferences.push(...payload.candidate_entity_ids);
        if (payload.canonical_entity_id) entityReferences.push(payload.canonical_entity_id);
        evidenceReferences.push(...payload.evidence_refs, ...payload.confidence.evidence_refs);
        lineageReferences.push(...payload.supersedes);
        break;
      case "atlas.review-item:v1":
        proposedReferences.push(...payload.proposed_object_ids);
        reviewCoverageReferences.push(...payload.source_coverage_keys);
        break;
      case "atlas.parity-record:v1":
        parityObjectReferences.push(...payload.canonical_object_ids);
        break;
    }
  }

  const unitEvidence = payloads.filter((payload): payload is CanonicalEvidencePayload => (
    payload.schema === "atlas.evidence:v1" && payload.extraction_method === "canonical-source-unit-v1"
  ));
  const unitEvidenceIdsByOccurrence = new Map<string, Set<string>>();
  for (const evidence of unitEvidence) {
    const occurrenceKey = unitOccurrenceKey(evidence.locator);
    if (!occurrenceKey) continue;
    const ids = unitEvidenceIdsByOccurrence.get(occurrenceKey) ?? new Set<string>();
    ids.add(evidence.evidence_id);
    unitEvidenceIdsByOccurrence.set(occurrenceKey, ids);
  }
  const meaningfulUnitOccurrences = expectedMeaningfulUnitOccurrences(input.sources, input.path_redaction_secret);
  const observations = payloads.filter((payload) => payload.schema === "atlas.observation:v1");
  const unrepresentedMeaningfulUnits = [...meaningfulUnitOccurrences].filter((occurrenceKey) => (
    !observations.some((observation) => {
      const unitEvidenceIds = unitEvidenceIdsByOccurrence.get(occurrenceKey);
      return unitEvidenceIds
        && parityBackedObservationIds.has(observation.assertion_id)
        && observation.evidence_refs.some((id) => unitEvidenceIds.has(id));
    })
  )).length;

  const incompleteReviews = reviews.filter((review) => {
    const coverage = review.source_coverage_keys.map((key) => parityByCoverage.get(key));
    return coverage.some((parity) => !parity
      || parity.coverage_state !== "represented"
      || parity.representation_kind !== "observation")
      || review.proposed_object_ids.some((id) => !objectIds.has(id))
      || !review.proposed_object_ids.some((id) => observationIds.has(id));
  }).length;
  const schemas = Object.fromEntries(canonicalSchemas.map((schema) => [
    schema,
    payloads.filter((payload) => payload.schema === schema).length
  ])) as Record<CanonicalPayload["schema"], number>;

  return {
    sources: {
      files: input.sources.length,
      bytes: input.sources.reduce((total, source) => total + source.byte_count, 0)
    },
    schemas,
    objects: {
      total: input.records.length,
      meaningful_unit_occurrences: meaningfulUnitOccurrences.size,
      unit_evidence: unitEvidence.length,
      observations: schemas["atlas.observation:v1"],
      facts: schemas["atlas.fact:v1"],
      relationships: schemas["atlas.relationship:v2"],
      entities: schemas["atlas.entity:v1"],
      entity_resolutions: schemas["atlas.entity-resolution:v1"],
      reviews: schemas["atlas.review-item:v1"],
      parity_records: schemas["atlas.parity-record:v1"]
    },
    review_queue: {
      owner_review: reviews.filter((review) => review.resolution_state === "owner-review").length,
      research: reviews.filter((review) => review.resolution_state === "research").length,
      incomplete: incompleteReviews
    },
    integrity: {
      duplicate_object_ids: input.records.length - objectIds.size,
      missing_evidence_references: evidenceReferences.filter((id) => !evidenceIds.has(id)).length,
      missing_entity_references: entityReferences.filter((id) => !entityIds.has(id)).length,
      missing_proposed_object_references: proposedReferences.filter((id) => !objectIds.has(id)).length,
      missing_review_coverage_references: reviewCoverageReferences.filter((key) => !parityByCoverage.has(key)).length,
      missing_parity_object_references: parityObjectReferences.filter((id) => !objectIds.has(id)).length,
      missing_lineage_references: lineageReferences.filter((id) => !objectIds.has(id)).length,
      missing_snapshot_references: snapshotReferences.filter((id) => !objectIds.has(id)).length,
      unrepresented_meaningful_units: unrepresentedMeaningfulUnits,
      unrepresented_source_parity: Math.max(0, input.sources.length - representedParity.length),
      reopened_manifest_mismatches: input.reopened_manifest_mismatches
    }
  };
}

export function assertCanonicalConversionIntegrity(report: CanonicalConversionReport): void {
  const integrity = report.integrity;
  const missingReferences = integrity.missing_evidence_references
    + integrity.missing_entity_references
    + integrity.missing_proposed_object_references
    + integrity.missing_review_coverage_references
    + integrity.missing_parity_object_references
    + integrity.missing_lineage_references
    + integrity.missing_snapshot_references;
  if (integrity.duplicate_object_ids > 0
    || missingReferences > 0
    || integrity.unrepresented_meaningful_units > 0
    || integrity.reopened_manifest_mismatches > 0) {
    throw new Error("canonical isolated-copy integrity check failed");
  }
}

function expectedMeaningfulUnitOccurrences(
  sources: Array<{ source_path: string; markdown: string }>,
  pathRedactionSecret: string
): Set<string> {
  const occurrences = new Set<string>();
  for (const source of sources) {
    const sourceRef = createMarkdownSourceRef(source.source_path, { path_redaction_secret: pathRedactionSecret });
    const excerpts = source.markdown.length === 0
      ? [""]
      : Array.from({ length: Math.ceil(source.markdown.length / 4_096) }, (_, index) => (
        source.markdown.slice(index * 4_096, (index + 1) * 4_096)
      ));
    const accountingEvidence: CanonicalEvidencePayload[] = excerpts.map((excerpt, index) => ({
      schema: "atlas.evidence:v1",
      evidence_id: `la_object_conversionaccounting${String(index).padStart(8, "0")}`,
      source_kind: "migration",
      locator: `migration:private-accounting:excerpt:${index + 1}`,
      content_hash: `sha256:${createHash("sha256").update(excerpt).digest("hex")}`,
      retrieved_at: "1970-01-01T00:00:00.000Z",
      independence_key: "private-accounting",
      excerpt,
      extraction_method: "canonical-markdown-lossless-v1"
    }));
    const occurrenceByUnitId = new Map<string, number>();
    for (const unit of accountSourceMeaning(accountingEvidence).meaningful_units) {
      const occurrence = (occurrenceByUnitId.get(unit.unit_id) ?? 0) + 1;
      occurrenceByUnitId.set(unit.unit_id, occurrence);
      occurrences.add(`${sourceRef}:${unit.unit_id}:${occurrence}`);
    }
  }
  return occurrences;
}

function unitOccurrenceKey(locator: string): string | undefined {
  const matched = /^migration:(la_source_[a-f0-9]{24}):unit:(sha256:[a-f0-9]{64}):occurrence:(\d+):excerpt:\d+$/.exec(locator);
  return matched ? `${matched[1]}:${matched[2]}:${matched[3]}` : undefined;
}

function manifestMismatchCount(left: CanonicalManifestEntry[], right: CanonicalManifestEntry[]): number {
  let mismatches = 0;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (JSON.stringify(left[index]) !== JSON.stringify(right[index])) mismatches += 1;
  }
  return mismatches;
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
}

function pathsOverlap(left: string, right: string): boolean {
  return isWithin(left, right) || isWithin(right, left);
}

function isWithin(path: string, parent: string): boolean {
  const pathRelativeToParent = relative(parent, path);
  return pathRelativeToParent === "" || (!pathRelativeToParent.startsWith("..") && !pathRelativeToParent.startsWith("../"));
}
