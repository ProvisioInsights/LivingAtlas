# ADR 0013: The Published Contract, And Asymmetric Strictness

Status: Accepted for implementation
Date: 2026-08-04

## Context

The prior consumer surface exposed 30 MCP tools. Each declared an `inputSchema`
and none declared an `outputSchema`, because each returned stringified JSON
inside an MCP text block — a shape with nowhere to put an output contract at
all. Three consequences followed mechanically:

1. No consumer could validate a response, so a field could be dropped from a
   result for months without anything noticing.
2. No response could be versioned, because there was no artifact to version.
3. A record pulled out of a log years later was uninterpretable: nothing in the
   payload said what kind of thing it was.

The tool catalog also drifted from itself. `LocalBatchMaxItems` was 100 and
`RemoteBatchMaxItems` was 10, so an identical request succeeded on one transport
and failed on the other, and no published value told a caller which limit
applied.

ADR 0004 settled canonical knowledge records and ADR 0005 settled assertion
lineage and evidence, but neither specified a published wire contract, its
evolution policy, or how a schema is prevented from disagreeing with the model
it describes. This ADR does.

## Decision

### Two normative artifacts, shipped together

`packages/atlas-contract/schema/2026.08.0/` is normative for SHAPE.
`docs/contract/atlas-knowledge-contract-2026.08.0.md` is normative for SEMANTICS
and evolution policy. Neither is changed without the other, and the schemas name
the document in every manifest.

Shape alone is not a contract: `recorded_at` and `valid_from` are both
RFC-3339-ish strings, and the type says nothing about the fact that one is
assigned by Atlas at commit and the other is caller-supplied and frequently
unknown.

### Strictness is a property of wire POSITION, not of the author

Published input schemas are closed (`additionalProperties: false`). Published
output schemas are open (the keyword is absent entirely).

The important part is the enforcement. The authoring language in
`packages/atlas-contract/src/shape.ts` has no `additionalProperties` knob at
all: an author writes `obj({...}, [...])` and the RENDERER assigns strictness
from the position the schema occupies. The same authored shape used on both
sides comes out closed on input and open on output, and an author who wanted to
get it wrong has no syntax for it.

This is structural rather than conventional because the failure being guarded
against is exactly a contract that tells consumers outputs are open while its
generators quietly emit them closed. A rule enforced only where it is applied
has one point of failure, so `generate.ts` re-walks the emitted JSON and throws
before writing.

Closed enums are the same mechanism. `enumOf(["assert", "correct"])` renders
without `other` on the input side and with `other` on the output side. A
reserved `other` in an output enum is how a 2026 consumer survives a 2031
member; a reserved `other` in an INPUT enum would be a value the server has to
invent a meaning for.

### The reserved member only works if servers downgrade

A server serving revision R must not emit an enum member that R does not
publish. A member added in a later revision reaches an R consumer as `other`.

Without that rule the reservation is decorative: a consumer validating against
its pinned copy of R would reject the new value, and `other` would have bought
nothing. The rule is stated normatively in the policy document as [C-06].

### Result slots are an envelope plus conditional refinement, not a `oneOf`

A heterogeneous result array is schema'd as an object requiring only
`record_schema`, with one `if`/`then` per known kind pulling in that record's
document.

A `oneOf` over a closed set would make every unrecognised `record_schema` a
validation FAILURE, so the first time Atlas returned a record kind added after a
consumer pinned this revision, a strict consumer would reject the whole page.
The chosen form validates a known kind in full and accepts an unknown kind as an
envelope — which is precisely the normative consumer obligation, expressed in
the schema instead of only in prose.

### `$id` uses `urn:`, so network dereference is impossible rather than forbidden

Every `$id` and `$ref` is a `urn:living-atlas:contract:<revision>:…`. A `urn:`
has no retrieval semantics, so a validator physically cannot resolve a published
reference over the network and end up validating against whatever a host served
that day. It also keeps a deployment hostname out of a public repository's
published bytes.

### Schemas are generated and committed, and a test proves they agree

The catalog is authored once in TypeScript; `write-schemas.ts` emits the JSON;
the emitted bytes are committed. A test regenerates in memory and compares
byte-for-byte against the committed files.

The bytes are committed because a published contract has to be reviewable in a
diff — nobody can tell whether a change was additive by reading the code that
produced it. The drift test is what makes "authored once" true rather than
aspirational. A released revision's directory is then immutable; a change ships
as a new revision directory.

### The server registers FROM the manifest

`loadContract()` reads the published bytes and `registerContractTools()` hands
those exact objects to the server. There is no path by which a server advertises
a shape different from the one it published.

Registration refuses in both directions: a published tool with no handler is a
tool that appears in `tools/list` and errors when called; a handler for an
unpublished tool is a callable surface nobody reviewed. Input is validated
before the handler runs; output is validated before the result leaves.

