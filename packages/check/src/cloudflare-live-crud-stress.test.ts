import { describe, expect, it } from "vitest";
import type { SyncBatch } from "@living-atlas/contracts";
import {
  buildLiveCrudBatch,
  liveCrudStressEnv,
  planLiveCrudStages,
  readCloudflareLiveCrudStressConfig,
  runCloudflareLiveCrudStress,
  type CloudflareLiveCrudStressConfig
} from "./cloudflare-live-crud-stress";

type CapturedRequest = {
  url: URL;
  method: string;
  headers: Headers;
  body?: string;
};

const config: CloudflareLiveCrudStressConfig = {
  endpoint: "https://living-atlas-live.example/",
  syncToken: "fixture-sync-token-value",
  healthToken: "fixture-health-token-value",
  runId: "live_crud_test_0001",
  authorityId: "la_authority_livecrudtest0001",
  authorityRef: "sha256:75ee67cd9c3fa9c00a4786e9153e04f55c7d40c67b1afde83fa8633d8f7654a2",
  clientId: "la_client_livecrudtest0001",
  capabilityId: "la_cap_livecrudtest0001",
  deviceId: "la_device_livecrudtest0001",
  tokenId: "live-token-id-0001",
  entryCount: 1_005,
  batchSize: 250,
  requestTimeoutMs: 5_000
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json"
    }
  });
}

function stealth404(): Response {
  return new Response("Not Found\n", {
    status: 404,
    headers: {
      "content-type": "text/plain; charset=utf-8"
    }
  });
}

function accepted(batch: SyncBatch, replay: boolean): Response {
  return json(202, {
    ok: true,
    batch_id: batch.batch_id,
    accepted_objects: batch.objects.length,
    accepted_changes: batch.changes.length,
    target_generation: batch.target_generation,
    withheld_plaintext_count: batch.withheld_plaintext_count,
    idempotent_replay: replay
  });
}

function rejected(status: number, reason: string): Response {
  return json(status, {
    ok: false,
    error: reason
  });
}

function pullBody(authorityId: string, afterGeneration: number, latestGeneration: number, committed: SyncBatch[]) {
  const batches = committed
    .filter((batch) => batch.target_generation > afterGeneration)
    .slice(0, 100)
    .map((batch) => ({
      batch_id: batch.batch_id,
      batch_hash: batch.batch_hash,
      base_generation: batch.base_generation,
      target_generation: batch.target_generation,
      submitted_at: batch.submitted_at,
      object_count: batch.objects.length,
      change_count: batch.changes.length,
      withheld_plaintext_count: batch.withheld_plaintext_count
    }));

  return {
    ok: true,
    authority_id: authorityId,
    from_generation: afterGeneration,
    latest_generation: latestGeneration,
    batches,
    next_cursor: {
      authority_id: authorityId,
      generation: batches.at(-1)?.target_generation ?? afterGeneration,
      batch_id: batches.at(-1)?.batch_id
    },
    has_more: committed.filter((batch) => batch.target_generation > afterGeneration).length > 100
  };
}

function createFakeCrudFetch() {
  const requests: CapturedRequest[] = [];
  const committed: SyncBatch[] = [];
  const committedByIdempotency = new Map<string, SyncBatch>();
  let latestGeneration = 0;

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = input instanceof URL ? input : new URL(String(input));
    const headers = new Headers(init?.headers);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : undefined;
    requests.push({ url, method, headers, body });

    if (url.searchParams.has("sync_token")) {
      return stealth404();
    }

    if (url.pathname === "/healthz") {
      return headers.get("x-living-atlas-health-token") === config.healthToken
        ? json(200, { ok: true })
        : stealth404();
    }

    if (url.pathname.startsWith("/api/sync/")) {
      if (
        headers.get("x-living-atlas-sync-token") !== config.syncToken ||
        headers.get("x-living-atlas-sync-client-id") !== config.clientId ||
        headers.get("x-living-atlas-sync-capability-id") !== config.capabilityId ||
        headers.get("x-living-atlas-sync-token-id") !== config.tokenId
      ) {
        return stealth404();
      }
    }

    if (url.pathname === "/api/sync/status") {
      return json(200, {
        ok: true,
        latest_generation: latestGeneration,
        object_count: committed.reduce((sum, batch) => sum + batch.objects.length, 0),
        change_count: committed.reduce((sum, batch) => sum + batch.changes.length, 0),
        latest_withheld_plaintext_count: 0
      });
    }

    if (url.pathname === "/api/sync/pull") {
      return json(
        200,
        pullBody(
          url.searchParams.get("authority_id") ?? config.authorityId,
          Number(url.searchParams.get("after_generation") ?? "0"),
          latestGeneration,
          committed
        )
      );
    }

    if (url.pathname !== "/api/sync/batch" || method !== "POST" || !body) {
      return stealth404();
    }

    const batch = JSON.parse(body) as SyncBatch;
    if (batch.batch_hash === "sha256:0000000000000000000000000000000000000000000000000000000000000000") {
      return rejected(400, "batch-hash-mismatch");
    }

    const existing = committedByIdempotency.get(batch.idempotency_key);
    if (existing) {
      return accepted(existing, true);
    }

    if (batch.base_generation < latestGeneration) {
      return rejected(409, "stale-generation");
    }

    if (batch.base_generation > latestGeneration) {
      return rejected(409, "generation-gap");
    }

    committed.push(batch);
    committedByIdempotency.set(batch.idempotency_key, batch);
    latestGeneration = batch.target_generation;
    return accepted(batch, false);
  };

  return { fetchImpl, requests };
}

