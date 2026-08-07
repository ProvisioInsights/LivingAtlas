# ADR 0030: The Durable Migration Adapter and the Apply Entrypoint

Status: Accepted for implementation
Date: 2026-08-06

## Context

`applyProjectionPlan` has always taken four ports — `EntityRegistry`,
`AliasLedger`, `TargetPlaneSink`, `MigrationAuditSink` — and the only
implementation of them was `createInMemoryTargetPlane()`. That plane accepts any
id shape, any timestamp and any sequence number, so a projection could satisfy it
completely while being unable to write a single record into the store it was
about to be pointed at. Every apply test passed against it for a week.

This change binds the four ports to the real durable core: `DurableAssertionLog`,
`DurableEntityRegistry` and the alias ledger that registry owns. Everything below
is a place the two planes disagreed, and each disagreement was a defect the
in-memory plane could not see.

## Decision

### 1. atlas-core wins on time and on sequence, and the plan's copies are decorative

`CommitRequest` carries `recorded_at` and `seq`. The adapter IGNORES both. The
assertion log stamps belief time at commit and allocates `seq` itself, because a
caller-supplied belief time is exactly what makes an as-of read unrepeatable and
a caller-supplied feed position is not the store's own.

This is stated here rather than left to be discovered. A reader of
`applyProjectionPlan` can reasonably assume the two fields are honoured; they are
not, and **a field that looks authoritative and is decorative is how the next
person builds on a guarantee that was never there.** It was verified before the
adapter was written that `applyProjectionPlan` never compares a returned `seq` or
`recorded_at` against a planned one — it only feeds the returned `seq` back into
its own per-source counter, which the adapter also ignores.

`CommitReceipt.seq` therefore carries the assertion's change-feed position, or
`0` when the record produced no assertion (an entity, or an absence). Zero cannot
be mistaken for a feed position because an assertion's `seq` is always positive.
`CommitRequest.object_id` is authoritative for entity records only — it is the id
`mintEntity` just minted — and is ignored for every other kind.

### 2. `client_id` is the constant `la_client_atlas_migrate`

`(client_id, idempotency_key)` is the assertion log's replay key. Anything
run-scoped or version-scoped — a timestamp, a run id, a package version — would
make a resume miss every receipt the first attempt wrote and commit a second copy
of the entire corpus. The migration is one logical writer across however many
attempts it takes.

### 3. Entity resumability lives in the identity log, not in a sidecar

`EntityDraft.basis` carries the migration's idempotency key, so "did this record
already mint an entity?" is answered by the identity log itself, rebuilt by
scanning it on open. A file beside the log would be a second copy of a fact the
log already holds, and a second copy can disagree with the first — including by
being lost, at which point the resume mints the whole corpus again.

This is load-bearing for a reason the in-memory plane hid: `mintEntity` writes to
the identity log and returns an id BEFORE the sink is asked to commit, because an
id handed out before the bytes are durable is an id that can be minted again for
something else. A run killed between the two leaves a durable entity with no
receipt naming it. `basis` is what lets the resume find that orphan and replay it
instead of minting a second identity for one legacy record. The measured case:
killing a run after six sink commits leaves seven entities on disk, and without
the basis handle the resume produced 21 entities where the plan called for 14.

### 4. `mintAssertion` defers, and the token it returns cannot become an id

The port allocates an assertion id before the record is resolved and written.
atlas-core cannot: `AssertionLog.commit` mints the id at commit from a fully
resolved draft. So the adapter returns a token prefixed `deferred-to-commit:`,
and the durable id comes back on the receipt — which is the id
`applyProjectionPlan` actually propagates.

The token is shaped so it CANNOT pass `AssertionIdSchema`. If a future change
ever let it reach a durable field, zod refuses the write rather than persisting a
plausible-looking id that resolves to nothing. A test greps every segment file
for the prefix, so this is a property of the bytes rather than a promise the
adapter makes about itself.

### 5. Retraction dispatches on what the deleted record became

An ASSERTION target retracts natively: a new assertion with
`lineage_action: "retract"` naming the original in `supersedes`, with the world
time copied rather than closed — a retraction is a belief error and the world did
not change.