### Records are output-only

An input schema may not `$ref` a record schema, and the renderer throws if one
tries. Every field that carries authority — `assertion_id`, `seq`,
`recorded_at`, `claim_digest`, `provenance.client_id` — is minted by Atlas at
commit, and reusing an output shape on the input side is exactly how a caller
ends up able to supply one.

### Limits are constants in one place

Every cap is a member of `CONTRACT_LIMITS`, compiled into the schemas as
`maximum`/`maxItems` AND published through `atlas.contract.describe.v1`. A test
asserts the two agree. This is the direct fix for the 100-vs-10 drift.

## The forks resolved here

### Output openness cannot reject an unexpected property, and that is the design

An open output object accepts `{"kind": "unknown", "value": "9999"}` — an
`unknown` world-time endpoint carrying the exact value the prior store used to
sort unknowns to the far future. The published output schema cannot refuse it,
because refusing it would mean closing the object, which would break additive
evolution.

The resolution is to be explicit about which layer holds which guarantee:

- What guarantees Atlas never EMITS such a record is the model's own strictness.
  `WorldTimePointSchema` in `atlas-core` is a strict union and refuses to
  construct one.
- What guarantees a consumer pinned to this revision still works in 2031 is this
  schema's openness.

`parity.test.ts` therefore asserts EXACT agreement between the contract and the
model on the input side, and one-way containment on the output side — the
contract accepts everything the model can produce, and is deliberately no
stricter. Stating it as one-way is the point; asserting equality would have
forced closing outputs, and asserting nothing would have hidden the asymmetry.

The input side is where it matters and there it is exact: a caller cannot
propose an `unknown` carrying a value.

### The propose intent discriminator is `lineage_action`, not a parallel vocabulary

The rewrite plan names an intent discriminator `assert | correction | invalidate
| split` on propose. `atlas-core` already defines `lineage_action` as
`assert | correct | retract | invalidate | reinstate | other`, and that
vocabulary is normative.

Publishing both would mean two names for one concept and a mapping table that
eventually disagrees with itself. The contract therefore publishes
`lineage_action`, with core's members minus `other` on the input side.

`retract` and `reinstate` are kept, not folded into `correction`. The
distinction between `retract` (a BELIEF error — we should never have said this,
world time untouched) and `invalidate` (a WORLD change — this was true and
stopped being true) is the single most load-bearing semantic in the model, and a
three-member intent enum cannot express it.

`split` is not an assertion action at all. It is an identity decision that
requires owner evidence and a recorder, and the consumer plane has no owner. It
is absent from the consumer surface and marked OPEN-2 in the policy document
rather than silently dropped.

### A batch submission is all-or-nothing

The plan asks for "array-batch propose under one idempotency key with per-item
results". Per-item results are published. Per-item SUCCESS is not, because one
submission is one durable commit group under ADR 0011 — there is no state in
which some proposals landed and others did not.

Publishing a partial-success shape would describe a state the store cannot
reach, and a consumer would eventually write recovery code for it. `results[]`
exists to say WHICH item caused a refusal.

### `atlas.sensitive.reveal.v1` is annotated non-read-only and non-idempotent

A reveal produces a durable audit event on every outcome, including a refusal,
and returns that event's id to the caller. Per the repository's architecture
bias, reads by a remote provider are security-relevant events that must be
observable; an audit trail a consumer does not know exists is one it cannot
reason about.

`readOnlyHint: true` would tell a client it is free to retry silently.
`idempotentHint: true` would be false on its face — an owner decision is not
repeatable, and the second call is a second ask.

### The deprecation window equals the change-feed retention floor

Both are 400 days, and that is not a coincidence. Atlas promises a consumer
offline for up to `change_feed_floor_days` can resume from its cursor. A shorter
deprecation window would make that promise hollow: the consumer resumes
successfully into a surface where the tool it calls no longer exists.

## Open questions

Recorded as open in the policy document rather than decided here: coverage
bucketing width and which credential classes get exact counts (OPEN-1);
whether consumers should ever propose an entity split (OPEN-2); whether a
source-declared `id_property` alone is authoritative for identity carry-forward,
carried over from ADR 0012 (OPEN-3); score comparability across search scorers
(OPEN-4); disclosure requests with no owner present (OPEN-5); whether
`contested[]` needs paging (OPEN-6); per-predicate value schemas (OPEN-7); and
whether the idempotency TTL should be per-credential (OPEN-8).

## Consequences

- Adding a field to any response is additive by construction. Adding an argument
  is additive only if it is optional.
- A consumer that validates strictly against a pinned revision keeps working
  when Atlas grows — provided servers honour [C-06] and downgrade unknown enum
  members to `other`. That obligation is on the server and is not something a
  schema can enforce; it needs a runtime test in the server package.
