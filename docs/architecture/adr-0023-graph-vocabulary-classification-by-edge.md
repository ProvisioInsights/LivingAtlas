# ADR 0023: Classification Moves From Subtype Enums Onto `has-type` Edges, And Predicates Get Enforced Domain Rules

Status: Accepted for implementation
Date: 2026-08-05

## Context

The graph vocabulary had eight endpoint types, each with its own closed subtype
enum, and thirty-seven predicates. Measured against the corpus it was supposed to
describe, both halves had failed in the same way: they had stopped
discriminating.

**The subtype enums did not classify.** `organization` declared ten values and put
370 of its 470 nodes in `other`, with a further 27 carrying none. `project`
declared seven values, and *all seven* had zero uses — every project that carried
a subtype at all carried a value nobody had declared. An enum whose modal value is
`other` is not a classification: it is a slot that answers every question
plausibly and wrongly, which is strictly worse than answering nothing. Renaming
`other` to `null` would have changed the spelling of the failure and nothing else.

**One slot could not hold two axes.** An organization has a legal form (company,
nonprofit, government) and a line of business (airline, law firm, university), and
the undeclared values that had drifted into the slot were a mixture of both —
activity words such as `airline` and `law-firm` sitting beside legal-form words
such as `company` and `nonprofit`. Whichever axis a curator chose, the other
became unrecordable. The same collision
appears in `offering`, where schema.org itself files software under three
different branches, so borrowing `product`/`service` would have imported an
unresolved ambiguity into a 24-node type.

**Several predicates were one predicate.** `board-member-of` (27), `advises` (15)
and `alumnus-of` (6) are all `member-of` with a different role. Keeping them apart
meant three query paths for one question, and a consumer that asked only one of
them got a confidently incomplete answer.

**Domain rules existed only in prose.** `based-in` accepted `person -> location`,
`organization -> location` *and* — as far as the schema was concerned — the
inverse. "Where is this organization based" and "who runs this place" were the
same edge with the endpoints swapped, and nothing in code could tell a consumer
which one it was holding. The same permissiveness let `owns` take an occurrence as
its target, which is how 323 travel segments came to be things a person owns
rather than things a person did.

## Decision

### 1. Seven subtype enums are deleted. `occurrence` keeps one, and it is total

The rule that decides whether a subtype enum survives, stated once so it can be
applied again:

> An enum earns its slot only if **both** hold: (a) the value changes which
> attributes and edges the node carries, and (b) the enum can be made **TOTAL** —
> every node of that type receives a real value during migration, with no residual
> `other`.

`person`, `organization`, `project`, `location`, `topic`, `offering` and `item`
fail (b), and `organization` and `offering` also fail (a) by needing two axes at
once. They carry no `subtype` key at all, and because the endpoint schemas are
strict, a payload that still sends one is refused rather than ignored. That
refusal is the point: a caller sending `subtype: "company"` believes it has
classified something, and failing is the only way to tell it otherwise.

`occurrence` keeps four values and they cover its corpus with no residue:
`segment` (323), `trip` (29), `stay` (40), `meeting` (72). `segment` is the only
new subtype word in the whole vocabulary. The subtype is **required and has no
default**: `other` is gone, so any default would file an occurrence whose author
did not choose under a word nobody chose, which is exactly what `other` did.

`meeting` is deliberately the residual value. Meal, conference, event, social and
incident are all "people were somewhere at a time", and the previous draft's
instinct to keep `meeting` (4 nodes) while discarding ~32 structurally identical
records into `other` had the discrimination backwards.

### 2. Classification becomes `has-type`, a predicate pointing at a `topic` node

Every retired enum value becomes a `topic` node reachable by `has-type`: airline,
car-rental, law-firm, university, threat-actor, restaurant, hotel, city, state,
country, software, meal, incident, and the rest.

Three properties follow immediately, and they are why this is better than the enum
rather than merely different:

- values are **identity-checked nodes**, not strings, so two spellings of one
  concept are a merge rather than two facts;
- `has-type` is **multi-valued**, so a state university is `has-type` government
  AND `has-type` university — the two-axis collision disappears instead of being
  adjudicated;
- it is **bitemporal like any other edge**, so a company that changes its line of
  business is expressible rather than overwritten.

The prior art is uniform across four independent modelling traditions, which is
the strongest available evidence that this is the shape of the problem and not a
local preference:

| source | mechanism |
|---|---|
| CIDOC-CRM | `P2 has type` → `E55 Type`, described as the general mechanism to specialise classification "to any level of detail" by linking to external vocabularies; an `E55 Type` is a *concept*, explicitly contrasted with `E41 Appellation`, a name |
| SKOS | one `skos:Concept` class — "an idea or notion; a unit of thought" — identified by URI, with hierarchy carried by `skos:broader`/`skos:narrower` rather than by subclassing |
| W3C ORG / RegOrg | `org:classification`, with `rov:orgType`, `rov:orgStatus` and `rov:orgActivity` as sub-properties, and the guidance that organisational activity be recorded with a controlled vocabulary expressed as SKOS concept schemes |
| schema.org | `additionalType`, "a relationship between something and a class that the thing is in", with text values permitted only *sparingly* — the class is the mechanism, text is the exception |

W3C ORG supplies the second half of the pattern too: `org:Membership` with a
`org:role`, which is how one membership predicate carries many kinds of member
without one predicate per kind.

**The disambiguation rule**, which the contract document publishes verbatim:

> **`has-type` says what the subject IS. `about` says what the subject is
> CONCERNED WITH.**

Both point at `topic` nodes and a topic may legitimately be the target of both:
"cybersecurity" is what a project is *about* and what a consultancy *is*. That is
one concept used in two relations, which is precisely SKOS — one class, many
relations pointing at it — and not two words for one thing.

This is a **convention, not a shape check, and it cannot be made one.** The two
predicates have identical published signatures (`any -> topic`), so no validator
can separate them without inventing a structural difference the semantics do not
have. Rather than fake it, the rule is published verbatim in the contract, held in
one exported constant in code, and a test compares the two so the sentence cannot
drift in either place while the other stays still.

### 3. Venues are two nodes joined by `operated-by`

A restaurant or hotel becomes a `location` **and** an `organization`, joined by
`operated-by` (location -> organization).

schema.org's own answer, `LocalBusiness`, is multiple inheritance — it appears
under both `Thing > Organization > LocalBusiness` and `Thing > Place >
LocalBusiness` — and Atlas cannot copy that: an endpoint has exactly one type.
Between the two remaining options, the owner chose the split. OpenStreetMap's
"one feature, one element" page argues the other way, and it also names the exact
failure mode of the merge — that tagging a hotel and its restaurant as one object
"is causing problems as soon as any more detailed tags such as opening_hours would
be added". The split takes that cost up front instead of at the first
opening-hours attribute.

`operated-by` launches with **zero existing edges by design**. Gate G6 measured
that none of the 65 venue locations has a matching organization today, so this
mints 65 organizations rather than de-duplicating existing ones. The direction is
taken from OSM `operator=*` — "the entity who is directly in charge of the current
operation of a map object" — and it is the correctly-directed counterpart of
`based-in`, which is now domain-restricted so it can never express the inverse.

### 4. The predicate set is twenty-five, and every domain rule is enforced in code

Eight predicates collapse into a survivor plus an attribute, one is renamed
because its endpoints moved, and three are new. `has-type`, `operated-by` and
`part-of` are the additions; the twenty-two carried forward are the ones the
corpus actually uses.

| retired | successor |
|---|---|
| `reports-to` | `employed-by` with `role` naming the reporting line |
| `board-member-of`, `advises`, `alumnus-of` | `member-of` with `role` |
| `hosted` | `participant-in` with `role: "organizer"` |
| `mentor-of`, `partner-of`, `related-to` | `connects` with `relation` |
| `created-for` | `created` with `created_for` naming the beneficiary object id |
| `engaged` | `spouse-of` with status `pending` — an engagement is a marriage that is not valid yet, which the bitemporal spine already expresses |
| `merged-with` | `acquired-by`, which names which organization survived; `merged-with` named neither |
| `intro-path-to` | `introduced-by`, once it has happened; a path nobody walked is a plan |
| `discussed-at` | `about` for the subject matter, plus `participant-in` for who was there |
| `instance-of` | `has-type`, or `offered-by` when the target is the provider |
| `purchased-from` | `sold-by`, whose **source is the thing sold** rather than the buyer |
| `related-topic`, `part-of-topic` | `about`, or the topic endpoint's `parent_topic_ref` |

`purchased-from` → `sold-by` is a **rename in name only for the reader**: the
endpoints move, so it is not a safe alias and the old name is refused rather than
silently rewritten. The distinction matters because an alias that also has to move
an endpoint produces a confidently backwards edge.

**Enforcement is code, not documentation.** `checkPredicateEndpoints` is the single
implementation; the zod schema and the throwing entry point both call it, so a
store cannot accept an edge its own validator would refuse. A violation returns a
typed `PredicateEndpointError` carrying `expected_domain`, `expected_range`, the
offending endpoint and a message naming the whole rule — and it returns **both**
violations for a wrong-direction edge rather than the first, because reporting only
the source sends the reader off to fix the half that is arguably right. A
`based-in` written `location -> organization` is told the domain wants
`person|organization` and the range wants `location`, which together say "you meant
`operated-by`".

