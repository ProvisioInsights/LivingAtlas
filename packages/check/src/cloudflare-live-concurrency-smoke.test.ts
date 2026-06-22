import { describe, expect, it } from "vitest";
import type { SyncBatch } from "@living-atlas/contracts";
import {
  buildLiveConcurrencyBatch,
  liveConcurrencyEnv,
  readCloudflareLiveConcurrencySmokeConfig,
  runCloudflareLiveConcurrencySmoke,
  type CloudflareLiveConcurrencySmokeConfig
} from "./cloudflare-live-concurrency-smoke";

type CapturedRequest = {
  url: URL;
  method: string;
  headers: Headers;
  body?: string;
};

const config: CloudflareLiveConcurrencySmokeConfig = {
  endpoint: "https://living-atlas-live.example/",
  syncToken: "live-sync-token-test-secret",
  runId: "live_test_0001",
  authorityId: "la_authority_livetest0001",
  clientId: "la_client_livetest0001",
  capabilityId: "la_cap_livetest0001",
  deviceId: "la_device_livetest0001",
  tokenId: "live-token-id-0001",
  concurrency: 4,
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
    has_more: false
  };
}

function createFakeLiveFetch(options: { acceptEveryRaceBatch?: boolean } = {}) {
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

    if (url.pathname === "/healthz") {
      return json(200, { ok: true });
    }

    if (url.pathname === "/api/sync/status") {
      return json(200, {
        ok: true,
        latest_generation: latestGeneration,
        object_count: committed.length,
        change_count: committed.length,
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
      return rejected(404, "not-found");
    }

    const batch = JSON.parse(body) as SyncBatch;
    const existing = committedByIdempotency.get(batch.idempotency_key);
    if (existing) {
      return accepted(existing, true);
    }

    if (options.acceptEveryRaceBatch && batch.base_generation === 1 && batch.target_generation === 2) {
      committed.push(batch);
      committedByIdempotency.set(batch.idempotency_key, batch);
      latestGeneration = 2;
      return accepted(batch, false);
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

describe("Cloudflare live concurrency smoke config", () => {
  it("refuses to run without explicit live endpoint, token, and mutation acknowledgement", async () => {
    let fetchCalled = false;
    const result = await runCloudflareLiveConcurrencySmoke({
      env: {},
      fetchImpl: async () => {
        fetchCalled = true;
        throw new Error("must not fetch");
      }
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain(liveConcurrencyEnv.endpoint);
    expect(result.errors.join("\n")).toContain(liveConcurrencyEnv.token);
    expect(result.errors.join("\n")).toContain(liveConcurrencyEnv.acknowledgeMutation);
    expect(fetchCalled).toBe(false);
  });

  it("parses live env values without exposing the token in generated ids", () => {
    const parsed = readCloudflareLiveConcurrencySmokeConfig({
      [liveConcurrencyEnv.endpoint]: "https://living-atlas-live.example",
      [liveConcurrencyEnv.token]: "secret-token-value",
      [liveConcurrencyEnv.acknowledgeMutation]: "mutates-deployed-sync-state",
      [liveConcurrencyEnv.runId]: "live_env_0001",
      [liveConcurrencyEnv.concurrency]: "3"
    });

    expect("syncToken" in parsed && parsed.syncToken).toBe("secret-token-value");
    expect("runId" in parsed && parsed.runId).toBe("live_env_0001");
    expect("concurrency" in parsed && parsed.concurrency).toBe(3);
    if ("authorityId" in parsed) {
      expect(parsed.authorityId).not.toContain("secret-token-value");
      expect(parsed.clientId).not.toContain("secret-token-value");
      expect(parsed.capabilityId).not.toContain("secret-token-value");
    }
  });
});

describe("Cloudflare live concurrency smoke harness", () => {
  it("builds valid ciphertext-only live batches", () => {
    const batch = buildLiveConcurrencyBatch(config, "unit", 0, 1);

    expect(batch.authority_id).toBe(config.authorityId);
    expect(batch.client_id).toBe(config.clientId);
    expect(batch.capability_id).toBe(config.capabilityId);
    expect(batch.objects).toHaveLength(1);
    expect(batch.objects[0]!.payload.kind).toBe("ciphertext-ref");
    expect(batch.objects[0]!.visible_metadata.remote_indexable).toBe(false);
  });

  it("exercises health, token status, idempotency, stale generation, race, and pull checks through fetch injection", async () => {
    const fake = createFakeLiveFetch();
    const result = await runCloudflareLiveConcurrencySmoke({
      config,
      fetchImpl: fake.fetchImpl
    });

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.cases.map((testCase) => testCase.name)).toEqual([
      "healthz",
      "sync-token-status",
      "initial-batch",
      "idempotency-replay",
      "stale-generation",
      "same-generation-race",
      "race-winner-idempotency",
      "generation-gap",
      "pull-after-race"
    ]);

    const syncRequests = fake.requests.filter((request) => request.url.pathname.startsWith("/api/sync"));
    expect(syncRequests.every((request) => !request.url.searchParams.has("sync_token"))).toBe(true);
    expect(syncRequests.every((request) => request.headers.get("x-living-atlas-sync-token") === config.syncToken)).toBe(true);
    expect(syncRequests.every((request) => request.headers.get("x-living-atlas-sync-client-id") === config.clientId)).toBe(true);
    expect(syncRequests.every((request) => request.headers.get("x-living-atlas-sync-capability-id") === config.capabilityId)).toBe(true);
    expect(syncRequests.every((request) => request.headers.get("x-living-atlas-sync-token-id") === config.tokenId)).toBe(true);
  });

  it("fails when the deployed endpoint accepts more than one same-generation race winner", async () => {
    const fake = createFakeLiveFetch({ acceptEveryRaceBatch: true });
    const result = await runCloudflareLiveConcurrencySmoke({
      config,
      fetchImpl: fake.fetchImpl
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("same-generation race accepted more than one batch");
    expect(result.cases.find((testCase) => testCase.name === "same-generation-race")).toMatchObject({
      ok: false
    });
  });
});
