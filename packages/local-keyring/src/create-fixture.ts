#!/usr/bin/env node
import { fixtureAuthorityId } from "@living-atlas/fixtures";
import { createDefaultLocalKeyring, FileLocalKeyringStore } from "./local-keyring";

const filePath = process.env.LIVING_ATLAS_LOCAL_KEYRING;
const passphrase = process.env.LIVING_ATLAS_LOCAL_KEYRING_PASSPHRASE;

if (!filePath || !passphrase) {
  console.error("LIVING_ATLAS_LOCAL_KEYRING and LIVING_ATLAS_LOCAL_KEYRING_PASSPHRASE are required.");
  process.exit(1);
}

await new FileLocalKeyringStore(filePath).write(createDefaultLocalKeyring({
  authorityId: fixtureAuthorityId
}), passphrase);
console.error(`Wrote encrypted fixture local keyring: ${filePath}`);
