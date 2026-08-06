import { CONTRACT_URN_PREFIX, RECORD_SCHEMAS, type RecordSchemaName } from "./revision.js";
import { KNOWN_VALUES, type VocabularyName } from "./vocabulary.js";

/**
 * The authoring language for published schemas — and, more importantly, what it
 * deliberately CANNOT express.
 *
 * There is no `additionalProperties` knob anywhere in this file. An author does
 * not choose strictness; the RENDERER assigns it from the position the schema
 * occupies on the wire:
 *
 *   INPUT  schemas are closed  (`additionalProperties: false`) — an argument
 *          Atlas does not understand is a caller mistake, and accepting it
 *          silently means a typo'd `as_of_recored` returns the present instead
 *          of the past. That answer is confidently wrong, which is the whole
 *          class of failure this rewrite exists to end.
 *
 *   OUTPUT schemas are OPEN (`additionalProperties` unconstrained) — adding a
 *          field to a response must be additive, so a consumer pinned to this
 *          revision keeps validating after Atlas starts returning more.
 *
 * The asymmetry has to be structural rather than a convention, because the
 * documented failure is precisely a contract that tells consumers to be lenient
 * while its generators emit strict. Here an author cannot get it wrong: the
 * same authored `Shape`, used on both sides, renders closed on input and open
 * on output.
 *
 * Closed enums work the same way. `enumOf(["assert","correct"])` renders
 * WITHOUT `other` on input and WITH `other` on output. A reserved `other` in an
 * output enum is how a 2026 consumer survives a 2031 member; a reserved `other`
 * in an INPUT enum would be a value the server has to invent a meaning for, so
 * it is never emitted there.
 */

export type JsonSchema = Record<string, unknown>;

/** Which side of the wire a schema is being rendered for. */
export type Position = "input" | "output";

export type Shape =
  | { form: "object"; properties: Record<string, Shape>; required: readonly string[]; description?: string }
  | { form: "array"; items: Shape; minItems?: number; maxItems?: number; description?: string }
  | { form: "enum"; values: readonly string[]; description?: string }
  | { form: "frozenEnum"; values: readonly string[]; reason: string; description?: string }
  | { form: "anyOf"; options: readonly Shape[]; description?: string }
  | { form: "vocabulary"; name: VocabularyName; description?: string }
  | { form: "const"; value: string; description?: string }
  | { form: "scalar"; schema: JsonSchema }
  | { form: "nullable"; inner: Shape }
  | { form: "ref"; def: string; description?: string }
  | { form: "record"; name: RecordSchemaName; description?: string }
  | { form: "taggedUnion"; members: readonly RecordSchemaName[]; description?: string }
  | { form: "anyJson"; description?: string };

// ---------------------------------------------------------------------------
// authoring helpers
// ---------------------------------------------------------------------------

export function obj(
  properties: Record<string, Shape>,
  required: readonly string[] = [],
  description?: string
): Shape {
  for (const name of required) {
    if (!(name in properties)) {
      throw new Error(`required names "${name}", which is not a declared property`);
    }
  }
  return description === undefined
    ? { form: "object", properties, required }
    : { form: "object", properties, required, description };
}

export function arr(items: Shape, bounds: { minItems?: number; maxItems?: number } = {}, description?: string): Shape {
  return { form: "array", items, ...bounds, ...(description === undefined ? {} : { description }) };
}

export function enumOf(values: readonly string[], description?: string): Shape {
  if (values.includes("other")) {
    // `other` is the RENDERER's job on the output side. An author writing it by
    // hand would also put it on the input side, where it means nothing.
    throw new Error("do not author `other` into an enum; the output renderer reserves it");
  }
  return { form: "enum", values, ...(description === undefined ? {} : { description }) };
}

