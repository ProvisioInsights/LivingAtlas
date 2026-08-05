import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureAuthorityId, sensitiveBaitRegistry, syntheticGraphObjects } from "@living-atlas/fixtures";
import { FileLocalControlStore, createFixtureLocalControlState } from "@living-atlas/local-control-store";
import { FileLocalGraphStore } from "@living-atlas/local-graph-store";
import { createDefaultLocalKeyring, decryptGraphObjectPayload, FileLocalKeyringStore } from "@living-atlas/local-keyring";
import {
  FileLocalMcpActivitySink,
  FileLocalMcpAuditSink,
  createLocalMcpContextFromControlState,
  localActivityRead,
  localCreateObject,
  localGraphStatus,
  localListObjects,
  localReadObject,
  localTombstoneObject,
  localUpdateObject
} from "@living-atlas/local-mcp";

/**
 * What a fresh local install must prove before anyone trusts it with a graph:
 * the control store and keyring reach disk SEALED, the graph reaches disk
 * ENCRYPTED, and no passphrase, token or payload plaintext appears in any file
 * the install wrote.
 *
 * This used to drive the 30-tool stdio server as a subprocess. That server is
 * retired (ADR 0017), and the assertions that mattered were never about the
 * transport: every one of them reads a file the install produced. They are made
 * here against the same graph commands the server used to wrap, so the leakage
 * guards keep running against a real journal instead of an empty one.
 */

const token = "local-install-smoke-token-0001";
const controlPassphrase = "local-install-smoke-control-passphrase-0001";
const keyringPassphrase = "local-install-smoke-keyring-passphrase-0001";
const timestamp = "2026-06-22T12:00:00.000Z";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

/** Narrow an untyped result member to the rows it is supposed to carry. */
function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null) : [];
}

function fixedHash(seed: string): `sha256:${string}` {
  return `sha256:${seed.repeat(64).slice(0, 64)}`;
}

function syntheticInstallObject() {
  return {
    schema_version: 1,
    authority_id: fixtureAuthorityId,
    object_id: "la_object_installsmoke0001",
    object_type: "page",
    version: 1,
    access_class: "remote-safe",
    encryption_class: "plaintext",
    created_at: timestamp,
    updated_at: timestamp,
    content_hash: fixedHash("c"),
    visible_metadata: {
      schema_namespace: "smoke/local-install",
      tombstone: false,
      size_class: "tiny",
      remote_indexable: true
    },
    payload: {
      kind: "plaintext-json",
      data: {
        title: "Synthetic install smoke object",
        body: "Fixture-only local mutation payload."
      }
    }
  };
}

function sensitiveInstallObject() {
  return {
    schema_version: 1,
    authority_id: fixtureAuthorityId,
    object_id: "la_object_installprivate0001",
    object_type: "page",
    version: 1,
    access_class: "local-private",
    encryption_class: "plaintext",
    created_at: timestamp,
    updated_at: timestamp,
    content_hash: fixedHash("e"),
    visible_metadata: {
      schema_namespace: "smoke/local-install",
      tombstone: false,
      size_class: "tiny",
      remote_indexable: false
    },
    payload: {
      kind: "plaintext-json",
      data: {
        title: "Synthetic local private install object",
        body: "Fixture-only local private payload."
      }
    }
  };
}

function assertNoSensitiveText(label: string, value: string): void {
  assert(!value.includes(token), `${label} leaked local credential token`);
  assert(!value.includes(controlPassphrase), `${label} leaked local control-store passphrase`);
  assert(!value.includes(keyringPassphrase), `${label} leaked local keyring passphrase`);
  assert(!value.includes("Synthetic install smoke object"), `${label} leaked create plaintext`);
  assert(!value.includes("Fixture-only local mutation payload."), `${label} leaked create payload`);
  assert(!value.includes("Synthetic install smoke object revised"), `${label} leaked update plaintext`);
  assert(!value.includes("Fixture-only local update payload."), `${label} leaked update payload`);
  assert(!value.includes("Synthetic local private install object"), `${label} leaked local private plaintext`);
  assert(!value.includes("Fixture-only local private payload."), `${label} leaked local private payload`);
  for (const bait of sensitiveBaitRegistry) {
    assert(!value.includes(bait.value), `${label} leaked sensitive bait: ${bait.id}`);
  }
}

