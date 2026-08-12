import {
  CONTRACT_HISTORY,
  CONTRACT_LIMITS,
  CONTRACT_POLICY_DOCUMENT,
  CONTRACT_PROTOCOL_VERSION,
  CONTRACT_REVISION,
  CONTRACT_TOOL_NAMES,
  CONTRACT_URN_PREFIX,
  RECORD_SCHEMAS,
  type RecordSchemaName
} from "./revision.js";
import { CATALOG_TOOLS, INPUT_DEFS, OUTPUT_DEFS, RECORD_SHAPES, SHARED_DEFS } from "./catalog.js";
import { commonUrn, recordUrn, render, toolUrn, type JsonSchema, type Position } from "./shape.js";
import type { ContractManifest, ManifestRecord, ManifestTool } from "./manifest.js";

/**
 * The generator.
 *
 * It emits the published bytes, and it is also where the rules that must never
 * drift are ENFORCED rather than merely intended. Three of them throw here:
 *
 *  1. Asymmetric strictness. Every object subschema in an input document must
 *     carry `additionalProperties: false`; no object subschema in an output
 *     document may carry the keyword at all. `render()` applies this, and
 *     `assertStrictness` re-checks the emitted JSON — because the failure this
 *     guards against is a contract that TELLS consumers outputs are open while
 *     its generator quietly emits them closed, and a rule checked only where it
 *     is applied is a rule with one point of failure.
 *
 *  2. Records are output-only. An input document may not `$ref` a record
 *     schema. Every field that carries authority — ids, `seq`, `recorded_at`,
 *     `claim_digest`, `provenance.client_id` — is minted by Atlas at commit,
 *     and reusing the output shape on the input side is precisely how a caller
 *     ends up being able to supply one.
 *
 *  3. Reserved `other`. Every closed enum in an output document contains
 *     `other`, unless it is explicitly frozen with a published reason.
 */

export const DIALECT = "https://json-schema.org/draft/2020-12/schema";

export type ContractDocument = { path: string; schema: JsonSchema };

export type GeneratedContract = {
  manifest: ContractManifest;
  documents: ContractDocument[];
};

/** `atlas.assertion:v1` → `atlas.assertion-v1`. A colon in a filename is a portability trap. */
export function recordFileStem(name: RecordSchemaName): string {
  return name.replace(":", "-");
}

function commonDocument(position: Position): JsonSchema {
  const source = position === "input" ? INPUT_DEFS : OUTPUT_DEFS;
  const defs: Record<string, JsonSchema> = {};
  // Shared defs first, then position-specific: an input document has no
  // business carrying `coverage`, and an output document has no business
  // carrying `assertion_draft`. Emitting only what each side can reference
  // keeps an unreferenced, unreviewed schema out of the published bytes.
  for (const [name, shape] of Object.entries(SHARED_DEFS)) defs[name] = render(shape, position);
  for (const [name, shape] of Object.entries(source)) defs[name] = render(shape, position);

  return {
    $schema: DIALECT,
    $id: commonUrn(position),
    title: `Living Atlas contract ${CONTRACT_REVISION} — shared ${position} definitions`,
    $defs: defs
  };
}

function recordDocument(name: RecordSchemaName): JsonSchema {
  const shape = RECORD_SHAPES[name];
  return {
    $schema: DIALECT,
    $id: recordUrn(name),
    title: name,
    ...render(shape, "output")
  };
}