An ENTITY target cannot. Entities are never deleted, so there is nothing to
retract and a retraction over an entity would name a claim nobody made. What the
legacy store recorded is a fact ABOUT that record, asserted as one under
`legacy-record-tombstoned`.

**OPEN:** the legacy tombstone was a bare boolean with no actor and no reason, so
the migration cannot tell a belief error (`retract`) from a world change
(`invalidate`). It follows the plan, which names the record a retraction. If the
distinction ever matters, it cannot be recovered from the migrated data — only
from the frozen replica, and only by a human who knows what the tombstone meant.

### 6. An absence commits no record, and records that it did

`Absence records commit NOTHING` is honoured: no entity, no assertion. But the
port needs a durable receipt or a resume re-enters that branch every run and
reports having committed records it did not write, so the one number an operator
uses to decide the migration is finished never settles.

A submission naming zero assertions is the only mechanism atlas-core offers that
is durable, idempotent and produces no record. Its `submission_id` is the
receipt's `object_id`: a real id naming exactly what happened, rather than an
empty string standing in for a record that was never meant to exist. Nothing
resolves through it — the projector points neither an alias nor a retraction at
an absence, and says so in `pushAbsenceRecord`.

### 7. The alias ledger round-trips exactly, or reports a conflict

`applyProjectionPlan` decides a run conflicted by comparing a re-read alias target
against the planned one with `JSON.stringify`, so a row that does not read back
byte-identical makes every resume report a conflict over rows it wrote itself.
atlas-core's row has one free-text `reason` and no field for the migration's
`record_kind`, `disposition`, refusal reason or detail.

- A **redirect** recovers its record kind from the id prefix: `la_entity_` is an
  entity record, `la_assertion_` a relationship — the only two kinds the
  projector ever points a redirect at. `appendAliasRow` checks that round trip on
  every write, so a third kind refuses at the append instead of reading back as
  one of these two.
- A **no-target** row encodes its three parts into `reason` as
  `disposition[/refusal-reason]: detail`, separated by tokens neither closed enum
  can contain. It reads as a sentence and parses back exactly, **key order
  included** — a value-wise reconstruction with different key order was measured
  to produce 14 phantom conflicts on the second run.
- A row that does NOT parse is returned as it stands rather than normalised into
  something that compares equal, so a row this migration did not write is
  reported as a conflict instead of being overwritten.

A legacy EDGE id uses the `mapped-assertion` disposition and the
`carried-as-assertion` refusal published in revision 2026.08.2 (ADR 0027).

### 8. Three guards on the apply entrypoint, each refusing and exiting non-zero

1. **The closure gate.** `applyProjectionPlan` refuses a failing plan on its own,
   but only after the caller has opened the target plane, which creates two
   segment logs. Evaluating the gate first means an uncertifiable plan leaves no
   directory behind for somebody to later mistake for a partial migration.
2. **The target is not the replica.** Compared on real paths after resolving
   symlinks — `~/store-new -> store` is the shape this mistake takes — and with a
   separator-aware prefix test, so `personal-prod-new` is not read as inside
   `personal-prod`. Both nesting directions are refused: a target that CONTAINS
   the replica makes the frozen bytes a subdirectory of a tree this run owns.
   Compared case-insensitively, because the operator's filesystem is, and because
   the two failure modes are not symmetric: a spurious refusal costs a rename, a
   missed one writes into the only surviving copy of the source graph.
3. **The sync daemon is not loaded.** A second writer during a migration is how
   you get a half-graph nobody can reason about. `undeterminable` — launchctl
   missing, not executable, killed — is a REFUSAL, because a guard that could not
   check has not checked.

Guards 2 and 3 are evaluated before the plan is built, and both are evaluated
even when the first has already fired: building the plan means decrypting the
whole replica, and an operator should not pay that to be told their target path
was wrong, nor fix one problem and then be told about the second.

### 9. The reconciliation is computed from the plan, never from a constant

    entities   == records_by_kind[entity] + [minted-entity]
    assertions == [relationship] + [minted-relationship] + [retraction]
    alias rows == plan.outcomes.length
    absence    == [absence], committed nowhere

