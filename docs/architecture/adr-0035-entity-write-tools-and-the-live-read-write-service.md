# ADR 0035: Entity-Write Tools and the Live Read-Write Service

Status: Accepted for implementation
Date: 2026-08-10

Extends: ADR 0033 (the credential directory and the owner grant), whose owner
grant stays read-only and is now one of two owner credentials rather than the
only one.

## Context

The migrated store is live and readable, and it could not be edited at all
through any published surface. Two independent gaps produced that, and only one
of them was the one anybody had noticed.

**Gap 1 — the contract could not name an entity's own existence.** The published
surface has exactly one write verb, `atlas.assertion.propose.v1`. It commits
directly and accepts `supersedes`, so a consumer could assert a fact about an id,
correct it, or retract it. It could not bring an id into being, and it could not
change what one is called. Entity lifecycle lived only in `atlas-core`'s
`EntityRegistry.register` / `EntityRegistry.rename`, reachable only by a process
holding the store — a private capability of whoever owns the directory. That is
the side channel this contract exists to remove: "any system can use Atlas as a
first-party temporal knowledge store" is false while creating a person requires a
maintenance script.

**Gap 2 — an edit is invisible to a client that is already connected.** `cli.ts`
opens the store *once for the life of the process* and answers from that state.
Every MCP client spawns its own stdio server, so N clients are N private
snapshots. A write performed anywhere — including by another client, including by
the same owner in another window — is invisible until the reader reconnects.
Measured, not inferred: the owner's corrections of 2026-08-09 were durable in the
store and absent from a Desktop session that had been connected across the write.

The second gap is the one that reads as broken, and it is not a query defect. The
query engine answers from current committed state correctly. The topology is
wrong: a per-client private copy of a store that is being written.

## Decision

### 1. `atlas.entity.create.v1` and `atlas.entity.rename.v1`, on the consumer plane

Contract revision **2026.08.3**, additive: twelve tools become fourteen and
nothing else moves.

**The consumer plane, not the operator plane.** The operator plane's charter is
the store's operation and never the knowledge in it — its tools are
`atlas.ops.*.read` plus `reconcile.run`. An entity IS knowledge. Putting entity
creation there would say that minting a person is an administrative act about
Atlas rather than a statement about the world, and it would put the one verb that
brings graph content into being on the plane an external consumer is never given.
The change feed had already made the same judgement: `entity-registered` and
`entity-renamed` are consumer change kinds.

**Publishing them grants nobody anything.** Both are gated exactly as
`propose` is, in the same order and by the same helper:

1. a store opened read-only refuses every credential with `store-read-only`;
2. a grant that does not permit the write tier is refused with
   `write-tier-not-permitted`.

Posture is checked before grant deliberately: a read-only store refuses every
credential, so answering "your grant is insufficient" first would send the caller
to ask for a grant that no grant could satisfy.

**Two hard properties are preserved, not relaxed.**

- *Identity is minted, never derived.* `create` takes no id and returns the one
  Atlas chose. It does **not** deduplicate: two identical calls make two
  entities. Guessing that two requests meant one thing is exactly the conflation
  the identity model exists to prevent, and the repair for a duplicate is a merge
  — an identity event with a ledger row — not a silent replay. `idempotentHint`
  is `false` and says so.
- *A rename changes what a thing is CALLED, never what it IS.* No id moves, no
  ledger row is written, no reference breaks; `entity_id` and `registered_at` come
  back unchanged with only the names and `updated_at` moved. A rename of an id
  that has already been merged away is REFUSED (`entity-redirected`) with
  `atlas.entity.resolve.v1` as the remedy, because editing a superseded record
  changes history rather than the present.

**The writer is exposed only when the store can honour it.** `GraphSource.entities`
gains optional `register` / `rename`, and `buildStore` attaches them only in
`read-write` mode. This is load-bearing rather than tidy: the read-only registry
is built with no journal, so a register through it would mutate RAM and return a
record describing bytes that vanish at exit — the same lie `ReadOnlyAssertionLog.commit`
refuses to tell. Omitting the methods makes the handler refuse before it can reach
for a writer that was never wired.

### 2. A single long-lived read-write service, and one writer

