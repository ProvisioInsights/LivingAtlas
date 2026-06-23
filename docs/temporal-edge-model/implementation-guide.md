# Temporal Edge Model Implementation Guide

**Status:** ready to implement · **Version:** v4  
**Audience:** engineers implementing Living Atlas import, edge, event, and
query behavior  
**Companions in this folder:** `temporal-edge-model-SPEC.md` (design
rationale), `schema-properties.md`, `schema-edges.md`, `schema-events.md`
(deploy-ready ontology pages)

---

## Integration note for Living Atlas V1

This package governs the **knowledge semantics** of Living Atlas: predicates,
events, bitemporal time, migration rules, and ontology enforcement.

It does **not** govern the final runtime/storage/security architecture. Living
Atlas architecture docs under `docs/architecture/` govern Cloudflare custody, local
replicas, encryption, sync, MCP access, audit, conflict handling, and privacy
boundaries.

The markdown-first language below describes the existing Logseq migration path
and human-readable compatibility format. In Living Atlas V1, the runtime uses
object envelopes, access classes, encryption classes, manifests, change logs,
and local/remote MCP policy. See
`docs/architecture/knowledge-schema-runtime-integration.md`.

Safe defaults now accepted for V1:

- `event` as edge endpoint: defer to V1.1
- dormancy threshold: 365 days without `contact` or `engagement`
- `comparable-to`: attribute, not predicate
- edge embeddings: deferred

Do not run the real graph migration first. Start with synthetic fixtures that
exercise both temporal semantics and the Cloudflare/local privacy model.

---

## 0. Read Me First

**Source graph to migrate from:** a private Logseq/Obsidian-style knowledge
graph. Public examples must use synthetic fixtures. Private source paths,
corpus sizes, and source-specific examples stay outside this repository.

**Order of work:** §10 is the phased plan. Do not turn on hard enforcement until the vocabulary is reconciled against synthetic fixtures and then a private local corpus (Phase 0–1). Read §9 (gotchas) before writing any code; several spec assumptions may be false against a legacy MCP.

---

## 1. Goal

Turn untyped `[[wikilinks]]` into **typed, dated, attribute-bearing edges with
bitemporal time**, derived from markdown import sources, so the system can
answer: *what is/was true on date T*, *what did we know on date T*, and *trends
over time*. Output feeds authorized Living Atlas viewers, MCP tools, and
query/index surfaces.

## 2. Architecture & migration source

- In the existing Logseq workflow, markdown is the migration source and
  human-readable compatibility format. Edges can be represented in markdown as
  block properties during migration/import.
- In Living Atlas V1, runtime authority is governed by the Living Atlas
  architecture:
  object envelopes, access classes, encryption classes, Cloudflare custody,
  local replicas, manifests, change logs, and MCP policy.
- Legacy write discipline still matters: one audited write path, file locks,
  atomic writes, bounded batch sizes, and dangling-link validation. The local
  MCP should preserve those properties rather than treating markdown import as
  an unguarded file rewrite.
- Viewer/Atlas surfaces read generated/indexed graph views and must not bypass
  MCP/policy for writes.
- No production database is required for the first semantic spike. Any database
  or object store projection must remain rebuildable from graph objects and
  change history.
- The importer may promote a Logseq `## Edges` line directly into an encrypted
  temporal edge only when the line names both endpoint types explicitly, for
  example `[[Person]] (person) advises [[Project]] (project) from 2026-06`.
  Lines without enough endpoint typing stay encrypted edge candidates; unsafe
  direction aliases stay quarantined.

## 3. Locked decisions (v4)

