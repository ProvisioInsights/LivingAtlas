# ADR 0016: Anti-Drift Build Gates, And The Quarantine Ledger

Status: Accepted for implementation
Date: 2026-08-04

## Context

Four pieces of drift were live in this repository when this work started. All
four were verified against the working tree before a line of gate code was
written, and all four are the same defect wearing different clothes: **one fact,
written down twice, in two places that cannot see each other.**

**The local-only deny list disagreed with itself.**
`LocalOnlyLivingAtlasMcpToolNames` in `packages/mcp-contract/src/index.ts` named
six tools. `LocalOnlyToolNames` in `packages/graph-service/src/index.ts` — the
list that *enforces* the rule — named four. The two missing entries were
`migration_open` and `migration_seal`, whose own catalog descriptions read
"Local-only; must be closed with migration_seal". They were reachable over
`remote-http`. Both copies type-check.

**One batch cap had two numbers, chosen by transport.**
`LocalBatchMaxItems = 100` and `RemoteBatchMaxItems = 10`, in the same file. The
published input schema tells every caller `maxItems: 100`, so a remote caller
sending eleven items is refused by a number that appears in no document it can
read and no tool it can call.

**Twenty-one of thirty input shapes were authored twice and disagreed.** The
local server declares its inputs in zod; the catalog declares them in JSON
Schema. The client is shown one and validated against the other. `status`
advertises `authority_id`, `include_tombstones` and `limit` and accepts none of
them; `object_list` advertises `object_type`, `include_tombstones` and `limit`
and accepts none of them; nineteen tools mark `authority_id` required in the
catalog and optional in the code.

**Four advertised tools cannot be performed.** `sync_pull`, `sync_envelopes`,
`usage_gate` and `usage_reconcile` all route to `localUnsupportedTool`. The
catalog is the document a client plans against.

None of these is visible to a type checker: both copies type-check. None is
visible to a single-transport test: only one copy is reached. Every one of them
is visible in the text, and none of them was being read.

A fifth, found while building the gates rather than before: **`include_superseded`
was a published input on `atlas.assertion.query.v1` that the handler never read.**
It reached the corpus because a pinned query asked a question whose answer
depended on it. Nothing else in the repository would have noticed.

## Decision

Five gates, wired into `npm run check` as `npm run gates`, each with permanent
negative controls in `packages/atlas-gates/src/*.test.ts`.

### 1. Single source

Four detectors, one per way this repository has actually drifted:

| detector | finds |
|---|---|
| `redeclared-tool-name-set` | a set of published tool names declared outside the contract |
| `transport-varying-limit` | one limit written twice, chosen by wire |
| `input-schema-divergence` | one shape authored twice, in two languages |
| `advertised-tool-unimplemented` | a tool the catalog promises and nothing serves |

The first two read source text, because the defect lives in the text and not in
the behaviour. The last two are asked over the wire, against the server a client
would actually get: `tools/list` must name exactly what `manifest.json` publishes,
and every advertised schema must be **byte-identical** to the published document
rather than a re-serialisation of it.

Comments are blanked before any detector runs. A gate that flagged the sentence
explaining a rule would make writing the explanation a build failure, and the
explanation would lose.

### 2. Golden fixtures

One recorded response per published tool, checked three ways: it matches the
recorded bytes; it satisfies **its own published output schema**; and coverage
cannot rot by omission in either direction — a published tool with no golden
fails, and a golden for a case nothing produces fails.

The schema check is the load-bearing one. A golden file alone says "the
implementation still does what it did", which is exactly as true after a
regression as before it if the regression was what got recorded.

### 3. Answer reproducibility

A frozen synthetic graph, nineteen pinned `(subject, as_of_valid, as_of_recorded)`
queries, and their recorded answers. This is the only gate here that compares a
version against its own past.

Nothing else in this repository would notice if a change to `intervalContains`
altered which assertions a 2019 query returns: every existing test computes its
expected answer with the same code it is testing, so the test moves with the
change and stays green. That is not hypothetical — it is the shape of the two
defects this store was built to replace. The old surface mapped an unknown date
to the string `"9999"` and stripped `~` before comparing, and both of those look
like small, sensible normalisations at the call site.

