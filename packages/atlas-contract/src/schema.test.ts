import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertNoRecordRefs,
  assertReservedOther,
  assertStrictness,
  generateContract,
  serialize
} from "./generate.js";
import { loadContract, schemaDirectory } from "./manifest.js";
import { recordUrn } from "./shape.js";
import { CONTRACT_LIMITS, CONTRACT_REVISION, CONTRACT_TOOL_NAMES, RECORD_SCHEMAS } from "./revision.js";
import { RECORD_SAMPLES, TOOL_INPUT_SAMPLES } from "./samples.js";
import { createContractValidator } from "./validator.js";
import { packageRoot } from "./write-schemas.js";
import type { JsonSchema } from "./shape.js";

const ROOT = packageRoot();
const PUBLISHED = schemaDirectory(ROOT, CONTRACT_REVISION);
const contract = loadContract(PUBLISHED);
const validator = createContractValidator(contract);

/** `noUncheckedIndexedAccess` is on; a missing fixture must fail loudly, not as undefined. */
function at<T>(items: Record<string, T> | Map<string, T>, key: string): T {
  const value = items instanceof Map ? items.get(key) : items[key];
  if (value === undefined) throw new Error(`no entry for ${key}`);
  return value;
}

/** Every subschema in a document, including the document itself. */
function subschemas(schema: JsonSchema, pointer = "#"): [string, JsonSchema][] {
  const found: [string, JsonSchema][] = [[pointer, schema]];
  const descend = (child: unknown, next: string): void => {
    if (typeof child === "object" && child !== null && !Array.isArray(child)) {
      found.push(...subschemas(child as JsonSchema, next));
    }
  };
  for (const keyword of ["items", "if", "then", "else", "not", "additionalProperties", "contains"]) {
    descend(schema[keyword], `${pointer}/${keyword}`);
  }
  for (const keyword of ["properties", "$defs", "patternProperties"]) {
    const map = schema[keyword];
    if (typeof map === "object" && map !== null && !Array.isArray(map)) {
      for (const [name, child] of Object.entries(map)) descend(child, `${pointer}/${keyword}/${name}`);
    }
  }
  for (const keyword of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
    const list = schema[keyword];
    if (Array.isArray(list)) list.forEach((child, index) => descend(child, `${pointer}/${keyword}/${index}`));
  }
  return found;
}

describe("published schema documents", () => {
  it("publishes exactly the fourteen consumer tools, in contract order", () => {
    expect(contract.tools.map((tool) => tool.name)).toEqual([...CONTRACT_TOOL_NAMES]);
    expect(contract.tools).toHaveLength(14);
  });

  it("is valid JSON Schema 2020-12, checked against the metaschema itself", () => {
    expect(validator.validateAgainstMetaschema()).toEqual({ valid: true });
  });

  it("resolves every $ref locally, with no network dereference possible", () => {
    // Compiling is the proof: Ajv is constructed with no `loadSchema`, so an
    // unresolved reference throws rather than being fetched or skipped. This
    // asserts the other half — that no published $ref even names a fetchable
    // scheme, so the guarantee does not depend on the validator's config.
    const documents: JsonSchema[] = [
      ...Object.values(contract.common),
      ...Object.values(contract.records),
      ...contract.tools.flatMap((tool) => [tool.inputSchema, tool.outputSchema])
    ];
    const refs = documents
      .flatMap((document) => subschemas(document))
      .map(([, node]) => node["$ref"])
      .filter((value): value is string => typeof value === "string");

    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref.startsWith("urn:living-atlas:contract:")).toBe(true);
      expect(ref).not.toMatch(/^https?:/);
    }
  });

  it("declares an outputSchema for every tool", () => {
    for (const tool of contract.tools) {
      expect(tool.outputSchema["$id"]).toBe(tool.output_schema_id);
      expect(tool.outputSchema["type"]).toBe("object");
    }
  });

  it("stays byte-identical to what the generator emits", () => {
    // The committed bytes are the published artifact and must be reviewable in
    // a diff. Regenerating in memory and comparing is what makes "authored
    // once" true rather than aspirational: if the catalog and the published
    // files ever disagree, this names the file.
    const { manifest, documents } = generateContract();
    for (const document of documents) {
      const onDisk = readFileSync(join(PUBLISHED, document.path), "utf8");
      expect(`${document.path}:\n${onDisk}`).toEqual(`${document.path}:\n${serialize(document.schema)}`);
    }
    expect(readFileSync(join(PUBLISHED, "manifest.json"), "utf8")).toEqual(serialize(manifest));
  });
});