describe("Cloudflare live CRUD stress config", () => {
  it("refuses to run without explicit endpoint, token, and CRUD stress acknowledgement", async () => {
    let fetchCalled = false;
    const result = await runCloudflareLiveCrudStress({
      env: {},
      fetchImpl: async () => {
        fetchCalled = true;
        throw new Error("must not fetch");
      }
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain(liveCrudStressEnv.endpoint);
    expect(result.errors.join("\n")).toContain(liveCrudStressEnv.token);
    expect(result.errors.join("\n")).toContain(liveCrudStressEnv.acknowledgeMutation);
    expect(fetchCalled).toBe(false);
  });

  it("parses live env values without deriving ids from token material", () => {
    const parsed = readCloudflareLiveCrudStressConfig({
      [liveCrudStressEnv.endpoint]: "https://living-atlas-live.example",
      [liveCrudStressEnv.token]: "fixture-token-value",
      [liveCrudStressEnv.acknowledgeMutation]: "mutates-deployed-sync-state",
      [liveCrudStressEnv.runId]: "live_crud_env_0001",
      [liveCrudStressEnv.entryCount]: "1001",
      [liveCrudStressEnv.batchSize]: "25"
    });

    expect("syncToken" in parsed && parsed.syncToken).toBe("fixture-token-value");
    expect("runId" in parsed && parsed.runId).toBe("live_crud_env_0001");
    expect("entryCount" in parsed && parsed.entryCount).toBe(1_001);
    expect("batchSize" in parsed && parsed.batchSize).toBe(25);
    if ("authorityId" in parsed) {
      expect(parsed.authorityId).not.toContain("fixture-token-value");
      expect(parsed.clientId).not.toContain("fixture-token-value");
      expect(parsed.capabilityId).not.toContain("fixture-token-value");
    }
  });
});

describe("Cloudflare live CRUD stress planner", () => {
  it("plans create, update, delete, and restore generations over more than 1000 entries", () => {
    const plan = planLiveCrudStages(config);
    const createStages = plan.stages.filter((stage) => stage.operation === "create");
    const updateStages = plan.stages.filter((stage) => stage.operation === "update");
    const deleteStages = plan.stages.filter((stage) => stage.operation === "delete");
    const restoreStages = plan.stages.filter((stage) => stage.operation === "restore");

    expect(plan.entries).toHaveLength(1_005);
    expect(createStages.reduce((sum, stage) => sum + stage.objects.length, 0)).toBe(1_005);
    expect(updateStages.reduce((sum, stage) => sum + stage.objects.length, 0)).toBe(1_005);
    expect(deleteStages.reduce((sum, stage) => sum + stage.objects.length, 0)).toBe(335);
    expect(restoreStages.reduce((sum, stage) => sum + stage.objects.length, 0)).toBe(167);
    expect(plan.stages.every((stage, index) => stage.targetGeneration === index + 1)).toBe(true);
  });

  it("builds valid ciphertext-only CRUD batches", () => {
    const plan = planLiveCrudStages(config);
    const deleteStage = plan.stages.find((stage) => stage.operation === "delete");
    expect(deleteStage).toBeDefined();

    const batch = buildLiveCrudBatch(config, deleteStage!);
    expect(batch.authority_id).toBe(config.authorityId);
    expect(batch.client_id).toBe(config.clientId);
    expect(batch.objects.length).toBeGreaterThan(0);
    expect(batch.objects.every((object) => object.payload.kind === "ciphertext-ref")).toBe(true);
    expect(batch.objects.every((object) => object.visible_metadata.tombstone === true)).toBe(true);
    expect(batch.changes.every((change) => change.operation === "delete")).toBe(true);
  });
});

describe("Cloudflare live CRUD stress harness", () => {
  it("exercises auth stealth, CRUD batches, idempotency, integrity, conflict, and pull checks through fetch injection", async () => {
    const fake = createFakeCrudFetch();
    const result = await runCloudflareLiveCrudStress({
      config,
      fetchImpl: fake.fetchImpl
    });

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.summary).toMatchObject({
      planned_entries: 1_005,
      created: 1_005,
      updated: 1_005,
      deleted: 335,
      restored: 167
    });
    expect(result.summary?.accepted_objects).toBe(2_512);
    expect(result.cases.map((testCase) => testCase.name)).toEqual([
      "unauth-health-stealth",
      "query-token-stealth",
      "missing-sync-token-stealth",
      "bad-sync-binding-stealth",
      "authenticated-health",
      "authenticated-sync-status",
      "crud-batches-accepted",
      "idempotency-replay",
      "tampered-batch-rejected",
      "stale-generation-rejected",
      "generation-gap-rejected",
      "pull-verifies-crud-history"
    ]);

    const syncRequests = fake.requests.filter((request) => request.url.pathname.startsWith("/api/sync"));
    expect(syncRequests.every((request) => !request.url.searchParams.has("token"))).toBe(true);
    expect(syncRequests.every((request) => !request.url.searchParams.has("claim_token"))).toBe(true);
  });
});
