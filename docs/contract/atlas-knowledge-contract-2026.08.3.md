# Atlas Knowledge Contract — revision 2026.08.3

Status: Published
Protocol revision: MCP `2026-07-28` (only)
Plane: consumer
Schemas: `packages/atlas-contract/schema/2026.08.3/`

## 0. What changed in 2026.08.3

A **compatible (additive)** revision. A consumer pinned to 2026.08.2 needs no code
change and loses nothing: every previously published tool keeps its name, its
arguments and its result. This revision ADDS two, so the surface is fourteen tools
rather than twelve.

| change | policy |
|---|---|
| `atlas.entity.create.v1` added | §11.1 **A1** — a new tool is additive; a consumer that never calls it is unaffected |
| `atlas.entity.rename.v1` added | §11.1 **A1** — likewise |

**What it means.** Until now the contract could state everything Atlas believes
*about* an entity and nothing about the entity's own existence or name: a consumer
could assert `worked-at` against an id, but the id itself could only be minted by a
maintenance path outside the contract. That made entity lifecycle a private
capability of whoever held the store, which is precisely the "no side channels"
property this contract exists to remove. These two tools close it.

They are deliberately narrow, and the two hardest properties are preserved rather
than relaxed:

- **Identity is still minted, never derived.** `atlas.entity.create.v1` takes no id
  and returns the one Atlas chose. Two calls with identical arguments make two
  entities; the tool does not deduplicate, because guessing that two requests meant
  one thing is the conflation the identity model exists to prevent. A mistake is
  repaired by merging, which is an identity event with a ledger row — not by
  pretending the second call never happened.
- **A rename changes what a thing is CALLED, never what it IS.**
  `atlas.entity.rename.v1` moves no id, writes no ledger row and breaks no reference:
  the returned record carries the same `entity_id` and the same `registered_at`, with
  only `display_name`, `also_known_as` and `updated_at` moved. Renaming an id that has
  already been merged away is REFUSED (`entity-redirected`) rather than applied,
  because editing a record that has been superseded changes history rather than the
  present; the refusal names `atlas.entity.resolve.v1` as the remedy.

**Both are writes, and both are gated exactly like `atlas.assertion.propose.v1`.** A
server whose store was opened read-only refuses them from every credential
(`store-read-only`), and a credential whose grant does not permit the write tier is
refused (`write-tier-not-permitted`) — so publishing these tools grants nobody
anything. The reach of a credential remains a property of its grant, readable at
`atlas.scope.describe.v1`.

**Servers on 2026.08.2 are unaffected and remain correct.** They publish twelve
tools; a consumer that calls a tool a server does not publish gets the ordinary
unknown-tool error, which is the same answer it would get from any server that has
not adopted the revision.

## 1. What this document is, and what it is not

Two artifacts are normative and they must not drift apart.

| artifact | normative for |
|---|---|
| `packages/atlas-contract/schema/2026.08.3/` | **shape** — what fields exist, what types they carry, what is required |
| this document | **semantics and evolution** — what those fields mean, what Atlas promises, what may change and when |

A shape without semantics is a contract nobody can implement against: `recorded_at`
and `valid_from` are both RFC-3339-ish strings, and knowing that tells a consumer
nothing about the fact that one is assigned by Atlas at commit and the other is
supplied by the caller and frequently unknown. A semantics document without a shape
is a description of software rather than an interface.

Where they appear to conflict, the schema wins on shape and this document wins on
meaning. Neither may be changed without the other; see §11.

Normative requirements are written in bold and carry a bracketed tag such as `[C-01]`.
Every tag appears once in the register in §13 alongside the test that enforces it or
the work unit that owns it. A requirement with neither is not a requirement, and a
test asserts there are none.

### 1.1 The surface

Twelve tools, one plane. Operational capabilities — migration windows, tiering
escalation, sync control, review workflow — live on a separate operator plane that
shares zero tool names with this one, so a consumer credential reaching an operator
endpoint gets a typed refusal and an empty tool list rather than a partial surface.

| tool | what it answers |
|---|---|
| `atlas.contract.describe.v1` | which contract is running, with the live vocabularies, limits, deprecations, and history block |
| `atlas.scope.describe.v1` | what this credential can reach, and whose assertions it may supersede |
| `atlas.entity.resolve.v1` | what does this identifier name today — including identifiers Atlas never minted |
| `atlas.entity.read.v1` | the entity records for these ids, without following redirects |
| `atlas.assertion.query.v1` | the bitemporal read, and the full-scan bootstrap |
| `atlas.assertion.read.v1` | these assertions by id, believed or not, optionally with lineage |
| `atlas.graph.neighbors.v1` | what this entity is connected to, bounded by depth and pinned on both axes |
| `atlas.text.search.v1` | what matches this text, and what could not be searched |
| `atlas.changes.read.v1` | what changed after this cursor |
| `atlas.assertion.propose.v1` | commit assertions under one idempotency key |
| `atlas.submission.read.v1` | did my submission commit — the tool for after a dropped connection |
| `atlas.sensitive.reveal.v1` | request disclosure of a withheld record, audited either way |

`atlas.entity.read.v1` deliberately does not follow redirects; `atlas.entity.resolve.v1`
does. Conflating them is how a consumer stops noticing that the thing it asked about
was merged away.

### 1.2 The graph vocabulary

Revision 2026.08.3 changes nothing about the record shapes, the limits, or the
protocol, and nothing about the twelve tools 2026.08.2 published — it adds two
(§0) and leaves the rest byte-identical. The vocabulary those tools carry is
unchanged from 2026.08.2, whose own only byte-level difference from 2026.08.0 was
the predicate hint published in `x-atlas-known-values`.

Two layers describe what a thing is.

**Type** is closed and small. Eight endpoint types — person, organization, project,
location, occurrence, topic, offering, item — and only `occurrence` carries a
subtype. The other seven carry none at all: a payload that sends one is refused
rather than ignored, because a caller sending `subtype` believes it has classified
something and the only way to tell it otherwise is to fail.

