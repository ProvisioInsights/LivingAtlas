import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SEED_ERROR_CODES } from "@living-atlas/atlas-contract";
import { ERROR_CODES, ERROR_CODE_SET, SEED_CODES_NOT_SERVED } from "./vocabulary.js";
import { callTool, startHarness, syntheticGraph, type Harness } from "./testing.js";

const started: Harness[] = [];

function harness(...args: Parameters<typeof startHarness>): Harness {
  const instance = startHarness(...args);
  started.push(instance);
  return instance;
}

afterEach(async () => {
  while (started.length > 0) await started.pop()?.handle.close();
});

function sourceOf(file: string): string {
  return readFileSync(join(dirname(fileURLToPath(import.meta.url)), file), "utf8");
}

/**
 * Every `code:` literal the handlers and the access layer can put into an
 * `atlas.error:v1` or a redaction stub.
 *
 * Read out of the source rather than listed here, because a list maintained by
 * hand is a list that drifts — and the whole point of the registry is that an
 * open vocabulary still has to be discoverable. A refusal added without a
 * registry entry fails this test before it can reach a consumer as an
 * unexplained string.
 */
function emittedCodes(): string[] {
  const codes = new Set<string>();
  for (const file of ["tools.ts", "access.ts", "server.ts"]) {
    for (const match of sourceOf(file).matchAll(/\b(?:code|reason_code|reasonCode):\s*"([a-z0-9-]+)"/g)) {
      const code = match[1];
      if (code !== undefined) codes.add(code);
    }
  }
  return [...codes].sort();
}

describe("the error-code registry", () => {
  it("names every code the handlers can emit", () => {
    const missing = emittedCodes().filter((code) => !ERROR_CODE_SET.has(code));
    expect(missing, "these codes are raised in source but are not in ERROR_CODES").toEqual([]);
  });

  it("finds a real, non-trivial set of codes to check", () => {
    // Without this the regex silently matching nothing would make the test above
    // pass by vacuity — which is the failure mode of every source-scanning test.
    expect(emittedCodes().length).toBeGreaterThan(10);
  });

  it("registers each code exactly once", () => {
    const seen = ERROR_CODES.map((entry) => entry.code);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("gives every code a summary a consumer can act on, not a restatement of the code", () => {
    for (const entry of ERROR_CODES) {
      expect(entry.summary.length, `${entry.code} has no usable summary`).toBeGreaterThan(30);
      expect(entry.summary.replace(/[^a-z]/g, "")).not.toBe(entry.code.replace(/-/g, ""));
    }
  });

  it("serves every code the published contract seeds, or names it as not served and says why", () => {
    const registered = new Set(ERROR_CODES.map((entry) => entry.code));
    const unaccounted = SEED_ERROR_CODES.map((entry) => entry.code).filter(
      (code) => !registered.has(code) && SEED_CODES_NOT_SERVED[code] === undefined
    );
    // The defect this catches is a rename: a refusal shipping under a second
    // name matched nothing a consumer branched on, and nothing compared the two
    // lists, so it shipped four times at once.
    expect(unaccounted, "published codes that are neither served nor declared unserved").toEqual([]);

    const stale = Object.keys(SEED_CODES_NOT_SERVED).filter(
      (code) => registered.has(code) || !SEED_ERROR_CODES.some((entry) => entry.code === code)
    );
    // The register is not a place to park names: an entry that is now served,
    // or that the contract never published, is itself drift.
    expect(stale, "not-served entries that are served, or that name no published code").toEqual([]);
  });

  it("agrees with the published contract about every code both of them name", () => {
    const published = new Map(SEED_ERROR_CODES.map((entry) => [entry.code, entry]));
    const disagreements: string[] = [];
    for (const entry of ERROR_CODES) {
      const seed = published.get(entry.code);
      if (!seed) continue;
      // Summaries are deliberately NOT compared: this registry describes what
      // THIS server does with the refusal and is richer on purpose. The three
      // fields a consumer branches on are the ones that must not diverge.
      if (entry.origin !== seed.origin) disagreements.push(`${entry.code}.origin ${entry.origin} vs ${seed.origin}`);
      if (entry.jsonrpc_code !== seed.jsonrpc_code) {
        disagreements.push(`${entry.code}.jsonrpc_code ${String(entry.jsonrpc_code)} vs ${String(seed.jsonrpc_code)}`);
      }
      if (entry.retryable !== seed.retryable) {
        disagreements.push(`${entry.code}.retryable ${String(entry.retryable)} vs ${String(seed.retryable)}`);
      }
    }
    expect(disagreements).toEqual([]);
    // Non-vacuous: the two tables genuinely overlap, so the loop above compared
    // something. Without this the check passes when a rename empties the overlap.
    expect(ERROR_CODES.filter((entry) => published.has(entry.code)).length).toBeGreaterThan(10);
  });

  it("only ever claims a JSON-RPC code from the ranges new code may use", () => {
    for (const entry of ERROR_CODES) {
      if (entry.jsonrpc_code === undefined) continue;
      // -32000..-32019 is the legacy range and is not for new code. -32020..-32099
      // is spec-reserved, and only DEFINED members may be emitted with their
      // specified meanings — so the allowed set is enumerated rather than a range.
      expect([-32700, -32600, -32601, -32602, -32603, -32021, -32022], `${entry.code} claims ${entry.jsonrpc_code}`).toContain(
        entry.jsonrpc_code
      );
    }
  });
});

describe("atlas.contract.describe.v1 vocabularies", () => {
  it("publishes the LIVE registries rather than a copy frozen into the schema", async () => {
    const graph = syntheticGraph();
    const { client } = harness({ graph });
    client.send(callTool({ id: 1, name: "atlas.contract.describe.v1" }));
    const payload = (await client.await(1)).result?.["structuredContent"] as Record<string, unknown>;
    const vocabularies = payload["vocabularies"] as Record<string, unknown>;

    // What came back is exactly what the graph supplied — not a constant here.
    expect(vocabularies["predicate"]).toEqual(graph.predicateRegistry().map((entry) => ({ ...entry })));
    expect((vocabularies["error_code"] as { code: string }[]).map((entry) => entry.code)).toEqual(
      ERROR_CODES.map((entry) => entry.code)
    );
    expect(vocabularies["entity_subtype"]).toEqual([]);
  });

  it("publishes a fetchable path next to every record schema id", async () => {
    const { client } = harness();
    client.send(callTool({ id: 1, name: "atlas.contract.describe.v1" }));
    const payload = (await client.await(1)).result?.["structuredContent"] as Record<string, unknown>;

    for (const entry of payload["record_schemas"] as { schema_id: string; schema_path: string }[]) {
      // A `urn:` has no retrieval semantics by design, so an id alone leaves a
      // consumer holding something it cannot dereference.
      expect(entry.schema_id.startsWith("urn:living-atlas:contract:")).toBe(true);
      expect(entry.schema_path.endsWith(".json")).toBe(true);
    }
  });
});
