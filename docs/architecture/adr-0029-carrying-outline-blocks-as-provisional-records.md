# ADR 0029: Carrying Outline Blocks Across as Provisional Records

Status: Accepted for implementation
Date: 2026-08-06

## Context

The Logseq outline blocks are the largest single population in the legacy store,
and the migration refused all of them. They classified as `narrative-object` and
were refused `no-typed-target-representation`, which was true — this projector has
no typed target for prose — but it left the biggest thing in the graph on the far
side of the migration with no plan for getting it across.

Their shape is known. The importer wrote them under one schema namespace with a
stable payload: an importer discriminator, the source path and block references,
the block's position among its siblings, its nesting depth, its text, and its
Logseq properties. The text is short in the median and small in the maximum; the
whole population is a couple of megabytes of prose.

One fact about them constrains everything below: **no block carries a reference to
any entity.** The importer derived typed endpoints FROM blocks and never stored
the link. There is no recorded edge from a block to the node it produced, in
either direction, and nothing in the payload can be read as one.

Three options were on the table:

1. **Model them now.** Decide what a block IS in the ratified vocabulary, publish
   it, and migrate against that. Correct, and it blocks the migration on a
   modelling question nobody has answered.
2. **Leave them in Logseq.** The frozen replica keeps them readable. Also correct,
   and it means the new store is missing the bulk of the corpus indefinitely.
3. **Carry them now, model them later.**

The owner chose (3), having been told the risk in as many words: *an unmodelled
record type tends to stay unmodelled, and it would be the one thing in the store
with no contract.*

That acceptance is the reason this ADR exists. A deferral somebody has accepted a
stated risk on has to be **structural** rather than aspirational, or the stated
risk is simply what happens.

## Decision

### 1. A provisional record kind, carrying every measured key verbatim

`provisional-block` joins `ProjectedRecordSchema` in `packages/atlas-migrate`. It
carries a full `LegacyProvenance` like every other imported record, plus the
namespace its shape was measured against, plus the source payload under `block`
with **the source's own key names, unchanged**.

Verbatim is not a slogan here, it is the acceptance test. A later modelling pass
must be able to diff a carried record against the frozen replica with no mapping
table in between, so renaming even one key — however much better the new name —
would make "carried verbatim" a claim somebody has to verify by reading code.

Three specifics, because each is a way the carry-over could have been quietly
lossy:

- **Zero is a position, not an absence.** A block at index 0 and depth 0 is the
  first bullet at the top of a file. A carry-over written with a truthiness check
  drops both fields for exactly those blocks and the outline stops being a tree,
  with nothing failing. There is a test for this case alone.
- **An empty bullet is a real node.** `text` may be the empty string. `index` and
  `depth` only describe a tree if every node of it is present.
- **Absent stays absent.** `properties` is the one optional key: Logseq blocks
  routinely carry none, and whether the importer materialised an empty map or
  omitted the key is not something this lane measured. Requiring it would refuse a
  large population over a difference nobody has looked at, and synthesising an
  empty map would destroy the difference between "no properties" and "the importer
  wrote an empty map".

The schema is **strict**. A passthrough would carry unmeasured keys as well and
read as more lossless, but it would also mean the schema had stopped describing
what the store holds — and the entire value of carrying these now is that a later
pass inherits something it can enumerate. A payload that does not fit is refused
as `unmeasured-block-shape`, counted by name, and left readable in the frozen
replica. Nothing is lost by a refusal; something is lost by a record that silently
holds less than its source did.

**The record names no entity, and that absence is the honest state.** The source
never recorded the link, so a field for it could only be filled by inference — a
content hash, a title match — and inventing that link is precisely the identity
decision this migration is built not to make. It is the same rule that makes the
alias ledger refuse a split rather than nominate a primary.

### 2. It is not published, and that is checked

The kind is declared in the migration package. It appears in no revision under
`packages/atlas-contract/schema/`, and a test walks those files and asserts that
every kind in `UnmodelledRecordKinds` appears in none of them.

The reason is mechanical, not stylistic: **released revisions are immutable, so a
shape published by accident is frozen by accident.** This shape is expected to
change — that is what "provisional" means — and publishing it would put the one
thing we intend to redesign into the one place that cannot be edited.

This carries an obligation onto whoever wires a durable store adapter: a record
whose kind is in `UnmodelledRecordKinds` **MUST NOT** be written into a published
contract shape. `CommitResolution` gains its own `provisional-block` variant
rather than reusing `absence` so an adapter cannot reach the wrong branch by
falling through — and because the two are opposite facts. An absence says content
did NOT come across; this says content came across whole and unmodelled.

