import { describe, expect, it } from "vitest";
import {
  AliasRowSchema,
  AssertionKindSchema,
  AssertionSchema,
  ConfidenceBandSchema,
  EntitySchema,
  EntityTypeSchema,
  EvidenceLinkSchema,
  LineageActionSchema,
  ProvenanceSchema,
  RecordedAtFidelitySchema,
  RecordedAtSchema,
  WorldTimePointSchema,
  type IdentityDecisionRefusal,
  type ResolutionRefusal
} from "@living-atlas/atlas-core";
import { loadContract, schemaDirectory } from "./manifest.js";
import { CONTRACT_REVISION } from "./revision.js";
import { RECORD_SAMPLES } from "./samples.js";
import { createContractValidator } from "./validator.js";
import { SEED_ERROR_CODES } from "./vocabulary.js";
import { packageRoot } from "./write-schemas.js";
import type { JsonSchema } from "./shape.js";

/**
 * The contract and the model are two descriptions of one thing, and the only
 * question that matters about a published contract is whether it still
 * describes what the store actually does.
 *
 * These tests fail when `@living-atlas/atlas-core` and the published schemas
 * disagree — which is the drift that turns a contract into documentation.
 */

const contract = loadContract(schemaDirectory(packageRoot(), CONTRACT_REVISION));
const validator = createContractValidator(contract);

function at<T>(items: Record<string, T>, key: string): T {
  const value = items[key];
  if (value === undefined) throw new Error(`no entry for ${key}`);
  return value;
}

function toolSchema(name: string, position: "input" | "output"): JsonSchema {
  const tool = contract.tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`no published tool ${name}`);
  return position === "input" ? tool.inputSchema : tool.outputSchema;
}

function properties(schema: JsonSchema): Record<string, JsonSchema> {
  return (schema["properties"] ?? {}) as Record<string, JsonSchema>;
}

/** Follow `#/$defs/x` refs into the common document for the given position. */
function resolve(schema: JsonSchema, position: "input" | "output"): JsonSchema {
  const target = schema["$ref"];
  if (typeof target !== "string") return schema;
  const common = at(contract.common, contract.manifest.common_schema_ids[position]);
  const name = target.split("#/$defs/")[1];
  if (name === undefined) throw new Error(`cannot resolve ${target} as a common $def`);
  return at(common["$defs"] as Record<string, JsonSchema>, name);
}

function enumValues(schema: JsonSchema): string[] {
  const values = schema["enum"];
  if (!Array.isArray(values)) throw new Error(`not an enum: ${JSON.stringify(schema).slice(0, 120)}`);
  return values as string[];
}

const assertionRecord = at(contract.records, "urn:living-atlas:contract:2026.08.0:record:atlas.assertion:v1");
const entityRecord = at(contract.records, "urn:living-atlas:contract:2026.08.0:record:atlas.entity:v1");

describe("published output enums match the model's enums", () => {
  it("carries every member atlas-core defines, `other` included", () => {
    const cases: [string, string[], string[]][] = [
      ["assertion.kind", enumValues(at(properties(assertionRecord), "kind")), [...AssertionKindSchema.options]],
      [
        "assertion.lineage_action",
        enumValues(at(properties(assertionRecord), "lineage_action")),
        [...LineageActionSchema.options]
      ],
      ["entity.type", enumValues(at(properties(entityRecord), "type")), [...EntityTypeSchema.options]],
      [
        "confidence.band",
        enumValues(at(properties(resolve(at(properties(assertionRecord), "confidence"), "output")), "band")),
        [...ConfidenceBandSchema.options]
      ],
      [
        "provenance.origin",
        enumValues(at(properties(resolve(at(properties(assertionRecord), "provenance"), "output")), "origin")),
        [...ProvenanceSchema.shape.origin.options]
      ],
      [
        "provenance.recorded_at_fidelity",
        enumValues(
          at(properties(resolve(at(properties(assertionRecord), "provenance"), "output")), "recorded_at_fidelity")
        ),
        // The only core enum with no `other`; the renderer adds it on the
        // output side, which is exactly the reservation this contract promises.
        [...RecordedAtFidelitySchema.options, "other"]
      ],
      [
        "evidence_link.stance",
        enumValues(
          at(
            properties(resolve(at(properties(assertionRecord), "evidence_links")["items"] as JsonSchema, "output")),
            "stance"
          )
        ),
        [...EvidenceLinkSchema.shape.stance.options]
      ]
    ];

    for (const [label, published, core] of cases) {
      expect(`${label}: ${[...published].sort().join(",")}`).toBe(`${label}: ${[...core].sort().join(",")}`);
    }
  });

  it("matches the alias ledger's dispositions on entity.resolve", () => {
    const resolutions = at(properties(toolSchema("atlas.entity.resolve.v1", "output")), "resolutions");
    const item = resolutions["items"] as JsonSchema;
    const published = enumValues(at(properties(item), "disposition"));
    const core = AliasRowSchema.options.map((option) => option.shape.disposition.value);
    expect([...published].sort()).toEqual([...core].sort());
  });
});

