#!/usr/bin/env -S npx tsx
import { readFileSync } from "node:fs";
import { CONTRACT_REVISION } from "@living-atlas/atlas-contract";
import { MemoryAuditJournal, type AuditJournal } from "../audit.js";
import { DurableFileAuditJournal } from "../audit-file.js";
import {
  InMemoryCredentialDirectory,
  credentialResolver,
  hashCredential,
  parseCredentialRecord,
  type CredentialRecord
} from "../credentials.js";
import {
  STORE_DIRECTORY_ENV,
  STORE_MODE_ENV,
  openStoreFromEnvironment,
  type AtlasStore
} from "../store.js";
import type { OperatorSource } from "./source.js";
import { storeBackedOperatorSource } from "./store-source.js";
import { serveOperatorStdio } from "./stdio.js";
import { syntheticOperatorSource } from "./testing.js";

/**
 * The operator plane's stdio entry.
 *
 * Like the consumer entry, it serves one of two sources and the environment
 * decides which:
 *
 *  - `LIVING_ATLAS_STORE_DIR` unset: a SYNTHETIC operational source, so an
 *    operator client can be pointed at a real 2026-07-28 server and see the
 *    operator surface — the tool set, the credential refusal, the audit read
 *    path — without any real deployment state being involved.
 *  - `LIVING_ATLAS_STORE_DIR` set: the durable store in that directory, opened
 *    once, and an operational view that reports what the store actually knows
 *    and refuses what it does not. See `store-source.ts`.
 *
 * Both planes read the SAME variable through the same function, so a deployment
 * cannot point its consumer at one store and its operator at another by
 * spelling a variable differently — and an operator asking
 * `atlas.ops.store.status.read.v1` is asking about the store the consumer is
 * serving.
 *
 * Unlike the consumer entry, this one REQUIRES a credential directory. An
 * operator surface with no credential to check would be one whose separation
 * from the consumer plane exists only in the file layout.
 */

function usage(): never {
  process.stderr.write(
    [
      "living-atlas-atlas-operator-mcp — Living Atlas operator plane over stdio",
      "",
      `  contract revision : ${CONTRACT_REVISION}`,
      "  protocol revision : 2026-07-28 only (no legacy era, no dual era)",
      "",
      "  --audit-log <path>    Where the one-event-per-tool-call log is appended (required).",
      "  --credentials <path>  JSON array of {token_hash, principal} records (required).",
      "",
      "The credentials file holds sha256 token HASHES, never secrets. A principal in it",
      "must carry plane 'operator' and credential_class 'operator'; anything else is refused",
      "when the file is loaded rather than when a call arrives.",
      "",
      `  ${STORE_DIRECTORY_ENV}   Directory of the durable store to report on. Must already exist.`,
      "                            Unset serves a synthetic in-memory operational source instead.",
      `  ${STORE_MODE_ENV}  read-only (default) or read-write.`,
      ""
    ].join("\n")
  );
  process.exit(2);
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

function loadCredentials(path: string): CredentialRecord[] {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(parsed)) throw new Error("the credentials file must hold a JSON array");
  // `parseCredentialRecord` is shared with the consumer's directory loader so the
  // two config surfaces cannot drift on what a valid record is: the hash-not-a-
  // secret rule and the parse-not-trust rule are one function, not two copies.
  return parsed.map((entry) => parseCredentialRecord(entry));
}

const auditLog = argument("audit-log");
const credentialsPath = argument("credentials");
if (auditLog === undefined || credentialsPath === undefined) usage();

const directory = new InMemoryCredentialDirectory(loadCredentials(credentialsPath));
process.stderr.write(`[atlas-operator-mcp] ${directory.size} operator credential(s) loaded\n`);

// The audit journal is both written and read here: the operator plane's audit
// read path is served from the same log this server appends to, so a read of
// the log is itself recorded in it.
const journal = new MemoryAuditJournal();
const file = new DurableFileAuditJournal(auditLog);
const teed: AuditJournal = {
  append: (event) => {
    journal.append(event);
    // The durable leg LAST, and it is the one that may throw: `append` returns
    // only once this event would survive a crash, so a result describing work
    // whose event is not yet on disk cannot be returned. The in-memory leg
    // feeds this plane's own audit read path and is not a durability claim.
    file.append(event);
  }
};

/**
 * Opened ONCE, before the server is built — never per request, and never a
 * second handle on a store the consumer plane already holds in this process.
 * The two planes run as separate processes, which is what makes one handle each
 * safe; `store.ts` refuses the case where they do not.
 */
let store: AtlasStore | undefined;
try {
  store = openStoreFromEnvironment(process.env);
} catch (cause) {
  // Exit, rather than fall back to the synthetic source. A fallback would put an
  // operator in front of fabricated migration windows while believing they
  // described a real deployment — which is worse here than on the consumer
  // plane, because acting on them is the entire purpose of this surface.
  process.stderr.write(`[atlas-operator-mcp] ${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exit(2);
}

const source: OperatorSource =
  store === undefined
    ? syntheticOperatorSource({ journal })
    : storeBackedOperatorSource({ store, audit: () => journal.events });

if (store === undefined) {
  process.stderr.write(`[atlas-operator-mcp] no ${STORE_DIRECTORY_ENV}: serving a SYNTHETIC operational source\n`);
} else {
  const status = store.status();
  process.stderr.write(
    `[atlas-operator-mcp] store opened ${status.mode} feed_epoch=${status.feed_epoch} ` +
      `assertions=${status.assertions} entities=${status.entities} ` +
      `segment_repairs=${status.segment_repairs} ignored_files=${status.ignored_files}\n`
  );
}

const handle = serveOperatorStdio({
  source,
  auditJournal: teed,
  resolvePrincipal: credentialResolver({ directory, plane: "operator" }),
  // stderr, never stdout: stdout is the JSON-RPC wire, and a stray line on it
  // corrupts the framing for every message after it.
  onerror: (error) => process.stderr.write(`[atlas-operator-mcp] ${error.message}\n`),
  onProtocolRejection: (rejection) =>
    process.stderr.write(
      `[atlas-operator-mcp] refused ${rejection.method}: protocol revision ${rejection.requested ?? "(unnamed)"}\n`
    )
});

process.stderr.write(`[atlas-operator-mcp] ready revision=${CONTRACT_REVISION}\n`);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    store?.close();
    file.close();
    void handle.close();
    process.exit(0);
  });
}

export { hashCredential };
