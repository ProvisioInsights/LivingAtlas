# ADR 0027: Contract Revision 2026.08.2 and Assertion Alias Rows

Status: Accepted for implementation
Date: 2026-08-06

## Context

The migration adapter has to write an alias row for every legacy id, including the
ids of legacy EDGE objects. The old store gave edges their own object ids, and on
the measured corpus roughly two thousand of them exist.

An edge becomes an ASSERTION, not an entity. The alias ledger could not say so:

- `mapped` requires `new_id: EntityIdSchema`;
- the three terminal dispositions (`never-migrated`, `content-unrecoverable`,
  `redacted-in-place`) all state the id was NOT carried forward, which is the
  opposite of what happened;
- and leaving the row out entirely makes `resolve()` answer `unknown-id`, which
  reads as "never existed".

Every available option made a resolvable id return a falsehood. An id that
resolves to a lie is worse than one that refuses, because a refusal is
inspectable and a lie is not.

## Decision

### 1. `mapped-assertion`, and a refusal that names what the id became

`AliasRowSchema` gains `{disposition: "mapped-assertion", new_assertion_id}`, and
`resolve()` gains a `carried-as-assertion` refusal carrying that id.

**Refusing is correct here, and is not a failure of the resolver.** `resolve()`
answers "which entity is this?", and the honest answer for an edge id is "none —
it is this assertion". Returning the assertion's subject entity would be a
category error dressed as helpfulness: every reference to the edge would silently
become a reference to one of the things it merely mentioned. What would be wrong
is refusing without saying where the content went, which is why the refusal
carries the assertion id.

`recordMigrationAssertionMapping` writes the row, mechanically: no human judged
anything, so `resolution_assertion_id` stays null, exactly as for every other row
in the migration family.

These three land TOGETHER and cannot be split. A disposition nothing resolves
falls through to `unknown-id` — reintroducing the lie the change exists to
remove — so a row type without its refusal is worse than neither.

### 2. No reserved member on `ResolutionRefusal["code"]`

The published surfaces already carry their escape hatches: the error vocabulary is
OPEN and consumers **MUST** [C-05] tolerate an unseen code, and the `outcome` enum
already reserves `other` under [C-06].

The union without one is atlas-core's INTERNAL TypeScript type, which is not
published. Adding `other` there would make it constructible to return a refusal
with no specific code — defusing the compile-time `Record<ResolutionRefusal["code"], true>`
trip-wire in `parity.test.ts` that caught this change in the first place. The
escape hatch belongs on the wire, where an unknown value must be survivable; not
in the internal type, where it would let a decision be skipped.

### 3. The revision was believed mandatory. It was not.

This is the part worth recording.

The change was escalated, twice, on the belief that adding a member to an output
enum is breaking and therefore required a MAJOR revision. Reading §11 of the
published policy showed the opposite, and the policy had said so all along:

- §11.1 **A5** — "Adding a value to an open vocabulary (predicate, entity subtype,
  **error code**). **Needs no revision at all**; that is what 'open' means."
- §11.3 — the contents of `x-atlas-known-values` are "Neither": not a contract
  change and not versioned.
- §11.1 **A4** — "Adding a member to an **output** closed enum — subject to
  [C-06]: servers on the prior revision deliver it as `other`." Listed under
  **Compatible**, not under Breaking. The published `2026.08.1` outcome enum does
  reserve `other`, so A4 applies directly.

So the error-code half needed no revision at all, and the outcome-enum half was
additive. **Path 1 — ship no revision, let a 2026.08.1 server report the refusal
as `outcome: "other"` with the precise `code` — was legal.** It was declined
deliberately, and the argument is the reason this section exists: "the error code
is open, so we need not publish the outcome" is the reasoning that ends with
`other` carrying nine distinct meanings and no consumer able to branch on any of
them. [C-06] exists so a `.1` consumer degrades gracefully, not so a `.2` need
never be cut. The disposition is permanent and thousands of ids resolve through
it, so it gets a name.

**What the false premise cost is the lesson.** Two rounds of escalation, a
reverted implementation, and an owner decision taken on a belief that the
documented policy contradicted. The policy is 70 lines long and was not read
until the third round. Before escalating a contract question, read the contract.

### 4. What the frozen directory actually forbids

Editing `schema/2026.08.1/` in place was blocked, and that block was real —
`released.lock.json` states it unconditionally and gate 4 checks it against git,
with deliberately no unfreeze flag. But immutability is not the same claim as
breakage: a released directory is frozen whether the change is additive or not.
Conflating the two is what turned an additive change into a believed major.

`2026.08.0` and `2026.08.1` remain byte-identical; gate 4 reports
`released=3 files=99 git_checked_revisions=2` with the two prior revisions
unmodified in git.

## Consequences

- A legacy edge id resolves, forever, to a stated outcome naming the assertion it
  became.
- A consumer on 2026.08.1 sees `outcome: "other"` plus the code, and is correct.
  A consumer on 2026.08.2 can branch on the outcome.
- Golden fixtures were re-recorded in the same change, moving one field:
  `contract_revision` `2026.08.1` → `2026.08.2`. Nothing else moved.
- **The answer-reproducibility corpus did not change.** That gate compares a
  version against its own past and is the one that must never be re-recorded to
  make a build pass; it passed untouched at 19 queries and 19 claims.

## What is NOT decided here

- **The migration adapter itself.** This revision exists to permit it and is
  deliberately separate: the adapter, the apply entrypoint, its guards, the
  reconciliation and the resume proof are the next change, built on top of a
  revision that has already been reviewed on its own terms.