`occurrence` keeps four subtypes and they are TOTAL: every occurrence receives one
of them, and a server **MUST NOT** [C-43] reintroduce `other` or accept an occurrence
with no subtype at all. A default would file every occurrence whose author did not
choose under a word nobody chose, which is exactly what `other` did.

| subtype | what it is | why it is not something else |
|---|---|---|
| `segment` | one leg of a journey | a leg is an activity, not a possession; it is joined to its container by `part-of` |
| `trip` | the container the legs belong to | one booking spans several legs, so the container is a node and not a field |
| `stay` | an occupancy of a place over time | it has a duration and a place, which a meeting does not require |
| `meeting` | people were somewhere at a time | the residual value, and deliberately so: meal, conference and incident are all this shape |

A subtype enum survives only when the value changes which attributes and edges the
node carries AND the enum can be made total. Seven failed that test. The largest of
them put the majority of its nodes in `other`, which is not a classification: it is a bucket
that answers every question plausibly and wrongly.

**Classification** is open and lives on edges. `has-type` points at a `topic` node, so
a classification is multi-valued, bitemporal like any other edge, and an
identity-checked node rather than a string. A state university is `has-type`
government AND `has-type` university, which one enum slot could never say. The prior
art is uniform: CIDOC-CRM `P2 has type` → `E55 Type`, SKOS `Concept`, W3C ORG
`org:classification`, and schema.org `additionalType`.

`has-type` and `about` have the identical published signature — any subject, a topic
target — so no shape check can separate them. The separation is a convention, and
this sentence is the convention:

> **`has-type` says what the subject IS. `about` says what the subject is CONCERNED
> WITH.**

Both point at topic nodes and a topic may legitimately be the target of both:
"cybersecurity" is what a project is *about* and what a consultancy *is*. That is one
concept in two relations, which is exactly what SKOS describes, not two words for one
thing. A server **MUST NOT** [C-46] represent this distinction as a shape difference:
inventing a structural gap the semantics do not have would make consumers validate
against a lie.

#### The predicates

Twenty-five, each with a domain rule stated as `domain -> range`. A server
**MUST** [C-42] enforce the rule in code and refuse a violating edge with a typed
error naming both the expected domain and the expected range. A domain rule that lives only in
prose is not a rule: `based-in` previously accepted both `person -> location` and
`location -> organization`, so "where is this organization based" and "who runs this
place" were the same edge and no consumer could tell which one it held.

| predicate | domain -> range | what it says |
|---|---|---|
| `employed-by` | person -> organization | employment; `role` carries the job title |
| `member-of` | person\|organization -> organization | non-employment affiliation; `role` carries board member, advisor, alumnus |
| `part-of` | occurrence -> occurrence | composition, e.g. a segment within its trip |
| `contained-in` | location -> location | spatial containment, the city/state/country ladder |
| `has-type` | any -> topic | classification |
| `operated-by` | location -> organization | the place-to-business link, correctly directed |
| `based-in` | person\|organization -> location | where an agent is based; never the inverse |
| `occurred-at` | occurrence -> location | where something happened |
| `participant-in` | person\|organization -> occurrence | who was there; `role` marks the organizer |
| `connects` | agent <-> agent | the generic association; `relation` names which |
| `owns` | person\|organization -> item\|offering\|organization | ownership as a state |
| `offered-by` | offering\|occurrence -> organization | who operates or provides the thing |
| `sold-by` | item\|offering\|occurrence -> organization | the counterparty of a sale |
| `purchased` | person -> item\|offering\|occurrence | the act of buying |
| `customer-of` | person\|organization -> organization | a standing commercial relationship |
| `founder-of` | person -> organization | founding |
| `acquired-by` | organization -> organization | which organization absorbed which |
| `invests-in` | person\|organization -> organization | capital deployed |
| `about` | any -> topic | subject matter |
| `parent-of` | person -> person | parenthood |
| `spouse-of` | person -> person | marriage; an engagement is this edge with status `pending` |
| `sibling-of` | person -> person | siblinghood |
| `estranged-from` | person -> person | an explicitly broken relationship |
| `introduced-by` | person -> person | who introduced whom |
| `created` | person\|organization -> item\|offering | authorship; `created_for` names the beneficiary |

`owns` and `purchased` and `sold-by` are three facts about one transaction — the
state, the act, and the counterparty — and they are separate because a consumer that
can only ask one of them cannot answer the other two.

#### Retired names

Eight predicates were retired into a survivor plus an attribute, because a
distinction that does not change the shape of a relation belongs in an attribute:
`board-member-of`, `advises` and `alumnus-of` are all `member-of` with a different
`role`, and keeping them separate meant three query paths for one question. The
retired set also includes `reports-to`, `engaged`, `merged-with`, `intro-path-to`,
`hosted`, `discussed-at`, `instance-of`, `purchased-from`, `created-for`,
`related-topic`, `part-of-topic`, `partner-of`, `mentor-of` and `related-to`.

A server that receives a retired name **MUST** [C-44] refuse it with a message
naming the successor and the attribute that carries the lost distinction, and it
**MUST NOT** [C-44] report it as an unknown predicate. A caller holding a retired name is holding
real history; "we have never heard of that word" is the one answer that is certainly
wrong. Retirement is a `vocabulary_value` deprecation under §11.4 and carries the
published window.

The open-vocabulary hint in `x-atlas-known-values` **MUST** [C-45] name exactly this
set. A hint that quietly advertises a predicate the graph refuses is worse than no
hint, because a consumer that trusts it builds a request that cannot succeed.

## 2. Citing a revision

A revision is cited as the pair `atlas-knowledge-contract` + `2026.08.3`. That pair
identifies both artifacts, because they ship together.

