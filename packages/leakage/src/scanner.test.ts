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
});
