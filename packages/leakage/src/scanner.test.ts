import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { controlPlaneFixture, fixtureRemoteClientId, sensitiveBaitRegistry, syntheticGraphObjects } from "@living-atlas/fixtures";
import { filterRemoteOutput } from "@living-atlas/policy";
import {
  createCloudflareManifestEntry,
  generateOpaqueCloudflareObjectPath,
  scanCloudflarePathOpacity,
  scanForBaitStrings,
  scanRepoSafety
} from "./index";

describe("metadata leakage scanner", () => {
  it("detects sensitive bait strings in arbitrary targets", () => {
    const findings = scanForBaitStrings(
      [{ name: "bad-output", content: "This leaked Avery North in output." }],
      sensitiveBaitRegistry
    );

    expect(findings).toEqual([
      {
        target_name: "bad-output",
        bait_id: "private-person-name",
        classification: "sensitive",
        offset: 12
      }
    ]);
  });

  it("finds no sensitive bait in remote output, opaque paths, or manifests", () => {
    const remoteCapability = controlPlaneFixture.capabilities.find((capability) => capability.profile === "remote-safe")!;
    const remoteOutput = filterRemoteOutput("remote-safe", syntheticGraphObjects, remoteCapability, fixtureRemoteClientId, "2026-06-21T12:00:00.000Z");
    const paths = syntheticGraphObjects.map((object) => generateOpaqueCloudflareObjectPath(object));
    const envelopePaths = syntheticGraphObjects.flatMap((object) => object.payload.kind === "ciphertext-ref" && object.payload.storage === "r2" ? [object.payload.path] : []);
    const manifest = syntheticGraphObjects.map((object) => createCloudflareManifestEntry(object));

    const findings = scanForBaitStrings(
      [
        { name: "remote-output", content: JSON.stringify(remoteOutput) },
        { name: "paths", content: paths.join("\n") },
        { name: "envelope-paths", content: envelopePaths.join("\n") },
        { name: "manifest", content: JSON.stringify(manifest) }
      ],
      sensitiveBaitRegistry
    );

    expect(findings).toEqual([]);
    expect(scanCloudflarePathOpacity([...paths, ...envelopePaths])).toEqual([]);
  });

  it("flags non-opaque Cloudflare-visible paths", () => {
    expect(scanCloudflarePathOpacity(["objects/a=fixtureopaque/p=7d/s=privatepageciphertext0001.bin"])).toEqual([
      {
        path: "objects/a=fixtureopaque/p=7d/s=privatepageciphertext0001.bin",
        reason: "Cloudflare-visible object path is not opaque"
      }
    ]);
  });
});

