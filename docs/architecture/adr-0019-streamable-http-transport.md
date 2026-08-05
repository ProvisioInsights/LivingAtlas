# ADR 0019: The Streamable HTTP Transport, And What Transport Parity Costs

Status: Accepted for implementation
Date: 2026-08-04

Relates to: [ADR 0013](adr-0013-published-contract-and-asymmetric-strictness.md),
[ADR 0014](adr-0014-consumer-mcp-server-and-mrtr-escalation.md),
[ADR 0015](adr-0015-operator-plane-and-capability-grants.md)

## Context

ADR 0013 published a contract whose central promise to a consumer is that it
never has to know how it connected. The server instructions repeat it to every
client in as many words: *"Never branch on which transport you connected over."*
ADR 0015 made that promise expressible by taking the transport out of the
credential — an `McpProfile` was literally a list of wires, and a grant is not.

Until now the promise was also untestable, because there was one transport. Both
planes served stdio only. A claim about two things that agree, made when only one
exists, is a claim nobody can falsify.

This ADR adds the second transport — MCP revision **2026-07-28 Streamable HTTP**
— to both planes, and makes the parity claim a test.

The revision matters here, and not only as a version string. `2026-07-28`
*removed* the GET stream endpoint and *removed* protocol-level sessions. There is
no `Mcp-Session-Id` to mint, no `Last-Event-ID` resumption, and no standing
server-to-client channel. Every JSON-RPC message is its own HTTP POST. That makes
HTTP structurally the same shape as the credential model ADR 0015 already chose:
per-request input, no connection state. A sessionful transport would have
reintroduced exactly the thing that ADR's `tools/list` reasoning forbids.

## Decision

### 1. One server core, two transports, and the difference confined to an edge

`buildAtlasServer` and `buildOperatorServer` are imported unchanged. The HTTP
entries (`src/http/consumer.ts`, `src/operator/http.ts`) are as thin as their
stdio counterparts: they name the core and hand it to a shared edge. Everything
transport-specific lives in `src/http/`, and none of it can change what a tool
answers.

The two plane entries stay separate files, mirroring `stdio.ts` and
`operator/stdio.ts`, for the reason ADR 0015 gives: the planes are two servers
with two tool tables bound to two credential classes, and a single entry serving
both would be the one place they meet.

### 2. The protocol is the SDK's entry, because it was measured and it is right

`createMcpHandler(factory, { legacy: 'reject' })` from
`@modelcontextprotocol/server@2.0.0`, rather than a hand-wired composition over
`PerRequestHTTPServerTransport`.

This was not assumed. Both candidates were probed against the running SDK before
either was written, and the measurements decided it:

| Requirement | `createMcpHandler` | `classifyInboundRequest` alone |
| --- | --- | --- |
| `Mcp-Method` disagrees with body | 400 `-32020` | 400 `-32020` |
| `Mcp-Name` disagrees with `params.name` | 400 `-32020` | **passes** |
| `Mcp-Method` / `Mcp-Name` missing | 400 `-32020` | **passes** |
| `MCP-Protocol-Version` disagrees with `_meta` | 400 `-32020` | 400 `-32020` |
| Unknown method | 404 `-32601` | not evaluated |
| Envelope names another revision | 400 `-32022`, `supported: ["2026-07-28"]` | routes it onward |
| No envelope / 2025 `initialize` | 400 `-32022` | routes legacy |
| `GET` / `DELETE` | 405 | classified legacy |
| Non-JSON body | 415 | not evaluated |
| Notification | 202, empty body | n/a |
| SSE upgrade | `X-Accel-Buffering: no`, `no-cache, no-transform` | n/a |
| `Mcp-Session-Id` present | ignored, never echoed | n/a |

The lower-level building block evaluates only the era and envelope rungs. Taking
it would have meant hand-writing the standard-header validation — including the
`=?base64?…?=` sentinel decoding and the `Mcp-Param-*` rules — and a
hand-written copy of a validation ladder is a copy that drifts from the ladder
the stdio path gets from the same SDK.

