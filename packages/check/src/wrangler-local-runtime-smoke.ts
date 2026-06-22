import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { sensitiveBaitRegistry } from "@living-atlas/fixtures";
import { scanForBaitStrings } from "@living-atlas/leakage";

export type WranglerSpawnResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
};

export type WranglerSpawn = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    encoding: "utf8";
    stdio: "pipe";
    timeout: number;
  }
) => WranglerSpawnResult;

export type WranglerLocalRuntimeSmokeOptions = {
  repoRoot?: string;
  configPath?: string;
  wranglerPackage?: string;
  keepOutput?: boolean;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  spawn?: WranglerSpawn;
};

export type WranglerLocalRuntimeSmokeResult = {
  ok: boolean;
  errors: string[];
  command: string[];
  output_dir: string;
  bundle_files: string[];
  stdout: string;
  stderr: string;
};

const requiredStdoutBindings = [
  "env.BOOTSTRAP_CLAIM_LOCK",
  "env.SYNC_SEQUENCER",
  "env.LA_CONTROL_DB",
  "env.LA_GRAPH_BUCKET"
];

const requiredBundleMarkers = [
  "x-living-atlas-bootstrap-token",
  "/api/bootstrap/claim",
  "/api/sync/batch",
  "BootstrapClaimLock",
  "SyncSequencer",
  "LA_GRAPH_BUCKET"
];

const workerBundleForbiddenBait = sensitiveBaitRegistry.filter((bait) => (
  // This predicate is part of the shared temporal contract registry, so Wrangler
  // correctly bundles the taxonomy literal even when no private fixture data ships.
  bait.id !== "private-relationship"
));

function textOutput(value: string | Buffer | undefined): string {
  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }

  return value ?? "";
}

function listFiles(root: string, current = root): string[] {
  if (!existsSync(current)) {
    return [];
  }

  const files: string[] = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const fullPath = join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(root, fullPath));
    } else if (entry.isFile()) {
      files.push(relative(root, fullPath));
    }
  }

  return files.sort();
}

function syntheticWranglerEnv(baseEnv: NodeJS.ProcessEnv, homeDir: string): NodeJS.ProcessEnv {
  return {
    PATH: baseEnv.PATH ?? "",
    HOME: homeDir,
    XDG_CONFIG_HOME: join(homeDir, ".config"),
    CI: "1",
    NO_COLOR: "1",
    WRANGLER_SEND_METRICS: "false"
  };
}

function validateDryRunOutput(outputDir: string, stdout: string, stderr: string, errors: string[]): string[] {
  const bundleFiles = listFiles(outputDir);
  if (!stdout.includes("--dry-run: exiting now.")) {
    errors.push("wrangler dry-run output did not confirm that it exited before deploy");
  }

  for (const binding of requiredStdoutBindings) {
    if (!stdout.includes(binding)) {
      errors.push(`wrangler dry-run output did not report binding ${binding}`);
    }
  }

  const bundlePath = join(outputDir, "index.js");
  if (!existsSync(bundlePath)) {
    errors.push("wrangler dry-run did not emit index.js");
  } else if (statSync(bundlePath).size === 0) {
    errors.push("wrangler dry-run emitted an empty index.js bundle");
  } else {
    const bundle = readFileSync(bundlePath, "utf8");
    for (const marker of requiredBundleMarkers) {
      if (!bundle.includes(marker)) {
        errors.push(`wrangler bundle is missing Worker marker: ${marker}`);
      }
    }

    const leakageFindings = scanForBaitStrings(
      [
        { name: "wrangler-bundle", content: bundle },
        { name: "wrangler-stdout", content: stdout },
        { name: "wrangler-stderr", content: stderr }
      ],
      workerBundleForbiddenBait
    );
    if (leakageFindings.length > 0) {
      errors.push(`wrangler dry-run leaked sensitive fixture bait: ${JSON.stringify(leakageFindings)}`);
    }
  }

  return bundleFiles;
}

export function runWranglerLocalRuntimeSmoke(options: WranglerLocalRuntimeSmokeOptions = {}): WranglerLocalRuntimeSmokeResult {
  const repoRoot = options.repoRoot ?? process.cwd();
  const configPath = options.configPath ?? join(repoRoot, "packages/cloudflare-worker/wrangler.example.jsonc");
  const wranglerPackage = options.wranglerPackage ?? "wrangler@4.103.0";
  const tempRoot = mkdtempSync(join(tmpdir(), "living-atlas-wrangler-smoke-"));
  const outputDir = join(tempRoot, "bundle");
  const homeDir = join(tempRoot, "home");
  const keepOutput = options.keepOutput ?? (options.env ?? process.env).LIVING_ATLAS_KEEP_WRANGLER_SMOKE === "1";
  const errors: string[] = [];
  const command = "pnpm";
  const args = [
    "dlx",
    wranglerPackage,
    "deploy",
    "--dry-run",
    "--outdir",
    outputDir,
    "--config",
    configPath
  ];
  let stdout = "";
  let stderr = "";
  let bundleFiles: string[] = [];

  try {
    mkdirSync(homeDir, { recursive: true });
    if (!existsSync(configPath)) {
      errors.push(`missing Wrangler config for local runtime smoke: ${configPath}`);
    } else {
      const run = options.spawn ?? ((spawnCommand, spawnArgs, spawnOptions) => spawnSync(spawnCommand, spawnArgs, spawnOptions));
      const result = run(command, args, {
        cwd: repoRoot,
        env: syntheticWranglerEnv(options.env ?? process.env, homeDir),
        encoding: "utf8",
        stdio: "pipe",
        timeout: options.timeoutMs ?? 120_000
      });
      stdout = textOutput(result.stdout);
      stderr = textOutput(result.stderr);

      if (result.error) {
        errors.push(`wrangler dry-run failed to start: ${result.error.message}`);
      }
      if (result.signal) {
        errors.push(`wrangler dry-run was terminated by signal ${result.signal}`);
      }
      if (result.status !== 0) {
        errors.push(`wrangler dry-run exited with status ${result.status ?? "unknown"}`);
      }

      if (errors.length === 0) {
        bundleFiles = validateDryRunOutput(outputDir, stdout, stderr, errors);
      }
    }

    return {
      ok: errors.length === 0,
      errors,
      command: [command, ...args],
      output_dir: outputDir,
      bundle_files: bundleFiles,
      stdout,
      stderr
    };
  } finally {
    if (!keepOutput) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }
}

export function printWranglerLocalRuntimeSmokeResult(result: WranglerLocalRuntimeSmokeResult): void {
  if (result.ok) {
    console.log("Living Atlas Wrangler local runtime smoke passed");
    console.log(`command: ${result.command.join(" ")}`);
    console.log(`bundle files: ${result.bundle_files.join(", ")}`);
    return;
  }

  console.error("Living Atlas Wrangler local runtime smoke failed");
  for (const error of result.errors) {
    console.error(`- ${error}`);
  }
  if (result.stdout.trim()) {
    console.error("\nstdout:");
    console.error(result.stdout.trim());
  }
  if (result.stderr.trim()) {
    console.error("\nstderr:");
    console.error(result.stderr.trim());
  }
}

export function main(): void {
  const result = runWranglerLocalRuntimeSmoke({
    keepOutput: process.env.LIVING_ATLAS_KEEP_WRANGLER_SMOKE === "1"
  });
  printWranglerLocalRuntimeSmokeResult(result);
  if (!result.ok) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