A retired predicate is refused with `retired-predicate` and a suggestion naming its
successor, never as `unknown-predicate`. A caller holding a retired name is holding
real history, and "we have never heard of that word" is the one answer that is
certainly wrong.

### 5. A new published revision, `2026.08.1`

`schema/2026.08.0/` is frozen and untouched. `2026.08.1` carries forward every
tool, record shape, limit and annotation byte-identically; the only content
difference is the `x-atlas-known-values` predicate hint, which now names exactly
the twenty-five. The corpus answers under gate 3 are unchanged, which is the
evidence that the vocabulary change did not silently change what any recorded
question answers.

`docs/contract/atlas-knowledge-contract-2026.08.1.md` gains §1.2, which publishes
the two-layer typing scheme, the totality rule, the disambiguation rule verbatim,
the twenty-five domain rules, and the retired names with their successors, under
five new registered requirements (C-42 … C-46).

## What is NOT decided here

- **Attribute valid time (OPEN-11).** Approved in principle and deliberately
  sequenced into its own change, because it reaches the storage layer and needs
  its own tests. Until it lands, attribute pairs that differ only by time —
  `maiden_name` beside `name`, `founded_year` beside `founded`, `birth_year`
  beside `birthday` — stay as two attributes rather than being collapsed. This ADR
  changes no endpoint attribute.
- **Whether `connects` must carry a discriminating attribute (OPEN-12).** It
  absorbed `related-to` (which required `relation`), `mentor-of` and `partner-of`
  (which carried their meaning in the predicate name), and it previously required
  `note`. Requiring either on the merged predicate would force synthesising a
  value for edges that never had one, so it currently requires neither and
  recognises both.
- **That nothing points at a `project` (OPEN-13).** Every predicate whose range
  once included `project` now excludes it, so a project can be the subject of
  `about` and of nothing else. The ratified table says so explicitly; whether
  `project` should regain an inbound predicate or be reduced to a classification
  of another type is not decided here.
- **The retypes themselves.** Moving the travel items to `occurrence/segment` in
  the same transaction as their `owns` → `participant-in` migration, minting the
  venue organizations, and backfilling `has-type` from the retired enum values are
  migration work with their own gates. This change makes the intermediate states
  unrepresentable — `owns` cannot take an occurrence — but performs none of them.
- **OPEN-20. Ongoing import cannot emit `has-type`.** Minting a topic node needs
  an identity decision — is this word the topic that already exists, or a new one
  — and the migration answers it with a whole-run view of every carrier plus a
  closure gate that refuses two nodes for one word. An importer sees one page at a
  time and has neither. Giving it the same guarantees is its own change; until
  then the classification is counted and queued, not carried, and the counts above
  are the measure of what that change would be worth.

## Consequences

- **Every consumer of a subtype loses a field.** The importer's Logseq type-alias
  table resolves `saas`, `device`, `hotel-room-type` and the rest to the TYPE
  alone; the connector import stops carrying a `subtype`; the topic-review
  pipeline loses its `subtype` axis and its `LIVING_ATLAS_LOGSEQ_TOPIC_REVIEW_CURATED_SUBTYPE`
  setting.

  **On the one-time migration the word moves to a `has-type` edge. On ongoing
  import it is DROPPED, and this bullet used to claim otherwise.** Only
  `buildProjectionPlan` emits a `has-type` edge, because only it mints the topic
  node the edge needs; the importer and the connector import each omitted the
  field with a comment describing an edge neither of them writes. That is
  recorded as OPEN-20 below, and until it closes the loss is made **countable**
  rather than silent: the importer queues one quarantined
  `dropped-classification-review` row per dropped word, and the connector ledger
  carries `import_totals.dropped_classification`. A number is not a fix, but it
  is the difference between a gap somebody can size and a gap nobody can see.
- **The importer emits one fewer property edge.** A topic's parent used to become a
  `part-of-topic` edge. That predicate is retired and nothing replaced it: `part-of`
  is occurrence-only, and a broader/narrower link is neither what a topic IS nor
  what it is CONCERNED WITH. Topic hierarchy stays on the endpoint's
  `parent_topic_ref`, which the endpoint projection already carries.
- **A Logseq page typed `milestone`, `life-event`, `observation` or `transaction`
  stops promoting.** Those four were declared, never used, and have no successor
  among the four occurrence subtypes. Guessing one would be the silent
  misclassification this ADR exists to stop; the page is refused and lands in
  review instead.
- **`EdgeCategorySchema` loses `governance` and `advisory`,** because no predicate
  can be filed under them any more, and a category nothing produces is a branch
  nobody has ever executed.
- **The legacy 30-tool surface's JSON-Schema predicate enum is updated in step.**
  It remains a second declaration of a set the contract owns — that drift is
  quarantined on the legacy plane and will be deleted with it — but a copy that
  disagrees is strictly worse than a copy that agrees.
