import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONTRACT_REVISION } from "@living-atlas/atlas-contract";
import { runGoldenGate } from "./gate-golden.js";
import { schemaRoot } from "./gate-immutable-revisions.js";
import { makeTemporaryRepo } from "./harness.test-helpers.js";
import { probeConsumerPlane } from "./probes.js";

/**
 * The two consumer-plane checks that need a running server, each shown failing.
 *
 * Both are seeded the same way: the published bytes under a temporary root are
 * edited while the server keeps serving the package's own copy. That is exactly
 * the situation the checks exist for — somebody hand-edits a schema, or adds a
 * tool to the manifest that nothing implements — and it is the situation neither
 * a type checker nor a single-transport test can see.
 */

function toolSchemaPath(root: string, file: string): string {
  return join(schemaRoot(root), CONTRACT_REVISION, "tools", file);
}

type Manifest = {
  tools: {
    name: string;
    title: string;
    description: string;
    input_schema: string;
    output_schema: string;
    input_schema_id: string;
    output_schema_id: string;
    annotations: Record<string, boolean>;
    cache: { ttl_ms: number; cache_scope: string };
    requires_capabilities: string[];
    deprecation: null;
  }[];
};

function manifestPath(root: string): string {
  return join(schemaRoot(root), CONTRACT_REVISION, "manifest.json");
}

describe("the consumer-plane byte-identity check", () => {
  it("passes when the served schema and the published document are the same bytes", async () => {
    expect(await probeConsumerPlane()).toEqual([]);
  });

  it("fails when a published input schema is edited by hand", async () => {
    const root = makeTemporaryRepo();
    const path = toolSchemaPath(root, "atlas.text.search.v1.input.json");
    const schema = JSON.parse(readFileSync(path, "utf8")) as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    // A plausible, well-meaning edit: tighten the input. The server still
    // compiles and validates against the copy it loaded, and a consumer that
    // fetched this document is now being told a different thing.
    schema.properties["query"] = { type: "string", minLength: 3 };
    writeFileSync(path, `${JSON.stringify(schema, null, 2)}\n`, "utf8");

    const findings = await probeConsumerPlane(root);
    expect(findings.map((finding) => finding.kind)).toContain("input-schema-divergence");
    const divergence = findings.find((finding) => finding.kind === "input-schema-divergence");
    expect(divergence?.where).toBe("atlas.text.search.v1");
    expect(divergence?.detail).toEqual(["inputSchema"]);
  });

  it("fails when the manifest advertises a tool nothing serves", async () => {
    const root = makeTemporaryRepo();
    const manifest = JSON.parse(readFileSync(manifestPath(root), "utf8")) as Manifest;
    const model = manifest.tools.find((tool) => tool.name === "atlas.contract.describe.v1");
    if (!model) throw new Error("the fixture manifest lost its describe tool");

    for (const position of ["input", "output"] as const) {
      const file = position === "input" ? model.input_schema : model.output_schema;
      const document = JSON.parse(readFileSync(join(schemaRoot(root), CONTRACT_REVISION, file), "utf8")) as Record<
        string,
        unknown
      >;
      document["$id"] = `urn:living-atlas:contract:${CONTRACT_REVISION}:tool:atlas.phantom.v1:${position}`;
      writeFileSync(toolSchemaPath(root, `atlas.phantom.v1.${position}.json`), `${JSON.stringify(document, null, 2)}\n`, "utf8");
    }
    manifest.tools.push({
      ...model,
      name: "atlas.phantom.v1",
      input_schema: "tools/atlas.phantom.v1.input.json",
      output_schema: "tools/atlas.phantom.v1.output.json",
      input_schema_id: `urn:living-atlas:contract:${CONTRACT_REVISION}:tool:atlas.phantom.v1:input`,
      output_schema_id: `urn:living-atlas:contract:${CONTRACT_REVISION}:tool:atlas.phantom.v1:output`
    });
    writeFileSync(manifestPath(root), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const findings = await probeConsumerPlane(root);
    const stranded = findings.find((finding) => finding.where === "atlas.phantom.v1");
    expect(stranded?.kind).toBe("advertised-tool-unimplemented");
    expect(stranded?.detail).toEqual(["published-not-served"]);
    expect(stranded?.message).toContain("method-not-found");
  });
});

describe("the golden gate's output-schema check", () => {
  it("fails when a live response stops satisfying the schema that was published for it", async () => {
    const root = makeTemporaryRepo();
    const path = toolSchemaPath(root, "atlas.scope.describe.v1.output.json");
    const schema = JSON.parse(readFileSync(path, "utf8")) as {
      required?: string[];
      properties: Record<string, unknown>;
    };
    // The contract now promises a member the server does not send. Nothing about
    // the recorded golden changed — this is the leg that catches a golden which
    // is perfectly stable and no longer contract-legal.
    schema.properties["tools_deprecated"] = { type: "array", items: { type: "string" } };
    schema.required = [...(schema.required ?? []), "tools_deprecated"];
    writeFileSync(path, `${JSON.stringify(schema, null, 2)}\n`, "utf8");

    const result = await runGoldenGate(root);
    expect(result.ok).toBe(false);
    const text = result.failures.join("\n");
    expect(text).toContain("does not satisfy the published output schema");
    expect(text).toContain("tools_deprecated");
    expect(text).toContain("pins the regression");
  });
});
