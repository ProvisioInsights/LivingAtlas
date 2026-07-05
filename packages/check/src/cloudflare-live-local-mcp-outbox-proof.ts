import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  GraphObjectEnvelopeSchema,
  type GraphObjectEnvelope
} from "@living-atlas/contracts";
import { FileLocalControlStore } from "@living-atlas/local-control-store";
import { FileLocalGraphStore } from "@living-atlas/local-graph-store";
import { resolveLocalSecret } from "@living-atlas/local-keyring";
import {
  FileLocalMcpMutationOutboxSink,
  createLocalMcpContextFromControlState,
  localCreateObject,
  localReadObject,
  localTombstoneObject,
  localUpdateObject
} from "@living-atlas/local-mcp";
import {
  printCloudflareLiveUsageGateResult,
  runCloudflareLiveUsageGate
} from "./cloudflare-live-usage-gate";

const ackEnv = "LIVING_ATLAS_LIVE_LOCAL_MCP_OUTBOX_ACK";
const ackValue = "queues-local-mcp-crud-for-sync";

type RuntimeEnv = {
  replicaDir: string;
  controlStorePath: string;
  controlStorePassphrase: string;
  graphDir: string;
  outboxDir: string;
  localMcpToken: string;
};

function envValue(key: string): string | undefined {
  const value = process.env[key]?.trim();
  return value ? value : undefined;
}

function digest(value: string, length = 24): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function defaultReplicaDir(): string {
  const environmentName = envValue("LIVING_ATLAS_ENV") ?? "default";
  return join(homedir(), "Library", "Application Support", "LivingAtlas", environmentName);
}

function parseRuntimeEnvFile(value: string): Record<string, string> {
  const output: Record<string, string> = {};
  for (const line of value.split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!match) {
      continue;
    }
    const raw = match[2] ?? "";
    output[match[1]!] = raw.startsWith("\"") && raw.endsWith("\"")
      ? JSON.parse(raw)
      : raw;
  }
  return output;
}

async function readRuntimeEnv(): Promise<RuntimeEnv> {
  const replicaDir = envValue("LIVING_ATLAS_LOCAL_REPLICA_DIR") ?? defaultReplicaDir();
  const envPath = join(replicaDir, "local-runtime.env");
  const fileValues = existsSync(envPath)
    ? parseRuntimeEnvFile(await readFile(envPath, "utf8"))
    : {};
  const controlStorePath = envValue("LIVING_ATLAS_LOCAL_CONTROL_STORE") ?? fileValues.LIVING_ATLAS_LOCAL_CONTROL_STORE;
  const controlStorePassphrase = envValue("LIVING_ATLAS_LOCAL_CONTROL_STORE_PASSPHRASE")
    ?? fileValues.LIVING_ATLAS_LOCAL_CONTROL_STORE_PASSPHRASE
    ?? resolveLocalSecret("LIVING_ATLAS_LOCAL_CONTROL_STORE_PASSPHRASE", {
      env: { LIVING_ATLAS_LOCAL_CONTROL_STORE_PASSPHRASE_KEYCHAIN_SERVICE: fileValues.LIVING_ATLAS_LOCAL_CONTROL_STORE_PASSPHRASE_KEYCHAIN_SERVICE }
    })?.value;
  const graphDir = envValue("LIVING_ATLAS_LOCAL_GRAPH_DIR") ?? fileValues.LIVING_ATLAS_LOCAL_GRAPH_DIR;
  const outboxDir = envValue("LIVING_ATLAS_LOCAL_SYNC_OUTBOX_DIR") ?? fileValues.LIVING_ATLAS_LOCAL_SYNC_OUTBOX_DIR;
  const localMcpToken = envValue("LIVING_ATLAS_LOCAL_MCP_TOKEN")
    ?? fileValues.LIVING_ATLAS_LOCAL_MCP_TOKEN
    ?? resolveLocalSecret("LIVING_ATLAS_LOCAL_MCP_TOKEN", {
      env: { LIVING_ATLAS_LOCAL_MCP_TOKEN_KEYCHAIN_SERVICE: fileValues.LIVING_ATLAS_LOCAL_MCP_TOKEN_KEYCHAIN_SERVICE }
    })?.value;

  if (!controlStorePath || !controlStorePassphrase || !graphDir || !outboxDir || !localMcpToken) {
    throw new Error(`local runtime env is incomplete at ${envPath}; run bidirectional sync setup first`);
  }

  return {
    replicaDir,
    controlStorePath,
    controlStorePassphrase,
    graphDir,
    outboxDir,
    localMcpToken
  };
}

