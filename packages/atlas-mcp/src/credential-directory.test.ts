import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decideAssertion } from "./access.js";
import {
  CREDENTIAL_DIRECTORY_ENV,
  credentialDirectoryFromEnvironment,
  directoryPrincipalResolver,
  loadCredentialDirectory
} from "./credential-directory.js";
import { hashCredential, type CredentialRecord } from "./credentials.js";
import { reachesTier } from "./grant.js";
import type { Principal } from "./principal.js";
import {
  OWNER_GRANT,
  OWNER_PRINCIPAL,
  callTool,
  credentialEnvelope,
  seedLocalPrivateAssertion,
  seedWithheldAssertion,
  startHarness,
  syntheticGraph,
  withGrant,
  type Harness,
  type SyntheticGraph
} from "./testing.js";

/**
 * Every path here is fabricated: temp directories the test owns and removes, and
 * synthetic secrets. Nothing reads a real credential directory or a real graph.
 */

const OWNER_SECRET = "synthetic-owner-secret-not-a-real-credential";
const OPEN_SECRET = "synthetic-open-secret-not-a-real-credential";

/** An open-only consumer principal, the shape the shipped entry serves by default. */
const OPEN_PRINCIPAL: Principal = withGrant(
  { ...OWNER_PRINCIPAL, client_id: "open-consumer", credential_class: "consumer" },
  { grant_id: "grant-open-only", sensitivity_reachable: [{ tier: "open", rank: 0 }] }
);

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "atlas-credential-dir-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

function record(secret: string, principal: Principal): CredentialRecord {
  return { token_hash: hashCredential(secret), principal };
}

/** Write one credential record as a `<name>.json` file under `root`. */
function writeRecordFile(root: string, name: string, value: unknown): void {
  writeFileSync(join(root, `${name}.json`), JSON.stringify(value, null, 2), "utf8");
}

/** A directory holding the owner and the open-only principal. Returns the root. */
function ownerAndOpenDirectory(): string {
  const root = tempRoot();
  writeRecordFile(root, "owner", record(OWNER_SECRET, OWNER_PRINCIPAL));
  writeRecordFile(root, "open-consumer", record(OPEN_SECRET, OPEN_PRINCIPAL));
  return root;
}

const started: Harness[] = [];

function harness(...args: Parameters<typeof startHarness>): Harness {
  const instance = startHarness(...args);
  started.push(instance);
  return instance;
}

afterEach(async () => {
  while (started.length > 0) await started.pop()?.handle.close();
});

function structured(response: { result?: Record<string, unknown> }): Record<string, unknown> {
  return (response.result?.["structuredContent"] ?? {}) as Record<string, unknown>;
}

