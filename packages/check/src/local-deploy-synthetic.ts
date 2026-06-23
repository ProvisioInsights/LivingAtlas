import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fixtureAuthorityId, fixtureDeviceId, fixtureUserId, sensitiveBaitRegistry } from "@living-atlas/fixtures";
import {
  FileLocalControlStore,
  createFixtureLocalControlState,
  createLocalProfile
} from "@living-atlas/local-control-store";
import { SyntheticLocalSyncDaemon } from "@living-atlas/sync-agent";
import { BootstrapClaimLockCore, InMemoryBootstrapClaimLockStorage } from "../../cloudflare-worker/src/bootstrap-lock";
import { sha256TokenHash } from "../../cloudflare-worker/src/bootstrap";
import type { BootstrapWorkerEnv } from "../../cloudflare-worker/src/worker";
import { LocalD1Database, LocalR2Bucket, createWorkerFetch } from "./local-worker-harness";

type JsonObject = Record<string, unknown>;

const baseUrl = "https://living-atlas.local";
const bootstrapToken = "synthetic-local-deploy-bootstrap-token-0001";
const localMcpToken = "synthetic-local-deploy-mcp-token-0001";
const passphrase = "synthetic-local-deploy-passphrase-0001";
const syncToken = "synthetic-local-deploy-sync-token-0001";
const syncTokenId = "la_sync_token_localdeploy0001";
const now = "2026-06-22T12:00:00.000Z";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function fixedHash(seed: string): `sha256:${string}` {
  return `sha256:${seed.repeat(64).slice(0, 64)}`;
}

function textContent(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return "";
  }

  const first = content[0] as { type?: unknown; text?: unknown } | undefined;
  return first?.type === "text" && typeof first.text === "string" ? first.text : "";
}

function parseToolJson<T>(label: string, result: unknown, outputs: string[]): T {
  const text = textContent(result);
  outputs.push(text);
  assert(text.length > 0, `${label} did not return text content`);
  return JSON.parse(text) as T;
}

function syntheticObject(objectId: string, title: string) {
  return {
    schema_version: 1,
    authority_id: fixtureAuthorityId,
    object_id: objectId,
    object_type: "page",
    version: 1,
    access_class: "remote-safe",
    encryption_class: "plaintext",
    created_at: now,
    updated_at: now,
    content_hash: fixedHash("e"),
    visible_metadata: {
      schema_namespace: "synthetic/local-deploy",
      tombstone: false,
      size_class: "tiny",
      remote_indexable: true
    },
    payload: {
      kind: "plaintext-json",
      data: {
        title,
        body: "Synthetic local deployment exercise payload."
      }
    }
  };
}

function assertNoLeak(label: string, value: string): void {
  for (const secret of [bootstrapToken, localMcpToken, passphrase, syncToken]) {
    assert(!value.includes(secret), `${label} leaked secret material`);
  }

  for (const bait of sensitiveBaitRegistry) {
    assert(!value.includes(bait.value), `${label} leaked sensitive bait: ${bait.id}`);
  }
}

