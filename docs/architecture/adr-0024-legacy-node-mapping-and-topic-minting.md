# ADR 0024: Legacy Node Mapping and Topic Minting

Status: Accepted for implementation
Date: 2026-08-05

## Context

ADR-0023 deleted seven of the eight subtype enums and moved classification onto
`has-type`, a predicate pointing at a `topic` node. That decision describes the
target vocabulary. It does not describe how the legacy corpus — which is written
entirely in the retired vocabulary — gets there.

The gap is not cosmetic. The endpoint schemas published in revision 2026.08.1 are
`.strict()` and seven of them carry no `subtype` key at all, so a legacy payload
reading `{type: "organization", subtype: "airline"}` is **refused** by the
contract, not merely ignored. Before this change every classified node in the
corpus would have been refused as `invalid-legacy-payload` and the migration
could not have run.

Two properties of the corpus, measured on the real graph, drive the design:

- The legacy occurrence vocabulary is a **closed** set of about ten words that
  collapse onto four survivors, and the travel legs were filed as `item` rather
  than as occurrences at all. Getting one of those wrong moves a node into a type
  whose edges mean something else, and nothing downstream can detect it.
- The legacy organization and location vocabularies were never closed — the modal
  organization value was `other`. Enumerating them would move the residue from a
  subtype slot into a mapping table without removing it.

## Decision

### 1. Two mapping rules, split by whether the TYPE changes

**Rule A — retype.** A closed, enumerated table (`RetypeRules` in
`packages/atlas-migrate/src/legacy-vocabulary.ts`) covering exactly the legacy
values that change a node's type: the five travel `item` words that become
`occurrence/segment`, and the legacy occurrence words that collapse onto
`segment | trip | stay | meeting`.

Rule A **refuses** a value it does not name. It never falls through to a default.
`meeting` is the modal occurrence target, so a default would look like a
successful mapping while filing an unknown word under the most common word —
which is `other` wearing a better name. The refusal is a named reason,
`unmapped-legacy-subtype`, and it is counted.

**Rule B — classify.** Every other legacy subtype value becomes a `has-type`
topic and the node keeps its type. Open by design, for the reason the enums were
deleted: a vocabulary that was never closed at the source cannot be closed by a
table downstream of it.

Rule A is consulted first. Reversing the order would let an unknown occurrence
word become a `has-type` topic on a node with no subtype — a node that satisfies
every schema check while having lost the field that says what kind of event it
was.

**Rule A is total over `occurrence`, not over `item`,** and reading it as total
over both is a defect this ADR originally invited. `occurrence` refuses an
unnamed word because its subtype is REQUIRED and Rule B would leave the node
without one. `item` carries no subtype at all, so an unnamed item word means
nothing more than "this item is not a travel leg" — it stays an item and the word
becomes a topic, exactly as it would for an organization. Refusing instead read
"this type has some enumerated retypes" as "this type must be retyped", and
refused every non-travel item in the corpus: a device, a document, a ticket, each
taking its `owns` edge down one hop later as `endpoint-not-projected`. An `item`
with no subtype at all is likewise an unclassified item, not a refusal.

### 2. Each Rule A row states its own disposition

A retype row does not only say where the node goes; it says what happens to the
word. Three dispositions, and the distinction is the reviewable part:

| disposition | meaning | examples |
|---|---|---|
| `topic` | the word says something the surviving subtype does not, so it survives as a topic node | `meal`, `social`, `incident`, `hotel-stay` → `hotel` |
| `absorbed` | the word is a second label for the survivor, so it mints nothing | `travel` → `trip`; `trip`, `stay`, `meeting` |
| `vacuous` | the word classifies nothing | `other`, `event` |

`other` is deliberately `vacuous`. Minting a controlled-vocabulary topic node
called `other` would rebuild the exact residue that deleting the enums removed.
`event` is `vacuous` because it is the superclass of every occurrence: a topic
true of every occurrence in the corpus partitions nothing.

