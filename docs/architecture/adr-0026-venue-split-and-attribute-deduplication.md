# ADR 0026: The Venue Split and Attribute Deduplication

Status: Accepted for implementation
Date: 2026-08-05

## Context

ADR-0023 ratified the graph vocabulary: seven subtype enums deleted,
classification moved to a `has-type` edge pointing at a `topic` node, and 25
predicates each carrying an enforced domain rule. That ADR changed what the
target plane *accepts*. It did not change what the migration *reads*, and the two
had drifted apart in a way that would have been fatal on the real corpus.

`buildProjectionPlan` parsed legacy entity payloads with `EndpointRecordSchema` —
the target vocabulary, which is `.strict()` and now refuses a `subtype` key on
seven of the eight endpoint types. A real legacy record carries retired subtypes
(`restaurant`, `airline`, `law-firm`) and retired attributes (`provider`,
`company_current`, `job_title`). Every one of them would have parsed as
`invalid-legacy-payload` and been refused. The closure gate would have passed:
every object accounted for, every refusal carrying a named reason, arithmetic
balanced. The migration would have reported a clean run having carried across
almost nothing. **A refusal that lands on 100% of the corpus is not a safety
property, it is a bug wearing one.**

Two further problems were settled by measurement rather than argument:

- Gate **G6** found venue locations (restaurants and hotels) and **none** with
  a same-named organization. A venue row is one node standing for two things — a
  place and a business — and nothing in the graph could express the difference.
- Gate **G8** found `provider` and `airline` **perfectly disjoint**: no object
  carries both. They are one attribute under two names.

## Decision

### 1. The legacy plane gets its own schema

`LegacyEndpointPayloadSchema` models what the old store actually wrote. It is a
deliberate **superset** of the target vocabulary, so one projector reads both a
modern export and a real legacy one. `subtype` is a free string rather than an
enum: the legacy values are exactly the set nobody can enumerate in advance, and
refusing an unrecognised one would refuse the node that carried it.

The one place this does *not* apply is `occurrence.subtype`, the single subtype
the vocabulary kept. A legacy value outside the four is refused rather than
guessed at, because the item/occurrence retype table belongs to a separate lane
and a projector that quietly invented a mapping would make that lane's decisions
unreviewable.

### 2. A venue becomes two nodes joined by `operated-by`

A `location` whose legacy subtype is `restaurant` or `hotel` projects as **two**
entity records — the location it already is, plus a newly minted organization —
joined by `operated-by` (location → organization). Both carry `has-type` to the
same topic node. G6 is why every one is minted rather than reconciled: there was
no organization to merge with, so `operated-by` launches with zero existing
warrant by design.

**Which node inherits which attribute** is decided by whose property it is, and
the test is what survives change. A restaurant that moves premises is the same
business at a different place, so:

| Attribute | Node | Why |
|---|---|---|
| `geo`, `timezone` | location | properties of the place |
| `founded_year`, `homepage_ref` | organization | properties of the business |
| `name`, `aliases`, `description` | **both** | one name genuinely belongs to both |

Nothing except the name is duplicated, so there is no second copy to drift. The
shared name is not an oversight — it is the reason the old id is ambiguous.

**Which node existing edges point at** is decided by the edge itself: an edge
carries a declared endpoint TYPE, and that type selects the node of that type.
The `occurred-at` edge that said `location` lands on the place; an edge that said
`organization` would land on the business. Nothing is guessed and "both" is never
needed. For an object that did not split, this is the type check the projector
already performed, and the `endpoint-type-mismatch` refusal is unchanged.

### 3. The old id resolves to an ambiguous split, not a winner

The alias row for a split legacy id is `ambiguous-split`, listing both candidates
with **no primary**, mirroring the entity registry's own split path. Nominating
one would silently reattribute every historical reference to it, which is the
failure ADR-0007 rejects.

This is not in tension with edges routing deterministically. An edge declares a
type and therefore says which half it meant. A bare id does not, and inventing a
discriminator it never had is the guess. A redirect chain that lands on a split
inherits the ambiguity rather than resolving past it.

