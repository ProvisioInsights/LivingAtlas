import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  runAllChecks,
  runFirstRunGuardrailCheck,
  runLocalCheck,
  runNamedCheck,
  runSyntheticCloudflareDeployReadinessCheck
} from "./cli";

describe("local check command", () => {
  it("passes against the current public-safe synthetic scaffold", () => {
    expect(runLocalCheck(process.cwd())).toEqual({ ok: true, errors: [] });
  });
});

describe("synthetic Cloudflare deploy readiness command", () => {
  it("passes against the public-safe Wrangler template and synthetic custody fixtures", () => {
    expect(runSyntheticCloudflareDeployReadinessCheck(process.cwd())).toEqual({ ok: true, errors: [] });
  });

  it("flags private Cloudflare values in a public deploy template", () => {
    const root = mkdtempSync(join(tmpdir(), "living-atlas-check-"));
    try {
      const workerDir = join(root, "packages/cloudflare-worker");
      mkdirSync(join(workerDir, "src"), { recursive: true });
      writeFileSync(join(workerDir, "src/index.ts"), "export default {};\n");
      const privateAccountId = "1234567890abcdef".repeat(2);
      writeFileSync(join(workerDir, "wrangler.example.jsonc"), JSON.stringify({
        name: "living-atlas-private",
        main: "src/index.ts",
        account_id: privateAccountId,
        durable_objects: {
          bindings: [{ name: "BOOTSTRAP_CLAIM_LOCK", class_name: "BootstrapClaimLock" }]
        },
        migrations: [{ tag: "v1", new_sqlite_classes: ["BootstrapClaimLock"] }],
        r2_buckets: [{ binding: "LA_GRAPH_BUCKET", bucket_name: "living-atlas-example-graph" }],
        d1_databases: [{
          binding: "LA_CONTROL_DB",
          database_name: "living-atlas-example-control",
          database_id: "11111111-1111-1111-1111-111111111111"
        }],
        kv_namespaces: [{ binding: "LA_CONFIG", id: "11111111111111111111111111111111" }],
        vars: {
          BOOTSTRAP_LOCK_NAME: "living-atlas-bootstrap-claim-lock",
          BOOTSTRAP_CLAIM_TOKEN_HASH: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        }
      }, null, 2));

      const result = runSyntheticCloudflareDeployReadinessCheck(root);
      expect(result.ok).toBe(false);
      expect(result.errors.join("\n")).toContain("private deploy values");
      expect(result.errors.join("\n")).toContain("database_id must stay a placeholder");
      expect(result.errors.join("\n")).toContain("LA_CONFIG id must stay a placeholder");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("first-run guardrail command", () => {
  it("passes the synthetic bootstrap first-claim checks", async () => {
    await expect(runFirstRunGuardrailCheck()).resolves.toEqual({ ok: true, errors: [] });
  });
});

describe("check command orchestration", () => {
  it("runs named checks", async () => {
    await expect(runNamedCheck("cloudflare-deploy-readiness", process.cwd())).resolves.toEqual({
      name: "cloudflare-deploy-readiness",
      ok: true,
      errors: []
    });
  });

  it("runs the full readiness set", async () => {
    await expect(runAllChecks(process.cwd())).resolves.toEqual([
      { name: "local", ok: true, errors: [] },
      { name: "cloudflare-deploy-readiness", ok: true, errors: [] },
      { name: "first-run-guardrails", ok: true, errors: [] }
    ]);
  });
});
