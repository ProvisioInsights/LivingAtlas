# ADR 0021: Legacy Projection, Tombstone Disposition, and the Closure Gate

Status: Accepted for implementation
Date: 2026-08-04

## Context

The legacy graph is being projected into the new assertion plane. Under ADR-0009
the legacy store is the complete source of custody today, so this is a one-way
move of the owner's entire corpus: whatever the projection leaves behind is
simply gone once the legacy replica is retired.

The failure mode that matters is not a crash. It is a migration that reports
success while quietly dropping a class of objects nobody thought about — a
schema shape the projector never had a branch for, a tombstone whose meaning did
not fit the one "deleted" flag, an edge whose endpoint never resolved. Those
losses are invisible precisely because nothing errored. The old importer
reported "N imported" with no denominator, so a skipped object and an object
that was never seen produced identical output.

Two further constraints shape the design:

- The corpus is largely ciphertext, and a substantial share of it is expected to
  be **undecryptable** with surviving key material. "We could not read this" must
  be a first-class, counted outcome, and it must be distinguishable from "we did
  not try".
- The real run is blocked on offline backup media. The tooling must therefore be
  provable entirely against synthetic fixtures, and must not be wired to any real
  path.

## Decision

### 1. Plan / apply split, with a pure plan

`buildProjectionPlan` is a pure function of the source envelopes. The plan
carries **no clock and no minted identity**. Two runs over the same frozen source
produce byte-identical plans, so a review diff shows source drift rather than
run-to-run noise.

Entities are named in the plan by a **slot** (`slot_entity_<hex>`), a plan-local
placeholder. Real ids are minted by the entity registry at apply. Deriving an id
from source content would make it a content hash, and two legacy objects that
happened to describe the same thing would silently collapse into one entity with
no resolution decision behind it.

`recorded_at` is stamped at commit and nowhere earlier. Legacy `created_at` /
`updated_at` land in a `provenance` envelope that no time axis reads; they are
bookkeeping about the old store, not belief time and not time of record.

### 2. Total accounting: exactly one outcome per source object

Every source object gets exactly one `SourceOutcome` carrying a category and a
disposition. The category enum is closed and, per house rule, carries `other` —
but a run that puts anything in `other` is **not certifiable**. That is how a
shape the author forgot fails loudly instead of vanishing: it is still counted,
so the arithmetic balances, and the gate still refuses.

Refusals carry a named reason from a closed enum. A refusal is countable; a drop
is not — and a refusal filed under the WRONG name is barely better, because the
operator's remedy is chosen from the name. A derived lookup table (a
reference-index namespace) is refused as `derived-index-not-migrated`, which
means "we decided and the decision is not to carry it"; it is deliberately not
`unclassified-source-category`, which means "nobody decided" and must fail the
gate. The projector had the reason and no branch that produced it, so a real
index object took the fall-through default, was refused as undecided, and failed
the gate on arithmetic while nothing had been lost.

Both directions of the category enum are now obligations the compiler checks:
`satisfies` proves the projector's print order holds nothing the source
vocabulary does not declare, and an `Exclude<>` assertion proves it is missing
nothing. The one-way check is what let `derived-index` be declared, produced, and
absent from every count the operator reads.

### 3. Tombstone disposition

A legacy tombstone is not one thing. Each is mapped to exactly one disposition:

| Legacy shape | Disposition | Why |
| --- | --- | --- |
| Tombstoned entity or typed edge whose payload the caller can read | `projected-as-retraction` | We know what was deleted, so import the pre-deletion record **and** a retraction of **every** record it produced. Importing nothing would turn a recorded deletion into an absence of history; retracting only the records that existed when the entity was drafted leaves the derived and minted edges behind, live and pointing at retracted nodes. |
| Tombstoned object whose ciphertext is permanently unrecoverable | `unrecoverable-ciphertext` | An absence record states that an object existed and could not be carried across. It never invents the content. |
| Object under `quarantine` access class | `redaction-stub` | Content is withheld by policy. Quarantine outranks readability in both directions: a readable quarantined object is still withheld, and an unreadable one is reported as withheld rather than lost. |
| Anything else | `refused:<reason>` | Including `ciphertext-not-attempted` when no key material was loaded. Reporting content as permanently lost when we never tried to open it would be a false statement about absence. |

Unrecoverable and withheld are deliberately kept apart. They are different facts
about the same hole and they send a reader to completely different remedies: one
is data loss to repair from another copy, the other is a policy decision to
review.

### 4. Alias ledger, and what a mechanical redirect may not assert

Every legacy `la_object_*` id gets an alias-ledger row on basis
`mechanical-migration` — **including the ids that carried nothing across**, which
get a typed `no-target` row naming the disposition and reason. A bare lookup miss
would read as "never existed"; the ledger must be able to answer "this existed,
it was not carried across, and here is why".

Legacy redirect chains are flattened at plan time to the record the final hop
became. Leaving the chain intact would force every later lookup to walk N hops,
and a cycle would hang the reader; both were failure modes of the old id-rewrite
scripts. A cycle is refused, not walked.

Chains are flattened **before** edges resolve, and an edge naming a redirected id
attaches to the object the chain ends at. Refusing such an edge would drop a real
relationship over bookkeeping the legacy store had already resolved.

A mechanical redirect writes a ledger row and **nothing else**. An
entity-resolution assertion would claim "these two identities are the same thing,
and here is the evidence" — a claim a mechanical migration has no standing to
make.

### 5. The closure gate

For every source object:

```
count(source) == count(projected) + count(explicitly refused with a named reason)
```

with a per-category and per-disposition breakdown. The denominator is counted off
the input array before any classification runs, so it is independent of the
outcome list: if outcomes were their own denominator, a projector that dropped an
object on the floor would balance perfectly.

The gate additionally refuses a plan that:

- puts any object in `other`, or refuses one as `unclassified-source-category`;
- uses the escape hatch of the refusal-reason or disposition enum;
- contains a relationship naming an entity slot the plan does not mint
  (dangling endpoint), or a retraction naming a record the plan does not create;
- repeats an idempotency key, leaves a record unclaimed by any outcome, or plans
  an alias row pointing at a record that does not exist;
- misreports its own totals — the gate recomputes rather than trusting the
  summary.

`applyProjectionPlan` refuses to run against a failing plan, and records the
refusal as an audit event. A migration that silently declined to run is
indistinguishable from one that was never started.

### 6. Idempotency

Each projected record carries a deterministic key derived from the authority, the
legacy object id, the record kind, and an ordinal. The key deliberately **excludes
the legacy version**: a replica re-read at a later version must land on the same
key, otherwise re-projecting a source that moved would mint a second entity for
one legacy object. Version stays in provenance, where it is evidence rather than
identity.

Apply looks up the original receipt for each key. A key that already has one is
replayed from that receipt — no second commit, no second mint, no second alias
row, and no change to the already-recorded time of record.

**A replay advances the per-legacy-object `seq` counter, and that is the
invariant rather than bookkeeping.** Re-running a *complete* apply is the easy
case: everything replays and nothing is numbered. The case that matters is a
resume after a run died part-way — a sink throw, a full disk, a killed process —
where some keys have receipts and some do not. With the counter left at zero
across the replays, the first record the resume actually commits is handed `seq=1`
while a record committed in the failed run already holds it. Measured on the
fixture: the tombstoned organisation's entity record committed `seq=1` in the
failed run and its retraction committed `seq=1` in the resume. The counter is
therefore raised to the replayed receipt's own `seq` before the loop continues,
so numbering survives however many runs it took.

One audit event per apply call carries aggregate counts. Per-record audit fanout
would make the audit log a second copy of the graph and would leak the shape of
the corpus to anyone allowed to read audit.

**That event names its own outcome.** `mode` says which operation was attempted;
`outcome` says what happened. They are separate because collapsing them is how a
run that committed every record, then hit an alias-ledger conflict, and returned
`ok: false` came to write `mode: "apply", gate_verdict: "pass"` with no field
naming the conflict — a durable event indistinguishable from a clean run, whose
only trace was that `alias_rows_written + alias_rows_reused` fell short of the
outcome count. `outcome` is one of `committed`, `alias-ledger-conflict` or
`closure-gate-failed`, and `alias_rows_conflicted` carries the size of the
disagreement. The event is still built after the alias loop and written once.

### 7. What is deliberately not carried across

- **Legacy edge `source`** — free text that may embed a private file locator.
- **Legacy `confidence` band** — the new plane requires a confidence assessment
  backed by evidence refs; manufacturing one from a bare band would fabricate
  evidence.
- **Narrative objects** (`page`, `attachment`, and any `block` outside a measured
  namespace) — refused with `no-typed-target-representation` rather than dropped.
  **Superseded in part by ADR 0029**: outline blocks in a namespace whose shape
  has been measured are now carried across verbatim as provisional records, under
  their own category and disposition. Pages and attachments stay refused.

The plan report is content-free by construction: ids, types and counts only. A
dry-run artifact is the last place that should hold plaintext.

## Consequences

- A migration run either certifies or names exactly which objects it could not
  account for. There is no third outcome.
- The gate will **fail on the real corpus today**, by design: temporal events and
  narrative objects have no typed target representation in v1, and objects whose
  keys are not loaded refuse as `ciphertext-not-attempted`. Those refusals are
  the work list, not a bug. Outline blocks have since come off that list by being
  carried rather than modelled (ADR 0029); pages and attachments have not.
- Absence records and `no-target` alias rows mean the new plane holds a permanent,
  queryable record of what the old store contained and did not survive.

## Open questions

- **OPEN — binding to the target plane.** The projector emits its own typed
  record shapes and writes through three ports (`EntityRegistry`, `AliasLedger`,
  `TargetPlaneSink`), which are still wired to the in-memory reference
  implementations in `in-memory-plane.ts`. The indirection is deliberate: a
  projector that imported `packages/atlas-core`'s payload schemas directly would
  make every legacy shape a change to the canonical ones, and the reconciliation
  between the two — which projected fields map onto which canonical members, and
  what a legacy shape with no canonical home does — is the decision this lane
  does not make. Binding the ports to the real plane, and that reconciliation,
  are undecided.
- **OPEN — temporal events.** Legacy `event` objects currently land in `other` and
  fail the gate. Whether they project to occurrence entities, to relationship
  assertions, or are refused with a named reason is undecided; failing loudly is
  the interim position, not the answer.
- **OPEN — whether `ciphertext-not-attempted` may ever be waived.** For the real
  run, a partial-key session produces a large refusal bucket. Whether an operator
  may certify a run that refuses on that reason alone — and what record that
  waiver leaves — is undecided.
- **OPEN — retraction semantics for a tombstone with no readable predecessor.**
  Today an unreadable tombstone yields an absence record rather than a retraction,
  because there is nothing to retract. Whether the plane should also carry a
  bare "this id was deleted" retraction is undecided.
