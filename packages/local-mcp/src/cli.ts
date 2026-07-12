#!/usr/bin/env node
import { FileLocalControlStore, createFixtureLocalControlState } from "@living-atlas/local-control-store";
import { FileLocalGraphStore } from "@living-atlas/local-graph-store";
import { decryptGraphObjectPayload, FileLocalKeyringStore, resolveLocalSecret } from "@living-atlas/local-keyring";
import { syntheticGraphObjects } from "@living-atlas/fixtures";
import { FileLocalMcpActivitySink } from "./activity";
import { FileLocalMcpAuditSink, InMemoryLocalMcpAuditSink } from "./audit";
import { createLocalMcpContextFromControlState } from "./local-graph";
import { FileLocalMcpMutationOutboxSink } from "./outbox";
import { runLivingAtlasLocalMcpStdio } from "./server";
import type { LocalControlState } from "@living-atlas/contracts";

async function loadControlState(): Promise<{ controlState: LocalControlState; fixtureMode: boolean }> {
  const storePath = process.env.LIVING_ATLAS_LOCAL_CONTROL_STORE;
  const passphrase = resolveLocalSecret("LIVING_ATLAS_LOCAL_CONTROL_STORE_PASSPHRASE")?.value;
  const fixtureToken = process.env.LIVING_ATLAS_LOCAL_MCP_TOKEN;

  if (storePath && passphrase) {
    return {
      controlState: await new FileLocalControlStore(storePath).read(passphrase),
      fixtureMode: false
    };
  }

  if (fixtureToken) {
    return {
      controlState: await createFixtureLocalControlState(fixtureToken),
      fixtureMode: true
    };
  }

  console.error(
    "Set LIVING_ATLAS_LOCAL_CONTROL_STORE and LIVING_ATLAS_LOCAL_CONTROL_STORE_PASSPHRASE, or set LIVING_ATLAS_LOCAL_MCP_TOKEN for the synthetic fixture mode."
  );
  process.exit(1);
}

function localMcpAuthorizationHeader(): string | undefined {
  if (process.env.LIVING_ATLAS_LOCAL_MCP_AUTHORIZATION) {
    return process.env.LIVING_ATLAS_LOCAL_MCP_AUTHORIZATION;
  }

  if (process.env.LIVING_ATLAS_LOCAL_MCP_TOKEN) {
    return `Bearer ${process.env.LIVING_ATLAS_LOCAL_MCP_TOKEN}`;
  }

  return undefined;
}

const { controlState, fixtureMode } = await loadControlState();
const localGraph = await loadGraphStore(controlState, fixtureMode);

await runLivingAtlasLocalMcpStdio(
  createLocalMcpContextFromControlState({
    controlState,
    graphStore: localGraph.graphStore,
    decryptPayload: localGraph.decryptPayload,
    auditSink: process.env.LIVING_ATLAS_AUDIT_LOG
      ? new FileLocalMcpAuditSink(process.env.LIVING_ATLAS_AUDIT_LOG)
      : new InMemoryLocalMcpAuditSink(),
    activitySink: process.env.LIVING_ATLAS_ACTIVITY_LOG
      ? new FileLocalMcpActivitySink(process.env.LIVING_ATLAS_ACTIVITY_LOG)
      : undefined,
    outboxSink: process.env.LIVING_ATLAS_LOCAL_SYNC_OUTBOX_DIR
      ? new FileLocalMcpMutationOutboxSink(process.env.LIVING_ATLAS_LOCAL_SYNC_OUTBOX_DIR)
      : undefined
  }),
  {
    authorizationHeader: localMcpAuthorizationHeader()
  }
);

async function loadGraphStore(
  controlState: LocalControlState,
  fixtureMode: boolean
): Promise<{
  graphStore?: FileLocalGraphStore;
  decryptPayload?: Parameters<typeof decryptGraphObjectPayload>[0] extends infer Object
    ? (object: Object) => ReturnType<typeof decryptGraphObjectPayload>
    : never;
}> {
  const directory = process.env.LIVING_ATLAS_LOCAL_GRAPH_DIR;
  if (!directory) {
    return {};
  }
  const keyringPath = process.env.LIVING_ATLAS_LOCAL_KEYRING;
  const keyringPassphrase = resolveLocalSecret("LIVING_ATLAS_LOCAL_KEYRING_PASSPHRASE")?.value;
  const keyring = keyringPath && keyringPassphrase
    ? await new FileLocalKeyringStore(keyringPath).read(keyringPassphrase)
    : undefined;

  const store = await FileLocalGraphStore.open({
    directory,
    authorityId: controlState.authority_id,
    plaintextPersistence: process.env.LIVING_ATLAS_LOCAL_GRAPH_PLAINTEXT === "allow" ? "allow" : keyring ? "encrypt" : "redact",
    keyring
  });

  if (fixtureMode && store.status().object_count === 0) {
    const initialized = await store.initializeFromObjects(syntheticGraphObjects);
    if (!initialized.ok) {
      throw new Error(`Failed to initialize local graph store: ${initialized.reason}`);
    }
  }

  return {
    graphStore: store,
    decryptPayload: keyring ? (object) => decryptGraphObjectPayload(object, keyring) : undefined
  };
}
