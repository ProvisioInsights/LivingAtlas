# ADR 0036: A Transitional Legacy Protocol Era over HTTP

Status: Accepted for implementation
Date: 2026-08-10

Extends: ADR 0034 (the stdio legacy era), whose "Rejected alternatives" entry
*"Widen HTTP too — out of scope; Desktop is stdio, and HTTP has its own
conformance surface to re-verify"* this ADR reverses, having re-verified it.

## Context

ADR 0035 made the graph live-editable through one read-write service on
loopback HTTP. It also recorded, measured, that the client the owner actually
uses could not reach it: the HTTP plane speaks 2026-07-28 only, Claude Desktop
1.26832.0 opens at `2025-11-25`, and it got `-32020` without the protocol header
and `-32022` with it.

That left the project in an absurd position — an architecture built so an edit is
visible everywhere without a restart, and the one client that needed it still on
a per-process read-only snapshot. Desktop moved to stdio's legacy era in ADR
0034; the service it now needs is HTTP.

The owner decided to widen the HTTP era.

## What the re-verification actually found

Established by running `@modelcontextprotocol/server@2.0.0`, not by reading it.
Three findings, each of which changed the design:

**1. `legacy: 'serve'` does not exist on HTTP.** The stdio entry takes
`'serve' | 'reject'`; `createMcpHandler` takes `'reject' | 'stateless'`. The
first attempt passed `'serve'`, which TypeScript rejected and `tsx` had been
stripping — a reminder that a type error suppressed at runtime is a measurement
that means nothing.

**2. The legacy path hands the server factory a DIFFERENT `Request` object.**
The edge binds a credential per request through a `WeakMap` keyed on the
`Request`. On the modern path the SDK hands back the very object the edge
registered (`same=true`); on the legacy path it does not (`same=false`), so the
lookup missed and the factory threw *"refusing to build a server with no bound
credential"* — a 500 on every legacy opening. The guard was right and the key was
fragile. `AsyncLocalStorage` now carries the scope, because it binds to the
async execution of the request rather than to an object the SDK is free to
rebuild. The `WeakMap` is kept as the first lookup: an SDK upgrade that stops
preserving async context then degrades to the throw rather than to a silently
unauthenticated server.

**3. HTTP legacy mode is `stateless` and issues no `Mcp-Session-Id`.** The first
design tracked admitted sessions in a bounded map and admitted follow-ups by
session id — the direct analogue of stdio's latched bit. It would have refused
every legacy request after the opening, because there is no session id to read.

## Decision

### 1. One switch, its own switch

`HTTP_SUPPORTED_LEGACY_PROTOCOL_VERSIONS` in `packages/atlas-mcp/src/http/serve.ts`
drives both the SDK's mode (`'stateless'` when non-empty, `'reject'` when empty)
and the edge's gate. Empty restores the modern-only behaviour exactly.

It is deliberately NOT stdio's `SUPPORTED_LEGACY_PROTOCOL_VERSIONS`. A pipe is
reachable only by whoever spawned the process; a loopback socket is reachable by
every process on the host. The two should be retirable independently, and one
shared switch would mean retiring the safer transport forced a decision about the
riskier one.

### 2. The eras are separated by the ENVELOPE, and it needs no state

A header-less POST is the shape of two very different callers, and the whole
correctness of the era is telling them apart:

- a 2025-era client, which sends `MCP-Protocol-Version` on nothing, ever;
- a modern client that dropped a required header, which must still be refused,
  because serving it from a legacy-era server would answer a 2026-07-28 caller in
  a shape it never asked for while both ends believed they agreed.

A modern client MUST carry `io.modelcontextprotocol/protocolVersion` in
`params._meta`; a 2025-era client never does. So the envelope decides, on every
method rather than only on `initialize` — a modern client that drops its header
mid-session is refused too. This needs no session memory, which is why there is
none to bound, evict, or reason about.

Four outcomes, from the body of a header-less POST:

| classification | answer |
|---|---|
| carries a modern `_meta` envelope | `-32020` — the header problem it is |
| `initialize` naming an admitted revision | served as legacy |
| `initialize` naming any other revision | `-32022`, naming what is served |
| `initialize` naming NO revision | `-32020` — the era admits a stated revision, never an omission |
| anything else | served as legacy (a follow-up) |

### 3. The admitted set is enforced on the header value too

Turning legacy mode on widened a door the edge did not own, and the existing
conformance suite caught it: with `legacy: 'reject'` the SDK answered `-32022` to
a `2025-06-18` client that sends the header its revision defined; with legacy
enabled it SERVED it. The era would have admitted every 2025 revision rather than
the one it names, and the envelope gate never saw those requests because that
client does send a header.

So a POST naming a version that is neither the modern revision nor an admitted
legacy one is refused `-32022` before anything else. `data.supported` lists the
MODERN revision only: the transitional era is a door held open for clients that
cannot yet speak it, never a revision this server offers anybody to negotiate
onto.

## Consequences

- Claude Desktop's protocol can now reach the live read-write service. Proven on
  the wire against a running service with the exact shape Desktop puts on it: a
  legacy `initialize` is served at `2025-11-25`, a legacy `tools/call` CREATES an
  entity, and the next legacy read finds it — a live edit with no restart.
- A read-only credential is still refused a write over the legacy era; the grant
  model is untouched by the transport.
- The modern path is unchanged, and the conformance suite still pins it.
- Two conformance cases were rewritten in the same commit as the change, because
  their premise — "refuse all of 2025" — is now deliberately false for one
  revision. One was re-pointed at a revision the era does not admit; the other
  moved from `-32020` to `-32022`, which still satisfies the requirement it cites
  (a recognizable modern JSON-RPC error) and is the more informative of the two.

## Retirement

Set `HTTP_SUPPORTED_LEGACY_PROTOCOL_VERSIONS` to `[]`. The SDK reverts to
`legacy: 'reject'`, the gate stops classifying, and every header-less POST is
refused again.

The condition is the same one ADR 0034 records for stdio: **Claude Desktop
negotiates 2026-07-28 on the wire.** Verify it by reading a handshake, not a
bundle — that mistake has now been made once in this repository and is documented
in ADR 0034 precisely so it is not made twice.

## Rejected alternatives

- **Share stdio's constant.** Couples the retirement of a low-exposure transport
  to a higher-exposure one. Two doors, two switches.
- **Admit every header-less POST while the era is on.** Simplest, and it routes a
  modern client's header mistake to a legacy-era server silently. The envelope
  check costs one clone and closes it.
- **Track admitted sessions and admit follow-ups by session id.** The direct
  analogue of stdio's latch, and it does not work: HTTP legacy mode is stateless
  and issues no session id. It also added bounded state reachable by an
  unauthenticated caller, for nothing.
- **A stdio-to-HTTP bridge Desktop spawns.** Leaves the HTTP surface untouched at
  the cost of a second protocol implementation to keep from drifting — the exact
  condition the anti-drift gates exist to prevent.