async function main(): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), "living-atlas-local-install-smoke-"));
  const storePath = join(tempDir, "control-store.json");
  const keyringPath = join(tempDir, "keyring.json");
  const graphDir = join(tempDir, "graph");
  const activityPath = join(tempDir, "activity.jsonl");
  const auditPath = join(tempDir, "audit.jsonl");

  try {
    const controlState = await createFixtureLocalControlState(token);
    await new FileLocalControlStore(storePath).write(controlState, controlPassphrase);
    const sealedStore = await readFile(storePath, "utf8");
    assert(sealedStore.includes("ciphertext_base64"), "local control store was not written as a sealed envelope");
    assertNoSensitiveText("sealed local control store", sealedStore);
    console.log("ok sealed local control store");

    const keyring = createDefaultLocalKeyring({
      authorityId: fixtureAuthorityId,
      createdAt: timestamp
    });
    await new FileLocalKeyringStore(keyringPath).write(keyring, keyringPassphrase);
    const sealedKeyring = await readFile(keyringPath, "utf8");
    assert(sealedKeyring.includes("ciphertext_base64"), "local keyring was not written as a sealed envelope");
    assertNoSensitiveText("sealed local keyring", sealedKeyring);
    for (const key of keyring.keys) {
      assert(!sealedKeyring.includes(key.material_base64), "sealed local keyring leaked raw key material");
    }
    console.log("ok sealed local keyring");

    const graphStore = await FileLocalGraphStore.open({
      directory: graphDir,
      authorityId: fixtureAuthorityId,
      plaintextPersistence: "encrypt",
      keyring
    });
    const initialized = await graphStore.initializeFromObjects(syntheticGraphObjects, { created_at: timestamp });
    assert(initialized.ok === true, "synthetic encrypted graph fixture did not initialize");
    console.log("ok encrypted local graph fixture");

    const context = createLocalMcpContextFromControlState({
      controlState,
      graphStore,
      decryptPayload: (object) => decryptGraphObjectPayload(object, keyring),
      activitySink: new FileLocalMcpActivitySink(activityPath),
      auditSink: new FileLocalMcpAuditSink(auditPath),
      now: timestamp
    });
    const authorization = `Bearer ${token}`;

    const status = await localGraphStatus(context, { authorization });
    assert(status.ok === true, "status did not succeed");
    assert(status.result.object_count === 6, "status returned an unexpected object count");
    assert(status.result.profile === "local-full", "status did not authenticate as local-full");
    assert(status.result.plaintext_persistence === "encrypted", "local graph persistence was not encrypted");
    console.log("ok local graph status");

    const list = await localListObjects(context, { authorization });
    assert(list.ok === true, "object_list did not succeed");
    assert(
      list.result.objects.some((object) => object.object_id === "la_object_privatepage0001" && object.access_class === "local-private"),
      "object_list did not include the fixture local-private object"
    );
    console.log("ok local list objects");

    const read = await localReadObject(context, { authorization, object_id: "la_object_privatepage0001" });
    assert(read.ok === true, "object_read did not succeed");
    assert(read.result.object.access_class === "local-private", "object_read did not read a local-private object");
    assert(read.result.object.payload.kind === "ciphertext-ref", "object_read should return the fixture ciphertext envelope");
    console.log("ok local read object");

    const created = await localCreateObject(context, { authorization, object: syntheticInstallObject() });
    assert(created.ok === true, "object_create did not succeed");
    assert(created.result.mutation === "created", "object_create did not report created mutation");
    assert(created.result.object_count === 7, "object_create did not add one object");

    const updated = await localUpdateObject(context, {
      authorization,
      object_id: "la_object_installsmoke0001",
      expected_version: 1,
      patch: {
        content_hash: fixedHash("d"),
        visible_metadata: { size_class: "small" },
        payload: {
          kind: "plaintext-json",
          data: {
            title: "Synthetic install smoke object revised",
            body: "Fixture-only local update payload."
          }
        }
      }
    });
    assert(updated.ok === true, "object_update did not succeed");
    assert(updated.result.mutation === "updated", "object_update did not report updated mutation");
    assert(updated.result.previous_version === 1 && updated.result.new_version === 2, "object_update did not advance version");

    const tombstoned = await localTombstoneObject(context, {
      authorization,
      object_id: "la_object_installsmoke0001",
      expected_version: 2
    });
    assert(tombstoned.ok === true, "object_delete did not succeed");
    assert(tombstoned.result.mutation === "tombstoned", "object_delete did not report tombstoned mutation");
    assert(tombstoned.result.previous_version === 2 && tombstoned.result.new_version === 3, "object_delete did not advance version");

    const sensitiveCreated = await localCreateObject(context, { authorization, object: sensitiveInstallObject() });
    assert(sensitiveCreated.ok === true, "object_create did not accept a local-private plaintext draft");
    assert(sensitiveCreated.result.mutation === "created", "object_create did not create local-private draft");
    assert(sensitiveCreated.result.object.access_class === "local-private", "local-private draft changed access class");
    assert(sensitiveCreated.result.object.encryption_class === "client-encrypted", "local-private draft was not encrypted");
    assert(sensitiveCreated.result.object.payload.kind === "ciphertext-inline", "local-private draft did not return ciphertext");
    console.log("ok local CRUD commands");

    assert(existsSync(activityPath), "local activity log was not written");
    const activity = await readFile(activityPath, "utf8");
    assert(activity.includes("object_read"), "local activity log did not record the read");
    assert(activity.includes("object_create"), "local activity log did not record the create");
    assert(activity.includes("object_update"), "local activity log did not record the update");
    assert(activity.includes("object_delete"), "local activity log did not record the tombstone");
    assertNoSensitiveText("local activity log", activity);
    const activityRead = await localActivityRead(context, { authorization });
    assert(activityRead.ok === true, "activity_read did not succeed");
    // activity_read answers Record<string, unknown> — one of the untyped result
    // shapes the published contract exists to replace — so both members are
    // narrowed rather than asserted.
    assert(
      rows(activityRead.result["events"]).some((event) => event["crud"] === "create"),
      "activity_read did not return persisted create activity"
    );
    assert(
      rows(activityRead.result["audit_events"]).some((event) => event["event_type"] === "tool.allowed"),
      "activity_read did not return persisted audit events"
    );
    assertNoSensitiveText("local command output", JSON.stringify({ status, list, read, created, updated, tombstoned, sensitiveCreated }));
    console.log("ok local activity leakage guard");

    const snapshot = await readFile(join(graphDir, "snapshot.json"), "utf8");
    const journal = await readFile(join(graphDir, "journal.jsonl"), "utf8");
    const graphFiles = `${snapshot}\n${journal}`;
    assert(graphFiles.includes("AES-GCM-256+local-keyring-v1"), "local graph files did not contain local keyring ciphertext");
    assert(!graphFiles.includes("plaintext-json"), "local graph files persisted plaintext payload markers");
    assertNoSensitiveText("local encrypted graph files", graphFiles);
    console.log("ok local encrypted graph leakage guard");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