/**
 * An enum that is closed on BOTH sides — no reserved `other`, ever.
 *
 * The `reason` is mandatory because skipping the `other` convention is a
 * decision, and a decision with no stated rationale is indistinguishable from
 * an oversight. The rationale is published as `x-atlas-frozen-reason` so a
 * consumer reading the schema sees why the set cannot grow, and a test asserts
 * that every output enum without `other` carries one.
 *
 * The only legitimate case is a STRUCTURAL discriminator: a new member would
 * mean a new branch shape, not a new label, and a branch with no declared shape
 * is unrepresentable — so reserving a member for it would publish a value that
 * can never validate.
 */
export function frozenEnum(values: readonly string[], reason: string, description?: string): Shape {
  if (reason.trim().length === 0) {
    throw new Error("frozenEnum requires a stated reason for skipping the reserved `other`");
  }
  return { form: "frozenEnum", values, reason, ...(description === undefined ? {} : { description }) };
}

export function anyOfShape(options: readonly Shape[], description?: string): Shape {
  return { form: "anyOf", options, ...(description === undefined ? {} : { description }) };
}

export function vocabulary(name: VocabularyName, description?: string): Shape {
  return { form: "vocabulary", name, ...(description === undefined ? {} : { description }) };
}

export function constant(value: string, description?: string): Shape {
  return { form: "const", value, ...(description === undefined ? {} : { description }) };
}

/**
 * A leaf that is not an object. Guarded, because the strictness walker only
 * recurses through declared forms — an object smuggled in as a raw schema would
 * silently escape both the sealing and the opening pass.
 */
export function scalar(schema: JsonSchema): Shape {
  if (schema["type"] === "object" || "properties" in schema || "additionalProperties" in schema) {
    throw new Error("scalar() cannot carry an object schema; use obj() so strictness is applied");
  }
  return { form: "scalar", schema };
}

export function nullable(inner: Shape): Shape {
  return { form: "nullable", inner };
}

export function ref(def: string, description?: string): Shape {
  return { form: "ref", def, ...(description === undefined ? {} : { description }) };
}

export function record(name: RecordSchemaName, description?: string): Shape {
  return { form: "record", name, ...(description === undefined ? {} : { description }) };
}

export function taggedUnion(members: readonly RecordSchemaName[], description?: string): Shape {
  return { form: "taggedUnion", members, ...(description === undefined ? {} : { description }) };
}

/**
 * Arbitrary JSON. Used only for an assertion's `value`, which is whatever the
 * predicate says it is — the contract cannot type it without also owning the
 * predicate vocabulary, which the graph owns.
 *
 * This is the one hole in input strictness and it is deliberate and named. It
 * is a VALUE, never an envelope, so nothing about the request's meaning hides
 * inside it.
 */
export function anyJson(description?: string): Shape {
  return { form: "anyJson", ...(description === undefined ? {} : { description }) };
}

// ---------------------------------------------------------------------------
// URNs
// ---------------------------------------------------------------------------

export function commonUrn(position: Position): string {
  return `${CONTRACT_URN_PREFIX}:common:${position}`;
}

export function recordUrn(name: RecordSchemaName): string {
  return `${CONTRACT_URN_PREFIX}:record:${name}`;
}

export function toolUrn(tool: string, position: Position): string {
  return `${CONTRACT_URN_PREFIX}:tool:${tool}:${position}`;
}

// ---------------------------------------------------------------------------
// the renderer
// ---------------------------------------------------------------------------

/**
 * Render an authored shape for one side of the wire.
 *
 * Every rule that could drift lives here and nowhere else:
 *   - objects: sealed on input, left open on output;
 *   - enums: `other` appended on output, never on input;
 *   - record `$ref`s: refused on input, because a record is something Atlas
 *     produced and a caller must never be able to hand one back as if it had
 *     authority. Every field that carries authority — ids, `seq`, `recorded_at`,
 *     `claim_digest`, `provenance.client_id` — is minted at commit, and letting
 *     an input reuse the output shape is exactly how a caller ends up supplying
 *     one.
 */