1. Edges stored **directed**, traversed both ways. One row per relationship, canonical `src -> predicate -> dst`. Symmetric predicates store once on normalized endpoints.
2. **Typed spine + open attribute bag.** Required spine + free attrs. Nuance goes in attrs, never a new predicate.
3. **Hard ontology** (closed predicate vocab, enforced domain/range, required attrs, closed enums) — but **reached empirically**: derive/confirm the vocab from synthetic fixtures and a private local corpus before locking. Enforcement is **hard at the typed-edge writer / import**, with the pre-commit audit **edge-scoped** (not a global tripwire) so one bad legacy row can't block unrelated commits. Prose and legacy non-edge props are not forced into the ontology (capture-all preserved).
4. **Bitemporal, but lazy.** `valid-from`/`valid-to` (world time) on every edge. System/knowledge time (`recorded-at`/`superseded-at`) is **written only when a correction happens, and lives in the event log, not the page** (keeps machine timestamps out of human-edited files).
5. **States are spans; occurrences are instants.** An edge is a state (interval); an event is an occurrence (instant). A forming moment yields BOTH (an event + an open-span edge). Nothing is stored as a zero-length interval.
6. **Invalidate, never delete.** Corrections close the old (valid-time) and append the new; the prior fact stays queryable.
7. **Mixed-precision dates** (`2018-06-07` / `2018-06` / `2017` / `~2015` / `unknown`), with defined comparison semantics (§5.7).
8. **Field names (locked):** edges `valid-from`/`valid-to` + (lazy) `recorded-at`/`superseded-at`; events `occurred-on` (+ `occurred-until`).
9. **Markdown-first migration; hubs-first scope** (do not rewrite an entire private corpus at once; promote where time/attributes matter).

## 4. Private Corpus Scan Findings (Redacted)

This section keeps the ontology lessons from a private corpus audit while
redacting source paths, exact corpus size, exact counts, and personal examples.

**Candidate predicates = property keys that carry a `[[wikilink]]` (clean, non-bak):**

| key | prevalence | meaning |
|---|---|---|
| `org` | high | primary org affiliation (the workhorse; mostly person -> employer). Migrate FIRST. |
| `tags` (with wikilink) | high | the messy bucket — includes the suffix-hacks below |
| `source` | medium | provenance, NOT a relationship edge |
| `role` | medium | role string (attribute, may contain an org link) |
| `relationship` | medium | **prose** relationship text (keep as texture attr, do not type) |
| `employer-historical` | low | -> `employed-by` (ended) |
| `acquired-by` | low | -> `acquired-by` |
| `relationship-origin` | low | attribute (how the relationship began) |
| `employer-current` | low | -> `employed-by` (active) |
| `spouse` | low | -> `spouse-of` |
| `parent` | low | -> `parent-of` |
| `chair` | low | -> `board-member-of` (chair role attr) |
| `customer-of`, `estranged-from`, `friend-group`, `family-cluster`, `family-branch`, `also-known-as` | sparse | present but sparse in the private corpus |

**Takeaway:** `org::` is the highest-volume migration path. Many genuinely
semantic predicates are sparse, and much of the relationship signal is in the
suffix-hacks. This is why the vocabulary must be derived, not guessed.

**`founded::` is a YEAR, not an edge** (`founded:: 2016`, `2020`, `2007`, `2025-07`). **Collision:** the spec wanted `founded` as a person->org predicate. RESOLUTION: rename the attribute to `founded-year::` (org attribute); use `founder-of` (person -> org/project) for the edge. Do this before enforcement or it rejects legit data.

**Suffix-hack inventory** (`[[Entity]]-suffix` on `tags::`, authored from the counterparty side, so usually INVERSE direction). Decode map for migration:

| suffix | -> predicate |
|---|---|
| `-employer-past` | `employed-by` (valid-to set; reverse direction) |
| `-education` | `alumnus-of` |
| `-cohort` | `member-of` |
| `-revenue` | `customer-of` |
| `-adjacent` | `connects` (weak tie) |
| `-orbit` | `connects` (weak tie) |
| `-fundraise-channel`, `-warm-intro-*` | `intro-path-to` / `introduced-by` |
| `-comparable`, `-fundraise-comparable` | `comparable-to` attribute |
| `-vendor` | `customer-of` (inverse) / `vendor-to` |
| `-portfolio` | `invests-in` (check direction; `funded-by` is inverse label only) |
| `-advisory-past` | `advises` (ended) |
| `-side-business-past` | `founder-of` / `member-of` (ended) |

