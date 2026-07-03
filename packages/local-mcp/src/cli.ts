#!/usr/bin/env node
import { FileLocalControlStore, createFixtureLocalControlState } from "@living-atlas/local-control-store";
import { FileLocalGraphStore } from "@living-atlas/local-graph-store";
import { FileLocalKeyringStore, resolveLocalSecret } from "@living-atlas/local-keyring";
import { syntheticGraphObjects } from "@living-atlas/fixtures";
import { FileLocalMcpActivitySink } from "./activity";
import { InMemoryLocalMcpAuditSink } from "./audit";
import { createLocalMcpContextFromControlState } from "./local-graph";
import { FileLocalMcpMutationOutboxSink } from "./outbox";
import { runLivingAtlasLocalMcpStdio } from "./server";
import type { LocalControlState } from "@living-atlas/contracts";

async function loadControlState() {
  const storePath = process.env.LIVING_ATLAS_LOCAL_CONTROL_STORE;
  const passphrase = resolveLocalSecret("LIVING_ATLAS_LOCAL_CONTROL_STORE_PASSPHRASE")?.value;
  const fixtureToken = process.env.LIVING_ATLAS_LOCAL_MCP_TOKEN;

  if (storePath && passphrase) {
    return new FileLocalControlStore(storePath).read(passphrase);
  }

  if (fixtureToken) {
    return createFixtureLocalControlState(fixtureToken);
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

const controlState = await loadControlState();

await runLivingAtlasLocalMcpStdio(
  createLocalMcpContextFromControlState({
    controlState,
    graphStore: await loadGraphStore(controlState),
    auditSink: new InMemoryLocalMcpAuditSink(),
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

async function loadGraphStore(controlState: LocalControlState): Promise<FileLocalGraphStore | undefined> {
  const directory = process.env.LIVING_ATLAS_LOCAL_GRAPH_DIR;
  if (!directory) {
    return undefined;
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

  if (store.status().object_count === 0) {
    const initialized = await store.initializeFromObjects(syntheticGraphObjects);
    if (!initialized.ok) {
      throw new Error(`Failed to initialize local graph store: ${initialized.reason}`);
    }
  }

  return store;
}
