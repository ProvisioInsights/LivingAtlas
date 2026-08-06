import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONTRACT_PLANE_PREDICATES,
  CONTRACT_REVISION,
  CONTRACT_TOOL_NAMES,
  KNOWN_VALUES,
  SEED_PREDICATES,
  packageRoot,
  schemaDirectory
} from "@living-atlas/atlas-contract";
import { PredicateRegistry, RetiredPredicates } from "@living-atlas/contracts";
import { publishedContract } from "./client.js";
import {
  COMMON_OUTPUT_KEY_MANIFESTS,
  COMMON_OUTPUT_NOT_TYPED,
  RECORDS_NOT_KEY_MANIFESTED,
  RECORD_KEY_MANIFESTS
} from "./records.js";
import { COMMON_INPUT_KEY_MANIFESTS, TOOL_KEY_MANIFESTS } from "./tools.js";

/**
 * The tie between this package's TypeScript and the published bytes.
 *
 * This client writes tool shapes down in TypeScript so a caller gets a typed
 * method rather than `unknown`. That is a SECOND declaration of a shape the
 * contract already owns, and a shape declared twice has two shapes — the whole
 * defect this repository's gates exist to catch. So the second declaration is
 * mechanically compared against the first, here, in both directions and for both
 * "which members exist" and "which members are guaranteed".
 *
 * What each direction catches:
 *
 *  - a member added to the CONTRACT and forgotten here — a caller would never see
 *    a field the server sends, which is how a consumer silently ignores a new
 *    honesty block;
 *  - a member invented HERE and absent from the contract — a caller would send an
 *    argument that `additionalProperties: false` refuses, or read a result field
 *    that never arrives;
 *  - a member the contract says is OPTIONAL typed as required — the client would
 *    crash on a conformant server rather than on a broken one;
 *  - a member the contract REQUIRES typed as optional — a caller would write a
 *    needless undefined check and, worse, learn to distrust the guarantee.
 */

function schemaFile(relative: string): Record<string, unknown> {
  const directory = schemaDirectory(packageRoot(), CONTRACT_REVISION);
  return JSON.parse(readFileSync(join(directory, relative), "utf8")) as Record<string, unknown>;
}

function propertyNames(schema: Record<string, unknown>): string[] {
  const properties = schema["properties"];
  return typeof properties === "object" && properties !== null ? Object.keys(properties).sort() : [];
}

function requiredNames(schema: Record<string, unknown>): string[] {
  const required = schema["required"];
  return Array.isArray(required) ? [...(required as string[])].sort() : [];
}

function manifestNames(manifest: Readonly<Record<string, true>>): string[] {
  return Object.keys(manifest).sort();
}

function defs(relative: string): Record<string, Record<string, unknown>> {
  const document = schemaFile(relative);
  const found = document["$defs"];
  return typeof found === "object" && found !== null ? (found as Record<string, Record<string, unknown>>) : {};
}

describe("the tool argument and result types", () => {
  const manifest = publishedContract().manifest;

  it.each([...CONTRACT_TOOL_NAMES])("%s declares the same input members as its published schema", (name) => {
    const published = manifest.tools.find((tool) => tool.name === name);
    expect(published, `${name} is not in the published manifest`).toBeDefined();
    if (!published) return;

    const schema = schemaFile(published.input_schema);
    const declared = TOOL_KEY_MANIFESTS[name].input;
    expect(manifestNames(declared.keys)).toEqual(propertyNames(schema));
    expect(manifestNames(declared.required)).toEqual(requiredNames(schema));
  });

  it.each([...CONTRACT_TOOL_NAMES])("%s declares the same result members as its published schema", (name) => {
    const published = manifest.tools.find((tool) => tool.name === name);
    expect(published, `${name} is not in the published manifest`).toBeDefined();
    if (!published) return;

    const schema = schemaFile(published.output_schema);
    const declared = TOOL_KEY_MANIFESTS[name].output;
    expect(manifestNames(declared.keys)).toEqual(propertyNames(schema));
    expect(manifestNames(declared.required)).toEqual(requiredNames(schema));
  });

  it("covers every published tool and invents none", () => {
    expect(Object.keys(TOOL_KEY_MANIFESTS).sort()).toEqual([...CONTRACT_TOOL_NAMES].sort());
  });
});