- **A specific schema** is cited by its `$id`, e.g.
  `urn:living-atlas:contract:2026.08.3:tool:atlas.assertion.query.v1:output`.
  The scheme is `urn:` deliberately: it has no retrieval semantics, so no validator
  can resolve a published `$ref` over the network and end up validating against
  whatever a host served that day.
- **A running server** reports its revision in the `_meta` of every registered tool
  under `atlas.contract/revision`, and in `atlas.contract.describe.v1`.
- **A record** cites itself. Every returned record carries a frozen `record_schema`
  literal, and a server **MUST** [C-01] set it on every record it returns.

Record schema versions are independent of the contract revision. `atlas.assertion:v1`
means one shape for the life of that identifier, whichever contract revision returned
it — so a record logged in 2026 and read in 2031 is interpretable with no server
present and no knowledge of which revision produced it. A shape change that removes
or retypes a field mints `:v2`; see §11.

## 3. Time: three timestamps, one axis of belief

Atlas is bitemporal. Two axes, never interchangeable:

- **World time** — `valid_from` / `valid_to`. When the thing was true out in the
  world. Supplied by the caller, frequently imprecise, sometimes simply unknown.
  Half-open `[valid_from, valid_to)`; an absent `valid_to` means "still true".
- **Belief time** — `recorded_at`. When Atlas learned it.

Three timestamps travel with a submission and only one of them is an axis:

| field | axis? | who sets it |
|---|---|---|
| `recorded_at` | **yes** — belief | Atlas, at commit |
| `committed_at` (on the receipt) | no — it is the same instant, reported | Atlas, at commit |
| `proposed_at` (on the draft) | **no** — advisory only | the caller |

A caller **MUST NOT** [C-07] be able to supply `recorded_at`, and Atlas rejects any
attempt: a caller that can set belief time can backdate what Atlas knew, and every
as-of read becomes unrepeatable. `proposed_at` exists so a client can record when it
formed an opinion; nothing orders by it.

`unknown` is not a date and never sorts. A world-time endpoint of `{"kind":"unknown"}`
**MUST NOT** [C-35] match any as-of point. An `approximate` endpoint widens by one
unit of its own precision and can only ever yield `match_quality: "possible"`.

Belief-time ordering is meaningful only for records whose
`provenance.recorded_at_fidelity` is `authoritative`. Records carrying
`import-artifact` reflect when a file was processed, not when Atlas learned anything;
any result mixing the two sets `horizon.recorded_at_fidelity_mixed`, permanently, not
as a transitional state.

## 4. Identity

Ids are minted and never derived. Nothing about a record's content, position, file
path, or encoding influences its id, which is what lets Atlas promise that an id it
once returned resolves forever.

A consumer **MUST NOT** [C-30] parse, decompose, or infer ordering from an id. Ids
sort by mint time as an index convenience; feed order is `seq` and belief order is
`recorded_at`.

`atlas.entity.resolve.v1` is the only way to ask what an identifier names today, and
it accepts identifiers Atlas never minted — legacy ids inherited at migration are
exactly the ones that most need to keep resolving. Every outcome is typed:

| outcome | meaning |
|---|---|
| `resolved` | the id names a live entity, possibly after following redirects |
| `unknown-id` | no such id was ever minted or inherited |
| `ambiguous-split` | the id was split; candidates are named |
| `not-carried-forward` | terminal disposition: never migrated, content unrecoverable, or redacted in place |
| `redirect-cycle` / `redirect-chain-too-long` / `redirect-dangling` | the ledger is damaged, and says so |

On a split, Atlas **MUST NOT** [C-31] nominate a primary successor. Nominating one
silently reattributes every historical reference to whichever candidate was picked.
The promise is that an id never becomes meaningless or reused — not that it always
yields exactly one entity.

**Split tiling.** When an id is split into successors, the successors **MUST** [C-29]
together account for everything the original accounted for: every assertion whose
subject was the original resolves through exactly one successor — no orphan, no
double-count. A split that loses an assertion is a deletion wearing a redirect's
clothes.

A renamed entity keeps its id and writes no ledger row. In Atlas an *alias* is a row
in the id ledger and a *nickname* is a string in `also_known_as`; conflating the two
is how a rename becomes a re-identification.

## 5. Writes

### 5.1 Idempotency is `(client_id, idempotency_key)`

Submission identity **MUST** [C-08] be `(client_id, idempotency_key)` and **MUST NOT**
be a content hash. This is not a preference. An assertion's body carries a
server-assigned `recorded_at`, so the same logical write can never hash the same
twice; content-addressed identity and server-assigned belief time are mutually
exclusive, and belief time is the one that has to win.

- A retry with the same pair **MUST** [C-09] return the ORIGINAL receipt with the
  ORIGINAL `submission_id` and `assertion_id`s. Nothing is re-minted, nothing is
  re-stamped, and no `seq` is burned.
- The same key with a **different** payload **MUST** [C-10] return a typed
  `idempotency-key-conflict` naming the original submission — never a silent accept
  of either version.
- Keys are scoped per `client_id`, so two consumers cannot collide.
- Deduplication lasts `idempotency_ttl_days` (30). After that an identical retry
  commits a **second copy**. `atlas.submission.read.v1` **MUST** [C-12] report
  `state: "expired"` rather than a bare not-found, because "I have no record of this"
  and "I had a record and stopped keeping it" call for opposite client behaviour.

### 5.2 A submission is all-or-nothing

One submission is one durable commit group. There is no state in which some proposals
landed and others did not, and a server **MUST NOT** [C-11] report one. Per-item
`results[]` exist to say *which* item caused a refusal, not to report partial success.

### 5.3 Supersession

`lineage_action` is normative and the distinction between `retract` and `invalidate`
is the one that matters most:

| action | meaning |
|---|---|
| `assert` | a new claim |
| `correct` | the prior claim was recorded wrongly; both stay readable |
| `retract` | a **belief** error — "we should never have said this". World time is untouched, because the world did not change |
| `invalidate` | a **world** change — "this was true and has stopped being true". Typically also closes `valid_to` |
| `reinstate` | re-assert something previously retracted |

