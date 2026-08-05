# ADR-0024: Transactional edge migration onto the ratified predicate vocabulary

- Status: Accepted
- Date: 2026-08-05
- Supersedes: none
- Related: ADR-0021 (legacy projection and closure gate), ADR-0023 (graph
  vocabulary, classification by edge)

## Context

ADR-0023 ratified 25 predicates, each with a domain rule enforced in code, and
retired 14 names plus their aliases. The legacy graph does not speak that
vocabulary. It carries `board-member-of`, `advises`, `alumnus-of`, `related-to`,
`mentor-of`, `partner-of`, `engaged`, `purchased-from` and `created-for`, and it
carries 348 `owns` edges of which 323 point at objects typed `item` that are not
possessions at all — they are rideshares, flights, car services, drives and
trains. Gate G1a measured this: `owns` is entirely `person -> item`.

Those 323 items are retyped to `occurrence/segment`. The moment that retype
lands, every `owns` edge still pointing at one asserts that a person owns an
event — a claim the ratified `owns` range (`item`, `offering`, `organization`)
exists specifically to make unwritable.

Two further facts constrain the design. 12 `owns` edges and 6 `based-in` edges
name ids that are not nodes. And `based-in` survived the ratification under its
own name while its domain rule changed, so a legacy `based-in` written
`location -> organization` is now wrong without anything about its spelling
having changed.

## Decision

### 1. The retype and the rewrite are one transaction, and the graph enforces it

`planEdgeMigration` emits transactions; `InMemoryMigrationGraph.commitTransaction`
applies one all-or-nothing, validates the resulting state **as a whole**, and only
then makes it visible. Validation is `findStateDomainViolations`, which runs the
contract's own `checkPredicateEndpoints` over every edge using endpoint types read
from the node table.

That single mechanism is what makes "no person ever owns an event" enforceable
rather than merely intended. A migration that retyped the nodes in one
transaction and rewrote the edges in the next would ask the graph to enter a
state where `owns` targets an `occurrence`; that is a range violation, so the
graph refuses the transaction and leaves itself untouched.

Two supporting choices carry the same weight:

- **The legacy edge type carries no `source_type` / `target_type`.** The legacy
  plane stored a copy of the endpoint type on the edge. Carrying that copy
  forward is exactly what would let the retype and the rewrite drift apart: the
  node table would say `occurrence` while the edge still said `item`, and a
  domain check reading the edge's own copy would certify the forbidden state.
  Endpoint types are resolved from the node table, never from the edge.
- **Refused edges are withdrawn in the same transaction.** Leaving a refused edge
  in place would mean the migrated plane still holds an edge its own vocabulary
  rejects. `findStateDomainViolations` therefore also refuses any predicate the
  registry does not define, so an unmigrated edge cannot pass every check by
  being illegible to all of them.

### 2. Every absorption carries the retired name's meaning as data

| retired | becomes | carries |
| --- | --- | --- |
| `board-member-of` | `member-of` | `attrs.role = "board-member"` |
| `advises` | `member-of` | `attrs.role = "advisor"` |
| `alumnus-of` | `member-of` | `attrs.role = "alumnus"` **and the edge's `valid_to`** |
| `mentor-of` | `connects` | `attrs.relation = "mentor"` |
| `partner-of` | `connects` | `attrs.relation = "partner"` |
| `related-to` | `connects` | the legacy `attrs.relation`, when it had one |
| `engaged` | `spouse-of` | `status = "pending"` |
| `purchased-from` | `sold-by` | the endpoints, when the source was the thing sold |
| `created-for` | `created` | `attrs.created_for`, from the legacy beneficiary attr |

A collapse that drops the distinction its name carried has destroyed information,
not normalised it: without `attrs.role`, `board-member-of` and `advises` and
`alumnus-of` become one indistinguishable `member-of`.

### 3. Nothing is invented, and every refusal is named and counted

Ten closed refusal reasons. An edge that cannot satisfy its rule is refused,
never silently dropped and never re-pointed at a different node to make a rule
pass. Three of them exist because the honest answer was "this cannot be
migrated":

- `absorption-requires-valid-to` — `alumnus-of` collapses into `member-of`
  *because the membership ended*. That is the whole argument for the collapse, so
  an alumnus edge with no `valid_to` would need the year somebody left invented.
- `absorption-endpoints-unavailable` — a `purchased-from` written from the buyer
  names no merchandise, and a `created-for` pointing at the beneficiary names no
  artifact. Emitting the successor would require minting the missing endpoint.
- `absorption-attr-conflict` — the absorption would overwrite a value the legacy
  edge already held.

`dangling-edge-endpoint` covers the 12 `owns` and 6 `based-in` edges that name
non-nodes; no target is invented for them. `retired-predicate-without-absorption`
refuses a retired name with the contract's own successor text attached, so an
operator is never told a word they are holding never existed — `reports-to` lands
here, because its successor `employed-by` needs an employer a `reports-to` edge
does not carry.

### 4. One audit event per apply call, aggregate counts only

No edge id and no object id reaches the audit log. A per-record trail would be a
second copy of the graph and would hand the shape of the corpus to anyone allowed
to read audit. Predicate names are vocabulary rather than content, so counting by
predicate is safe. `nodes_retyped`, `edges_migrated` and `edges_withdrawn` are
counted off the transactions that actually committed rather than off the plan, so
a run stopped by a refusal reports what it did instead of what it intended.

## Consequences

- The migration is only as atomic as the store it commits through. A future
  durable store must keep the same property: apply a transaction all-or-nothing
  and validate the post-state before it is visible.
- Refusals are expected output, not failure. The fixture carries one instance of
  every reason precisely so a reason that stopped firing shows up as a zero.
- Plans are pure and carry no clock, so a re-run over an unchanged source
  produces a byte-identical plan and a review diff shows source drift rather than
  run-to-run noise.

## What is NOT decided here

- **OPEN-14. Which shape `purchased-from` actually has in the corpus.** The lane
  brief calls it a rename; ADR-0023's retirement note says "the endpoints move;
  this is not a rename". Both shapes are handled — a source within `sold-by`'s
  domain is renamed, a buyer-sourced edge is refused as
  `absorption-endpoints-unavailable` — so the migration is correct either way,
  but the measured split is unknown and the refusal count is the thing to look at
  on the first dry run.
- **OPEN-15. Which shape `created-for` actually has.** Same disagreement: the
  brief says "created + beneficiary attribute", ADR-0023's attr comment says the
  target *was* the beneficiary. Handled the same way, with the same caveat.
- **OPEN-16. The non-travel retypes are not in this lane.** The ratified retype
  table also folds `occurrence/{trip, travel}` into `trip`,
  `occurrence/{hotel-stay, stay}` into `stay`, and six occurrence subtypes into
  `meeting`. None of those is transactionally coupled to an edge rewrite, so they
  belong to the node lane. Only the `item -> occurrence/segment` travel retype is
  here, and only because `owns` cannot be rewritten without it.
- **OPEN-17. `operated-by` is not minted here.** D3 mints 65 organizations for
  venue locations. A legacy `contained-in` pointing at an organization is refused
  as a range violation rather than rewritten to `operated-by`, because the two
  nodes D3 calls for do not exist yet and this migration does not mint nodes.
- **OPEN-11 (from ADR-0023) still stands.** Attribute valid time is sequenced
  separately, so no endpoint attribute is touched by this lane.
