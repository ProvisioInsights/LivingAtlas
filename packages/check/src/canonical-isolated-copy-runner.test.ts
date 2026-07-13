import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analyzeCanonicalConversion,
  assertCanonicalConversionIntegrity,
  persistCanonicalConversionArtifacts,
  runCanonicalIsolatedCopy,
  validateCanonicalIsolatedCopyRun
} from "./canonical-isolated-copy-runner";
import { createCanonicalMarkdownMigration, createCanonicalMarkdownMigrationExport } from "@living-atlas/importer";
import { CanonicalResearchResultPayloadSchema, type CanonicalExportRecord } from "@living-atlas/contracts";
import { FileLocalGraphStore } from "@living-atlas/local-graph-store";
import { decryptGraphObjectPayload, FileLocalKeyringStore } from "@living-atlas/local-keyring";
import { createLocalCanonicalAtlasClient } from "@living-atlas/atlas-client";

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

function hasOnlyNumberLeaves(value: unknown): boolean {
  if (typeof value === "number") return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every(hasOnlyNumberLeaves);
}

async function reopenCanonicalRecords(output: string, authorityId: string, passphrase: string) {
  const keyring = await new FileLocalKeyringStore(join(output, "keyring.json")).read(passphrase);
  const store = await FileLocalGraphStore.open({
    directory: join(output, "graph"),
    authorityId,
    plaintextPersistence: "encrypt",
    keyring
  });
  return (await createLocalCanonicalAtlasClient({
    graphStore: store,
    decryptPayload: async (object) => {
      const payload = await decryptGraphObjectPayload(object, keyring);
      return payload?.kind === "plaintext-json" ? payload.data : undefined;
    }
  }).exportCanonical()).records;
}

