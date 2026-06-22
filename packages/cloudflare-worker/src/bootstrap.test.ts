import { describe, expect, it } from "vitest";
import { BootstrapClaimLockCore, InMemoryBootstrapClaimLockStorage } from "./bootstrap-lock";
import { handleBootstrapRequest, type BootstrapWorkerEnv } from "./worker";
import { sha256TokenHash } from "./bootstrap";

const validToken = "fixture-bootstrap-token-0001";
const fixedNow = "2026-06-22T00:00:00.000Z";

const claimPayload = {
  authority_id: "la_authority_bootstrap0001",
  user_id: "la_user_bootstrap0001",
  device_id: "la_device_bootstrap0001",
  device_public_key_hash: "fixture-device-public-key-hash",
  policy_generation: 1,
  wrapped_keys: [
    {
      key_id: "la_key_bootstrap0001",
      wrapping_device_id: "la_device_bootstrap0001",
      algorithm: "synthetic-fixture",
      ciphertext: "wrapped-key-ciphertext-fixture"
    }
  ],
  initial_remote_config: {
    remote_mcp_enabled: false
  }
} as const;

async function createLock(): Promise<{ lock: BootstrapClaimLockCore; tokenHash: string }> {
  return {
    lock: new BootstrapClaimLockCore(new InMemoryBootstrapClaimLockStorage()),
    tokenHash: await sha256TokenHash(validToken)
  };
}

async function createEnv(): Promise<BootstrapWorkerEnv> {
  const { lock, tokenHash } = await createLock();
  return {
    BOOTSTRAP_CLAIM_LOCK: {
      getByName: () => lock
    },
    LA_GRAPH_BUCKET: {} as R2Bucket,
    LA_CONTROL_DB: {} as D1Database,
    BOOTSTRAP_CLAIM_TOKEN_HASH: tokenHash,
    BOOTSTRAP_TOKEN_EXPIRES_AT: "2026-06-23T00:00:00.000Z"
  };
}

describe("BootstrapClaimLockCore", () => {
  it("starts sealed when no bootstrap claim token hash is configured", async () => {
    const lock = new BootstrapClaimLockCore(new InMemoryBootstrapClaimLockStorage());

    await expect(lock.getStatus({})).resolves.toEqual({
      bootstrap_state: "sealed",
      reset_generation: 0
    });
  });

  it("starts unclaimed when only token verification material is configured", async () => {
    const { lock, tokenHash } = await createLock();

    await expect(lock.getStatus({ claim_token_hash: tokenHash })).resolves.toEqual({
      bootstrap_state: "unclaimed",
      reset_generation: 0
    });
  });

  it("rejects missing, invalid, and expired tokens", async () => {
    const { lock, tokenHash } = await createLock();

    await expect(lock.claim(claimPayload, undefined, { claim_token_hash: tokenHash }, fixedNow)).resolves.toMatchObject({ ok: false, reason: "missing-token" });
    await expect(lock.claim(claimPayload, "wrong-token", { claim_token_hash: tokenHash }, fixedNow)).resolves.toMatchObject({ ok: false, reason: "invalid-token" });
    await expect(
      lock.claim(claimPayload, validToken, { claim_token_hash: tokenHash, claim_token_expires_at: "2026-06-21T00:00:00.000Z" }, fixedNow)
    ).resolves.toMatchObject({ ok: false, reason: "expired-token" });
  });

  it("accepts exactly one concurrent valid first claim and burns the token", async () => {
    const { lock, tokenHash } = await createLock();
    const config = { claim_token_hash: tokenHash, claim_token_expires_at: "2026-06-23T00:00:00.000Z" };
    const [first, second] = await Promise.all([
      lock.claim(claimPayload, validToken, config, fixedNow),
      lock.claim(claimPayload, validToken, config, fixedNow)
    ]);

    const results = [first, second];
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok).map((result) => result.reason)).toEqual(["already-claimed"]);
    await expect(lock.getStatus(config)).resolves.toMatchObject({
      bootstrap_state: "claimed",
      authority_id: claimPayload.authority_id,
      claim_token_burned_at: fixedNow
    });
    expect(JSON.stringify(results)).not.toContain(validToken);
  });

  it("rejects raw sensitive key fields by strict claim payload validation", async () => {
    const { lock, tokenHash } = await createLock();
    await expect(
      lock.claim({ ...claimPayload, account_root_key_plaintext: "forbidden" }, validToken, { claim_token_hash: tokenHash }, fixedNow)
    ).resolves.toMatchObject({ ok: false, reason: "malformed-claim" });
  });
});

describe("Worker bootstrap routes", () => {
  it("serves health and bootstrap status", async () => {
    const env = await createEnv();

    const health = await handleBootstrapRequest(new Request("https://living-atlas.example/healthz"), env);
    await expect(health.json()).resolves.toEqual({ ok: true, service: "living-atlas-cloudflare-bootstrap" });

    const status = await handleBootstrapRequest(new Request("https://living-atlas.example/api/bootstrap/status"), env);
    await expect(status.json()).resolves.toMatchObject({ bootstrap_state: "unclaimed" });
  });

  it("rejects bootstrap claim tokens in query strings", async () => {
    const env = await createEnv();
    const response = await handleBootstrapRequest(
      new Request("https://living-atlas.example/api/bootstrap/claim?claim_token=fixture-bootstrap-token-0001", {
        method: "POST",
        body: JSON.stringify(claimPayload)
      }),
      env
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: "bootstrap token must not be sent in the query string" });
  });

  it("claims with a header token and never returns the token", async () => {
    const env = await createEnv();
    const response = await handleBootstrapRequest(
      new Request("https://living-atlas.example/api/bootstrap/claim", {
        method: "POST",
        headers: { "content-type": "application/json", "x-living-atlas-bootstrap-token": validToken },
        body: JSON.stringify(claimPayload)
      }),
      env
    );

    expect(response.status).toBe(201);
    const body = await response.text();
    expect(body).toContain("\"bootstrap_state\":\"claimed\"");
    expect(body).not.toContain(validToken);
    expect(body).not.toContain("wrapped-key-ciphertext-fixture");
  });
});
