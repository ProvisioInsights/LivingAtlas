# Remote MCP: OAuth 2.1 + Tiered Decryption + Streaming — Design

**Status:** Draft — 2026-07-04. Decisions locked via brainstorming; pending spec review.
**Scope:** the *remote* MCP surface only. The local stdio MCP is explicitly out of scope and unchanged.

## 1. Problem & goals

Living Atlas exposes a local **stdio** MCP today: localhost token → local keyring → full plaintext across all tiers, fast, no network. To reach off-device clients — especially third-party AI hosts (ChatGPT) that **require OAuth 2.1** and **cannot carry custom headers** — we need a remote MCP surface that:

- authenticates every remote client via **OAuth 2.1** (unified; static-header remote auth retired);
- enforces a **configurable, per-client decryption ceiling** across the three encryption tiers;
- preserves **host-blind custody** for the most sensitive tier (Cloudflare never holds the T2 key);
- supports **progress streaming** for long tool calls;
- is **provider-generic** — works for any MCP client, not just ChatGPT;
- never compromises or slows the local **stdio** path.

## 2. Non-goals

- Changing the local stdio MCP (stays localhost-token → keyring, full authority, fast, non-OAuth).
- Letting Cloudflare decrypt T2 (super-sensitive) data under any circumstance.
- Per-capability **tool allowlist** — designed-for but implemented later (tracked, not in first build).
- Field-level redaction **on by default** — a hook is built; rules are off by default.
- The immutable backup subsystem — separate spec (`2026-07-04-immutable-backup-restore-design.md`).

## 3. Core model: two independent layers

**Authentication** (may this client connect?) is separate from **decryption authority** (what plaintext may it read?). Authenticating yields ciphertext + approved metadata; seeing plaintext is a *second, distinct* act of key presentation.

Encryption tiers (existing):

| Tier | Access class | Who can decrypt |
|---|---|---|
| T0 at-rest | `local-keyring-v1` | local keyring only (never cloud) |
| T1 normal | `cloud-unlock-v1` | primary cloud-unlock key |
| T2 super-sensitive | `cloud-unlock-escalated-v1` | escalation key; worker returns `escalation-required` until supplied |

## 4. Architecture (Approach A: fronting gateway + local oracle)

```
MCP client ──OAuth 2.1 / Streamable HTTP──▶ [OAuth Gateway Worker] ──internal──▶ [MCP Worker]
(ChatGPT, etc.)                                     │  (existing; ciphertext custody)
                                                    │ T1: cloud-unlock key (CF secret)
                                                    │ T2: mutual-TLS + signed 15-min grant
                                                    ▼
                                        [Local Decryption Oracle]  (owner's machine,
                                         in front of the keyring; fails safe when offline)
```

> **Architecture revision — 2026-07-04 (decision A1).** After verifying the current Cloudflare stack, the remote surface is **rebuilt on the Agents SDK** rather than fronting the hand-rolled `/mcp` handler with a proxy. `@cloudflare/workers-oauth-provider` (OAuth 2.1 + PKCE, draft-ietf-oauth-v2-1-13) provides token/authz/storage; `McpAgent`/`createMcpHandler` provide a **Durable-Object-per-session** with **built-in SSE + Streamable HTTP transports and resumability**; `@simplewebauthn/server` + KV (5-min-TTL challenges) provide the passkey login. So the "OAuth Gateway Worker" and "MCP Worker" **merge into a single OAuth-fronted McpAgent worker**; the old hand-rolled remote `/mcp` handler is retired; and the "resumable streaming + DO event store" work is **provided by the SDK**, not custom-built. Our custom code is the security layer *on top*: tier-ceiling policy, T1 secret injection, T2 mTLS-oracle brokering, audit/alert, kill-switch, rate limit, redaction hook, rotation. Components below are updated to match.

### Components