Each pinned query carries a `holds` line naming the rule it exists to protect,
because a corpus entry whose purpose nobody wrote down is one the next person
re-records instead of investigating.

### 4. Released revisions are immutable

Two independent checks, because each alone has a way to be wrong.

- **Content.** Every file's SHA-256 must equal the digest in
  `packages/atlas-contract/schema/released.lock.json`. Needs no git, no history,
  no network. Its weakness is that the lock is a file too.
- **Git.** A released revision that is tracked must have no working-tree change
  of any kind beneath it. This fails **even when the lock was updated in the same
  change**, which is exactly the case the content check cannot catch.

A revision directory that no lock entry covers is itself a failure: an unfrozen
published directory is the unversioned surface this whole exercise exists to
prevent. `--freeze-revision` only ever ADDS a revision the lock has never seen.
There is no flag that unfreezes one, because the tool that could would be the
tool somebody reaches for at 6pm on a Friday.

### 5. Literal-constant lint

`revision.ts` **authors** a limit; `schema/<revision>/` **publishes** it;
`baseline/contract-baseline.<revision>.json` is **generated** from the published
bytes; everything else **reads** the generated file. Author, publish, generate,
consume — one direction, four steps, no step skippable.

- **5a** regenerating the baseline must reproduce the committed file byte for
  byte. This is what makes it *generated* rather than merely committed; without
  it, "read the number from the baseline" degrades into "read the number from a
  file somebody typed".
- **5b** every authored `CONTRACT_LIMITS` value must equal the published one.
  5a cannot catch a hand-edited schema, because the baseline is derived from the
  schemas and agrees with them by construction.
- **5c** no other file may restate a published number. The rule is narrow: `100`
  alone is not a finding — it is one of the commonest integers there is — but
  `100` on a line that also says `batch` or `items` is a restatement of
  `max_batch_items`, and the next time that cap moves it will move in the
  baseline and not here.

## The forks resolved here, and why

### The quarantine ledger, rather than fixing or exempting the legacy plane

The four drifts are on the 30-tool surface, which is scheduled for demolition in
this same run. Three options:

1. **Fix them.** Rewriting a surface that is about to be deleted, with behaviour
   risk on twenty-one input schemas, for zero durable benefit.
2. **Exempt the plane.** Then the gates are theatre on the one surface that
   demonstrably needed them.
3. **Quarantine with a ledger.** Chosen.

A quarantine is not a suppression, and the difference is the whole argument:

- the ledger holds **fingerprints** — `kind | file | sorted evidence` — so a
  finding whose *wording* improves still matches and one whose *substance*
  changes does not;
- the comparison is **equality, not containment**. New drift fails. Changed
  drift fails. Drift that was fixed while its row stayed behind fails, because a
  ledger describing defects that no longer exist is one nobody can trust, and the
  next reader assumes the remaining rows are equally stale;
- `enforcement: "enforced"` is a variant with **no ledger field at all**. The
  consumer plane cannot acquire an exception, because there is nowhere to put
  one. That is a type, not a policy;
- every detector a plane does *not* run must be recorded in `notApplicable` with
  a reason. A detector silently not running is indistinguishable from one that
  found nothing.

When the legacy surface is deleted, its registration goes with it. Deleting the
code and leaving the registration behind answers `plane-unreadable` rather than
passing quietly.

**Reversible in one line:** delete `LEGACY_PLANE` from
`packages/atlas-gates/src/registry.ts` and the plane is no longer gated at all.

### The line number is NOT part of a fingerprint

An earlier draft included it. Adding a comment above a constant then re-keyed
every finding below it and failed the build with a diff nobody could interpret.
A gate that cries wolf on an unrelated edit is a gate that gets switched off.
`detail` already separates two findings of the same kind in the same file,
because it holds the members or constants that make each one what it is. The
line still travels on the finding and still appears in the message.

### The corpus pins the ANSWER, not the ENVELOPE

Published output schemas are open and additive evolution is explicitly permitted
(ADR 0013). A corpus over the full response would therefore fail for a change the
contract allows. It records which claims matched, in what order, with what match
quality and world-time fidelity, the coverage counts, and the refusal code —
sensitive to every semantic change, stable under additive evolution. The envelope
is gate 2's job.

### The corpus carries an INDEPENDENT claim-digest implementation