### 4. Attributes become edges

| Legacy attribute | Becomes | Note |
|---|---|---|
| `subtype` | `has-type` → topic | every retired enum value |
| `parent_location_ref` | `contained-in` | the ladder an attribute held one rung of |
| `provider` + `airline` | `offered-by` → organization | merged on G8 |
| `merchant` | `sold-by` → organization | |
| `participant_refs` + `organizer_refs` | `participant-in` | organizer via `attrs.role` |
| `company_current` | `employed-by` | backfilled, then dropped |
| `job_title` | `attrs.role` on `employed-by` | or `has-type` when there is no employer |
| `date`, `occurred_on`, `purchase_date` | one `occurred_on` | attribute, not an edge |

An attribute that became an edge is **not** also kept on the node. Keeping both
would state one fact in two mechanisms that can disagree.

`company_current` is deleted by construction — the target person schema has no
such field — so the only question is whether the fact survives. Backfilling first
is what makes the deletion lossless. The organization is **minted from the name
and deliberately not matched** against a same-named legacy organization: matching
would be an identity decision taken on a string, which is the `id = hash(title)`
shortcut that merged two different people in the old store. A curator can merge
them later through the alias ledger, where the decision carries evidence.

`job_title` has three populations and three answers: exactly one employer, and it
lands on that edge; no employer, and it is an occupation, which is a
classification and therefore a topic; more than one, and choosing would attach a
real job to a possibly wrong employer, so it goes to a human.

### 5. Minted nodes carry derived provenance

A topic node for `restaurant` exists because many objects carried that word.
There is no single legacy object behind it, and handing it the provenance of the
first contributor — the shortcut that fits the existing schema unchanged — would
attach that object's `legacy_version` and `legacy_content_hash` to a node it does
not describe. `DerivedProvenance` instead names the attribute, the value, and how
many objects carried it. The count is an aggregate and never the ids.

The closure gate reads this off the record: a record projected from a legacy
object must be claimed by exactly one outcome, and a **minted node by none**. A
minted node appearing in some object's `record_keys` would make one arbitrary
contributor the owner of a node shared by hundreds.

### 6. A relationship names its source, always

`ProjectedRelationshipRecordSchema` requires **exactly one** of `legacy_edge_id`
and `derivation`. An edge either came across from a row the old store wrote or
was computed from an attribute, and an auditor must be able to tell which without
guessing, because only one of them has a source row to go back to.

Derived edges carry `valid_from: "unknown"`. The attribute they came from carried
no validity, and synthesising one from a neighbouring field would manufacture a
fact that reads exactly like a recorded one.

### 7. Hand review: neither a refusal nor silence

An attribute the projector cannot place mechanically produces a `hand_review`
row naming the object and the attribute — never the value, because the plan is
written to whatever directory a dry run is reviewed in. It is not a refusal: the
object still projects, and refusing it would throw away a whole node over one
field. It is not silence either, which is what an unplaced attribute would
otherwise be, since the target schema simply has no field to drop it into.

Attribute conflicts (`provider` vs `airline`, or three date names disagreeing)
are hand-review rows for the same reason: an attribute-level problem gets an
attribute-level outcome, and neither value wins.

## Consequences

- The projector reads the real legacy shape. The migration can be dry-run against
  an actual export rather than only against a fixture in the new vocabulary.
- An organization is minted per venue that did not exist. They are new nodes, not
  discovered ones, and the plan reports them as such.
- A consumer holding a venue's legacy id gets a refusal it can act on rather than
  a redirect that quietly picked a half.
- Names are duplicated across each split pair. This is intended and is the
  visible trace of the ambiguity.
- Minted counterparty organizations may duplicate same-named legacy ones. This is
  deliberate under-merging: a false merge is unrecoverable, a duplicate is not.

## What is NOT decided here

- **OPEN-11 (attribute valid time, D4)** remains sequenced separately. This lane
  touched no attribute's time axis; `maiden_name`, `birth_year`/`birthday` and
  `founded_year`/`founded` are all left in place, uncollapsed. Collapsing them
  now would lose the earlier value. Every derived edge's `unknown` world time is
  the shape of that gap.