The fix for gap 2 is topology, not caching. One process opens the store
**read-write** and owns it for its lifetime; every client connects to that one
process over MCP Streamable HTTP on loopback. A write mutates the state that same
process answers reads from, so it is visible to the next query from any client,
with no restart and no reconnect.

**HTTP, not a second stdio server.** stdio is one client per process by
construction — that is the shape that produced N private copies. `serveAtlasHttp`
already binds loopback-only and already *requires* a credential directory and a
bearer token, for the reason `auth.ts` states: on stdio the pipe is the trust
boundary, but a loopback socket is reachable by every process on the host.

**Single writer is enforced, not documented.** `openAtlasStore` already refuses a
second handle within a process. Across processes the guard is a lock file the
service holds for its lifetime, so a second read-write service — or a
`real-data:*` maintenance runner — refuses to start rather than interleaving
appends into one segment log. Read-only consumers are unaffected: they open no
writer and take no lock.

**Bounded logging is a precondition, not an afterthought.** The previous daemon
wrote three stderr lines per respawn into a file nothing truncated, under a
`KeepAlive` that respawned at spin rate, and that is why Atlas was turned off.
The service therefore ships with `KeepAlive` restricted to `SuccessfulExit: false`
plus a `ThrottleInterval`, and log rotation installed with it — the same job
`install-atlas-log-rotation.sh` already performs. A service that cannot prove its
logs are bounded does not get installed.

### 3. Which clients can reach it today — measured, not assumed