describe("loading a credential directory from disk", () => {
  it("reads one record per file and indexes principals by id", () => {
    const loaded = loadCredentialDirectory(ownerAndOpenDirectory());

    expect(loaded.size).toBe(2);
    expect(loaded.clientIds).toEqual(["open-consumer", "owner"]);
    expect(loaded.principal("owner")).toEqual(OWNER_PRINCIPAL);
    expect(loaded.principal("open-consumer")).toEqual(OPEN_PRINCIPAL);
    expect(loaded.principal("nobody")).toBeUndefined();

    // The same records also resolve a PRESENTED secret through the underlying
    // directory — the existing credentialResolver path is unchanged.
    expect(loaded.directory.resolve(OWNER_SECRET)?.client_id).toBe("owner");
    expect(loaded.directory.resolve(OPEN_SECRET)?.client_id).toBe("open-consumer");
    expect(loaded.directory.resolve("nonsense")).toBeUndefined();
  });

  it("ignores files that are not .json, so notes can live beside the credentials", () => {
    const root = tempRoot();
    writeRecordFile(root, "owner", record(OWNER_SECRET, OWNER_PRINCIPAL));
    writeFileSync(join(root, "README.md"), "operator notes, not a credential", "utf8");

    const loaded = loadCredentialDirectory(root);
    expect(loaded.size).toBe(1);
    expect(loaded.clientIds).toEqual(["owner"]);
  });

  it("returns undefined when the environment names no directory", () => {
    expect(credentialDirectoryFromEnvironment({})).toBeUndefined();
    // An empty value is unset, not a request to load the directory named "".
    expect(credentialDirectoryFromEnvironment({ [CREDENTIAL_DIRECTORY_ENV]: "" })).toBeUndefined();
  });

  it("loads the directory the environment names", () => {
    const root = ownerAndOpenDirectory();
    const loaded = credentialDirectoryFromEnvironment({ [CREDENTIAL_DIRECTORY_ENV]: root });
    expect(loaded?.size).toBe(2);
  });

  it("refuses a directory that does not exist, rather than falling back to open-only", () => {
    const missing = join(tempRoot(), "not-here");
    expect(() => loadCredentialDirectory(missing)).toThrow(/cannot be read/);
  });

  it("refuses a path that is a file, not a directory", () => {
    const root = tempRoot();
    const file = join(root, "creds.json");
    writeFileSync(file, JSON.stringify(record(OWNER_SECRET, OWNER_PRINCIPAL)), "utf8");
    expect(() => loadCredentialDirectory(file)).toThrow(/not a directory/);
  });

  it("refuses an empty directory rather than serving as no one", () => {
    expect(() => loadCredentialDirectory(tempRoot())).toThrow(/no .* credential files/);
  });

  it("refuses a credential file that is not valid JSON", () => {
    const root = tempRoot();
    writeFileSync(join(root, "owner.json"), "{ this is not json", "utf8");
    expect(() => loadCredentialDirectory(root)).toThrow(/not valid JSON/);
  });

  it("refuses a record whose token_hash is not a sha256 hash", () => {
    const root = tempRoot();
    writeRecordFile(root, "owner", { token_hash: "plaintext-secret", principal: OWNER_PRINCIPAL });
    expect(() => loadCredentialDirectory(root)).toThrow(/valid credential record/);
  });

  it("refuses a principal whose plane and credential class disagree", () => {
    const root = tempRoot();
    // An operator credential class on the consumer plane: PrincipalSchema refuses
    // it, at load time, not when a call finally arrives against it.
    writeRecordFile(root, "bad", {
      token_hash: hashCredential("s"),
      principal: { ...OWNER_PRINCIPAL, credential_class: "operator" }
    });
    expect(() => loadCredentialDirectory(root)).toThrow(/valid credential record/);
  });

  it("refuses two files that name the same principal id", () => {
    const root = tempRoot();
    writeRecordFile(root, "owner-a", record(OWNER_SECRET, OWNER_PRINCIPAL));
    writeRecordFile(root, "owner-b", record("another-secret", OWNER_PRINCIPAL));
    expect(() => loadCredentialDirectory(root)).toThrow(/unique across the directory/);
  });

  it("refuses two records that share a token hash", () => {
    const root = tempRoot();
    writeRecordFile(root, "owner", record(OWNER_SECRET, OWNER_PRINCIPAL));
    writeRecordFile(root, "other", record(OWNER_SECRET, OPEN_PRINCIPAL));
    // InMemoryCredentialDirectory refuses this: a shared hash means one of the
    // two credentials would be unreachable.
    expect(() => loadCredentialDirectory(root)).toThrow(/token hash/);
  });
});

describe("directoryPrincipalResolver", () => {
  it("resolves a presented secret through the directory", () => {
    const loaded = loadCredentialDirectory(ownerAndOpenDirectory());
    const resolve = directoryPrincipalResolver({
      directory: loaded.directory,
      plane: "consumer",
      defaultPrincipal: OPEN_PRINCIPAL
    });
    const outcome = resolve(OWNER_SECRET);
    expect(outcome.ok && outcome.principal.client_id).toBe("owner");
  });

  it("speaks as the connection's default principal when nothing is presented", () => {
    const loaded = loadCredentialDirectory(ownerAndOpenDirectory());
    const resolve = directoryPrincipalResolver({
      directory: loaded.directory,
      plane: "consumer",
      defaultPrincipal: OWNER_PRINCIPAL
    });
    const outcome = resolve(undefined);
    expect(outcome.ok && outcome.principal.client_id).toBe("owner");
  });

  it("refuses a request that presents nothing when there is no default", () => {
    const loaded = loadCredentialDirectory(ownerAndOpenDirectory());
    const resolve = directoryPrincipalResolver({ directory: loaded.directory, plane: "consumer" });
    expect(resolve(undefined)).toEqual({ ok: false, reasonCode: "credential-required" });
  });

  it("refuses a default principal that belongs to another plane", () => {
    const loaded = loadCredentialDirectory(ownerAndOpenDirectory());
    const operatorPrincipal: Principal = {
      client_id: "operator-one",
      credential_class: "operator",
      plane: "operator",
      grant: OWNER_GRANT
    };
    const resolve = directoryPrincipalResolver({
      directory: loaded.directory,
      plane: "consumer",
      defaultPrincipal: operatorPrincipal
    });
    expect(resolve(undefined)).toEqual({ ok: false, reasonCode: "credential-plane-mismatch" });
  });

  it("refuses an unrecognised presented secret", () => {
    const loaded = loadCredentialDirectory(ownerAndOpenDirectory());
    const resolve = directoryPrincipalResolver({
      directory: loaded.directory,
      plane: "consumer",
      defaultPrincipal: OPEN_PRINCIPAL
    });
    expect(resolve("a-secret-nobody-issued")).toEqual({ ok: false, reasonCode: "credential-unknown" });
  });
});

