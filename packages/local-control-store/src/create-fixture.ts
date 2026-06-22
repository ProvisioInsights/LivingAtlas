#!/usr/bin/env node
import { FileLocalControlStore } from "./control-store";
import { createFixtureLocalControlState } from "./fixture";

const filePath = process.env.LIVING_ATLAS_LOCAL_CONTROL_STORE;
const passphrase = process.env.LIVING_ATLAS_LOCAL_CONTROL_STORE_PASSPHRASE;
const localMcpToken = process.env.LIVING_ATLAS_LOCAL_MCP_TOKEN;

if (!filePath || !passphrase || !localMcpToken) {
  console.error(
    "LIVING_ATLAS_LOCAL_CONTROL_STORE, LIVING_ATLAS_LOCAL_CONTROL_STORE_PASSPHRASE, and LIVING_ATLAS_LOCAL_MCP_TOKEN are required."
  );
  process.exit(1);
}

await new FileLocalControlStore(filePath).write(await createFixtureLocalControlState(localMcpToken), passphrase);
console.error(`Wrote encrypted fixture local control store: ${filePath}`);