async function expectWorkerJson<T extends JsonObject>(
  label: string,
  response: Response,
  expectedStatus: number,
  outputs: string[]
): Promise<T> {
  const text = await response.text();
  outputs.push(text);
  assert(response.status === expectedStatus, `${label} expected HTTP ${expectedStatus}, got ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}

async function exerciseLocalMcp(input: {
  repoRoot: string;
  tempDir: string;
  controlStorePath: string;
  activityLogPath: string;
  outputs: string[];
}): Promise<void> {
  let client: Client | undefined;
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "packages/local-mcp/src/cli.ts"],
    cwd: input.repoRoot,
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: input.tempDir,
      LIVING_ATLAS_LOCAL_CONTROL_STORE: input.controlStorePath,
      LIVING_ATLAS_LOCAL_CONTROL_STORE_PASSPHRASE: passphrase,
      LIVING_ATLAS_LOCAL_MCP_TOKEN: localMcpToken,
      LIVING_ATLAS_ACTIVITY_LOG: input.activityLogPath
    }
  });
  const stderrChunks: string[] = [];
  transport.stderr?.on("data", (chunk) => {
    stderrChunks.push(Buffer.from(chunk).toString("utf8"));
  });

  try {
    client = new Client({ name: "living-atlas-local-deploy-synthetic", version: "0.1.0" });
    await client.connect(transport);

    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name).sort();
    for (const required of [
      "status",
      "object_list",
      "object_read",
      "object_create",
      "object_update",
      "object_delete"
    ]) {
      assert(toolNames.includes(required), `local MCP missing tool ${required}`);
    }
    input.outputs.push(JSON.stringify(toolNames));

    const initialStatus = parseToolJson<{
      ok: boolean;
      result?: { object_count?: number; profile?: string };
    }>("status", await client.callTool({ name: "status", arguments: {} }), input.outputs);
    assert(initialStatus.ok === true, "status failed");
    assert(initialStatus.result?.object_count === 6, "local graph did not start with six fixture objects");
    assert(initialStatus.result.profile === "local-full", "local MCP did not authenticate as local-full");

    const privateRead = parseToolJson<{
      ok: boolean;
      result?: { object?: { access_class?: string; payload?: { kind?: string } } };
    }>("object_read", await client.callTool({
      name: "object_read",
      arguments: { object_id: "la_object_privatepage0001" }
    }), input.outputs);
    assert(privateRead.ok === true, "local private read failed");
    assert(privateRead.result?.object?.access_class === "local-private", "local private read returned wrong class");
    assert(privateRead.result.object.payload?.kind === "ciphertext-ref", "local private fixture should be ciphertext envelope in this slice");

    const created = parseToolJson<{
      ok: boolean;
      result?: { mutation?: string; object_count?: number; new_version?: number };
    }>("object_create", await client.callTool({
      name: "object_create",
      arguments: {
        object: syntheticObject("la_object_localdeploy0001", "Synthetic local deploy object")
      }
    }), input.outputs);
    assert(created.ok === true, "local create failed");
    assert(created.result?.mutation === "created", "local create did not report created");
    assert(created.result.object_count === 7 && created.result.new_version === 1, "local create returned unexpected version/count");

    const updated = parseToolJson<{
      ok: boolean;
      result?: { mutation?: string; previous_version?: number; new_version?: number };
    }>("object_update", await client.callTool({
      name: "object_update",
      arguments: {
        object_id: "la_object_localdeploy0001",
        expected_version: 1,
        patch: {
          content_hash: fixedHash("f"),
          visible_metadata: { size_class: "small" },
          payload: {
            kind: "plaintext-json",
            data: {
              title: "Synthetic local deploy object revised",
              body: "Synthetic local deployment update payload."
            }
          }
        }
      }
    }), input.outputs);
    assert(updated.ok === true, "local update failed");
    assert(updated.result?.previous_version === 1 && updated.result.new_version === 2, "local update did not advance version");

    const versionConflict = parseToolJson<{ ok: boolean; reason?: string }>(
      "object_update_conflict",
      await client.callTool({
        name: "object_update",
        arguments: {
          object_id: "la_object_localdeploy0001",
          expected_version: 1,
          patch: {
            visible_metadata: { size_class: "medium" }
          }
        }
      }),
      input.outputs
    );
    assert(versionConflict.ok === false && versionConflict.reason === "version-conflict", "local update did not detect version conflict");

    const tombstoned = parseToolJson<{
      ok: boolean;
      result?: { mutation?: string; previous_version?: number; new_version?: number };
    }>("object_delete", await client.callTool({
      name: "object_delete",
      arguments: {
        object_id: "la_object_localdeploy0001",
        expected_version: 2
      }
    }), input.outputs);
    assert(tombstoned.ok === true, "local tombstone failed");
    assert(tombstoned.result?.previous_version === 2 && tombstoned.result.new_version === 3, "local tombstone did not advance version");

    for (let index = 2; index <= 5; index += 1) {
      const bulkCreate = parseToolJson<{
        ok: boolean;
        result?: { mutation?: string; new_version?: number };
      }>(`object_create_bulk_${index}`, await client.callTool({
        name: "object_create",
        arguments: {
          object: syntheticObject(`la_object_localdeploy000${index}`, `Synthetic local deploy object ${index}`)
        }
      }), input.outputs);
      assert(bulkCreate.ok === true, `bulk local create ${index} failed`);
      assert(bulkCreate.result?.mutation === "created" && bulkCreate.result.new_version === 1, `bulk local create ${index} returned unexpected result`);
    }

    const finalStatus = parseToolJson<{
      ok: boolean;
      result?: { object_count?: number };
    }>("status_final", await client.callTool({ name: "status", arguments: {} }), input.outputs);
    assert(finalStatus.ok === true && finalStatus.result?.object_count === 11, "local graph final object count should include bulk objects and tombstone");
    console.log("ok local MCP deploy lifecycle");
  } finally {
    await client?.close();
    assertNoLeak("local MCP stderr", stderrChunks.join("\n"));
  }
}

async function exerciseLocalWorkerAndSyncDaemon(input: {
  controlState: Awaited<ReturnType<typeof createFixtureLocalControlState>>;
  outputs: string[];
}): Promise<void> {
  const graphBucket = new LocalR2Bucket(now);
  const controlDb = new LocalD1Database();
  const claimLock = new BootstrapClaimLockCore(new InMemoryBootstrapClaimLockStorage());
  const syncClient = input.controlState.control_plane.clients.find((client) => client.allowed_profile === "sync-device");
  const syncCapability = input.controlState.control_plane.capabilities.find((capability) => capability.profile === "sync-device");
  assert(syncClient?.client_id, "fixture missing sync client");
  assert(syncCapability?.capability_id, "fixture missing sync capability");

  const env: BootstrapWorkerEnv = {
    BOOTSTRAP_CLAIM_LOCK: {
      getByName: () => claimLock
    },
    LA_GRAPH_BUCKET: graphBucket as unknown as R2Bucket,
    LA_CONTROL_DB: controlDb as unknown as D1Database,
    LA_AUTHORITY_ID: fixtureAuthorityId,
    BOOTSTRAP_CLAIM_TOKEN_HASH: await sha256TokenHash(bootstrapToken),
    BOOTSTRAP_TOKEN_EXPIRES_AT: "2099-01-01T00:00:00.000Z",
    LA_SYNC_TOKEN_HASH: await sha256TokenHash(syncToken),
    LA_SYNC_CLIENT_ID: syncClient.client_id,
    LA_SYNC_CAPABILITY_ID: syncCapability.capability_id,
    LA_SYNC_TOKEN_ID: syncTokenId
  };
  const workerFetch = createWorkerFetch(env);

  const bootstrapStatus = await expectWorkerJson<{ bootstrap_state?: string }>(
    "bootstrap status",
    await workerFetch(new URL("/api/bootstrap/status", baseUrl), {
      headers: {
        "x-living-atlas-bootstrap-token": bootstrapToken
      }
    }),
    200,
    input.outputs
  );
  assert(bootstrapStatus.bootstrap_state === "unclaimed", "local Worker should start unclaimed with bootstrap hash");

  const claim = await expectWorkerJson<{ ok?: boolean }>(
    "bootstrap claim",
    await workerFetch(new URL("/api/bootstrap/claim", baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-living-atlas-bootstrap-token": bootstrapToken
      },
      body: JSON.stringify({
        authority_id: fixtureAuthorityId,
        user_id: fixtureUserId,
        device_id: fixtureDeviceId,
        device_public_key_hash: "synthetic-local-deploy-device-public-key-hash",
        policy_generation: 1,
        wrapped_keys: [
          {
            key_id: "la_key_localdeploy0001",
            wrapping_device_id: fixtureDeviceId,
            algorithm: "synthetic-fixture",
            ciphertext: "synthetic-local-deploy-wrapped-key"
          }
        ],
        initial_remote_config: {
          fixture_only: true
        }
      })
    }),
    201,
    input.outputs
  );
  assert(claim.ok === true, "local Worker bootstrap claim failed");

  const daemon = new SyntheticLocalSyncDaemon({
    controlState: input.controlState,
    endpoint: baseUrl,
    syncToken,
    tokenId: syncTokenId,
    fetchImpl: workerFetch
  });
  const initialPlan = await daemon.planFromRemoteStatus();
  assert(initialPlan.ok === true, "sync daemon initial remote status failed");
  assert(initialPlan.plan.action === "idle", "sync daemon should start idle against empty local Worker");

  const queued = daemon.queueCiphertextBatch({ now });
  assert(queued.included_object_count === 3, "sync daemon should queue three ciphertext envelopes");
  assert(queued.withheld_plaintext_count === 3, "sync daemon should withhold three plaintext fixtures");
  assert(daemon.planFromStatus(initialPlan.status).action === "push", "sync daemon should plan push with pending outbox");

  const submitted = await daemon.submitNextPending({ acceptedAt: "2026-06-22T12:00:01.000Z" });
  assert(submitted.ok === true && submitted.submitted === true, "sync daemon push did not submit");
  assert(submitted.accepted.accepted_objects === 3 && submitted.accepted.target_generation === 1, "sync daemon push accepted unexpected batch");
  assert(graphBucket.puts.length === 3, "local Worker should store three R2 envelopes");

  const postPushPlan = await daemon.planFromRemoteStatus();
  assert(postPushPlan.ok === true, "sync daemon post-push status failed");
  assert(postPushPlan.status.latest_generation === 1, "local Worker generation did not advance");
  assert(postPushPlan.plan.action === "idle", "sync daemon should be idle after accepted push");

  const pullDaemon = new SyntheticLocalSyncDaemon({
    controlState: input.controlState,
    endpoint: baseUrl,
    syncToken,
    tokenId: syncTokenId,
    fetchImpl: workerFetch
  });
  const pullPlan = await pullDaemon.planFromRemoteStatus();
  assert(pullPlan.ok === true && pullPlan.plan.action === "pull", "fresh local daemon should plan pull from generation 0");
  const pull = await pullDaemon.fetchPlannedPull(pullPlan);
  assert(pull.ok === true && pull.skipped === false, "fresh local daemon pull failed");
  assert(pull.response.batches.length === 1 && pull.response.next_cursor.generation === 1, "local pull did not return generation 1 batch");

  const staleDaemon = new SyntheticLocalSyncDaemon({
    controlState: input.controlState,
    endpoint: baseUrl,
    syncToken,
    tokenId: syncTokenId,
    fetchImpl: workerFetch
  });
  staleDaemon.queueCiphertextBatch({
    baseGeneration: 0,
    targetGeneration: 1,
    now: "2026-06-22T12:01:00.000Z"
  });
  const stale = await staleDaemon.submitNextPending();
  assert(stale.ok === false && stale.status === 409, "stale local sync batch should be rejected");

  const wrongBindingDaemon = new SyntheticLocalSyncDaemon({
    controlState: input.controlState,
    endpoint: baseUrl,
    syncToken,
    tokenId: "la_sync_token_wrongbinding0001",
    fetchImpl: workerFetch
  });
  const wrongBinding = await wrongBindingDaemon.planFromRemoteStatus();
  assert(wrongBinding.ok === false && wrongBinding.status_code === 403, "wrong sync token binding should be rejected");

  const combinedStorage = [
    ...graphBucket.puts.map((put) => put.value),
    ...graphBucket.puts.map((put) => JSON.stringify(put.options)),
    JSON.stringify(controlDb.records)
  ].join("\n");
  assertNoLeak("local Worker storage", combinedStorage);
  console.log("ok local Worker and sync daemon lifecycle");
}

async function main(): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), "living-atlas-local-deploy-"));
  const outputs: string[] = [];
  try {
    const profile = await createLocalProfile({ homeDir: tempDir, now });
    const controlState = await createFixtureLocalControlState(localMcpToken);
    await new FileLocalControlStore(profile.paths.control_store_path).write(controlState, passphrase);

    const profileJson = await readFile(profile.paths.profile_config_path, "utf8");
    const sealedStore = await readFile(profile.paths.control_store_path, "utf8");
    assert(profileJson.includes("living-atlas-local-profile"), "local profile was not created");
    assert(sealedStore.includes("ciphertext_base64"), "local control store was not sealed");
    assertNoLeak("local profile", profileJson);
    assertNoLeak("local control store", sealedStore);
    console.log("ok local profile and sealed control store");

    await exerciseLocalMcp({
      repoRoot: process.cwd(),
      tempDir,
      controlStorePath: profile.paths.control_store_path,
      activityLogPath: profile.paths.activity_log_path,
      outputs
    });

    assert(existsSync(profile.paths.activity_log_path), "local MCP activity log was not created");
    const activity = await readFile(profile.paths.activity_log_path, "utf8");
    for (const expected of ["object_read", "object_create", "object_update", "object_delete"]) {
      assert(activity.includes(expected), `activity log missing ${expected}`);
    }
    assertNoLeak("local MCP activity log", activity);

    await exerciseLocalWorkerAndSyncDaemon({ controlState, outputs });
    assertNoLeak("local deploy outputs", outputs.join("\n"));
    console.log("ok synthetic local deploy leakage guard");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