Any action other than `assert` **MUST** [C-36] name what it acts on in `supersedes[]`.

A consumer credential **MUST NOT** [C-13] supersede an assertion authored by a
different `client_id`; the refusal is `supersession-not-permitted`. A consumer that
can retract another consumer's belief can rewrite attribution, and attribution is the
only thing that makes provenance mean anything. `atlas.scope.describe.v1` publishes
the effective rule as `supersession_scope`.

Supersession stamps the prior record once and never returns to null. The stamp is the
only write Atlas ever makes to a committed assertion.

### 5.4 Contradiction: both succeed

Two consumers asserting mutually exclusive facts is not an error and neither commit
is rejected. Both **MUST** [C-14] succeed, and neither supersedes the other:
supersession is a statement about lineage that only the author of the earlier belief
is entitled to make. The contradiction surfaces at READ time.

**Predicate cardinality** decides what counts as a contradiction:

- `functional` — at most one live value per subject at any world instant. Two live
  assertions on one functional key **MUST** [C-15] be returned together in
  `contested[]`, neither superseded, and Atlas does not pick.
- `multi-valued` — several may hold at once. Two overlapping `employed-by`
  assertions are two jobs and **MUST NOT** [C-15] appear in `contested[]`.

Cardinality and the functional key are published per predicate by
`atlas.contract.describe.v1`. This rule supersedes any last-write-wins behaviour
described by earlier schema documents.

### 5.5 Event kinds

`kind` is `fact | relationship | observation`. An `observation` need not carry a
`target_entity_id` or a `value`: that an observation about the subject exists at a
world time is itself the claim. An objectless life event is expressed this way rather
than by inventing a placeholder object, because a placeholder object acquires
assertions of its own and then cannot be removed.

### 5.6 What sensitivity tier a proposal lands at

`atlas.assertion.propose.v1` publishes **no** sensitivity field, so a consumer cannot
name a tier. Every consumer-proposed assertion is therefore unclassified content, and
unclassified content is stamped **`local-private`** (rank 10) — the same default an
entity gets, and the default AGENTS.md requires: *"Default new content to
`local-private` unless explicitly classified otherwise."*

Two consequences a consumer has to plan for, and neither is incidental:

- The grant must name `local-private` in `write_tiers_permitted`, or the proposal is
  refused with `write-tier-not-permitted` before anything is committed. A credential
  that may read the whole graph is not thereby able to write to it.
- The grant must also name `local-private` in `sensitivity_reachable` for the consumer
  to **read back what it just wrote**. A grant with write reach and without read reach
  is legal and means exactly what it says: this credential may contribute, and may not
  see the result. Both are published by `atlas.scope.describe.v1`, so a consumer
  discovers which it holds rather than inferring it from a failure.

The cost is stated rather than hidden: the safe default is also a blunt one, and
reclassifying a proposal upward is an owner action with no consumer-facing tool on this
revision. See OPEN-10.

## 6. Reads

### 6.1 Absence is reported, never performed

Every read result **MUST** [C-16] carry a `coverage` block and an `atlas.horizon:v1`.
A record this credential may not read **MUST** [C-16] occupy its row as an
`atlas.redaction:v1` stub — it is never dropped. The consumer learns *that* something
is there and unreachable, so counts reconcile and a filtered graph is never mistaken
for a complete one.

`coverage.counts_basis` says whether the counts are `exact` or `bucketed`. Exact
counts are themselves a disclosure channel: repeated filter bisection against an exact
`withheld` localises a withheld record without ever reading it. Which credential
classes receive exact counts, and what bucket width defeats bisection, is **OPEN** —
see §12.

`atlas.text.search.v1` additionally reports `search_scope.encrypted_unsearchable`.
Content that is encrypted at rest is not scanned, and a search that silently excludes
it makes "no match" and "could not look" indistinguishable.

### 6.2 The history floor

`horizon.bitemporal_since` is the earliest belief instant Atlas can answer for. A read
with `as_of_recorded` below it **MUST** [C-17] be refused with `as-of-before-history-floor`,
and **MUST NOT** [C-17] be answered from present state. A confident wrong answer is
worse than a refusal.

The floor may be advanced and never lowered. Advancing it is a forfeiture and is a
breaking change; see §11.

### 6.3 Paging and the snapshot pin

Page 1 of a paged read returns `page.snapshot`, which pins
`{as_of_recorded, seq_watermark, feed_epoch}`. Pages 2..N **MUST** [C-18] echo it, and
a server **MUST** [C-18] compute them against that pin. A page sequence computed
against advancing state skips and repeats rows with no way for the consumer to notice.

A snapshot lives `snapshot_ttl_seconds` (900). After that the server **MUST** [C-19]
return `snapshot-expired` with `remedy.tool` naming the tool that restarts the read —
never a silently re-run query.

### 6.4 Bootstrap, then follow

`atlas.assertion.query.v1` with `full_scan: true` is legal with no filters at all;
that is the point. The final page **MUST** [C-20] carry `page.feed_handoff` naming
`atlas.changes.read.v1` and the exact `cursor_seq` the scan covered, so
bootstrap-then-follow has no gap and no overlap.

### 6.5 The change feed

`seq` is per-assertion, monotone, and gapless within a `feed_epoch`. It is
deliberately not a per-transaction generation number: one number shared by every event
of a submission means a cursor cannot resume mid-submission.

- Delivery is at-least-once. A consumer **MUST** [C-22] deduplicate on `change_id`.
- Retention is `change_feed_floor_days` (400) — a concrete day count, not "recent".
- A cursor below the retention floor **MUST** [C-21] return
  `cursor-before-retention-floor` with `remedy` naming the re-scan entry point.
  It **MUST NOT** [C-21] return a silent empty page: a consumer that resumes past a
  hole cannot otherwise tell a compacted range from an uneventful one.