describe("published input enums are the model's enums minus the reserved member", () => {
  it("never lets a caller propose an uninterpretable kind or lineage action", () => {
    // `other` on an input is a value the server has to invent a meaning for.
    // Accepting it would commit an assertion nobody can read back correctly.
    const draft = resolve(
      at(properties(toolSchema("atlas.assertion.propose.v1", "input")), "proposals")["items"] as JsonSchema,
      "input"
    );
    expect(enumValues(at(properties(draft), "kind"))).toEqual(
      AssertionKindSchema.options.filter((value) => value !== "other")
    );
    expect(enumValues(at(properties(draft), "lineage_action"))).toEqual(
      LineageActionSchema.options.filter((value) => value !== "other")
    );
  });
});

describe("published patterns accept exactly what the model accepts", () => {
  const assertionSample = RECORD_SAMPLES["atlas.assertion:v1"] as Record<string, unknown>;
  const entitySample = RECORD_SAMPLES["atlas.entity:v1"] as Record<string, unknown>;

  it("agrees with the model on belief-time instants", () => {
    // The whole point of the narrower type: an offset-bearing timestamp string-
    // sorts wrong even when it names the same instant, and belief time is
    // ordered by string comparison in the change feed.
    const probes = [
      "2026-08-04T12:00:00.000Z",
      "2026-08-04T12:00:00Z",
      "2026-08-04T12:00:00.000000Z",
      "2026-08-04T12:00:00.000+05:00",
      "2026-08-04 12:00:00.000Z",
      "not-a-time",
      ""
    ];
    for (const probe of probes) {
      const byModel = RecordedAtSchema.safeParse(probe).success;
      const byContract = validator.validateRecord("atlas.assertion:v1", { ...assertionSample, recorded_at: probe }).valid;
      expect(`${probe || "<empty>"}: contract=${byContract}`).toBe(`${probe || "<empty>"}: contract=${byModel}`);
    }
  });

  const WORLD_TIME_PROBES: unknown[] = [
    { kind: "unknown" },
    { kind: "exact", value: "2019" },
    { kind: "exact", value: "2019-03" },
    { kind: "approximate", value: "2019-03-15" },
    // `unknown` carries no value. The prior store mapped it to the string
    // "9999", so an unknown start sorted to the far future and silently
    // satisfied every "before X" filter.
    { kind: "unknown", value: "9999" },
    { kind: "exact" },
    { kind: "other", value: "2019" },
    { kind: "exact", value: "19" },
    { kind: "exact", value: "2019-3" }
  ];

  function draftWith(point: unknown): unknown {
    return {
      idempotency_key: "fixture-parity",
      proposals: [
        {
          kind: "fact",
          subject_entity_id: entitySample["entity_id"],
          predicate: "based-in",
          valid_from: point,
          confidence: { band: "high" },
          evidence_links: [{ evidence_id: "e", stance: "supports" }]
        }
      ]
    };
  }

  it("agrees with the model exactly on world-time points a CALLER may supply", () => {
    // Input objects are sealed, so this is exact agreement — including the
    // "9999" case, which the contract must refuse at the door rather than
    // accept and let the store reject later with a less specific message.
    for (const probe of WORLD_TIME_PROBES) {
      const byModel = WorldTimePointSchema.safeParse(probe).success;
      const byContract = validator.validateToolInput("atlas.assertion.propose.v1", draftWith(probe)).valid;
      const label = JSON.stringify(probe);
      expect(`${label}: contract=${byContract}`).toBe(`${label}: contract=${byModel}`);
    }
  });

  it("accepts, on OUTPUT, everything the model can produce — and is deliberately no stricter", () => {
    // Output objects are open so a field added later stays additive, and the
    // price is exact: an output schema cannot reject an unexpected property.
    // `{kind:"unknown", value:"9999"}` therefore validates here while the model
    // refuses to construct one. That asymmetry is the design, not a gap: what
    // guarantees Atlas never EMITS such a record is the model's strictness, and
    // what guarantees a consumer keeps working in 2031 is this schema's
    // openness. Asserting one-way containment says so out loud.
    for (const probe of WORLD_TIME_PROBES) {
      const byModel = WorldTimePointSchema.safeParse(probe).success;
      const byContract = validator.validateRecord("atlas.assertion:v1", { ...assertionSample, valid_from: probe }).valid;
      const label = JSON.stringify(probe);
      if (byModel) expect(`${label}: contract accepts ${byContract}`).toBe(`${label}: contract accepts true`);
    }

    // Openness reaches extra properties only. A wrong DISCRIMINATOR or a
    // malformed value is still refused on output, which is what keeps the
    // schema worth validating against at all.
    for (const rejected of [{ kind: "other", value: "2019" }, { kind: "exact" }, { kind: "exact", value: "19" }]) {
      expect(
        `${JSON.stringify(rejected)}: ${validator.validateRecord("atlas.assertion:v1", { ...assertionSample, valid_from: rejected }).valid}`
      ).toBe(`${JSON.stringify(rejected)}: false`);
    }
  });

  it("agrees with the model on minted id shapes", () => {
    const probes = [
      "la_entity_01k3zj9m00abcdefghjkmnpqrs",
      "la_entity_01k3zj9m00abcdefghjkmnpqr",
      "la_entity_01K3ZJ9M00ABCDEFGHJKMNPQRS",
      "la_assertion_01k3zj9m00abcdefghjkmnpqrs",
      "legacy-object-0001"
    ];
    for (const probe of probes) {
      const byModel = EntitySchema.shape.entity_id.safeParse(probe).success;
      const byContract = validator.validateRecord("atlas.entity:v1", { ...entitySample, entity_id: probe }).valid;
      expect(`${probe}: contract=${byContract}`).toBe(`${probe}: contract=${byModel}`);
    }
  });
});

