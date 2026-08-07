# ADR 0028: Serving A Durable Store From A Directory, Read-Only By Default

Status: Accepted for implementation
Date: 2026-08-06

Issue: #71 (there is no supported way to point a client at an existing graph),
#63.

## Context

ADRs 0011 and 0012 built a durable segment log and a durable identity log. ADR
0014 built a consumer server behind a `GraphSource` port. ADR 0015 built an
operator plane behind an `OperatorSource` port. ADR 0022 built an end-to-end
harness that spawns a real server against a real directory.

Nothing joined them up in the product.

`packages/atlas-mcp/src/cli.ts` — the binary the package declares as
`living-atlas-atlas-mcp` — constructed a fresh in-memory `AssertionLog` at
startup and served an empty ephemeral graph. The seam was already there and
nothing durable was behind it. The end-to-end harness DID open a durable store,
but through `packages/atlas-e2e/src/server-entry.ts`, which is a test file: it
took `--data-dir` because the harness told it to, and it said so in its own
comment ("wiring a durable store to the shipped binary is a separate, reviewable
act"). So the repository could demonstrate the whole system working against a
real directory while shipping a binary that could not be pointed at one.

Two claims are different and only the second is a product: "the server works when
a harness composes it", and "the thing you install can be pointed at your graph".

## Decision

### 1. The store arrives by environment, and both planes read the same variable

```
LIVING_ATLAS_STORE_DIR    the directory holding the store
LIVING_ATLAS_STORE_MODE   read-only (default) | read-write
```

`packages/atlas-mcp/src/store.ts` owns both names and the single function
`openStoreFromEnvironment` that both entry points call. One function rather than
two readings of one variable, so a deployment cannot point its consumer at one
store and its operator at another by spelling something differently — and an
operator asking `atlas.ops.store.status.read.v1` is asking about the store the
consumer is serving.

`LIVING_ATLAS_STORE_DIR` is deliberately NOT `LIVING_ATLAS_LOCAL_GRAPH_DIR`. That
name belongs to the frozen legacy replica, which is never written after the
freeze; a server pointed at one when it meant the other must fail rather than
serve the wrong graph.

The store layout is:

```
<store root>/
  assertions/   the assertion segment log
  identity/     the identity segment log
```

Two directories because atlas-core refuses to load a directory holding both: an
assertion record found by the identity reader means two logs were written into
one place, and it says so rather than skipping what it does not understand.

The audit log is deliberately NOT part of the layout. It stays `--audit-log`.
Where a plane writes its disclosure log is an argument to that plane; folding it
into the graph store would mean a server pointed at a store silently inherits an
audit destination nobody named.

### 2. With the variable unset, nothing changes

Absent `LIVING_ATLAS_STORE_DIR`, the consumer entry serves the same empty
in-memory graph it always did and the operator entry serves the same synthetic
operational source. Every existing test and the whole end-to-end fixture harness
depend on that, and the harness spawns its child with a replacement environment
that contains no `LIVING_ATLAS_*` variable at all.

### 3. An absent store is an ERROR, never an empty one

Nothing in `store.ts` calls `mkdir`. The root, `assertions/` and `identity/` must
all already exist; a missing one throws, naming which, and the entry point exits
rather than falling back to the in-memory graph.

This matches `LocalGraphMigrationSource` in `packages/local-graph-store`, which
refuses the same way for the same stated reason: "reporting a directory that does
not exist as a store with zero objects is how a migration completes against
nothing." The same sentence holds for a server — a typo'd path that answered
every query with an empty page would look healthy while serving nothing.

The three directories are required rather than only the root, because the
dangerous case is a root that DOES exist. Creating the two log directories inside
a real directory pointed at by mistake would serve an empty graph out of
somebody's home directory and report it as a healthy store.

A store that exists and holds nothing is a different fact and is REPORTED, not
refused: the count reaches stderr at startup and
`atlas.ops.store.status.read.v1`.

### 4. Read-only is the default, and it is real

**The consumer plane opens the store read-only unless the operator asks
otherwise.** The reason is D-BACKUP: new-format backup does not exist yet. The
frozen legacy store plus its verified backup is the recovery story for what was
migrated; anything written into the new store afterwards is unprotected until
backup lands. A default that silently accepted writes would be choosing, on the
operator's behalf, to create data that cannot be recovered.

Read-only means it at the filesystem and not only at the tool boundary:

- the segment logs are scanned with `repair: false`, so a torn tail is REPORTED
  and the bytes are left exactly as they are. A read-only open that truncated a
  damaged file would be a write performed by something that promised not to
  write;
- no `SegmentWriter` is constructed, so no header, no repair record and no new
  segment file is created. A unit test compares the whole directory tree
  byte-for-byte across an open;
- the log is built with no journal, and `commit`/`advanceHistoryFloor` are
  overridden to throw. This is the one that matters most: an `AssertionLog`
  without a journal still ACCEPTS a commit — into RAM — and returns a receipt
  for it, which is strictly worse than refusing.

The refusal a caller sees is `store-read-only`, a new code in the OPEN
`atlas.error:v1` vocabulary, raised in tool code from
`GraphSource.readOnly`. It is checked BEFORE the grant checks, because a
read-only store refuses every proposal from every credential and answering
`predicate-not-writable` first would send the caller to
`atlas.scope.describe.v1` and then to whoever issues grants, for a refusal no
grant can lift. It is marked `retryable: true` on the same reading as
`sensitivity-withheld`: the identical request succeeds against the same store
reopened read-write, and reopening is not something the caller does to its
request.

`readOnly` lives on `GraphSource` rather than in the grant because it is a
property of the STORE. "No credential was granted this predicate" and "this
server cannot write at all" are different facts.

`LIVING_ATLAS_STORE_MODE=read-write` opts in. An unrecognised value throws rather
than falling back: a typo in the one variable that decides whether a server may
write must not silently select an answer, and a fallback would never tell the
operator the value was not understood.

### 5. The store is opened once per process

Both entry points open at module scope, before the server is built. `store.ts`
additionally refuses a second open of the same directory within one process,
keyed on the resolved real path so that a relative path, a trailing slash or a
symlink cannot get around it. Two `SegmentWriter`s appending to one segment log
interleave records and corrupt the commit groups the reader depends on.

A failed open releases the handle, so the retry an operator makes next fails for
its own reason instead of reporting "already open" about a store nobody opened.

### 6. The operator plane reports the store, and refuses to pretend

`atlas.ops.store.status.read.v1` reports mode, feed epoch, belief-time floor,
published watermark, record and segment counts, and what the load found wrong.

When this server opened NO store, the tool REFUSES with `store-not-opened`
rather than reporting a row of zeroes. The whole reason `store.ts` refuses an
absent directory is that zero and not-there must never be spelled the same way;
reporting them identically here would put the confusion back one layer up. It is
also the only way an operator can tell a server serving a real store from one
serving the fixture without deducing it from a refusal they happened to provoke.

The result carries no graph content and no filesystem path. The operator supplied
the path; a tool result is not the place to publish where a deployment keeps its
data.

`storeBackedOperatorSource` reports EMPTY migration windows, replication targets,
metered usage and review queue, and refuses every reconcile with
`reconcile-refused`. None of that state is durable in the store, and carrying the
synthetic fixtures over would have an operator reading a replication lag for a
replica that does not exist.

## Consequences

### What this does not do, stated rather than left to be discovered

**No new-format backup (D-BACKUP).** Nothing written into the new store after
migration is protected until backup lands. Read-only being the default bounds the
exposure to whatever a deliberate `read-write` deployment writes, but it does not
remove it.

**The change-feed watermark is not durable in read-only mode.** `changesSince`
advances the published watermark through the journal, and a read-only open has
none, so the advance is in memory and forgotten at exit. Compaction keys off that
watermark. Nothing on either entry point can reach `compact()` today, but a store
served read-only must not be compacted by another process concurrently, and
whoever adds a compaction path owns closing this.

**The shipped consumer entry still authenticates nobody.** It holds one fixed
principal with the narrowest usable grant: `open` tier, no writable predicates.
Over a durable store that has a visible consequence — `local-private` is the tier
atlas-core stamps on anything committed without a classification, so most of a
migrated graph arrives as redaction stubs rather than content. That is the grant
model working, not the store failing, but a deployment that needs to read further
needs a credential directory on this entry point, which this ADR does not add.

**OPEN: the durable store carries no predicate vocabulary.** `GraphSource.
predicateRegistry` is derived from the assertions the store holds. `relational`
is observable — an assertion either carries a `target_entity_id` or it does not —
but CARDINALITY is not recorded anywhere. Every derived predicate is therefore
reported `multi-valued`, which is the honest reading of "no functional key is
declared for this predicate". The consequence: **a store-backed graph reports no
functional-key contradiction until the store can carry a vocabulary.** Claiming
`functional` from data would be the opposite error and a worse one — Atlas would
invent contradictions in a graph that never declared the constraint. A later
revision must decide where the vocabulary lives and how it is migrated.

**A read-write open of an EMPTY store founds its feed.** `DurableAssertionLog.
open` takes its epoch and history floor from the segment header when one exists
and from its defaults when none does, so opening a prepared-but-empty store
read-write writes a header with epoch `e1` and a floor of "now". That is
atlas-core's documented open semantics and this ADR does not change it, but it
means the SERVER can found a feed that a migration was going to found. The
startup line and `atlas.ops.store.status.read.v1` both report the record count,
so the case is visible; whoever writes the migration runner owns making the
runner, not the server, the thing that creates a store.

**Entities are enumerated once, at open.** `EntityRegistry` exposes no
enumeration, so `searchableEntities` comes from a scan of the identity log after
it is opened. The consumer plane registers no entities, so the list is stable for
the life of the process. A plane that gains an entity-write tool has to revisit
this, and would find `atlas.text.search.v1` reporting fewer plaintext candidates
than the graph holds.

**No compatibility path (D-CLIENT).** Protocol stays 2026-07-28 only. This ADR
changes what the server serves FROM, not what it speaks.

### Validation gates

- `packages/atlas-mcp/src/store.test.ts` — the refusals (absent root, absent
  assertion log, absent identity log, a file where a directory should be), the
  byte-for-byte proof that a read-only open writes nothing, the throwing
  mutators, the one-handle rule including the spelling variants and the
  released-on-failure case, the derived predicate registry, and the environment
  parsing including the refusal of an unrecognised mode.
- `packages/atlas-mcp/src/operator/operator.test.ts` — the store status tool over
  a real store, the `store-not-opened` refusal, the empty operational lists, and
  the reconcile refusal.
- `packages/atlas-e2e/src/serve-store.e2e.test.ts` — the SHIPPED binary, resolved
  through the package's own `bin`, spawned against a real temporary store that
  atlas-core populated directly, driven through the real typed client with no
  mocks: reads back what was written, gives identical answers and resumes the
  same cursor after SIGKILL and restart on the same directory, refuses a proposal
  with `store-read-only`, still serves the empty in-memory graph when the
  variable is unset, and EXITS with a startup failure rather than serving an
  empty graph when the directory is not there.
