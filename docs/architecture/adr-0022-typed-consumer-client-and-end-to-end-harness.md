# ADR 0022: A Typed Consumer Client Derived From The Contract, And An End-To-End Harness That Mocks Nothing

Status: Accepted for implementation
Date: 2026-08-04

## Context

ADRs 0013–0017 published a contract, built a server that registers from it, and
retired the local half of the thirty-tool surface it replaces. Two things were
still missing, and they are the two that decide whether any of it holds.

**Nothing consumed the contract.** `packages/atlas-client` targeted the retired
surface. It carried hand-written argument shapes for the thirty tools, returned
`unknown` from every call, and expressed every failure — an HTTP status, a JSON
parse error, a JSON-RPC error, a typed refusal — as one class with a `code`
string and the interesting part stringified inside `detail`. A caller that wanted
to branch on a history-floor refusal had to pattern-match prose. The contract's
asymmetric-strictness claim ("a consumer validates what it receives") had no
implementation anywhere in the repository.

**Nothing exercised the whole thing at once.** Every test in `packages/atlas-mcp`
drives the server through a `PassThrough` pipe pair inside the test process. That
is the right shape for those tests and it cannot see four classes of defect:
child-process framing, a store that does not survive the process that wrote it, a
cursor that does not resume across a restart, and an idempotency receipt that
lives only in memory. Each of those is invisible to every existing test and
catastrophic in the field. The prior store's journal is 0 bytes today and 169,205
mutations left nothing behind; no test in that era would have noticed.

## Decision

### 1. `packages/atlas-client` is rewritten as the client of the published plane

The package root is the new plane. It loads the published bytes from
`packages/atlas-contract/schema/<revision>/` — the same documents the server
registers from — validates arguments against the published input schema before
sending and results against the published output schema before returning, speaks
the 2026-07-28 envelope on every request, and exposes the twelve tools as typed
methods.

Four failure modes are four types, because a caller does something different
about each: `AtlasToolRefusal` (Atlas answered, in contract, and said no, with
the `atlas.error:v1` record attached whole), `AtlasCapabilityRequired` (the
`-32021` MUST, carrying `requiredCapabilities` and the payload the server built),
`AtlasProtocolMismatch` (the `-32022` MUST, carrying both version sets), and
`AtlasContractViolation` (the answer was not in contract).

**The `-32022` retry budget is a parameter, not a version comparison.** A request
that is refused retries at most once, and the second attempt carries no budget
whatever the server answers — so no sequence of replies produces a third. An
earlier shape guarded on "did the negotiated revision change", which reads as
bounded but is not the property that matters, and which made the retry
*unreachable* on a single-revision client. Reachable it must be: a proxy that
rewrites the `_meta` envelope makes the server refuse a revision it does in fact
serve and name that same revision in `data.supported`. The client's own bytes
were correct, one retry is the remedy, and a refusal would send the caller
looking for a version mismatch that does not exist.

### 2. The retired client moves to `@living-atlas/atlas-client/legacy`

It is not deleted. `packages/check` still drives it against the live Cloudflare
worker and the canonical isolated-copy runners, and deleting live scripts is not
this change. But it no longer answers to the name "the Atlas client": seven
import sites in `packages/check` now read
`from "@living-atlas/atlas-client/legacy"`, which says at the import site which
surface is being spoken to. Every existing test moved with it and none was
changed.

**When the remote half of the legacy surface is deleted** — `packages/mcp-contract`
and `packages/graph-service`, the two that still carry the quarantine ledger rows
in `atlas-gates` — delete `packages/atlas-client/src/legacy` in the same change.

### 3. TypeScript shapes are a second declaration, so they are mechanically tied to the first

Typed methods mean writing tool shapes down in TypeScript, and the contract
already owns those shapes. A shape declared twice has two shapes; that is the
defect this repository's gates exist to catch, and exempting the client from it
because the second copy is "just types" is how the exemption always starts.

Every closed shape in `records.ts` and `tools.ts` carries a **key manifest** —
an object literal constrained by `satisfies Record<keyof T, true>`, which
TypeScript accepts only when the listed keys are exactly the type's keys — and a
**required-key manifest** derived the same way. `contract-parity.test.ts`
compares both against the published document's own `properties` and `required`,
in both directions, for all twelve tools, the record schemas and the common
`$defs`. A member added to the contract and forgotten here fails the build; so
does the reverse; so does an optional member typed as required.

