import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  InMemoryCredentialDirectory,
  credentialResolver,
  parseCredentialRecord,
  type CredentialRecord
} from "./credentials.js";
import type { Plane, Principal, PrincipalResolution, PrincipalResolver } from "./principal.js";

/**
 * Loading a credential directory from disk, so the owner reads their own graph.
 *
 * The shipped consumer entry authenticates nobody: it serves one hardcoded
 * principal reaching `open` alone, so a migrated graph — nearly all of it
 * `local-private`, the tier atlas-core stamps on unclassified content — arrives
 * as redaction stubs rather than content. That is the grant model working, not
 * the store failing. Reading further needs a directory that maps a principal to
 * a grant that names the tier. This module is that directory, read from disk.
 *
 * What it deliberately is NOT: it is not a decryption key and it does not carry
 * one. The new store holds records CLEARTEXT at rest behind filesystem
 * permissions; withholding is an authorization decision made per read against
 * the caller's grant, not encryption. So a directory that reaches `local-private`
 * WIDENS what one principal may be shown; it never decrypts anything, and there
 * is no key material anywhere in this file. See ADR 0033.
 *
 * Three refusals govern the load, and each is a failure this system has already
 * paid for once:
 *
 *  1. **An unreadable or malformed directory is an ERROR, never a fallback.** A
 *     server that silently fell back to the open-only principal would look like
 *     it worked while serving stubs for content the owner was entitled to; one
 *     that fell back to reaching everything would be a privilege escalation by
 *     way of a typo. Both are refused at startup instead. Mirrors `store.ts`,
 *     which refuses a missing store rather than serving an empty one.
 *  2. **A grant reaches a tier only by NAMING it.** This module supplies no
 *     grant of its own — every grant is read from the file, and enforcement
 *     stays in `access.ts` where `reachesTier` is a membership test. A tier
 *     nobody wrote into a grant is unreachable, including the sealed/escalation
 *     tier, which stays behind the two-key MRTR reveal path and is not something
 *     a directory grant may name its way past by mistake.
 *  3. **The file holds HASHES, never secrets.** `parseCredentialRecord` refuses a
 *     record whose token_hash is not a `sha256:` hash, which is what keeps a
 *     credential set reviewable in a diff without being a leak.
 */

/**
 * The directory this process was told to read, house style `LIVING_ATLAS_*`.
 *
 * A DIRECTORY of one-record-per-file JSON documents, not a single file, and that
 * is deliberate: one principal per file is reviewable on its own and can carry
 * its own `0600` permissions, and adding a principal is adding a file rather than
 * editing a shared array. The operator plane reads a single admin-managed array
 * file instead — a different surface with a different custodian — and the two
 * share only the record shape, through `parseCredentialRecord`.
 */
export const CREDENTIAL_DIRECTORY_ENV = "LIVING_ATLAS_CREDENTIAL_DIR";

/** Only files with this suffix are read as credential records. */
export const CREDENTIAL_FILE_SUFFIX = ".json";

/**
 * A loaded directory, in the two shapes the entry point needs.
 *
 *  - `directory` resolves a PRESENTED secret to a principal, the existing
 *    `credentialResolver` path, unchanged. HTTP presents it as a bearer token;
 *    a consumer sharing one pipe presents it in `_meta`.
 *  - `principal(clientId)` selects the principal a CONNECTION speaks as when it
 *    presents no secret at all — the single-owner stdio case, where the pipe is
 *    the trust boundary and Claude Desktop sends no per-request credential.
 *
 * Both read out of the same records, so the tier a principal reaches is one
 * answer whether it was authenticated by a secret or selected by id.
 */
export type LoadedCredentialDirectory = {
  /** The token-hash-keyed directory, for `credentialResolver`. */
  directory: InMemoryCredentialDirectory;
  /** The principal with this `client_id`, or undefined. Ids are unique across the directory. */
  principal(clientId: string): Principal | undefined;
  /** How many records were read. */
  size: number;
  /** The principal ids present, sorted. For a startup line and a refusal message; never secrets. */
  clientIds: readonly string[];
};

/**
 * Read every credential record file under one directory.
 *
 * The whole directory is read at startup and any failure throws, so a
 * misconfiguration is a server that does not start rather than one that starts
 * degraded. Nothing here is lazy: a file that cannot be read or parsed on the
 * first request would be a file that changed the server's behaviour after it
 * reported healthy.
 */