describe("the record types", () => {
  const manifest = publishedContract().manifest;

  it("either describes each published record schema or records why it does not", () => {
    // Every published record is accounted for exactly once. A record that
    // appeared in neither table would be one this client types by accident, and
    // a record in both would leave the reader unable to tell which rule applies.
    const described = Object.keys(RECORD_KEY_MANIFESTS).sort();
    const excused = Object.keys(RECORDS_NOT_KEY_MANIFESTED).sort();
    expect([...described, ...excused].sort()).toEqual(manifest.record_schemas.map((entry) => entry.name).sort());
    expect(described.filter((name) => excused.includes(name))).toEqual([]);
  });

  it.each(Object.keys(RECORD_KEY_MANIFESTS))("%s declares the same members as its published schema", (name) => {
    const published = manifest.record_schemas.find((entry) => entry.name === name);
    expect(published, `${name} is not published`).toBeDefined();
    if (!published) return;

    const schema = schemaFile(published.schema);
    const declared = RECORD_KEY_MANIFESTS[name as keyof typeof RECORD_KEY_MANIFESTS];
    expect(declared).toBeDefined();
    if (!declared) return;
    expect(manifestNames(declared.keys)).toEqual(propertyNames(schema));
    expect(manifestNames(declared.required)).toEqual(requiredNames(schema));
  });
});

describe("the shared blocks", () => {
  it("accounts for every $def in the common OUTPUT document", () => {
    const published = Object.keys(defs(publishedContract().manifest.common_schemas.output)).sort();
    const described = Object.keys(COMMON_OUTPUT_KEY_MANIFESTS);
    const excused = Object.keys(COMMON_OUTPUT_NOT_TYPED);
    expect([...described, ...excused].sort()).toEqual(published);
    expect(described.filter((name) => excused.includes(name))).toEqual([]);
  });

  it.each(Object.keys(COMMON_OUTPUT_KEY_MANIFESTS))("%s declares the same members as the common document", (name) => {
    const schema = defs(publishedContract().manifest.common_schemas.output)[name];
    expect(schema, `${name} is not a $def in the common output document`).toBeDefined();
    if (!schema) return;

    const declared = COMMON_OUTPUT_KEY_MANIFESTS[name];
    expect(declared).toBeDefined();
    if (!declared) return;
    expect(manifestNames(declared.keys)).toEqual(propertyNames(schema));
    expect(manifestNames(declared.required)).toEqual(requiredNames(schema));
  });

  it.each(Object.keys(COMMON_INPUT_KEY_MANIFESTS))("%s declares the same members as the common input document", (name) => {
    const schema = defs(publishedContract().manifest.common_schemas.input)[name];
    expect(schema, `${name} is not a $def in the common input document`).toBeDefined();
    if (!schema) return;

    const declared = COMMON_INPUT_KEY_MANIFESTS[name];
    expect(declared).toBeDefined();
    if (!declared) return;
    expect(manifestNames(declared.keys)).toEqual(propertyNames(schema));
    expect(manifestNames(declared.required)).toEqual(requiredNames(schema));
  });
});

describe("the published open-vocabulary hint and the graph vocabulary", () => {
  it("publishes exactly the graph's predicate vocabulary as the open-vocabulary hint", () => {
    // The hint is published in `x-atlas-known-values` and the enforcing registry
    // lives in @living-atlas/contracts, which the contract package cannot import
    // without a dependency it does not have. So the two lists are held together
    // HERE, in the one package that depends on both.
    //
    // The direction that matters is both: a predicate in the hint that the graph
    // refuses builds a request that cannot succeed, and a predicate the graph
    // accepts but the hint omits is a relation no consumer will discover.
    const graph = new Set(Object.keys(PredicateRegistry));
    const contractPlane = new Set(CONTRACT_PLANE_PREDICATES);
    const seeded = SEED_PREDICATES.map((entry) => entry.predicate);

    expect(seeded.filter((predicate) => graph.has(predicate)).sort()).toEqual([...graph].sort());
    expect(seeded.filter((predicate) => !graph.has(predicate)).sort()).toEqual([...contractPlane].sort());
    expect(new Set(seeded).size).toBe(seeded.length);

    // Retired names must not survive in the hint. A consumer reading the hint is
    // told what it may send; a retired name there is an invitation to a refusal.
    for (const retired of Object.keys(RetiredPredicates)) {
      expect(`${retired} still hinted: ${seeded.includes(retired)}`).toBe(`${retired} still hinted: false`);
    }

    // And the hint the consumer actually fetches is the one built from the seed,
    // not a second copy that happens to agree today.
    expect([...KNOWN_VALUES.predicate]).toEqual(seeded);
  });
});

describe("the client's own protocol constants", () => {
  it("takes the revision it validates against from the loaded manifest, not from a literal", () => {
    // A client whose bytes and the server's revision disagree is caught by the
    // output validator on the first call — but the revision it REPORTS has to
    // come from the document it actually loaded, or a mismatch would be
    // reported as agreement.
    expect(publishedContract().manifest.contract_revision).toBe(CONTRACT_REVISION);
  });
});