**Geography:** private corpus pages carry **plain-text** `location::`/`headquarters::` values that are not always wikilinked to location nodes. These want `based-in -> location` edges after the strings are resolved/linked. High-leverage for a spatial 3D viewer.

**Family/personal keys:** use synthetic fixtures to test family predicates before private migration. Private-corpus prevalence is intentionally redacted.

## 5. The data model (final)

### 5.1 Edge shape

An edge is **one bullet inside a reserved, machine-managed `## Edges` section** on the source page (NOT inline in prose — see §9 for why). Bullet text = human-readable fact incl. the in-content `[[wikilink]]` (the `dst`, preserves native backlinks). `key:: value` lines under it = spine + open attrs. Synthetic example (`Alex Rivera.md`):

```
## Edges
- invests-in [[Example Labs]] — synthetic LOI, contingent
  predicate:: invests-in
  valid-from:: 2026-05-01
  status:: pending
  amount:: synthetic
  investment-status:: pending
  condition:: operator confirmed scope
  source:: synthetic fixture
```

Spine (required unless noted): `predicate::` (registry); object (the wikilink); `valid-from::` (date or `unknown`); `valid-to::` (absent = ongoing); `status::` (derived, machine-written); `source::` (required). **System time is NOT in the page** — it lives in the event log, written only on correction. Open attrs may use non-reserved keys such as `amount`, `investment-status`, `role`, `via`, `relation`, `note`, `scope`, `condition`, `relationship`, `relationship-origin`, and `comparable-to`.

### 5.2 Predicate registry v1 (empirically grounded — evidence in the right column)

| predicate | category | direction | domain -> range | required | evidence |
|---|---|---|---|---|---|
| employed-by | employment | dir (inv: employs) | person -> organization | valid-from | org-style affiliation, employer-* |
| reports-to | employment | dir (inv: manages) | person -> person | valid-from | concept; rare today |
| founder-of | employment | dir (inv: founded-by) | person -> organization, project | valid-from | renamed off founded:: collision |
| board-member-of | governance | dir (inv: board-includes) | person -> organization | valid-from | chair-style governance role |
| advises | advisory | dir (inv: advised-by) | person -> organization, project | valid-from | -advisory-past |
| invests-in | capital | dir (inv: funded-by) | person, organization -> organization, project | amount, investment-status | -fundraise-channel, -portfolio |
| customer-of | customer | dir (inv: vendor-to) | organization -> organization | — | -revenue, -vendor, customer-of |
| engaged | customer | dir | person -> organization | valid-from | customer roster (era engagements) |
| acquired-by | structural | dir (inv: acquired) | organization -> organization | valid-from | acquired-by |
| merged-with | structural | **sym** | organization -> organization | valid-from | split from acquired-by (not a merger) |
| introduced-by | network | dir (inv: introduced) | person -> person | — | -warm-intro-* |
| intro-path-to | network | dir | person -> organization, person | via | -fundraise-channel |
| connects | network | **sym** | person -> person | note | -adjacent, -orbit (LAST-RESORT, requires note) |
| member-of | affiliation | dir | person -> organization | — | cohort memberships |
| alumnus-of | affiliation | dir | person -> organization | — | -education |
| based-in | geography | dir | person, organization -> location | — | plain-text location/headquarters values |
| spouse-of | personal | **sym** | person -> person | — | family fixture |
| partner-of | personal | **sym** | person -> person | — | family fixture |
| parent-of | personal | dir (inv: child-of) | person -> person | — | family fixture |
| sibling-of | personal | **sym** | person -> person | — | family-branch |
| related-to | personal | **sym** | person -> person | relation | kinship catch-all |
| estranged-from | personal | **sym** | person -> person | — | family fixture |
| mentor-of | personal | dir (inv: mentored-by) | person -> person | — | concept |

