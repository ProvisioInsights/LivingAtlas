import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import {
  accountSourceMeaning,
  createCanonicalMarkdownMigration,
  createCanonicalMarkdownMigrationExport,
  createMarkdownSourceRef,
  type CanonicalTypedProjectionOmissions,
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
import {
  assertSemanticSourceDiscoveryComplete,
  discoverImportableSemanticSourceFiles,
  type SemanticSourceDiscoveryCounts
} from "./logseq-semantic-source-files";

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

export type CanonicalManifestEntry = Pick<CanonicalExportRecord, "object_id" | "object_type" | "content_hash">;

export type CanonicalConversionReport = {
  sources: { files: number; bytes: number };
  source_discovery: SemanticSourceDiscoveryCounts;
  typed_projection_omissions: CanonicalTypedProjectionOmissions;
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
    cross_source_parity_observation_references: number;
    duplicate_expected_coverage_keys: number;
    missing_expected_parity_records: number;
    duplicate_expected_parity_records: number;
    unexpected_parity_coverage_records: number;
    missing_expected_review_records: number;
    duplicate_expected_review_records: number;
    unexpected_review_coverage_references: number;
    invalid_review_coverage_cardinality: number;
    invalid_meaningful_source_parity_records: number;
    invalid_zero_unit_source_parity_records: number;
    incomplete_nonzero_source_reviews: number;
    actionable_zero_unit_source_reviews: number;
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
  path_redaction_secret: string;
  source_kind: MarkdownImportSourceKind;
  source_mode: MarkdownSourceMode;
}): Promise<{ source_file_count: number; canonical_object_count: number; generation: number }> {
  if (input.path_redaction_secret.trim().length === 0) {
    throw new Error("canonical isolated-copy path_redaction_secret is required");
  }
  const paths = validateCanonicalIsolatedCopyRun(input);
  await mkdir(paths.copy_dir, { recursive: true, mode: 0o700 });
  if ((await readdir(paths.copy_dir)).length > 0) throw new Error("canonical isolated-copy output must be empty");
  const discovery = await discoverImportableSemanticSourceFiles({
    root: paths.source_dir,
    sourceKind: input.source_kind,
    mode: input.source_mode,
    maxFiles: 100_000,
    offset: 0,
    maxFileBytes: 16 * 1024 * 1024,
    include_empty: true
  });
  assertSemanticSourceDiscoveryComplete(discovery.counts);
  const files = await Promise.all(discovery.selected_paths.map(async (path) => {
    try {
      const bytes = await readFile(path);
      return {
        source_path: relative(paths.source_dir, path),
        markdown: bytes.toString("utf8"),
        source_kind: input.source_kind,
        byte_count: bytes.byteLength
      };
    } catch {
      throw new Error("semantic source discovery incomplete: oversize=0 unreadable=1 cap=0");
    }
  }));
  const migration = createCanonicalMarkdownMigration(files.map(({ byte_count: _byteCount, ...file }) => file), {
    authority_id: input.authority_id,
    path_redaction_secret: input.path_redaction_secret
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
    authority_id: input.authority_id,
    sources: files.map(({ source_path, markdown, byte_count }) => ({ source_path, markdown, byte_count })),
    source_discovery: discovery.counts,
    path_redaction_secret: input.path_redaction_secret,
    typed_projection_omissions: migration.typed_projection_omissions,
    reopened_manifest_mismatches: reopenedManifestMismatches
  });
  await persistCanonicalConversionArtifacts({ copy_dir: paths.copy_dir, report, manifest });
  return { source_file_count: files.length, canonical_object_count: result.objects.length, generation: result.generation };
}

function canonicalManifest(records: CanonicalExportRecord[]): CanonicalManifestEntry[] {
  return records
    .map(({ object_id, object_type, content_hash }) => ({ object_id, object_type, content_hash }))
    .sort((left, right) => left.object_id.localeCompare(right.object_id));
}