### 3. The deferral is a number on every run

Three surfaces, all driven off one declaration (`UnmodelledRecordKinds`), so a
second provisional kind is counted by all three without anyone remembering to:

- `ProjectionBreakdown.unmodelled_records`, recomputed by the closure gate from
  the records like every other row, so the plan cannot assert a deferral it did
  not make;
- an `unmodelled-records` section in the plan report, printed **even at zero** —
  an absent section reads as "not measured", and a zero reads as "this run
  deferred nothing", which is what makes the run where it stops being zero
  noticeable;
- a closure-gate finding, `unmodelled-record-carried`, on every run that carries
  one. This is the surface that cannot be skimmed past: `migration-plan-dryrun`
  prints every finding to stderr with its severity.

The finding is **tolerated**, not a failure. The records are exactly what the
owner asked for, so failing would mean no plan could ever certify, and a gate that
can never pass is a gate somebody removes. This widens `tolerated` from one shape
of problem to two — see the severity documentation in `closure-gate.ts` — and the
second shape is a narrow door on purpose: it is for a deferral the owner decided
in writing, with an ADR naming what was preserved and what a later pass must
decide. A defect the author would rather not fix is not a deferral, and the test
is whether the ADR exists.

Toleration is not approval. It means the finding cannot block a migration on a
decision that has already been made; it still gets counted, named and printed
every single time.

### 4. The closure gate still closes

Blocks move from the refused side of `projected + refused == source` to the
projected side, under their own disposition `projected-as-provisional`. Their own,
rather than one of the existing `projected-as-*` values: those name what an object
BECAME in the ratified vocabulary, and a block became nothing in it. Filing blocks
as `projected-as-entity` would inflate the row an operator reads to see how much
of the knowledge graph arrived.

The category vocabulary gains `outline-block` and `tombstoned-outline-block`. A
deleted block is carried AND retracted, exactly like a deleted node — importing
nothing would turn a recorded deletion into an absence of history, which an
append-only plane must never do.

Two properties are asserted rather than assumed:

- Carrying blocks does not make one a resolvable edge endpoint. A block is not an
  endpoint; an edge naming one still refuses `endpoint-not-projected` rather than
  landing on a record with no type to satisfy the predicate's range.
- The legacy block id now redirects at the carried record instead of answering
  "nothing carried this across". The alias row names no slot, because there is no
  entity to name.

### 5. Pages and attachments do NOT ride along

They stay `narrative-object`, refused `no-typed-target-representation`, counted.

**The rule this follows is that the carry-over is scoped to a shape somebody has
measured.** That is what the namespace check enforces: a block in a namespace this
projector has not measured stays narrative and stays refused, and so does every
page and every attachment. Carrying them would mean either inventing a second
provisional shape from a guess, or making the provisional record an untyped
payload bag — at which point "provisional" stops meaning "we measured it and
deferred the modelling" and starts meaning "we shovelled whatever we found", and
the later modelling pass inherits a heap it cannot enumerate.

Two further reasons, one per shape:

- **A page's content is its blocks**, and the blocks are the thing being carried.
  Each block carries its own `source_path_ref`, so the outline of a page is
  reconstructible from the blocks alone: path, block reference, index and depth
  are the whole tree. What a page object might hold BEYOND that — page-level
  properties in particular — is unmeasured, and is OPEN below.
- **An attachment is a file.** Its content is bytes the store never held, and a
  record carrying "text and properties" would describe a PDF by carrying neither
  of them. Losslessly carrying an attachment means carrying the bytes, which is a
  different piece of work with different size, encryption and tiering questions.

Nothing is lost by either decision. The frozen replica keeps both readable, both
are counted refusals rather than silence, and both can be carried later by exactly
this mechanism once their shape has been measured — which is the point of scoping
the mechanism to a measured namespace rather than to a storage type.

## Consequences

- The store gains a record kind with no published contract. That is the accepted
  risk, stated at the top, and sections 2 and 3 are what it is held to.
- The block population moves out of the refused count. An operator comparing dry
  runs across this change will see the refusal total fall and the projected total
  rise by the same number; `unmodelled-records` says how much of the rise is
  deferral rather than knowledge.
- Anything written into the new store after migration is unprotected until
  new-format backup lands (D-BACKUP). That now includes every carried block, which
  is the bulk of what the new store holds by count. The frozen old store plus its
  verified backup remains the recovery story for the source content.
- The report holds no block text, and neither does any gate finding. Findings name
  idempotency keys, which are opaque and resolve locally — the same rule that made
  the topic findings report slots rather than words. A block's text is the most
  content-bearing thing the plan carries and none of it belongs on a review
  surface.

