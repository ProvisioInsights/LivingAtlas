# Task 2 Report: Complete observations and deterministic typed projections

## Result

- Status: `DONE_WITH_CONCERNS`
- Starting commit: `adb346214d62761356a3ae04bde70aef4cfd3f5f`
- Implementation commit: `c931c40` (`feat(importer): project canonical source units`)
- Scope remained synthetic-only. No personal corpus content was read, printed, or added.

## Files

- `packages/contracts/src/knowledge.ts`
- `packages/contracts/src/knowledge.test.ts`
- `packages/importer/src/canonical-markdown-migration.ts`
- `packages/importer/src/canonical-markdown-migration.test.ts`

## TDD evidence

Each production behavior began with a focused failing test and was rerun after the smallest implementation change.

1. Predicate registry
   - RED: `pnpm vitest run packages/contracts/src/knowledge.test.ts -t "constrains measured direct-contact fact predicates"`
   - Result: 1 failed, 9 skipped; `phone` was rejected as an invalid predicate.
   - GREEN: same command.
   - Result: 1 passed, 9 skipped.

2. Occurrence-scoped unit observations
   - RED: `pnpm vitest run packages/importer/src/canonical-markdown-migration.test.ts -t "keeps repeated meaningful units"`
   - Result: 1 failed, 2 skipped; the migration returned one file placeholder instead of three unit observations.
   - GREEN: same command.
   - Result: 1 passed, 2 skipped.

3. Bounded long-unit custody
   - RED: `pnpm vitest run packages/importer/src/canonical-markdown-migration.test.ts -t "keeps a long meaningful unit complete"`
   - Result: 1 failed, 3 skipped; Zod rejected a statement over 8,192 characters.
   - GREEN: same command.
   - Result: 1 passed, 3 skipped.

4. Exact provenance and exact unique wiki candidates
   - RED: `pnpm vitest run packages/importer/src/canonical-markdown-migration.test.ts -t "binds observation candidates"`
   - Result: 1 failed, 4 skipped; candidates were empty and the typed unit remained `research`.
   - GREEN: same command.
   - Result: 1 passed, 4 skipped.

5. Measured direct facts
   - RED: `pnpm vitest run packages/importer/src/canonical-markdown-migration.test.ts -t "emits only parseable measured direct fields"`
   - Result: 1 failed, 5 skipped; no facts were emitted.
   - GREEN: same command.
   - Result: 1 passed, 5 skipped.

6. Extractor-proven relationships and unit evidence
   - RED: `pnpm vitest run packages/importer/src/canonical-markdown-migration.test.ts -t "emits extractor-proven relationships"`
   - Result: 1 failed, 6 skipped; relationships still used derived generic evidence rather than unit evidence.
   - GREEN: same command.
   - Result: 1 passed, 6 skipped.

7. Additive review proposals and observation-only parity
   - RED: `pnpm vitest run packages/importer/src/canonical-markdown-migration.test.ts -t "keeps typed projections additive"`
   - Result: 1 failed, 7 skipped; the review proposed observations only, omitting entity/fact/relationship projections.
   - GREEN: same command.
   - Result: 1 passed, 7 skipped.

8. Explicit typed-relationship review routing
   - RED: `pnpm vitest run packages/importer/src/canonical-markdown-migration.test.ts -t "routes an explicit typed-relationship source"`
   - Result: 1 failed, 8 skipped; an edge-only typed source was routed to `research`.
   - GREEN: same command.
   - Result: 1 passed, 8 skipped.

Compatibility pass:

- `pnpm vitest run packages/contracts/src/knowledge.test.ts packages/importer/src/canonical-markdown-migration.test.ts`
- First result after the feature cycles: 16 passed, 2 failed. Both failures were obsolete assertions that combined lossless and unit evidence or expected one placeholder observation; the tests were corrected to assert the new contract.
- Final result: 19 passed, 0 failed.

Compiler pass:

- RED: `pnpm typecheck`
- Result: test-only discriminated-union narrowing errors in new evidence/parity filters.
- GREEN: `pnpm typecheck`
- Result: `tsc --noEmit`, exit 0.

## Final verification

- Required command: `pnpm vitest run packages/contracts/src/knowledge.test.ts packages/importer/src/canonical-markdown-migration.test.ts`
  - 2 files passed, 19 tests passed, 0 failed.
- Repository suite: `pnpm test`
  - 120 files passed, 646 tests passed, 0 failed.
- Type checking: `pnpm typecheck`
  - Exit 0.
- Patch hygiene: `git diff --check`
  - No output; exit 0.

## Self-review

- Added only `phone:text`, `email:text`, `address:text`, `birth-date:date`, and `last-contacted:date|timestamp`.
- Every meaningful unit produces one or more bounded observations. Repeated identical units use source- and occurrence-scoped evidence/observation/fact IDs.
- Full-file evidence remains `canonical-markdown-lossless-v1`; unit evidence is separately marked `canonical-source-unit-v1` with unit hash, occurrence, and excerpt index in its locator.
- Unit observations reference their unit evidence plus the file's lossless evidence so Task 3 can separate exact source custody from destination mapping.
- Primary subjects resolve only through an exact extractor `source_path_ref`. Wiki references resolve only through a unique normalized exact typed title or alias; collisions, fuzzy references, and missing references remain unresolved.
- Facts require an exact typed primary subject and a schema-parseable allowlisted value. Invalid labeled values remain observations.
- Relationships come only from `extractLogseqTypedSemantics`, require existing endpoints with matching types, use the most specific unique unit evidence available, and otherwise fall back to lossless file evidence. Importer-only source-capsule attributes are not copied into canonical relationships.
- Typed entities, facts, and relationships are additive review proposals. Parity remains `representation_kind: observation` and names only the complete observation set.
- Typed endpoint or explicit typed-relationship sources remain unresolved `owner-review`; wholly untyped sources remain `research`.
- No event projection or prose relationship inference was added. Export access classification remains `local-private` for every canonical record.

## Concerns

- When repeated source units support the same extracted relationship and the extractor exposes no occurrence ordinal, the migration deliberately falls back to lossless file evidence instead of guessing one unit. Task 3 therefore cannot claim a unique unit-to-edge mapping for that ambiguous case.
- The requested independent read-only reviewer did not return before the controller's wrap deadline. Fresh focused/full tests, type checking, self-review, and the parent controller review gate remain available as evidence.
