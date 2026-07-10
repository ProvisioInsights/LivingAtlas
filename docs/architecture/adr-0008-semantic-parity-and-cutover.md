# ADR 0008: Semantic Parity Coverage And Truth Resolution Are Separate

Status: Accepted for implementation planning
Date: 2026-07-09

## Context

The Logseq-derived corpus must reach 100 percent semantic parity in Atlas before
the migration workspace can be retired. Some source statements may remain
ambiguous even after research, and the owner may not know the missing real-world
answer.

Requiring every ambiguity to become a certain structured fact makes cutover
depend on unknowable information. Allowing ambiguous source units to disappear
would violate the no-data-loss requirement.

## Decision

Parity coverage and truth resolution are independent state axes.

Every source coverage unit has:

- `coverage_state`: `unrepresented` or `represented`;
- `representation_kind`: structured fact, relationship, occurrence, normalized
  text assertion, or unresolved observation;
- canonical object ids that preserve its meaning;
- source/evidence references; and
- a content-derived idempotency key.

Every review item separately has a `resolution_state`: `pending`,
`auto-applied`, `resolved`, `research`, `owner-review`, or `deferred-unknown`.

A source unit counts as represented only when a canonical Atlas record preserves
its meaningful content. If identity or truth is unknowable, an unresolved
observation may preserve the normalized assertion, ambiguity, surrounding
context needed to understand it, and provenance. It must not invent an entity,
relationship, date, or certainty.

Cutover requires:

1. zero `unrepresented` source units;
2. zero partially applied or failed resolution transactions;
3. every open `research`, `owner-review`, or `deferred-unknown` item to reference
   a represented canonical observation rather than only temporary source data;
4. every canonical object to decrypt and satisfy schema and referential checks;
5. no active canonical object to depend on a migration-only object;
6. successful idempotency, restart, backup, isolated restore, and parity-manifest
   comparison; and
7. owner acceptance of the final parity and open-resolution report.

The temporary encrypted migration workspace can be retired after those gates.
The original Logseq archive remains untouched until the owner separately
approves its retention or disposal. Open research can continue against canonical
unresolved observations after cutover.

## Consequences

Positive:

- Atlas can achieve complete semantic custody without fabricating knowledge.
- Genuinely unknowable items do not block migration forever.
- Open research remains visible and backed by canonical context.
- Parity reports measure preservation separately from certainty.

Negative:

- Some canonical records intentionally represent unresolved observations.
- The final cutover report must explain open resolution work, not only show one
  completion percentage.
- Review tooling must filter two state axes.

## Rejected Alternatives

### Require Zero Open Review Or Research Items

Rejected because unknowable real-world facts can make the gate impossible or
encourage false certainty.

### Count A Quarantined Migration Object As Parity

Rejected because the canonical graph would still depend on page/block/source
material slated for retirement.

### Skip Ambiguous Material

Rejected because it loses meaningful source content.

## Verification

- Parity reports distinguish unrepresented units from represented but unresolved
  observations.
- An ambiguous fixture reaches represented coverage without inventing a typed
  entity or relationship.
- Removing the migration workspace from an isolated copy does not break any
  canonical read, provenance link, or review item.
- Backup and restore reproduce coverage counts, resolution counts, canonical ids,
  and content hashes exactly.
