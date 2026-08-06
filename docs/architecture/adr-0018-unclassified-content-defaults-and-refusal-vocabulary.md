# ADR 0018: Unclassified Content Defaults To `local-private`, And One Name Per Refusal

Status: Accepted for implementation
Date: 2026-08-04

## Context

Two defects found in review of the work ADRs 0011–0017 settled. They are
unrelated in mechanism and identical in shape: a rule stated in one place and
contradicted, silently, in another.

**The privacy default was decided in two directions.** `EntityRegistry.register`
stamps `DEFAULT_ENTITY_SENSITIVITY = {tier: "local-private", rank: 10}` and
quotes AGENTS.md line 85 for it — *"Default new content to `local-private` unless
explicitly classified otherwise."* `AssertionLog.commit` stamped
`{tier: "open", rank: 0, withheld: false}`, and `atlas.assertion.propose.v1`
restated `const COMMIT_TIER = "open"` beside it. Since the published
`atlas.assertion.propose.v1` input carries no sensitivity field, *every* consumer
write landed at rank 0 — reachable by every grant including the narrowest — and
no ADR recorded that as a decision. The repository's own fixtures show what this
covers: `medical-note` is a predicate in the corpus.

**The refusal vocabulary had grown two names for the same refusal.** The frozen
schema documents for revision 2026.08.0 publish an `x-atlas-known-values` hint on
`atlas.error:v1.code` and `atlas.redaction:v1.reason_code`. The running server
emitted a different name for five of them:

| the frozen contract publishes | the server emitted |
|---|---|
| `capability-required` | `client-capability-required` |
| `sensitivity-withheld` | `sensitivity-ceiling-exceeded` |
| `reveal-declined` | `owner-decision-declined` |
| `cursor-before-retention-floor` | `cursor-below-retention-floor` |
| `revision-not-served` | `unknown-contract-revision` |

A consumer branching on the published name matched none of them. Nothing failed,
because nothing compared the two tables: `parity.test.ts` asserts
`capability-required` maps to `-32021` by reading atlas-contract's own constant
and comparing it to another constant in the same package, so it passes while the
server disagrees. The contract document's C-25 register row cited that test.

## Decision

### 1. `AssertionLog.commit` stamps `local-private` when nothing classified the content

`DEFAULT_ASSERTION_SENSITIVITY` lives beside `DEFAULT_ENTITY_SENSITIVITY`, holds
the same values, and cites the same sentence of AGENTS.md. One rule, one pair of
defaults that agree by construction.

`COMMIT_TIER` in `atlas-mcp` is now **read from** that constant rather than
restated. A constant that said `open` while `commit` wrote `local-private` would
make the grant check enforce a tier nothing is ever written at — the same
class of defect as the two names above, one layer down.

### 2. A consumer's grant must name `local-private` to write, and again to read back

This is the cost, and it is real. A credential that may propose must carry
`local-private` in `write_tiers_permitted`, or the proposal is refused with
`write-tier-not-permitted` before anything commits. To *read back what it wrote*
it must also carry `local-private` in `sensitivity_reachable`. A grant with the
first and not the second is legal and means what it says: this credential may
contribute and may not see the result.

Published in the contract as §5.6 so a consumer discovers it rather than meeting
it as a refusal, and mirrored in the synthetic fixture grant.

### 3. The server emits the name the contract publishes

Five codes renamed in `packages/atlas-mcp/src/vocabulary.ts` and at their emit
sites. Direction chosen deliberately: revision 2026.08.0 is **released and
frozen**, and its `x-atlas-known-values` bytes already carry the published names
— so the server conforms to the artifact, not the reverse. (The reviewer who
found this reported that the frozen schemas enumerate neither name; that is
incorrect. Both hints live in `schema/2026.08.0/records/`, not at the top level
of the revision directory.)

Renaming `sensitivity-ceiling-exceeded` to `sensitivity-withheld` also fixes a
narrower wrongness: `decideAssertion` withholds for *two* reasons — the record is
marked withheld, or its tier is outside the grant — and the old name described
only the second.

### 4. `retryable` is settled against the definition the frozen schema publishes

The frozen `atlas.error:v1` defines `retryable` as *"whether the identical
request could succeed later with nothing changed by the caller"*. Applied:

- `capability-required` → **false**. The identical request refuses forever;
  declaring the capability is the caller changing the request. The seed table
  said `true` and its own comment gave the reason — "once the client declares the
  capability" — which is the case the definition says `false` for. Corrected in
  the seed.
- `sensitivity-withheld` → **true**, `reveal-declined` → **true**. A
  reclassification or an owner approval makes the same bytes succeed, and neither
  is something the caller does to its request. Corrected in the server.

### 5. An anti-drift check, and an explicit register of what is not served

`vocabulary.test.ts` now asserts two things the old suite did not:

- every code both tables name agrees on `origin`, `jsonrpc_code` and `retryable`
  (summaries are deliberately not compared — the server's are richer on purpose);
- every contract-published code is either registered in the server's live
  registry or named in `SEED_CODES_NOT_SERVED` **with a reason**.

The second is the anti-drift property. The vocabulary is open by design, so the
server holding *more* codes than the contract seeds is legal and expected; what
must never happen again is the server holding a *different name* for a refusal
the contract already published, or a published code quietly having no
implementation and no note. Five codes are currently in that register:
`history-floor-cannot-regress`, `identity-ambiguous`,
`unsupported-protocol-version`, `batch-limit-exceeded`, `lineage-target-unknown`.

The C-25 register row now cites a wire-level test in `packages/atlas-mcp` that
drives a real server and asserts the emitted code and the `-32021` error, rather
than a constant-to-constant comparison inside `atlas-contract`.

## Consequences

- A consumer's proposals are invisible to a credential that reaches only `open`.
  That is the intended reading of AGENTS.md and it is a behaviour change: the
  same proposal was world-readable to every grant before this ADR.
- Synthetic fixtures now stamp `open` explicitly where they mean it, rather than
  inheriting whatever the default happens to be. A fixture whose readability
  turns on a privacy default is a fixture that silently changes meaning when the
  default is corrected.
- Twelve golden fixtures were re-recorded in the same change: the renamed codes,
  the fixture grant's derived `sensitivity_ceiling` (now `local-private`/10), and
  a one-millisecond shift in two belief-time stamps caused by the new
  `tools/list` audit event.

## Open questions

- **OPEN-1: naming a tier on a proposal.** A consumer cannot classify what it
  proposes, so everything lands at `local-private` and reclassification is a
  manual owner action with no consumer-facing tool. Published as OPEN-10.
- **OPEN-2: the rank of `local-private`.** 10 is inherited from
  `DEFAULT_ENTITY_SENSITIVITY` and has never been justified against a tier
  ladder that does not yet exist beyond `open` (0), `local-private` (10) and the
  fixtures' `sealed` (90).
- **OPEN-3: the five unserved published codes.** Two of them —
  `batch-limit-exceeded` and `lineage-target-unknown` — describe conditions the
  server *does* detect and currently reports as `invalid-argument`. Whether to
  map them onto their published names is a contract-visible change and is not
  decided here.

## Verification

- A store test queries with an `as_of_valid` that excludes records carrying exact
  world time, and asserts `with_valid_time + unknown_or_absent_valid_time` equals
  `matched`. Proven to fail against the prior ordering.
- A wire test drives the stdio server with `clientCapabilities: {}` and asserts
  `error.code === -32021` and `error.data.requiredCapabilities`. Proven to fail
  with the transport decorator disabled.
- The registry-agreement and not-served tests fail on any renamed or unaccounted
  code.