export function loadCredentialDirectory(path: string): LoadedCredentialDirectory {
  let stat;
  try {
    stat = statSync(path);
  } catch (cause) {
    throw new Error(
      `${CREDENTIAL_DIRECTORY_ENV} names a credential directory that cannot be read: ${path}. ` +
        `It is refused rather than ignored: falling back to the open-only principal would serve ` +
        `redaction stubs for content the owner is entitled to, while looking healthy. ` +
        `(${cause instanceof Error ? cause.message : String(cause)})`
    );
  }
  if (!stat.isDirectory()) {
    throw new Error(
      `${CREDENTIAL_DIRECTORY_ENV} must name a directory of ${CREDENTIAL_FILE_SUFFIX} credential files, ` +
        `but ${path} is not a directory.`
    );
  }

  // Sorted, so two loads of the same directory read the files in the same order
  // and a duplicate-id refusal names the same file every time.
  const names = readdirSync(path)
    .filter((name) => name.endsWith(CREDENTIAL_FILE_SUFFIX))
    .sort((left, right) => left.localeCompare(right));

  const records: CredentialRecord[] = [];
  const byClientId = new Map<string, Principal>();
  for (const name of names) {
    const file = join(path, name);
    // A subdirectory whose name ends in `.json` is not a credential file; skip it
    // rather than trying to read a directory as JSON and reporting a confusing
    // parse error.
    if (!statSync(file).isFile()) continue;

    const record = readCredentialFile(file);
    if (byClientId.has(record.principal.client_id)) {
      throw new Error(
        `two credential files name the principal ${record.principal.client_id}; a principal id must be ` +
          `unique across the directory, or selecting a connection's principal by id would be ambiguous. ` +
          `The second was ${file}.`
      );
    }
    byClientId.set(record.principal.client_id, record.principal);
    records.push(record);
  }

  if (records.length === 0) {
    throw new Error(
      `${CREDENTIAL_DIRECTORY_ENV} names ${path}, which holds no ${CREDENTIAL_FILE_SUFFIX} credential files. ` +
        `An empty directory is refused rather than served: every call against it would be attributed to ` +
        `no one, which is the collapse the credential directory exists to prevent.`
    );
  }

  // Constructed once, here. `InMemoryCredentialDirectory` re-parses each principal
  // and refuses two records that share a token hash, so a duplicated secret is a
  // startup failure rather than a credential that silently shadows another.
  const directory = new InMemoryCredentialDirectory(records);

  return {
    directory,
    principal: (clientId) => byClientId.get(clientId),
    size: records.length,
    clientIds: [...byClientId.keys()].sort((left, right) => left.localeCompare(right))
  };
}

function readCredentialFile(file: string): CredentialRecord {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (cause) {
    throw new Error(
      `a credential file could not be read: ${file}. ` +
        `(${cause instanceof Error ? cause.message : String(cause)})`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error(
      `a credential file is not valid JSON: ${file}. ` +
        `(${cause instanceof Error ? cause.message : String(cause)})`
    );
  }

  try {
    // The same refusals the operator's array loader applies: a `sha256:` hash and
    // never a secret, a principal PARSED rather than trusted.
    return parseCredentialRecord(parsed);
  } catch (cause) {
    throw new Error(
      `a credential file is not a valid credential record: ${file}. ` +
        `(${cause instanceof Error ? cause.message : String(cause)})`
    );
  }
}

/**
 * The credential directory the environment names, or `undefined` when it names
 * none.
 *
 * An EMPTY value is `undefined` rather than an error, matching `store.ts`: `VAR=`
 * in a shell profile is how a variable is left unset, and treating it as a
 * request to load the directory named by the empty string would refuse to start
 * a server nobody asked to authenticate. `undefined` here is what preserves the
 * unchanged single-principal behaviour — the entry point keeps its hardcoded
 * open-only principal.
 */
export function credentialDirectoryFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>
): LoadedCredentialDirectory | undefined {
  const value = environment[CREDENTIAL_DIRECTORY_ENV];
  if (value === undefined || value.length === 0) return undefined;
  return loadCredentialDirectory(value);
}

/**
 * Resolve a request's principal from a loaded directory.
 *
 * A request that PRESENTS a secret is resolved through the directory by that
 * secret — the existing `credentialResolver`, unchanged, so the same secret over
 * a bearer header or over `_meta` reaches the same principal. A request that
 * presents NOTHING speaks as the connection's `defaultPrincipal`, if one was
 * configured: on the single-owner pipe the connection itself is the trust
 * boundary, and the owner's client sends no per-request credential, so the
 * principal the connection was launched to speak as is the honest answer. Absent
 * a default, nothing-presented is `credential-required`, exactly as before.
 *
 * The plane of the default is checked too, so a directory whose selected
 * principal belongs to another plane refuses rather than serving it here. This
 * decision consults whether a credential was presented and never how the request
 * arrived; two deployments of one directory over different channels resolve the
 * same way.
 */
export function directoryPrincipalResolver(options: {
  directory: InMemoryCredentialDirectory;
  plane: Plane;
  defaultPrincipal?: Principal;
}): PrincipalResolver {
  const bySecret = credentialResolver({ directory: options.directory, plane: options.plane });
  const fallback = options.defaultPrincipal;
  return (presented): PrincipalResolution => {
    if (presented !== undefined && presented.length > 0) return bySecret(presented);
    if (fallback === undefined) return { ok: false, reasonCode: "credential-required" };
    if (fallback.plane !== options.plane) return { ok: false, reasonCode: "credential-plane-mismatch" };
    return { ok: true, principal: fallback };
  };
}
