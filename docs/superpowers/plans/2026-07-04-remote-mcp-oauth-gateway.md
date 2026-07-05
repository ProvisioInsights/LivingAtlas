# Remote MCP OAuth Gateway (A1 McpAgent) — TDD Implementation Plan

**Status:** Draft plan — 2026-07-04. Implements decision **A1** from `docs/superpowers/specs/2026-07-04-remote-mcp-auth-tiered-decryption-design.md`.

This plan rebuilds the *remote* MCP surface as an **OAuth-fronted `McpAgent` worker** (`@cloudflare/workers-oauth-provider` + Cloudflare Agents SDK), retires the hand-rolled remote `/mcp` handler in `packages/cloudflare-worker/src/worker.ts` (`routeRemoteMcpRequest`), and reuses ciphertext custody + tiered-decryption logic from shared packages. The local **stdio** MCP (`packages/local-mcp`) is out of scope and must stay byte-for-byte unchanged.

Each task is 2–5 minutes: it names exact file paths, adds a failing test with real code, gives the command to run + the expected failure, gives the minimal real implementation, the command to see it pass, and a commit. **No placeholders.** Follow the tasks in order; do not skip the red step.

---

## OPEN QUESTIONS (resolve before or during the tasks; do not invent an API)

1. **`McpAgent.serve()` vs `createMcpHandler`.** The Cloudflare **authorization** guide (`https://developers.cloudflare.com/agents/model-context-protocol/authorization/`) and the **remote-mcp-server** guide (`https://developers.cloudflare.com/agents/guides/remote-mcp-server/`) both wire `apiHandler: MyMCP.serve("/mcp")` where `MyMCP extends McpAgent`. The **mcp-handler-api** page (`https://developers.cloudflare.com/agents/api-reference/mcp-handler-api/`) instead documents a stateless `createMcpHandler(server, options)` from `agents/mcp`. **This plan uses the `McpAgent` + `.serve("/mcp")` form** (Durable-Object-per-session, matches A1's "DO-per-session with built-in resumability"). If, at implementation time, the installed `agents` package version does not expose `McpAgent.serve`, fall back to `createMcpHandler` + `WorkerTransport` + `DurableObjectEventStore` and adjust Tasks 8–10 accordingly. Pin the version in Task 1 and re-read the docs for that exact version.

2. **Resumability is not automatic.** Per the transport docs (`.../model-context-protocol/transport/`), `Last-Event-ID` replay requires an **`EventStore`** (`DurableObjectEventStore` exported from `agents/mcp`); `McpAgent` provides the DO session but the event store may need explicit wiring. Task 20 asserts streaming works; if the SDK version requires manual `EventStore` config, wire it there and cite the doc URL in the commit body. **Do not hand-roll an event store.**

3. **`completeAuthorization` return field.** The workers-oauth-provider README describes `completeAuthorization({ request, userId, metadata, scope, props })` returning `{ redirectTo }`. Older snippets call it `redirectTo` vs `redirectToApp`. Task 6 asserts against `.redirectTo`; if the installed version differs, adapt to the actual field and note it in the commit.

4. **mTLS from a Worker.** Cloudflare Workers reach the local oracle over a **Cloudflare Tunnel** with **mTLS client cert** presented via `fetch(url, { /* mTLS */ })`. Worker-originated client-certificate mTLS uses **mTLS certificate bindings** (`mtls_certificates` in wrangler, surfaced as a `Fetcher`-like binding). The plan treats the oracle client as an injectable `fetch`-like dependency (Task 15) so unit tests never open a socket; the **real** binding + tunnel is a deployment gate (see final section), not a code task.

5. **Passkey ceremony transport.** The browser side of WebAuthn (calling `navigator.credentials.create/get`) is a human/browser step. This plan builds and unit-tests the **server** half (`@simplewebauthn/server`) with KV challenge storage; the actual passkey enrollment is a deployment gate.

---

## Confirmed external API signatures (source URLs)

- **`@cloudflare/workers-oauth-provider`** — `https://github.com/cloudflare/workers-oauth-provider`
  - Constructor: `new OAuthProvider({ apiRoute, apiHandler, apiHandlers?, defaultHandler, authorizeEndpoint, tokenEndpoint, clientRegistrationEndpoint?, scopesSupported?, accessTokenTTL?=3600, refreshTokenTTL?=2592000, clientRegistrationTTL?=7776000, allowImplicitFlow?=false, allowPlainPKCE?=true, disallowPublicClientRegistration?=false })`.
  - Helpers on `env.OAUTH_PROVIDER`: `parseAuthRequest(request)` → `{ clientId, redirectUri, scope, state, responseType }`; `lookupClient(clientId)`; `completeAuthorization({ request, userId, metadata, scope, props })` → `{ redirectTo }`. `props` is end-to-end encrypted and surfaces as `ctx.props` (agent: `this.props`).
  - PKCE and dynamic client registration are **on by default**; disable open registration with `disallowPublicClientRegistration: true`. KV binding **`OAUTH_KV`** stores tokens.
- **Cloudflare Agents `McpAgent`** — `https://developers.cloudflare.com/agents/model-context-protocol/authorization/` and `.../transport/`
  - `class MyMCP extends McpAgent<Env, State, Props> { server = new McpServer({ name, version }); async init() { this.server.tool(name, description, zodSchema, handler); } }`.
  - Wired as `apiHandler: MyMCP.serve("/mcp")` (Streamable HTTP) and/or `MyMCP.serveSSE("/sse")` (legacy). Auth identity available as `this.props`.
- **`createMcpHandler` / `getMcpAuthContext`** (fallback path) — `https://developers.cloudflare.com/agents/api-reference/mcp-handler-api/`: `createMcpHandler(server, { route?="/mcp", transport?, storage? })`; `getMcpAuthContext()` from `agents/mcp`; `DurableObjectEventStore` for resumability.
- **`@simplewebauthn/server` v13+** — `https://simplewebauthn.dev/docs/packages/server`
  - `generateRegistrationOptions({ rpName, rpID, userName, userID?, attestationType?, excludeCredentials?, authenticatorSelection? })` → JSON with `challenge`.
  - `verifyRegistrationResponse({ response, expectedChallenge, expectedOrigin, expectedRPID })` → `{ verified, registrationInfo: { credential: { id, publicKey, counter, transports }, credentialDeviceType, credentialBackedUp } }`.
  - `generateAuthenticationOptions({ rpID, allowCredentials? })` → JSON with `challenge`.
  - `verifyAuthenticationResponse({ response, expectedChallenge, expectedOrigin, expectedRPID, credential: { id, publicKey, counter, transports } })` → `{ verified, authenticationInfo: { newCounter } }`.
  - Docs explicitly instruct storing the challenge server-side with a short TTL → we use **KV with ~300s TTL**.

---

## Repo conventions to honor (observed)

- **Monorepo:** pnpm workspaces (`pnpm-workspace.yaml`, `packages/*`), package manager `pnpm@11.8.0`. Root `type: module`.
- **Tests:** `vitest` (root `vitest.config.ts` includes `packages/**/*.test.ts`). Run a single package's tests with `pnpm vitest run <path>`; run one file with `pnpm vitest run <file>`.
- **Typecheck:** `pnpm typecheck` (= `tsc --noEmit`, config `tsconfig.json`, `types: ["node","vitest","@cloudflare/workers-types"]`, `strict`, `noUncheckedIndexedAccess`).
- **Full gate:** `pnpm run check` = `lint:repo-safety` + `typecheck` + `test`.
- **Crypto reuse:** `packages/cloudflare-worker/src/cloud-unlock.ts` (`decryptCloudUnlockObject`, `encryptCloudUnlockObject`, `CloudUnlockObjectAlgorithm`) and `cloud-unlock-escalated.ts` (`decryptEscalatedCloudUnlockObject`, `encryptEscalatedCloudUnlockObject`, `CloudUnlockEscalatedObjectAlgorithm`). These use only `crypto.subtle` + `@living-atlas/contracts` — portable to a shared package.
- **Tool catalog:** `packages/mcp-contract/src/index.ts` (`LivingAtlasMcpToolDefinitions`, `LivingAtlasMcpToolName`).
- **Envelope type:** `GraphObjectEnvelope` from `@living-atlas/contracts`.
- **Wrangler:** `wrangler.jsonc` with `compatibility_flags: ["nodejs_compat"]`, DO bindings + `migrations.new_sqlite_classes`, R2/D1/KV bindings (see `packages/cloudflare-worker/wrangler.example.jsonc`).
- **Test doubles:** `packages/cloudflare-worker/src/worker-test-doubles.ts` provides `FakeR2Bucket`, `FakeD1Database` — reuse for gateway tool tests.

---

## Package layout decision

Three new packages plus one extraction:

1. **`packages/remote-crypto`** (extraction). Move the tier crypto out of `cloudflare-worker` so both the sync worker and the new gateway import it without duplication. Re-export from `cloudflare-worker` for backward compatibility (keeps existing worker tests green).
   - `src/cloud-unlock.ts`, `src/cloud-unlock-escalated.ts`, `src/index.ts`.
2. **`packages/remote-mcp-gateway`** (new Cloudflare Worker). OAuthProvider + `McpAgent`. Owns: WebAuthn login, tier-ceiling policy engine, T1 secret injection, T2 mTLS-oracle brokering, guardrails (audit/alert, kill-switch, rate limit, redaction hook, rotation), and the `remote_*` tool surface (imported from `mcp-contract`).
   - `src/policy.ts`, `src/webauthn.ts`, `src/grant.ts`, `src/oracle-client.ts`, `src/guardrails.ts`, `src/rotation.ts`, `src/redaction.ts`, `src/agent.ts`, `src/index.ts`, plus `*.test.ts` siblings, `wrangler.jsonc`, `package.json`.
3. **`packages/local-decryption-oracle`** (new; runs on the owner's machine, in front of the keyring). Verifies the signed grant + performs T2 decrypt. Pure logic + a thin HTTP entry; unit-tested without sockets.
   - `src/grant-verify.ts`, `src/oracle.ts`, `src/index.ts`, `*.test.ts`, `package.json`.

`grant.ts` (sign) lives in the gateway; `grant-verify.ts` (verify) lives in the oracle; both import a shared `grant-format` from `remote-crypto` (Task 12) so the wire format cannot drift.

---

# Phase 0 — Scaffolding & shared-crypto extraction

## Task 1 — Create `remote-crypto` package skeleton (moved crypto, re-exported)

**Files:**
- `packages/remote-crypto/package.json`
- `packages/remote-crypto/src/index.ts`
- Move `packages/cloudflare-worker/src/cloud-unlock.ts` → `packages/remote-crypto/src/cloud-unlock.ts`
- Move `packages/cloudflare-worker/src/cloud-unlock-escalated.ts` → `packages/remote-crypto/src/cloud-unlock-escalated.ts`
- Move test files `cloud-unlock.test.ts`, `cloud-unlock-escalated.test.ts`, `worker-escalation.test.ts`'s crypto imports.

**Red — write the failing test** `packages/remote-crypto/src/index.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import {
  CloudUnlockObjectAlgorithm,
  CloudUnlockEscalatedObjectAlgorithm,
  decryptCloudUnlockObject,
  encryptCloudUnlockObject,
  decryptEscalatedCloudUnlockObject,
  encryptEscalatedCloudUnlockObject
} from "@living-atlas/remote-crypto";

describe("remote-crypto barrel", () => {
  it("re-exports both tier algorithms and round-trips T1", async () => {
    expect(CloudUnlockObjectAlgorithm).toBe("AES-GCM-256+cloud-unlock-v1");
    expect(CloudUnlockEscalatedObjectAlgorithm).toBe("AES-GCM-256+cloud-unlock-escalated-v1");
    expect(typeof decryptCloudUnlockObject).toBe("function");
    expect(typeof encryptCloudUnlockObject).toBe("function");
    expect(typeof decryptEscalatedCloudUnlockObject).toBe("function");
    expect(typeof encryptEscalatedCloudUnlockObject).toBe("function");
  });
});
```

**Run:** `pnpm vitest run packages/remote-crypto/src/index.test.ts`
**Expect fail:** `Cannot find module '@living-atlas/remote-crypto'` (package does not exist yet).

**Green — minimal implementation:**
`packages/remote-crypto/package.json`:
```json
{
  "name": "@living-atlas/remote-crypto",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./cloud-unlock": "./src/cloud-unlock.ts",
    "./cloud-unlock-escalated": "./src/cloud-unlock-escalated.ts"
  },
  "dependencies": {
    "@living-atlas/contracts": "workspace:*"
  }
}
```
`git mv packages/cloudflare-worker/src/cloud-unlock.ts packages/remote-crypto/src/cloud-unlock.ts` and the escalated file the same way (contents unchanged; they only import `@living-atlas/contracts`).
`packages/remote-crypto/src/index.ts`:
```ts
export * from "./cloud-unlock";
export * from "./cloud-unlock-escalated";
```
Run `pnpm install` so the new workspace package resolves.

**Run:** `pnpm vitest run packages/remote-crypto/src/index.test.ts` → **passes.**

**Commit:** `refactor(remote-crypto): extract tier crypto into shared package`

---

## Task 2 — Keep `cloudflare-worker` green via re-export shim

**Files:**
- `packages/cloudflare-worker/src/cloud-unlock.ts` (recreate as shim)
- `packages/cloudflare-worker/src/cloud-unlock-escalated.ts` (recreate as shim)
- `packages/cloudflare-worker/package.json` (add dep)
- Move `cloud-unlock.test.ts` + `cloud-unlock-escalated.test.ts` into `packages/remote-crypto/src/` (they test moved code).

**Red:** Run the *existing* worker suite to see the break the move caused:
**Run:** `pnpm vitest run packages/cloudflare-worker`
**Expect fail:** `worker.ts` and `worker-escalation.test.ts` import `./cloud-unlock` / `./cloud-unlock-escalated` which no longer contain the implementation.

**Green — minimal shim** `packages/cloudflare-worker/src/cloud-unlock.ts`:
```ts
export * from "@living-atlas/remote-crypto/cloud-unlock";
```
`packages/cloudflare-worker/src/cloud-unlock-escalated.ts`:
```ts
export * from "@living-atlas/remote-crypto/cloud-unlock-escalated";
```
Add to `packages/cloudflare-worker/package.json` dependencies: `"@living-atlas/remote-crypto": "workspace:*"`. Move the two crypto test files under `packages/remote-crypto/src/`. Run `pnpm install`.

**Run:** `pnpm vitest run packages/cloudflare-worker && pnpm vitest run packages/remote-crypto` → **both pass.**
**Run:** `pnpm typecheck` → passes.

**Commit:** `refactor(cloudflare-worker): re-export tier crypto from remote-crypto shim`

---

## Task 3 — `remote-mcp-gateway` package + worker entry skeleton

**Files:**
- `packages/remote-mcp-gateway/package.json`
- `packages/remote-mcp-gateway/src/index.ts`
- `packages/remote-mcp-gateway/src/index.test.ts`

**Red** `packages/remote-mcp-gateway/src/index.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import worker from "@living-atlas/remote-mcp-gateway";

describe("gateway worker entry", () => {
  it("returns a stealth 404 for an unauthenticated non-OAuth path", async () => {
    const env = { LA_STEALTH_MODE: "1" } as never;
    const res = await worker.fetch(new Request("https://gw.example/nope"), env, {} as never);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/plain");
  });
});
```

**Run:** `pnpm vitest run packages/remote-mcp-gateway/src/index.test.ts`
**Expect fail:** `Cannot find module '@living-atlas/remote-mcp-gateway'`.

**Green** `packages/remote-mcp-gateway/package.json`:
```json
{
  "name": "@living-atlas/remote-mcp-gateway",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@living-atlas/contracts": "workspace:*",
    "@living-atlas/mcp-contract": "workspace:*",
    "@living-atlas/remote-crypto": "workspace:*",
    "@cloudflare/workers-oauth-provider": "0.0.11",
    "@simplewebauthn/server": "13.2.2",
    "agents": "0.2.11",
    "zod": "4.4.3"
  }
}
```
> Pin exact versions at install time; the ones above are placeholders for "latest stable at implementation" — run `pnpm view <pkg> version` and record the resolved versions in the commit body. After pinning, re-read the OPEN QUESTION #1 docs for that `agents` version.

`packages/remote-mcp-gateway/src/index.ts`:
```ts
function truthyFlag(value: string | undefined): boolean {
  return value === "1" || value === "true" || value === "on" || value === "yes";
}

function plainNotFound(): Response {
  return new Response("Not Found\n", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }
  });
}

export type GatewayEnv = {
  LA_STEALTH_MODE?: string;
};

export default {
  async fetch(request: Request, env: GatewayEnv): Promise<Response> {
    // OAuthProvider is wired in Task 8; until then everything unauthenticated
    // is a stealth 404 when stealth mode is on (reuses LA_STEALTH_MODE plumbing).
    if (truthyFlag(env.LA_STEALTH_MODE)) {
      return plainNotFound();
    }
    return plainNotFound();
  }
};
```
Run `pnpm install`.

**Run:** `pnpm vitest run packages/remote-mcp-gateway/src/index.test.ts` → **passes.**

**Commit:** `feat(remote-mcp-gateway): scaffold OAuth-fronted worker package`

---

# Phase 1 — Capability → tier-ceiling policy engine

## Task 4 — Tier-ceiling decision: `remote-safe-only` blocks all plaintext

**Files:**
- `packages/remote-mcp-gateway/src/policy.ts`
- `packages/remote-mcp-gateway/src/policy.test.ts`

**Red** `policy.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { decideTierAccess, type CapabilityPolicy } from "./policy";

const safeOnly: CapabilityPolicy = {
  capability_id: "la_cap_remote0001",
  tier_ceiling: "remote-safe-only",
  rate_limit_per_minute: 60
};

describe("decideTierAccess", () => {
  it("remote-safe-only denies T1 and T2 plaintext, allows ciphertext", () => {
    expect(decideTierAccess(safeOnly, "safe")).toEqual({ allowed: true, reason: "within-ceiling" });
    expect(decideTierAccess(safeOnly, "T1")).toEqual({ allowed: false, reason: "above-ceiling" });
    expect(decideTierAccess(safeOnly, "T2")).toEqual({ allowed: false, reason: "above-ceiling" });
  });
});
```

**Run:** `pnpm vitest run packages/remote-mcp-gateway/src/policy.test.ts`
**Expect fail:** `Cannot find module './policy'`.

**Green** `policy.ts`:
```ts
export type TierCeiling = "remote-safe-only" | "T1" | "T2";
export type RequestedTier = "safe" | "T1" | "T2";

export type CapabilityPolicy = {
  capability_id: string;
  tier_ceiling: TierCeiling;
  rate_limit_per_minute: number;
};

export type TierDecision =
  | { allowed: true; reason: "within-ceiling" }
  | { allowed: false; reason: "above-ceiling" };

const CEILING_RANK: Record<TierCeiling, number> = { "remote-safe-only": 0, T1: 1, T2: 2 };
const TIER_RANK: Record<RequestedTier, number> = { safe: 0, T1: 1, T2: 2 };

export function decideTierAccess(policy: CapabilityPolicy, requested: RequestedTier): TierDecision {
  return TIER_RANK[requested] <= CEILING_RANK[policy.tier_ceiling]
    ? { allowed: true, reason: "within-ceiling" }
    : { allowed: false, reason: "above-ceiling" };
}
```

**Run:** `pnpm vitest run packages/remote-mcp-gateway/src/policy.test.ts` → **passes.**

**Commit:** `feat(gateway): tier-ceiling decision for remote-safe-only`

---

## Task 5 — T1 ceiling allows T1 but not T2; T2 ceiling allows all

**Files:** `packages/remote-mcp-gateway/src/policy.test.ts` (extend).

**Red — add cases:**
```ts
const t1Ceiling: CapabilityPolicy = { capability_id: "c", tier_ceiling: "T1", rate_limit_per_minute: 10 };
const t2Ceiling: CapabilityPolicy = { capability_id: "c", tier_ceiling: "T2", rate_limit_per_minute: 10 };

it("T1 ceiling allows safe+T1, denies T2", () => {
  expect(decideTierAccess(t1Ceiling, "safe").allowed).toBe(true);
  expect(decideTierAccess(t1Ceiling, "T1").allowed).toBe(true);
  expect(decideTierAccess(t1Ceiling, "T2")).toEqual({ allowed: false, reason: "above-ceiling" });
});

it("T2 ceiling allows every tier", () => {
  for (const tier of ["safe", "T1", "T2"] as const) {
    expect(decideTierAccess(t2Ceiling, tier).allowed).toBe(true);
  }
});
```

**Run:** `pnpm vitest run packages/remote-mcp-gateway/src/policy.test.ts`
**Expect:** the two new cases pass immediately against the Task 4 implementation (the rank comparison already covers them). If any fails, the ranking is wrong — fix `CEILING_RANK`/`TIER_RANK` until green. This task locks the full lattice with explicit assertions.

**Commit:** `test(gateway): lock full tier-ceiling lattice (T1/T2 ceilings)`

---

## Task 6 — Provider-generic policy config loader with conservative default

**Files:**
- `packages/remote-mcp-gateway/src/policy.ts` (extend)
- `packages/remote-mcp-gateway/src/policy.test.ts` (extend)

**Red:**
```ts
import { loadCapabilityPolicy } from "./policy";

it("parses a provider-generic policy map from JSON and applies conservative default", () => {
  const json = JSON.stringify({
    default: { tier_ceiling: "remote-safe-only", rate_limit_per_minute: 30 },
    capabilities: {
      "la_cap_owner0001": { tier_ceiling: "T2", rate_limit_per_minute: 120 }
    }
  });
  const owner = loadCapabilityPolicy(json, "la_cap_owner0001");
  expect(owner.tier_ceiling).toBe("T2");
  const stranger = loadCapabilityPolicy(json, "la_cap_unknown9999");
  expect(stranger.tier_ceiling).toBe("remote-safe-only");
  expect(stranger.rate_limit_per_minute).toBe(30);
});

it("defaults to remote-safe-only when config is absent", () => {
  const p = loadCapabilityPolicy(undefined, "whatever");
  expect(p.tier_ceiling).toBe("remote-safe-only");
});
```

**Run:** `pnpm vitest run packages/remote-mcp-gateway/src/policy.test.ts`
**Expect fail:** `loadCapabilityPolicy is not a function`.

**Green — add to `policy.ts`:**
```ts
import { z } from "zod";

const PolicyEntrySchema = z.object({
  tier_ceiling: z.enum(["remote-safe-only", "T1", "T2"]),
  rate_limit_per_minute: z.number().int().positive()
});
const PolicyConfigSchema = z.object({
  default: PolicyEntrySchema,
  capabilities: z.record(z.string(), PolicyEntrySchema).default({})
});

const CONSERVATIVE_DEFAULT: Omit<CapabilityPolicy, "capability_id"> = {
  tier_ceiling: "remote-safe-only",
  rate_limit_per_minute: 30
};

export function loadCapabilityPolicy(configJson: string | undefined, capabilityId: string): CapabilityPolicy {
  if (!configJson) {
    return { capability_id: capabilityId, ...CONSERVATIVE_DEFAULT };
  }
  const parsed = PolicyConfigSchema.safeParse(JSON.parse(configJson));
  if (!parsed.success) {
    return { capability_id: capabilityId, ...CONSERVATIVE_DEFAULT };
  }
  const entry = parsed.data.capabilities[capabilityId] ?? parsed.data.default;
  return { capability_id: capabilityId, tier_ceiling: entry.tier_ceiling, rate_limit_per_minute: entry.rate_limit_per_minute };
}
```

**Run:** `pnpm vitest run packages/remote-mcp-gateway/src/policy.test.ts` → **passes.**

**Commit:** `feat(gateway): provider-generic policy loader with conservative default`

---

# Phase 2 — WebAuthn owner login (server half) + KV challenge store

## Task 7 — KV challenge store with 300s TTL (put/take-once semantics)

**Files:**
- `packages/remote-mcp-gateway/src/webauthn.ts`
- `packages/remote-mcp-gateway/src/webauthn.test.ts`
- `packages/remote-mcp-gateway/src/test-doubles.ts` (a `FakeKVNamespace` supporting `put(key, val, { expirationTtl })`, `get`, `delete`)

**Red** `webauthn.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { putChallenge, takeChallenge } from "./webauthn";
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
```

**Run:** `pnpm vitest run packages/remote-mcp-gateway/src/webauthn.test.ts`
**Expect fail:** `Cannot find module './webauthn'`.

**Green** `test-doubles.ts`:
```ts
export class FakeKVNamespace {
  private store = new Map<string, string>();
  lastPutOptions: { expirationTtl?: number } | undefined;
  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.lastPutOptions = options;
    this.store.set(key, value);
  }
  async get(key: string): Promise<string | null> {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}
```
`webauthn.ts`:
```ts
const CHALLENGE_TTL_SECONDS = 300;

export async function putChallenge(kv: KVNamespace, key: string, challenge: string): Promise<void> {
  await kv.put(key, challenge, { expirationTtl: CHALLENGE_TTL_SECONDS });
}

export async function takeChallenge(kv: KVNamespace, key: string): Promise<string | undefined> {
  const value = await kv.get(key);
  if (value === null) return undefined;
  await kv.delete(key);
  return value;
}
```

**Run:** `pnpm vitest run packages/remote-mcp-gateway/src/webauthn.test.ts` → **passes.**

**Commit:** `feat(gateway): KV challenge store with 300s TTL and take-once semantics`

---

## Task 8 — Registration options bound to the single allowlisted owner

**Files:** `packages/remote-mcp-gateway/src/webauthn.ts` (extend), `webauthn.test.ts` (extend).

**Red:**
```ts
import { beginOwnerRegistration } from "./webauthn";

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
```

**Run:** `pnpm vitest run packages/remote-mcp-gateway/src/webauthn.test.ts`
**Expect fail:** `beginOwnerRegistration is not a function`.

**Green — add to `webauthn.ts`:**
```ts
import { generateRegistrationOptions } from "@simplewebauthn/server";

export type OwnerRpConfig = {
  rpID: string;
  rpName: string;
  ownerUserId: string;
  ownerUserName: string;
};

export async function beginOwnerRegistration(kv: KVNamespace, cfg: OwnerRpConfig) {
  const options = await generateRegistrationOptions({
    rpName: cfg.rpName,
    rpID: cfg.rpID,
    userName: cfg.ownerUserName,
    attestationType: "none",
    authenticatorSelection: { residentKey: "required", userVerification: "required" }
  });
  await putChallenge(kv, `webauthn:reg:${cfg.ownerUserId}`, options.challenge);
  return options;
}
```

**Run:** `pnpm vitest run packages/remote-mcp-gateway/src/webauthn.test.ts` → **passes.**
> If `@simplewebauthn/server` v13 requires `userID` as a `Uint8Array`, pass `userID: new TextEncoder().encode(cfg.ownerUserId)` and adapt; cite the docs page in the commit.

**Commit:** `feat(gateway): owner passkey registration options + challenge stash`

---

## Task 9 — Verify registration → persist the single owner credential; reject a second owner

**Files:** `packages/remote-mcp-gateway/src/webauthn.ts` (extend), `webauthn.test.ts` (extend), `test-doubles.ts` (add a `FakeCredentialStore`).

**Red:**
```ts
import { finishOwnerRegistration } from "./webauthn";

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
```

**Run:** `pnpm vitest run packages/remote-mcp-gateway/src/webauthn.test.ts`
**Expect fail:** `finishOwnerRegistration is not a function`.

**Green — add to `webauthn.ts`:**
```ts
import { verifyRegistrationResponse } from "@simplewebauthn/server";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";

export type OwnerCredential = { id: string; publicKey: Uint8Array; counter: number };

export type FinishRegistrationConfig = {
  rpID: string;
  expectedOrigin: string;
  ownerUserId: string;
};

export type FinishRegistrationResult =
  | { ok: true; credential: OwnerCredential }
  | { ok: false; reason: "owner-already-bound" | "challenge-missing" | "verification-failed" };

export async function finishOwnerRegistration(
  kv: KVNamespace,
  cfg: FinishRegistrationConfig,
  response: RegistrationResponseJSON,
  lookupExistingOwner: () => OwnerCredential | { id: string } | undefined
): Promise<FinishRegistrationResult> {
  if (lookupExistingOwner()) {
    return { ok: false, reason: "owner-already-bound" };
  }
  const expectedChallenge = await takeChallenge(kv, `webauthn:reg:${cfg.ownerUserId}`);
  if (!expectedChallenge) {
    return { ok: false, reason: "challenge-missing" };
  }
  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: cfg.expectedOrigin,
    expectedRPID: cfg.rpID
  });
  if (!verification.verified || !verification.registrationInfo) {
    return { ok: false, reason: "verification-failed" };
  }
  const { credential } = verification.registrationInfo;
  return { ok: true, credential: { id: credential.id, publicKey: credential.publicKey, counter: credential.counter } };
}
```
The single-owner short-circuit runs **before** `verifyRegistrationResponse`, so the test passes without a real WebAuthn response.

**Run:** `pnpm vitest run packages/remote-mcp-gateway/src/webauthn.test.ts` → **passes.**

**Commit:** `feat(gateway): single-owner registration binding (reject second owner)`

---

## Task 10 — Authentication options + verify (counter advance) against the bound owner

**Files:** `packages/remote-mcp-gateway/src/webauthn.ts` (extend), `webauthn.test.ts` (extend).

**Red:**
```ts
import { beginOwnerAuthentication, finishOwnerAuthentication } from "./webauthn";

it("auth options include the owner's credential and stash the challenge", async () => {
  const kv = new FakeKVNamespace();
  const options = await beginOwnerAuthentication(kv as never, {
    rpID: "atlas.example", ownerUserId: "la_owner_0001"
  }, [{ id: "cred-1", transports: ["internal"] }]);
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
```

**Run:** `pnpm vitest run packages/remote-mcp-gateway/src/webauthn.test.ts`
**Expect fail:** `beginOwnerAuthentication is not a function`.

**Green — add to `webauthn.ts`:**
```ts
import { generateAuthenticationOptions, verifyAuthenticationResponse } from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, AuthenticatorTransportFuture } from "@simplewebauthn/server";

export async function beginOwnerAuthentication(
  kv: KVNamespace,
  cfg: { rpID: string; ownerUserId: string },
  allowCredentials: Array<{ id: string; transports?: AuthenticatorTransportFuture[] }>
) {
  const options = await generateAuthenticationOptions({
    rpID: cfg.rpID,
    allowCredentials,
    userVerification: "required"
  });
  await putChallenge(kv, `webauthn:auth:${cfg.ownerUserId}`, options.challenge);
  return options;
}

export type FinishAuthResult =
  | { ok: true; newCounter: number }
  | { ok: false; reason: "challenge-missing" | "verification-failed" };

export async function finishOwnerAuthentication(
  kv: KVNamespace,
  cfg: { rpID: string; expectedOrigin: string; ownerUserId: string },
  response: AuthenticationResponseJSON,
  credential: OwnerCredential & { transports?: AuthenticatorTransportFuture[] }
): Promise<FinishAuthResult> {
  const expectedChallenge = await takeChallenge(kv, `webauthn:auth:${cfg.ownerUserId}`);
  if (!expectedChallenge) {
    return { ok: false, reason: "challenge-missing" };
  }
  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: cfg.expectedOrigin,
    expectedRPID: cfg.rpID,
    credential: {
      id: credential.id,
      publicKey: credential.publicKey,
      counter: credential.counter,
      transports: credential.transports
    }
  });
  return verification.verified
    ? { ok: true, newCounter: verification.authenticationInfo.newCounter }
    : { ok: false, reason: "verification-failed" };
}
```
The "challenge-missing" test hits the short-circuit before any real verification.

**Run:** `pnpm vitest run packages/remote-mcp-gateway/src/webauthn.test.ts` → **passes.**

**Commit:** `feat(gateway): owner passkey authentication options + verify`

---

# Phase 3 — Signed escalation grant (≤15 min) sign/verify

## Task 11 — Grant format + HMAC sign (gateway side)

**Files:**
- `packages/remote-crypto/src/grant-format.ts` (shared wire format so gateway & oracle can't drift)
- `packages/remote-crypto/src/index.ts` (export it)
- `packages/remote-mcp-gateway/src/grant.ts`
- `packages/remote-mcp-gateway/src/grant.test.ts`

**Red** `grant.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { signEscalationGrant } from "./grant";

const signingKey = "c2lnbmluZy1rZXktMzItYnl0ZXMtZm9yLWhtYWMtdGVzdA=="; // 32 bytes b64

describe("signEscalationGrant", () => {
  it("produces a grant with subject, object, ≤900s expiry, nonce, and a base64url signature", async () => {
    const now = Date.parse("2026-07-04T12:00:00.000Z");
    const grant = await signEscalationGrant(signingKey, {
      capability_id: "la_cap_owner0001",
      authority_id: "la_authority_worker0001",
      object_id: "la_object_ssn0001",
      issued_at_ms: now,
      ttl_seconds: 900,
      nonce: "nonce-abc"
    });
    expect(grant.payload.object_id).toBe("la_object_ssn0001");
    expect(grant.payload.expires_at_ms).toBe(now + 900_000);
    expect(grant.signature).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("refuses to sign a grant with a TTL over 900 seconds", async () => {
    await expect(signEscalationGrant(signingKey, {
      capability_id: "c", authority_id: "a", object_id: "o",
      issued_at_ms: 0, ttl_seconds: 901, nonce: "n"
    })).rejects.toThrow(/ttl/i);
  });
});
```

**Run:** `pnpm vitest run packages/remote-mcp-gateway/src/grant.test.ts`
**Expect fail:** `Cannot find module './grant'`.

**Green** `packages/remote-crypto/src/grant-format.ts`:
```ts
export const MAX_GRANT_TTL_SECONDS = 900;

export type EscalationGrantPayload = {
  v: 1;
  capability_id: string;
  authority_id: string;
  object_id: string;
  issued_at_ms: number;
  expires_at_ms: number;
  nonce: string;
};

export type SignedEscalationGrant = {
  payload: EscalationGrantPayload;
  signature: string; // base64url HMAC-SHA-256 over canonicalGrantBytes(payload)
};

export function canonicalGrantString(p: EscalationGrantPayload): string {
  return [
    "living-atlas-escalation-grant:v1",
    p.capability_id, p.authority_id, p.object_id,
    String(p.issued_at_ms), String(p.expires_at_ms), p.nonce
  ].join(":");
}
```
Export from `packages/remote-crypto/src/index.ts`: `export * from "./grant-format";`
`packages/remote-mcp-gateway/src/grant.ts`:
```ts
import {
  MAX_GRANT_TTL_SECONDS, canonicalGrantString,
  type EscalationGrantPayload, type SignedEscalationGrant
} from "@living-atlas/remote-crypto";

const encoder = new TextEncoder();

function fromBase64(value: string): Uint8Array {
  const norm = value.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(norm.padEnd(Math.ceil(norm.length / 4) * 4, "="));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function hmacKey(rawKeyB64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", fromBase64(rawKeyB64), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export type SignGrantInput = {
  capability_id: string; authority_id: string; object_id: string;
  issued_at_ms: number; ttl_seconds: number; nonce: string;
};

export async function signEscalationGrant(signingKeyB64: string, input: SignGrantInput): Promise<SignedEscalationGrant> {
  if (input.ttl_seconds > MAX_GRANT_TTL_SECONDS || input.ttl_seconds <= 0) {
    throw new Error(`escalation grant ttl must be 1..${MAX_GRANT_TTL_SECONDS} seconds`);
  }
  const payload: EscalationGrantPayload = {
    v: 1,
    capability_id: input.capability_id,
    authority_id: input.authority_id,
    object_id: input.object_id,
    issued_at_ms: input.issued_at_ms,
    expires_at_ms: input.issued_at_ms + input.ttl_seconds * 1000,
    nonce: input.nonce
  };
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(signingKeyB64), encoder.encode(canonicalGrantString(payload))));
  return { payload, signature: toBase64Url(sig) };
}
```

**Run:** `pnpm vitest run packages/remote-mcp-gateway/src/grant.test.ts` → **passes.**

**Commit:** `feat(gateway): sign ≤15-min escalation grants (HMAC-SHA-256)`

---

## Task 12 — Grant verify (oracle side): signature, expiry, replay

**Files:**
- `packages/local-decryption-oracle/package.json`
- `packages/local-decryption-oracle/src/grant-verify.ts`
- `packages/local-decryption-oracle/src/grant-verify.test.ts`

**Red** `grant-verify.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { signEscalationGrant } from "@living-atlas/remote-mcp-gateway/grant";
import { verifyEscalationGrant, InMemoryNonceSeen } from "./grant-verify";

const signingKey = "c2lnbmluZy1rZXktMzItYnl0ZXMtZm9yLWhtYWMtdGVzdA==";

describe("verifyEscalationGrant", () => {
  it("accepts a fresh, correctly-signed grant once and rejects the replay", async () => {
    const now = Date.parse("2026-07-04T12:00:00.000Z");
    const grant = await signEscalationGrant(signingKey, {
      capability_id: "c", authority_id: "a", object_id: "o",
      issued_at_ms: now, ttl_seconds: 900, nonce: "n1"
    });
    const seen = new InMemoryNonceSeen();
    expect(await verifyEscalationGrant(signingKey, grant, { now_ms: now + 1000, seen })).toEqual({ ok: true });
    expect(await verifyEscalationGrant(signingKey, grant, { now_ms: now + 2000, seen })).toEqual({ ok: false, reason: "replayed" });
  });

  it("rejects an expired grant and a tampered signature", async () => {
    const now = Date.parse("2026-07-04T12:00:00.000Z");
    const grant = await signEscalationGrant(signingKey, {
      capability_id: "c", authority_id: "a", object_id: "o",
      issued_at_ms: now, ttl_seconds: 900, nonce: "n2"
    });
    const seen = new InMemoryNonceSeen();
    expect(await verifyEscalationGrant(signingKey, grant, { now_ms: now + 901_000, seen })).toEqual({ ok: false, reason: "expired" });
    const tampered = { ...grant, payload: { ...grant.payload, object_id: "o-evil" } };
    expect(await verifyEscalationGrant(signingKey, tampered, { now_ms: now + 1000, seen: new InMemoryNonceSeen() })).toEqual({ ok: false, reason: "bad-signature" });
  });
});
```

**Run:** `pnpm vitest run packages/local-decryption-oracle/src/grant-verify.test.ts`
**Expect fail:** `Cannot find module '@living-atlas/remote-mcp-gateway/grant'` (add the subpath export in this task) then `Cannot find module './grant-verify'`.

**Green:** Add subpath export to `packages/remote-mcp-gateway/package.json`: `"./grant": "./src/grant.ts"`.
`packages/local-decryption-oracle/package.json`:
```json
{
  "name": "@living-atlas/local-decryption-oracle",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts", "./grant-verify": "./src/grant-verify.ts" },
  "dependencies": {
    "@living-atlas/contracts": "workspace:*",
    "@living-atlas/remote-crypto": "workspace:*",
    "@living-atlas/remote-mcp-gateway": "workspace:*"
  }
}
```
`packages/local-decryption-oracle/src/grant-verify.ts`:
```ts
import { canonicalGrantString, type SignedEscalationGrant } from "@living-atlas/remote-crypto";

export interface NonceSeen {
  seenBefore(nonce: string): Promise<boolean>;
  remember(nonce: string, expiresAtMs: number): Promise<void>;
}

export class InMemoryNonceSeen implements NonceSeen {
  private seen = new Map<string, number>();
  async seenBefore(nonce: string): Promise<boolean> { return this.seen.has(nonce); }
  async remember(nonce: string, expiresAtMs: number): Promise<void> { this.seen.set(nonce, expiresAtMs); }
}

const encoder = new TextEncoder();
function fromBase64Url(value: string): Uint8Array {
  const norm = value.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(norm.padEnd(Math.ceil(norm.length / 4) * 4, "="));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
function fromBase64(value: string): Uint8Array { return fromBase64Url(value); }

export type GrantVerifyResult =
  | { ok: true }
  | { ok: false; reason: "bad-signature" | "expired" | "replayed" };

export async function verifyEscalationGrant(
  signingKeyB64: string,
  grant: SignedEscalationGrant,
  ctx: { now_ms: number; seen: NonceSeen }
): Promise<GrantVerifyResult> {
  const key = await crypto.subtle.importKey("raw", fromBase64(signingKeyB64), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("HMAC", key, fromBase64Url(grant.signature), encoder.encode(canonicalGrantString(grant.payload)));
  if (!ok) return { ok: false, reason: "bad-signature" };
  if (ctx.now_ms >= grant.payload.expires_at_ms) return { ok: false, reason: "expired" };
  if (await ctx.seen.seenBefore(grant.payload.nonce)) return { ok: false, reason: "replayed" };
  await ctx.seen.remember(grant.payload.nonce, grant.payload.expires_at_ms);
  return { ok: true };
}
```
Run `pnpm install`.

**Run:** `pnpm vitest run packages/local-decryption-oracle/src/grant-verify.test.ts` → **passes.**

**Commit:** `feat(oracle): verify escalation grants (signature, expiry, replay)`

---

## Task 13 — Oracle T2 decrypt: valid grant unlocks, invalid grant fails safe

**Files:**
- `packages/local-decryption-oracle/src/oracle.ts`
- `packages/local-decryption-oracle/src/oracle.test.ts`

**Red** `oracle.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { encryptEscalatedCloudUnlockObject } from "@living-atlas/remote-crypto";
import { signEscalationGrant } from "@living-atlas/remote-mcp-gateway/grant";
import { createLocalOracle, InMemoryNonceSeen } from "./oracle";

const signingKey = "c2lnbmluZy1rZXktMzItYnl0ZXMtZm9yLWhtYWMtdGVzdA==";
function key32(seed: number): string {
  let b = ""; for (let i = 0; i < 32; i++) b += String.fromCharCode((i * 7 + seed) % 256);
  return btoa(b);
}
const escalationKey = key32(2);
const ts = "2026-07-04T12:00:00.000Z";

const envelopeIdentity = {
  schema_version: 1, authority_id: "la_authority_worker0001", object_id: "la_object_ssn0001",
  object_type: "page", version: 1, access_class: "super-sensitive", encryption_class: "client-encrypted",
  created_at: ts, updated_at: ts, key_ref: "la_key_esc0001",
  visible_metadata: { tombstone: false, size_class: "tiny", remote_indexable: false }
} as const;

describe("local oracle T2 decrypt", () => {
  it("decrypts a super-sensitive object under a valid grant", async () => {
    const object = await encryptEscalatedCloudUnlockObject({
      envelope: envelopeIdentity as never, plaintext: { ssn: "123-45-6789" }, encodedEscalationKey: escalationKey
    });
    const now = Date.parse(ts);
    const grant = await signEscalationGrant(signingKey, {
      capability_id: "la_cap_owner0001", authority_id: object.authority_id, object_id: object.object_id,
      issued_at_ms: now, ttl_seconds: 900, nonce: "n-decrypt"
    });
    const oracle = createLocalOracle({ signingKeyB64: signingKey, escalationKeyB64: escalationKey, seen: new InMemoryNonceSeen(), now: () => now + 1000 });
    const result = await oracle.decrypt({ grant, object });
    expect(result).toEqual({ ok: true, plaintext: { kind: "plaintext-json", data: { ssn: "123-45-6789" } } });
  });

  it("refuses when the grant is for a different object (fails safe)", async () => {
    const object = await encryptEscalatedCloudUnlockObject({
      envelope: envelopeIdentity as never, plaintext: { ssn: "x" }, encodedEscalationKey: escalationKey
    });
    const now = Date.parse(ts);
    const grant = await signEscalationGrant(signingKey, {
      capability_id: "c", authority_id: object.authority_id, object_id: "la_object_OTHER", issued_at_ms: now, ttl_seconds: 900, nonce: "n-mismatch"
    });
    const oracle = createLocalOracle({ signingKeyB64: signingKey, escalationKeyB64: escalationKey, seen: new InMemoryNonceSeen(), now: () => now + 1000 });
    expect(await oracle.decrypt({ grant, object })).toEqual({ ok: false, reason: "grant-object-mismatch" });
  });
});
```

**Run:** `pnpm vitest run packages/local-decryption-oracle/src/oracle.test.ts`
**Expect fail:** `Cannot find module './oracle'`.

**Green** `packages/local-decryption-oracle/src/oracle.ts`:
```ts
import { decryptEscalatedCloudUnlockObject, type SignedEscalationGrant } from "@living-atlas/remote-crypto";
import type { GraphObjectEnvelope } from "@living-atlas/contracts";
import { verifyEscalationGrant, InMemoryNonceSeen, type NonceSeen } from "./grant-verify";

export { InMemoryNonceSeen } from "./grant-verify";

export type OracleConfig = {
  signingKeyB64: string;
  escalationKeyB64: string;
  seen: NonceSeen;
  now: () => number;
};

export type OracleDecryptResult =
  | { ok: true; plaintext: { kind: "plaintext-json"; data: Record<string, unknown> } }
  | { ok: false; reason: "grant-object-mismatch" | "bad-signature" | "expired" | "replayed" | "decrypt-failed" | "unsupported-algorithm" | "unsupported-payload" | "invalid-escalation-key" };

export function createLocalOracle(config: OracleConfig) {
  return {
    async decrypt(input: { grant: SignedEscalationGrant; object: GraphObjectEnvelope }): Promise<OracleDecryptResult> {
      if (input.grant.payload.object_id !== input.object.object_id || input.grant.payload.authority_id !== input.object.authority_id) {
        return { ok: false, reason: "grant-object-mismatch" };
      }
      const verified = await verifyEscalationGrant(config.signingKeyB64, input.grant, { now_ms: config.now(), seen: config.seen });
      if (!verified.ok) return { ok: false, reason: verified.reason };
      const decrypted = await decryptEscalatedCloudUnlockObject(input.object, config.escalationKeyB64);
      return decrypted.ok ? { ok: true, plaintext: decrypted.plaintext } : { ok: false, reason: decrypted.reason };
    }
  };
}
```

**Run:** `pnpm vitest run packages/local-decryption-oracle/src/oracle.test.ts` → **passes.**

**Commit:** `feat(oracle): T2 decrypt gated by grant + object binding (fail-safe)`

---

# Phase 4 — Guardrails as tested units

## Task 14 — T2 audit-ledger write + alert hook fires on every escalated decrypt

**Files:**
- `packages/remote-mcp-gateway/src/guardrails.ts`
- `packages/remote-mcp-gateway/src/guardrails.test.ts`

**Red** `guardrails.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { recordT2Decrypt } from "./guardrails";

describe("recordT2Decrypt", () => {
  it("writes one audit row and fires the alert hook exactly once", async () => {
    const rows: unknown[] = [];
    const alerts: unknown[] = [];
    await recordT2Decrypt(
      { appendAudit: async (e) => { rows.push(e); }, alert: async (a) => { alerts.push(a); } },
      { capability_id: "la_cap_owner0001", authority_id: "la_authority_worker0001", object_id: "la_object_ssn0001", at_iso: "2026-07-04T12:00:00.000Z" }
    );
    expect(rows).toHaveLength(1);
    expect(alerts).toHaveLength(1);
    expect((rows[0] as { event_type: string }).event_type).toBe("object.decrypt");
    expect((alerts[0] as { object_id: string }).object_id).toBe("la_object_ssn0001");
  });
});
```

**Run:** `pnpm vitest run packages/remote-mcp-gateway/src/guardrails.test.ts`
**Expect fail:** `Cannot find module './guardrails'`.

**Green** `guardrails.ts`:
```ts
export type T2AuditEvent = {
  event_type: "object.decrypt";
  outcome: "allowed";
  capability_id: string;
  authority_id: string;
  object_id: string;
  recorded_at: string;
  tier: "super-sensitive";
};
export type T2Alert = { authority_id: string; object_id: string; capability_id: string; at: string };

export type GuardrailSinks = {
  appendAudit: (event: T2AuditEvent) => Promise<void>;
  alert: (alert: T2Alert) => Promise<void>;
};

export async function recordT2Decrypt(
  sinks: GuardrailSinks,
  ctx: { capability_id: string; authority_id: string; object_id: string; at_iso: string }
): Promise<void> {
  await sinks.appendAudit({
    event_type: "object.decrypt",
    outcome: "allowed",
    capability_id: ctx.capability_id,
    authority_id: ctx.authority_id,
    object_id: ctx.object_id,
    recorded_at: ctx.at_iso,
    tier: "super-sensitive"
  });
  await sinks.alert({ authority_id: ctx.authority_id, object_id: ctx.object_id, capability_id: ctx.capability_id, at: ctx.at_iso });
}
```

**Run:** `pnpm vitest run packages/remote-mcp-gateway/src/guardrails.test.ts` → **passes.**

**Commit:** `feat(gateway): T2 audit + alert guardrail`

---

## Task 15 — Instant kill-switch: revoked capability → stealth 404 (no oracle contact)

**Files:** `packages/remote-mcp-gateway/src/guardrails.ts` (extend), `guardrails.test.ts` (extend).

**Red:**
```ts
import { isRevoked, assertNotRevoked } from "./guardrails";

it("treats a capability listed in the revocation set as revoked", () => {
  const revoked = new Set(["la_cap_bad0001"]);
  expect(isRevoked(revoked, "la_cap_bad0001")).toBe(true);
  expect(isRevoked(revoked, "la_cap_owner0001")).toBe(false);
});

it("assertNotRevoked throws kill-switch-revoked for a revoked capability", () => {
  expect(() => assertNotRevoked(new Set(["c"]), "c")).toThrow(/kill-switch-revoked/);
});
```

**Run:** `pnpm vitest run packages/remote-mcp-gateway/src/guardrails.test.ts`
**Expect fail:** `isRevoked is not a function`.

**Green — add to `guardrails.ts`:**
```ts
export function parseRevocationSet(json: string | undefined): Set<string> {
  if (!json) return new Set();
  try {
    const parsed = JSON.parse(json);
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}
export function isRevoked(revoked: Set<string>, capabilityId: string): boolean {
  return revoked.has(capabilityId);
}
export function assertNotRevoked(revoked: Set<string>, capabilityId: string): void {
  if (revoked.has(capabilityId)) throw new Error("kill-switch-revoked");
}
```
> Wiring note (implemented in Task 18): the agent reads the revocation set from an env var / KV so a single edit revokes without redeploy; a revoked request returns the stealth 404 already produced by the Task 3 path.

**Run:** `pnpm vitest run packages/remote-mcp-gateway/src/guardrails.test.ts` → **passes.**

**Commit:** `feat(gateway): instant kill-switch revocation set`

---

## Task 16 — Per-capability rate limit (configurable, sliding window)

**Files:**
- `packages/remote-mcp-gateway/src/rate-limit.ts`
- `packages/remote-mcp-gateway/src/rate-limit.test.ts`

**Red** `rate-limit.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { checkRateLimit, InMemoryRateCounter } from "./rate-limit";

describe("checkRateLimit", () => {
  it("allows up to the configured per-minute limit then blocks", async () => {
    const counter = new InMemoryRateCounter();
    const at = Date.parse("2026-07-04T12:00:00.000Z");
    const opts = { capability_id: "c", limit_per_minute: 3, now_ms: at };
    expect((await checkRateLimit(counter, opts)).allowed).toBe(true);
    expect((await checkRateLimit(counter, opts)).allowed).toBe(true);
    expect((await checkRateLimit(counter, opts)).allowed).toBe(true);
    expect(await checkRateLimit(counter, opts)).toEqual({ allowed: false, reason: "rate-limited" });
  });

  it("resets after the window advances", async () => {
    const counter = new InMemoryRateCounter();
    const at = Date.parse("2026-07-04T12:00:00.000Z");
    await checkRateLimit(counter, { capability_id: "c", limit_per_minute: 1, now_ms: at });
    expect((await checkRateLimit(counter, { capability_id: "c", limit_per_minute: 1, now_ms: at + 60_001 })).allowed).toBe(true);
  });
});
```

**Run:** `pnpm vitest run packages/remote-mcp-gateway/src/rate-limit.test.ts`
**Expect fail:** `Cannot find module './rate-limit'`.

**Green** `rate-limit.ts`:
```ts
export interface RateCounter {
  incr(bucketKey: string, windowExpiresAtMs: number): Promise<number>;
}
export class InMemoryRateCounter implements RateCounter {
  private buckets = new Map<string, { count: number; expiresAtMs: number }>();
  async incr(bucketKey: string, windowExpiresAtMs: number): Promise<number> {
    const existing = this.buckets.get(bucketKey);
    if (!existing || existing.expiresAtMs <= Date.now()) {
      this.buckets.set(bucketKey, { count: 1, expiresAtMs: windowExpiresAtMs });
      return 1;
    }
    existing.count += 1;
    return existing.count;
  }
}
export type RateCheckResult = { allowed: true } | { allowed: false; reason: "rate-limited" };
export async function checkRateLimit(
  counter: RateCounter,
  opts: { capability_id: string; limit_per_minute: number; now_ms: number }
): Promise<RateCheckResult> {
  const windowStart = Math.floor(opts.now_ms / 60_000) * 60_000;
  const bucketKey = `${opts.capability_id}:${windowStart}`;
  const count = await counter.incr(bucketKey, windowStart + 60_000);
  return count <= opts.limit_per_minute ? { allowed: true } : { allowed: false, reason: "rate-limited" };
}
```
> The `InMemoryRateCounter` here uses `Date.now()` for expiry only in the fallback branch; the test drives the window via `now_ms` bucket keys, so the two "windows" produce different `bucketKey`s and the reset test passes deterministically.

**Run:** `pnpm vitest run packages/remote-mcp-gateway/src/rate-limit.test.ts` → **passes.**

**Commit:** `feat(gateway): per-capability configurable rate limit`

---

## Task 17 — Field-redaction hook (off by default), rule-driven masking

**Files:**
- `packages/remote-mcp-gateway/src/redaction.ts`
- `packages/remote-mcp-gateway/src/redaction.test.ts`

**Red** `redaction.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { applyRedaction, loadRedactionRules } from "./redaction";

describe("applyRedaction", () => {
  it("is a no-op when no rules are configured (off by default)", () => {
    const rules = loadRedactionRules(undefined);
    const data = { name: "Jen", address: "123 Main St", amount: 4200 };
    expect(applyRedaction(rules, data)).toEqual(data);
  });

  it("masks configured fields when rules are present", () => {
    const rules = loadRedactionRules(JSON.stringify({ mask_fields: ["address", "amount"] }));
    const out = applyRedaction(rules, { name: "Jen", address: "123 Main St", amount: 4200 });
    expect(out).toEqual({ name: "Jen", address: "[redacted]", amount: "[redacted]" });
  });
});
```

**Run:** `pnpm vitest run packages/remote-mcp-gateway/src/redaction.test.ts`
**Expect fail:** `Cannot find module './redaction'`.

**Green** `redaction.ts`:
```ts
import { z } from "zod";
const RedactionRulesSchema = z.object({ mask_fields: z.array(z.string()).default([]) });
export type RedactionRules = { maskFields: Set<string> };

export function loadRedactionRules(json: string | undefined): RedactionRules {
  if (!json) return { maskFields: new Set() };
  const parsed = RedactionRulesSchema.safeParse(JSON.parse(json));
  return { maskFields: new Set(parsed.success ? parsed.data.mask_fields : []) };
}

export function applyRedaction(rules: RedactionRules, data: Record<string, unknown>): Record<string, unknown> {
  if (rules.maskFields.size === 0) return data;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    out[key] = rules.maskFields.has(key) ? "[redacted]" : value;
  }
  return out;
}
```

**Run:** `pnpm vitest run packages/remote-mcp-gateway/src/redaction.test.ts` → **passes.**

**Commit:** `feat(gateway): field-redaction hook (off by default)`

---

## Task 18 — Key-rotation version tag + scheduled sweep selection

**Files:**
- `packages/remote-mcp-gateway/src/rotation.ts`
- `packages/remote-mcp-gateway/src/rotation.test.ts`

**Red** `rotation.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { currentKeyVersion, selectStaleForRotation } from "./rotation";

describe("key rotation", () => {
  it("reports the active version tag for a tier", () => {
    expect(currentKeyVersion({ T1_KEY_VERSION: "v3", T2_KEY_VERSION: "v2" }, "T1")).toBe("v3");
    expect(currentKeyVersion({ T1_KEY_VERSION: "v3", T2_KEY_VERSION: "v2" }, "T2")).toBe("v2");
  });

  it("selects only objects whose key_version lags the active version, bounded by sweep size", () => {
    const objects = [
      { object_id: "o1", key_version: "v3" },
      { object_id: "o2", key_version: "v2" },
      { object_id: "o3", key_version: "v1" }
    ];
    expect(selectStaleForRotation(objects, "v3", 10).map((o) => o.object_id)).toEqual(["o2", "o3"]);
    expect(selectStaleForRotation(objects, "v3", 1).map((o) => o.object_id)).toEqual(["o2"]);
  });
});
```

**Run:** `pnpm vitest run packages/remote-mcp-gateway/src/rotation.test.ts`
**Expect fail:** `Cannot find module './rotation'`.

**Green** `rotation.ts`:
```ts
export type Tier = "T1" | "T2";
export function currentKeyVersion(env: { T1_KEY_VERSION?: string; T2_KEY_VERSION?: string }, tier: Tier): string {
  const value = tier === "T1" ? env.T1_KEY_VERSION : env.T2_KEY_VERSION;
  if (!value) throw new Error(`missing key version for tier ${tier}`);
  return value;
}
export function selectStaleForRotation<T extends { key_version: string }>(objects: readonly T[], activeVersion: string, maxSweep: number): T[] {
  return objects.filter((o) => o.key_version !== activeVersion).slice(0, maxSweep);
}
```

**Run:** `pnpm vitest run packages/remote-mcp-gateway/src/rotation.test.ts` → **passes.**

**Commit:** `feat(gateway): key-rotation version tag + scheduled sweep selection`

---

# Phase 5 — Oracle client (mTLS) + T1 secret injection

## Task 19 — Oracle client posts grant+object to an injectable fetch, maps outcomes

**Files:**
- `packages/remote-mcp-gateway/src/oracle-client.ts`
- `packages/remote-mcp-gateway/src/oracle-client.test.ts`

**Red** `oracle-client.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { callDecryptionOracle } from "./oracle-client";

describe("callDecryptionOracle", () => {
  it("returns plaintext on a 200 oracle response", async () => {
    const fakeFetch = async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.grant.payload.object_id).toBe("la_object_ssn0001");
      return new Response(JSON.stringify({ ok: true, plaintext: { kind: "plaintext-json", data: { ssn: "x" } } }), { status: 200 });
    };
    const result = await callDecryptionOracle(fakeFetch as never, "https://oracle.internal/decrypt", {
      grant: { payload: { object_id: "la_object_ssn0001" }, signature: "s" } as never,
      object: { object_id: "la_object_ssn0001" } as never
    });
    expect(result).toEqual({ ok: true, plaintext: { kind: "plaintext-json", data: { ssn: "x" } } });
  });

  it("fails safe with owner-offline when the oracle is unreachable", async () => {
    const fakeFetch = async () => { throw new Error("ECONNREFUSED"); };
    const result = await callDecryptionOracle(fakeFetch as never, "https://oracle.internal/decrypt", {
      grant: { payload: { object_id: "o" }, signature: "s" } as never, object: { object_id: "o" } as never
    });
    expect(result).toEqual({ ok: false, reason: "owner-offline" });
  });
});
```

**Run:** `pnpm vitest run packages/remote-mcp-gateway/src/oracle-client.test.ts`
**Expect fail:** `Cannot find module './oracle-client'`.

**Green** `oracle-client.ts`:
```ts
import type { SignedEscalationGrant } from "@living-atlas/remote-crypto";
import type { GraphObjectEnvelope } from "@living-atlas/contracts";

export type OracleClientResult =
  | { ok: true; plaintext: { kind: "plaintext-json"; data: Record<string, unknown> } }
  | { ok: false; reason: "owner-offline" | "oracle-denied" };

export async function callDecryptionOracle(
  fetchImpl: typeof fetch,
  oracleUrl: string,
  input: { grant: SignedEscalationGrant; object: GraphObjectEnvelope }
): Promise<OracleClientResult> {
  let response: Response;
  try {
    response = await fetchImpl(oracleUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant: input.grant, object: input.object })
    });
  } catch {
    return { ok: false, reason: "owner-offline" };
  }
  if (response.status !== 200) {
    return { ok: false, reason: "oracle-denied" };
  }
  const body = (await response.json()) as OracleClientResult;
  return body.ok ? body : { ok: false, reason: "oracle-denied" };
}
```
> `fetchImpl` is injected so unit tests never open a socket. In production it is the **mTLS certificate binding**'s `fetch` reaching the oracle over a Cloudflare Tunnel (deployment gate).

**Run:** `pnpm vitest run packages/remote-mcp-gateway/src/oracle-client.test.ts` → **passes.**

**Commit:** `feat(gateway): mTLS oracle client with owner-offline fail-safe`

---

## Task 20 — Tier resolver: safe → T1 (CF secret) → T2 (oracle), enforcing ceiling + guardrails

**Files:**
- `packages/remote-mcp-gateway/src/decrypt-resolver.ts`
- `packages/remote-mcp-gateway/src/decrypt-resolver.test.ts`

**Red** `decrypt-resolver.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { encryptCloudUnlockObject, encryptEscalatedCloudUnlockObject } from "@living-atlas/remote-crypto";
import { resolveDecrypt } from "./decrypt-resolver";

function key32(seed: number): string {
  let b = ""; for (let i = 0; i < 32; i++) b += String.fromCharCode((i * 7 + seed) % 256);
  return btoa(b);
}
const t1Key = key32(1);
const escKey = key32(2);
const ts = "2026-07-04T12:00:00.000Z";
const identity = {
  schema_version: 1, authority_id: "la_authority_worker0001", object_id: "la_object_x",
  object_type: "page", version: 1, access_class: "cloud-shareable", encryption_class: "client-encrypted",
  created_at: ts, updated_at: ts, key_ref: "la_key_x",
  visible_metadata: { tombstone: false, size_class: "tiny", remote_indexable: true }
} as const;

describe("resolveDecrypt", () => {
  it("denies T1 plaintext under a remote-safe-only ceiling", async () => {
    const object = await encryptCloudUnlockObject({ envelope: identity as never, plaintext: { a: 1 }, encodedUnlockKey: t1Key });
    const result = await resolveDecrypt({
      policy: { capability_id: "c", tier_ceiling: "remote-safe-only", rate_limit_per_minute: 10 },
      object, cloudUnlockKeyB64: t1Key, callOracle: async () => { throw new Error("must not call oracle"); },
      signGrant: async () => { throw new Error("nope"); }, recordT2: async () => {}, nowIso: ts
    });
    expect(result).toEqual({ ok: false, reason: "above-ceiling", tier: "T1" });
  });

  it("injects the CF T1 secret to decrypt a normal object under a T1 ceiling", async () => {
    const object = await encryptCloudUnlockObject({ envelope: identity as never, plaintext: { a: 1 }, encodedUnlockKey: t1Key });
    const result = await resolveDecrypt({
      policy: { capability_id: "c", tier_ceiling: "T1", rate_limit_per_minute: 10 },
      object, cloudUnlockKeyB64: t1Key, callOracle: async () => { throw new Error("must not call oracle"); },
      signGrant: async () => { throw new Error("nope"); }, recordT2: async () => {}, nowIso: ts
    });
    expect(result).toEqual({ ok: true, tier: "T1", plaintext: { kind: "plaintext-json", data: { a: 1 } } });
  });

  it("brokers a T2 object to the oracle under a T2 ceiling and records the guardrail", async () => {
    const object = await encryptEscalatedCloudUnlockObject({ envelope: identity as never, plaintext: { ssn: "x" }, encodedEscalationKey: escKey });
    let recorded = 0;
    const result = await resolveDecrypt({
      policy: { capability_id: "c", tier_ceiling: "T2", rate_limit_per_minute: 10 },
      object, cloudUnlockKeyB64: t1Key,
      signGrant: async () => ({ payload: { object_id: object.object_id }, signature: "s" } as never),
      callOracle: async () => ({ ok: true, plaintext: { kind: "plaintext-json", data: { ssn: "x" } } }),
      recordT2: async () => { recorded += 1; }, nowIso: ts
    });
    expect(result).toEqual({ ok: true, tier: "T2", plaintext: { kind: "plaintext-json", data: { ssn: "x" } } });
    expect(recorded).toBe(1);
  });
});
```

**Run:** `pnpm vitest run packages/remote-mcp-gateway/src/decrypt-resolver.test.ts`
**Expect fail:** `Cannot find module './decrypt-resolver'`.

**Green** `decrypt-resolver.ts`:
```ts
import type { GraphObjectEnvelope } from "@living-atlas/contracts";
import {
  CloudUnlockEscalatedObjectAlgorithm, decryptCloudUnlockObject, type SignedEscalationGrant
} from "@living-atlas/remote-crypto";
import { decideTierAccess, type CapabilityPolicy } from "./policy";
import type { OracleClientResult } from "./oracle-client";

type Plain = { kind: "plaintext-json"; data: Record<string, unknown> };

export type ResolveDecryptInput = {
  policy: CapabilityPolicy;
  object: GraphObjectEnvelope;
  cloudUnlockKeyB64: string;
  signGrant: (object: GraphObjectEnvelope) => Promise<SignedEscalationGrant>;
  callOracle: (grant: SignedEscalationGrant, object: GraphObjectEnvelope) => Promise<OracleClientResult>;
  recordT2: (ctx: { capability_id: string; authority_id: string; object_id: string; at_iso: string }) => Promise<void>;
  nowIso: string;
};

export type ResolveDecryptResult =
  | { ok: true; tier: "T1" | "T2"; plaintext: Plain }
  | { ok: false; tier: "T1" | "T2"; reason: string };

function objectTier(object: GraphObjectEnvelope): "T1" | "T2" {
  return object.payload.kind === "ciphertext-inline" && object.payload.algorithm === CloudUnlockEscalatedObjectAlgorithm ? "T2" : "T1";
}

export async function resolveDecrypt(input: ResolveDecryptInput): Promise<ResolveDecryptResult> {
  const tier = objectTier(input.object);
  const requested = tier === "T2" ? "T2" : "T1";
  const decision = decideTierAccess(input.policy, requested);
  if (!decision.allowed) {
    return { ok: false, tier, reason: "above-ceiling" };
  }
  if (tier === "T1") {
    const decrypted = await decryptCloudUnlockObject(input.object, input.cloudUnlockKeyB64);
    return decrypted.ok ? { ok: true, tier, plaintext: decrypted.plaintext } : { ok: false, tier, reason: decrypted.reason };
  }
  const grant = await input.signGrant(input.object);
  const oracleResult = await input.callOracle(grant, input.object);
  if (!oracleResult.ok) {
    return { ok: false, tier, reason: oracleResult.reason };
  }
  await input.recordT2({ capability_id: input.policy.capability_id, authority_id: input.object.authority_id, object_id: input.object.object_id, at_iso: input.nowIso });
  return { ok: true, tier, plaintext: oracleResult.plaintext };
}
```

**Run:** `pnpm vitest run packages/remote-mcp-gateway/src/decrypt-resolver.test.ts` → **passes.**

**Commit:** `feat(gateway): tier resolver (safe/T1-secret/T2-oracle) with ceiling + audit`

---

# Phase 6 — OAuthProvider + McpAgent wiring

## Task 21 — McpAgent registers the `remote_*` tool catalog from `mcp-contract`

**Files:**
- `packages/remote-mcp-gateway/src/agent.ts`
- `packages/remote-mcp-gateway/src/agent.test.ts`

**Red** `agent.test.ts` (assert the pure tool-registration surface, not the network):
```ts
import { describe, expect, it } from "vitest";
import { remoteToolNames } from "./agent";
import { LivingAtlasMcpToolNames } from "@living-atlas/mcp-contract";

describe("gateway agent tool surface", () => {
  it("exposes exactly the mcp-contract catalog, prefixed remote_", () => {
    expect(remoteToolNames()).toEqual(LivingAtlasMcpToolNames.map((n) => `remote_${n}`));
  });
});
```

**Run:** `pnpm vitest run packages/remote-mcp-gateway/src/agent.test.ts`
**Expect fail:** `Cannot find module './agent'`.

**Green** `agent.ts` (registration list is a pure function so it is testable without instantiating the DO):
```ts
import { LivingAtlasMcpToolNames, type LivingAtlasMcpToolName } from "@living-atlas/mcp-contract";

export function remoteToolNames(): string[] {
  return LivingAtlasMcpToolNames.map((name) => `remote_${name}`);
}

export function toRemoteToolName(name: LivingAtlasMcpToolName): string {
  return `remote_${name}`;
}
```
> The `McpAgent` subclass that calls `this.server.tool(...)` for each of these is added in Task 22; its constructor/`init()` are exercised by the integration surface, but the *catalog* is unit-tested here so drift from `mcp-contract` is caught cheaply.

**Run:** `pnpm vitest run packages/remote-mcp-gateway/src/agent.test.ts` → **passes.**

**Commit:** `feat(gateway): remote_ tool catalog mirrors mcp-contract`

---

## Task 22 — `LivingAtlasRemoteMcp extends McpAgent`: init registers tools, props carries capability

**Files:**
- `packages/remote-mcp-gateway/src/agent.ts` (extend)
- `packages/remote-mcp-gateway/src/agent.test.ts` (extend)

**Red** — assert the agent builds its tool registrations from props without needing a live DO. Extract the registration into a pure builder:
```ts
import { buildToolRegistrations, type GatewayProps } from "./agent";

it("builds one registration per catalog tool and closes over the caller's capability", () => {
  const props: GatewayProps = { capability_id: "la_cap_owner0001", authority_id: "la_authority_worker0001" };
  const regs = buildToolRegistrations(props);
  expect(regs).toHaveLength(remoteToolNames().length);
  expect(regs.every((r) => r.name.startsWith("remote_"))).toBe(true);
  expect(regs[0]?.capability_id).toBe("la_cap_owner0001");
});
```

**Run:** `pnpm vitest run packages/remote-mcp-gateway/src/agent.test.ts`
**Expect fail:** `buildToolRegistrations is not a function`.

**Green — add to `agent.ts`:**
```ts
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LivingAtlasMcpToolDefinitions } from "@living-atlas/mcp-contract";

export type GatewayProps = { capability_id: string; authority_id: string };

export type ToolRegistration = { name: string; description: string; capability_id: string };

export function buildToolRegistrations(props: GatewayProps): ToolRegistration[] {
  return LivingAtlasMcpToolDefinitions.map((def) => ({
    name: `remote_${def.name}`,
    description: def.description,
    capability_id: props.capability_id
  }));
}

export type GatewayEnv = {
  LA_CAPABILITY_POLICY_JSON?: string;
  LA_REVOCATION_JSON?: string;
  LA_CLOUD_UNLOCK_KEY?: string;   // T1 secret (CF secret)
  LA_GRANT_SIGNING_KEY?: string;  // escalation grant HMAC key (CF secret)
  LA_ORACLE_URL?: string;
  OAUTH_KV: KVNamespace;
};

export class LivingAtlasRemoteMcp extends McpAgent<GatewayEnv, unknown, GatewayProps> {
  server = new McpServer({ name: "living-atlas-remote-mcp", version: "0.1.0" });

  async init(): Promise<void> {
    for (const reg of buildToolRegistrations(this.props)) {
      // Task 23 replaces the stub body with the policy/decrypt pipeline; the
      // registration wiring itself is what this task proves.
      this.server.tool(reg.name, reg.description, {}, async () => ({
        content: [{ type: "text", text: JSON.stringify({ ok: true, tool: reg.name }) }]
      }));
    }
  }
}
```
> Add deps in `package.json`: `"@modelcontextprotocol/sdk"` (transitive of `agents`, but pin explicitly). If the installed `agents` re-exports `McpServer`, import from `agents/mcp` instead — verify against the pinned version and cite the source in the commit.

**Run:** `pnpm vitest run packages/remote-mcp-gateway/src/agent.test.ts` → **passes.**
**Run:** `pnpm typecheck` → passes (fix imports if the SDK export path differs for the pinned version).

**Commit:** `feat(gateway): McpAgent registers remote tools from props`

---

## Task 23 — Wire OAuthProvider (allowlisted DCR, PKCE) as the worker default export

**Files:**
- `packages/remote-mcp-gateway/src/index.ts` (replace the Task 3 stub)
- `packages/remote-mcp-gateway/src/auth-handler.ts`
- `packages/remote-mcp-gateway/src/index.test.ts` (extend)

**Red — assert the OAuth metadata surface exists** (a well-known route the provider serves, proving the provider is mounted):
```ts
it("serves OAuth authorization-server metadata (provider mounted)", async () => {
  const env = makeTestEnv(); // helper builds OAUTH_KV etc. via FakeKVNamespace
  const res = await worker.fetch(new Request("https://gw.example/.well-known/oauth-authorization-server"), env, {} as never);
  expect(res.status).toBe(200);
  const body = await res.json() as { token_endpoint: string };
  expect(body.token_endpoint).toContain("/token");
});
```
> If the pinned `@cloudflare/workers-oauth-provider` serves the metadata under a different well-known path, adapt the assertion to the path the library actually publishes (check the README's "endpoints" section) and cite it.

**Run:** `pnpm vitest run packages/remote-mcp-gateway/src/index.test.ts`
**Expect fail:** the Task 3 stub returns 404 for that path.

**Green** `auth-handler.ts` (the `defaultHandler` that renders/authorizes owner login; minimal here — full passkey ceremony is a deployment gate):
```ts
import type { GatewayEnv } from "./agent";

export const authHandler = {
  async fetch(request: Request, env: GatewayEnv & { OAUTH_PROVIDER: { parseAuthRequest: (r: Request) => Promise<unknown>; completeAuthorization: (i: unknown) => Promise<{ redirectTo: string }> } }): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/authorize") {
      // Real UI + passkey verification is wired at deploy time; here we prove
      // the provider delegates to us and that props flow through.
      return new Response("owner-login-required", { status: 401 });
    }
    return new Response("Not Found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
};
```
`index.ts`:
```ts
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { LivingAtlasRemoteMcp } from "./agent";
import { authHandler } from "./auth-handler";

export { LivingAtlasRemoteMcp };

export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: LivingAtlasRemoteMcp.serve("/mcp"),
  defaultHandler: authHandler as never,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  scopesSupported: ["mcp:remote"],
  disallowPublicClientRegistration: true, // allowlisted DCR per spec §5
  accessTokenTTL: 900
});
```
> The earlier stealth-404 test from Task 3 now targets a path the provider does not own; keep it asserting 404 for `/nope`. The provider handles `/token`, `/register`, `/.well-known/*`; `defaultHandler` handles the rest.

**Run:** `pnpm vitest run packages/remote-mcp-gateway/src/index.test.ts` → **passes.**

**Commit:** `feat(gateway): mount OAuthProvider (PKCE, allowlisted DCR) over McpAgent`

---

# Phase 7 — Streaming + isolation guards

## Task 24 — Long tool call streams progress (SDK Streamable-HTTP, resumable)

**Files:**
- `packages/remote-mcp-gateway/src/streaming.ts`
- `packages/remote-mcp-gateway/src/streaming.test.ts`

**Red** `streaming.test.ts` — assert the tool handler emits interim progress notifications through the SDK's progress callback (we test our *use* of the SDK, not the SDK transport):
```ts
import { describe, expect, it } from "vitest";
import { runStreamingTool } from "./streaming";

describe("runStreamingTool", () => {
  it("emits progress updates before the final result for a long call", async () => {
    const progress: number[] = [];
    const result = await runStreamingTool({
      totalSteps: 3,
      onProgress: async (p) => { progress.push(p.progress); },
      work: async (step) => ({ step })
    });
    expect(progress).toEqual([1, 2, 3]);
    expect(result).toEqual({ ok: true, steps: [{ step: 0 }, { step: 1 }, { step: 2 }] });
  });
});
```

**Run:** `pnpm vitest run packages/remote-mcp-gateway/src/streaming.test.ts`
**Expect fail:** `Cannot find module './streaming'`.

**Green** `streaming.ts`:
```ts
export type ProgressNotification = { progress: number; total: number };

export async function runStreamingTool<T>(input: {
  totalSteps: number;
  onProgress: (p: ProgressNotification) => Promise<void>;
  work: (step: number) => Promise<T>;
}): Promise<{ ok: true; steps: T[] }> {
  const steps: T[] = [];
  for (let step = 0; step < input.totalSteps; step += 1) {
    steps.push(await input.work(step));
    await input.onProgress({ progress: step + 1, total: input.totalSteps });
  }
  return { ok: true, steps };
}
```
> In the agent (Task 22 tools for `remote_search`, `remote_traverse`, `remote_timeline`), pass the MCP SDK's `sendNotification`/progress token as `onProgress`. Resumability + `Last-Event-ID` are provided by the SDK transport / `DurableObjectEventStore` (OPEN QUESTION #2) — this task proves *our* handler yields progress; it must NOT hand-roll an event store or SSE framing.

**Run:** `pnpm vitest run packages/remote-mcp-gateway/src/streaming.test.ts` → **passes.**

**Commit:** `feat(gateway): streaming tool progress via SDK progress callback`

---

## Task 25 — Isolation guard: the local stdio MCP package is untouched

**Files:**
- `packages/remote-mcp-gateway/src/isolation.test.ts`

**Red** `isolation.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const localMcpSrc = join(__dirname, "../../local-mcp/src");

function allTsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? allTsFiles(full) : full.endsWith(".ts") ? [full] : [];
  });
}

describe("stdio MCP isolation", () => {
  it("no local-mcp source imports the remote gateway or oracle packages", () => {
    for (const file of allTsFiles(localMcpSrc)) {
      const text = readFileSync(file, "utf8");
      expect(text).not.toMatch(/@living-atlas\/remote-mcp-gateway/);
      expect(text).not.toMatch(/@living-atlas\/local-decryption-oracle/);
    }
  });
});
```

**Run:** `pnpm vitest run packages/remote-mcp-gateway/src/isolation.test.ts`
**Expect:** passes immediately (local-mcp has no such imports today). If it fails, an earlier task wrongly reached into `local-mcp` — revert that import. This test is a **standing guard**: it stays in the suite so any future edit that couples the stdio path to the remote packages turns the build red.

**Also** run the local-mcp suite to prove it is byte-for-byte unaffected:
**Run:** `pnpm vitest run packages/local-mcp` → **passes** (unchanged).

**Commit:** `test(gateway): standing isolation guard for stdio MCP`

---

## Task 26 — Retire the hand-rolled remote `/mcp` handler in the sync worker

**Files:**
- `packages/cloudflare-worker/src/worker.ts` (remove `routeRemoteMcpRequest`, the `/mcp` route, `callRemoteMcpTool`, `executeRemoteMcpTool`'s remote-only branches, and the `sensitive_decrypt` cloud-unlock/escalation code path — that responsibility now lives in the gateway)
- `packages/cloudflare-worker/src/worker-escalation.test.ts` (delete or relocate — escalation is now exercised by the gateway/oracle suites)
- `packages/cloudflare-worker/src/worker.test.ts` if present (drop `/mcp` assertions)

**Red — assert the sync worker no longer serves `/mcp`.** Add to a worker test:
```ts
it("no longer serves the hand-rolled remote /mcp endpoint", async () => {
  const { env } = await createEnv();
  const res = await handleBootstrapRequest(new Request("https://w.example/mcp", { method: "POST", body: "{}" }), env);
  expect(res.status).toBe(404); // stealth path or plain not-found; not a JSON-RPC 200
});
```

**Run:** `pnpm vitest run packages/cloudflare-worker`
**Expect fail:** today `/mcp` returns a JSON-RPC response, not 404.

**Green:** Delete `routeRemoteMcpRequest` and its `if (url.pathname === "/mcp")` dispatch in `routeBootstrapRequest`; delete `callRemoteMcpTool`, `executeRemoteMcpTool`, `hasValidRemoteMcpDiscoveryToken`, and the `/mcp` stealth branch in `shouldStealthDrop`. Remove now-unused imports (`LivingAtlasMcpToolDefinitions`, `createLivingAtlasGraphService`, escalation crypto, `decryptCloudUnlockObject`) from `worker.ts`. Keep sync/bootstrap/usage/activity routes intact.

**Run:** `pnpm vitest run packages/cloudflare-worker` → **passes.**
**Run:** `pnpm typecheck` → passes (remove dangling imports until clean).

**Commit:** `refactor(cloudflare-worker): retire hand-rolled remote /mcp handler (A1)`

---

## Task 27 — Full-repo green gate

**Files:** none (verification task).

**Run, in order:**
```
pnpm install
pnpm run lint:repo-safety
pnpm typecheck
pnpm test
```
**Expect:** all green. If `lint:repo-safety` (`packages/check/src/cli.ts`) flags the new packages (e.g., a secret-shaped literal in a test), adjust the test fixture to a clearly-synthetic value; do not weaken the safety rule.

**Commit:** `chore: full check green with remote-mcp-gateway + oracle`

---

# Deployment & Gates (need human — NOT code tasks)

These are operational steps performed by the owner; they are out of scope for the TDD tasks above and must be done by a human with credentials.

1. **Wrangler config + secrets for the new gateway worker** (`packages/remote-mcp-gateway/wrangler.jsonc`):
   - `compatibility_flags: ["nodejs_compat"]`, a recent `compatibility_date`.
   - `durable_objects.bindings`: `{ name: "MCP_OBJECT" (or SDK-required name), class_name: "LivingAtlasRemoteMcp" }`; `migrations: [{ tag: "v1", new_sqlite_classes: ["LivingAtlasRemoteMcp"] }]`. **Verify the exact binding name the pinned `agents` `McpAgent.serve` expects** against the template repo (`cloudflare/ai/demos/remote-mcp-github-oauth`) — this plan could not pin it from the docs (OPEN QUESTION #1).
   - `kv_namespaces`: `{ binding: "OAUTH_KV", id: "…" }` (OAuthProvider token store) and a second KV for WebAuthn challenges (or reuse `OAUTH_KV` with prefixed keys).
   - Secrets via `wrangler secret put`: `LA_CLOUD_UNLOCK_KEY` (T1), `LA_GRANT_SIGNING_KEY` (escalation grant HMAC), plus `LA_CAPABILITY_POLICY_JSON`, `LA_REVOCATION_JSON`, `LA_ORACLE_URL`, `T1_KEY_VERSION`, `T2_KEY_VERSION` as vars/secrets.
   - `mtls_certificates` binding for the oracle client cert (Worker-side mTLS).

2. **Passkey registration ceremony:** With the gateway deployed, the owner performs the browser-side WebAuthn enrollment (`navigator.credentials.create`) once to bind the single owner credential (Tasks 8–9 server half). Store the resulting credential (id/publicKey/counter) in the gateway's credential store.

3. **Local-oracle mTLS cert setup + Cloudflare Tunnel:** Generate the mTLS client/server certs; run `packages/local-decryption-oracle` on the owner's machine behind `cloudflared` so `LA_ORACLE_URL` resolves through the tunnel; load `LA_GRANT_SIGNING_KEY` (verify side) and the T2 escalation key into the oracle process only. Confirm oracle-offline → gateway returns "sensitive data unavailable (owner offline)" (Task 19 fail-safe).

4. **ChatGPT connector registration:** Register the gateway as a remote MCP connector in ChatGPT (OAuth 2.1 discovery via the provider's well-known metadata). Because DCR is allowlisted (`disallowPublicClientRegistration: true`), pre-register or allowlist ChatGPT's client.

5. **HARD DEPENDENCY — Stage B before any T1/T2 remote decrypt end-to-end.** T1/T2 remote decryption can only be exercised end-to-end once **Stage B is done**: tiered data must be actually pushed (objects sealed to `cloud-unlock-v1` / `cloud-unlock-escalated-v1`) **and** the escalation worker/oracle path is live. Until Stage B lands, the gateway's `remote-safe-only` surface works, but T1 returns nothing to decrypt and T2 has no live oracle. Do not sign off remote decryption until Stage B is complete.