`transport-conformance.test.ts` pins every row of that table anyway. The SDK is a
dependency on its own release cycle, and "this transport is conformant" is a
claim this repository makes to consumers; a bump that quietly stopped answering
`-32020` for a forged `Mcp-Name` should fail here, not in a deployment.

### 3. One rung the SDK leaves open, closed in Atlas code

A POST carrying **no** `MCP-Protocol-Version` header is measurably served — the
SDK infers the revision from the body envelope and answers `200`.

The revision permits that, but only for a server that still serves clients older
than `2025-06-18`: *"A server that does not support such clients MUST reject a
request without the header."* This server speaks exactly one revision and has no
legacy era, so the permission does not apply to it and the MUST does. The edge
answers `400` with `-32020`.

This is still the correct answer for a genuinely ancient client. The revision's
fallback rules tell such a client to inspect a `400` body and fall back to the
HTTP+SSE handshake only when the body is *not* a recognised modern JSON-RPC
error. `-32020` is one, so the client learns this endpoint is modern instead of
retrying a 2024 handshake against it.

### 4. `-32021` moves seam, not rule

The specification makes a JSON-RPC `MissingRequiredClientCapability` error a MUST
when a request needs a capability it did not declare, and ADR 0014 established
that a tool handler cannot raise one: `McpServer` flattens a handler throw into a
text tool error and the numeric code — the only part a conformant client can
branch on — is lost. On stdio the answer is produced by a transport decorator,
`capabilityRefusalTransport`.

`createMcpHandler` takes a server *factory* and owns its transport internally, so
there is nothing to decorate. The swap therefore happens on the outbound
**response** instead — but the *decision* does not move. Both transports call the
same `capabilityErrorFor`, a pure function over one wire message and the sink.
Where a rule is applied is an implementation detail; how many implementations of
it exist is not, and the one that drifts is always the one nobody is looking at.

Both response shapes are handled. A single JSON body is what a refusal produces
today; `responseMode: 'auto'` upgrades to SSE the moment a handler emits anything
before its result, and a rewrite that silently stopped working when a handler
grew a progress notification would be the same defect wearing a different hat.

**The sink is per request, not per listener.** A refusal is parked under a
JSON-RPC id; ids are chosen by the caller, and every client numbers its first
request `1`. A listener-wide sink would hand one caller's `-32021` to whichever
response was serialised first. Each exchange gets its own sink, reached through a
`WeakMap` keyed on the `Request` object the SDK hands back as `ctx.requestInfo`.
That property is asserted directly rather than through a race — a concurrency
test can only lose a race by luck, and this one demonstrably did not catch a
shared-sink mutant until the assertion was moved to the wiring itself.

### 5. Loopback, Origin, and bearer — all three, in code

The SDK documents that its entry performs neither Origin validation nor token
verification. Both are therefore the edge's job:

- **Loopback binding** is an allowlist (`127.0.0.1`, `::1`, `localhost`), not a
  `!== "0.0.0.0"` check. The ways to say "every interface" outnumber the ways to
  say loopback — `0.0.0.0`, `::`, the empty string, and an omitted host all mean
  it — so a deny-list would have to enumerate them correctly forever. A host the
  allowlist has never heard of is refused.
- **Origin** is validated before authentication. A DNS-rebinding attacker's page
  holds no bearer token but does hold the browser's ambient reach to loopback,
  and the refusal must not depend on what it managed to guess. A present,
  foreign `Origin` is `403`; an absent one passes, because non-browser clients
  send none.
- **Bearer** is required on every request, and the listener refuses to start
  without a credential directory. See ADR 0015 OPEN-5 for the credential-binding
  decision itself.

### 6. Cancellation is the socket, and only the socket

