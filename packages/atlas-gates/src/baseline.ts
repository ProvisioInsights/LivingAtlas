import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadContract, type LoadedContract } from "@living-atlas/atlas-contract";
import type { BaselineConstant } from "./detectors.js";
import { repoRoot } from "./sources.js";

/**
 * The generated baseline: every number the contract publishes, derived from the
 * PUBLISHED BYTES.
 *
 * The direction matters and it is the whole point of gate 5. `revision.ts`
 * AUTHORS the limits; `schema/<revision>/` PUBLISHES them; this file GENERATES a
 * machine-readable summary of what was published; everything else READS the
 * generated summary. Author, publish, generate, consume — one direction, four
 * steps, and no step may be skipped.
 *
 * Generating from the published documents rather than from `revision.ts` is what
 * makes the round trip meaningful. A baseline generated from the same TypeScript
 * constant the catalog reads would agree with it by construction and prove
 * nothing; generated from the emitted JSON it disagrees the moment somebody
 * edits a schema by hand, which is the failure this gate exists to catch.
 */

export type ContractBaseline = {
  generated_from: string;
  contract_revision: string;
  protocol_version: string;
  counts: {
    tools: number;
    record_schemas: number;
    published_documents: number;
    deprecations: number;
  };
  limits: Record<string, number>;
  history: Record<string, number | boolean>;
  cache_ttl_ms: Record<string, number>;
  /** Every numeric bound that appears in a published INPUT schema, by JSON pointer. */
  schema_bounds: Record<string, number>;
};

const BOUND_KEYWORDS = ["maxItems", "minItems", "maximum", "minimum", "maxLength", "minLength", "maxProperties"];

function collectBounds(node: unknown, pointer: string, into: Record<string, number>): void {
  if (Array.isArray(node)) {
    for (const [index, item] of node.entries()) collectBounds(item, `${pointer}/${index}`, into);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (BOUND_KEYWORDS.includes(key) && typeof value === "number") {
      into[`${pointer}/${key}`] = value;
      continue;
    }
    collectBounds(value, `${pointer}/${key}`, into);
  }
}

/** Build the baseline from a loaded revision. Pure: same bytes in, same bytes out. */
export function generateBaseline(contract: LoadedContract, generatedFrom: string): ContractBaseline {
  const manifest = contract.manifest;

  const cacheTtl: Record<string, number> = {};
  for (const tool of manifest.tools) cacheTtl[tool.name] = tool.cache.ttl_ms;

  const bounds: Record<string, number> = {};
  for (const tool of contract.tools) {
    collectBounds(tool.inputSchema, `${tool.name}.input`, bounds);
  }
  for (const [id, schema] of Object.entries(contract.common)) {
    if (id.endsWith(":input")) collectBounds(schema, "common.input", bounds);
  }

  return {
    generated_from: generatedFrom,
    contract_revision: manifest.contract_revision,
    protocol_version: manifest.protocol_version,
    counts: {
      tools: manifest.tools.length,
      record_schemas: manifest.record_schemas.length,
      // manifest + both common documents + one per record + two per tool. A
      // count rather than a list, because the list is the manifest.
      published_documents: 3 + manifest.record_schemas.length + manifest.tools.length * 2,
      deprecations: manifest.deprecations.length
    },
    limits: { ...manifest.limits },
    history: { ...manifest.history },
    cache_ttl_ms: sortKeys(cacheTtl),
    schema_bounds: sortKeys(bounds)
  };
}

function sortKeys(record: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of Object.keys(record).sort()) out[key] = record[key] as number;
  return out;
}

/** Two spaces and a trailing newline, so a regenerated file diffs against a committed one. */
export function serializeBaseline(baseline: ContractBaseline): string {
  return `${JSON.stringify(baseline, null, 2)}\n`;
}

export function baselinePath(revision: string, root = repoRoot()): string {
  return join(root, "packages", "atlas-gates", "baseline", `contract-baseline.${revision}.json`);
}

export function readBaseline(revision: string, root = repoRoot()): ContractBaseline {
  return JSON.parse(readFileSync(baselinePath(revision, root), "utf8")) as ContractBaseline;
}

export function loadPublishedContract(revision: string, root = repoRoot()): LoadedContract {
  return loadContract(join(root, "packages", "atlas-contract", "schema", revision));
}

/**
 * Words that say nothing about WHICH limit a name refers to. `max_page_size` and
 * `max_batch_items` both say `max`; only `page` and `batch` identify them.
 */
const UNINFORMATIVE = new Set(["max", "min", "default", "per", "request", "prior", "before", "only", "ms", "v1"]);

export function contextWordsFor(name: string): string[] {
  return name
    .split(/[_.]/)
    .map((word) => word.toLowerCase())
    .filter((word) => word.length > 2 && !UNINFORMATIVE.has(word));
}

/**
 * The baseline as a lint table.
 *
 * Values below 2 are excluded: `0` and `1` are structural in every codebase, and
 * a rule that fires on them reports noise until somebody switches the rule off,
 * which is worse than not having it. Cache TTLs are excluded for the same
 * reason — most of them are `0`, and a `0` beside the word `cache` is how you
 * write "do not cache this".
 */
export function baselineConstants(baseline: ContractBaseline): BaselineConstant[] {
  const constants: BaselineConstant[] = [];

  for (const [name, value] of Object.entries(baseline.limits)) {
    if (value < 2) continue;
    constants.push({ name: `limits.${name}`, value, contextWords: contextWordsFor(name) });
  }
  for (const [name, value] of Object.entries(baseline.counts)) {
    if (value < 2) continue;
    constants.push({ name: `counts.${name}`, value, contextWords: contextWordsFor(name) });
  }
  return constants;
}