export function generateContract(): GeneratedContract {
  const documents: ContractDocument[] = [];

  const commons = {} as Record<Position, JsonSchema>;
  for (const position of ["input", "output"] as const) {
    const schema = commonDocument(position);
    assertStrictness(schema, position, `common.${position}.json`);
    if (position === "input") assertNoRecordRefs(schema, "common.input.json");
    documents.push({ path: `common.${position}.json`, schema });
    commons[position] = schema;
  }

  const recordEntries: ManifestRecord[] = [];
  const records: Partial<Record<RecordSchemaName, JsonSchema>> = {};
  for (const name of RECORD_SCHEMAS) {
    const path = `records/${recordFileStem(name)}.json`;
    const schema = recordDocument(name);
    assertStrictness(schema, "output", path);
    assertReservedOther(schema, path);
    documents.push({ path, schema });
    recordEntries.push({ name, schema: path, schema_id: recordUrn(name) });
    records[name] = schema;
  }

  const tools: ManifestTool[] = [];
  for (const tool of CATALOG_TOOLS) {
    const inputPath = `tools/${tool.name}.input.json`;
    const outputPath = `tools/${tool.name}.output.json`;

    const inputSchema: JsonSchema = bundle(
      {
        $schema: DIALECT,
        $id: toolUrn(tool.name, "input"),
        title: `${tool.name} — arguments`,
        description: tool.description,
        ...render(tool.input, "input")
      },
      commons,
      records
    );
    const outputSchema: JsonSchema = bundle(
      {
        $schema: DIALECT,
        $id: toolUrn(tool.name, "output"),
        title: `${tool.name} — result`,
        description: tool.description,
        ...render(tool.output, "output")
      },
      commons,
      records
    );

    assertStrictness(inputSchema, "input", inputPath);
    assertNoRecordRefs(inputSchema, inputPath);
    assertStrictness(outputSchema, "output", outputPath);
    assertReservedOther(outputSchema, outputPath);
    assertSelfContained(inputSchema, inputPath);
    assertSelfContained(outputSchema, outputPath);

    documents.push({ path: inputPath, schema: inputSchema });
    documents.push({ path: outputPath, schema: outputSchema });

    tools.push({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      input_schema: inputPath,
      output_schema: outputPath,
      input_schema_id: toolUrn(tool.name, "input"),
      output_schema_id: toolUrn(tool.name, "output"),
      annotations: { ...tool.annotations },
      // Stamped, never authored. Every result in this revision varies by
      // credential, because policy filtering varies by credential — a shared
      // cache would hand one consumer's permitted view to another. Authoring
      // this per tool is how one of them ends up `public` by accident.
      cache: { ttl_ms: tool.cache_ttl_ms, cache_scope: "private" },
      requires_capabilities: [...tool.requires_capabilities],
      deprecation: null
    });
  }

  assertToolOrder(tools);

  const manifest: ContractManifest = {
    contract_revision: CONTRACT_REVISION,
    protocol_version: CONTRACT_PROTOCOL_VERSION,
    plane: "consumer",
    policy_document: CONTRACT_POLICY_DOCUMENT,
    generated_by: "packages/atlas-contract/src/generate.ts",
    limits: CONTRACT_LIMITS,
    history: CONTRACT_HISTORY,
    common_schemas: { input: "common.input.json", output: "common.output.json" },
    common_schema_ids: { input: commonUrn("input"), output: commonUrn("output") },
    record_schemas: recordEntries,
    tools,
    deprecations: []
  };

  return { manifest, documents };
}

// ---------------------------------------------------------------------------
// bundling
// ---------------------------------------------------------------------------

/**
 * Make one tool document resolvable with nothing but itself.
 *
 * The wire hands a consumer exactly one document per tool, and the MCP protocol
 * (2026-07-28, "$ref Resolution") forbids that consumer from dereferencing
 * anything outside it: a validator compiles each `tools/list` entry in
 * isolation, and an unresolved external `$ref` is a rejection, not a skip. A
 * cross-document `$ref` that is not carried inside the document is therefore
 * unresolvable BY CONSTRUCTION for every conforming client — which is exactly
 * how every consumer-plane call failed from the MCP SDK's own client while the
 * server, holding all the documents, validated the same bytes happily.
 *
 * So the generator embeds each tool document's transitive closure — the shared
 * definitions and record documents its `$ref`s reach — under the document's own
 * `$defs`, each copy keeping its original `$id`. No `$ref` string changes:
 * a `urn:` reference now resolves to the embedded schema resource, which is the
 * standard JSON Schema 2020-12 bundling process, and the URN scheme keeps its
 * security property (nothing here is fetchable over a network, embedded or
 * not).
 *
 * Closure is computed per tool rather than embedding the whole common corpus,
 * for the same reason `commonDocument` emits only what each side can reference:
 * an embedded definition nothing reaches is published, reviewed by nobody, and
 * reads as authoritative to whoever finds it.
 */
