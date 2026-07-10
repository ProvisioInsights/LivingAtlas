import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analyzeCanonicalConversion,
  assertCanonicalConversionIntegrity,
  runCanonicalIsolatedCopy,
  validateCanonicalIsolatedCopyRun
} from "./canonical-isolated-copy-runner";
import { createCanonicalMarkdownMigration, createCanonicalMarkdownMigrationExport } from "@living-atlas/importer";
import type { CanonicalExportRecord } from "@living-atlas/contracts";

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

function hasOnlyNumberLeaves(value: unknown): boolean {
  if (typeof value === "number") return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every(hasOnlyNumberLeaves);
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
      expect(result).toMatchObject({ source_file_count: 3, canonical_object_count: 27, generation: 1 });

      const report = await readJson(join(output, "conversion-report.json"));
      expect(hasOnlyNumberLeaves(report)).toBe(true);
      expect(report).toEqual({
        sources: { files: 3, bytes: sourceBytes },
        schemas: {
          "atlas.entity:v1": 2,
          "atlas.fact:v1": 1,
          "atlas.observation:v1": 7,
          "atlas.relationship:v2": 1,
          "atlas.evidence:v1": 10,
          "atlas.entity-resolution:v1": 0,
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
          reviews: 3,
          parity_records: 3
        },
        review_queue: { owner_review: 2, research: 1, incomplete: 0 },
        integrity: {
          duplicate_object_ids: 0,
          missing_evidence_references: 0,
          missing_entity_references: 0,
          missing_proposed_object_references: 0,
          missing_review_coverage_references: 0,
          missing_parity_object_references: 0,
          missing_lineage_references: 0,
          missing_snapshot_references: 0,
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

      expect(await readFile(personPath, "utf8")).toBe(personContent);
      expect(await readFile(organizationPath, "utf8")).toBe(organizationContent);
      expect(await readFile(researchPath, "utf8")).toBe(researchContent);
      const privateArtifacts = [
        join(output, "conversion-report.json"),
        join(output, "canonical-manifest.json")
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
      await expect(runCanonicalIsolatedCopy({ copy_dir: output, source_dir: source, acknowledgement: "run-canonical-isolated-copy", live_paths: [], authority_id: "la_authority_fixture0001", keyring_passphrase: "synthetic-isolated-copy-passphrase", source_kind: "logseq", source_mode: "logseq-notes" })).rejects.toThrow("output must be empty");
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
});