function proofObject(authorityId: string): GraphObjectEnvelope {
  const seed = `${Date.now()}:${randomBytes(8).toString("hex")}:local-mcp-outbox-proof`;
  const nonce = randomBytes(12).toString("base64");
  const ciphertext = Buffer.from(`living-atlas-local-mcp-outbox-proof:${seed}`).toString("base64");
  const now = new Date().toISOString();
  return GraphObjectEnvelopeSchema.parse({
    schema_version: 1,
    authority_id: authorityId,
    object_id: `la_object_mcpoutbox${digest(seed, 14)}`,
    object_type: "page",
    version: 1,
    access_class: "local-private",
    encryption_class: "client-encrypted",
    created_at: now,
    updated_at: now,
    content_hash: sha256(`${nonce}:${ciphertext}`),
    key_ref: `la_key_mcpoutbox${digest(`${seed}:key`, 14)}`,
    visible_metadata: {
      schema_namespace: "sync/local-mcp-outbox-proof",
      tombstone: false,
      size_class: "tiny",
      remote_indexable: false
    },
    payload: {
      kind: "ciphertext-inline",
      ciphertext,
      nonce,
      algorithm: "aes-256-gcm"
    }
  });
}

function nextCiphertextObject(object: GraphObjectEnvelope, label: string, tombstone = false): GraphObjectEnvelope {
  const nonce = randomBytes(12).toString("base64");
  const ciphertext = Buffer.from(`${label}:${object.object_id}:v${object.version + 1}`).toString("base64");
  return GraphObjectEnvelopeSchema.parse({
    ...object,
    version: object.version + 1,
    updated_at: new Date().toISOString(),
    content_hash: sha256(`${nonce}:${ciphertext}`),
    visible_metadata: {
      ...object.visible_metadata,
      tombstone
    },
    payload: {
      kind: "ciphertext-inline",
      ciphertext,
      nonce,
      algorithm: "aes-256-gcm"
    }
  });
}

async function main(): Promise<void> {
  if (envValue(ackEnv) !== ackValue) {
    console.error(`${ackEnv} must equal ${ackValue}`);
    process.exitCode = 2;
    return;
  }

  const gate = await runCloudflareLiveUsageGate();
  printCloudflareLiveUsageGateResult(gate);
  if (!gate.ok) {
    process.exitCode = 2;
    return;
  }

  const runtime = await readRuntimeEnv();
  const controlState = await new FileLocalControlStore(runtime.controlStorePath).read(runtime.controlStorePassphrase);
  const graphStore = await FileLocalGraphStore.open({
    directory: runtime.graphDir,
    authorityId: controlState.authority_id,
    plaintextPersistence: "redact"
  });
  const context = createLocalMcpContextFromControlState({
    controlState,
    graphStore,
    outboxSink: new FileLocalMcpMutationOutboxSink(runtime.outboxDir)
  });
  const authorization = `Bearer ${runtime.localMcpToken}`;
  const createdObject = proofObject(controlState.authority_id);

  const created = await localCreateObject(context, {
    authorization,
    object: createdObject
  });
  if (!created.ok) {
    throw new Error(`local MCP create failed: ${created.reason}`);
  }

  const read = await localReadObject(context, {
    authorization,
    object_id: createdObject.object_id
  });
  if (!read.ok) {
    throw new Error(`local MCP read after create failed: ${read.reason}`);
  }

  const updatedEnvelope = nextCiphertextObject(createdObject, "local-mcp-outbox-update");
  const updated = await localUpdateObject(context, {
    authorization,
    object_id: createdObject.object_id,
    expected_version: 1,
    patch: {
      updated_at: updatedEnvelope.updated_at,
      content_hash: updatedEnvelope.content_hash,
      payload: updatedEnvelope.payload
    }
  });
  if (!updated.ok) {
    throw new Error(`local MCP update failed: ${updated.reason}`);
  }

  const tombstoned = await localTombstoneObject(context, {
    authorization,
    object_id: createdObject.object_id,
    expected_version: 2
  });
  if (!tombstoned.ok) {
    throw new Error(`local MCP tombstone failed: ${tombstoned.reason}`);
  }

  console.log("Living Atlas local MCP outbox proof queued");
  console.log(`replica_dir=${runtime.replicaDir}`);
  console.log(`outbox=${runtime.outboxDir}`);
  console.log(`object_id=${createdObject.object_id}`);
  console.log(`queued_mutations=3; local_generation=${graphStore.status().generation}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
