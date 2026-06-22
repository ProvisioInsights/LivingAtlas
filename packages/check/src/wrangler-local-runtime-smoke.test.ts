import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  runWranglerLocalRuntimeSmoke,
  type WranglerSpawn
} from "./wrangler-local-runtime-smoke";

const wranglerStdout = [
  "Total Upload: 641.76 KiB / gzip: 97.67 KiB",
  "env.BOOTSTRAP_CLAIM_LOCK (BootstrapClaimLock) Durable Object",
  "env.SYNC_SEQUENCER (SyncSequencer) Durable Object",
  "env.LA_CONTROL_DB (living-atlas-example-control) D1 Database",
  "env.LA_GRAPH_BUCKET (living-atlas-example-graph) R2 Bucket",
  "--dry-run: exiting now."
].join("\n");

const workerBundle = [
  "living-atlas-cloudflare-bootstrap",
  "/api/bootstrap/claim",
  "/api/sync/batch",
  "BootstrapClaimLock",
  "SyncSequencer",
  "LA_GRAPH_BUCKET"
].join("\n");

function outputDirFromArgs(args: string[]): string {
  const index = args.indexOf("--outdir");
  const outputDir = args[index + 1];
  if (index < 0 || !outputDir) {
    throw new Error("test spawn missing --outdir");
  }

  return outputDir;
}

describe("Wrangler local runtime smoke", () => {
  it("uses a synthetic dry-run command, sanitized env, and validates the emitted Worker bundle", () => {
    let capturedCommand: string | undefined;
    let capturedArgs: string[] = [];
    let capturedHome: string | undefined;
    const fakeSpawn: WranglerSpawn = (command, args, options) => {
      capturedCommand = command;
      capturedArgs = args;
      capturedHome = options.env.HOME;
      const outputDir = outputDirFromArgs(args);
      mkdirSync(outputDir, { recursive: true });
      writeFileSync(join(outputDir, "index.js"), workerBundle);
      writeFileSync(join(outputDir, "index.js.map"), "{}");
      writeFileSync(join(outputDir, "README.md"), "synthetic wrangler dry-run output");
      return {
        status: 0,
        signal: null,
        stdout: wranglerStdout,
        stderr: ""
      };
    };

    const result = runWranglerLocalRuntimeSmoke({
      repoRoot: process.cwd(),
      wranglerPackage: "wrangler@4.103.0",
      env: {
        PATH: process.env.PATH,
        HOME: "/should/not/reuse",
        CLOUDFLARE_API_TOKEN: "redacted"
      },
      spawn: fakeSpawn
    });

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(capturedCommand).toBe("pnpm");
    expect(capturedArgs).toContain("dlx");
    expect(capturedArgs).toContain("wrangler@4.103.0");
    expect(capturedArgs).toContain("deploy");
    expect(capturedArgs).toContain("--dry-run");
    expect(capturedArgs).toContain("--config");
    expect(capturedHome).not.toBe("/should/not/reuse");
    expect(result.bundle_files).toEqual(["README.md", "index.js", "index.js.map"]);
  });

  it("fails when Wrangler dry-run output leaks sensitive fixture bait", () => {
    const fakeSpawn: WranglerSpawn = (_command, args) => {
      const outputDir = outputDirFromArgs(args);
      mkdirSync(outputDir, { recursive: true });
      writeFileSync(join(outputDir, "index.js"), `${workerBundle}\nAvery North`);
      return {
        status: 0,
        signal: null,
        stdout: wranglerStdout,
        stderr: ""
      };
    };

    const result = runWranglerLocalRuntimeSmoke({
      repoRoot: process.cwd(),
      spawn: fakeSpawn
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("sensitive fixture bait");
  });
});