1. **OAuth-fronted McpAgent worker** (new; replaces both the old remote `/mcp` handler and the notional gateway). `@cloudflare/workers-oauth-provider` wraps an `McpAgent` that hosts the `remote_*` tool catalog over the SDK's Streamable-HTTP transport. Owner login is **self-contained WebAuthn/passkey** (`@simplewebauthn/server` + KV). It maps the OAuth identity → a **capability** with a configured **tier ceiling**; holds the **T1** `cloud-unlock-v1` key as a Cloudflare secret; brokers **T2** to the local oracle over mutual-TLS; enforces rate limits, the kill-switch, and T2 audit+alerts. Ciphertext custody + tiered-decryption logic is imported from **shared packages** (extracted from the current worker), so the graph/crypto is reused, not reimplemented.
3. **Local Decryption Oracle** (new; runs on the owner's machine). Sits in front of the existing keyring. Accepts requests **only** over mutual-TLS from the gateway, each carrying a fresh **signed, ≤15-min escalation grant**. Decrypts T2 ciphertext and returns plaintext. The escalation key never leaves this process; when the machine is offline, T2 remote decrypt **fails safe**.
4. **Capability / policy config** (provider-generic). Declares, per client/provider: tier ceiling (`remote-safe-only` | `T1` | `T2`), rate limits, and (future) tool allowlist. Generic Atlas ships conservative defaults.
5. **Durable-Object event store** (new). Backs resumable SSE streams (`Last-Event-ID`).

## 5. Authentication

- **OAuth 2.1** with PKCE; **dynamic client registration allowlisted** (not open).
- **Single-owner binding** established at bootstrap (reuses the existing bootstrap-claim mechanism).
- **Owner login = WebAuthn/passkey**, self-hosted in the gateway — no password database, no external IdP dependency.
- Access-token TTL short with refresh; **instant kill-switch** revokes a client without redeploy (reuses `LA_STEALTH_MODE` plumbing: unauthorized/revoked requests get a stealth 404).

## 6. Authorization & the escalation flow

- Each client → a **capability** carrying a **configurable tier ceiling**.
- `remote-safe-only`: ciphertext + approved metadata, no plaintext.
- `T1`: gateway injects the cloud-unlock key → normal plaintext.
- `T2`: MCP worker returns `escalation-required`; gateway obtains a signed grant and calls the local oracle; only then is sensitive plaintext returned.
- **Reference owner config:** ceiling = `T2` (full parity, escalation-gated). **Generic default:** `remote-safe-only` or `T1`, never `T2`, until the adopter opts in.

## 7. Key custody

- **T1** `cloud-unlock-v1`: Cloudflare secret in the gateway (convenient, always-on). Cloudflare can decrypt normal-tier — accepted.
- **T2** `cloud-unlock-escalated-v1`: **never in Cloudflare**. Reachable only via mutual-TLS to the local oracle with a fresh signed grant (≤15 min). Preserves host-blind for the crown jewels; fails safe when the owner's machine is offline.

## 8. Streaming

- Transport is **Streamable HTTP** (single `/mcp` endpoint; the worker already advertises protocol `2025-06-18`). The deprecated standalone HTTP+SSE transport is **not** implemented.
- Long tool calls (`remote_semantic_search`, `remote_graph_traverse`, `remote_timeline_query`) use the **SSE response mode** for progress events.
- Streams are **resumable** via the DO event store + `Last-Event-ID`, with periodic heartbeats — robust against serverless connection drops.

## 9. Guardrails

- **T2 audit + alert:** every escalated decrypt writes to the durable audit ledger *and* pushes the owner a notification.
- **Kill-switch:** one command instantly revokes a client.
- **Rate limit:** per-capability, reusing the existing usage gate; **configurable and easy to change**.
- **Field-redaction hook:** built, off by default; lets an owner mask specific fields (e.g., exact addresses/financials) even within an allowed tier.
- **Key rotation:** version-tagged access classes; new version goes live immediately and a **scheduled background sweep** re-encrypts to it so old versions retire predictably. T1 and T2 rotate independently.

## 10. Isolation from stdio

All remote plumbing (gateway, oracle client, OAuth, streaming, capability policy) lives in a **separate package** with no import path into the local stdio server. The stdio path keeps its direct localhost-token → keyring flow; remote work cannot slow or widen it.

## 11. Error handling

- `escalation-required` → gateway initiates grant; if the oracle is unreachable, return a clear "sensitive data unavailable (owner offline)" — never a silent downgrade.
- Invalid/expired/revoked token → stealth 404 (no oracle contact, no oracle info leak).
- Grant expiry/replay → oracle rejects; gateway re-mints.
- Stream drop → client resumes via `Last-Event-ID`.

## 12. Testing

- **Tier isolation:** the primary key cannot open a T2 object (algorithm-class + AAD domain separation + distinct key), asserted adversarially.
- OAuth 2.1 flow (PKCE, allowlisted DCR, passkey login), token revocation/kill-switch.
- mTLS gateway↔oracle; grant TTL + replay rejection; oracle-offline fail-safe.
- Streaming resume; heartbeat; rate-limit enforcement.
- Audit+alert fires on every T2 decrypt; no plaintext ever written to CF-visible storage.

## 13. Deferred / future

- Per-capability **tool allowlist** implementation (e.g., read+create but not delete for a given client).
- Concrete field-redaction rulesets.
- Multi-provider onboarding docs (Gemini and other MCP hosts) atop the provider-generic config.