describe("canonical isolated-copy runner guard", () => {
  it("rejects missing acknowledgement, non-copy marker, and live source paths", () => {
    expect(() => validateCanonicalIsolatedCopyRun({ copy_dir: "/tmp/copy", source_dir: "/tmp/source", acknowledgement: "", live_paths: [] })).toThrow("acknowledgement");
    expect(() => validateCanonicalIsolatedCopyRun({ copy_dir: "/tmp/copy", source_dir: "/tmp/source", acknowledgement: "run-canonical-isolated-copy", live_paths: [] })).toThrow("copy marker");
    expect(() => validateCanonicalIsolatedCopyRun({ copy_dir: "/tmp/copy/.atlas-isolated-copy", source_dir: "/live/profile", acknowledgement: "run-canonical-isolated-copy", live_paths: ["/live/profile"] })).toThrow("live path");
    expect(() => validateCanonicalIsolatedCopyRun({ copy_dir: "/tmp/archive-copy/.atlas-isolated-copy", source_dir: "/tmp/archive-copy", acknowledgement: "run-canonical-isolated-copy", live_paths: [] })).toThrow("must not overlap");
    expect(validateCanonicalIsolatedCopyRun({ copy_dir: "/tmp/copy/.atlas-isolated-copy", source_dir: "/tmp/archive-copy", acknowledgement: "run-canonical-isolated-copy", live_paths: ["/live/profile"] })).toEqual({ copy_dir: "/tmp/copy/.atlas-isolated-copy", source_dir: "/tmp/archive-copy" });
  });

  it("writes counts-only integrity and stable canonical manifests after an encrypted reopen", async () => {
    const root = await mkdtemp(join(tmpdir(), "living-atlas-isolated-copy-"));
    const source = join(root, "source-copy");
    const output = join(root, "output", ".atlas-isolated-copy");
    const personPath = join(source, "pages", "Synthetic Person.md");
    const organizationPath = join(source, "pages", "Synthetic Org.md");
    const researchPath = join(source, "pages", "Synthetic Research.md");
    const personContent = [
      "type:: person",
      "phone:: +1 555 0123",
      "org:: [[Synthetic Org]]",
      "- Synthetic contact note."
    ].join("\n");
    const organizationContent = "type:: organization\n- Synthetic organization note.";
    const researchContent = "- Synthetic unresolved research note.";
    const sourceBytes = Buffer.byteLength(personContent)
      + Buffer.byteLength(organizationContent)
      + Buffer.byteLength(researchContent);
    try {
      await (await import("node:fs/promises")).mkdir(join(source, "pages"), { recursive: true });
      await writeFile(personPath, personContent, "utf8");
      await writeFile(organizationPath, organizationContent, "utf8");
      await writeFile(researchPath, researchContent, "utf8");
      await writeFile(join(source, "pages", "Unsupported.txt"), "unsupported", "utf8");
      await writeFile(join(source, "pages", ".Synthetic Hidden.md"), "- hidden", "utf8");
      const result = await runCanonicalIsolatedCopy({
        copy_dir: output,
        source_dir: source,
        acknowledgement: "run-canonical-isolated-copy",
        live_paths: [],
        authority_id: "la_authority_fixture0001",
        keyring_passphrase: "synthetic-isolated-copy-passphrase",
        path_redaction_secret: "synthetic-stable-path-redaction-secret",
        source_kind: "logseq",
        source_mode: "logseq-notes"
      });
      expect(result).toMatchObject({
        source_file_count: 3,
        canonical_object_count: 27,
        generation: 4,
        auto_apply: {
          planned: 3,
          committed: 3,
          retry_committed: 0,
          retry_idempotent: 3
        }
      });

      const report = await readJson(join(output, "conversion-report.json"));
      expect(hasOnlyNumberLeaves(report)).toBe(true);
      expect(report).toEqual({
        sources: { files: 3, bytes: sourceBytes },
        source_discovery: {
          selected: 3,
          unsupported: 1,
          hidden: 1,
          oversize: 0,
          unreadable: 0,
          cap: 0,
          symlink: 0
        },
        typed_projection_omissions: {
          ambiguous_typed_entity_ids: 0,
          missing_edge_endpoints: 0,
          endpoint_type_mismatches: 0,
          ambiguous_endpoint_edges: 0,
          duplicate_edge_ids: 0,
          other_edge_omissions: 0
        },
        schemas: {
          "atlas.entity:v1": 2,
          "atlas.fact:v1": 1,
          "atlas.observation:v1": 7,
          "atlas.relationship:v2": 1,
          "atlas.evidence:v1": 10,
          "atlas.entity-resolution:v1": 0,
          "atlas.research-result:v1": 0,
          "atlas.review-item:v1": 3,
          "atlas.parity-record:v1": 3
        },
        objects: {
          total: 27,
          meaningful_unit_occurrences: 7,
          unit_evidence: 7,
          observations: 7,
          facts: 1,
          relationships: 1,
          entities: 2,
          entity_resolutions: 0,
          research_results: 0,
          reviews: 3,
          parity_records: 3
        },
        review_queue: { owner_review: 0, research: 0, automatic: 3, incomplete: 0 },
        integrity: {
          duplicate_object_ids: 0,
          missing_evidence_references: 0,
          missing_entity_references: 0,
          missing_proposed_object_references: 0,
          missing_review_coverage_references: 0,
          missing_parity_object_references: 0,
          missing_lineage_references: 0,
          missing_snapshot_references: 0,
          cross_source_parity_observation_references: 0,
          duplicate_expected_coverage_keys: 0,
          missing_expected_parity_records: 0,
          duplicate_expected_parity_records: 0,
          unexpected_parity_coverage_records: 0,
          missing_expected_review_records: 0,
          duplicate_expected_review_records: 0,
          unexpected_review_coverage_references: 0,
          invalid_review_coverage_cardinality: 0,
          invalid_meaningful_source_parity_records: 0,
          invalid_zero_unit_source_parity_records: 0,
          incomplete_nonzero_source_reviews: 0,
          actionable_zero_unit_source_reviews: 0,
          unrepresented_meaningful_units: 0,
          unrepresented_source_parity: 0,
          reopened_manifest_mismatches: 0
        }
      });

      const manifest = await readJson(join(output, "canonical-manifest.json"));
      expect(manifest).toEqual(expect.arrayContaining([
        expect.objectContaining({
          object_id: expect.stringMatching(/^la_object_[A-Za-z0-9_-]+$/),
          object_type: expect.stringMatching(/^(entity|assertion|edge|evidence|review|manifest)$/),
          content_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)
        })
      ]));
      expect(manifest).toHaveLength(27);
      expect((manifest as Array<{ object_id: string }>).map((item) => item.object_id)).toEqual(
        [...(manifest as Array<{ object_id: string }>).map((item) => item.object_id)].sort()
      );
      expect((manifest as Array<Record<string, unknown>>).every((item) => (
        Object.keys(item).sort().join(",") === "content_hash,object_id,object_type"
      ))).toBe(true);
      await expect(readJson(join(output, "candidate-proof.json"))).resolves.toEqual(expect.objectContaining({
        proof_schema: "living-atlas-canonical-candidate-proof:v1",
        plaintext_policy: "counts-and-hashes-only",
        decrypt_coverage_complete: true,
        restart_manifest_equal: true,
        mutation_idempotency_verified: true
      }));

      const reopenedRecords = await reopenCanonicalRecords(
        output,
        "la_authority_fixture0001",
        "synthetic-isolated-copy-passphrase"
      );
      expect(reopenedRecords.filter((record) => record.payload.schema === "atlas.review-item:v1"))
        .toHaveLength(3);
      expect(reopenedRecords.every((record) => record.payload.schema === "atlas.review-item:v1"
        ? record.version === 2 && record.payload.resolution_state === "auto-applied"
        : record.version === 1)).toBe(true);
      expect(reopenedRecords.filter((record) => record.payload.schema === "atlas.parity-record:v1")
        .every((record) => record.version === 1)).toBe(true);

      expect(await readFile(personPath, "utf8")).toBe(personContent);
      expect(await readFile(organizationPath, "utf8")).toBe(organizationContent);
      expect(await readFile(researchPath, "utf8")).toBe(researchContent);
      const privateArtifacts = [
        join(output, "conversion-report.json"),
        join(output, "canonical-manifest.json"),
        join(output, "candidate-proof.json")
      ];
      for (const path of privateArtifacts) expect((await stat(path)).mode & 0o077).toBe(0);
      const persisted = [
        await readFile(join(output, "conversion-report.json"), "utf8"),
        await readFile(join(output, "canonical-manifest.json"), "utf8"),
        await readFile(join(output, "graph", "snapshot.json"), "utf8")
      ].join("\n");
      for (const privateBait of [
        personContent,
        organizationContent,
        researchContent,
        "Synthetic contact note.",
        "Synthetic organization note.",
        "Synthetic unresolved research note.",
        "Synthetic Person.md",
        "Synthetic Org.md",
        "Synthetic Research.md",
        "Unsupported.txt",
        ".Synthetic Hidden.md",
        personPath,
        organizationPath,
        researchPath
      ]) expect(persisted).not.toContain(privateBait);
      expect(persisted).not.toContain("control.json");
      expect(await readdir(output)).not.toContain("control.json");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("refuses to overwrite a nonempty isolated-copy output", async () => {
    const root = await mkdtemp(join(tmpdir(), "living-atlas-isolated-copy-existing-"));
    const source = join(root, "source-copy");
    const output = join(root, "output", ".atlas-isolated-copy");
    try {
      await (await import("node:fs/promises")).mkdir(source, { recursive: true });
      await (await import("node:fs/promises")).mkdir(output, { recursive: true });
      await writeFile(join(output, "existing"), "do-not-overwrite");
      await expect(runCanonicalIsolatedCopy({ copy_dir: output, source_dir: source, acknowledgement: "run-canonical-isolated-copy", live_paths: [], authority_id: "la_authority_fixture0001", keyring_passphrase: "synthetic-isolated-copy-passphrase", path_redaction_secret: "synthetic-existing-output-path-secret", source_kind: "logseq", source_mode: "logseq-notes" })).rejects.toThrow("output must be empty");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("keeps canonical ids stable when encryption rotates under a separate path-redaction secret", async () => {
    const root = await mkdtemp(join(tmpdir(), "living-atlas-isolated-copy-rotation-"));
    const source = join(root, "source-copy");
    const firstOutput = join(root, "first", ".atlas-isolated-copy");
    const secondOutput = join(root, "second", ".atlas-isolated-copy");
    const sourcePath = join(source, "pages", "Synthetic Rotation.md");
    const pathRedactionSecret = "synthetic-stable-identity-secret";
    try {
      await (await import("node:fs/promises")).mkdir(join(source, "pages"), { recursive: true });
      await writeFile(sourcePath, "type:: person\nphone:: +1 555 0142", "utf8");
      const base = {
        source_dir: source,
        acknowledgement: "run-canonical-isolated-copy",
        live_paths: [],
        authority_id: "la_authority_fixture0001",
        path_redaction_secret: pathRedactionSecret,
        source_kind: "logseq" as const,
        source_mode: "logseq-notes" as const
      };
      await runCanonicalIsolatedCopy({
        ...base,
        copy_dir: firstOutput,
        keyring_passphrase: "synthetic-first-encryption-passphrase"
      });
      await runCanonicalIsolatedCopy({
        ...base,
        copy_dir: secondOutput,
        keyring_passphrase: "synthetic-second-encryption-passphrase"
      });

      const firstManifest = await readJson(join(firstOutput, "canonical-manifest.json")) as Array<{ object_id: string }>;
      const secondManifest = await readJson(join(secondOutput, "canonical-manifest.json")) as Array<{ object_id: string }>;
      expect(secondManifest.map((item) => item.object_id)).toEqual(firstManifest.map((item) => item.object_id));
      const privateReports = [
        await readFile(join(firstOutput, "canonical-manifest.json"), "utf8"),
        await readFile(join(firstOutput, "conversion-report.json"), "utf8"),
        await readFile(join(secondOutput, "canonical-manifest.json"), "utf8"),
        await readFile(join(secondOutput, "conversion-report.json"), "utf8")
      ].join("\n");
      expect(privateReports).not.toContain(pathRedactionSecret);
      expect(privateReports).not.toContain("synthetic-first-encryption-passphrase");
      expect(privateReports).not.toContain("synthetic-second-encryption-passphrase");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("fails closed on duplicate ids, dangling references, and a meaningful unit without parity-backed observation", () => {
    const pathRedactionSecret = "synthetic-integrity-path-secret";
    const source = {
      source_path: "pages/Synthetic Integrity.md",
      markdown: "type:: person\nphone:: +1 555 0173",
      source_kind: "logseq" as const
    };
    const migration = createCanonicalMarkdownMigration([source], {
      authority_id: "la_authority_fixture0001",
      created_at: "2026-07-10T12:00:00.000Z",
      path_redaction_secret: pathRedactionSecret
    });
    const exported = createCanonicalMarkdownMigrationExport(migration);
    const unitEvidence = exported.records.find((record) => (
      record.payload.schema === "atlas.evidence:v1"
      && record.payload.extraction_method === "canonical-source-unit-v1"
    ));
    expect(unitEvidence).toBeDefined();
    const missingObjectId = "la_object_missingintegrity0001";
    const missingCoverageKey = "la_coverage_missingintegrity0001";
    const brokenRecords = exported.records
      .filter((record) => record.object_id !== unitEvidence!.object_id)
      .map((record): CanonicalExportRecord => {
        if (record.payload.schema === "atlas.observation:v1") return {
          ...record,
          payload: { ...record.payload, evidence_refs: ["la_object_missingevidence0001"] }
        } as CanonicalExportRecord;
        if (record.payload.schema === "atlas.fact:v1") return {
          ...record,
          payload: { ...record.payload, subject_entity_id: "la_object_missingentity0001" }
        } as CanonicalExportRecord;
        if (record.payload.schema === "atlas.review-item:v1") return {
          ...record,
          payload: {
            ...record.payload,
            proposed_object_ids: [...record.payload.proposed_object_ids, missingObjectId],
            source_coverage_keys: [...record.payload.source_coverage_keys, missingCoverageKey]
          }
        } as CanonicalExportRecord;
        if (record.payload.schema === "atlas.parity-record:v1") return {
          ...record,
          payload: { ...record.payload, canonical_object_ids: [missingObjectId] }
        } as CanonicalExportRecord;
        return record;
      });
    brokenRecords.push(brokenRecords[0]!);

    const report = analyzeCanonicalConversion({
      records: brokenRecords,
      authority_id: "la_authority_fixture0001",
      sources: [{
        source_path: source.source_path,
        markdown: source.markdown,
        byte_count: Buffer.byteLength(source.markdown)
      }],
      path_redaction_secret: pathRedactionSecret,
      reopened_manifest_mismatches: 0
    });
    expect(report.objects.meaningful_unit_occurrences).toBe(2);
    expect(report.integrity).toMatchObject({
      duplicate_object_ids: 1,
      missing_evidence_references: expect.any(Number),
      missing_entity_references: expect.any(Number),
      missing_proposed_object_references: 1,
      missing_review_coverage_references: 1,
      missing_parity_object_references: 1,
      unrepresented_meaningful_units: 2
    });
    expect(report.integrity.missing_evidence_references).toBeGreaterThan(0);
    expect(report.integrity.missing_entity_references).toBeGreaterThan(0);
    expect(() => assertCanonicalConversionIntegrity(report)).toThrow("canonical isolated-copy integrity check failed");
  });

  it("counts observation supersedes as lineage references", () => {
    const pathRedactionSecret = "synthetic-observation-lineage-secret";
    const source = {
      source_path: "pages/Synthetic Observation Lineage.md",
      markdown: "- Original observation.\n- Successor observation.",
      source_kind: "logseq" as const
    };
    const exported = createCanonicalMarkdownMigrationExport(createCanonicalMarkdownMigration([source], {
      authority_id: "la_authority_fixture0001",
      created_at: "2026-07-10T12:00:00.000Z",
      path_redaction_secret: pathRedactionSecret
    }));
    const observations = exported.records.filter((record) => record.payload.schema === "atlas.observation:v1");
    expect(observations).toHaveLength(2);
    const predecessor = observations[0]!;
    if (predecessor.payload.schema !== "atlas.observation:v1") throw new Error("expected observation predecessor");
    const predecessorId = predecessor.payload.assertion_id;
    const successorId = observations[1]!.object_id;
    const withSupersedes = (predecessor: string): CanonicalExportRecord[] => exported.records.map((record) => (
      record.object_id === successorId
        ? { ...record, payload: { ...record.payload, supersedes: [predecessor] } } as CanonicalExportRecord
        : record
    ));
    const analyze = (records: CanonicalExportRecord[]) => analyzeCanonicalConversion({
      records,
      authority_id: "la_authority_fixture0001",
      sources: [{
        source_path: source.source_path,
        markdown: source.markdown,
        byte_count: Buffer.byteLength(source.markdown)
      }],
      path_redaction_secret: pathRedactionSecret,
      reopened_manifest_mismatches: 0
    });

    expect(analyze(withSupersedes(predecessorId)).integrity.missing_lineage_references).toBe(0);
    const missingReport = analyze(withSupersedes("la_object_missinglineage0001"));
    expect(missingReport.integrity.missing_lineage_references).toBe(1);
    expect(() => assertCanonicalConversionIntegrity(missingReport)).toThrow("canonical isolated-copy integrity check failed");
  });

  it("counts canonical research results and validates their evidence and proposal references", () => {
    const authorityId = "la_authority_fixture0001";
    const pathRedactionSecret = "synthetic-research-result-integrity-secret";
    const source = {
      source_path: "pages/Synthetic Research Result.md",
      markdown: "type:: person\nphone:: +1 555 0123",
      source_kind: "logseq" as const
    };
    const exported = createCanonicalMarkdownMigrationExport(createCanonicalMarkdownMigration([source], {
      authority_id: authorityId,
      created_at: "2026-07-10T12:00:00.000Z",
      path_redaction_secret: pathRedactionSecret
    }));
    const evidence = exported.records.find((record) => record.payload.schema === "atlas.evidence:v1")!;
    const proposal = exported.records.find((record) => record.payload.schema === "atlas.fact:v1")!;
    if (evidence.payload.schema !== "atlas.evidence:v1" || proposal.payload.schema !== "atlas.fact:v1") {
      throw new Error("expected synthetic evidence and fact");
    }
    const result = CanonicalResearchResultPayloadSchema.parse({
      schema: "atlas.research-result:v1",
      research_result_id: "la_object_researchintegrity0001",
      run_id: "la_research_run_aaaaaaaaaaaaaaaaaaaaaaaa",
      candidate_id: "la_candidate_researchintegrity0001",
      source_unit_id: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      algorithm_version: "canonical-research-v1",
      normalized_query_hash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      connector_kind: "public-web",
      upstream_identity: "synthetic-integrity-source",
      independence_key: "synthetic-integrity-group",
      evidence_id: evidence.object_id,
      evidence_content_hash: evidence.payload.content_hash,
      retrieved_at: evidence.payload.retrieved_at,
      stance: "supports",
      identity_state: "resolved",
      identity_confidence: {
        band: "high",
        assessment_kind: "identity",
        method: "synthetic-fixture",
        assessed_at: "2026-07-10T12:00:00.000Z",
        evidence_refs: [evidence.object_id]
      },
      proposed_object_id: proposal.object_id,
      proposed_mutation_hash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      recorded_at: "2026-07-10T12:00:00.000Z"
    });
    const resultRecord: CanonicalExportRecord = {
      authority_id: authorityId,
      object_id: result.research_result_id,
      object_type: "review",
      version: 1,
      access_class: "local-private",
      content_hash: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      payload: result
    };
    const analyze = (record: CanonicalExportRecord) => analyzeCanonicalConversion({
      records: [...exported.records, record],
      authority_id: authorityId,
      sources: [{
        source_path: source.source_path,
        markdown: source.markdown,
        byte_count: Buffer.byteLength(source.markdown)
      }],
      path_redaction_secret: pathRedactionSecret,
      reopened_manifest_mismatches: 0
    });

    const valid = analyze(resultRecord);
    expect(valid.schemas["atlas.research-result:v1"]).toBe(1);
    expect(valid.objects.research_results).toBe(1);
    expect(valid.integrity).toMatchObject({
      missing_evidence_references: 0,
      missing_proposed_object_references: 0
    });

    const missing = analyze({
      ...resultRecord,
      payload: {
        ...result,
        evidence_id: "la_object_missingresearchevidence0001",
        identity_confidence: {
          ...result.identity_confidence,
          evidence_refs: ["la_object_missingresearchevidence0001"]
        },
        proposed_object_id: "la_object_missingresearchproposal0001"
      }
    } as CanonicalExportRecord);
    expect(missing.integrity.missing_evidence_references).toBeGreaterThan(0);
    expect(missing.integrity.missing_proposed_object_references).toBeGreaterThan(0);
  });

  it("binds each long meaningful-unit occurrence only to its exact source parity", () => {
    const authorityId = "la_authority_fixture0001";
    const pathRedactionSecret = "synthetic-source-bound-path-secret";
    const sources = [
      {
        source_path: "pages/Synthetic Long Source.md",
        markdown: `- ${"A".repeat(9_000)}`,
        source_kind: "logseq" as const
      },
      {
        source_path: "pages/Synthetic Other Source.md",
        markdown: "- Synthetic other source unit.",
        source_kind: "logseq" as const
      }
    ];
    const exported = createCanonicalMarkdownMigrationExport(createCanonicalMarkdownMigration(sources, {
      authority_id: authorityId,
      created_at: "2026-07-10T12:00:00.000Z",
      path_redaction_secret: pathRedactionSecret
    }));
    const parityRecords = exported.records.filter((record) => record.payload.schema === "atlas.parity-record:v1");
    expect(parityRecords).toHaveLength(2);
    const swappedParityIds = [
      parityRecords[1]!.payload.schema === "atlas.parity-record:v1"
        ? parityRecords[1]!.payload.canonical_object_ids
        : [],
      parityRecords[0]!.payload.schema === "atlas.parity-record:v1"
        ? parityRecords[0]!.payload.canonical_object_ids
        : []
    ];
    let parityIndex = 0;
    const records = exported.records.map((record): CanonicalExportRecord => {
      if (record.payload.schema !== "atlas.parity-record:v1") return record;
      return {
        ...record,
        payload: { ...record.payload, canonical_object_ids: swappedParityIds[parityIndex++]! }
      } as CanonicalExportRecord;
    });

    const report = analyzeCanonicalConversion({
      records,
      authority_id: authorityId,
      sources: sources.map((source) => ({
        source_path: source.source_path,
        markdown: source.markdown,
        byte_count: Buffer.byteLength(source.markdown)
      })),
      path_redaction_secret: pathRedactionSecret,
      reopened_manifest_mismatches: 0
    });
    expect(report.objects).toMatchObject({
      meaningful_unit_occurrences: 2,
      unit_evidence: 4,
      observations: 3
    });
    expect(report.integrity).toMatchObject({
      cross_source_parity_observation_references: 3,
      unrepresented_meaningful_units: 2
    });
    expect(() => assertCanonicalConversionIntegrity(report)).toThrow("canonical isolated-copy integrity check failed");
  });

  it("accounts for every duplicate, missing, unexpected, and invalid source coverage record", () => {
    const authorityId = "la_authority_fixture0001";
    const pathRedactionSecret = "synthetic-coverage-ledger-secret";
    const sources = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"].map((name) => ({
      source_path: `pages/Synthetic ${name}.md`,
      markdown: `- Synthetic ${name} unit.`,
      source_kind: "logseq" as const
    }));
    const migration = createCanonicalMarkdownMigration(sources, {
      authority_id: authorityId,
      created_at: "2026-07-10T12:00:00.000Z",
      path_redaction_secret: pathRedactionSecret
    });
    const exported = createCanonicalMarkdownMigrationExport(migration);
    const parity = migration.payloads.filter((payload) => payload.schema === "atlas.parity-record:v1");
    const reviews = migration.payloads.filter((payload) => payload.schema === "atlas.review-item:v1");
    expect(parity).toHaveLength(5);
    expect(reviews).toHaveLength(5);
    const unexpectedCoverageKey = "la_coverage_unexpectedsource0001";
    const duplicateParityId = "la_object_duplicateparity0001";
    const duplicateReviewId = "la_object_duplicatereview0001";
    const records = exported.records.flatMap((record): CanonicalExportRecord[] => {
      if (record.object_id === parity[1]!.parity_id || record.object_id === reviews[4]!.review_id) return [];
      if (record.object_id === parity[2]!.parity_id && record.payload.schema === "atlas.parity-record:v1") return [{
        ...record,
        payload: { ...record.payload, source_coverage_key: unexpectedCoverageKey }
      } as CanonicalExportRecord];
      if (record.object_id === reviews[2]!.review_id && record.payload.schema === "atlas.review-item:v1") return [{
        ...record,
        payload: { ...record.payload, source_coverage_keys: [unexpectedCoverageKey] }
      } as CanonicalExportRecord];
      if (record.object_id === parity[3]!.parity_id && record.payload.schema === "atlas.parity-record:v1") return [{
        ...record,
        payload: {
          ...record.payload,
          coverage_state: "unrepresented",
          representation_kind: undefined,
          canonical_object_ids: []
        }
      } as CanonicalExportRecord];
      return [record];
    });
    const firstParityRecord = exported.records.find((record) => record.object_id === parity[0]!.parity_id)!;
    const firstReviewRecord = exported.records.find((record) => record.object_id === reviews[0]!.review_id)!;
    if (firstParityRecord.payload.schema !== "atlas.parity-record:v1"
      || firstReviewRecord.payload.schema !== "atlas.review-item:v1") throw new Error("synthetic fixture mismatch");
    records.push({
      ...firstParityRecord,
      object_id: duplicateParityId,
      payload: { ...firstParityRecord.payload, parity_id: duplicateParityId }
    } as CanonicalExportRecord);
    records.push({
      ...firstReviewRecord,
      object_id: duplicateReviewId,
      payload: { ...firstReviewRecord.payload, review_id: duplicateReviewId }
    } as CanonicalExportRecord);

    const report = analyzeCanonicalConversion({
      records,
      authority_id: authorityId,
      sources: [...sources, sources[0]!].map((source) => ({
        source_path: source.source_path,
        markdown: source.markdown,
        byte_count: Buffer.byteLength(source.markdown)
      })),
      path_redaction_secret: pathRedactionSecret,
      reopened_manifest_mismatches: 0
    });
    expect(report.integrity).toMatchObject({
      duplicate_expected_coverage_keys: 1,
      missing_expected_parity_records: 2,
      duplicate_expected_parity_records: 1,
      unexpected_parity_coverage_records: 1,
      missing_expected_review_records: 2,
      duplicate_expected_review_records: 1,
      unexpected_review_coverage_references: 1,
      invalid_meaningful_source_parity_records: 1,
      incomplete_nonzero_source_reviews: 2,
      unrepresented_meaningful_units: 3,
      unrepresented_source_parity: 1
    });
    expect(() => assertCanonicalConversionIntegrity(report)).toThrow("canonical isolated-copy integrity check failed");
  });

  it("keeps empty and source-system-only Markdown as honest zero-unit source coverage", async () => {
    const root = await mkdtemp(join(tmpdir(), "living-atlas-isolated-zero-unit-"));
    const source = join(root, "source-copy");
    const output = join(root, "output", ".atlas-isolated-copy");
    const emptyPath = join(source, "pages", "Synthetic Empty.md");
    const excludedPath = join(source, "pages", "Synthetic Excluded.md");
    const excludedContent = "type:: query\n{{query (property :synthetic)}}";
    const authorityId = "la_authority_fixture0001";
    const passphrase = "synthetic-zero-unit-passphrase";
    try {
      await (await import("node:fs/promises")).mkdir(join(source, "pages"), { recursive: true });
      await writeFile(emptyPath, "", "utf8");
      await writeFile(excludedPath, excludedContent, "utf8");
      const result = await runCanonicalIsolatedCopy({
        copy_dir: output,
        source_dir: source,
        acknowledgement: "run-canonical-isolated-copy",
        live_paths: [],
        authority_id: authorityId,
        keyring_passphrase: passphrase,
        path_redaction_secret: "synthetic-zero-unit-path-secret",
        source_kind: "logseq",
        source_mode: "logseq-notes"
      });
      expect(result).toEqual({
        source_file_count: 2,
        canonical_object_count: 6,
        generation: 3,
        auto_apply: {
          planned: 2,
          committed: 2,
          retry_committed: 0,
          retry_idempotent: 2
        }
      });
      const report = await readJson(join(output, "conversion-report.json")) as {
        sources: { files: number; bytes: number };
        objects: Record<string, number>;
        review_queue: Record<string, number>;
        integrity: Record<string, number>;
      };
      expect(report.sources).toEqual({ files: 2, bytes: Buffer.byteLength(excludedContent) });
      expect(report.objects).toMatchObject({
        meaningful_unit_occurrences: 0,
        unit_evidence: 0,
        observations: 0,
        reviews: 2,
        parity_records: 2
      });
      expect(report.review_queue).toEqual({ owner_review: 0, research: 0, automatic: 2, incomplete: 0 });
      expect(report.integrity).toMatchObject({
        invalid_meaningful_source_parity_records: 0,
        invalid_zero_unit_source_parity_records: 0,
        incomplete_nonzero_source_reviews: 0,
        actionable_zero_unit_source_reviews: 0,
        unrepresented_meaningful_units: 0,
        unrepresented_source_parity: 2
      });

      const records = await reopenCanonicalRecords(output, authorityId, passphrase);
      const evidence = records.filter((record) => record.payload.schema === "atlas.evidence:v1");
      const reviews = records.filter((record) => record.payload.schema === "atlas.review-item:v1");
      const parity = records.filter((record) => record.payload.schema === "atlas.parity-record:v1");
      expect(evidence).toHaveLength(2);
      expect(evidence.map((record) => record.payload.schema === "atlas.evidence:v1"
        ? record.payload.excerpt
        : undefined).sort()).toEqual(["", excludedContent]);
      expect(evidence.some((record) => record.payload.schema === "atlas.evidence:v1"
        && record.payload.excerpt === ""
        && record.payload.extraction_method === "canonical-markdown-lossless-v1")).toBe(true);
      expect(records.some((record) => record.payload.schema === "atlas.observation:v1")).toBe(false);
      expect(reviews.every((record) => record.payload.schema === "atlas.review-item:v1"
        && record.payload.resolution_state === "auto-applied"
        && record.payload.proposed_object_ids.length === 0)).toBe(true);
      expect(parity.every((record) => record.payload.schema === "atlas.parity-record:v1"
        && record.payload.coverage_state === "unrepresented"
        && record.payload.meaning_state === "non-meaningful"
        && record.payload.canonical_object_ids.length === 0)).toBe(true);
      expect(await readFile(emptyPath, "utf8")).toBe("");
      expect(await readFile(excludedPath, "utf8")).toBe(excludedContent);
      const persisted = [
        await readFile(join(output, "conversion-report.json"), "utf8"),
        await readFile(join(output, "canonical-manifest.json"), "utf8"),
        await readFile(join(output, "graph", "snapshot.json"), "utf8")
      ].join("\n");
      expect(persisted).not.toContain(excludedContent);
      expect(persisted).not.toContain("Synthetic Empty.md");
      expect(persisted).not.toContain("Synthetic Excluded.md");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects represented parity and actionable review records for a zero-unit source", () => {
    const authorityId = "la_authority_fixture0001";
    const pathRedactionSecret = "synthetic-zero-unit-integrity-secret";
    const source = { source_path: "pages/Synthetic Empty.md", markdown: "", source_kind: "logseq" as const };
    const exported = createCanonicalMarkdownMigrationExport(createCanonicalMarkdownMigration([source], {
      authority_id: authorityId,
      created_at: "2026-07-10T12:00:00.000Z",
      path_redaction_secret: pathRedactionSecret
    }));
    const evidenceId = exported.records.find((record) => record.payload.schema === "atlas.evidence:v1")!.object_id;
    const records = exported.records.map((record): CanonicalExportRecord => {
      if (record.payload.schema === "atlas.parity-record:v1") return {
        ...record,
        payload: {
          ...record.payload,
          coverage_state: "represented",
          representation_kind: "observation",
          canonical_object_ids: [evidenceId]
        }
      } as CanonicalExportRecord;
      if (record.payload.schema === "atlas.review-item:v1") return {
        ...record,
        payload: { ...record.payload, proposed_object_ids: [evidenceId] }
      } as CanonicalExportRecord;
      return record;
    });

    const report = analyzeCanonicalConversion({
      records,
      authority_id: authorityId,
      sources: [{ source_path: source.source_path, markdown: "", byte_count: 0 }],
      path_redaction_secret: pathRedactionSecret,
      reopened_manifest_mismatches: 0
    });
    expect(report.review_queue.incomplete).toBe(1);
    expect(report.integrity).toMatchObject({
      invalid_zero_unit_source_parity_records: 1,
      actionable_zero_unit_source_reviews: 1,
      unrepresented_source_parity: 0
    });
    expect(() => assertCanonicalConversionIntegrity(report)).toThrow("canonical isolated-copy integrity check failed");
  });

  it("persists no success artifacts when the integrity report is malformed", async () => {
    const root = await mkdtemp(join(tmpdir(), "living-atlas-artifact-boundary-"));
    const output = join(root, ".atlas-isolated-copy");
    const authorityId = "la_authority_fixture0001";
    const pathRedactionSecret = "synthetic-artifact-boundary-secret";
    const source = {
      source_path: "pages/Synthetic Boundary.md",
      markdown: "- Synthetic boundary unit.",
      source_kind: "logseq" as const
    };
    try {
      await (await import("node:fs/promises")).mkdir(output, { recursive: true });
      const exported = createCanonicalMarkdownMigrationExport(createCanonicalMarkdownMigration([source], {
        authority_id: authorityId,
        created_at: "2026-07-10T12:00:00.000Z",
        path_redaction_secret: pathRedactionSecret
      }));
      const validReport = analyzeCanonicalConversion({
        records: exported.records,
        authority_id: authorityId,
        sources: [{
          source_path: source.source_path,
          markdown: source.markdown,
          byte_count: Buffer.byteLength(source.markdown)
        }],
        path_redaction_secret: pathRedactionSecret,
        reopened_manifest_mismatches: 0
      });
      const malformedReport = {
        ...validReport,
        integrity: { ...validReport.integrity, duplicate_object_ids: 1 }
      };

      await expect(persistCanonicalConversionArtifacts({
        copy_dir: output,
        report: malformedReport,
        manifest: [],
        candidate_proof: {
          proof_schema: "living-atlas-canonical-candidate-proof:v1",
          plaintext_policy: "counts-and-hashes-only",
          decrypt_coverage_complete: true,
          restart_manifest_equal: true,
          mutation_idempotency_verified: true
        }
      })).rejects.toThrow("canonical isolated-copy integrity check failed");
      expect(await readdir(output)).not.toContain("conversion-report.json");
      expect(await readdir(output)).not.toContain("canonical-manifest.json");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects one review that claims two expected zero-unit source keys", () => {
    const authorityId = "la_authority_fixture0001";
    const pathRedactionSecret = "synthetic-multisource-review-secret";
    const sources = ["One", "Two"].map((name) => ({
      source_path: `pages/Synthetic Empty ${name}.md`,
      markdown: "",
      source_kind: "logseq" as const
    }));
    const migration = createCanonicalMarkdownMigration(sources, {
      authority_id: authorityId,
      created_at: "2026-07-10T12:00:00.000Z",
      path_redaction_secret: pathRedactionSecret
    });
    const exported = createCanonicalMarkdownMigrationExport(migration);
    const reviews = migration.payloads.filter((payload) => payload.schema === "atlas.review-item:v1");
    expect(reviews).toHaveLength(2);
    const records = exported.records.flatMap((record): CanonicalExportRecord[] => {
      if (record.object_id === reviews[1]!.review_id) return [];
      if (record.object_id === reviews[0]!.review_id && record.payload.schema === "atlas.review-item:v1") return [{
        ...record,
        payload: {
          ...record.payload,
          source_coverage_keys: [
            reviews[0]!.source_coverage_keys[0]!,
            reviews[1]!.source_coverage_keys[0]!
          ]
        }
      } as CanonicalExportRecord];
      return [record];
    });

    const report = analyzeCanonicalConversion({
      records,
      authority_id: authorityId,
      sources: sources.map((source) => ({
        source_path: source.source_path,
        markdown: source.markdown,
        byte_count: 0
      })),
      path_redaction_secret: pathRedactionSecret,
      reopened_manifest_mismatches: 0
    });
    expect(report.integrity).toMatchObject({
      missing_expected_review_records: 0,
      duplicate_expected_review_records: 0,
      invalid_review_coverage_cardinality: 1
    });
    expect(() => assertCanonicalConversionIntegrity(report)).toThrow("canonical isolated-copy integrity check failed");
  });

  it("accepts an empty-proposal auto-applied review only with explicit non-meaningful parity", () => {
    const authorityId = "la_authority_fixture0001";
    const pathRedactionSecret = "synthetic-zero-auto-apply-secret";
    const source = {
      source_path: "pages/Synthetic Empty Auto.md",
      markdown: "",
      source_kind: "logseq" as const
    };
    const exported = createCanonicalMarkdownMigrationExport(createCanonicalMarkdownMigration([source], {
      authority_id: authorityId,
      created_at: "2026-07-10T12:00:00.000Z",
      path_redaction_secret: pathRedactionSecret
    }));
    const records = exported.records.map((record): CanonicalExportRecord => {
      if (record.payload.schema !== "atlas.review-item:v1") return record;
      return {
        ...record,
        payload: {
          ...record.payload,
          recommendation: "auto-apply",
          resolution_state: "auto-applied",
          proposed_object_ids: []
        }
      } as CanonicalExportRecord;
    });

    const report = analyzeCanonicalConversion({
      records,
      authority_id: authorityId,
      sources: [{ source_path: source.source_path, markdown: "", byte_count: 0 }],
      path_redaction_secret: pathRedactionSecret,
      reopened_manifest_mismatches: 0
    });
    expect(report.integrity).toMatchObject({
      invalid_review_coverage_cardinality: 0,
      invalid_zero_unit_source_parity_records: 0,
      actionable_zero_unit_source_reviews: 0
    });
    expect(() => assertCanonicalConversionIntegrity(report)).not.toThrow();
  });

  it("surfaces metadata-safe typed projection omission counts", () => {
    const authorityId = "la_authority_fixture0001";
    const pathRedactionSecret = "synthetic-typed-report-secret";
    const source = {
      source_path: "pages/Synthetic Typed Report.md",
      markdown: "- Synthetic report unit.",
      source_kind: "logseq" as const
    };
    const migration = createCanonicalMarkdownMigration([source], {
      authority_id: authorityId,
      created_at: "2026-07-10T12:00:00.000Z",
      path_redaction_secret: pathRedactionSecret
    });
    const typedProjectionOmissions = {
      ambiguous_typed_entity_ids: 1,
      missing_edge_endpoints: 2,
      endpoint_type_mismatches: 3,
      ambiguous_endpoint_edges: 4,
      duplicate_edge_ids: 5,
      other_edge_omissions: 6
    };
    const report = analyzeCanonicalConversion({
      records: createCanonicalMarkdownMigrationExport(migration).records,
      authority_id: authorityId,
      sources: [{
        source_path: source.source_path,
        markdown: source.markdown,
        byte_count: Buffer.byteLength(source.markdown)
      }],
      path_redaction_secret: pathRedactionSecret,
      typed_projection_omissions: typedProjectionOmissions,
      reopened_manifest_mismatches: 0
    });

    expect(report.typed_projection_omissions).toEqual(typedProjectionOmissions);
    expect(hasOnlyNumberLeaves(report.typed_projection_omissions)).toBe(true);
  });

  it("requires an independent nonempty path-redaction secret", async () => {
    const root = await mkdtemp(join(tmpdir(), "living-atlas-required-path-secret-"));
    const source = join(root, "source-copy");
    const output = join(root, "output", ".atlas-isolated-copy");
    try {
      await (await import("node:fs/promises")).mkdir(join(source, "pages"), { recursive: true });
      await writeFile(join(source, "pages", "Synthetic Secret.md"), "- Synthetic secret unit.", "utf8");
      await expect(runCanonicalIsolatedCopy({
        copy_dir: output,
        source_dir: source,
        acknowledgement: "run-canonical-isolated-copy",
        live_paths: [],
        authority_id: "la_authority_fixture0001",
        keyring_passphrase: "synthetic-keyring-passphrase",
        path_redaction_secret: "",
        source_kind: "logseq",
        source_mode: "logseq-notes"
      })).rejects.toThrow("path_redaction_secret is required");
      await expect(readFile(join(output, "conversion-report.json"), "utf8")).rejects.toThrow();
      await expect(readFile(join(output, "canonical-manifest.json"), "utf8")).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails before success artifacts when source discovery finds an oversize file", async () => {
    const root = await mkdtemp(join(tmpdir(), "living-atlas-oversize-discovery-"));
    const source = join(root, "source-copy");
    const output = join(root, "output", ".atlas-isolated-copy");
    const oversizePath = join(source, "pages", "Synthetic Oversize.md");
    try {
      await (await import("node:fs/promises")).mkdir(join(source, "pages"), { recursive: true });
      await writeFile(oversizePath, "", "utf8");
      await truncate(oversizePath, (16 * 1024 * 1024) + 1);
      await expect(runCanonicalIsolatedCopy({
        copy_dir: output,
        source_dir: source,
        acknowledgement: "run-canonical-isolated-copy",
        live_paths: [],
        authority_id: "la_authority_fixture0001",
        keyring_passphrase: "synthetic-oversize-passphrase",
        path_redaction_secret: "synthetic-oversize-path-secret",
        source_kind: "logseq",
        source_mode: "logseq-notes"
      })).rejects.toThrow("semantic source discovery incomplete: oversize=1 unreadable=0 cap=0 symlink=0");
      await expect(readFile(join(output, "conversion-report.json"), "utf8")).rejects.toThrow();
      await expect(readFile(join(output, "canonical-manifest.json"), "utf8")).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails before success artifacts when discovery finds file and directory symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "living-atlas-symlink-discovery-"));
    const source = join(root, "source-copy");
    const pages = join(source, "pages");
    const output = join(root, "output", ".atlas-isolated-copy");
    try {
      await (await import("node:fs/promises")).mkdir(pages, { recursive: true });
      const sourceFile = join(pages, "Synthetic Source.md");
      await writeFile(sourceFile, "- Synthetic source.", "utf8");
      try {
        await symlink(sourceFile, join(pages, "Synthetic File Link.md"), "file");
        await symlink(pages, join(source, "Synthetic Directory Link"), "dir");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") return;
        throw error;
      }

      await expect(runCanonicalIsolatedCopy({
        copy_dir: output,
        source_dir: source,
        acknowledgement: "run-canonical-isolated-copy",
        live_paths: [],
        authority_id: "la_authority_fixture0001",
        keyring_passphrase: "synthetic-symlink-passphrase",
        path_redaction_secret: "synthetic-symlink-path-secret",
        source_kind: "logseq",
        source_mode: "logseq-notes"
      })).rejects.toThrow("semantic source discovery incomplete: oversize=0 unreadable=0 cap=0 symlink=2");
      await expect(readFile(join(output, "conversion-report.json"), "utf8")).rejects.toThrow();
      await expect(readFile(join(output, "canonical-manifest.json"), "utf8")).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a symlink-ancestor alias of a configured live source before creating output", async () => {
    const root = await mkdtemp(join(tmpdir(), "living-atlas-live-alias-"));
    const realParent = join(root, "real-parent");
    const liveSource = join(realParent, "live-source");
    const aliasParent = join(root, "alias-parent");
    const output = join(root, "output", ".atlas-isolated-copy");
    try {
      await (await import("node:fs/promises")).mkdir(join(liveSource, "pages"), { recursive: true });
      await writeFile(join(liveSource, "pages", "Synthetic.md"), "- live source", "utf8");
      try {
        await symlink(realParent, aliasParent, "dir");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") return;
        throw error;
      }

      await expect(runCanonicalIsolatedCopy({
        copy_dir: output,
        source_dir: join(aliasParent, "live-source"),
        acknowledgement: "run-canonical-isolated-copy",
        live_paths: [liveSource],
        authority_id: "la_authority_fixture0001",
        keyring_passphrase: "synthetic-live-alias-passphrase",
        path_redaction_secret: "synthetic-live-alias-path-secret",
        source_kind: "logseq",
        source_mode: "logseq-notes"
      })).rejects.toThrow("configured live path");
      await expect(readdir(output)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
