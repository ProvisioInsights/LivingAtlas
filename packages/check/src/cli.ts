import { pathToFileURL } from "node:url";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import {
  ControlPlaneSnapshotSchema,
  DurableAuditEventSchema,
  GraphObjectEnvelopeSchema,
  SyncChangeEventSchema,
  TemporalEdgeSchema,
  TemporalEventSchema
} from "@living-atlas/contracts";
import {
  auditEventFixture,
  controlPlaneFixture,
  fixtureRemoteClientId,
  sensitiveBaitRegistry,
  syncChangeFixture,
  syntheticGraphObjects,
  temporalEdges,
  temporalEvents
} from "@living-atlas/fixtures";
import {
  createCloudflareManifestEntry,
  generateOpaqueCloudflareObjectPath,
  scanCloudflarePathOpacity,
  scanForBaitStrings,
  scanRepoSafety
} from "@living-atlas/leakage";
import { filterRemoteOutput } from "@living-atlas/policy";
import { sha256TokenHash } from "../../cloudflare-worker/src/bootstrap";
import { BootstrapClaimLockCore, InMemoryBootstrapClaimLockStorage } from "../../cloudflare-worker/src/bootstrap-lock";
import { runWranglerLocalRuntimeSmoke } from "./wrangler-local-runtime-smoke";

export type LocalCheckResult = {
  ok: boolean;
  errors: string[];
};

export type CheckCommand = "local" | "cloudflare-deploy-readiness" | "first-run-guardrails" | "wrangler-local-runtime";

export type NamedCheckResult = LocalCheckResult & {
  name: CheckCommand;
};