Three record schemas are deliberately **not** key-manifested —
`atlas.assertion:v1`, `atlas.entity:v1`, `atlas.redaction:v1` — because all three
are open at the top level in the published schema too, and a key manifest over an
index signature checks nothing. The exemption is a table with a reason per row,
and the parity test asserts that every published record appears in exactly one of
the two tables. A record in neither would be one this client types by accident.

### 4. `packages/atlas-client/src` joins the consumer plane's anti-drift gates

The client is a second reader of the published contract, and the failure a
consumer client has is precisely what gate 5 looks for: a limit or a tool-name
set written down again in the code that calls rather than read from the document
that publishes it. It passes with zero findings, and a restated
`max_page_size = 200` in the client was confirmed to fail the gate.

### 5. The transport is a seam with one method, and HTTP drops into it

`AtlasTransport` is `request(JsonRpcRequest) => Promise<JsonRpcResponse>` and
`close()`. It knows nothing about `_meta`, credentials, contract revisions or
tools. Everything that could differ between deployments lives above it, so a
correct consumer never branches on how it connected — the same rule the server
states from its side ("nothing in this type names a transport, and nothing may").

**Only the stdio transport ships here**, because the Streamable HTTP surface is
another lane's work and did not exist in this worktree. An HTTP transport
implements this interface and everything above the seam — including every
end-to-end scenario — is reused unchanged. Nothing in `client.ts` reads a URL, a
header, a pipe, or a process handle. **OPEN:** transport parity is therefore
*designed for* and not yet *demonstrated*. The scenario that closes it is the
identical client object driven identically over both transports, asserting
identical results; it needs both transports in one worktree.

Request/response rather than send/receive, because this revision's
multi-round-trip flow returns its `inputRequests` inside the tool result rather
than as a server-initiated request, so every message is client-initiated. A
transport that must carry server-initiated requests adds a member; this one does
not change shape.

### 6. Declaring `elicitation` and being able to answer one are the same field

`elicitation` is declared when, and only when, an elicitation decider was
supplied — and a caller that passes `capabilities: { elicitation: {} }` without
one has the key removed rather than honoured. A client that advertises an owner
decision it cannot service receives a request nobody can answer and waits on it;
the `-32021` the server owes an undeclared capability only works if clients
declare honestly. The escalation follows exactly one round: a server that
escalates the answer to its own escalation is one this client cannot make
progress against, and retrying would hide that.

The signed `requestState` is handed to the decider. The codec is signed and not
encrypted, so a client can already read it; withholding it would protect nothing
while making a host that persists an escalation across processes impossible.

### 7. `packages/atlas-e2e` is a new package, and it is a harness, not a surface

It declares no `exports` — nothing outside it can import it — and no binary. Its
files match the repository's vitest include, so the journey runs inside
`npm test`; they are named `*.e2e.test.ts` so a reader of a failure knows a real
process was involved.

**A scenario that writes takes its own server; a scenario that only reads shares
one per file.** The first version gave every scenario a private process — 34
children, about 18 seconds of CPU — and it reliably tipped an existing CPU-bound
test in `packages/backup` over its 20-second timeout. That test takes 18.3s alone
and its own comment records that it was already tuned once for parallel
contention; two of three full runs failed with the harness as first written. A
suite that destabilises its neighbours is not a suite anyone keeps, so the
harness now spawns 14 and the full run is stable over repeated trials.

Sharing is not merely cheaper, it is more correct. It forces the audit assertions
to be **deltas** — `auditSince(marker)`, "this call wrote exactly one event" —
rather than totals, and a total says the same thing only on a server nothing else
has spoken to. It also lets one process serve a consumer, an operator and an
anonymous caller at once, which demonstrates that credentials are per-request
input better than three processes each seeing one credential would.

What keeps a private process: anything that commits, and the restart scenarios.
The change feed's seq and the idempotency table are exactly the state a later
test would otherwise depend on, and an order-dependent suite is one that passes
until somebody inserts a test in the middle.