- A `feed_epoch` mismatch **MUST** [C-23] fail loudly. Resuming a cursor into a
  different total order produces plausible, wrong output indefinitely.
- Supersession is its own change with its own `seq`, so a mirror converges from the
  feed alone.

### 6.6 Reclaimed records

An assertion reclaimed by compaction **MUST** [C-32] resolve to a typed
`assertion-reclaimed` error carrying its reclamation note — never a bare not-found.
Otherwise a dangling reference and a typo are indistinguishable.

## 7. Disclosure

`atlas.sensitive.reveal.v1` is not a read. It **MUST** [C-24] produce a durable audit
event on every outcome, including a refusal, and **MUST** [C-24] return that event's
id to the caller: an audit trail a consumer does not know exists is one it cannot
reason about. This is why the tool is annotated `readOnlyHint: false` and
`idempotentHint: false` — an owner decision is not repeatable, and the second call is
a second ask.

It requires the `elicitation` client capability. If the client did not declare it, the
server **MUST** [C-25] answer with the JSON-RPC error `-32021`
(MissingRequiredClientCapability) whose `data.requiredCapabilities` names the missing
capability in the `ClientCapabilities` shape. It **MUST NOT** [C-25] issue an
elicitation nobody can answer, and it **MUST NOT** [C-25] report the condition only as
a tool RESULT: a conformant client branches on the numeric code, and a number carried
in a result field is a number nobody reads. The typed `atlas.error:v1` record (`code:
"capability-required"`) and the audit receipt ride along in `data.result`, so nothing a
caller is owed is lost by the change of channel.

Disclosure state (`request_state`) is integrity-protected and bound to the principal
resolved from the credential — never to self-reported client info — and to the method
and its arguments, so it cannot be replayed across principals or requests.

### 7.1 What the server enforces, and what it does not

Being explicit, because "owner decision" reads like a server-side control and only part
of it is one. The server enforces, in code:

- **integrity** of `request_state` (HMAC, verified before any handler runs);
- **principal binding** — a state minted for one credential is refused when another
  echoes it;
- **method binding** — a state minted by one method does not verify in another;
- **object binding** — the redaction id inside the signed payload is compared against
  the `redaction_id` argument, and a mismatch is refused;
- **expiry** — the TTL is inside the signed payload;
- **the durable audit event**, on every outcome including a refusal.

The server does **not** enforce who answers. The approval arrives as an elicitation
response on the **calling client's own channel** and is read from the request's
`inputResponses`, which is caller-supplied input. A non-interactive or scripted MCP
client can therefore answer its own disclosure request. The disclosure gate is the
calling client's human-in-the-loop; the controls above are what the server contributes
independently of it. See OPEN-9.

## 8. Limits are transport-invariant

Every cap in `atlas.contract.describe.v1`'s `limits` is compiled into the published
schemas as `maximum`/`maxItems`. A transport **MUST NOT** [C-26] narrow one. The
measured defect this fixes: the prior surface enforced 100 items locally and 10
remotely, so an identical request succeeded on one transport and failed on the other
with no way for a caller to discover which limit applied.

| limit | value |
|---|---|
| `max_page_size` | 200 |
| `default_page_size` | 50 |
| `max_batch_items` | 100 |
| `max_batch_bytes` | 1048576 |
| `max_traversal_depth` | 5 |
| `max_ids_per_request` | 100 |
| `snapshot_ttl_seconds` | 900 |
| `idempotency_ttl_days` | 30 |
| `change_feed_floor_days` | 400 |
| `deprecation_window_days` | 400 |

### 8.1 A credential is a capability grant, and a grant only narrows

What a credential may do is a *capability grant*: the sensitivity tiers it may read,
the tools it may call, the predicates and tiers it may write, and its own `limits`.
None of those is a property of how the credential connected. A consumer's permissions
**MUST NOT** [C-40] depend on the transport it connects over, and a correct consumer
therefore never branches on one — it reads its grant from
`atlas.scope.describe.v1`, which publishes every dimension of it including the
`tools_available` its `tools/list` will contain.

The measured defect this replaces: the prior control plane's credential profiles were
literally named for transports (`local-full`, `local-readonly`, `remote-safe`), and
the local daemon refused any profile not beginning `local-`. A credential *was* its
transport, so "the same client with the same permissions over a different wire" was
not expressible and every difference between two surfaces was invisible rather than
declared.

A grant's `limits` **MUST NOT** [C-41] widen a published cap. The effective limit is
the minimum of the published number and the granted one, and `atlas.scope.describe.v1`
publishes the effective numbers — so a caller designs to the cap that actually
applies to it rather than discovering it from a truncated page.

Sensitivity reach is a NAMED SET of tiers, not a threshold, and
`sensitivity_ceiling` is a report of that set rather than the rule. A threshold admits
any tier that happens to be ranked below it, including one introduced after the grant
was written; a named set cannot widen without someone editing a grant.

## 9. Asymmetric strictness

The single most important structural rule in this contract.

- **Input schemas are closed.** Every object carries `additionalProperties: false`. An
  argument Atlas does not understand is a caller mistake, and accepting it silently
  means a typo'd `as_of_recored` returns the present when the caller asked for the
  past.
- **Output schemas are open.** No object constrains `additionalProperties` at all, so
  a field added later is additive and a consumer pinned to this revision keeps
  validating.

A generator **MUST** [C-03] emit closed inputs and **MUST** [C-02] emit open outputs.
This is enforced structurally rather than by convention: the authoring language has no
`additionalProperties` knob, the renderer assigns strictness from wire position, and
the generator re-checks the emitted bytes. The failure being guarded against is
precisely a contract that tells consumers outputs are open while its generators
quietly emit them closed.

Two consequences worth naming:

1. Output openness reaches **extra properties only**. A wrong discriminator or a
   malformed value is still refused. What guarantees Atlas never *emits* an
   unexpected property is the model's own strictness, not this schema.
2. An input schema **MUST NOT** [C-37] reference a record schema. Every field that
   carries authority — ids, `seq`, `recorded_at`, `claim_digest`,
   `provenance.client_id` — is minted at commit, and reusing an output shape on the
   input side is exactly how a caller ends up able to supply one.

**Closed enums** reserve `other` in output position and **MUST NOT** [C-06] reserve it
in input position, where the server would have to invent a meaning for it. A set that
genuinely cannot grow publishes `x-atlas-frozen-reason` instead, so skipping the
convention is visible in the artifact.

A server serving revision R **MUST NOT** [C-06] emit an enum member that R does not
publish. A member added in a later revision reaches an R consumer as `other`. Without
that rule the reserved member is decorative: the consumer's copy of R's schema would
reject the new value and the reservation would have bought nothing.

**Open vocabularies** — predicates, entity subtypes, error codes — are the graph's to
grow, not the contract's. They are typed `{"type":"string"}` with an
`x-atlas-known-values` hint, and the live registry is served by
`atlas.contract.describe.v1`. A consumer **MUST** [C-38] validate against that
registry rather than against a copy captured when it shipped.

## 10. Normative consumer obligations

A consumer of this contract:

1. **MUST** [C-02] ignore fields it does not recognise in any result. Every output
   object is open and Atlas will add fields.
2. **MUST** [C-05] tolerate an `atlas.error:v1` `code` it has never seen. Branch on
   `retryable` and `remedy`, and treat an unknown code as a refusal it cannot
   specifically handle. A consumer that crashes on an unknown code breaks when Atlas
   becomes more honest.
3. **MUST** [C-04] tolerate a `record_schema` it does not recognise by handling the
   envelope alone: read `record_schema`, then keep or discard the record as opaque.
   It **MUST NOT** [C-04] reject the surrounding page. Result slots are schema'd as
   "envelope plus conditional refinement" precisely so an unknown kind validates
   [C-33].
4. **MUST NOT** [C-30] parse or order by an id.
5. **MUST NOT** [C-39] parse an error `message`. It is for humans; branch on `code`.
6. **MUST** [C-22] deduplicate change-feed rows on `change_id`.
7. **MUST** [C-18] echo `page.snapshot` on pages 2..N.
8. **SHOULD** call `atlas.contract.describe.v1` on connect and alert on any
   `deprecations[]` entry naming something it uses.

A server:

9. **MUST NOT** [C-34] return a result that fails its own published output schema.
   Consumers cache and replay these records for years with no server present to ask
   what a malformed one meant.

## 11. Evolution policy

The published directory for a released revision is immutable. Any change **MUST** [C-28]
ship as a new revision directory. The bytes of `schema/2026.08.0/` never change
again, and the bytes of `schema/2026.08.3/` will not either once it is frozen.

A new revision is either **compatible** or **breaking**.

### 11.1 Compatible (additive)

A consumer may adopt a compatible revision at leisure and need not change code.

| | change |
|---|---|
| A1 | Adding a new tool. |
| A2 | Adding an **optional** property to an input schema. |
| A3 | Adding any property to an output schema or a record. |
| A4 | Adding a member to an **output** closed enum — subject to [C-06]: servers on the prior revision deliver it as `other`. |
| A5 | Adding a value to an open vocabulary (predicate, entity subtype, error code). Needs no revision at all; that is what "open" means. |
| A6 | Adding a new `record_schema`, provided it appears only in slots typed as tagged unions. |
| A7 | Relaxing an input constraint: raising a cap, widening a pattern, making a required input optional. |
| A8 | Adding an optional field to an existing record schema (no `:v2`). |
| A9 | Adding a deprecation notice. |
| A10 | Adding a new `requires_capabilities` entry to a **new** tool. |

### 11.2 Breaking

| | change |
|---|---|
| B1 | Removing or renaming a tool. |
| B2 | Removing or renaming any property of an output schema or record. |
| B3 | Dropping a property from an output schema's `required`. A consumer depends on presence, not only on type. |
| B4 | Changing the type, unit, or meaning of any existing field. |
| B5 | Adding a **required** property to an input schema. |
| B6 | Removing a member from any enum, input or output. |
| B7 | Narrowing an input constraint: lowering a cap, tightening a pattern, making an optional input required. |
| B8 | Changing a `record_schema` literal, or changing an existing record's shape other than by A8 — which mints `:v2` and is breaking for anything that resolved `:v1` by name. |
| B9 | Changing an id format or a `$id` URN. |
| B10 | Changing the semantics of an existing error code, or changing which code a given condition returns. |
| B11 | Changing any `cache.cache_scope` from `private` to `public`. |
| B12 | Reordering `tools[]`. The order is diffed by consumers and by the anti-drift gate. |
| B13 | Raising the required MCP protocol revision. |
| B14 | Advancing `bitemporal_since`. Reads that were answerable become refusals; it is a deliberate, irreversible forfeiture. |
| B15 | Rolling `feed_epoch`. Every cursor is invalidated. |
| B16 | Reducing `change_feed_floor_days`, `idempotency_ttl_days`, `snapshot_ttl_seconds`, or `deprecation_window_days`. |
| B17 | Adding a `requires_capabilities` entry to an **existing** tool. |

### 11.3 Neither

Not contract changes and not versioned: prose in `description` fields; the contents of
`x-atlas-known-values` (a hint, never a whitelist); and the graph's data.

### 11.4 Deprecation

Nothing published is removed without notice.

- A deprecation is announced **machine-readably** in
  `atlas.contract.describe.v1` → `deprecations[]`, and on the affected tool as
  `deprecation` in the manifest and in `_meta["atlas.contract/deprecation"]`. A
  changelog entry is not an announcement: a consumer cannot poll a changelog.