export function analyzeCanonicalConversion(input: {
  records: CanonicalExportRecord[];
  authority_id: string;
  sources: Array<{ source_path: string; markdown: string; byte_count: number }>;
  source_discovery?: SemanticSourceDiscoveryCounts;
  path_redaction_secret: string;
  typed_projection_omissions?: CanonicalTypedProjectionOmissions;
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
  const parityByCoverage = new Map<string, typeof parityRecords>();
  for (const parity of parityRecords) {
    const records = parityByCoverage.get(parity.source_coverage_key) ?? [];
    records.push(parity);
    parityByCoverage.set(parity.source_coverage_key, records);
  }
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
        lineageReferences.push(...(payload.supersedes ?? []));
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
  const sourceRefByUnitEvidenceId = new Map<string, string>();
  for (const evidence of unitEvidence) {
    const occurrence = unitOccurrence(evidence.locator);
    if (!occurrence) continue;
    const ids = unitEvidenceIdsByOccurrence.get(occurrence.key) ?? new Set<string>();
    ids.add(evidence.evidence_id);
    unitEvidenceIdsByOccurrence.set(occurrence.key, ids);
    sourceRefByUnitEvidenceId.set(evidence.evidence_id, occurrence.source_ref);
  }
  const expectedSources = expectedSourceCoverages(input.sources, input.authority_id, input.path_redaction_secret);
  const expectedSourcesByCoverage = new Map<string, ExpectedSourceCoverage[]>();
  for (const source of expectedSources) {
    const sources = expectedSourcesByCoverage.get(source.coverage_key) ?? [];
    sources.push(source);
    expectedSourcesByCoverage.set(source.coverage_key, sources);
  }
  const expectedCoverageKeys = new Set(expectedSourcesByCoverage.keys());
  const reviewsByCoverage = new Map<string, typeof reviews>();
  for (const review of reviews) {
    for (const coverageKey of review.source_coverage_keys) {
      const records = reviewsByCoverage.get(coverageKey) ?? [];
      records.push(review);
      reviewsByCoverage.set(coverageKey, records);
    }
  }
  const observations = payloads.filter((payload) => payload.schema === "atlas.observation:v1");
  const observationById = new Map(observations.map((observation) => [observation.assertion_id, observation]));
  let unrepresentedMeaningfulUnits = 0;
  let crossSourceParityObservationReferences = 0;
  for (const source of expectedSources) {
    const exactParityObservationIds = new Set((parityByCoverage.get(source.coverage_key) ?? [])
      .filter((parity) => parity.coverage_state === "represented" && parity.representation_kind === "observation")
      .flatMap((parity) => parity.canonical_object_ids.filter((id) => observationIds.has(id))));
    for (const occurrenceKey of source.meaningful_unit_occurrences) {
      const unitEvidenceIds = unitEvidenceIdsByOccurrence.get(occurrenceKey);
      if (!unitEvidenceIds || !observations.some((observation) => (
        exactParityObservationIds.has(observation.assertion_id)
        && observation.evidence_refs.some((id) => unitEvidenceIds.has(id))
      ))) unrepresentedMeaningfulUnits += 1;
    }
    for (const observationId of exactParityObservationIds) {
      const observation = observationById.get(observationId);
      if (observation?.evidence_refs.some((id) => {
        const evidenceSourceRef = sourceRefByUnitEvidenceId.get(id);
        return evidenceSourceRef !== undefined && evidenceSourceRef !== source.source_ref;
      })) crossSourceParityObservationReferences += 1;
    }
  }

  const isCompleteNonzeroReview = (coverageKey: string, review: typeof reviews[number]): boolean => {
    const coverageParity = parityByCoverage.get(coverageKey) ?? [];
    if (review.source_coverage_keys.length !== 1
      || review.source_coverage_keys[0] !== coverageKey
      || coverageParity.length !== 1) return false;
    const parity = coverageParity[0]!;
    return parity.coverage_state === "represented"
      && parity.representation_kind === "observation"
      && parity.canonical_object_ids.length > 0
      && parity.canonical_object_ids.every((id) => observationIds.has(id) && review.proposed_object_ids.includes(id))
      && review.proposed_object_ids.every((id) => objectIds.has(id));
  };
  const incompleteReviews = reviews.filter((review) => {
    if (review.source_coverage_keys.length !== 1) return true;
    const coverageKey = review.source_coverage_keys[0]!;
    const sourceCoverage = expectedSourcesByCoverage.get(coverageKey);
    if (!sourceCoverage || sourceCoverage.length !== 1) return true;
    if (sourceCoverage[0]!.meaningful_unit_occurrences.length === 0) return true;
    return !isCompleteNonzeroReview(coverageKey, review);
  }).length;
  let invalidMeaningfulSourceParityRecords = 0;
  let invalidZeroUnitSourceParityRecords = 0;
  let incompleteNonzeroSourceReviews = 0;
  let actionableZeroUnitSourceReviews = 0;
  for (const [coverageKey, sourceCoverage] of expectedSourcesByCoverage) {
    const coverageParity = parityByCoverage.get(coverageKey) ?? [];
    const coverageReviews = reviewsByCoverage.get(coverageKey) ?? [];
    if (sourceCoverage.some((source) => source.meaningful_unit_occurrences.length > 0)) {
      if (coverageParity.length === 1) {
        const parity = coverageParity[0]!;
        if (parity.coverage_state !== "represented"
          || parity.representation_kind !== "observation"
          || parity.canonical_object_ids.length === 0) invalidMeaningfulSourceParityRecords += 1;
      }
      if (coverageReviews.length === 1
        && !isCompleteNonzeroReview(coverageKey, coverageReviews[0]!)) incompleteNonzeroSourceReviews += 1;
      continue;
    }
    if (coverageParity.length === 1) {
      const parity = coverageParity[0]!;
      if (parity.coverage_state !== "unrepresented"
        || parity.representation_kind !== undefined
        || parity.canonical_object_ids.length > 0) invalidZeroUnitSourceParityRecords += 1;
    }
    if (coverageReviews.length === 1) {
      const review = coverageReviews[0]!;
      if (review.source_coverage_keys.length !== 1
        || review.source_coverage_keys[0] !== coverageKey
        || review.proposed_object_ids.length > 0
        || review.recommendation !== "research"
        || review.resolution_state !== "research") actionableZeroUnitSourceReviews += 1;
    }
  }
  const duplicateExpectedCoverageKeys = [...expectedSourcesByCoverage.values()]
    .reduce((total, sources) => total + Math.max(0, sources.length - 1), 0);
  const missingExpectedParityRecords = [...expectedCoverageKeys]
    .filter((key) => (parityByCoverage.get(key) ?? []).length === 0).length;
  const duplicateExpectedParityRecords = [...expectedCoverageKeys]
    .reduce((total, key) => total + Math.max(0, (parityByCoverage.get(key) ?? []).length - 1), 0);
  const unexpectedParityCoverageRecords = parityRecords
    .filter((parity) => !expectedCoverageKeys.has(parity.source_coverage_key)).length;
  const missingExpectedReviewRecords = [...expectedCoverageKeys]
    .filter((key) => (reviewsByCoverage.get(key) ?? []).length === 0).length;
  const duplicateExpectedReviewRecords = [...expectedCoverageKeys]
    .reduce((total, key) => total + Math.max(0, (reviewsByCoverage.get(key) ?? []).length - 1), 0);
  const unexpectedReviewCoverageReferences = reviews
    .flatMap((review) => review.source_coverage_keys)
    .filter((key) => !expectedCoverageKeys.has(key)).length;
  const invalidReviewCoverageCardinality = reviews
    .filter((review) => review.source_coverage_keys.length !== 1).length;
  const schemas = Object.fromEntries(canonicalSchemas.map((schema) => [
    schema,
    payloads.filter((payload) => payload.schema === schema).length
  ])) as Record<CanonicalPayload["schema"], number>;

  return {
    sources: {
      files: input.sources.length,
      bytes: input.sources.reduce((total, source) => total + source.byte_count, 0)
    },
    source_discovery: input.source_discovery ?? {
      selected: input.sources.length,
      unsupported: 0,
      hidden: 0,
      oversize: 0,
      unreadable: 0,
      cap: 0,
      symlink: 0
    },
    typed_projection_omissions: input.typed_projection_omissions ?? {
      ambiguous_typed_entity_ids: 0,
      missing_edge_endpoints: 0,
      endpoint_type_mismatches: 0,
      ambiguous_endpoint_edges: 0,
      duplicate_edge_ids: 0,
      other_edge_omissions: 0
    },
    schemas,
    objects: {
      total: input.records.length,
      meaningful_unit_occurrences: expectedSources.reduce(
        (total, source) => total + source.meaningful_unit_occurrences.length,
        0
      ),
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
      cross_source_parity_observation_references: crossSourceParityObservationReferences,
      duplicate_expected_coverage_keys: duplicateExpectedCoverageKeys,
      missing_expected_parity_records: missingExpectedParityRecords,
      duplicate_expected_parity_records: duplicateExpectedParityRecords,
      unexpected_parity_coverage_records: unexpectedParityCoverageRecords,
      missing_expected_review_records: missingExpectedReviewRecords,
      duplicate_expected_review_records: duplicateExpectedReviewRecords,
      unexpected_review_coverage_references: unexpectedReviewCoverageReferences,
      invalid_review_coverage_cardinality: invalidReviewCoverageCardinality,
      invalid_meaningful_source_parity_records: invalidMeaningfulSourceParityRecords,
      invalid_zero_unit_source_parity_records: invalidZeroUnitSourceParityRecords,
      incomplete_nonzero_source_reviews: incompleteNonzeroSourceReviews,
      actionable_zero_unit_source_reviews: actionableZeroUnitSourceReviews,
      unrepresented_meaningful_units: unrepresentedMeaningfulUnits,
      unrepresented_source_parity: parityRecords.filter((parity) => (
        parity.coverage_state === "unrepresented" && expectedCoverageKeys.has(parity.source_coverage_key)
      )).length,
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
  const malformedSourceCoverage = integrity.duplicate_expected_coverage_keys
    + integrity.missing_expected_parity_records
    + integrity.duplicate_expected_parity_records
    + integrity.unexpected_parity_coverage_records
    + integrity.missing_expected_review_records
    + integrity.duplicate_expected_review_records
    + integrity.unexpected_review_coverage_references
    + integrity.invalid_review_coverage_cardinality
    + integrity.invalid_meaningful_source_parity_records
    + integrity.invalid_zero_unit_source_parity_records
    + integrity.incomplete_nonzero_source_reviews
    + integrity.actionable_zero_unit_source_reviews;
  if (integrity.duplicate_object_ids > 0
    || missingReferences > 0
    || malformedSourceCoverage > 0
    || integrity.cross_source_parity_observation_references > 0
    || integrity.unrepresented_meaningful_units > 0
    || integrity.reopened_manifest_mismatches > 0) {
    throw new Error("canonical isolated-copy integrity check failed");
  }
}

export async function persistCanonicalConversionArtifacts(input: {
  copy_dir: string;
  report: CanonicalConversionReport;
  manifest: CanonicalManifestEntry[];
}): Promise<void> {
  assertCanonicalConversionIntegrity(input.report);
  await writePrivateJson(join(input.copy_dir, "canonical-manifest.json"), input.manifest);
  await writePrivateJson(join(input.copy_dir, "conversion-report.json"), input.report);
}

type ExpectedSourceCoverage = {
  source_ref: string;
  coverage_key: string;
  meaningful_unit_occurrences: string[];
};

function expectedSourceCoverages(
  sources: Array<{ source_path: string; markdown: string }>,
  authorityId: string,
  pathRedactionSecret: string
): ExpectedSourceCoverage[] {
  return sources.map((source) => {
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
    const occurrences: string[] = [];
    for (const unit of accountSourceMeaning(accountingEvidence).meaningful_units) {
      const occurrence = (occurrenceByUnitId.get(unit.unit_id) ?? 0) + 1;
      occurrenceByUnitId.set(unit.unit_id, occurrence);
      occurrences.push(`${sourceRef}:${unit.unit_id}:${occurrence}`);
    }
    const stableBase = `${authorityId}:${sourceRef}:${sha256(source.markdown)}`;
    return {
      source_ref: sourceRef,
      coverage_key: stableIdentifier("la_coverage", `${stableBase}:coverage`),
      meaningful_unit_occurrences: occurrences
    };
  });
}

function unitOccurrence(locator: string): { key: string; source_ref: string } | undefined {
  const matched = /^migration:(la_source_[a-f0-9]{24}):unit:(sha256:[a-f0-9]{64}):occurrence:(\d+):excerpt:\d+$/.exec(locator);
  return matched ? { key: `${matched[1]}:${matched[2]}:${matched[3]}`, source_ref: matched[1]! } : undefined;
}

function stableIdentifier(prefix: string, input: string): string {
  return `${prefix}_${sha256(input).slice("sha256:".length, "sha256:".length + 24)}`;
}

function sha256(input: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`;
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
