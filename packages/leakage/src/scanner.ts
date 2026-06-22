import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { GraphObjectEnvelope } from "@living-atlas/contracts";
import type { BaitString } from "@living-atlas/fixtures";

export type ScanTarget = {
  name: string;
  content: string;
};

export type LeakageFinding = {
  target_name: string;
  bait_id: string;
  classification: BaitString["classification"];
  offset: number;
};

export function scanForBaitStrings(targets: ScanTarget[], baitRegistry: BaitString[]): LeakageFinding[] {
  const findings: LeakageFinding[] = [];

  for (const target of targets) {
    for (const bait of baitRegistry) {
      const offset = target.content.indexOf(bait.value);
      if (offset >= 0) {
        findings.push({
          target_name: target.name,
          bait_id: bait.id,
          classification: bait.classification,
          offset
        });
      }
    }
  }

  return findings;
}

function digest(value: string, length = 32): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

export function generateOpaqueCloudflareObjectPath(envelope: GraphObjectEnvelope): string {
  const authority = digest(envelope.authority_id, 16);
  const segment = digest(`${envelope.authority_id}:${envelope.object_id}:${envelope.version}`, 40);
  const partition = segment.slice(0, 2);
  return `objects/a=${authority}/p=${partition}/s=${segment}.bin`;
}

export type CloudflareManifestEntry = {
  ref: string;
  version: number;
  path: string;
  byte_size?: number;
  ciphertext_hash?: string;
};

export function createCloudflareManifestEntry(envelope: GraphObjectEnvelope): CloudflareManifestEntry {
  return {
    ref: digest(`${envelope.authority_id}:${envelope.object_id}`, 24),
    version: envelope.version,
    path: generateOpaqueCloudflareObjectPath(envelope),
    byte_size: envelope.payload.kind === "ciphertext-ref" ? envelope.payload.byte_size : undefined,
    ciphertext_hash: envelope.payload.kind === "ciphertext-ref" ? envelope.payload.ciphertext_hash : undefined
  };
}

export type PathOpacityFinding = {
  path: string;
  reason: string;
};

export function scanCloudflarePathOpacity(paths: string[]): PathOpacityFinding[] {
  return paths
    .filter((path) => !/^objects\/a=[a-f0-9]{16}\/p=[a-f0-9]{2}\/s=[a-f0-9]{40}\.bin$/.test(path))
    .map((path) => ({ path, reason: "Cloudflare-visible object path is not opaque" }));
}

export type RepoSafetyFinding = {
  path: string;
  rule: string;
  detail: string;
};

export type RepoSafetyResult = {
  ok: boolean;
  findings: RepoSafetyFinding[];
};

const SkippedDirectories = new Set([".git", "node_modules", ".pnpm", "dist", "coverage", ".turbo"]);
const ForbiddenFileRules: Array<{ rule: string; test: (path: string) => boolean; detail: string }> = [
  { rule: "terraform-state", test: (path) => /\.tfstate(?:\.backup)?$/.test(path), detail: "Terraform/OpenTofu state must not be committed" },
  { rule: "terraform-vars", test: (path) => /\.tfvars(?:\.json)?$/.test(path), detail: "Personal tfvars belong outside public git" },
  { rule: "dotenv", test: (path) => /(^|\/)\.env(?:\.|$)/.test(path), detail: "Environment secrets belong outside public git" },
  { rule: "wrangler-dev-vars", test: (path) => /(^|\/)\.dev\.vars$/.test(path), detail: "Wrangler local secrets belong outside public git" },
  { rule: "wrangler-personal-config", test: (path) => /(^|\/)wrangler\.jsonc?$/.test(path), detail: "Personal Wrangler config belongs in ignored/private deployment overlays; use wrangler.example.jsonc in public git" },
  { rule: "wrangler-local-state", test: (path) => /(^|\/)\.wrangler(\/|$)/.test(path), detail: "Wrangler local state belongs outside public git" },
  { rule: "living-atlas-local-profile", test: (path) => /(^|\/)\.living-atlas(\/|$)/.test(path), detail: "Local Living Atlas profile state belongs outside public git" }
];

const ForbiddenContentRules: Array<{ rule: string; pattern: RegExp; detail: string }> = [
  { rule: "cloudflare-api-token", pattern: /["']?(?:CLOUDFLARE_API_TOKEN|CF_API_TOKEN)["']?\s*[:=]\s*(?<!\\)["']?[A-Za-z0-9_-]{20,}/, detail: "Cloudflare API tokens must not be committed" },
  { rule: "cloudflare-account-id", pattern: /(?:CLOUDFLARE_ACCOUNT_ID\s*[:=]\s*|["']?account_id["']?\s*[:=]\s*)(?<!\\)["'][0-9a-f]{32}["']/i, detail: "Personal Cloudflare account ids belong in ignored deployment overlays" },
  { rule: "bootstrap-claim-token", pattern: /bootstrap[_-]?claim[_-]?token\s*[:=]\s*["'][A-Za-z0-9._-]{16,}["']/i, detail: "Bootstrap claim tokens must be generated locally and shown once" },
  { rule: "private-key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/, detail: "Private keys must not be committed" }
];

function walkFiles(root: string, current = root): string[] {
  const entries = readdirSync(current, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(current, entry.name);
    const rel = relative(root, fullPath);

    if (entry.isDirectory()) {
      if (SkippedDirectories.has(entry.name)) {
        continue;
      }
      files.push(...walkFiles(root, fullPath));
      continue;
    }

    if (entry.isFile()) {
      files.push(rel);
    }
  }

  return files;
}

export function scanRepoSafety(repoRoot: string): RepoSafetyResult {
  const findings: RepoSafetyFinding[] = [];

  for (const relPath of walkFiles(repoRoot)) {
    for (const rule of ForbiddenFileRules) {
      if (rule.test(relPath)) {
        findings.push({ path: relPath, rule: rule.rule, detail: rule.detail });
      }
    }

    const fullPath = join(repoRoot, relPath);
    if (statSync(fullPath).size > 2_000_000) {
      continue;
    }

    const content = readFileSync(fullPath, "utf8");
    for (const rule of ForbiddenContentRules) {
      if (rule.pattern.test(content)) {
        findings.push({ path: relPath, rule: rule.rule, detail: rule.detail });
      }
    }
  }

  return {
    ok: findings.length === 0,
    findings
  };
}