## What a later modelling pass must decide

These are the questions this ADR deliberately does not answer. They are the
deferral, written down.

- **OPEN-29.1 — What is a block in the ratified vocabulary?** A note-like entity
  in its own right, an attachment to the entity it describes, a source-evidence
  record, or something that stays out of the knowledge graph and lives only as
  searchable text. Nothing here presumes an answer.
- **OPEN-29.2 — Can a block be reattached to the entity it produced, and by what
  evidence?** The link was never recorded. Re-deriving it means re-running the
  importer's own extraction against the carried text and treating the result as a
  proposal with evidence, never as a fact. It must not be inferred from a content
  hash or a title match.
- **OPEN-29.3 — Does the outline structure become graph structure?** `index` and
  `depth` describe a tree per source path. Whether that tree becomes `part-of`
  edges, an ordered attribute, or stays a rendering concern is undecided.
- **OPEN-29.4 — Do page-level properties exist outside blocks?** If a page object
  holds anything the blocks do not already carry, pages need their own provisional
  shape before they can be carried. **Measure this before the next pass**; the
  decision in section 5 rests on the answer being "no" and that has not been
  verified.
- **OPEN-29.5 — Do attachments come across, and as what?** Carrying them
  losslessly means carrying bytes, with its own size, encryption-class and tiering
  questions.
- **OPEN-29.6 — Is the `properties` map required by the importer?** If it always
  writes one, the key should become required and the optionality removed. If it
  does not, the distinction between absent and empty must be preserved by whatever
  models it.
- **OPEN-29.7 — What retires this kind?** A provisional record with no published
  successor and no removal plan is the thing the owner was warned about. Whoever
  models blocks must also say what happens to the carried records: rewritten in
  place, superseded and retracted, or left as the durable source layer beneath the
  modelled one.

## Merge-time amendment: what the durable plane forced

This ADR was written against the in-memory target plane. Wiring the durable
plane (ADR 0030) in the same tree contradicted two things it assumed, because a
durable store's every shape is released and uneditable while a provisional
record's whole point is that it is not.

### A. A legacy block id gets a terminal alias row, not a redirect

The projector originally named the carried block as the legacy id's alias
primary, so the id redirected at the record. `atlas.alias-row:v1` is a RELEASED
shape whose dispositions are a closed set, and a redirect row must name its
target as one of them. That left only two ways to write it, and both are worse
than saying plainly that the published ledger has no word for this:

- add a disposition for provisional targets — which publishes the very kind this
  ADR keeps unpublished, into a revision that can never be edited; or
- file it as `mapped-assertion` — which claims the block became an assertion.

So a block's legacy id now resolves as `no-target` with disposition
`projected-as-provisional` and a detail naming the carry. **Nothing about the
carry-over changed**: the block is still carried verbatim, still counted, still
readable in the frozen replica. What the id does not get is a redirect.

This is also why the change is in the projector rather than in one adapter. The
durable ledger can only store this as a terminal disposition, so a plan that had
promised a redirect would compare unequal to the row that came back and report a
conflict with itself on every resume.

### B. Carried records live in a file of their own, and so do their retractions

`provisional-blocks.jsonl` sits beside the two logs under the target root. Not
in the assertion log, which serialises `atlas.assertion:v1`; not in the identity
log, which serialises `atlas.entity:v1`; and not as an `absence`, which asserts
the opposite fact — that content did NOT come across.

A tombstoned block forced the second half. A retraction is itself an
`atlas.assertion:v1` naming what it supersedes, and the assertion log holds no
record with a carried block's id for it to name — so the published shapes cannot
express "the unmodelled thing over there was deleted" at all. The retraction is
carried beside the block. Dropping it would turn a recorded deletion into an
absence of history, which an append-only plane must never do.

Both are counted separately (`provisional_blocks`, `provisional_retractions`) and
both are reconciled against the plan on every apply. The assertion equation
subtracts retractions that target unmodelled records, resolved through the
records they actually name rather than assumed from a count.

- **OPEN-29.8 — How should a legacy block id resolve once blocks are modelled?**
  The terminal row is honest but it is not a redirect, so a lookup of a block's
  old id cannot follow a pointer to the carried record. Restoring that needs
  either a published record kind for blocks or a ledger disposition that can name
  an unpublished target. Both are modelling decisions, and modelling is what this
  ADR defers.
- **OPEN-29.9 — A legacy redirect that resolves to a block now refuses.** With no
  alias primary, a redirect chain ending at a block reports `endpoint-not-projected`
  rather than inheriting the block's target. On the fixtures no chain ends at a
  block; whether any does in the real corpus is unmeasured.