The revision defines no `notifications/cancelled` over Streamable HTTP: closing
the response stream *is* the cancellation signal, and a server MUST treat it as
one. The listener wires an `AbortSignal` from the **response** closing early —
`writableFinished === false` — and never from the request stream. A POST's
`IncomingMessage` emits `close` as soon as its body has been read, which for
every well-formed request is long before the answer exists; aborting on that
would cancel each exchange the moment it was understood. This was a real defect
in the first draft of the listener and is called out here because the correct
event is not the obvious one.

### 7. Parity is a test, with its concessions named

`parity.test.ts` drives the same call over both transports and compares the
structured result — the thing a consumer consumes. The transport envelope
legitimately differs and is excluded; comparing it would be comparing the two
transports rather than the one contract.

Covered: `contract.describe`, `assertion.query` (including a redaction stub and
its coverage counts), `changes.read`, `assertion.propose`, and the
`sensitive.reveal` `-32021` refusal — the last chosen precisely because the two
transports produce it by different mechanisms.

Two honest concessions, both tied to a structural fact rather than to
convenience:

- **Minted ids cannot match.** Ids are minted, never derived: ULID-shaped, with
  sixteen characters of `randomBytes`. Two servers cannot mint the same id and no
  fixture arrangement makes them. Ids are therefore replaced by placeholders in
  first-seen order, per result — which preserves the property that matters, that
  the two transports agree on how many distinct ids there are, where each
  appears, and which positions co-refer. A transport returning the right shape
  with scrambled cross-references still fails, and a test asserts that.
- **Digests over content that names a minted id inherit its nondeterminism.**
  `request_digest` and `claim_digest` are normalised *only* in the one case that
  needs separate fixtures. That case is `assertion.propose`, because two
  transports writing one idempotency key into one log is the replay path by
  design. Every read case shares a single graph, so its ids and digests are
  identical and compared literally.

Nothing else is normalised: `recorded_at`, `seq`, coverage and withheld counts,
fidelity flags, tier labels, error codes, refusal messages, and the
digest-derived audit `event_id` are all compared byte for byte, which is why both
sides run on fixed clocks.

The write case additionally gets the property byte-equality cannot express:
**idempotency crosses transports.** A proposal made over stdio and retried over
HTTP returns the first receipt with `state: "replayed"`, and the log grows by
exactly one — because `(client_id, idempotency_key)` contains nothing about a
wire.

## Consequences

- The ADR 0013 promise is now falsifiable, and forty tests hold it.
- A second transport can be added without touching a tool: the shape to copy is
  an edge plus a plane entry, and the parity file is where the new one proves
  itself.
- The SDK's conformance is pinned by this repository's own suite, so a dependency
  bump that regresses the transport fails the build.
- HTTP has no unauthenticated mode, by construction. That is a deliberate
  asymmetry with stdio and the reason there is no HTTP demo binary.

## Open questions

- **OPEN-9: rate limiting and request size.** The edge refuses on identity and
  origin but imposes no per-credential request rate and no maximum body size.
  Loopback-only binding bounds the blast radius to processes already on the host;
  it does not bound a loop. A bearer token is the natural key and the audit
  journal already counts per-credential calls, but nothing enforces a ceiling.
- **OPEN-10: credential rotation over HTTP.** Inherited unchanged from OPEN-6 —
  the directory still has no revocation, rotation, or expiry, and a bearer token
  is exactly the credential where that absence is most visible, because it is
  presented on every request and travels through more intermediaries than a pipe.
- **OPEN-11: `subscriptions/listen`.** The revision delivers long-lived change
  notifications on the response stream of a `subscriptions/listen` request. The
  handler supports it and Atlas registers no such surface, so a client asking for
  one gets an empty subscription rather than the change feed. Whether the
  `atlas.changes.read.v1` cursor should also be exposed as a push subscription —
  and what that would mean for the audit rule of one event per call, since a
  stream is not a call — is not decided here.