- Each notice carries `target_kind`, `target`, `announced_at`, `removal_not_before`,
  `reason`, and `replacement` where one exists.
- `removal_not_before` **MUST** [C-27] be at least `deprecation_window_days` (400)
  after `announced_at`, and Atlas **MUST NOT** [C-27] remove the target before it.
- 400 days is not arbitrary: it equals `change_feed_floor_days`. Atlas promises a
  consumer offline for up to that long can resume from its cursor. A shorter
  deprecation window would make that promise hollow — the consumer would resume
  successfully into a surface where the tool it calls no longer exists.
- An empty `deprecations[]` is a real answer meaning nothing is deprecated, not an
  absence of information.

## 12. Open questions

Marked open rather than quietly decided.

| | question |
|---|---|
| **OPEN-1** | Coverage bucketing. `counts_basis: "bucketed"` is declared, but which credential classes get exact counts and what bucket width actually defeats filter-bisection is not decided. Until it is, a server that serves exact counts to a non-owner credential is within the schema and outside the intent. |
| **OPEN-2** | Consumer-proposed entity splits. `atlas.assertion.propose.v1` deliberately does not carry a `split` intent: a split is an identity decision requiring owner evidence, and the consumer plane has no owner. Whether consumers should ever be able to *propose* one (as a reviewable candidate rather than an applied change) is unresolved. |
| **OPEN-3** | Whether a source-declared `id_property` alone should be authoritative for identity carry-forward. Today the rule is ≥2-of-4 observed traits. Carried forward from ADR 0012. |
| **OPEN-4** | Score comparability in `atlas.text.search.v1`. `search_scope.scorer` is published so a consumer knows which scorer ran, but no comparability guarantee is made across scorers or across calls, and none is currently possible. |
| **OPEN-5** | Disclosure requests with no owner present. `input-required` carries a TTL; what happens at expiry — silent drop, queued request, or a durable pending state a later session can answer — is not decided, and the three differ in whether a request can be answered by someone other than the requester's session. |
| **OPEN-6** | `contested[]` is returned whole rather than paged. A subject with pathologically many contradictions has no bound on that array. Whether to page it, cap it, or summarise it is open. |
| **OPEN-7** | Per-predicate value schemas. `value` is unconstrained JSON. Publishing a schema per predicate would let a consumer validate it, and would also make every predicate addition a contract change. The trade has not been made. |
| **OPEN-8** | Whether `idempotency_ttl_days` should be per-credential rather than global. A batch importer and an interactive assistant have different retry horizons. |
| **OPEN-9** | Whether a disclosure needs an owner channel independent of the requesting client. Today the elicitation answer arrives on the calling client's own channel (§7.1), so a scripted client can approve its own disclosure. An out-of-band owner channel would close that, at the cost of a disclosure no single-process client could complete. Not decided. |
| **OPEN-11** | Attribute valid time. Endpoint attributes carry no validity interval, so an organization's former name and its current one cannot both be true at different times without two attributes. The change is approved in principle and deliberately sequenced separately because it reaches the storage layer; until it lands, pairs that differ only by time (`maiden_name` beside `name`, `founded_year` beside `founded`) stay as two attributes rather than being collapsed. |
| **OPEN-12** | Whether `connects` must carry a discriminating attribute. It absorbed `related-to` (which required `relation`), `mentor-of` and `partner-of` (which carried their meaning in the predicate name), and it previously required `note`. Requiring either on the merged predicate would force synthesising a value for edges that never had one, so it currently requires neither and both are recognised. Which — if either — becomes mandatory is unresolved and depends on measuring how many existing edges carry each. |
| **OPEN-13** | Nothing in the vocabulary points AT a `project`. Every predicate whose range once included project now excludes it, so a project can be the subject of `about` and the subject of nothing else. Whether project should regain an inbound predicate, or be reduced to a classification of some other type, is not decided here. |
| **OPEN-10** | Whether a consumer should be able to name the sensitivity tier of a proposal. Today it cannot: `atlas.assertion.propose.v1` publishes no tier and every consumer write lands at `local-private` (§5.6). That is the safe default and it is also a blunt one — a consumer proposing something the owner considers `open` cannot say so, and the reclassification is manual. |

## 13. Requirement register

Every normative tag above, with the executable test that enforces it or the work unit
that owns it. `pending` means the behaviour is specified here and not yet
implementable — the server that will own it does not exist in this revision's scope.

