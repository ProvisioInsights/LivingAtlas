import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { JsonSchema } from "./shape.js";
import type { ContractHistory, ContractLimits, ContractToolName, RecordSchemaName } from "./revision.js";

/**
 * The published manifest, and the loader that turns it back into something a
 * server can register.
 *
 * The direction of dependency is the point: the server reads THIS, and never
 * carries its own copy of a schema. A tool whose shape is declared in two
 * places has two shapes, and the one that is wrong is always the one nobody
 * looks at. Schemas are authored once, published once, and loaded from the
 * published bytes — so what a consumer fetched and what the server validates
 * against are the same document.
 */

export type ToolAnnotationsManifest = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
};

export type DeprecationNotice = {
  target_kind: "tool" | "field" | "error_code" | "record_schema" | "vocabulary_value";
  target: string;
  announced_at: string;
  removal_not_before: string;
  replacement?: string;
  reason: string;
};

export type ManifestTool = {
  name: ContractToolName;
  title: string;
  description: string;
  input_schema: string;
  output_schema: string;
  input_schema_id: string;
  output_schema_id: string;
  annotations: ToolAnnotationsManifest;
  cache: { ttl_ms: number; cache_scope: "private" | "public" };
  requires_capabilities: string[];
  deprecation: DeprecationNotice | null;
};

export type ManifestRecord = {
  name: RecordSchemaName;
  schema: string;
  schema_id: string;
};

export type ContractManifest = {
  contract_revision: string;
  protocol_version: string;
  plane: "consumer";
  policy_document: string;
  generated_by: string;
  limits: ContractLimits;
  history: ContractHistory;
  common_schemas: { input: string; output: string };
  common_schema_ids: { input: string; output: string };
  record_schemas: ManifestRecord[];
  tools: ManifestTool[];
  deprecations: DeprecationNotice[];
};

/** A tool as the server registers it: schemas resolved from bytes, not rebuilt. */
export type LoadedTool = Omit<ManifestTool, "input_schema" | "output_schema"> & {
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
};

export type LoadedContract = {
  manifest: ContractManifest;
  tools: LoadedTool[];
  records: Record<string, JsonSchema>;
  /** Both common documents, keyed by `$id`, ready to hand a validator. */
  common: Record<string, JsonSchema>;
};

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function asSchema(path: string, value: unknown): JsonSchema {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} is not a JSON Schema object`);
  }
  return value as JsonSchema;
}

/** Absolute path of the published directory for one revision. */
export function schemaDirectory(packageRoot: string, revision: string): string {
  return join(packageRoot, "schema", revision);
}

/**
 * Load a published revision from disk.
 *
 * Every referenced file is read and every `$id` is checked against the manifest.
 * A manifest that names a document whose `$id` disagrees is refused rather than
 * loaded: the manifest is how a consumer finds a schema by id, so a mismatch
 * means the id a consumer resolves and the bytes it gets are different things.
 */
export function loadContract(directory: string): LoadedContract {
  const manifest = readJson(join(directory, "manifest.json")) as ContractManifest;

  const common: Record<string, JsonSchema> = {};
  for (const position of ["input", "output"] as const) {
    const file = manifest.common_schemas[position];
    const schema = asSchema(file, readJson(join(directory, file)));
    const declared = manifest.common_schema_ids[position];
    if (schema["$id"] !== declared) {
      throw new Error(`${file} declares $id ${String(schema["$id"])}, manifest says ${declared}`);
    }
    common[declared] = schema;
  }

  const records: Record<string, JsonSchema> = {};
  for (const entry of manifest.record_schemas) {
    const schema = asSchema(entry.schema, readJson(join(directory, entry.schema)));
    if (schema["$id"] !== entry.schema_id) {
      throw new Error(`${entry.schema} declares $id ${String(schema["$id"])}, manifest says ${entry.schema_id}`);
    }
    records[entry.schema_id] = schema;
  }

  const tools: LoadedTool[] = manifest.tools.map((tool) => {
    const { input_schema, output_schema, ...rest } = tool;
    const inputSchema = asSchema(input_schema, readJson(join(directory, input_schema)));
    const outputSchema = asSchema(output_schema, readJson(join(directory, output_schema)));
    if (inputSchema["$id"] !== tool.input_schema_id) {
      throw new Error(`${input_schema} declares $id ${String(inputSchema["$id"])}, manifest says ${tool.input_schema_id}`);
    }
    if (outputSchema["$id"] !== tool.output_schema_id) {
      throw new Error(`${output_schema} declares $id ${String(outputSchema["$id"])}, manifest says ${tool.output_schema_id}`);
    }
    return { ...rest, inputSchema, outputSchema };
  });

  // A file in the published directory that the manifest does not name would be
  // served to nobody and reviewed by nobody, while still looking authoritative
  // to anyone who found it. Refuse rather than ignore.
  const named = new Set<string>([
    "manifest.json",
    manifest.common_schemas.input,
    manifest.common_schemas.output,
    ...manifest.record_schemas.map((entry) => entry.schema),
    ...manifest.tools.flatMap((tool) => [tool.input_schema, tool.output_schema])
  ]);
  for (const found of listJsonFiles(directory)) {
    if (!named.has(found)) {
      throw new Error(`${found} is published but not named by manifest.json`);
    }
  }

  return { manifest, tools, records, common };
}

/** Relative paths of every `.json` under the published directory, one level deep. */
function listJsonFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const child of readdirSync(join(directory, entry.name), { withFileTypes: true })) {
        if (child.isFile() && child.name.endsWith(".json")) found.push(`${entry.name}/${child.name}`);
      }
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      found.push(entry.name);
    }
  }
  return found;
}