- **OPEN-14: whether a subtype topic and an occupation topic with the same word
  are one node.** They are kept apart today — `subtype: "consultant"` and
  `job_title: "consultant"` mint two topics — because merging them would be an
  identity decision made on a string match. A curator may merge them with
  evidence; the migration will not. **RESOLVED:** they are two concepts in two
  concept schemes, not a duplicate. The migration does not merge them and the
  gate reports them as a tolerated cross-scheme homonym rather than refusing to
  certify. See "OPEN-14 RESOLVED" below.
- **OPEN-15: the item/occurrence retype table** (rideshare and flight to
  `segment`, meal and incident to `meeting`) is not implemented here. An
  occurrence carrying a legacy subtype outside the four new values is refused
  with a reason naming that lane.
- Whether minted counterparty organizations should later be reconciled against
  legacy organizations of the same name, and by what evidence.

## Amended when the parallel lanes were merged

**OPEN-15 is closed.** The retype table landed in ADR 0024, and the projector now
maps every entity payload through it. An occurrence carrying a legacy subtype
outside the four ratified values is retyped rather than refused.

Closing it exposed a gap in that table, fixed here: a node whose subtype is
*already* one of the four ratified values has no retype rule — the table maps
legacy words onto ratified ones, so a ratified word is simply absent from it — and
was being refused for being correct. It is now an identity mapping. This was
reachable only after the merge, because the projector previously tried the strict
contract schema first, which caught the already-ratified case for payloads
carrying no legacy attributes: on a real corpus, almost none of them.

**The subtype namespace lost its classifier here.** `deriveAttributeEdges` no
longer reads the raw `subtype` word; ADR 0024's table-driven, normalised classifier
owns it, and this ADR's derived-node registry keeps the counterparty and job-title
namespaces. See ADR 0024's amendment for why. Subtype topics are therefore
`minted-entity` records rather than derived entities, and the tests that asserted
on their derived provenance now assert on `minted_basis` and
`classified_node_count`, which carry the same two facts: the value, and how many
legacy nodes asked for it.

## Amended after review: one slot per word, checked across every mechanism

The `duplicate-minted-topic` guard read `minted_basis.legacy_value` off
`minted-entity` records alone. Two of those holding one value share a slot **and**
an idempotency key, so `duplicate-idempotency-key` fires first — the duplicate
branch was unreachable in practice, and the guard could see none of the three ways
a plan can actually put two nodes on one word:

1. the subtype classifier mints one (`minted-entity`),
2. the derived-node registry creates one per occupation under the `job_title`
   namespace (an ordinary `entity` with derived provenance),
3. the corpus itself may already hold a legacy `topic` node with that name.

The gate now keys on the normalised NAME across every topic-typed record the plan
creates, whatever produced it. Case 3 is the one nobody had considered: minting
`aviation` beside a legacy topic node named `Aviation` splits one concept in two,
and nothing in the plan is malformed, so no other check would ever have said so.

**This fires on the OPEN-14 pair, and that is the decision.** OPEN-14 settled that
the migration will not MERGE a subtype topic and an occupation topic on a string
match. It did not settle that a plan holding both should be certified for apply
unexamined — and `applyProjectionPlan` refuses a failing gate, so certification is
exactly the question. The operator sees the collision on the dry run, which is
when curating one of the words is still cheap; the remedy is to curate the source
word, not to widen the gate.

The finding's subjects are the colliding SLOTS and never the word. Naming the
words helps an operator curate, and it also put personal graph content into an
artifact whose own contract is ids, types and counts — the first real-data run
put a private topic name into the report file and onto the terminal. Slots are
opaque and resolve to their words on the machine that already holds the graph, so
nothing is lost that the operator cannot recover locally.

- **OPEN-19. There is no mechanism to accept a collision and proceed.** The gate
  has no acknowledgement flag, by design — an exemption is a hole the size of
  whatever it exempts. If the corpus turns out to hold collisions that are
  genuinely two concepts, the answer is a curation step before apply, and giving
  that step a record is its own change. **Amended below:** one class of collision
  is now tolerated by CODE rather than by exemption, which is a different
  mechanism and not an acknowledgement flag.

