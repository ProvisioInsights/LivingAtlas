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

const SkippedDirectories = new Set([".git", "node_modules", ".pnpm", "dist", "coverage", ".turbo", ".claude"]);
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
  { rule: "private-key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/, detail: "Private keys must not be committed" },
  /**
   * A COUNT OF THE OWNER'S GRAPH, in a public repository.
   *
   * `.gitignore` already keeps the vocabulary proposal out for exactly this
   * reason — those counts ARE a description of a private corpus, and this
   * repository is public — and then the same counts were committed anyway, in
   * source comments and ADRs, one design argument at a time. A per-type node
   * census is a census. A per-subtype breakdown of travel legs is an itemised
   * inventory of somebody's movements.
   *
   * The design arguments survive the numbers being removed, which is the test
   * that they were never load-bearing: "the modal value was `other`" makes the
   * same point and describes nothing. So the rule is narrow on purpose — it
   * fires on a MEASUREMENT CLAIM carrying a multi-digit number, not on every
   * number. A contract constant, a limit, a test count and a version are all
   * numbers about the software rather than about the corpus, and none of them
   * matches.
   *
   * This comment deliberately quotes no example. A lint that has to spell out
   * the thing it forbids either exempts its own file or fails on itself, and an
   * exemption is a hole the size of whatever it exempts.
   */
  {
    rule: "corpus-census-ratio",
    pattern: /\b\d{2,}\s+of\s+\d{2,}\b/,
    detail: "A count of the owner's private graph. State the rule the measurement justifies, not the measurement"
  },
  {
    rule: "corpus-census-measurement",
    pattern:
      /(?:measured\s+(?:on|against)\s+the\s+(?:real\s+)?(?:graph|corpus)|on\s+the\s+measured\s+corpus|gate\s+G\d[a-z]?)[^.\n]{0,160}\b\d{2,}\b|\b\d{2,}\b[^.\n]{0,160}(?:measured\s+(?:on|against)\s+the\s+(?:real\s+)?(?:graph|corpus)|on\s+the\s+measured\s+corpus|gate\s+G\d[a-z]?)/i,
    detail: "A measurement of the owner's private graph with the number attached. Keep the rule, drop the count"
  }
];

/**
 * Source files that must stay TEXT, and the byte that stops them being text.
 *
 * git classifies a blob as binary when it finds a NUL in the first 8000 bytes,
 * and a binary blob has no line diff, no `git blame` and no reviewable view in a
 * pull request. This has now shipped three times, always the same way: a NUL
 * separator typed literally into a template literal instead of written as the
 * `\u0000` escape. The two files it last hit were the redaction decision and the
 * HMAC request-state binding — the two a reviewer most needs to be able to read.
 *
 * The escape and the literal byte compile to the same string, so the rule costs
 * nothing at runtime and is purely about whether the change can be reviewed.
 */
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".jsx"];

const SchemaGuardSkippedPaths = [
  /^packages\/contracts\/src\/temporal\.ts$/,
  /^packages\/contracts\/src\/contracts\.test\.ts$/,
  /^packages\/contracts\/package\.json$/,
  /^packages\/cloudflare-worker\/src\/sync\.test\.ts$/,
  /^packages\/leakage\/src\/scanner\.ts$/,
  /^packages\/leakage\/src\/scanner\.test\.ts$/,
  /^packages\/mcp-contract\/src\/index\.ts$/,
  /^pnpm-lock\.yaml$/
];

const ForbiddenSchemaContentRules: Array<{ rule: string; pattern: RegExp; detail: string }> = [
  {
    rule: "old-recurrence-schema-name",
    pattern: /\b(?:RRuleSchema|RecurrenceRuleSchema)\b/,
    detail: "Use only IcalendarRecurrenceSchema/IcalendarRecurrenceSetTextSchema/IcalendarRRuleTextSchema"
  },
  {
    rule: "split-recurrence-field-name",
    pattern: /\b(?:dtstart|rdate|exdate|starts_at_local|starts-at-local)\b|["']rrule["']\s*:|\brrule\s*:/,
    detail: "Store recurrence components inside recurrence_set, not split fields"
  },
  {
    rule: "ambiguous-capital-status-attr",
    pattern: /amount\s*,\s*status|status\s*,\s*amount/,
    detail: "Use investment_status for capital edge state; edge status is lifecycle state"
  },
  {
    rule: "ambiguous-edge-recurrence-attr",
    pattern: /attrs\.(?:recurrence)|attrs\]\["recurrence"\]|attrs\]\['recurrence'\]/,
    detail: "Use attrs.schedule for temporal edge recurrence"
  }
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

/**
 * Files `.gitignore` names OUTRIGHT — a literal path, no glob, no negation.
 *
 * Content rules ask "would this text be published?", and a file git will never
 * stage cannot be. The working notes at the repo root are the case: they hold
 * absolute local paths and a census of the owner's graph, which is exactly WHY
 * they are ignored, so a content scan that failed on them would make the rule
 * that protects the repository unusable inside it.
 *
 * File-EXISTENCE rules still apply to everything, deliberately. A `.env` sitting
 * in the tree is worth naming whether or not git would stage it today, because
 * the ignore entry is one edit away from not covering it.
 */
function ignoredLiteralPaths(repoRoot: string): Set<string> {
  const paths = new Set<string>();
  let text: string;
  try {
    text = readFileSync(join(repoRoot, ".gitignore"), "utf8");
  } catch {
    return paths;
  }
  for (const line of text.split(/\r?\n/)) {
    const entry = line.trim();
    if (entry.length === 0 || entry.startsWith("#") || entry.startsWith("!")) {
      continue;
    }
    if (/[*?[\]]/.test(entry) || entry.endsWith("/") || entry.startsWith("/")) {
      continue;
    }
    paths.add(entry);
  }
  return paths;
}

export function scanRepoSafety(repoRoot: string): RepoSafetyResult {
  const findings: RepoSafetyFinding[] = [];
  const ignoredPaths = ignoredLiteralPaths(repoRoot);

  for (const relPath of walkFiles(repoRoot)) {
    for (const rule of ForbiddenFileRules) {
      if (rule.test(relPath)) {
        findings.push({ path: relPath, rule: rule.rule, detail: rule.detail });
      }
    }

    const fullPath = join(repoRoot, relPath);
    if (statSync(fullPath).size > 2_000_000 || ignoredPaths.has(relPath)) {
      continue;
    }

    const content = readFileSync(fullPath, "utf8");
    for (const rule of ForbiddenContentRules) {
      if (rule.pattern.test(content)) {
        findings.push({ path: relPath, rule: rule.rule, detail: rule.detail });
      }
    }

    // Scoped to source, not to every file: a fixture, a lockfile or a binary
    // asset may legitimately hold any byte. A `.ts` file may not, because the
    // whole reason it is checked in is that a human reads its diff.
    if (SOURCE_EXTENSIONS.some((extension) => relPath.endsWith(extension)) && content.includes("\u0000")) {
      findings.push({
        path: relPath,
        rule: "source-nul-byte",
        detail:
          "A source file holds a raw NUL byte, so git classifies it as binary and it has no reviewable diff. Write the \\u0000 escape instead — it compiles to the same string."
      });
    }

    if (!SchemaGuardSkippedPaths.some((pattern) => pattern.test(relPath))) {
      for (const rule of ForbiddenSchemaContentRules) {
        if (rule.pattern.test(content)) {
          findings.push({ path: relPath, rule: rule.rule, detail: rule.detail });
        }
      }
    }
  }

  return {
    ok: findings.length === 0,
    findings
  };
}