| id | requirement | verified by |
|---|---|---|
| C-01 | Every returned record carries its frozen `record_schema` literal | `packages/atlas-contract/src/schema.test.ts` › "requires the frozen record_schema literal on every record" |
| C-02 | Output schemas are open; consumers ignore unknown fields | `packages/atlas-contract/src/schema.test.ts` › "leaves every object in every published output schema open" |
| C-03 | Input schemas are closed | `packages/atlas-contract/src/schema.test.ts` › "closes every object in every published input schema" |
| C-04 | An unknown `record_schema` validates as an envelope | `packages/atlas-contract/src/schema.test.ts` › "accepts a result slot carrying a record_schema this revision never defined" |
| C-05 | Error codes are an open vocabulary | `packages/atlas-contract/src/schema.test.ts` › "leaves open vocabularies as strings that name their live registry" |
| C-06 | Output enums reserve `other`; input enums never do | `packages/atlas-contract/src/schema.test.ts` › "reserves `other` in every closed enum of every output document" |
| C-07 | `recorded_at` is never caller-supplied | `packages/atlas-contract/src/schema.test.ts` › "refuses a proposal that supplies a field Atlas mints at commit" |
| C-08 | Idempotency is `(client_id, idempotency_key)`, never a content hash | `packages/atlas-core/src/store.test.ts` › "scopes keys per client, so two consumers cannot collide" |
| C-09 | A retry returns the original receipt and ids | `packages/atlas-core/src/store.test.ts` › "replays the original receipt and ids without re-minting" |
| C-10 | The same key with a different payload is a typed conflict | `packages/atlas-core/src/store.test.ts` › "rejects the same key with a different payload instead of accepting either" |
| C-11 | A submission is all-or-nothing | `packages/atlas-core/src/durable-log.test.ts` › "does not burn a seq or half-write a group when supersedes is unresolvable" |
| C-12 | An expired idempotency key is reported, not returned as not-found | **pending** — W33 (12-tool consumer server) |
| C-13 | A consumer may only supersede its own `client_id`'s assertions | **pending** — W33 (12-tool consumer server) |
| C-14 | Contradictory assertions both succeed | `packages/atlas-core/src/store.test.ts` › "keeps two conflicting claims current rather than auto-resolving" |
| C-15 | `contested[]` on a functional key; never on a multi-valued one | **pending** — W18 (bitemporal query engine) |
| C-16 | Coverage on every read; withheld rows occupy a row | `packages/atlas-core/src/store.test.ts` › "counts withheld rows so totals reconcile" |
| C-17 | An as-of read below the history floor is refused | `packages/atlas-core/src/store.test.ts` › "refuses a belief-time read before the history floor instead of guessing" |
| C-18 | Paged reads pin and echo the snapshot | **pending** — W18 (bitemporal query engine) |
| C-19 | An expired snapshot is typed and names the restart tool | **pending** — W18 (bitemporal query engine) |
| C-20 | A full scan's final page hands off to the feed with no gap | **pending** — W19 (change feed + bootstrap handoff) |
| C-21 | A cursor below the retention floor is typed and names the re-scan tool | `packages/atlas-core/src/store.test.ts` › "resumes from a cursor without gaps or repeats" |
| C-22 | Change delivery is at-least-once; dedup on `change_id` | **pending** — W19 (change feed + bootstrap handoff) |
| C-23 | A `feed_epoch` mismatch fails loudly | `packages/atlas-core/src/durable-log.test.ts` › "restores the feed epoch and the history floor rather than re-deriving them" |
| C-24 | A reveal always writes an audit event and returns its id | **pending** — W31 (MRTR with bound requestState) |
| C-25 | An undeclared capability is `-32021`, never a silent unanswerable request | `packages/atlas-mcp/src/reveal.test.ts` › "answers -32021 on the wire when the client advertises no elicitation" |
| C-26 | Caps are transport-invariant and published | `packages/atlas-contract/src/schema.test.ts` › "publishes the same caps it compiles into the schemas" |
| C-27 | Deprecation notice is machine-readable and at least the published window | `packages/atlas-contract/src/policy.test.ts` › "publishes a deprecation window at least as long as the change-feed floor" |
| C-28 | A released revision directory is immutable | `packages/atlas-contract/src/schema.test.ts` › "stays byte-identical to what the generator emits" |
| C-29 | Split tiling: successors account for everything the original did | **pending** — W22 (alias ledger backfill) |
| C-30 | Ids are opaque; never parsed or ordered by | `packages/atlas-core/src/entity-registry.test.ts` › "mints a distinct id every time, so no id is ever reused" |
| C-31 | A split names candidates and never a primary | `packages/atlas-core/src/entity-registry.test.ts` › "creates the new entities and redirects the old id ambiguously" |
| C-32 | A reclaimed id resolves to a typed note, never not-found | `packages/atlas-core/src/durable-log.test.ts` › "is lossless when it does run, and stays lossless across a reload" |
| C-33 | Result slots validate an unknown record kind as an envelope | `packages/atlas-contract/src/schema.test.ts` › "still validates a KNOWN record kind in full inside a result slot" |
| C-34 | A server never returns a result failing its own output schema | `packages/atlas-contract/src/manifest.test.ts` › "rejects a result that fails the tool's own output schema" |
| C-35 | `unknown` world time never matches an as-of point | `packages/atlas-core/src/time.test.ts` › "never matches an as-of point" |
| C-36 | A non-`assert` action must name what it supersedes | `packages/atlas-core/src/store.test.ts` › "requires supersedes[] on any non-assert action" |
| C-37 | An input schema never references a record schema | `packages/atlas-contract/src/schema.test.ts` › "refuses to generate an input schema that references a record schema" |
| C-38 | Consumers validate open vocabularies against the live registry | `packages/atlas-contract/src/schema.test.ts` › "leaves open vocabularies as strings that name their live registry" |
| C-39 | An error `message` is for humans; consumers branch on `code` | `packages/atlas-contract/src/policy.test.ts` › "tells consumers in the schema itself never to parse an error message" |
| C-40 | A credential's permissions never depend on the transport it connects over | `packages/atlas-mcp/src/grant.test.ts` › "finds none in the code of any authorization module" |
| C-41 | A grant's `limits` narrow a published cap and never widen one | `packages/atlas-mcp/src/grant.test.ts` › "does not let a grant WIDEN a published cap, at the seam and not only in the helper" |
| C-42 | A predicate's domain and range are enforced in code, and a violation is a typed error naming both | `packages/contracts/src/temporal-vocabulary.test.ts` › "rejects a wrong-direction edge with a typed error naming the expected domain and range" |
| C-43 | `occurrence` is the only type with a subtype, and its four values are total | `packages/contracts/src/temporal-vocabulary.test.ts` › "covers a fixture of every occurrence subtype and admits no fifth" |
| C-44 | A retired predicate is refused by name with its successor, never as unknown | `packages/contracts/src/temporal-vocabulary.test.ts` › "refuses every retired predicate by name and says what replaced it" |
| C-45 | The published predicate hint names exactly the graph's vocabulary | `packages/atlas-client/src/contract-parity.test.ts` › "publishes exactly the graph's predicate vocabulary as the open-vocabulary hint" |
| C-46 | `has-type` and `about` are separated by a published convention, not by shape | `packages/contracts/src/temporal-vocabulary.test.ts` › "publishes the has-type versus about rule verbatim in the contract document" |