export function render(shape: Shape, position: Position): JsonSchema {
  switch (shape.form) {
    case "object": {
      const properties: Record<string, JsonSchema> = {};
      for (const [name, child] of Object.entries(shape.properties)) {
        properties[name] = render(child, position);
      }
      return {
        type: "object",
        ...(shape.description === undefined ? {} : { description: shape.description }),
        properties,
        ...(shape.required.length > 0 ? { required: [...shape.required] } : {}),
        // The whole asymmetry, in one ternary, applied uniformly at every depth.
        ...(position === "input" ? { additionalProperties: false } : {})
      };
    }
    case "array":
      return {
        type: "array",
        ...(shape.description === undefined ? {} : { description: shape.description }),
        items: render(shape.items, position),
        ...(shape.minItems === undefined ? {} : { minItems: shape.minItems }),
        ...(shape.maxItems === undefined ? {} : { maxItems: shape.maxItems })
      };
    case "enum":
      return {
        type: "string",
        ...(shape.description === undefined ? {} : { description: shape.description }),
        enum: position === "output" ? [...shape.values, "other"] : [...shape.values]
      };
    case "frozenEnum":
      return {
        type: "string",
        ...(shape.description === undefined ? {} : { description: shape.description }),
        enum: [...shape.values],
        "x-atlas-frozen-reason": shape.reason
      };
    case "anyOf":
      return {
        ...(shape.description === undefined ? {} : { description: shape.description }),
        anyOf: shape.options.map((option) => render(option, position))
      };
    case "vocabulary":
      return {
        type: "string",
        ...(shape.description === undefined ? {} : { description: shape.description }),
        minLength: 1,
        "x-atlas-vocabulary": shape.name,
        "x-atlas-known-values": [...KNOWN_VALUES[shape.name]],
        "x-atlas-registry-tool": "atlas.contract.describe.v1"
      };
    case "const":
      return {
        const: shape.value,
        ...(shape.description === undefined ? {} : { description: shape.description })
      };
    case "scalar":
      return { ...shape.schema };
    case "nullable":
      return { anyOf: [render(shape.inner, position), { type: "null" }] };
    case "ref":
      return {
        $ref: `${commonUrn(position)}#/$defs/${shape.def}`,
        ...(shape.description === undefined ? {} : { description: shape.description })
      };
    case "record": {
      if (position === "input") {
        throw new Error(
          `record("${shape.name}") appears in an input schema; records are output-only`
        );
      }
      return {
        $ref: recordUrn(shape.name),
        ...(shape.description === undefined ? {} : { description: shape.description })
      };
    }
    case "taggedUnion": {
      if (position === "input") {
        throw new Error("taggedUnion is output-only");
      }
      return renderTaggedUnion(shape.members, shape.description);
    }
    case "anyJson":
      return shape.description === undefined ? {} : { description: shape.description };
  }
}

/**
 * A heterogeneous result slot, keyed on `record_schema`.
 *
 * Written as "envelope plus conditional refinements" rather than as a `oneOf`
 * over a closed set, and the difference is load-bearing. A `oneOf` would make
 * every unrecognised `record_schema` a VALIDATION FAILURE, so the first time
 * Atlas returned a record kind added after a consumer pinned this revision, a
 * strict consumer would reject the whole page. Here an unknown kind satisfies
 * the envelope and fails nothing — which is exactly the normative consumer
 * obligation, expressed in the schema instead of only in prose.
 *
 * A known kind still validates in full: the `if` matches its literal and the
 * `then` pulls in the record document.
 */
function renderTaggedUnion(members: readonly RecordSchemaName[], description?: string): JsonSchema {
  for (const member of members) {
    if (!(RECORD_SCHEMAS as readonly string[]).includes(member)) {
      throw new Error(`taggedUnion names an unpublished record schema: ${member}`);
    }
  }
  return {
    type: "object",
    ...(description === undefined ? {} : { description }),
    required: ["record_schema"],
    properties: {
      record_schema: {
        type: "string",
        minLength: 1,
        "x-atlas-known-values": [...members]
      }
    },
    allOf: members.map((member) => ({
      if: {
        required: ["record_schema"],
        properties: { record_schema: { const: member } }
      },
      then: { $ref: recordUrn(member) }
    }))
  };
}