describe("the owner grant reaches local-private and stops before sealed", () => {
  function firstAssertion(graph: SyntheticGraph): Parameters<typeof decideAssertion>[0] {
    const page = graph.assertions.query({});
    if (!page.ok) throw new Error("the fixture query hit the history floor");
    const record = page.hits[0]?.assertion;
    if (!record) throw new Error("the fixture holds no assertion");
    return record;
  }

  it("reads a local-private record the open-only grant only sees as a stub", () => {
    const graph = syntheticGraph();
    seedLocalPrivateAssertion(graph);
    const assertion = firstAssertion(graph);

    // The owner grant names local-private, so the content is disclosed.
    expect(decideAssertion(assertion, OWNER_PRINCIPAL).allowed).toBe(true);
    // The open-only grant does not name it, so the same record is withheld.
    expect(decideAssertion(assertion, OPEN_PRINCIPAL).allowed).toBe(false);
  });

  it("does not reach the sealed tier through the owner grant", () => {
    // By name, not by rank: local-private is rank 10 and sealed is rank 90, but
    // reachability is membership, so naming local-private grants nothing about
    // sealed. A grant that reached it would make the two-key MRTR gate decorative.
    expect(reachesTier(OWNER_GRANT, "local-private")).toBe(true);
    expect(reachesTier(OWNER_GRANT, "sealed")).toBe(false);

    const graph = syntheticGraph();
    seedWithheldAssertion(graph);
    const sealed = firstAssertion(graph);
    expect(sealed.sensitivity.tier).toBe("sealed");
    // Withheld twice over for the owner: the record is marked withheld AND the
    // owner grant does not name its tier. Either alone would withhold it.
    expect(decideAssertion(sealed, OWNER_PRINCIPAL).allowed).toBe(false);
  });
});

describe("over the wire, a directory-selected owner reads its own graph", () => {
  function ownerHarness(): { graph: SyntheticGraph; instance: Harness } {
    const graph = syntheticGraph();
    seedLocalPrivateAssertion(graph);
    const loaded = loadCredentialDirectory(ownerAndOpenDirectory());
    // The connection defaults to the OPEN-ONLY principal, and a presented owner
    // secret resolves to the owner — so one server answers both, and the
    // difference between them is a property of the grant, not the transport.
    const resolvePrincipal = directoryPrincipalResolver({
      directory: loaded.directory,
      plane: "consumer",
      defaultPrincipal: OPEN_PRINCIPAL
    });
    return { graph, instance: harness({ graph, resolvePrincipal }) };
  }

  it("returns local-private content to the owner secret and a stub to the default principal", async () => {
    const { instance } = ownerHarness();

    // The owner presents its secret and reads the local-private assertion as content.
    instance.client.send(
      callTool({ id: 1, name: "atlas.assertion.query.v1", meta: credentialEnvelope(OWNER_SECRET), args: {} })
    );
    const ownerResult = structured(await instance.client.await(1));
    const ownerRecords = ownerResult["results"] as Record<string, unknown>[];
    expect(ownerRecords.some((r) => r["record_schema"] === "atlas.assertion:v1")).toBe(true);
    expect(ownerRecords.some((r) => r["record_schema"] === "atlas.redaction:v1")).toBe(false);
    expect(ownerResult["coverage"]).toMatchObject({ withheld: 0 });

    // The same query with NO credential falls to the open-only default principal
    // and sees the same record as a redaction stub instead.
    instance.client.send(callTool({ id: 2, name: "atlas.assertion.query.v1", args: {} }));
    const defaultResult = structured(await instance.client.await(2));
    const defaultRecords = defaultResult["results"] as Record<string, unknown>[];
    expect(defaultRecords.some((r) => r["record_schema"] === "atlas.redaction:v1")).toBe(true);
    expect(defaultRecords.some((r) => r["record_schema"] === "atlas.assertion:v1")).toBe(false);
    expect(defaultResult["coverage"]).toMatchObject({ withheld: 1 });
  });
});