const TypeScriptApiScanSkippedDirectories = new Set([
  ".claude",
  ".codex",
  ".git",
  ".wrangler",
  "coverage",
  "dist",
  "node_modules"
]);
const TypeScriptApiScanExtensions = new Set([".cjs", ".cts", ".js", ".mjs", ".mts", ".ts", ".tsx"]);
const TypeScriptApiImportPatterns = [
  /\bfrom\s+["']typescript["']/,
  /\bimport\s*\(\s*["']typescript["']\s*\)/,
  /\brequire\s*\(\s*["']typescript["']\s*\)/
];

function collectParseError(label: string, error: unknown): string {
  return `${label}: ${error instanceof Error ? error.message : String(error)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripJsonComments(input: string): string {
  let output = "";
  let inString = false;
  let stringQuote = "";
  let escaped = false;

  for (let index = 0; index < input.length; index += 1) {
    const current = input[index]!;
    const next = input[index + 1];

    if (inString) {
      output += current;
      if (escaped) {
        escaped = false;
      } else if (current === "\\") {
        escaped = true;
      } else if (current === stringQuote) {
        inString = false;
        stringQuote = "";
      }
      continue;
    }

    if (current === "\"" || current === "'") {
      inString = true;
      stringQuote = current;
      output += current;
      continue;
    }

    if (current === "/" && next === "/") {
      while (index < input.length && input[index] !== "\n") {
        index += 1;
      }
      output += "\n";
      continue;
    }

    if (current === "/" && next === "*") {
      index += 2;
      while (index < input.length && !(input[index] === "*" && input[index + 1] === "/")) {
        index += 1;
      }
      index += 1;
      continue;
    }

    output += current;
  }

  return output;
}

function readJsonFile(path: string): unknown {
  return JSON.parse(stripJsonComments(readFileSync(path, "utf8"))) as unknown;
}

function walkSourceFiles(repoRoot: string, current = repoRoot): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      continue;
    }

    const fullPath = join(current, entry.name);
    if (entry.isDirectory()) {
      if (!TypeScriptApiScanSkippedDirectories.has(entry.name)) {
        files.push(...walkSourceFiles(repoRoot, fullPath));
      }
      continue;
    }

    if (entry.isFile() && TypeScriptApiScanExtensions.has(extname(entry.name))) {
      files.push(relative(repoRoot, fullPath));
    }
  }
  return files;
}

export function collectTypeScriptCompilerApiImportFindings(repoRoot = process.cwd()): string[] {
  const findings: string[] = [];

  for (const relPath of walkSourceFiles(repoRoot)) {
    const fullPath = join(repoRoot, relPath);
    if (statSync(fullPath).size > 2_000_000) {
      continue;
    }

    const content = readFileSync(fullPath, "utf8");
    if (TypeScriptApiImportPatterns.some((pattern) => pattern.test(content))) {
      findings.push(`${relPath}: import the TypeScript compiler through a deliberate dev-only adapter, or use tsc/tsx/esbuild instead`);
    }
  }

  return findings;
}

function getArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function hasBinding(bindings: unknown, name: string): boolean {
  return getArray(bindings).some((binding) => isRecord(binding) && (binding.name === name || binding.binding === name));
}

function hasDurableObjectBinding(bindings: unknown, name: string, className: string): boolean {
  return getArray(bindings).some((binding) => (
    isRecord(binding) &&
    binding.name === name &&
    binding.class_name === className
  ));
}

function collectForbiddenConfigKeys(value: unknown, path: string[] = []): string[] {
  if (!isRecord(value)) {
    return [];
  }

  const forbiddenKeys = new Set([
    "account_id",
    "BOOTSTRAP_CLAIM_TOKEN_HASH",
    "BOOTSTRAP_CLAIM_TOKEN",
    "LA_SYNC_TOKEN_HASH",
    "LA_SYNC_TOKEN",
    "CLOUDFLARE_API_TOKEN",
    "CF_API_TOKEN"
  ]);
  const findings: string[] = [];

  for (const [key, child] of Object.entries(value)) {
    const childPath = [...path, key];
    if (forbiddenKeys.has(key)) {
      findings.push(childPath.join("."));
    }
    findings.push(...collectForbiddenConfigKeys(child, childPath));
  }

  return findings;
}

export function runLocalCheck(repoRoot = process.cwd()): LocalCheckResult {
  const errors: string[] = [];

  for (const [index, object] of syntheticGraphObjects.entries()) {
    const parsed = GraphObjectEnvelopeSchema.safeParse(object);
    if (!parsed.success) {
      errors.push(collectParseError(`syntheticGraphObjects[${index}]`, parsed.error));
    }
  }

  for (const [index, edge] of temporalEdges.entries()) {
    const parsed = TemporalEdgeSchema.safeParse(edge);
    if (!parsed.success) {
      errors.push(collectParseError(`temporalEdges[${index}]`, parsed.error));
    }
  }

  for (const [index, event] of temporalEvents.entries()) {
    const parsed = TemporalEventSchema.safeParse(event);
    if (!parsed.success) {
      errors.push(collectParseError(`temporalEvents[${index}]`, parsed.error));
    }
  }

  const controlPlane = ControlPlaneSnapshotSchema.safeParse(controlPlaneFixture);
  if (!controlPlane.success) {
    errors.push(collectParseError("controlPlaneFixture", controlPlane.error));
  }

  const auditEvent = DurableAuditEventSchema.safeParse(auditEventFixture);
  if (!auditEvent.success) {
    errors.push(collectParseError("auditEventFixture", auditEvent.error));
  }

  const syncChange = SyncChangeEventSchema.safeParse(syncChangeFixture);
  if (!syncChange.success) {
    errors.push(collectParseError("syncChangeFixture", syncChange.error));
  }

  const remoteCapability = controlPlaneFixture.capabilities.find((capability) => capability.profile === "remote-safe");
  if (!remoteCapability) {
    errors.push("controlPlaneFixture: missing remote-safe capability");
  }

  const remoteOutput = remoteCapability
    ? filterRemoteOutput("remote-safe", syntheticGraphObjects, remoteCapability, fixtureRemoteClientId, "2026-06-21T12:00:00.000Z")
    : { objects: [], withheld_count: syntheticGraphObjects.length };
  const cloudflarePaths = syntheticGraphObjects.map((object) => generateOpaqueCloudflareObjectPath(object));
  const envelopeR2Paths = syntheticGraphObjects.flatMap((object) => object.payload.kind === "ciphertext-ref" && object.payload.storage === "r2" ? [object.payload.path] : []);
  const cloudflareManifest = syntheticGraphObjects.map((object) => createCloudflareManifestEntry(object));
  const leakageFindings = scanForBaitStrings(
    [
      { name: "remote-output", content: JSON.stringify(remoteOutput) },
      { name: "cloudflare-paths", content: cloudflarePaths.join("\n") },
      { name: "envelope-r2-paths", content: envelopeR2Paths.join("\n") },
      { name: "cloudflare-manifest", content: JSON.stringify(cloudflareManifest) }
    ],
    sensitiveBaitRegistry
  );

  if (leakageFindings.length > 0) {
    errors.push(`sensitive fixture bait leaked into remote/cloud-visible output: ${JSON.stringify(leakageFindings)}`);
  }

  const pathOpacityFindings = scanCloudflarePathOpacity([...cloudflarePaths, ...envelopeR2Paths]);
  if (pathOpacityFindings.length > 0) {
    errors.push(`cloudflare-visible paths are not opaque: ${JSON.stringify(pathOpacityFindings)}`);
  }

  const repoSafety = scanRepoSafety(repoRoot);
  if (!repoSafety.ok) {
    errors.push(`repo safety scan failed: ${JSON.stringify(repoSafety.findings)}`);
  }

  const compilerApiImports = collectTypeScriptCompilerApiImportFindings(repoRoot);
  if (compilerApiImports.length > 0) {
    errors.push(`TypeScript compiler API imports are not allowed in active source: ${JSON.stringify(compilerApiImports)}`);
  }

  return {
    ok: errors.length === 0,
    errors
  };
}

export function runSyntheticCloudflareDeployReadinessCheck(repoRoot = process.cwd()): LocalCheckResult {
  const errors: string[] = [];
  const wranglerPath = join(repoRoot, "packages/cloudflare-worker/wrangler.example.jsonc");

  if (!existsSync(wranglerPath)) {
    return {
      ok: false,
      errors: [`missing public-safe Wrangler example: ${wranglerPath}`]
    };
  }

  let config: unknown;
  try {
    config = readJsonFile(wranglerPath);
  } catch (error) {
    errors.push(collectParseError("wrangler.example.jsonc", error));
    config = undefined;
  }

  if (isRecord(config)) {
    const workerMain = typeof config.main === "string" ? join(dirname(wranglerPath), config.main) : undefined;
    if (!workerMain || !existsSync(workerMain)) {
      errors.push("wrangler.example.jsonc: main must point at an existing Worker entrypoint");
    }

    if (config.route !== undefined || config.routes !== undefined || config.custom_domain !== undefined || config.custom_domains !== undefined) {
      errors.push("wrangler.example.jsonc: public template must not contain personal routes or custom domains");
    }

    const forbiddenConfigKeys = collectForbiddenConfigKeys(config);
    if (forbiddenConfigKeys.length > 0) {
      errors.push(`wrangler.example.jsonc: private deploy values must not appear in the public template: ${forbiddenConfigKeys.join(", ")}`);
    }

    const observability = isRecord(config.observability) ? config.observability : undefined;
    if (!observability || observability.enabled !== true) {
      errors.push("wrangler.example.jsonc: observability must be enabled before deployment");
    } else {
      const logs = isRecord(observability.logs) ? observability.logs : undefined;
      if (!logs || typeof logs.head_sampling_rate !== "number" || logs.head_sampling_rate <= 0 || logs.head_sampling_rate > 1) {
        errors.push("wrangler.example.jsonc: observability.logs.head_sampling_rate must be > 0 and <= 1");
      }

      const traces = isRecord(observability.traces) ? observability.traces : undefined;
      if (!traces || traces.enabled !== true || typeof traces.head_sampling_rate !== "number" || traces.head_sampling_rate <= 0 || traces.head_sampling_rate > 1) {
        errors.push("wrangler.example.jsonc: observability.traces must be enabled with head_sampling_rate > 0 and <= 1");
      }
    }

    const durableObjectBindings = isRecord(config.durable_objects) ? config.durable_objects.bindings : undefined;
    if (!hasDurableObjectBinding(durableObjectBindings, "BOOTSTRAP_CLAIM_LOCK", "BootstrapClaimLock")) {
      errors.push("wrangler.example.jsonc: missing BOOTSTRAP_CLAIM_LOCK Durable Object binding");
    }
    if (!hasDurableObjectBinding(durableObjectBindings, "SYNC_SEQUENCER", "SyncSequencer")) {
      errors.push("wrangler.example.jsonc: missing SYNC_SEQUENCER Durable Object binding");
    }

    const migrations = getArray(config.migrations);
    const hasBootstrapMigration = migrations.some((migration) => (
      isRecord(migration) &&
      getArray(migration.new_sqlite_classes).includes("BootstrapClaimLock")
    ));
    if (!hasBootstrapMigration) {
      errors.push("wrangler.example.jsonc: missing BootstrapClaimLock Durable Object migration");
    }
    const hasSyncSequencerMigration = migrations.some((migration) => (
      isRecord(migration) &&
      getArray(migration.new_sqlite_classes).includes("SyncSequencer")
    ));
    if (!hasSyncSequencerMigration) {
      errors.push("wrangler.example.jsonc: missing SyncSequencer Durable Object migration");
    }

    if (!hasBinding(config.r2_buckets, "LA_GRAPH_BUCKET")) {
      errors.push("wrangler.example.jsonc: missing LA_GRAPH_BUCKET R2 binding");
    }

    if (!hasBinding(config.analytics_engine_datasets, "LA_OPERATIONAL_ANALYTICS")) {
      errors.push("wrangler.example.jsonc: missing LA_OPERATIONAL_ANALYTICS Analytics Engine binding");
    }

    const d1Bindings = getArray(config.d1_databases);
    const controlDb = d1Bindings.find((binding) => isRecord(binding) && binding.binding === "LA_CONTROL_DB");
    if (!isRecord(controlDb)) {
      errors.push("wrangler.example.jsonc: missing LA_CONTROL_DB D1 binding");
    } else if (controlDb.database_id !== "00000000-0000-0000-0000-000000000000") {
      errors.push("wrangler.example.jsonc: LA_CONTROL_DB database_id must stay a placeholder in the public template");
    } else if (controlDb.migrations_dir !== "./migrations") {
      errors.push("wrangler.example.jsonc: LA_CONTROL_DB must declare ./migrations for D1 schema setup");
    }

    const kvBindings = getArray(config.kv_namespaces);
    const configKv = kvBindings.find((binding) => isRecord(binding) && binding.binding === "LA_CONFIG");
    if (!isRecord(configKv)) {
      errors.push("wrangler.example.jsonc: missing LA_CONFIG KV binding");
    } else if (configKv.id !== "00000000000000000000000000000000") {
      errors.push("wrangler.example.jsonc: LA_CONFIG id must stay a placeholder in the public template");
    }

    if (!isRecord(config.vars) || typeof config.vars.BOOTSTRAP_LOCK_NAME !== "string") {
      errors.push("wrangler.example.jsonc: vars must include BOOTSTRAP_LOCK_NAME only as non-secret setup config");
    } else {
      if (config.vars.LA_OBSERVABILITY_CONSOLE !== "1") {
        errors.push("wrangler.example.jsonc: vars must enable LA_OBSERVABILITY_CONSOLE for structured Worker logs");
      }
      if (typeof config.vars.LA_OBSERVABILITY_LOG_SAMPLE_RATE !== "string") {
        errors.push("wrangler.example.jsonc: vars must include LA_OBSERVABILITY_LOG_SAMPLE_RATE as a non-secret sampling control");
      }
      if (typeof config.vars.LA_OBSERVABILITY_ANALYTICS_DATASET !== "string") {
        errors.push("wrangler.example.jsonc: vars must include LA_OBSERVABILITY_ANALYTICS_DATASET as a non-secret dataset label");
      }
      if (typeof config.vars.LA_OBSERVABILITY_RETENTION_DAYS !== "string") {
        errors.push("wrangler.example.jsonc: vars must include LA_OBSERVABILITY_RETENTION_DAYS as a non-secret retention control");
      }
      if (typeof config.vars.LA_AUTHORITY_ID !== "string") {
        errors.push("wrangler.example.jsonc: vars must include LA_AUTHORITY_ID as the non-secret authority boundary");
      }
      if (typeof config.vars.LA_USAGE_PROVIDER !== "string") {
        errors.push("wrangler.example.jsonc: vars must include LA_USAGE_PROVIDER as non-secret usage metadata");
      }
      if (typeof config.vars.LA_USAGE_PLAN !== "string") {
        errors.push("wrangler.example.jsonc: vars must include LA_USAGE_PLAN as non-secret usage metadata");
      }
      if (typeof config.vars.LA_USAGE_WINDOW_HOURS !== "string") {
        errors.push("wrangler.example.jsonc: vars must include LA_USAGE_WINDOW_HOURS as a non-secret usage window");
      }
      if (typeof config.vars.LA_USAGE_BUDGETS_JSON !== "string") {
        errors.push("wrangler.example.jsonc: vars must include LA_USAGE_BUDGETS_JSON as non-secret budget metadata");
      }
    }
  }

  const d1MigrationPath = join(repoRoot, "packages/cloudflare-worker/migrations/0001_sync_control.sql");
  if (!existsSync(d1MigrationPath)) {
    errors.push("missing D1 sync control migration at packages/cloudflare-worker/migrations/0001_sync_control.sql");
  } else {
    const migrationSql = readFileSync(d1MigrationPath, "utf8");
    for (const requiredTable of ["sync_batches", "sync_objects", "sync_changes", "sync_conflicts"]) {
      if (!migrationSql.includes(`CREATE TABLE IF NOT EXISTS ${requiredTable}`)) {
        errors.push(`D1 migration must create ${requiredTable}`);
      }
    }
    for (const requiredColumn of ["idempotency_key", "batch_hash", "staged_at", "last_seen_at"]) {
      if (!migrationSql.includes(requiredColumn)) {
        errors.push(`D1 migration must include ${requiredColumn}`);
      }
    }
    if (migrationSql.includes("idempotency_key TEXT NOT NULL UNIQUE")) {
      errors.push("D1 sync control migration must not make idempotency globally unique");
    }
    if (!migrationSql.includes("idx_sync_batches_authority_idempotency_key")) {
      errors.push("D1 sync control migration must scope idempotency by authority");
    }
  }

  const auditMigrationPath = join(repoRoot, "packages/cloudflare-worker/migrations/0002_audit_ledger.sql");
  if (!existsSync(auditMigrationPath)) {
    errors.push("missing D1 audit ledger migration at packages/cloudflare-worker/migrations/0002_audit_ledger.sql");
  } else {
    const migrationSql = readFileSync(auditMigrationPath, "utf8");
    for (const requiredTable of ["audit_events", "operational_metrics"]) {
      if (!migrationSql.includes(`CREATE TABLE IF NOT EXISTS ${requiredTable}`)) {
        errors.push(`D1 audit ledger migration must create ${requiredTable}`);
      }
    }
    for (const requiredClause of [
      "audit_events_no_update",
      "audit_events_no_delete",
      "event_hash TEXT NOT NULL UNIQUE",
      "idx_audit_events_authority_previous_hash",
      "expires_at TEXT NOT NULL",
      "sensitive INTEGER NOT NULL CHECK (sensitive = 0)"
    ]) {
      if (!migrationSql.includes(requiredClause)) {
        errors.push(`D1 audit ledger migration must include ${requiredClause}`);
      }
    }
  }

  const remoteGraphWriteMigrationPath = join(repoRoot, "packages/cloudflare-worker/migrations/0004_remote_graph_writes.sql");
  if (!existsSync(remoteGraphWriteMigrationPath)) {
    errors.push("missing D1 remote graph writes migration at packages/cloudflare-worker/migrations/0004_remote_graph_writes.sql");
  } else {
    const migrationSql = readFileSync(remoteGraphWriteMigrationPath, "utf8");
    if (migrationSql.includes("idempotency_key TEXT PRIMARY KEY")) {
      errors.push("D1 remote graph writes migration must not make idempotency globally unique");
    }
    if (!migrationSql.includes("idx_remote_graph_writes_authority_idempotency")) {
      errors.push("D1 remote graph writes migration must scope idempotency by authority");
    }
  }

  const securityMigrationPath = join(repoRoot, "packages/cloudflare-worker/migrations/0005_security_remediation.sql");
  if (!existsSync(securityMigrationPath)) {
    errors.push("missing D1 security remediation migration at packages/cloudflare-worker/migrations/0005_security_remediation.sql");
  } else {
    const migrationSql = readFileSync(securityMigrationPath, "utf8");
    for (const requiredClause of [
      "sync_batches_security_remediation",
      "remote_graph_writes_security_remediation",
      "idx_sync_batches_authority_idempotency_key",
      "idx_remote_graph_writes_authority_idempotency",
      "idx_audit_events_authority_previous_hash"
    ]) {
      if (!migrationSql.includes(requiredClause)) {
        errors.push(`D1 security remediation migration must include ${requiredClause}`);
      }
    }
  }

  const cloudflareManifest = syntheticGraphObjects.map((object) => createCloudflareManifestEntry(object));
  if (cloudflareManifest.length !== syntheticGraphObjects.length) {
    errors.push("synthetic Cloudflare manifest must cover the complete fixture graph");
  }

  const generatedPaths = cloudflareManifest.map((entry) => entry.path);
  const envelopeR2Paths = syntheticGraphObjects.flatMap((object) => object.payload.kind === "ciphertext-ref" && object.payload.storage === "r2" ? [object.payload.path] : []);
  const pathOpacityFindings = scanCloudflarePathOpacity([...generatedPaths, ...envelopeR2Paths]);
  if (pathOpacityFindings.length > 0) {
    errors.push(`synthetic Cloudflare deploy paths are not opaque: ${JSON.stringify(pathOpacityFindings)}`);
  }

  const sensitiveObjects = syntheticGraphObjects.filter((object) => object.access_class === "local-private" || object.access_class === "quarantine");
  for (const object of sensitiveObjects) {
    if (object.payload.kind === "plaintext-json") {
      errors.push(`synthetic deploy posture: sensitive object ${object.object_id} would expose plaintext to Cloudflare`);
    }

    if (object.encryption_class === "plaintext") {
      errors.push(`synthetic deploy posture: sensitive object ${object.object_id} uses plaintext encryption_class`);
    }

    if (object.visible_metadata.remote_indexable) {
      errors.push(`synthetic deploy posture: sensitive object ${object.object_id} is remote indexable`);
    }
  }

  const leakageFindings = scanForBaitStrings(
    [
      { name: "synthetic-cloudflare-manifest", content: JSON.stringify(cloudflareManifest) },
      { name: "synthetic-cloudflare-paths", content: [...generatedPaths, ...envelopeR2Paths].join("\n") }
    ],
    sensitiveBaitRegistry
  );
  if (leakageFindings.length > 0) {
    errors.push(`synthetic Cloudflare deploy metadata leaks sensitive bait: ${JSON.stringify(leakageFindings)}`);
  }

  return {
    ok: errors.length === 0,
    errors
  };
}

function syntheticBootstrapClaimPayload(): Record<string, unknown> {
  return {
    authority_id: "la_authority_bootstrapcheck0001",
    user_id: "la_user_bootstrapcheck0001",
    device_id: "la_device_bootstrapcheck0001",
    device_public_key_hash: "bootstrap-check-device-public-key-hash",
    policy_generation: 1,
    wrapped_keys: [
      {
        key_id: "la_key_bootstrapcheck0001",
        wrapping_device_id: "la_device_bootstrapcheck0001",
        algorithm: "synthetic-fixture",
        ciphertext: "wrapped-key-ciphertext-check-fixture"
      }
    ],
    recovery_public_material: {
      recovery_kit: "synthetic-public-material"
    },
    initial_remote_config: {
      profile: "synthetic-only"
    }
  };
}

export async function runFirstRunGuardrailCheck(repoRoot = process.cwd()): Promise<LocalCheckResult> {
  const errors: string[] = [];
  const now = "2026-06-21T12:00:00.000Z";
  const validToken = "synthetic-bootstrap-token-check-0001";
  const validTokenHash = await sha256TokenHash(validToken);
  const payload = syntheticBootstrapClaimPayload();

  const sealedLock = new BootstrapClaimLockCore(new InMemoryBootstrapClaimLockStorage());
  const sealedStatus = await sealedLock.getStatus({});
  if (sealedStatus.bootstrap_state !== "sealed") {
    errors.push(`first-run guardrail: missing bootstrap token hash must start sealed, got ${sealedStatus.bootstrap_state}`);
  }

  const sealedClaim = await sealedLock.claim(payload, validToken, {}, now);
  if (sealedClaim.ok || sealedClaim.reason !== "sealed") {
    errors.push("first-run guardrail: sealed deployment accepted or misclassified a claim");
  }

  const unclaimedLock = new BootstrapClaimLockCore(new InMemoryBootstrapClaimLockStorage());
  const config = {
    claim_token_hash: validTokenHash,
    claim_token_expires_at: "2099-01-01T00:00:00.000Z"
  };
  const unclaimedStatus = await unclaimedLock.getStatus(config);
  if (unclaimedStatus.bootstrap_state !== "unclaimed") {
    errors.push(`first-run guardrail: valid token hash should create unclaimed state, got ${unclaimedStatus.bootstrap_state}`);
  }

  const missingTokenClaim = await unclaimedLock.claim(payload, undefined, config, now);
  if (missingTokenClaim.ok || missingTokenClaim.reason !== "missing-token") {
    errors.push("first-run guardrail: claim without token was not rejected as missing-token");
  }

  const invalidTokenClaim = await unclaimedLock.claim(payload, "wrong-token", config, now);
  if (invalidTokenClaim.ok || invalidTokenClaim.reason !== "invalid-token") {
    errors.push("first-run guardrail: claim with invalid token was not rejected as invalid-token");
  }

  const expiredLock = new BootstrapClaimLockCore(new InMemoryBootstrapClaimLockStorage());
  const expiredClaim = await expiredLock.claim(payload, validToken, {
    claim_token_hash: validTokenHash,
    claim_token_expires_at: "2020-01-01T00:00:00.000Z"
  }, now);
  if (expiredClaim.ok || expiredClaim.reason !== "expired-token") {
    errors.push("first-run guardrail: expired token was not rejected as expired-token");
  }

  const concurrentLock = new BootstrapClaimLockCore(new InMemoryBootstrapClaimLockStorage());
  const concurrentClaims = await Promise.all([
    concurrentLock.claim(payload, validToken, config, now),
    concurrentLock.claim(payload, validToken, config, now)
  ]);
  const successfulClaims = concurrentClaims.filter((claim) => claim.ok);
  const rejectedAlreadyClaimed = concurrentClaims.filter((claim) => !claim.ok && claim.reason === "already-claimed");
  if (successfulClaims.length !== 1 || rejectedAlreadyClaimed.length !== 1) {
    errors.push(`first-run guardrail: concurrent valid claims must produce exactly one authority, got ${JSON.stringify(concurrentClaims)}`);
  }

  const claimedStatus = await concurrentLock.getStatus(config);
  if (claimedStatus.bootstrap_state !== "claimed" || claimedStatus.claim_token_burned_at !== now) {
    errors.push("first-run guardrail: successful claim must burn token and leave deployment claimed");
  }

  const workerSourcePath = join(repoRoot, "packages/cloudflare-worker/src/worker.ts");
  if (!existsSync(workerSourcePath)) {
    errors.push("first-run guardrail: missing Worker route source for token-in-query guard");
  } else {
    const workerSource = readFileSync(workerSourcePath, "utf8");
    for (const forbiddenParam of ["token", "claim_token", "bootstrap_claim_token", "sync_token"]) {
      if (!workerSource.includes(`"${forbiddenParam}"`)) {
        errors.push(`first-run guardrail: Worker route source must reject ${forbiddenParam} query parameter`);
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors
  };
}

export async function runNamedCheck(command: CheckCommand, repoRoot = process.cwd()): Promise<NamedCheckResult> {
  const result = command === "first-run-guardrails"
    ? await runFirstRunGuardrailCheck(repoRoot)
    : command === "wrangler-local-runtime"
      ? runWranglerLocalRuntimeSmoke({ repoRoot })
    : command === "cloudflare-deploy-readiness"
      ? runSyntheticCloudflareDeployReadinessCheck(repoRoot)
      : runLocalCheck(repoRoot);

  return {
    name: command,
    ...result
  };
}

export async function runAllChecks(repoRoot = process.cwd()): Promise<NamedCheckResult[]> {
  // Keep default checks in-process; the Wrangler smoke can fetch/use a CLI binary and is explicit.
  return Promise.all([
    runNamedCheck("local", repoRoot),
    runNamedCheck("cloudflare-deploy-readiness", repoRoot),
    runNamedCheck("first-run-guardrails", repoRoot)
  ]);
}

function parseCheckCommands(args: string[]): CheckCommand[] | undefined {
  if (args.length === 0 || args.includes("all")) {
    return ["local", "cloudflare-deploy-readiness", "first-run-guardrails"];
  }

  const validCommands = new Set<CheckCommand>(["local", "cloudflare-deploy-readiness", "first-run-guardrails", "wrangler-local-runtime"]);
  const commands = args.filter((arg): arg is CheckCommand => validCommands.has(arg as CheckCommand));
  return commands.length === args.length ? commands : undefined;
}

function printUsage(): void {
  console.error("Usage: living-atlas-check [all|local|cloudflare-deploy-readiness|first-run-guardrails|wrangler-local-runtime ...]");
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const commands = parseCheckCommands(args);
  if (!commands) {
    printUsage();
    process.exitCode = 2;
    return;
  }

  const results = await Promise.all(commands.map((command) => runNamedCheck(command)));
  const failed = results.filter((result) => !result.ok);

  if (failed.length > 0) {
    console.error("Living Atlas check failed");
    for (const result of failed) {
      console.error(`\n${result.name}`);
      for (const error of result.errors) {
        console.error(`- ${error}`);
      }
    }
    process.exitCode = 1;
    return;
  }

  console.log(`Living Atlas checks passed: ${results.map((result) => result.name).join(", ")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
