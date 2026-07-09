import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixtureLocalControlState, FileLocalControlStore } from "@living-atlas/local-control-store";
import { FileLocalGraphStore } from "@living-atlas/local-graph-store";
import { createDefaultLocalKeyring, decryptGraphObjectPayload, FileLocalKeyringStore } from "@living-atlas/local-keyring";
import { fixtureAuthorityId } from "@living-atlas/fixtures";
import { FileLocalMcpActivitySink } from "@living-atlas/local-mcp";
import { FileLocalMcpAuditSink } from "@living-atlas/local-mcp";
import {
  createLocalMcpContextFromControlState,
  localActivityRead,
  localCreateObject,
  localReadObject,
  localSearchObjects,
  localTimelineQuery,
  localTombstoneObject,
  localTraverseGraph,
  localUpdateObject
} from "@living-atlas/local-mcp";
import { importLogseqSemanticLocalObjects } from "./logseq-semantic-local-import";
import { runBackup } from "./backup-run";
import { restoreRunner } from "./backup-restore";

const timestamp = "2026-07-09T12:00:00.000Z";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function hash(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function tuples(store: FileLocalGraphStore): string[] {
  return store.listObjects({ include_tombstones: true })
    .map((object) => `${object.object_id}:${object.version}:${object.content_hash}`)
    .sort();
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "living-atlas-local-mvp-proof-"));
  const token = "synthetic-local-mvp-proof-token-0001";
  const controlPassphrase = "synthetic-local-mvp-control-passphrase-0001";
  const keyringPassphrase = "synthetic-local-mvp-keyring-passphrase-0001";
  const recoveryMaster = randomBytes(32);
  const paths = {
    control: join(root, "control-store.json"),
    keyring: join(root, "keyring.json"),
    graph: join(root, "graph"),
    activity: join(root, "activity.jsonl"),
    audit: join(root, "audit.jsonl"),
    staging: join(root, "backup-staging"),
    restored: join(root, "restored"),
    failedRestore: join(root, "failed-restore")
  };
  const savedEnv = new Map<string, string | undefined>();
  const backupEnv = {
    LIVING_ATLAS_BACKUP_STAGING_DIR: paths.staging,
    LIVING_ATLAS_BACKUP_RECOVERY_MASTER: recoveryMaster.toString("base64"),
    LIVING_ATLAS_LOCAL_KEYRING: paths.keyring,
    LIVING_ATLAS_LOCAL_GRAPH_DIR: paths.graph,
    LIVING_ATLAS_BACKUP_AUTHORITY_ID: fixtureAuthorityId,
    LIVING_ATLAS_BACKUP_FULL_EVERY_MS: "1",
    LIVING_ATLAS_BACKUP_R2_BUCKET: "",
    LIVING_ATLAS_BACKUP_ONEDRIVE_FOLDER: ""
  };

  try {
    for (const [key, value] of Object.entries(backupEnv)) {
      savedEnv.set(key, process.env[key]);
      process.env[key] = value;
    }

    const controlState = await createFixtureLocalControlState(token);
    await new FileLocalControlStore(paths.control).write(controlState, controlPassphrase);
    const keyring = createDefaultLocalKeyring({ authorityId: fixtureAuthorityId, createdAt: timestamp });
    await new FileLocalKeyringStore(paths.keyring).write(keyring, keyringPassphrase);

    const imported = await importLogseqSemanticLocalObjects({
      files: [{
        source_path: "pages/Synthetic Local MVP.md",
        source_kind: "logseq",
        markdown: "## Edges\n\n- [[Synthetic Person]] (person) advises [[Synthetic Project]] (project) from 2026-06\n"
      }],
      sourceRootRef: hash("synthetic-local-mvp-root"),
      sourceKind: "logseq",
      sourceMode: "logseq-notes",
      pathRedactionSecret: "synthetic-local-mvp-path-redaction-secret-0001",
      localGraphDir: paths.graph,
      keyringPath: paths.keyring,
      keyringPassphrase,
      authorityId: fixtureAuthorityId,
      recordedAt: timestamp
    });
    assert(imported.object_totals.selected_objects === imported.object_totals.planned_objects, "local import skipped planned objects");
    assert(imported.source_outcomes.length === 1, "local import did not record exactly one source outcome");
    console.log("local MVP proof: encrypted import ok");

    const source = await FileLocalGraphStore.open({
      directory: paths.graph,
      authorityId: fixtureAuthorityId,
      plaintextPersistence: "encrypt",
      keyring
    });
    const makeContext = (store: FileLocalGraphStore) => createLocalMcpContextFromControlState({
      controlState,
      graphStore: store,
      decryptPayload: (object) => decryptGraphObjectPayload(object, keyring),
      activitySink: new FileLocalMcpActivitySink(paths.activity),
      auditSink: new FileLocalMcpAuditSink(paths.audit),
      now: timestamp
    });
    const context = makeContext(source);
    const authorization = `Bearer ${token}`;
    const edgeRef = imported.object_refs.find((object) => object.object_type === "edge");
    assert(edgeRef, "local import did not produce typed edge fixture");
    const edgeRead = await localReadObject(context, { authorization, object_id: edgeRef.object_id });
    assert(edgeRead.ok && edgeRead.result.object.payload.kind === "plaintext-json", "authenticated local read did not decrypt imported edge");
    const edge = edgeRead.result.object.payload.data as { edge?: { source_object_id?: string } };
    assert(edge.edge?.source_object_id, "imported edge did not expose source endpoint after local decrypt");
    const search = await localSearchObjects(context, { authorization, query: "advises" });
    assert(search.ok && search.result.results.length > 0, "authenticated local search did not query imported graph");
    const traverse = await localTraverseGraph(context, { authorization, start_object_id: edge.edge.source_object_id });
    assert(traverse.ok && traverse.result.edges.length > 0, "authenticated local traversal did not follow imported edge");
    const timeline = await localTimelineQuery(context, { authorization, predicate: "advises" });
    assert(timeline.ok && timeline.result.results.some((result) => result.field === "edge.valid_from"), "authenticated local timeline query did not find imported edge");

    const correctionId = "la_object_localmvpcorrect0001";
    const created = await localCreateObject(context, { authorization, object: {
      schema_version: 1, authority_id: fixtureAuthorityId, object_id: correctionId, object_type: "page", version: 1,
      access_class: "local-private", encryption_class: "plaintext", created_at: timestamp, updated_at: timestamp,
      content_hash: hash("synthetic-local-mvp-correction-v1"),
      visible_metadata: { schema_namespace: "proof/local-mvp", tombstone: false, size_class: "tiny", remote_indexable: false },
      payload: { kind: "plaintext-json", data: { title: "Synthetic correction" } }
    } });
    assert(created.ok, "authenticated local create failed");
    const updated = await localUpdateObject(context, { authorization, object_id: correctionId, expected_version: 1, patch: {
      content_hash: hash("synthetic-local-mvp-correction-v2"),
      visible_metadata: { size_class: "small" }
    } });
    assert(updated.ok && updated.result.new_version === 2, "authenticated local correction update failed");
    const tombstoneId = "la_object_localmvptombstone0001";
    const tombstoneCreated = await localCreateObject(context, { authorization, object: {
      schema_version: 1, authority_id: fixtureAuthorityId, object_id: tombstoneId, object_type: "page", version: 1,
      access_class: "local-private", encryption_class: "plaintext", created_at: timestamp, updated_at: timestamp,
      content_hash: hash("synthetic-local-mvp-tombstone"),
      visible_metadata: { schema_namespace: "proof/local-mvp", tombstone: false, size_class: "tiny", remote_indexable: false },
      payload: { kind: "plaintext-json", data: { title: "Synthetic tombstone" } }
    } });
    assert(tombstoneCreated.ok, "authenticated local tombstone setup failed");
    const tombstoned = await localTombstoneObject(context, { authorization, object_id: tombstoneId, expected_version: 1 });
    assert(tombstoned.ok, "authenticated local tombstone failed");
    const activity = await localActivityRead(context, { authorization, limit: 100 });
    assert(activity.ok && Array.isArray(activity.result.events) && Array.isArray(activity.result.audit_events), "local activity/audit readback failed");
    console.log("local MVP proof: authenticated query and correction ok");

    const restarted = await FileLocalGraphStore.open({ directory: paths.graph, authorityId: fixtureAuthorityId, plaintextPersistence: "encrypt", keyring });
    console.log("local MVP proof: reopened encrypted graph");
    const afterRestart = await localReadObject(makeContext(restarted), { authorization, object_id: correctionId });
    assert(afterRestart.ok && afterRestart.result.object.version === 2, "local correction did not survive restart");
    console.log("local MVP proof: restart persistence ok");

    const sourceTuples = tuples(restarted);
    const sourceFilesBeforeFailedRestore = `${await readFile(join(paths.graph, "snapshot.json"), "utf8")}\n${await readFile(join(paths.graph, "journal.jsonl"), "utf8")}`;
    assert(await runBackup(1_000) === 0, "encrypted local backup failed");
    console.log("local MVP proof: encrypted backup ok");
    await restoreRunner({ backupId: "la_backup_000001", storeDir: paths.staging, outDir: paths.restored }, recoveryMaster);
    console.log("local MVP proof: restore artifact verified");
    const restoredKeyring = await new FileLocalKeyringStore(join(paths.restored, "keyring.json")).read(keyringPassphrase);
    const restored = await FileLocalGraphStore.open({ directory: join(paths.restored, "graph"), plaintextPersistence: "encrypt", keyring: restoredKeyring });
    assert(restored.status().authority_id === restarted.status().authority_id, "restored authority mismatch");
    assert(restored.status().generation === restarted.status().generation, "restored generation mismatch");
    assert(restored.status().object_count === restarted.status().object_count, "restored object count mismatch");
    assert(JSON.stringify(tuples(restored)) === JSON.stringify(sourceTuples), "restored object tuple set mismatch");
    await restoreRunner({ backupId: "la_backup_000001", storeDir: paths.staging, outDir: paths.failedRestore }, randomBytes(32)).then(
      () => { throw new Error("restore accepted an invalid recovery master"); },
      () => undefined
    );
    const sourceFilesAfterFailedRestore = `${await readFile(join(paths.graph, "snapshot.json"), "utf8")}\n${await readFile(join(paths.graph, "journal.jsonl"), "utf8")}`;
    assert(sourceFilesAfterFailedRestore === sourceFilesBeforeFailedRestore, "failed restore altered source replica");

    const localLogs = `${await readFile(paths.activity, "utf8")}\n${await readFile(paths.audit, "utf8")}`;
    for (const secret of [token, controlPassphrase, keyringPassphrase, "Synthetic Person", "Synthetic Project", "Synthetic correction"]) {
      assert(!localLogs.includes(secret), "local MVP proof leaked a secret or plaintext into audit output");
    }
    console.log(`LOCAL_MVP_PROOF_OK authority=${restored.status().authority_id} generation=${restored.status().generation} objects=${restored.status().object_count} tuple_set_sha=${hash(JSON.stringify(tuples(restored))).slice(0, 20)}`);
  } finally {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