Demote `advises-on` to a `scope::` attribute on `advises` (don't make it a predicate). `role`, `founded-year`, `relationship` (prose), `relationship-origin`, `comparable-to` are **attributes**, not predicates.

### 5.3 Endpoint types

Implemented edge endpoints (from `schema-properties.md` `type::`): **person, organization, project, location, occurrence, topic**. `location` was ADDED vs the earlier draft (location for `based-in`).

Use **occurrence** for knowledge happenings
such as a meeting, appointment, trip, dinner, visit, party, or other bounded
thing that happened or is scheduled to happen. Prefer `occurrence` over
`event` so knowledge happenings do not collide with runtime audit/sync/change
events.

Use **topic** for controlled subjects/themes that need traversal, for example
when a subject was discussed at an occurrence or a project is about a durable
theme. Prefer `topic` over broad `concept`; do not auto-create topics from
every noun phrase or model-generated keyword.

Deferred/non-endpoint concepts:

- `artifact`: stored/encrypted evidence or content first; graph endpoint later
  after artifact predicates and leakage rules are designed.
- broad `concept`: tag/index/attribute unless explicitly promoted to controlled `topic`.
- `source`: provenance metadata (`source`, `source_ref`, `source_path_ref`),
  not a relationship endpoint.
- `cluster`: not persisted; derived dynamically from graph edges. Manual
  cohorts/groups should be represented as `organization` or `project` nodes.

### 5.3.1 iCalendar recurrence and schedules

Recurring patterns must not create infinite future occurrence objects.

Use `schedule` on the temporal edge attrs and `recurrence` on an occurrence
series. Each contains a `recurrence_set` value: a
newline-delimited RFC 5545 recurrence block containing only `DTSTART`, `RRULE`,
`RDATE`, and `EXDATE` lines. Do not split those values across separate
ad hoc fields.

| field | meaning |
|---|---|
| `timezone` | IANA timezone required for local recurring times |
| `recurrence_set` | RFC 5545 recurrence lines; must include at least one `RRULE` or `RDATE`; `RRULE` requires `DTSTART`; any `TZID` must match `timezone` |
| `duration` | RFC 5545 planned duration such as `PT2H` or `P1D` |
| `exceptions` | canceled, moved, skipped, or extra instances |

Materialize a concrete occurrence only when it actually happens, is edited,
is canceled, needs audit, has participants/details, or is needed as evidence.

### 5.4 Enums (closed)

`status` = active | pending | ended | dormant · `confidence` = high | medium | low · `category` = employment | governance | advisory | capital | structural | customer | network | affiliation | geography | occurrence | taxonomy | personal.

Occurrence and topic predicates:

| predicate | category | direction | domain -> range | required | meaning |
|---|---|---|---|---|---|
| participant-in | occurrence | dir | person, organization -> occurrence | — | endpoint participated in the happening |
| occurred-at | occurrence | dir | occurrence -> location | — | happening took place at a location |
| hosted | occurrence | dir | person, organization -> occurrence | — | endpoint hosted the happening |
| discussed-at | occurrence | dir | organization, project, topic -> occurrence | — | entity/topic was discussed during the happening |
| about | taxonomy | dir | person, organization, project, occurrence -> topic | — | entity/happening is about a controlled topic |
| related-topic | taxonomy | sym | topic -> topic | — | controlled topic association |
| part-of-topic | taxonomy | dir | topic -> topic | — | controlled topic hierarchy |

### 5.5 Alias map (canonicalize synonyms; NEVER silently reverse direction)

`works-at`/`works-for`/`employee-of`/`job-at` -> employed-by · `advisor-to`/`advisor` -> advises · `investor-in`/`backs` -> invests-in · `client-of` -> customer-of · `co-founded` -> founder-of · `married-to` -> spouse-of · `sits-on-board-of` -> board-member-of · `knows`/`connected-to` -> connects.

`portfolio-company-of` is direction-sensitive and must not silently canonicalize
to `invests-in`; reject it or echo the stored `invests-in` edge with swapped
endpoints. `funded-by` is an inverse label for `invests-in`, not a forward
predicate.

**Direction-safety (HARD RULE):** any alias whose voice flips subject/object (`manages` -> reports-to; active-voice `acquired`/`bought` -> acquired-by) must NOT be silently reversed. The writer must either (a) reject with "use `<canonical>` with swapped endpoints, confirm direction," or (b) accept and **echo the stored edge back** (`stored: Person A -> reports-to -> Person B`) so the reversal is visible and auditable. Inverse labels (`employs`, `manages`, `acquired`, `led-by`, `board-includes`) must be rejected as forward `predicate::` values.

### 5.6 Event shape + kind registry

Events are dated journal bullets tagged `#event` in the migration/compatibility
format. In Living Atlas runtime, temporal events become graph objects or
change/audit records wrapped in runtime envelopes. A generated
`generated/events.jsonl` mirror may exist for Logseq compatibility, but it is
rebuildable and not the runtime master. Fields: `subject` (wikilink, req),
`kind::` (enum, req), `occurred-on::` (world instant, mixed precision, req),
`occurred-until::` (multi-day, opt), `recorded-at::` (system, machine),
`predicate::`/object (opt, the edge it forms/ends), `source::` (req),
`detail::` (opt), `supersedes::` (list; req when kind=correction|split).

Kinds (closed): relationship-formed · stage-change · role-change · engagement · org-change · life-event · contact · observation · correction · invalidate · **split** (backdated period-split, see 5.9).

### 5.7 Time semantics (the part the review found underspecified — implement exactly)

- **Half-open intervals `[from, to)`.** `valid-to`/`superseded-at` is the first instant the fact is NO LONGER true (exclusive). To end "through 2022," write `valid-to:: 2023`. Successor edges set `valid-from` = predecessor's `valid-to` (no overlap, no gap).
- **Mixed precision: never compare raw strings.** On read, expand every WORLD-time value to `(lo, hi, confidence)` half-open ISO bounds:
  - `2018-06-07` -> `[2018-06-07, 2018-06-08)` · `2018-06` -> `[2018-06-01, 2018-07-01)` · `2017` -> `[2017-01-01, 2018-01-01)` · `~2015` -> same bounds as `2015` **plus `confidence=low`** (the `~` is confidence-only; it does NOT widen the interval) · `unknown` -> `lo = -infinity` (so a known `valid-to` still bounds the right side).
  - **Ordering:** use the interval's **lower bound** with an optimistic bias (an era starts at its earliest consistent instant). `active as-of T`: `from.lo <= T AND (valid_to IS NULL OR T < to.lo)`.
  - **Three-valued comparison:** partial-vs-partial where neither interval contains the other resolves to **`uncertain`**, never silently true/false (this is the NULL-logic analogue; surface `uncertain` in results).
- **System time is always a full machine timestamp** (never mixed precision / `~`).

### 5.8 Status derivation (two-tier — NOT purely date-derived)

- `active` / `ended`: derived from valid-time vs now.
- `pending`: NOT date-derivable; set by a `stage-change` event (e.g. an `invests-in` whose condition is unmet). Do not hand-set `status:: pending` in a page as the source of truth; emit a `stage-change`.
- `dormant`: derived from **last-activity event + a threshold constant** (default: no `contact`/`engagement` event for **365 days**). Configurable; document the constant.

### 5.9 Corrections, invalidation, reinstatement, period-splitting

- **Correction** (we were wrong, same world-fact): close the old edge's system-time (`superseded-at` in the event log), append the corrected edge; emit a `correction` event with `supersedes`. Correction events carry the **full** replacement fields (compensating event, not a delta) so replay is deterministic last-write-wins.
- **Invalidation** (fact stopped being true): set `valid-to`; emit `invalidate` event.
- **Reinstatement** (ended then resumed): a **new edge with a disjoint valid span** — never re-open the old edge, never a correction. Disambiguator: same `valid-from` + contradictory content = correction; later `valid-from` after a closed prior span = reinstatement.
- **Backdated period-split** (e.g. recorded `employed-by Example Corp 2017->open`, later learn it ended 2021): emit a `split` event; supersede the original; write replacement edges that **tile the original `[from,to)` exactly** (no gap/overlap) with the corrected sub-interval carrying the new fact. `supersedes::` is a list. The audit checks exact tiling. This is the class of case synthetic era-backfill fixtures should cover.
- **Replay order:** by `recorded-at` (system time, total order); ties by event id. World-time is payload, never the replay order.

## 6. Hard ontology + enforcement

- **Hard at the typed-edge writer / import:** `write_edge` rejects any edge whose predicate is unregistered, domain/range is violated, a required attr is missing, or an enum value is invalid — with the nearest alias/suggestion. This is where "no randomness for same-type edges" is enforced, and where the controlled import works piece by piece.
- **Edge-scoped audit, not a global tripwire:** `graph_audit_v2.py` must NOT fold edge violations into its global `hard_violations` sum (that bricks all commits on one bad row). Add a SEPARATE edge gate that fails only on edges inside `## Edges`, with an env escape (`LOGSEQ_EDGE_AUDIT=warn`) for mid-migration.
- **Quarantine, never drop:** batch/derivation violations go to `generated/unmapped-edges.jsonl` + a review surface.
- **Capture-all preserved:** the ontology governs only the typed-edge projection. Prose, journal events, and legacy props still capture anything; promotion to a typed edge is what's gated.

## 7. MCP build scope (this is NET-NEW code, not a tweak)

The current MCP **cannot read or write block properties** — `PROP_RE` deliberately disallows leading whitespace, the parser is frontmatter-only, and the adjacency it builds is untyped. So:
- Add a dedicated **`write_edge`** + **`read_edges`** tool pair with their OWN block-property parser. **Do NOT extend `PROP_RE`** (it would break the body-safety guarantee every other tool relies on).
- Edges live in a reserved, machine-managed **`## Edges`** section the edge tools own exclusively (humans/other agents never hand-edit inside it). This avoids `update_body_section`'s line-slice surgery severing block-property contiguity.
- Honor the existing discipline: file lock, atomic write, git-guard, dangling-link validation.
- Resolve the `founded::` -> `founded-year::` collision (migration script) before enabling the `founder-of` predicate check.
- The Atlas has **no time field today**; "upgrade timeline replay" is also real work, not a tweak.

## 8. Migration plan (controlled, piece-by-piece, mostly OUT-OF-BAND)

The git guard caps at **`GIT_MAX_CHANGED_FILES=25`**, so bulk migration must run as a standalone script over raw `.md` committing in batches, NOT through the per-write MCP path. Order:
1. **`founded::` -> `founded-year::`** rename (org attribute) + reserve `founder-of` edge.
2. **`org::`-style affiliation fields** -> `employed-by` / `member-of` edges (per page type), keeping the legacy `org::` in a dual-write window until the projection is trusted.
3. **`acquired-by`, `employer-current/historical`, and family/person relationship fields** -> typed edges after fixture validation.
4. **Suffix-hacks** -> typed edges via the §4 decode map; flip direction (they're authored from the counterparty side); human-review the suffix->predicate mapping. This is the bulk of the effort.
5. **`location::`/`headquarters::` plain-text values** -> resolve/link to location nodes, then emit `based-in` edges.
Big-bang migration through the MCP is forbidden because it has too much
blast-radius and too many filesystem/sync edge cases for a first pass.

## 9. Known constraints & gotchas (READ BEFORE CODING)

- **`PROP_RE` is frontmatter-only by design** — block props are invisible to it. (§7)
- **`update_body_section` does tab-depth line surgery** — will sever an edge's `predicate::` from its bullet if it inserts between them. Use the dedicated edge tools + reserved section.
- **git guard: 25-file cap** — bulk ops go out-of-band.
- **Cloud-synced filesystem backing** — hidden file artifacts, hydration latency,
  and partial-sync risk on big rewrites can make mtime-based cache invalidation
  less reliable. Rebuild projections in one pass; add a fingerprint so the
  Atlas refuses a projection older than the source files.
- **`graph_audit_v2.py` hard-fail is a GLOBAL sum** — must be made edge-scoped (§6).
- **Atlas/public view leakage** — viewer projections must not expose absolute
  paths or denied properties. Add a deny-by-default redaction boundary before
  any viewer consumes edges carrying fields such as `amount`, `condition`, or
  `note`.
- **One runtime source** — use this repository's graph object model and
  projection pipeline as the source for new Living Atlas implementations.
- **Two sources of truth risk** — for migration, markdown is an import/export
  format; for Living Atlas runtime, graph objects and change history are the
  authoritative runtime representation. Do not let markdown sidecars, JSONL,
  indexes, or Atlas copies become independent masters.

## 10. Phased plan + acceptance criteria

- **Phase 0 — synthetic spike (no enforcement).** Build a synthetic fixture set
  that exercises the §5.1 edge blocks, event bullets, mixed-precision dates,
  suffix-hack decode cases, `founded-year` collision, and sensitive
  local-private examples. Write a throwaway parser that runs the §5.7 as-of
  (valid + lazy knowledge) and a trend query. **Accept when:** the synthetic
  cases return correct temporal answers and local-private facts do not appear
  in remote-readable projections.
- **Phase 0.1 — controlled real-sample proof.** After synthetic leakage/policy
  checks pass, test against a small operator-approved sample from the real
  graph. Do not bulk rewrite real files in this phase.
- **Phase 0.5 — reconcile.** Run the founded rename; finalize the suffix->predicate decode with the operator; lock the v1 registry in `schema-edges.md`. **Accept when:** every §4 suffix + `org::` pattern has a target predicate or an explicit "stays prose" decision.
- **Phase 1 — MCP edge tools.** Build `write_edge`/`read_edges` + block-prop parser + `## Edges` section; edge-scoped audit checks (warn-escapable). **Accept when:** an out-of-ontology edge is rejected with a suggestion; a valid edge round-trips; `graph_audit` fails ONLY on bad edges, not the whole repo; direction-flipping aliases echo the stored edge.
- **Phase 1.5 — bulk migrate (out-of-band).** `org::` first, dual-write; then low-count props; then suffix-hacks; then `based-in`. **Accept when:** projection matches a hand-audited sample of 20 hubs; legacy props retained.
- **Phase 2 — Atlas.** Pick one Atlas; add redaction boundary; point at the projection; build the bitemporal scrubber + edge-record panel. **Accept when:** valid-time scrubber + knowledge lens render from synthetic fixtures first and private local data only after the redaction boundary passes; no absolute paths or denied props cross the boundary.
- **Phase 3 — flip to hard + optional DB.** Turn the edge writer hard once the vocab is stable. Add DuckDB only if query/Atlas perf demands.

## 11. Resolved defaults for V1

1. Allow `event` as an edge endpoint (`attended`/`spoke-at`) in v1: defer to V1.1.
2. Dormancy threshold: 365 days without `contact` or `engagement`.
3. `comparable-to` (the `-comparable` hacks): attribute, not predicate.
4. Embeddings on edges for hybrid retrieval: deferred.

## 12. Sources

Design rationale: `temporal-edge-model-SPEC.md` (this folder). Cross-checked against: Zep/Graphiti (arxiv 2501.13956; bitemporal valid_at/invalid_at + created_at/expired_at, invalidate-not-delete), XTDB (valid + system time, FOR VALID_TIME / SYSTEM_TIME AS OF, FOR PORTION OF splitting), SQL:2011 temporal tables, Neo4j (directed-store/traverse-both, edge properties), Fowler event sourcing, synthetic fixtures, and redacted private-corpus audit lessons in §4.