describe("asymmetric strictness", () => {
  it("closes every object in every published input schema", () => {
    for (const tool of contract.tools) {
      const objects = subschemas(tool.inputSchema).filter(([, node]) => node["type"] === "object");
      expect(objects.length).toBeGreaterThan(0);
      for (const [pointer, node] of objects) {
        expect(`${tool.name}${pointer}: ${JSON.stringify(node["additionalProperties"])}`).toBe(
          `${tool.name}${pointer}: false`
        );
      }
    }
    const commonInput = at(contract.common, contract.manifest.common_schema_ids.input);
    for (const [pointer, node] of subschemas(commonInput)) {
      if (node["type"] !== "object") continue;
      expect(`common.input${pointer}: ${JSON.stringify(node["additionalProperties"])}`).toBe(
        `common.input${pointer}: false`
      );
    }
  });

  it("leaves every object in every published output schema open", () => {
    const outputs: [string, JsonSchema][] = [
      ...contract.tools.map((tool): [string, JsonSchema] => [tool.name, tool.outputSchema]),
      ...Object.entries(contract.records),
      [contract.manifest.common_schema_ids.output, at(contract.common, contract.manifest.common_schema_ids.output)]
    ];
    for (const [label, document] of outputs) {
      const objects = subschemas(document).filter(([, node]) => node["type"] === "object");
      expect(objects.length).toBeGreaterThan(0);
      for (const [pointer, node] of objects) {
        expect(`${label}${pointer}: ${JSON.stringify(node["additionalProperties"])}`).toBe(
          `${label}${pointer}: undefined`
        );
      }
    }
  });

  it("rejects an unknown argument and accepts an unknown result field", () => {
    // The asymmetry, demonstrated rather than inspected. A typo'd `as_of_recored`
    // must not be silently ignored — ignoring it returns the present when the
    // caller asked for the past, and that answer is confidently wrong.
    const typo = validator.validateToolInput("atlas.assertion.query.v1", { as_of_recored: "2026-08-04T12:00:00.000Z" });
    expect(typo.valid).toBe(false);

    const sample = { ...(RECORD_SAMPLES["atlas.horizon:v1"] as Record<string, unknown>), field_added_in_2031: true };
    expect(validator.validateRecord("atlas.horizon:v1", sample)).toEqual({ valid: true });
  });

  it("refuses to generate an input schema that references a record schema", () => {
    // Records carry minted authority — ids, seq, recorded_at, claim_digest,
    // provenance.client_id. Reusing the output shape on the input side is how a
    // caller ends up able to supply one.
    expect(() =>
      assertNoRecordRefs({ properties: { smuggled: { $ref: recordUrn("atlas.assertion:v1") } } }, "probe")
    ).toThrow(/may not reference a record schema/);
  });

  it("refuses an input object the renderer left open, and an output object it closed", () => {
    expect(() => assertStrictness({ type: "object", properties: {} }, "input", "probe")).toThrow(/must be closed/);
    expect(() =>
      assertStrictness({ type: "object", properties: {}, additionalProperties: false }, "output", "probe")
    ).toThrow(/unconstrained/);
  });
});