`claim_digest` covers the claim core and nothing else, and every existing test of
it compares a stored digest against a freshly computed one from the same
function. Those tests move with the function. `independentClaimDigest` shares no
code with `atlas-core`: its own key-sorted serialiser, its own hash call, its own
list of the five permitted fields. Two implementations that agree tell you
something.

### Goldens canonicalise minted ids; the corpus records no timestamps at all

`mintEntityId` draws `randomBytes(16)` and must — ids are minted, never derived.
Random by design means different every run by design, so minted ids, digests over
them, and the signed `requestState` MAC are replaced by first-encounter labels.
Timestamps are deliberately NOT canonicalised: the fixtures drive a **constant**
clock, so belief-time stamps advance only where the store's own
`Math.max(now, last + 1)` guard advances them — once per commit, once per audit
event — which is exactly what a golden should notice.

### `include_superseded` was implemented rather than removed from the corpus

The corpus asked a question whose answer depended on a published input the
handler ignored. A declared parameter that is silently dropped is worse than one
never offered: the caller receives an answer to a question it did not ask and has
no way to tell. `AsOfQuery` gained an optional `include_superseded`, off by
default, composing with `as_of_recorded` rather than replacing it.

### 2026.08.0 is marked RELEASED, and that has teeth today

Any later stage of this run that needs a schema change must mint a new revision
directory. That is the requirement and it is also the lesson — but it will block
a stage that expects to regenerate `schema/2026.08.0/` in place. The failure
message names the remedy. **Reversible in one line:** remove the `2026.08.0`
entry from `released.lock.json`.

## Open questions

- **~~OPEN-1 — the git leg has no baseline yet.~~ RESOLVED 2026-08-04.** The
  schema directory is tracked, so the leg runs: `git_checked_revisions` now
  equals the number of released revisions rather than 0, and the hand-edit-plus-
  re-freeze hole is closed — a working-tree diff under a released revision fails
  regardless of what the lock file says.

  The gate is deliberately still tolerant of `no-baseline`, because it must run
  outside a git checkout (an exported tarball has no history to consult). That
  tolerance is what made the original condition silent, so the guard is a test
  rather than a gate failure: `gates.test.ts` asserts that in THIS repository
  every released revision is checked by the git leg. Gitignoring the schema
  directory would otherwise remove the second leg with every gate still green.
- **OPEN-2 — the operator plane's caps coincide with the consumer's.**
  `OPERATOR_LIMITS` holds `max_page_size: 200` and `default_page_size: 50`, the
  same values the consumer contract publishes, and they are deliberately
  independent numbers. They were moved into `operator/limits.ts` so the lint's
  exemption covers fifteen lines rather than six hundred. Whether the operator
  plane should publish its own machine-readable baseline is undecided.
- **OPEN-3 — the literal lint's context words are a heuristic.** It fires on an
  integer equal to a published limit on a line that also carries one of that
  limit's own words. Precise enough to catch every real copy in this repository
  and to reject the false positives that an earlier draft produced (`06` inside a
  date; `recorded` matched as `record`), but it is a heuristic and it can be
  fooled by a sufficiently indirect restatement.
- **OPEN-4 — parameter-level unimplementation is not detected.** Gate 1 catches a
  TOOL the catalog advertises and nothing serves. It does not catch a published
  ARGUMENT the handler ignores — `include_superseded` was found by the corpus, not
  by a detector. A general check would have to compare each published input
  property against the arguments a handler actually reads.

## Consequences

- `npm run check` gains `npm run gates` before `typecheck` and `test`. The gates
  also run inside vitest, so a developer running only the tests still gets them.
- `packages/atlas-gates/` depends on the legacy packages so it can probe them.
  Demolition must remove those dependencies and the plane registration together.
- Four artifacts are now normative and reviewed on change:
  `packages/atlas-gates/baseline/contract-baseline.2026.08.0.json`,
  `packages/atlas-gates/golden/*.json`, `packages/atlas-gates/corpus/answers.json`,
  and `packages/atlas-contract/schema/released.lock.json`.
- Recording is a separate command from checking and always will be:
  `--write-baseline`, `--write-goldens`, `--write-corpus`, `--freeze-revision`.
  A gate that silently re-records what it was supposed to be checking is a very
  expensive way of asserting `true`.