function bundle(
  schema: JsonSchema,
  commons: Record<Position, JsonSchema>,
  records: Partial<Record<RecordSchemaName, JsonSchema>>
): JsonSchema {
  const neededDefs: Record<Position, Set<string>> = { input: new Set(), output: new Set() };
  const neededRecords = new Set<RecordSchemaName>();

  const commonDefs = (position: Position): Record<string, JsonSchema> =>
    commons[position]["$defs"] as Record<string, JsonSchema>;

  const visit = (node: JsonSchema): void => {
    walk(node, (child) => {
      const ref = child["$ref"];
      if (typeof ref !== "string" || ref.startsWith("#")) return;
      for (const position of ["input", "output"] as const) {
        const prefix = `${commonUrn(position)}#/$defs/`;
        if (!ref.startsWith(prefix)) continue;
        const name = ref.slice(prefix.length);
        if (neededDefs[position].has(name)) return;
        const definition = commonDefs(position)[name];
        if (!definition) throw new Error(`$ref ${ref} names no published shared definition`);
        neededDefs[position].add(name);
        visit(definition);
        return;
      }
      const recordPrefix = `${CONTRACT_URN_PREFIX}:record:`;
      if (ref.startsWith(recordPrefix)) {
        const name = ref.slice(recordPrefix.length) as RecordSchemaName;
        if (neededRecords.has(name)) return;
        const document = records[name];
        if (!document) throw new Error(`$ref ${ref} names no published record schema`);
        neededRecords.add(name);
        visit(document);
        return;
      }
      throw new Error(`$ref ${ref} is neither a shared definition nor a record schema; nothing can bundle it`);
    });
  };

  visit(schema);

  const embedded: Record<string, JsonSchema> = {};
  for (const position of ["input", "output"] as const) {
    if (neededDefs[position].size === 0) continue;
    const defs: Record<string, JsonSchema> = {};
    for (const name of [...neededDefs[position]].sort()) {
      const definition = commonDefs(position)[name];
      if (definition) defs[name] = definition;
    }
    embedded[commonUrn(position)] = { $id: commonUrn(position), $defs: defs };
  }
  for (const name of RECORD_SCHEMAS) {
    if (!neededRecords.has(name)) continue;
    const document = records[name];
    if (!document) continue;
    // The embedded copy keeps its `$id` (that is what the `$ref`s resolve to)
    // and drops `$schema`: an embedded resource with no dialect declaration
    // inherits the root document's, which is the same one.
    const { $schema: _dialect, ...body } = document;
    embedded[recordUrn(name)] = body;
  }

  return Object.keys(embedded).length === 0 ? schema : { ...schema, $defs: embedded };
}

// ---------------------------------------------------------------------------
// enforcement
// ---------------------------------------------------------------------------

/**
 * Keywords whose values are themselves schemas. Walking only these avoids
 * mistaking a `properties` map's KEY for a schema, or descending into a
 * `default`/`example` value that happens to look like one.
 */
const SCHEMA_VALUED = ["items", "if", "then", "else", "not", "additionalProperties", "contains"] as const;
const SCHEMA_MAPS = ["properties", "$defs", "patternProperties", "definitions"] as const;
const SCHEMA_LISTS = ["allOf", "anyOf", "oneOf", "prefixItems"] as const;

function walk(schema: JsonSchema, visit: (node: JsonSchema, pointer: string) => void, pointer = "#"): void {
  visit(schema, pointer);
  for (const keyword of SCHEMA_VALUED) {
    const child = schema[keyword];
    if (isSchema(child)) walk(child, visit, `${pointer}/${keyword}`);
  }
  for (const keyword of SCHEMA_MAPS) {
    const map = schema[keyword];
    if (isSchema(map)) {
      for (const [name, child] of Object.entries(map)) {
        if (isSchema(child)) walk(child, visit, `${pointer}/${keyword}/${name}`);
      }
    }
  }
  for (const keyword of SCHEMA_LISTS) {
    const list = schema[keyword];
    if (Array.isArray(list)) {
      list.forEach((child, index) => {
        if (isSchema(child)) walk(child, visit, `${pointer}/${keyword}/${index}`);
      });
    }
  }
}

