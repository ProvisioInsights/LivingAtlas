#!/usr/bin/env -S npx tsx
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { CONTRACT_REVISION } from "@living-atlas/atlas-contract";
import { MemoryAuditJournal, type AuditEvent, type AuditJournal } from "../audit.js";
import {
  InMemoryCredentialDirectory,
  credentialResolver,
  hashCredential,
  type CredentialRecord
} from "../credentials.js";
import { PrincipalSchema } from "../principal.js";
import { serveOperatorStdio } from "./stdio.js";
import { syntheticOperatorSource } from "./testing.js";

/**
 * The operator plane's stdio entry, wired to a SYNTHETIC operational source.
 *
 * Deliberately synthetic. This binary exists so an operator client can be
 * pointed at a real 2026-07-28 server and see the operator surface — the tool
 * set, the credential refusal, the audit read path — without any real
 * deployment state being involved. Wiring a real source to it is a separate,
 * reviewable act.
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
      "The operational source is synthetic and in memory. This entry serves the SURFACE.",
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

/** Append-only, one JSON object per line, fsync-free — the log is not the graph. */
function fileAuditJournal(path: string): AuditJournal {
  mkdirSync(dirname(path), { recursive: true });
  return {
    append: (event: AuditEvent) => {
      appendFileSync(path, `${JSON.stringify(event)}\n`, "utf8");
    }
  };
}

function loadCredentials(path: string): CredentialRecord[] {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(parsed)) throw new Error("the credentials file must hold a JSON array");
  return parsed.map((entry) => {
    const record = entry as { token_hash?: unknown; principal?: unknown };
    if (typeof record.token_hash !== "string" || !record.token_hash.startsWith("sha256:")) {
      throw new Error("every credential record needs a token_hash of the form sha256:<hex>");
    }
    // Parsed here rather than trusted: the directory refuses a principal whose
    // plane and credential class disagree, and a configuration file is exactly
    // where that mismatch would otherwise be introduced.
    return { token_hash: record.token_hash, principal: PrincipalSchema.parse(record.principal) };
  });
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
const file = fileAuditJournal(auditLog);
const teed: AuditJournal = {
  append: (event) => {
    journal.append(event);
    file.append(event);
  }
};

serveOperatorStdio({
  source: syntheticOperatorSource({ journal }),
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

export { hashCredential };