- Every record is self-describing. A row pulled out of a log in 2031 names its
  own schema, and its `:v1` shape is frozen for the life of that identifier
  independently of the contract revision that returned it.
- The generator is versioned by revision. Cutting 2026.09.0 adds a catalog
  module; the 2026.08.0 module is frozen, and the drift test fails loudly if
  anyone edits it.
- Records referenced from result slots must all be published documents. A
  server cannot return an ad-hoc shape in a typed slot without adding it to the
  contract first, which is the intended friction.
- 39 normative requirements now exist with named owners. 30 have executable
  tests today; 9 are marked pending against the work unit that will own them
  (W18, W19, W22, W31, W33), and a test asserts every pending row names one.

## Rejected Alternatives

### Hand-authoring the JSON Schema documents

Rejected. Asymmetric strictness would then be a convention an author has to
remember 33 times, and the failure mode is silent: a closed output object looks
exactly like a correct one until a consumer rejects a response two years later.

### A `oneOf` over the known `record_schema` values

Rejected. It makes an unrecognised record kind a validation failure for the
whole page, which is the opposite of the stated consumer obligation and would
make adding a record kind a breaking change.

### Publishing enums for predicates and entity subtypes

Rejected. Predicates are the graph's vocabulary and grow whenever the owner
records something new. Enumerating them would mean either republishing the
contract on every new predicate or shipping a schema that rejects valid data.
They are typed as strings with an `x-atlas-known-values` HINT, and the live
registry is served by `atlas.contract.describe.v1`.

### `https://` `$id`s on a domain we control

Rejected. A resolvable `$id` invites a validator to fetch it, and then the
document being validated against is whatever that host served today rather than
the reviewed artifact. It would also put a deployment hostname into a public
repository.

### A separate `packages/atlas-contract-schemas` holding only JSON

Rejected. The generator, the loader and the schemas have to move together, and
a package boundary between them enforces nothing at runtime while guaranteeing
that a change touches two packages. The published directory inside this package
is already the artifact boundary.

### Validating only inputs at the server boundary

Rejected. Input validation checks the party that cannot break the contract's
promise. The party that can is the server, and a result that fails its own
published output schema is the one failure consumers cannot recover from later —
they will have cached and replayed it.

## Implementation

`packages/atlas-contract/src/`:

- `revision.ts` — frozen constants: revision, protocol revision, URN prefix,
  record schema names, limits, history block, tool order.
- `vocabulary.ts` — the open vocabularies and the predicate cardinality
  registry.
- `shape.ts` — the authoring language with no strictness knob, and the
  position-driven renderer.
- `catalog.ts` — the 12 tools and 6 records, authored once.
- `generate.ts` — emission plus the three enforced invariants (strictness,
  no record refs in inputs, reserved `other`).
- `write-schemas.ts` — the CLI that writes the published directory.
- `manifest.ts` — the manifest types and the loader.
- `validator.ts` — the Ajv 2020-12 wrapper, constructed with no `loadSchema`.
- `register.ts` — the SDK-free registrar port and the binder.
- `samples.ts` — one synthetic sample per record schema.

`packages/atlas-contract/schema/2026.08.0/` — 33 published documents:
`manifest.json`, `common.input.json`, `common.output.json`, 6 records, and 24
tool schemas.

## Verification

- Every published document validates against the 2020-12 metaschema itself, not
  merely compiles.
- Every `$ref` resolves locally and no `$ref` names a fetchable scheme.
- Every object in every input document is closed; every object in every output
  document is open; both directions are asserted per-pointer with the pointer in
  the failure message.
- Every closed enum in an output document reserves `other` or publishes a frozen
  rationale; no input enum reserves `other`.
- One sample of every `record_schema` validates; each fails when its
  `record_schema` literal is removed or changed.
- A result slot accepts a `record_schema` this revision never defined, and still
  validates a known kind in full.
- The published enums equal `atlas-core`'s enums on the output side and equal
  them minus `other` on the input side.
- The published patterns accept exactly what the model accepts for belief-time
  instants, minted ids, and caller-supplied world-time points.
- Core refusal codes are pinned by a compile-time exhaustiveness check, so a new
  refusal in `atlas-core` fails `tsc` before it can reach a consumer undescribed.
- The committed bytes are byte-identical to what the generator emits.
- The manifest round-trips: generate, write, load, compare.
- A manifest whose `$id` disagrees with the document it names is refused; a
  published file the manifest does not name is refused.
- Registration refuses a missing handler and an unpublished handler; a bad
  argument is rejected before the handler runs; a bad result is rejected before
  it leaves.
- Every bolded MUST in the policy document carries a tag; every tag is
  registered once; every registered tag is used; every cited test file and title
  exists; every pending requirement names a work unit.
