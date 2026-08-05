# ADR 0024: The Venue Split and Attribute Deduplication

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

- Gate **G6** found 65 venue locations (restaurants and hotels) and **zero** with
  a same-named organization. A venue row is one node standing for two things — a
  place and a business — and nothing in the graph could express the difference.
- Gate **G8** found `provider` (177) and `airline` (146) **perfectly disjoint**:
  no object carries both. They are one attribute under two names.

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
same topic node. G6 is why all 65 are minted rather than reconciled: there was no
organization to merge with, so `operated-by` launches with zero existing warrant
by design.

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
- 65 organizations are minted that did not exist. They are new nodes, not
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
  evidence; the migration will not.
- **OPEN-15: the item/occurrence retype table** (rideshare and flight to
  `segment`, meal and incident to `meeting`) is not implemented here. An
  occurrence carrying a legacy subtype outside the four new values is refused
  with a reason naming that lane.
- Whether minted counterparty organizations should later be reconciled against
  legacy organizations of the same name, and by what evidence.
