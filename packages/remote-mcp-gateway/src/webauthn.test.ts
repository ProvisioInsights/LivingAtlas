import { describe, expect, it } from "vitest";
import {
  putChallenge,
  takeChallenge,
  beginOwnerRegistration,
  finishOwnerRegistration,
  beginOwnerAuthentication,
  finishOwnerAuthentication
} from "./webauthn";
import { FakeKVNamespace } from "./test-doubles";

describe("WebAuthn challenge store", () => {
  it("stores a challenge with a 300s TTL and returns it exactly once", async () => {
    const kv = new FakeKVNamespace();
    await putChallenge(kv as never, "reg:owner", "challenge-abc");
    expect(kv.lastPutOptions?.expirationTtl).toBe(300);
    expect(await takeChallenge(kv as never, "reg:owner")).toBe("challenge-abc");
    // consumed: second take is undefined (replay-resistant)
    expect(await takeChallenge(kv as never, "reg:owner")).toBeUndefined();
  });
});

describe("WebAuthn owner registration", () => {
  it("generates registration options for the allowlisted owner and stashes the challenge", async () => {
    const kv = new FakeKVNamespace();
    const options = await beginOwnerRegistration(kv as never, {
      rpID: "atlas.example",
      rpName: "Living Atlas",
      ownerUserId: "la_owner_0001",
      ownerUserName: "owner@atlas.example"
    });
    expect(options.challenge).toBeTruthy();
    expect(options.rp.id).toBe("atlas.example");
    // challenge persisted under the owner registration key
    expect(await kv.get("webauthn:reg:la_owner_0001")).toBe(options.challenge);
  });

  it("rejects registration once an owner credential already exists (single-owner binding)", async () => {
    const kv = new FakeKVNamespace();
    const store = { existing: { id: "cred-1" } }; // pretend owner already bound
    const result = await finishOwnerRegistration(
      kv as never,
      { rpID: "atlas.example", expectedOrigin: "https://atlas.example", ownerUserId: "la_owner_0001" },
      { fake: "response" } as never,
      () => store.existing // credential lookup: already present
    );
    expect(result).toEqual({ ok: false, reason: "owner-already-bound" });
  });
});

describe("WebAuthn owner authentication", () => {
  it("auth options include the owner's credential and stash the challenge", async () => {
    const kv = new FakeKVNamespace();
    const options = await beginOwnerAuthentication(
      kv as never,
      { rpID: "atlas.example", ownerUserId: "la_owner_0001" },
      [{ id: "cred-1", transports: ["internal"] }]
    );
    expect(options.challenge).toBeTruthy();
    expect(options.allowCredentials?.[0]?.id).toBe("cred-1");
    expect(await kv.get("webauthn:auth:la_owner_0001")).toBe(options.challenge);
  });

  it("rejects authentication when no challenge is stored (expired / replay)", async () => {
    const kv = new FakeKVNamespace();
    const result = await finishOwnerAuthentication(
      kv as never,
      { rpID: "atlas.example", expectedOrigin: "https://atlas.example", ownerUserId: "la_owner_0001" },
      { fake: "response" } as never,
      { id: "cred-1", publicKey: new Uint8Array([1, 2, 3]), counter: 0 }
    );
    expect(result).toEqual({ ok: false, reason: "challenge-missing" });
  });
});