The HTTP plane is **2026-07-28 only**. ADR 0034 widened the *stdio* entry with a
transitional legacy era for 2025-11-25 and explicitly left HTTP alone ("out of
scope; Desktop is stdio, and HTTP has its own conformance surface to
re-verify"). That deferral has a consequence which has now been measured against
the running service rather than reasoned about:

```
# an initialize at 2025-11-25, i.e. what Claude Desktop 1.26832.0 actually sends
-32020  Missing required header MCP-Protocol-Version. This server speaks
        2026-07-28 only and has no legacy era to infer a version for.
# and with the header supplied
-32022  Unsupported protocol version: 2025-11-25  (supported: ["2026-07-28"])
```

**So Claude Desktop cannot connect to this service yet.** Its bundle contains
URL and SSE transports, but ADR 0034's lesson applies unchanged: a bundle
containing protocol code is not a client using it on the wire, and the only
evidence that counts is the handshake. Desktop reaches Atlas today over stdio
through the transitional legacy era, and that path still serves a per-process
read-only snapshot — which is to say Desktop still needs a reconnect to see an
edit.

The service is nonetheless correct and useful as built: any 2026-07-28 client
reaches it, and the properties it exists for — one writer, one authoritative
state, an edit visible to the next query from any client — are proven on the
wire. Closing the gap for Desktop is a **separate, deliberate decision** with
three candidates, none of which is taken here:

1. **Extend the transitional legacy era to HTTP**, gated by the same constant
   `SUPPORTED_LEGACY_PROTOCOL_VERSIONS`. The honest analogue of ADR 0034, and it
   re-opens a transport conformance surface (the header contract, the `_meta`
   envelope, session handling) that must be re-verified rather than assumed.
2. **A stdio-to-HTTP bridge** Desktop spawns, speaking legacy on the pipe and
   modern to the service. Leaves the HTTP security surface untouched at the cost
   of a second protocol implementation to keep from drifting — which is the
   condition the anti-drift gates exist to prevent.
3. **Wait for Desktop to negotiate 2026-07-28**, which is also the documented
   condition for retiring the stdio legacy era.

### 4. What adversarial review changed, and what it left as a deploy constraint

Two independent reviewers attacked this design. One finding was a real hole and
is FIXED in code; the rest are constraints on a deployment that has not happened
yet, recorded here rather than left in a runbook nobody re-reads.

**FIXED — the lock was in the wrong layer.** It was acquired in the HTTP
service's entrypoint alone, which stopped the service being started twice and
did nothing about the service running beside a read-write *stdio* client or a
`real-data:*` runner — the cases it was written for. Three entrypoints reach a
read-write open. The lock now lives in `openAtlasStore` and is released by
`store.close()`, so the guarantee is structural: every read-write opener is
guarded by the single act of opening, and no future entrypoint has to remember.

**CONSTRAINT — back up from a store at rest.** `real-data:store-backup` is a
filesystem copy that takes no lock, and its own header scopes safe concurrency to
a store that is *served read-only*. Taken while the service is mid-append it can
capture a torn trailing record; the manifest's digests would then be perfectly
self-consistent with a torn snapshot, which is worse than an obvious failure.
**Stop the service (or run it read-only) before backing up.** The lock now makes
the reverse mistake impossible — a maintenance runner cannot open read-write
under a live service — but a *reading* backup is still the operator's discipline.

**CONSTRAINT — least-privilege the writer credential.** The owner-writer grant
must not be a superset of the owner read grant. Specifically it should NOT carry
`atlas.sensitive.reveal.v1` or `reveal_available: true` (reveal is a read-side
escalation and has nothing to do with create/rename/assert/retract), and
`supersession_scope` stays `own-client-id` unless correcting migration-written
edges is genuinely required — `grant.ts` documents `any` as "can rewrite
attribution", which is strictly broader than the read grant. Otherwise the
everyday, always-connected credential becomes the most powerful one on every
axis and the read-only owner grant becomes vestigial.

**CONSTRAINT — the write bearer is the highest-value secret in the system.** It
can write the only cleartext copy of the graph, and a bearer must be presented
verbatim by the client. It must never live in a non-`0600` file. A client that
can only hold a static header in a world-readable config is a reason to front the
service with a shim that injects the header, not a reason to accept the config.

**RECORDED — a rename leaves no ledger row, deliberately.** `display_name` /
`also_known_as` are therefore the one mutable property in an otherwise
append-only graph. This is not a gap: the identity log is append-only, so the
prior record — and every earlier name — remains readable, and the change feed
carries `entity-renamed`. What a rename must NOT do is mint an id or write a
redirect, because that would make correcting a spelling a re-identification. The
distinction is the whole reason `rename` exists separately from `merge`.

## Consequences

- The graph is editable in place by an authenticated owner writer: create,
  rename, assert, correct, retract — all live.
- There are now two owner credentials, and the distinction is the point: the
  existing **owner** grant stays read-only (ADR 0033 unchanged), and a separate
  **owner-writer** grant carries the write tier and the permitted predicates. A
  read that goes wrong cannot write.
- A client already connected when the service starts still sees its own old
  snapshot; pointing a client at the service is a one-time reconfiguration and
  one reconnect. After that, no restart is ever required to see an edit.
- Claude Desktop is not yet one of those clients (§3). Until one of the three
  options there is taken, Desktop keeps its stdio read-only path and still needs
  a reconnect to see a change — so the owner-facing problem is solved for
  2026-07-28 clients and open for Desktop.
- The store is the only cleartext copy of irreplaceable data, and it is now
  writable by a running service. A verified backup before enabling writes is
  mandatory, and `real-data:store-backup` + `real-data:store-restore` are the
  proven pair.
- Entity content still not carried from the migration (ADR 0030) is unaffected;
  `create` mints identity and names only, and facts remain assertions.

## Rejected alternatives

- **Make reads re-read the store per request.** Treats the symptom. It would make
  a stale reader eventually correct while leaving N processes able to open the
  same store read-write, which is the corruption case. Topology is the defect.
- **Put entity writes on the operator plane.** Confuses knowledge with
  administration, and hides the one verb that creates graph content from every
  external consumer — reintroducing the side channel by another name.
- **An off-contract owner-admin socket.** Fastest, and it re-creates gap 1
  permanently: entity lifecycle stays a private capability of whoever holds the
  store, undiscoverable through `atlas.contract.describe.v1` and untestable by the
  conformance suite.
- **Give `create` an idempotency key so retries are replays.** Attractive until a
  legitimate second person with the same name is silently swallowed. Deduplication
  by argument equality is a guess about intent; merge is the honest repair.
- **Widen the existing owner grant to write.** One credential that both reads
  everything and writes everything, held by every client, so any read path defect
  becomes a write path defect. The two grants stay separate.
