import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fixtureAuthorityId, sensitiveBaitRegistry } from "@living-atlas/fixtures";
import { FileLocalControlStore, createFixtureLocalControlState } from "@living-atlas/local-control-store";
import { createDefaultLocalKeyring, FileLocalKeyringStore } from "@living-atlas/local-keyring";

const token = "local-install-smoke-token-0001";
const controlPassphrase = "local-install-smoke-control-passphrase-0001";
const keyringPassphrase = "local-install-smoke-keyring-passphrase-0001";
const timestamp = "2026-06-22T12:00:00.000Z";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function textContent(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return "";
  }

  const first = content[0] as { type?: unknown; text?: unknown } | undefined;
  return first?.type === "text" && typeof first.text === "string" ? first.text : "";
}

function parseToolJson<T>(label: string, result: unknown): T {
  const text = textContent(result);
  assert(text.length > 0, `${label} did not return text content`);
  return JSON.parse(text) as T;
}

function fixedHash(seed: string): `sha256:${string}` {
  return `sha256:${seed.repeat(64).slice(0, 64)}`;
}

function syntheticInstallObject() {
  return {
    schema_version: 1,
    authority_id: fixtureAuthorityId,
    object_id: "la_object_installsmoke0001",
    object_type: "page",
    version: 1,
    access_class: "remote-safe",
    encryption_class: "plaintext",
    created_at: timestamp,
    updated_at: timestamp,
    content_hash: fixedHash("c"),
    visible_metadata: {
      schema_namespace: "smoke/local-install",
      tombstone: false,
      size_class: "tiny",
      remote_indexable: true
    },
    payload: {
      kind: "plaintext-json",
      data: {
        title: "Synthetic install smoke object",
        body: "Fixture-only MCP mutation payload."
      }
    }
  };
}

function sensitiveInstallObject() {
  return {
    schema_version: 1,
    authority_id: fixtureAuthorityId,
    object_id: "la_object_installprivate0001",
    object_type: "page",
    version: 1,
    access_class: "local-private",
    encryption_class: "plaintext",
    created_at: timestamp,
    updated_at: timestamp,
    content_hash: fixedHash("e"),
    visible_metadata: {
      schema_namespace: "smoke/local-install",
      tombstone: false,
      size_class: "tiny",
      remote_indexable: false
    },
    payload: {
      kind: "plaintext-json",
      data: {
        title: "Synthetic local private install object",
        body: "Fixture-only local private MCP payload."
      }
    }
  };
}

function assertNoSensitiveText(label: string, value: string): void {
  assert(!value.includes(token), `${label} leaked local MCP token`);
  assert(!value.includes(controlPassphrase), `${label} leaked local control-store passphrase`);
  assert(!value.includes(keyringPassphrase), `${label} leaked local keyring passphrase`);
  assert(!value.includes("Synthetic install smoke object"), `${label} leaked create plaintext`);
  assert(!value.includes("Fixture-only MCP mutation payload."), `${label} leaked create payload`);
  assert(!value.includes("Synthetic install smoke object revised"), `${label} leaked update plaintext`);
  assert(!value.includes("Fixture-only MCP update payload."), `${label} leaked update payload`);
  assert(!value.includes("Synthetic local private install object"), `${label} leaked local private plaintext`);
  assert(!value.includes("Fixture-only local private MCP payload."), `${label} leaked local private payload`);
  for (const bait of sensitiveBaitRegistry) {
    assert(!value.includes(bait.value), `${label} leaked sensitive bait: ${bait.id}`);
  }
}

