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
  collapse onto four survivors, and 323 travel legs were filed as `item` rather
  than as occurrences at all. Getting one of those wrong moves a node into a type
  whose edges mean something else, and nothing downstream can detect it.
- The legacy organization and location vocabularies were never closed — 370 of
  470 organizations sat in `other`. Enumerating them would move the residue from
  a subtype slot into a mapping table without removing it.

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
  origin. Both statements cannot be satisfied today. The mapper therefore reports
  them as `attributes_without_a_contract_slot` rather than dropping them or
  widening a frozen revision from inside a migration. This needs a contract
  change, and it is the same sequencing problem as OPEN-11.
- **OPEN-15 — `event` and `other` mint no topic.** Recorded as a table row with a
  stated basis rather than as a silent omission. If the owner disagrees, the
  change is one field per row.
- **OPEN-16 — a `participant_refs` occurrence whose recorded subtype maps to
  something other than `meeting`.** The table governs and the backfill does not
  fire. Measured on the real graph this affects a single node, whose recorded word
  sends it to `trip`.
- **Venue splitting (D3).** `operated-by` and the minting of organizations for
  venue locations are a different change and are not implemented here. Only topic
  nodes are minted today, though `minted-entity` carries the full endpoint-type
  enum so that lane does not have to widen it invisibly.
- **Attribute valid time (D4 / OPEN-11).** Untouched, as in ADR-0023.