Values that mint nothing are printed in the mapping report with their basis. A
word that vanishes from the report vanishes from the review.

### 3. One topic node per VALUE, minted from the value

A minted topic's slot and idempotency key are derived from the normalised value
(`mintedTopicSlot`, `mintedTopicIdempotencyKey`). This is the one place a
content-derived identity is correct — the topic node's whole identity IS the
word — and it buys two properties at once:

- **Reuse within a run.** Nine organizations that each said `airline` resolve to
  one node. Nine nodes would leave nine unrelated concepts sharing a spelling,
  and merging them afterwards would be an identity decision with no evidence.
- **Idempotence across runs.** A second projection over the same source resolves
  to the same slot instead of minting a tenth.

Normalisation is case-folding and trimming only. Collapsing `car-rental` and
`car rental` is a judgement about synonymy that belongs to a curator.

The topic node's `name` is the legacy word verbatim. A migration that renames the
vocabulary it carries makes the old corpus unsearchable by the words it was
written with.

### 4. Two new record kinds, because provenance must not be invented

`minted-entity` carries **no** `provenance`, and that absence is load-bearing.
Every other projected record can name the legacy object it came from; a topic
node genuinely cannot, because every carrier of the value asked for it. Filling
the field with the first contributor's id would make an arbitrary choice look
like a recorded fact.

`minted-relationship` — the `has-type` edge — *does* carry provenance, because
the classification was written down on that node in its subtype slot. What it
lacks is a `legacy_edge_id`: the legacy store held no edge here, so the field is
absent rather than fabricated. Its `valid_from` is `unknown` with fidelity
`unknown`, because a subtype string carried no time and stamping the import date
would assert that the organization became an airline the day we ran the
migration.

### 5. Minted records are owned by the PLAN, checked at that level

The closure gate requires every record to be claimed by exactly one source
outcome. A minted topic cannot satisfy that — it is shared. Rather than weaken
the rule, the plan carries `minted_record_keys` and two new gate findings:

- `minted-record-not-accounted` — a minted record the plan does not claim, or a
  claim naming no record.
- `duplicate-minted-topic` — two nodes minted for one value. This is the
  permanent control on the property the whole change turns on, independent of
  whatever produced the plan.

`checkEndpointsResolve` now resolves relationship endpoints against **every**
slot the plan puts into the plane, minted or imported. A gate that knew only
about imported entities would report every `has-type` edge as dangling.

### 6. Endpoints and modes are reported, never synthesised

Travel-leg endpoints arrive in three disjoint and incomplete shapes: some legs
carry `route`, some carry `origin`/`destination`, and the largest group carries
neither. `readTravelEndpoints` reports what is there and adds nothing. A fourth
answer, `partial`, exists so a leg that knows where it started and not where it
ended is not folded into either neighbour.

An invented endpoint is indistinguishable from a recorded one the moment it
lands. A segment with no origin is a segment whose origin we do not know, and the
record says so.

The mode of travel stays an attribute: it is not re-encoded as a subtype and not
minted as a topic. It is one fact, and putting it in two places lets them
disagree.

### 7. The participant backfill fills holes only

An occurrence with `participant_refs` and **no** subtype is a meeting. An
occurrence that recorded a subtype keeps it. A backfill that outranks recorded
data is a second classifier competing with the ratified table, and the two will
disagree silently.

## Consequences

- The migration can read the legacy vocabulary. Before this change it could not.
- The strict contract path is tried **first** and unchanged, so every payload
  that parsed before parses identically now. The legacy mapper only sees payloads
  the contract refuses; it never relaxes a rule the contract enforces on the same
  shape.
- `packages/atlas-migrate/src/legacy-vocabulary-fixture.ts` is a second fixture
  that still speaks the retired vocabulary. Its counts are **invented** and do not
  mirror the owner's corpus; a public repository is not a place to record how many
  of anything a private graph holds.

