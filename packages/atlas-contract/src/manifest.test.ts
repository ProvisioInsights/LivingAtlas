import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { generateContract, serialize } from "./generate.js";
import { loadContract, schemaDirectory, type ContractManifest } from "./manifest.js";
import {
  ContractInputError,
  ContractOutputError,
  registerContractTools,
  type RegisteredToolDefinition,
  type ToolHandler
} from "./register.js";
import { CONTRACT_REVISION, CONTRACT_TOOL_NAMES } from "./revision.js";
import { RECORD_SAMPLES, TOOL_INPUT_SAMPLES } from "./samples.js";
import { createContractValidator } from "./validator.js";
import { packageRoot, writeContract } from "./write-schemas.js";

const PUBLISHED = schemaDirectory(packageRoot(), CONTRACT_REVISION);
const scratch: string[] = [];

/** Synthetic, under the OS temp dir. Nothing here reads or writes real graph data. */
function copyPublished(): string {
  const root = mkdtempSync(join(tmpdir(), "atlas-contract-"));
  scratch.push(root);
  cpSync(PUBLISHED, schemaDirectory(root, CONTRACT_REVISION), { recursive: true });
  return schemaDirectory(root, CONTRACT_REVISION);
}

function editManifest(directory: string, edit: (manifest: ContractManifest) => void): void {
  const manifest = loadContract(directory).manifest;
  edit(manifest);
  writeFileSync(join(directory, "manifest.json"), serialize(manifest), "utf8");
}

afterAll(() => {
  for (const root of scratch) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
});

function recordingRegistrar(): { registered: RegisteredToolDefinition[]; handlers: Map<string, ToolHandler>; registrar: { registerTool: (d: RegisteredToolDefinition, h: ToolHandler) => void } } {
  const registered: RegisteredToolDefinition[] = [];
  const handlers = new Map<string, ToolHandler>();
  return {
    registered,
    handlers,
    registrar: {
      registerTool(definition, handler) {
        registered.push(definition);
        handlers.set(definition.name, handler);
      }
    }
  };
}

function stubHandlers(result: unknown = {}): Record<string, ToolHandler> {
  return Object.fromEntries(CONTRACT_TOOL_NAMES.map((name) => [name, () => result]));
}

describe("the manifest loader", () => {
  it("round-trips: generate, write, load, and get the same manifest back", () => {
    const root = mkdtempSync(join(tmpdir(), "atlas-contract-"));
    scratch.push(root);
    writeContract(root);
    const loaded = loadContract(schemaDirectory(root, CONTRACT_REVISION));
    expect(loaded.manifest).toEqual(generateContract().manifest);
    expect(loaded.tools.map((tool) => tool.name)).toEqual([...CONTRACT_TOOL_NAMES]);
  });

  it("loads the schemas as bytes, not by rebuilding them", () => {
    const loaded = loadContract(PUBLISHED);
    const generated = generateContract();
    for (const tool of loaded.tools) {
      const source = generated.documents.find((document) => document.path === `tools/${tool.name}.input.json`);
      expect(tool.inputSchema).toEqual(source?.schema);
    }
  });

  it("refuses a manifest whose $id disagrees with the document it names", () => {
    // The manifest is how a consumer finds a schema by id. If the two disagree,
    // the id a consumer resolves and the bytes it receives are different things,
    // and nothing downstream can detect that.
    const directory = copyPublished();
    editManifest(directory, (manifest) => {
      const first = manifest.tools[0];
      if (first) first.input_schema_id = "urn:living-atlas:contract:2026.08.0:tool:wrong:input";
    });
    expect(() => loadContract(directory)).toThrow(/declares \$id/);
  });

  it("refuses a published file the manifest does not name", () => {
    // An unnamed file is served to nobody and reviewed by nobody, while looking
    // every bit as authoritative to anyone who finds it in the directory.
    const directory = copyPublished();
    writeFileSync(join(directory, "records", "atlas.stowaway-v1.json"), "{}\n", "utf8");
    expect(() => loadContract(directory)).toThrow(/published but not named by manifest/);
  });
});