describe("repo safety scanner", () => {
  it("flags secret-bearing files and personal deployment overlays", () => {
    const root = join(tmpdir(), `living-atlas-repo-safety-${process.pid}`);
    rmSync(root, { force: true, recursive: true });
    mkdirSync(root, { recursive: true });
    mkdirSync(join(root, ".wrangler", "state"), { recursive: true });
    writeFileSync(join(root, "personal.tfvars"), "account_id = \"0123456789abcdef0123456789abcdef\"\n");
    writeFileSync(join(root, "wrangler.jsonc"), "{ \"account_id\": \"fedcba9876543210fedcba9876543210\", \"CF_API_TOKEN\": \"abcdefghijklmnopqrstuvwxyz123456\" }\n");
    writeFileSync(join(root, ".wrangler", "state", "local.sqlite"), "local state");
    writeFileSync(join(root, "README.md"), "safe");

    try {
      const result = scanRepoSafety(root);
      expect(result.ok).toBe(false);
      expect(result.findings.map((finding) => finding.rule)).toEqual(expect.arrayContaining([
        "terraform-vars",
        "cloudflare-account-id",
        "cloudflare-api-token",
        "wrangler-local-state",
        "wrangler-personal-config"
      ]));
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("flags a raw NUL byte in a source file, because git then serves it as an unreviewable binary blob", () => {
    const root = join(tmpdir(), `living-atlas-nul-guard-${process.pid}`);
    rmSync(root, { force: true, recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    // The literal byte and the escape compile to the same string, so only one of
    // these two files is a finding — the difference is entirely whether a
    // reviewer can read the diff that introduces it.
    writeFileSync(join(root, "src", "binary.ts"), `const key = \`a${"\u0000"}b\`;\n`);
    writeFileSync(join(root, "src", "text.ts"), String.raw`const key = \`a\u0000b\`;` + "\n");
    // Not source: a fixture may legitimately hold any byte at all.
    writeFileSync(join(root, "src", "fixture.bin"), `payload${"\u0000"}payload`);

    try {
      const result = scanRepoSafety(root);
      const flagged = result.findings.filter((finding) => finding.rule === "source-nul-byte");
      expect(flagged.map((finding) => finding.path)).toEqual(["src/binary.ts"]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("flags ambiguous schema names outside contract guard files", () => {
    const root = join(tmpdir(), `living-atlas-schema-guard-${process.pid}`);
    rmSync(root, { force: true, recursive: true });
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs", "bad.md"), [
      "Use RecurrenceRuleSchema here.",
      "required: amount, status",
      "attrs.recurrence is accepted"
    ].join("\n"));

    try {
      const result = scanRepoSafety(root);
      expect(result.ok).toBe(false);
      expect(result.findings.map((finding) => finding.rule)).toEqual(expect.arrayContaining([
        "old-recurrence-schema-name",
        "ambiguous-capital-status-attr",
        "ambiguous-edge-recurrence-attr"
      ]));
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  /**
   * The repository is public and the graph is not. The proposal file was ignored
   * for precisely this reason and the same counts were then committed anyway, in
   * source comments and ADRs, one design argument at a time — so the guard has to
   * be mechanical rather than a habit.
   *
   * Both halves are asserted, and the second half is the one that decides whether
   * the rule can live in the tree at all: a lint that also flags contract limits,
   * test counts and version numbers gets switched off within a week.
   *
   * The census strings are BUILT rather than written, because a positive control
   * that spells out the forbidden text either fails on itself or has to be
   * exempted — and an exemption is a hole the size of whatever it exempts. The
   * interpolation breaks the pattern in the source and restores it at runtime,
   * which is exactly the string the scanner is handed.
   */
  it("flags a census of the owner's graph and not a number about the software", () => {
    const root = join(tmpdir(), `living-atlas-census-guard-${process.pid}`);
    rmSync(root, { force: true, recursive: true });
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs", "census.md"), `A per-type breakdown: ${370} of ${470} nodes.\n`);
    writeFileSync(join(root, "docs", "gate.md"), `Gate G${6} measured ${65} of these and found none.\n`);
    writeFileSync(
      join(root, "docs", "safe.md"),
      [
        "Deduplication lasts `idempotency_ttl_days` (30).",
        "A snapshot lives `snapshot_ttl_seconds` (900).",
        "Measured — that mutant survived the whole 1536-test suite.",
        "Revision 2026.08.1 carries 12 tools and 25 predicates."
      ].join("\n")
    );

    try {
      const result = scanRepoSafety(root);
      const census = result.findings.filter((finding) => finding.rule.startsWith("corpus-census"));

      expect(census.map((finding) => finding.path).sort()).toEqual(["docs/census.md", "docs/gate.md"]);
      expect(census.map((finding) => finding.rule).sort()).toEqual([
        "corpus-census-measurement",
        "corpus-census-ratio"
      ]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  /**
   * A content rule asks "would this text be published?", so a file git will
   * never stage cannot fail it. The working notes at the repo root are the case
   * the exemption exists for: they hold the census, which is exactly why they
   * are ignored, and a scan that failed on them would make the rule protecting
   * the repository unusable inside it.
   *
   * The file-EXISTENCE rules still apply, because an ignore entry is one edit
   * away from not covering the file it names.
   */
  it("skips content rules for a file .gitignore names outright, but not file rules", () => {
    const root = join(tmpdir(), `living-atlas-ignored-notes-${process.pid}`);
    rmSync(root, { force: true, recursive: true });
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, ".gitignore"), "NOTES.local.md\n.env\nnode_modules/\n");
    writeFileSync(join(root, "NOTES.local.md"), `Working note: ${370} of ${470} nodes were other.\n`);
    writeFileSync(join(root, ".env"), "TOKEN=abc\n");

    try {
      const result = scanRepoSafety(root);

      expect(result.findings.filter((finding) => finding.path === "NOTES.local.md")).toEqual([]);
      expect(result.findings.map((finding) => finding.rule)).toContain("dotenv");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