## Amended after the first real-data dry run: two duplicates, two answers

The dry run produced exactly two topic collisions and they were different kinds
of problem, which the single `duplicate-minted-topic` code could not express:

- one was a topic node this migration MINTED beside a legacy topic node for the
  same concept — a defect in the migration, now impossible by construction (see
  ADR 0024's amendment: a classification resolves before it mints);
- the other was two legacy `topic` nodes the corpus itself already held under one
  name, neither of them minted by anything.

The second is not a migration defect. The owner has decided it: both nodes come
across, both legacy ids stay resolvable through the alias ledger, and the two are
merged later inside Atlas through the existing entity-merge path, where the
decision carries evidence and a record. Migration correctness and data cleanup
are separate jobs. Failing the gate on it would block the migration permanently
on a condition no re-run can change, and merging or dropping one of the two would
be the migration making an identity decision on a string match — the move ADR
0012 exists to prevent.

So a finding now carries a **severity**, and `ClosureGateResult.ok` turns on the
failures rather than on the finding count:

- `duplicate-minted-topic` — **failure**. At least one colliding slot belongs to a
  record this migration created. Nothing in the corpus asked for two nodes.
- `duplicate-source-topic` — **tolerated**. Every colliding slot belongs to a
  topic projected from a legacy object. Counted, named and printed on every run;
  it does not stop the plan certifying.

They are separate CODES rather than one code with a note in the detail, so a
regression that starts minting duplicates again cannot hide inside the tolerated
bucket — it arrives under a code whose severity is `failure`, and no plan
carrying that certifies. The severity is a property of the code, declared in one
`Record` over the code union: a new code fails to compile until somebody decides
whether it blocks a migration, and one code can never be filed at two severities.

This is not OPEN-19's acknowledgement flag and does not reopen it. There is still
no per-subject exemption, no suppression list and no way to mark a particular
collision as accepted; a code is tolerated or it is not, and the population it
covers is defined by what the records ARE rather than by anything an operator can
edit. The subjects stay slots for the tolerated finding exactly as for the
failing one — a duplicate the owner has accepted is still a private topic name.

## Amended after the collision was misread: the finding names its mechanism

The dry run reported two colliding slots and the pair was read as "the migration
minted a node beside one the corpus already held". It was not: it was an
occupation topic beside a subtype topic — the OPEN-14 pair — and neither node came
from the corpus. A round of work went into looking for a reuse bug that did not
exist, because the finding named only slots and the plan has three mechanisms that
can produce a topic node.

Both topic findings now carry a per-mechanism count:
`projected-from-corpus`, `minted-from-subtype`, `derived-from-<attribute>`.
`projected-from-corpus` is printed even at zero, because a zero is the fact that
says reuse had nothing to resolve onto, and an absent count reads as unmeasured.

A mechanism name is a namespace or a record kind — a fact about the software, not
about the graph — so this stays inside the ids-types-and-counts contract that keeps
the subjects opaque. **A finding that cannot be acted on without a second, manual
probe is a finding that will be guessed at instead.**

### The occupation namespace was keying on the raw value

Found while reproducing the above: `DerivedNodeRegistry` keyed a minted node on the
value exactly as written, so two people whose `job_title` differed only in case
minted **two** occupation topics for one occupation. That is a duplicate inside a
single namespace — no cross-namespace judgement involved, nothing OPEN-14 excuses —
and it failed the gate like any other duplicate this migration creates.

Topic-typed derived nodes now take the same canonical key every other topic takes.
Organization-typed ones deliberately do NOT: a counterparty's name is an identity
rather than a vocabulary word, and folding two companies together on case would be
the identity-on-a-string-match decision this namespace exists to refuse — the same
rule that stops it matching a minted organization onto a same-named legacy one.

### OPEN-14 is now the decision that blocks real-data certification

With reuse landing and the occupation namespace deduplicated, the remaining
`duplicate-minted-topic` on the real corpus is the OPEN-14 pair itself: one word
held by a person's `job_title` and by an organization's retired `subtype`. The
migration keeps them apart, the gate refuses to certify a plan holding both, and
those two positions together mean the corpus cannot be applied until the owner
either curates one of the words or reverses OPEN-14. That is a decision with
evidence behind it now — the count is visible on every dry run, by mechanism —
and it is the owner's to make rather than the migration's.

## OPEN-14 RESOLVED: topics carry a concept scheme

**The owner ruled: do not merge.** A person IS an investor and a firm IS an
investment firm. One word, two things, and merging them would force the word onto
both. Nor will the frozen legacy store be edited to make the clash go away.

The resolution is not a merge and not an exemption. It is that **the topic set was
never one vocabulary**, and the model said so all along: ADR 0023 cites SKOS and
calls the topic node set Atlas's Concept Scheme — but SKOS is not one flat scheme.
`skos:ConceptScheme` exists precisely so two concepts can share a label without
being duplicates, because label uniqueness is scoped PER SCHEME rather than
globally. Three schemes were being flattened into one namespace, and the label
clash that follows from flattening them was read as a defect.

**Every topic record now names its scheme**, derived from the mechanism that
produced it and never hand-authored:

| scheme | produced by | what it is |
| --- | --- | --- |
| `subject-matter` | a `topic` node the corpus holds | what `about` edges point at |
| `occupation` | a person's `job_title` | what somebody does |
| `entity-kind` | a retired subtype value | what `has-type` points at |

The enum is CLOSED and carries the reserved `other`, which the gate refuses to
certify. An open string would let a fourth mechanism coin a scheme at the call
site, and a vocabulary whose schemes can be invented in passing is not a
controlled vocabulary. `other` is the trip-wire that makes the fourth mechanism
somebody's decision instead of an accident.

**Identity is `(scheme, canonical word)`.** The normalisation rule and its stated
exclusions are unchanged. Reuse fires WITHIN a scheme — nine organizations saying
`airline` still reach one node — and never across one. The scheme is in the seed
of both the slot and the idempotency key, so two schemes minting one word can
never collide on either; that is defensive today, because only `entity-kind`
mints through those functions, and it is pinned by its own test rather than left
as an accident of there being one caller.

**The gate splits three ways**, by code rather than by prose:

- `duplicate-minted-topic` — same scheme, at least one node minted by the
  migration. **Failure**, unchanged. Label uniqueness within a scheme is what
  makes the scheme controlled.
- `duplicate-source-topic` — same scheme, both from the corpus. **Tolerated**,
  unchanged. The owner's accepted pair.
- `cross-scheme-topic-homonym` — one word, more than one scheme. **Tolerated**,
  and reported: two schemes reaching for one word may still be one concept a
  curator wants to unify, and an unreported homonym is one nobody can choose
  about. Reported is not the same as wrong.

Every one of the three carries a per-scheme and per-mechanism count, so no reader
has to parse prose to tell a defect from a legitimate homonym.

### What this costs, stated plainly

Scheme scoping retired the corpus-topic REUSE added a round earlier, along with
its alias-awareness and its name-over-alias precedence. A classification landing
on a corpus topic spelled the same is the same forced merge the owner just
rejected — the corpus's node is a `subject-matter` concept, and asserting it is
also the entity kind is an identity decision on a string. Letting a corpus node
absorb both minted schemes would additionally make it a merge point through which
`occupation` and `entity-kind` become one node, which is the ruling undone by the
back door. Measured impact on the real corpus is nil: reuse fired zero times
there, because no corpus topic name equals a retired subtype word.

If corpus reuse is ever wanted back, the principled route is EVIDENCE rather than
spelling: a corpus topic could claim `entity-kind` when the corpus itself already
points a `has-type` edge at it, because that is the owner's own usage rather than
a guess. Recorded as an option, not built.

**The same-scheme corpus pair is unaffected.** Two `subject-matter` topics the
corpus holds under one name remain a tolerated `duplicate-source-topic`, and the
migration still carries both across with both ids resolvable.