describe("closed enums and open vocabularies", () => {
  it("reserves `other` in every closed enum of every output document", () => {
    const documents: [string, JsonSchema][] = [
      ...contract.tools.map((tool): [string, JsonSchema] => [tool.name, tool.outputSchema]),
      ...Object.entries(contract.records),
      [contract.manifest.common_schema_ids.output, at(contract.common, contract.manifest.common_schema_ids.output)]
    ];
    let checked = 0;
    for (const [label, document] of documents) {
      for (const [pointer, node] of subschemas(document)) {
        const values = node["enum"];
        if (!Array.isArray(values)) continue;
        checked += 1;
        if (typeof node["x-atlas-frozen-reason"] === "string") continue;
        expect(`${label}${pointer}: ${JSON.stringify(values)}`).toContain('"other"');
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  it("never reserves `other` in an input enum", () => {
    // An input enum member the server has to invent a meaning for is worse than
    // an absent one: the caller gets an accept for a request nobody defined.
    for (const tool of contract.tools) {
      for (const [pointer, node] of subschemas(tool.inputSchema)) {
        const values = node["enum"];
        if (Array.isArray(values)) {
          expect(`${tool.name}${pointer}: ${JSON.stringify(values)}`).not.toContain('"other"');
        }
      }
    }
  });

  it("carries a published rationale wherever a closed set skips `other`", () => {
    const frozen = subschemas(at(contract.common, contract.manifest.common_schema_ids.output)).filter(
      ([, node]) => typeof node["x-atlas-frozen-reason"] === "string"
    );
    expect(frozen.length).toBeGreaterThan(0);
    for (const [, node] of frozen) {
      expect(String(node["x-atlas-frozen-reason"]).length).toBeGreaterThan(40);
    }
  });

  it("leaves open vocabularies as strings that name their live registry", () => {
    // A predicate the owner records tomorrow must not fail a consumer's
    // validator today. The registry is served, not frozen into the schema.
    const assertion = at(contract.records, recordUrn("atlas.assertion:v1"));
    const properties = assertion["properties"] as Record<string, JsonSchema>;
    expect(at(properties, "predicate")["$ref"]).toBe(
      `${contract.manifest.common_schema_ids.output}#/$defs/predicate`
    );

    const commonOutput = at(contract.common, contract.manifest.common_schema_ids.output);
    const predicate = at(commonOutput["$defs"] as Record<string, JsonSchema>, "predicate");
    expect(predicate["type"]).toBe("string");
    expect(predicate["enum"]).toBeUndefined();
    expect(Array.isArray(predicate["x-atlas-known-values"])).toBe(true);
    expect(predicate["x-atlas-registry-tool"]).toBe("atlas.contract.describe.v1");

    expect(validator.validateRecord("atlas.assertion:v1", {
      ...(RECORD_SAMPLES["atlas.assertion:v1"] as Record<string, unknown>),
      predicate: "a-predicate-invented-after-this-revision-shipped"
    })).toEqual({ valid: true });
  });

  it("rejects an assertion whose closed `kind` is outside the published set", () => {
    expect(
      validator.validateRecord("atlas.assertion:v1", {
        ...(RECORD_SAMPLES["atlas.assertion:v1"] as Record<string, unknown>),
        kind: "not-a-kind"
      }).valid
    ).toBe(false);
  });
});

describe("record samples", () => {
  it("validates one sample of every published record_schema", () => {
    expect(Object.keys(RECORD_SAMPLES).sort()).toEqual([...RECORD_SCHEMAS].sort());
    for (const name of RECORD_SCHEMAS) {
      expect(`${name}: ${JSON.stringify(validator.validateRecord(name, RECORD_SAMPLES[name]))}`).toBe(
        `${name}: {"valid":true}`
      );
    }
  });

  it("requires the frozen record_schema literal on every record", () => {
    for (const name of RECORD_SCHEMAS) {
      const sample = { ...(RECORD_SAMPLES[name] as Record<string, unknown>) };
      delete sample["record_schema"];
      expect(`${name} without record_schema: ${validator.validateRecord(name, sample).valid}`).toBe(
        `${name} without record_schema: false`
      );
      expect(
        validator.validateRecord(name, { ...(RECORD_SAMPLES[name] as Record<string, unknown>), record_schema: "atlas.other:v9" })
          .valid
      ).toBe(false);
    }
  });

  it("accepts a result slot carrying a record_schema this revision never defined", () => {
    // The normative consumer obligation, expressed in the schema: an unknown
    // record kind satisfies the envelope and fails nothing. A `oneOf` over a
    // closed set would make the first record kind added after a consumer pinned
    // this revision reject the entire page.
    const page = {
      results: [
        RECORD_SAMPLES["atlas.assertion:v1"],
        { record_schema: "atlas.speculation:v1", confidence_interval: [0.1, 0.9] }
      ],
      contested: [],
      page: { page_size: 50, has_more: false },
      coverage: {
        evaluated: 2,
        matched: 2,
        returned: 2,
        withheld: 0,
        with_valid_time: 1,
        unknown_or_absent_valid_time: 1,
        counts_basis: "exact"
      },
      horizon: RECORD_SAMPLES["atlas.horizon:v1"],
      cache: { ttl_ms: 0, cache_scope: "private" }
    };
    expect(validator.validateToolOutput("atlas.assertion.query.v1", page)).toEqual({ valid: true });
  });

  it("still validates a KNOWN record kind in full inside a result slot", () => {
    const page = {
      results: [{ ...(RECORD_SAMPLES["atlas.assertion:v1"] as Record<string, unknown>), seq: -1 }],
      contested: [],
      page: { page_size: 50, has_more: false },
      coverage: {
        evaluated: 1,
        matched: 1,
        returned: 1,
        withheld: 0,
        with_valid_time: 1,
        unknown_or_absent_valid_time: 0,
        counts_basis: "exact"
      },
      horizon: RECORD_SAMPLES["atlas.horizon:v1"],
      cache: { ttl_ms: 0, cache_scope: "private" }
    };
    expect(validator.validateToolOutput("atlas.assertion.query.v1", page).valid).toBe(false);
  });
});

describe("tool inputs", () => {
  it("accepts the documented minimal call for every tool", () => {
    for (const tool of contract.tools) {
      const sample = TOOL_INPUT_SAMPLES[tool.name];
      expect(`${tool.name}: ${JSON.stringify(validator.validateToolInput(tool.name, sample))}`).toBe(
        `${tool.name}: {"valid":true}`
      );
    }
  });

  it("refuses a page_size above the published cap on every paged tool", () => {
    const over = CONTRACT_LIMITS.max_page_size + 1;
    for (const name of ["atlas.assertion.query.v1", "atlas.graph.neighbors.v1", "atlas.text.search.v1"] as const) {
      const base = TOOL_INPUT_SAMPLES[name] as Record<string, unknown>;
      expect(`${name} at ${over}: ${validator.validateToolInput(name, { ...base, page_size: over }).valid}`).toBe(
        `${name} at ${over}: false`
      );
    }
  });

  it("refuses a batch above the published cap, on the schema and not only at runtime", () => {
    const proposal = (TOOL_INPUT_SAMPLES["atlas.assertion.propose.v1"] as { proposals: unknown[] }).proposals[0];
    const oversized = {
      idempotency_key: "fixture-key-2",
      proposals: Array.from({ length: CONTRACT_LIMITS.max_batch_items + 1 }, () => proposal)
    };
    expect(validator.validateToolInput("atlas.assertion.propose.v1", oversized).valid).toBe(false);
  });

  it("refuses a proposal that supplies a field Atlas mints at commit", () => {
    // recorded_at, assertion_id, seq, claim_digest and provenance.client_id all
    // carry authority. A caller that can set recorded_at can backdate what
    // Atlas knew, which makes every as-of read unrepeatable.
    for (const smuggled of ["recorded_at", "assertion_id", "seq", "claim_digest", "provenance"]) {
      const input = {
        idempotency_key: "fixture-key-3",
        proposals: [
          {
            kind: "fact",
            subject_entity_id: "la_entity_01k3zj9m00abcdefghjkmnpqrs",
            predicate: "based-in",
            confidence: { band: "high" },
            evidence_links: [{ evidence_id: "e", stance: "supports" }],
            [smuggled]: "anything"
          }
        ]
      };
      expect(`${smuggled}: ${validator.validateToolInput("atlas.assertion.propose.v1", input).valid}`).toBe(
        `${smuggled}: false`
      );
    }
  });

  it("requires at least one evidence link on every proposal", () => {
    const input = {
      idempotency_key: "fixture-key-4",
      proposals: [
        {
          kind: "fact",
          subject_entity_id: "la_entity_01k3zj9m00abcdefghjkmnpqrs",
          predicate: "based-in",
          confidence: { band: "high" },
          evidence_links: []
        }
      ]
    };
    expect(validator.validateToolInput("atlas.assertion.propose.v1", input).valid).toBe(false);
  });
});

describe("transport-invariant limits", () => {
  it("publishes the same caps it compiles into the schemas", () => {
    // The measured defect: LocalBatchMaxItems=100 and RemoteBatchMaxItems=10,
    // so an identical request succeeded on one transport and failed on the
    // other with no way for a caller to discover which limit applied.
    expect(contract.manifest.limits).toEqual(CONTRACT_LIMITS);

    const propose = at(
      contract.tools.reduce<Record<string, JsonSchema>>((acc, tool) => {
        acc[tool.name] = tool.inputSchema;
        return acc;
      }, {}),
      "atlas.assertion.propose.v1"
    );
    const proposals = (propose["properties"] as Record<string, JsonSchema>)["proposals"] as JsonSchema;
    expect(proposals["maxItems"]).toBe(CONTRACT_LIMITS.max_batch_items);
    expect(proposals["maxItems"]).toBe(contract.manifest.limits.max_batch_items);

    // Every paged tool reaches the cap through one shared definition, so the
    // number is written down once rather than once per tool.
    const commonInput = at(contract.common, contract.manifest.common_schema_ids.input);
    const pageSize = at(commonInput["$defs"] as Record<string, JsonSchema>, "page_size");
    expect(pageSize["maximum"]).toBe(CONTRACT_LIMITS.max_page_size);
    expect(pageSize["default"]).toBe(CONTRACT_LIMITS.default_page_size);

    const pagedRef = `${contract.manifest.common_schema_ids.input}#/$defs/page_size`;
    for (const name of [
      "atlas.assertion.query.v1",
      "atlas.graph.neighbors.v1",
      "atlas.text.search.v1"
    ] as const) {
      const tool = contract.tools.find((candidate) => candidate.name === name);
      const properties = (tool?.inputSchema["properties"] ?? {}) as Record<string, JsonSchema>;
      expect(`${name}: ${String(properties["page_size"]?.["$ref"])}`).toBe(`${name}: ${pagedRef}`);
    }
    const feed = contract.tools.find((candidate) => candidate.name === "atlas.changes.read.v1");
    expect(((feed?.inputSchema["properties"] ?? {}) as Record<string, JsonSchema>)["limit"]?.["$ref"]).toBe(pagedRef);
  });

  it("publishes no shared definition that nothing references", () => {
    // An unreferenced $def is published, reviewed by nobody, and reads as
    // authoritative to anyone who finds it — the same failure the loader
    // refuses for an unnamed file, one level down.
    const documents: JsonSchema[] = [
      ...Object.values(contract.common),
      ...Object.values(contract.records),
      ...contract.tools.flatMap((tool) => [tool.inputSchema, tool.outputSchema])
    ];
    const referenced = new Set(
      documents
        .flatMap((document) => subschemas(document))
        .map(([, node]) => node["$ref"])
        .filter((value): value is string => typeof value === "string")
    );
    for (const position of ["input", "output"] as const) {
      const id = contract.manifest.common_schema_ids[position];
      const defs = at(contract.common, id)["$defs"] as Record<string, JsonSchema>;
      for (const name of Object.keys(defs)) {
        expect(`common.${position} ${name} referenced: ${referenced.has(`${id}#/$defs/${name}`)}`).toBe(
          `common.${position} ${name} referenced: true`
        );
      }
    }
  });

  it("marks every credential-varying result private", () => {
    for (const tool of contract.tools) {
      expect(`${tool.name}: ${tool.cache.cache_scope}`).toBe(`${tool.name}: private`);
    }
  });
});

describe("the history block", () => {
  it("reports zero retained prior versions as a number, not a phrase", () => {
    expect(contract.manifest.history.prior_versions_retained_before_cutover).toBe(0);
    expect(typeof contract.manifest.history.prior_versions_retained_before_cutover).toBe("number");
  });

  it("requires bitemporal_since and the zero count in contract.describe's own output", () => {
    const output = at(
      contract.tools.reduce<Record<string, JsonSchema>>((acc, tool) => {
        acc[tool.name] = tool.outputSchema;
        return acc;
      }, {}),
      "atlas.contract.describe.v1"
    );
    const history = (output["properties"] as Record<string, JsonSchema>)["history"] as JsonSchema;
    expect(history["required"]).toContain("prior_versions_retained_before_cutover");
    expect(history["required"]).toContain("bitemporal_since");
  });

  it("refuses a describe result that omits the retained-version count", () => {
    const result = describeResult();
    delete (result["history"] as Record<string, unknown>)["prior_versions_retained_before_cutover"];
    expect(validator.validateToolOutput("atlas.contract.describe.v1", result).valid).toBe(false);
  });

  it("accepts a complete describe result", () => {
    expect(validator.validateToolOutput("atlas.contract.describe.v1", describeResult())).toEqual({ valid: true });
  });
});

function describeResult(): Record<string, unknown> {
  return {
    revision: CONTRACT_REVISION,
    revisions_served: [CONTRACT_REVISION],
    protocol_version: contract.manifest.protocol_version,
    policy_document: contract.manifest.policy_document,
    history: {
      prior_versions_retained_before_cutover: 0,
      bitemporal_since: "2026-08-01T00:00:00.000Z",
      belief_time_meaningful_since_cutover_only: true,
      feed_epoch: "e1",
      retention_floor_seq: 0,
      change_feed_floor_days: CONTRACT_LIMITS.change_feed_floor_days
    },
    limits: { ...CONTRACT_LIMITS },
    record_schemas: contract.manifest.record_schemas.map((entry) => ({
      name: entry.name,
      schema_id: entry.schema_id,
      schema_path: entry.schema
    })),
    tools: contract.tools.map((tool) => ({
      name: tool.name,
      title: tool.title,
      input_schema_id: tool.input_schema_id,
      output_schema_id: tool.output_schema_id,
      requires_capabilities: tool.requires_capabilities,
      deprecation: null
    })),
    vocabularies: {
      predicate: [{ predicate: "employed-by", cardinality: "multi-valued", relational: true }],
      entity_subtype: ["project"],
      error_code: [
        { code: "as-of-before-history-floor", origin: "store", retryable: false, summary: "below the history floor" }
      ]
    },
    deprecations: [],
    cache: { ttl_ms: 300000, cache_scope: "private" }
  };
}