describe("published record samples are records the model can produce", () => {
  it("parses the assertion sample with the model's own strict schema", () => {
    // The published sample carries two read-context fields the stored record
    // does not have. Stripping them and parsing with a `.strict()` schema is
    // what proves the rest of the sample is a genuine record shape rather than
    // a plausible-looking one.
    const { valid_time_fidelity, match_quality, ...stored } = RECORD_SAMPLES["atlas.assertion:v1"] as Record<
      string,
      unknown
    >;
    expect(valid_time_fidelity).toBeDefined();
    expect(match_quality).toBeDefined();
    expect(AssertionSchema.safeParse(stored).success).toBe(true);
  });

  it("parses the entity sample with the model's own strict schema", () => {
    expect(EntitySchema.safeParse(RECORD_SAMPLES["atlas.entity:v1"]).success).toBe(true);
  });
});

describe("published error codes cover the model's refusals", () => {
  const published = new Set(SEED_ERROR_CODES.map((entry) => entry.code));

  /**
   * A compile-time gate, not a runtime one. If atlas-core grows a refusal code
   * that the contract does not publish, this object stops type-checking and
   * `npm run check` fails at `tsc` — before any test runs and before a consumer
   * can receive a code no registry describes.
   */
  const CORE_RESOLUTION_CODES: Record<ResolutionRefusal["code"], true> = {
    "unknown-id": true,
    "redirect-cycle": true,
    "redirect-chain-too-long": true,
    "redirect-dangling": true,
    "ambiguous-split": true,
    "not-carried-forward": true
  };

  /**
   * Identity DECISIONS are operator-plane operations, so their refusals are not
   * consumer-facing and are deliberately absent from the consumer registry.
   * Listing them here still forces a decision when core adds one: either it is
   * consumer-visible and belongs in the registry, or it is named here as
   * operator-only. Silence is what lets a code appear on the wire undescribed.
   */
  const OPERATOR_ONLY_CODES: Record<IdentityDecisionRefusal["code"], true> = {
    "alias-already-redirected": true,
    "merge-into-self": true,
    "merge-would-create-cycle": true,
    "merge-target-unresolvable": true,
    "resolution-subject-unresolvable": true,
    "resolution-recorder-required": true,
    "resolution-assertion-failed": true,
    "split-needs-two-candidates": true
  };

  it("publishes every resolution refusal the registry can return", () => {
    for (const code of Object.keys(CORE_RESOLUTION_CODES)) {
      expect(`${code} published: ${published.has(code)}`).toBe(`${code} published: true`);
    }
  });

  it("keeps operator-plane refusals out of the consumer registry", () => {
    for (const code of Object.keys(OPERATOR_ONLY_CODES)) {
      expect(`${code} published: ${published.has(code)}`).toBe(`${code} published: false`);
    }
  });

  it("offers every resolution refusal as an outcome on entity.resolve", () => {
    const resolutions = at(properties(toolSchema("atlas.entity.resolve.v1", "output")), "resolutions");
    const outcomes = new Set(enumValues(at(properties(resolutions["items"] as JsonSchema), "outcome")));
    expect(outcomes.has("resolved")).toBe(true);
    for (const code of Object.keys(CORE_RESOLUTION_CODES)) {
      expect(`${code} reachable: ${outcomes.has(code)}`).toBe(`${code} reachable: true`);
    }
  });

  it("maps the protocol refusals onto their JSON-RPC codes", () => {
    const byCode = new Map(SEED_ERROR_CODES.map((entry) => [entry.code, entry]));
    expect(byCode.get("capability-required")?.jsonrpc_code).toBe(-32021);
    expect(byCode.get("unsupported-protocol-version")?.jsonrpc_code).toBe(-32022);
    expect(byCode.get("invalid-argument")?.jsonrpc_code).toBe(-32602);
  });
});
