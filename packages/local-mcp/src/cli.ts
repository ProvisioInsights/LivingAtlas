#!/usr/bin/env node
import { FileLocalControlStore, createFixtureLocalControlState } from "@living-atlas/local-control-store";
import { FileLocalMcpActivitySink } from "./activity";
import { InMemoryLocalMcpAuditSink } from "./audit";
import { createLocalMcpContextFromControlState } from "./local-graph";
import { runLivingAtlasLocalMcpStdio } from "./server";

async function loadControlState() {
  const storePath = process.env.LIVING_ATLAS_LOCAL_CONTROL_STORE;
  const passphrase = process.env.LIVING_ATLAS_LOCAL_CONTROL_STORE_PASSPHRASE;
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

await runLivingAtlasLocalMcpStdio(
  createLocalMcpContextFromControlState({
    controlState: await loadControlState(),
    auditSink: new InMemoryLocalMcpAuditSink(),
    activitySink: process.env.LIVING_ATLAS_ACTIVITY_LOG
      ? new FileLocalMcpActivitySink(process.env.LIVING_ATLAS_ACTIVITY_LOG)
      : undefined
  }),
  {
    authorizationHeader: localMcpAuthorizationHeader()
  }
);