function isSchema(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertStrictness(schema: JsonSchema, position: Position, path: string): void {
  walk(schema, (node, pointer) => {
    if (node["type"] !== "object") return;
    const additional = node["additionalProperties"];
    if (position === "input" && additional !== false) {
      throw new Error(
        `${path} ${pointer}: an input object must be closed (additionalProperties:false), found ${JSON.stringify(additional)}`
      );
    }
    if (position === "output" && additional !== undefined) {
      throw new Error(
        `${path} ${pointer}: an output object must leave additionalProperties unconstrained, found ${JSON.stringify(additional)}`
      );
    }
  });
}

/**
 * Every `$ref` in a published tool document resolves within that document:
 * a same-document pointer, or a URN naming a resource embedded under the
 * document's own `$defs` (and, for a pointer fragment, the named definition on
 * that resource). Re-checked on the emitted JSON for the same reason
 * `assertStrictness` is: `bundle()` applies the rule, and a rule checked only
 * where it is applied has one point of failure.
 */
export function assertSelfContained(schema: JsonSchema, path: string): void {
  const resources = new Map<string, JsonSchema>();
  const rootId = schema["$id"];
  if (typeof rootId === "string") resources.set(rootId, schema);
  const defs = schema["$defs"];
  if (isSchema(defs)) {
    for (const embedded of Object.values(defs)) {
      if (isSchema(embedded) && typeof embedded["$id"] === "string") {
        resources.set(embedded["$id"], embedded);
      }
    }
  }

  walk(schema, (node, pointer) => {
    const ref = node["$ref"];
    if (typeof ref !== "string" || ref.startsWith("#")) return;
    const [base = "", fragment = ""] = ref.split("#");
    const resource = resources.get(base);
    if (!resource) {
      throw new Error(`${path} ${pointer}: $ref ${ref} resolves to no resource embedded in the document`);
    }
    if (fragment.startsWith("/$defs/")) {
      const name = fragment.slice("/$defs/".length);
      const embeddedDefs = resource["$defs"];
      if (!isSchema(embeddedDefs) || !isSchema(embeddedDefs[name])) {
        throw new Error(`${path} ${pointer}: $ref ${ref} names no definition on the embedded resource`);
      }
    }
  });
}

export function assertNoRecordRefs(schema: JsonSchema, path: string): void {
  walk(schema, (node, pointer) => {
    const target = node["$ref"];
    if (typeof target === "string" && target.includes(":record:")) {
      throw new Error(`${path} ${pointer}: input schemas may not reference a record schema (${target})`);
    }
  });
}

/**
 * Every closed enum in an output document reserves `other`.
 *
 * Without it, adding a member to an output enum breaks every strict consumer,
 * so Atlas could never name a new kind of thing without a major version. With
 * it, a 2026 consumer receiving a 2031 record sees `other` and knows precisely
 * that it is looking at something it does not understand — rather than silently
 * misreading it as something it does.
 *
 * A set that genuinely cannot grow says so with `x-atlas-frozen-reason`, which
 * is published, so skipping the convention is visible in the artifact rather
 * than only in the source.
 */
export function assertReservedOther(schema: JsonSchema, path: string): void {
  walk(schema, (node, pointer) => {
    const values = node["enum"];
    if (!Array.isArray(values)) return;
    if (values.includes("other")) return;
    if (typeof node["x-atlas-frozen-reason"] === "string") return;
    throw new Error(
      `${path} ${pointer}: output enum ${JSON.stringify(values)} reserves no "other" and states no frozen reason`
    );
  });
}

function assertToolOrder(tools: readonly ManifestTool[]): void {
  const emitted = tools.map((tool) => tool.name);
  const expected = [...CONTRACT_TOOL_NAMES];
  if (emitted.length !== expected.length || emitted.some((name, index) => name !== expected[index])) {
    throw new Error(
      // Deterministic ordering is what makes a diff of two tools/list responses
      // mean something. An order that depends on object iteration is an order
      // that changes for reasons nobody can name.
      `manifest tool order drifted from CONTRACT_TOOL_NAMES:\n  emitted: ${emitted.join(", ")}\n  expected: ${expected.join(", ")}`
    );
  }
}

/** Deterministic bytes: two-space indent and a trailing newline, always. */
export function serialize(schema: JsonSchema | ContractManifest): string {
  return `${JSON.stringify(schema, null, 2)}\n`;
}