## What is NOT decided here

- **OPEN-14 — `mode`, `route`, `origin` and `destination` have no home.** The
  ratified table says the mode of travel stays an attribute. The 2026.08.1
  occurrence endpoint is `.strict()` and has no key for one, nor for a route or an
  origin. Both statements cannot be satisfied today. They are therefore reported
  rather than dropped, and rather than widening a frozen revision from inside a
  migration. This needs a contract change, and it is the same sequencing problem
  as OPEN-11.
- **OPEN-15 — `event` and `other` mint no topic.** Recorded as a table row with a
  stated basis rather than as a silent omission. If the owner disagrees, the
  change is one field per row.
- **OPEN-16 — a `participant_refs` occurrence whose recorded subtype maps to
  something other than `meeting`.** The table governs and the backfill does not
  fire. This is a rare shape, and the recorded word wins wherever it appears.
- **Venue splitting (D3).** `operated-by` and the minting of organizations for
  venue locations are a different change and are not implemented here. Only topic
  nodes are minted today, though `minted-entity` carries the full endpoint-type
  enum so that lane does not have to widen it invisibly.
- **Attribute valid time (D4 / OPEN-11).** Untouched, as in ADR-0023.

## Amended when the parallel lanes were merged

Two lanes independently built a subtype classifier. This one maps the legacy word
through the ratified retype table and mints a `minted-entity` topic; ADR 0026's
derived-node registry read the raw `subtype` string and minted an ordinary entity
with derived provenance. Both were correct alone and neither fixture could see the
other, so together they minted **two topic nodes for one concept** — the precise
failure a controlled vocabulary exists to prevent.

Resolved in favour of this ADR's classifier, because it normalises the value (so
`Airline` and `airline` are one node) and honours the table's `absorbed` and
`vacuous` dispositions (so no node is minted for `other`). The registry keeps the
counterparty and job-title namespaces, which this ADR never claimed.

One behaviour changed as a result: the `has-type` edge is now emitted from **every**
entity a draft produced, not from the primary alone, so both halves of ADR 0026's
venue split are classified. Its idempotency key therefore names the classified
entity's slot; keyed by legacy object alone, a split venue's two edges would have
collided and the second would have been dropped as a replay of the first.

## Amended after review: the mapper's findings reach the plan

Sections 6 and 7 above described `mapLegacyNode` faithfully and stopped there.
`resolveLegacyEntity` kept only the type, the subtype, the name, the aliases,
the description and the topics; `unplaced_attributes`, `travel_endpoints` and
the hand-review flag were computed and then discarded, and
`buildLegacyNodeMappingReport` — the only thing that reads them — has no
production caller. So the mode of every travel leg, every route, every origin,
and both `project` nodes the table declined to decide left the migration with no
row, no count and no trace: the exact silent drop the mapper's own comment says
it exists to prevent, one layer further down.

They now travel out of the mapper into `plan.hand_review`, under two reasons
that are deliberately not the existing ones:

- `no-contract-slot` — the ratified table keeps the value and the frozen
  endpoint revision declares no key for it. Distinct from `unplaced-attribute`,
  which means the projector had a slot and could not choose; the remedy here is a
  contract change, and merging the two would hide the contract gap inside the
  curator's queue.
- `ratified-table-declined` — `project/tool` and `project/product`. The node
  still projects; the decline is a question for a human, not a refusal.

A leg that arrived with **no** endpoint data queues no row, because it holds no
attribute to re-home. Its absence is counted instead, by
`breakdown.travel_endpoint_coverage`, which the closure gate reconstructs from
the records and the queue rather than trusting the plan's copy. That row is the
control on the rule that nothing is synthesised: gate G3 measured the shapes
disjoint and incomplete, and a `none` count that fell to zero would mean a leg
had been given an origin nobody recorded. The plan report prints both aggregates
above the per-object rows, because a queue of hundreds of rows is not a number
anybody checks.