It spawns the **real** consumer server: the shipped `serveAtlasStdio`, the
shipped twelve handlers, the published schemas on both sides, the protocol gate,
the capability-refusal transport, and atlas-core's `DurableAssertionLog` and
`DurableEntityRegistry`. Nothing on the request path is mocked. The suite kills
the server with SIGKILL — not a graceful stop, which would prove only that an
orderly shutdown loses nothing — and restarts on the same bytes.

### 8. The harness owns its server wiring; `atlas-mcp`'s CLI stays as it is

`packages/atlas-mcp/src/cli.ts` serves the surface against an empty in-memory
graph, deliberately (ADR 0014). Wiring a durable store to the *shipped* binary is
a separate, reviewable act with real-data implications, so this change does not
make it: `packages/atlas-e2e/src/server-entry.ts` composes the real pieces
against a temporary directory instead.

Composing real components is not mocking them — a mock answers questions, and
that file only decides which directory the real answers are written to — but it
is a fork worth naming. **OPEN:** whether the shipped consumer CLI should gain a
`--data-dir` and open the durable store belongs to whoever wires the first real
deployment, and `server-entry.ts` is the reference for what that costs.

### 9. Secrets are minted by the parent and never written down

The credential file the spawned server reads holds **token hashes and principals
only**, which is `InMemoryCredentialDirectory`'s own design note used as intended.
Secrets are not passed on the child's command line (argv is readable through
`ps`) and not placed in its environment — the child receives a *replacement*
environment rather than an inherited one, because a child that inherits the
parent's whole environment inherits every secret in it.

The spawned server reads nothing outside the directory it is told to use: no
environment fallback, no profile lookup, no default path. A missing `--data-dir`
is a usage error rather than a guess, because a harness server that helpfully
guessed a location is one that can be pointed at real data by omission.

### 10. `ATLAS_CREDENTIAL_META_KEY` is restated in the client, and checked

The client declares `io.livingatlas/credential` rather than importing
`CREDENTIAL_META_KEY` from `@living-atlas/atlas-mcp`: a consumer client that
depended on the server package at runtime would invert the dependency and drag an
entire MCP server in to read one string. The cost of restating it is drift — if
the two ever disagree, every request presents its credential on a member the
server does not read and every call is refused with a cause invisible from either
side — so the server package is a **dev** dependency, present for
`credential-meta-key.test.ts` and nothing else, and the two constants are
compared.

**OPEN:** the key's natural home is `@living-atlas/atlas-contract`, since how a
consumer authenticates on this plane is a property of the plane rather than of one
server. Moving it changes the published contract and belongs to the next revision.

## Consequences

- A consumer gets typed methods, validated results and four distinguishable
  failure modes, and pays for it with a parity test that fails whenever the
  contract moves without the client. That is the intended trade.
- The client cannot express a call to a tool the contract does not publish: its
  method signatures are keyed by `ContractToolName`, and at runtime it refuses
  because no input schema is published for the name. The operator plane is
  therefore unreachable from this client by construction, not by a filter.
- Durability, cursor resumption and idempotency replay across a process death are
  now asserted rather than assumed. Confirmed load-bearing by mutation: giving
  each server process its own log directory fails the restart scenarios, and
  dropping the owner's answer from the escalation retry fails the reveal
  scenarios.
- The e2e suite spawns fourteen child processes and adds roughly six seconds to
  `npm test`. If that becomes a problem, the answer is a smaller fixture or
  fewer private servers — never a shared server for a scenario that writes.
- `packages/backup/src/cloud/personal-onedrive.test.ts` remains a latent flake
  independent of this change: it takes 18.3s against a 20s timeout with nothing
  else running. It is not touched here, but any future work that adds parallel
  CPU load to `npm test` will meet it again, and the real fix is in that test.
- **OPEN:** the in-band escalation form (`outcome: "input-required"` in a complete
  result) exists for a client with no multi-round-trip support, but this revision
  gives the owner's *answer* no channel other than `inputResponses`. Such a client
  can echo the state and cannot convey the decision, and gets
  `owner-decision-missing`. That is a gap in the in-band form, not in this client;
  closing it means a published input field for the decision, which is a contract
  change.
