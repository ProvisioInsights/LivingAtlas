# ADR 0012: Entity Registry And Append-Only Alias Ledger

Status: Accepted for implementation
Date: 2026-08-04

## Context

The prior local store derived a block's id from
`sha256(sourcePathRef : lineIndex : text)`. Three consequences followed
mechanically:

1. Fixing a typo minted a new id.
2. Inserting one bullet shifted every line below it and re-identified all of
   them.
3. Renaming a file re-identified everything the file contained.

51,811 of 65,091 objects were exposed to this. Two fallback paths made it worse:
one derived the path-redaction secret from the import run's own timestamp, the
other from `randomBytes(16)` per call, so a careless re-import produced a
completely disjoint id space for the entire corpus.

An id that changes when the text changes is not an identifier. It is a content
hash with an identifier's name, and it cannot support the one thing a long-term
reference has to support: a consumer writing an id down today and getting the
same thing back in five years.

ADR 0007 settled the identity *pipeline* — observation, evidence, resolution
decision, canonical reference — and stated that merges keep every id durable
through a redirect index. It did not specify the record shapes, the resolution
algorithm, its termination properties, or how a redirect relates to an
assertion. This ADR does.

`packages/atlas-core` already holds minted ids (`mintEntityId`), the assertion
log, and the segment-log durability layer from ADR 0011. This work extends that
package rather than adding a new one — see "Rejected Alternatives".

## Decision

### `entity_id` is minted once and is never re-derived

There is no API that accepts an entity id. `register()` and `resolveOrMint()`
return one; nothing takes one as an input to creation. Content, position, file
path, and encoding are recorded as `SourceObservation` — evidence *about* an
entity — and an observation may change freely without moving an id.

Names are observations too. `display_name` and `also_known_as` are strings a
human reads. The field is deliberately not called "aliases", because in Atlas an
alias is a row in the id ledger, and one word meaning both a nickname and an id
redirect is how a rename becomes a re-identification. Renaming writes no ledger
row and cannot move an id.

### The alias ledger is append-only, hash-chained, and is not the assertion log

A row records what happened to an id: `{old_id, reason, recorded_at, basis,
disposition, provenance, resolution_assertion_id}` plus the chain links
`prev_ledger_digest` and `ledger_digest`. `old_id` is a plain string, not an
`EntityId`, because the ids that most need to keep resolving are the legacy ones
Atlas inherited rather than minted.

Each row commits to its predecessor, so removing or back-dating a row
invalidates every row after it. `verifyAliasLedger()` recomputes the chain and
also checks `row_seq` for gaps — an intact chain across a deletion still hides
the deletion if nobody notices the missing position. Without this, "append-only"
is a claim about the writer's behaviour; with it, it is a property of the bytes.

### A redirect is not an assertion

Mechanical migration produces tens of thousands of redirects. Routing them
through the assertion path would require fabricating an evidence record for each
one — manufactured provenance, at scale, in the exact layer attribution depends
on.

So `basis` discriminates:

- `mechanical-migration` writes a ledger row and nothing else.
  `resolution_assertion_id` is null.
- `owner-resolution` additionally commits a resolution assertion carrying real
  evidence, and the row names it.

If no assertion log is wired up, an owner-initiated merge is **refused** rather
than downgraded to a bare row. Silently dropping the evidence would leave a
human's decision indistinguishable from a machine's.

The assertion is committed **before** the row. A crash between them leaves
evidence for a redirect that does not exist — inert and discoverable. The other
order would leave a redirect that consumers already follow with no record of who
decided it or why.

The two record shapes are disjoint, and that is tested rather than asserted: no
alias row validates against `AssertionSchema`.

### Resolution follows chains and always terminates

`resolve(id)` consults the ledger **before** the entity table, because a
merged-away entity is still a live record — merges never delete — and returning
it would hand back a stale identity that looks perfectly valid.

Three independent guarantees of termination:

1. **One successor per id.** A second row for an id already carrying one is
   refused (`alias-already-redirected`). This makes the ledger a forest of paths
   rather than a graph, so there is never a winner to pick.
2. **A visited set**, which catches a cycle a tampered or hand-edited ledger
   contains, and refuses with the cycle path.
3. **A depth cap** (default 32), which fires as a typed error even if cycle
   detection is itself wrong. It bounds the walk without shortening a legal
   chain: the id reached by the last permitted hop is still resolved.

Cycles are also refused at **write** time: a merge whose target already resolves
through the source is rejected before any row is appended.

Whenever a redirect was followed, the result carries `redirected_from`,
`redirect_chain`, `redirect_reason`, and `redirect_rows`, so a consumer can
always see it was redirected and audit every hop. `redirect_reason` is the
*first* hop's reason — the answer to "why did the id I hold stop being current?"
A single string cannot honestly summarise a multi-hop history, so it does not
try; `redirect_rows` carries the rest.