describe("registering tools from the manifest", () => {
  const contract = loadContract(PUBLISHED);
  const validator = createContractValidator(contract);

  it("registers all twelve, in manifest order, with both schemas attached", () => {
    const { registered, registrar } = recordingRegistrar();
    const names = registerContractTools(registrar, contract, validator, stubHandlers(), { validateOutput: false });

    expect(names).toEqual([...CONTRACT_TOOL_NAMES]);
    expect(registered.map((tool) => tool.name)).toEqual([...CONTRACT_TOOL_NAMES]);
    for (const tool of registered) {
      expect(tool.outputSchema["$id"]).toMatch(/:output$/);
      expect(tool.inputSchema["$id"]).toMatch(/:input$/);
      expect(tool._meta["atlas.contract/revision"]).toBe(CONTRACT_REVISION);
    }
  });

  it("hands the server the published bytes, not a copy it could edit", () => {
    const { registered, registrar } = recordingRegistrar();
    registerContractTools(registrar, contract, validator, stubHandlers(), { validateOutput: false });
    const query = registered.find((tool) => tool.name === "atlas.assertion.query.v1");
    expect(query?.inputSchema).toBe(contract.tools.find((tool) => tool.name === "atlas.assertion.query.v1")?.inputSchema);
  });

  it("refuses to start when a published tool has no handler", () => {
    const { registrar } = recordingRegistrar();
    const handlers = stubHandlers();
    delete handlers["atlas.sensitive.reveal.v1"];
    expect(() => registerContractTools(registrar, contract, validator, handlers)).toThrow(
      /published tools have no handler: atlas\.sensitive\.reveal\.v1/
    );
  });

  it("refuses to start when a handler names a tool the contract does not publish", () => {
    const { registrar } = recordingRegistrar();
    expect(() =>
      registerContractTools(registrar, contract, validator, { ...stubHandlers(), "atlas.secret.backdoor.v1": () => ({}) })
    ).toThrow(/handlers registered for unpublished tools: atlas\.secret\.backdoor\.v1/);
  });

  it("rejects arguments that fail the published input schema before the handler runs", async () => {
    const { handlers, registrar } = recordingRegistrar();
    let called = 0;
    registerContractTools(registrar, contract, validator, { ...stubHandlers(), "atlas.entity.read.v1": () => { called += 1; return {}; } }, { validateOutput: false });

    const handler = handlers.get("atlas.entity.read.v1");
    await expect(handler?.({ entity_ids: ["not-a-minted-id"] })).rejects.toBeInstanceOf(ContractInputError);
    expect(called).toBe(0);
  });

  it("rejects a result that fails the tool's own output schema", async () => {
    const { handlers, registrar } = recordingRegistrar();
    registerContractTools(registrar, contract, validator, stubHandlers({ nonsense: true }));
    const handler = handlers.get("atlas.entity.read.v1");
    await expect(handler?.(TOOL_INPUT_SAMPLES["atlas.entity.read.v1"])).rejects.toBeInstanceOf(ContractOutputError);
  });

  it("passes a result that satisfies the published output schema", async () => {
    const result = {
      results: [RECORD_SAMPLES["atlas.entity:v1"]],
      coverage: {
        evaluated: 1,
        matched: 1,
        returned: 1,
        withheld: 0,
        with_valid_time: 0,
        unknown_or_absent_valid_time: 1,
        counts_basis: "exact"
      },
      horizon: RECORD_SAMPLES["atlas.horizon:v1"],
      cache: { ttl_ms: 0, cache_scope: "private" }
    };
    const { handlers, registrar } = recordingRegistrar();
    registerContractTools(registrar, contract, validator, { ...stubHandlers(), "atlas.entity.read.v1": () => result });
    const handler = handlers.get("atlas.entity.read.v1");
    await expect(handler?.(TOOL_INPUT_SAMPLES["atlas.entity.read.v1"])).resolves.toEqual(result);
  });
});