async function main(): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), "living-atlas-local-install-smoke-"));
  const storePath = join(tempDir, "control-store.json");
  const keyringPath = join(tempDir, "keyring.json");
  const graphDir = join(tempDir, "graph");
  const activityPath = join(tempDir, "activity.jsonl");
  const repoRoot = process.cwd();
  let client: Client | undefined;

  try {
    await new FileLocalControlStore(storePath).write(await createFixtureLocalControlState(token), controlPassphrase);
    const sealedStore = await readFile(storePath, "utf8");
    assert(sealedStore.includes("ciphertext_base64"), "local control store was not written as a sealed envelope");
    assertNoSensitiveText("sealed local control store", sealedStore);
    console.log("ok sealed local control store");

    const keyring = createDefaultLocalKeyring({
      authorityId: fixtureAuthorityId,
      createdAt: timestamp
    });
    await new FileLocalKeyringStore(keyringPath).write(keyring, keyringPassphrase);
    const sealedKeyring = await readFile(keyringPath, "utf8");
    assert(sealedKeyring.includes("ciphertext_base64"), "local keyring was not written as a sealed envelope");
    assertNoSensitiveText("sealed local keyring", sealedKeyring);
    for (const key of keyring.keys) {
      assert(!sealedKeyring.includes(key.material_base64), "sealed local keyring leaked raw key material");
    }
    console.log("ok sealed local keyring");

    const transport = new StdioClientTransport({
      command: "npx",
      args: ["tsx", "packages/local-mcp/src/cli.ts"],
      cwd: repoRoot,
      stderr: "pipe",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        LIVING_ATLAS_LOCAL_CONTROL_STORE: storePath,
        LIVING_ATLAS_LOCAL_CONTROL_STORE_PASSPHRASE: controlPassphrase,
        LIVING_ATLAS_LOCAL_MCP_TOKEN: token,
        LIVING_ATLAS_LOCAL_GRAPH_DIR: graphDir,
        LIVING_ATLAS_LOCAL_KEYRING: keyringPath,
        LIVING_ATLAS_LOCAL_KEYRING_PASSPHRASE: keyringPassphrase,
        LIVING_ATLAS_ACTIVITY_LOG: activityPath
      }
    });

    const stderrChunks: string[] = [];
    transport.stderr?.on("data", (chunk) => {
      stderrChunks.push(Buffer.from(chunk).toString("utf8"));
    });

    client = new Client({
      name: "living-atlas-local-install-smoke",
      version: "0.1.0"
    });
    await client.connect(transport);

    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name).sort();
    for (const required of [
      "local_graph_status",
      "local_list_objects",
      "local_read_object",
      "local_create_object",
      "local_update_object",
      "local_tombstone_object"
    ]) {
      assert(toolNames.includes(required), `local MCP is missing tool: ${required}`);
    }
    console.log(`ok local MCP tools -> ${toolNames.join(", ")}`);

    const status = parseToolJson<{
      ok: boolean;
      result?: {
        object_count?: number;
        profile?: string;
        plaintext_persistence?: string;
      };
    }>("local_graph_status", await client.callTool({ name: "local_graph_status", arguments: {} }));
    assert(status.ok === true, "local_graph_status did not succeed");
    assert(status.result?.object_count === 6, "local_graph_status returned an unexpected object count");
    assert(status.result?.profile === "local-full", "local_graph_status did not authenticate as local-full");
    assert(status.result?.plaintext_persistence === "encrypted", "local graph persistence was not encrypted");
    console.log("ok local graph status");

    const list = parseToolJson<{
      ok: boolean;
      result?: {
        objects?: Array<{ object_id?: string; access_class?: string }>;
      };
    }>("local_list_objects", await client.callTool({ name: "local_list_objects", arguments: {} }));
    assert(list.ok === true, "local_list_objects did not succeed");
    assert(
      list.result?.objects?.some((object) => object.object_id === "la_object_privatepage0001" && object.access_class === "local-private"),
      "local_list_objects did not include the fixture local-private object"
    );
    console.log("ok local list objects");

    const read = parseToolJson<{
      ok: boolean;
      result?: {
        object?: {
          object_id?: string;
          access_class?: string;
          payload?: { kind?: string };
        };
      };
    }>("local_read_object", await client.callTool({
      name: "local_read_object",
      arguments: {
        object_id: "la_object_privatepage0001"
      }
    }));
    assert(read.ok === true, "local_read_object did not succeed");
    assert(read.result?.object?.access_class === "local-private", "local_read_object did not read a local-private object");
    assert(read.result.object.payload?.kind === "ciphertext-ref", "local_read_object should return the fixture ciphertext envelope");
    console.log("ok local read object");

    const created = parseToolJson<{
      ok: boolean;
      result?: {
        mutation?: string;
        object_count?: number;
        object?: { object_id?: string };
      };
    }>("local_create_object", await client.callTool({
      name: "local_create_object",
      arguments: {
        object: syntheticInstallObject()
      }
    }));
    assert(created.ok === true, "local_create_object did not succeed");
    assert(created.result?.mutation === "created", "local_create_object did not report created mutation");
    assert(created.result.object_count === 7, "local_create_object did not add one object");

    const updated = parseToolJson<{
      ok: boolean;
      result?: {
        mutation?: string;
        previous_version?: number;
        new_version?: number;
      };
    }>("local_update_object", await client.callTool({
      name: "local_update_object",
      arguments: {
        object_id: "la_object_installsmoke0001",
        expected_version: 1,
        patch: {
          content_hash: fixedHash("d"),
          visible_metadata: {
            size_class: "small"
          },
          payload: {
            kind: "plaintext-json",
            data: {
              title: "Synthetic install smoke object revised",
              body: "Fixture-only MCP update payload."
            }
          }
        }
      }
    }));
    assert(updated.ok === true, "local_update_object did not succeed");
    assert(updated.result?.mutation === "updated", "local_update_object did not report updated mutation");
    assert(updated.result.previous_version === 1 && updated.result.new_version === 2, "local_update_object did not advance version");

    const tombstoned = parseToolJson<{
      ok: boolean;
      result?: {
        mutation?: string;
        previous_version?: number;
        new_version?: number;
      };
    }>("local_tombstone_object", await client.callTool({
      name: "local_tombstone_object",
      arguments: {
        object_id: "la_object_installsmoke0001",
        expected_version: 2
      }
    }));
    assert(tombstoned.ok === true, "local_tombstone_object did not succeed");
    assert(tombstoned.result?.mutation === "tombstoned", "local_tombstone_object did not report tombstoned mutation");
    assert(tombstoned.result.previous_version === 2 && tombstoned.result.new_version === 3, "local_tombstone_object did not advance version");

    const sensitiveCreated = parseToolJson<{
      ok: boolean;
      result?: {
        mutation?: string;
        object_count?: number;
        object?: {
          object_id?: string;
          access_class?: string;
          encryption_class?: string;
          payload?: { kind?: string; algorithm?: string };
        };
      };
    }>("local_create_object_private", await client.callTool({
      name: "local_create_object",
      arguments: {
        object: sensitiveInstallObject()
      }
    }));
    assert(sensitiveCreated.ok === true, "local_create_object did not accept a local-private plaintext draft");
    assert(sensitiveCreated.result?.mutation === "created", "local_create_object did not create local-private draft");
    assert(sensitiveCreated.result?.object?.access_class === "local-private", "local-private draft changed access class");
    assert(sensitiveCreated.result.object.encryption_class === "client-encrypted", "local-private draft was not encrypted");
    assert(sensitiveCreated.result.object.payload?.kind === "ciphertext-inline", "local-private draft did not return ciphertext");
    console.log("ok local CRUD tools");

    assert(existsSync(activityPath), "local MCP activity log was not written");
    const activity = await readFile(activityPath, "utf8");
    assert(activity.includes("local_read_object"), "local MCP activity log did not record the read");
    assert(activity.includes("local_create_object"), "local MCP activity log did not record the create");
    assert(activity.includes("local_update_object"), "local MCP activity log did not record the update");
    assert(activity.includes("local_tombstone_object"), "local MCP activity log did not record the tombstone");
    assertNoSensitiveText("local MCP activity log", activity);
    assertNoSensitiveText("local MCP tool output", JSON.stringify({ status, list, read, created, updated, tombstoned, sensitiveCreated }));
    console.log("ok local MCP activity leakage guard");

    const snapshot = await readFile(join(graphDir, "snapshot.json"), "utf8");
    const journal = await readFile(join(graphDir, "journal.jsonl"), "utf8");
    const graphFiles = `${snapshot}\n${journal}`;
    assert(graphFiles.includes("AES-GCM-256+local-keyring-v1"), "local graph files did not contain local keyring ciphertext");
    assert(!graphFiles.includes("plaintext-json"), "local graph files persisted plaintext payload markers");
    assertNoSensitiveText("local encrypted graph files", graphFiles);
    console.log("ok local encrypted graph leakage guard");

    const stderr = stderrChunks.join("").trim();
    assertNoSensitiveText("local MCP stderr", stderr);
  } finally {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