### Splits refuse to guess

A split creates new entities and redirects the old id to
`disposition: "ambiguous-split"` listing the candidates. There is no primary.
Nominating one would silently attribute every historical reference to it, which
is precisely the "silently combining different people" failure ADR 0007 rejects.

This does not weaken the contract promise. The promise is that an id never
becomes meaningless and is never reused — not that it always yields exactly one
entity. `resolve()` on a split id returns a typed ambiguity naming the
candidates, which is an answer. It never returns `unknown-id`.

### Legacy ids that were not carried forward resolve to a stated outcome

`never-migrated`, `content-unrecoverable`, and `redacted-in-place` are terminal
dispositions. "We chose not to carry this", "we could not decrypt it", and "we
deliberately redacted it" are three different answers, and a consumer that
cannot tell them apart cannot tell a dropped record from a dangling reference or
a typo. There are no bare not-founds for an id the migration touched.

### The identity index: carrying an id forward across a re-import

Minting stops an edit from *changing* an id. It does not stop a re-import from
failing to *find* it — and a re-import that cannot find an entity mints a second
one, which is the same duplicate explosion by another route.

`resolveOrMint()` matches an incoming `SourceObservation` against four
independently unstable traits — `source_path_ref`, `block_ordinal`,
`text_digest`, `id_property` — and carries an id forward when **at least two**
agree with exactly one entity (the threshold pinned by the migration plan's W15).
Two or more entities reaching the threshold is refused as `identity-ambiguous`.
Below the threshold, a new entity is minted.

The asymmetry is deliberate. Minting when it should have matched produces a
**duplicate**, repairable later by a merge. Matching when it should have minted
produces a **conflation** — two different things wearing one id — which no later
operation can cleanly undo. Prefer the repairable error.

Two supporting rules:

- **The observation is re-anchored on every carry-forward.** Drift accumulates
  one trait at a time; only re-anchoring keeps each import within the threshold
  of the last, so edit-then-rename-then-reorder still resolves to one id.
- **An observation carrying fewer than two traits is refused.** It could never
  reach the threshold, so every future import would mint another copy. Refusing
  prevents the duplicate at the point it would be seeded.

`text_digest` rather than the text itself, so the index is inspectable without
exposing content. It is a fingerprint, not a redaction — anyone holding the
source can confirm a match — which is why the index stays local-private.

### Identity is durable, and is never reclaimed

The registry writes through a synchronous journal port to its own segment log:
header first so a zero-byte segment is detectable, a `group-commit` marker
written last so a half-written group is discarded, repair only at the tail of
the final segment, and an unknown record kind refuses the load. These are ADR
0011's rules.

What is deliberately absent is compaction: no watermark, no history floor, no
reclamation. An id Atlas has ever returned resolves forever, so the promise is
kept by never having written the code that could break it.

The observation index is journalled too. If it did not survive a restart, the
next re-import would mint a second entity for a record it already had an id for.

## The forks resolved here

### Two logs, not one

`packages/atlas-core` now writes two segment logs into two directories. They
cannot share one, because a segment is the unit of reclamation and their
retention rules are opposites: the assertion log reclaims segments that have
fallen below the history floor; the identity log reclaims nothing. Sharing would
mean either that one alias row pins a segment permanently — making compaction
useless once 65,091 migration rows exist — or that a bug in a retention guard
deletes identity.

The separation is enforced in code: each reader refuses the other's records as
an unknown kind, and each header declares a different `log_format` that the
reader checks by name. The format check earns its place — before it, a misfiled
segment failed only because the two headers happened to differ in *shape*, which
is luck rather than a guarantee.

### Entity sensitivity defaults to local-private

`AssertionLog.commit` defaults an unclassified assertion's sensitivity to
`{tier: "open", rank: 0}`. Entities default to
`{tier: "local-private", rank: 10}` instead, following AGENTS.md's
"default new content to local-private": an entity record holds the names, which
is the most identifying payload in the graph. `withheld` stays false, because
withholding is a decision a projection makes per reader, not one the registry
can make.

### An import never overwrites a curated name

`resolveOrMint()` carries the id forward and re-anchors the observation, but
leaves `display_name` alone. Carrying the id is the importer's job; naming is
not, and a re-import silently reverting a name a human chose would be a
data-loss bug that looks like a sync.

## Open questions

- **`id_property` is weighted like any other trait.** A bullet whose only
  surviving trait is the `id::` UUID the source explicitly declares — because it
  moved file *and* was edited — mints a new entity rather than carrying its id
  forward. Only 433 of 17,036 source bullets (2.5%) carry `id::` at all, so the
  blast radius is small and the failure is a repairable duplicate rather than a
  conflation. Whether an explicit source-declared identifier should be
  authoritative on its own, rather than counting as one of four, is left open
  rather than decided here; W15 pins the ≥2-of-4 rule.
- **The registry has no idempotency keys of its own.** The assertion log's
  `(client_id, idempotency_key)` protects retries there; here, re-entry
  protection is the identity index, which is stronger for imports because it
  survives a *different* key on a re-run. Whether a directly-called
  `register()` needs its own retry protection is open.

## Consequences

Positive:

- An id Atlas has returned resolves forever, and no id is reused.
- Ids survive text edits, line reordering, file renames, entity renames, and
  re-import.
- Identity decisions are explainable: every redirect names a reason, and every
  owner decision names its evidence.
- The provenance layer is not polluted by mechanical bookkeeping.
- Removing or editing a ledger row is detectable from the bytes.

Negative:

- Consumers must resolve redirects rather than dereferencing ids directly.
- Merged-away and split entities stay in storage forever; the identity log only
  grows.
- Some ids resolve to a refusal (`ambiguous-split`, `not-carried-forward`) that
  a caller has to handle as a distinct case from success.
- An ambiguous re-import needs a human, so a migration is not fully unattended.

## Rejected Alternatives

### Deriving ids from content, position, or a natural key

Rejected: this is the defect. Only 433 of 17,036 bullets carry an `id::`, so no
natural key exists for 97.5% of the corpus, and every derivable key is unstable
under ordinary editing.

### A `status: "merged"` field on the entity

Rejected. It would be a second place the redirect state is written, and a second
place can disagree with the ledger — the disagreement then resolving in favour
of whichever one the reader happened to trust. The ledger is the only redirect
authority.

### Rewriting references and deleting the duplicate on merge

Rejected for the reason ADR 0007 gives: partial failure orphans data, and a
mistaken merge becomes destructive rather than reversible.

### Nominating a primary on split

Rejected. It silently attributes every historical reference to one candidate,
which is the conflation the identity boundary exists to prevent.

### Last-row-wins for multiple rows on one id

Rejected. It makes resolution depend on ledger order in a way a reader cannot
audit, and it removes the natural place to notice a contradictory decision.
Refusing the second row keeps the chain a path.

### Routing mechanical redirects through the assertion path

Rejected. It requires an evidence record per redirect, so ~65,000 fabricated
evidence records enter the layer attribution depends on.

### A separate `packages/atlas-identity`

Rejected. The boundary that matters is the log directory and the record
vocabulary, and both are enforced by code that mutually rejects the other log's
bytes — a stronger guarantee than a package edge, which enforces nothing at
runtime. A new workspace package would add a dependency edge and lockfile churn
without adding a rule. Identity also shares `mintEntityId`, `ProvenanceSchema`,
`SensitivitySchema`, and the segment writer with the rest of `atlas-core`.

## Implementation

- `packages/atlas-core/src/entity.ts` — `EntitySchema`, `EntityDraftSchema`,
  `SourceObservationSchema`, the local-private default.
- `packages/atlas-core/src/alias-ledger.ts` — `AliasRowSchema` (a discriminated
  union over `disposition`), the hash chain, `verifyAliasLedger`.
- `packages/atlas-core/src/entity-registry.ts` — `EntityRegistry`, the
  `IdentityJournal` and `ResolutionRecorder` ports, `resolve`, `merge`, `split`,
  `rename`, `resolveOrMint`.
- `packages/atlas-core/src/identity-record.ts` — the identity log's record
  union.
- `packages/atlas-core/src/identity-log.ts` — `scanIdentityLog`,
  `DurableEntityRegistry`.
- `packages/atlas-core/src/segment-writer.ts` — generalised over its record type
  and header factory, so both logs share one fsync-and-roll implementation
  rather than two that drift.

## Verification

- An id survives a text edit, an inserted bullet, a file rename, an entity
  rename, and drift accumulating across successive re-imports.
- Every minted id is distinct across 500 registrations.
- A merged-away id resolves to the canonical entity, reports
  `redirected_from` / `redirect_chain` / `redirect_reason`, and the merged-away
  record is still readable.
- A chain resolves and reports every hop; a cycle is refused with its path; a
  chain past the depth cap is refused with the cap; a dangling redirect is
  reported as an integrity failure rather than a missing record.
- A second successor for one id is refused; a merge that would close a loop is
  refused at write time.
- A mechanical redirect writes no assertion; an owner merge writes one carrying
  its evidence; an owner merge with nowhere to record it is refused and writes
  no row either.
- No alias row validates against `AssertionSchema`.
- A split redirects ambiguously and every candidate resolves to itself.
- The ledger chain verifies, and detects both a row edited in place and a row
  removed from the middle.
- Entities, rows, observations, and the chain survive a reopen; row numbering
  continues rather than restarting; a re-import after a restart still carries
  its id forward.
- A group that died before its commit marker is discarded; a torn tail is
  truncated and reported; a zero-byte segment refuses.
- Each log refuses the other's segments, including a header that is well-formed
  but declares the other log's format.