Read back by RE-SCANNING the segment files, never from the counters the run kept:
a reconciliation computed from the process's own bookkeeping proves the process
is self-consistent, which is the one thing it is guaranteed to be. Compaction in
this repo already reasons about the bytes that exist rather than about what the
writer believes it wrote, and a migration's final tally has the same standard.

"Committed nowhere" is not a separate assertion — it is what the first two
equations MEAN. If an absence had committed an assertion, `assertions` would
exceed the relationship-and-retraction total and the run would fail.

A mismatch is a FAILED run, reported as one and exiting non-zero. A migration
that wrote a different number of records than its own plan called for has not
"completed with a warning"; nobody can say what it did.

A hardcoded total would stop being a check the moment the corpus grew: it passes
for the run it was written against and is then either failing forever or quietly
updated to whatever the run produced, at which point it measures nothing.

## What is NOT carried, and is counted instead

`atlas.entity:v1` is identity and names. A projected entity record also carries
`attrs` (`founded_year`, `geo`, `timezone`, `homepage_ref`, `occurred_on`), a
`description`, an occurrence `entity_subtype` and a `topic_scheme`, and the
entity record has no field for any of them. The reconciliation above says an
entity record produces exactly one entity and no assertion, so this adapter does
not carry them — and does not invent an assertion shape to hold them either, because
what predicate an imported `founded_year` becomes is a modelling decision, and
inventing one here would publish a shape by accident in the same move ADR 0027
was cut to avoid.

The deferral is structural rather than aspirational, on the terms already set for
the unmodelled Logseq blocks:

- **Nothing is lost.** The replica is frozen and never written after the freeze,
  so every value is still readable at its source.
- **It is visible.** `countDeferredEntityContent` counts the entity records
  carrying each of the four, plus the distinct attribute KEYS (never the values,
  which are graph content). `real-data:migration-apply` prints the block on every
  run, zero or not — a section that disappeared when it read zero is a section
  people stop looking for.
- **A test holds it.** One asserts the counts are non-zero on the fixture so the
  number is not vacuous; another asserts the descriptions are genuinely absent
  from the identity log, so nothing is quietly smuggled into a display name.

**OPEN — for the modelling pass, not for this change:**

- What predicate each carried attribute becomes, and whether `attrs` is one
  assertion per key or one per record.
- Whether `entity_subtype` — the one surviving subtype enum — belongs on the
  entity, on a `has-type` edge, or on an assertion, given the vocabulary
  deliberately keeps it as an enum rather than a topic.
- Whether `topic_scheme` needs to survive on the entity at all. Scheme-scoped
  slots already mean two homonyms in different schemes become two entities with
  the same `display_name`, which is correct; what is lost is the ability to ask
  which scheme an entity's word belongs to.
- Whether the legacy `access_class` should classify the imported assertion.
  Today every imported record takes the `local-private` default, carrying the
  legacy value inside the assertion's `value` envelope. Re-tiering downward later
  is reversible; having imported at the wrong tier is not.

## Consequences

- The migration can be pointed at a real target root, and a run killed part-way
  is completable by re-running.
- **Anything written into the new store after migration is unprotected until
  new-format backup lands.** New-format backup is deferred this round; the frozen
  old store plus its verified backup is the recovery story for what was migrated,
  and it covers nothing written afterwards.
- The protocol stays 2026-07-28 only. No compatibility path was added.
- Two additions to `EntityMintRequest`: the record's `idempotency_key` (§3) and
  its `name`/`aliases`. A registry that mints identity has to be handed a display
  name — one is required on every entity, and an adapter that had to invent one
  would put a placeholder where the graph shows a person's name.
- `value` on an imported assertion carries the legacy provenance envelope
  verbatim, which puts provenance inside `claim_digest`. Accepted rather than
  overlooked: an imported record already carries
  `recorded_at_fidelity: "import-artifact"` and the store reports a page mixing
  fidelities precisely because comparing an import against an authored claim is
  not meaningful. Losing the evidence to protect a comparison nobody can make
  would be the wrong trade.
- Confidence on every imported assertion is `medium`, not `high`. A mechanical
  import evaluated no claim; `high` would put the migration's name behind
  assertions nobody assessed.
