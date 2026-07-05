type:: schema
status:: draft v4 - registry to be finalized in Phase 0.5 against the suffix decode map
authority:: implementation-guide.md is authoritative for full semantics; this page is the graph-deployable summary
created:: 2026-06-17

- **Namespace:** `schema/edges` — the closed ontology for typed edges. Predicates are derived from synthetic fixtures plus a private-corpus audit whose paths, counts, and examples are redacted from the public repo.
- **Rule:** only registry predicates are valid. Enforcement is **hard at the typed-edge writer / import** (reject + suggest), **edge-scoped** in the pre-commit audit (never a global tripwire), and **quarantine** (`generated/unmapped-edges.jsonl`) on batch ingest. Prose and legacy props are not forced into the ontology (capture-all preserved). Adding/relaxing a predicate = a definition row here + a changelog line.
- ## Edge shape
	- One bullet in a reserved, machine-managed `## Edges` section on the source page. Bullet text = human-readable fact incl. the in-content `[[wikilink]]` (the `dst`). `key:: value` lines = spine + open attrs.
	- Spine (required unless noted): `predicate::` (registry) · object (the wikilink) · `valid-from::` (date or `unknown`) · `valid-to::` (absent = ongoing) · `status::` (DERIVED, machine-written) · `source::` (required).
	- **System time (`recorded-at`/`superseded-at`) is LAZY and lives in the event log, NOT on the page** — written only when a correction occurs.
	- Open attrs: any other non-reserved `key:: value` (amount, investment-status, role, condition, scope, relationship [prose], note...). Nuance never becomes a predicate.
- ## Endpoint types (valid `src`/`dst`)
	- Implemented endpoints: `person`, `organization`, `project`, `location`, `occurrence`, `topic`, `offering`, `item`.
	- Use `occurrence` for knowledge happenings. Prefer `occurrence` over `event` to avoid confusing graph happenings with runtime audit/sync/change events.
	- Use `topic` for controlled subjects/themes. Broad `concept` remains non-endpoint metadata until explicitly promoted to a controlled topic.
	- Use `offering` for reusable provider-facing products, services, subscriptions, packages, travel classes, hotel room types, and ticket classes.
	- Use `item` for concrete devices, documents, tickets, reservations, receipts, seats, rooms, deliverables, and created works.
	- Not endpoints: broad `concept`, `source`, `cluster`. Sources remain provenance/storage metadata, concepts are tags/indexes unless promoted, and clusters are derived views from edges.
- ## Value enums (closed)
	- `status::` = active | pending | ended | dormant (two-tier derivation, see `implementation-guide.md` §5.8) · `confidence::` = high | medium | low · `category` = employment | governance | advisory | capital | structural | customer | network | affiliation | geography | occurrence | taxonomy | commerce | creation | personal.
- ## Predicate registry v4-draft (empirically grounded — evidence column)

	| predicate | category | direction | domain -> range | required | evidence |
	|---|---|---|---|---|---|
	| employed-by | employment | dir (inv: employs) | person -> organization | valid-from | org-style affiliation, employer-* |
	| reports-to | employment | dir (inv: manages) | person -> person | valid-from | concept |
	| founder-of | employment | dir (inv: founded-by) | person -> organization, project, offering | valid-from | renamed off `founded::` (which is a YEAR -> `founded-year::`) |
	| board-member-of | governance | dir (inv: board-includes) | person -> organization | valid-from | chair:: |
	| advises | advisory | dir (inv: advised-by) | person -> organization, project, offering | valid-from | -advisory-past (use `scope::` attr, not `advises-on`) |
	| invests-in | capital | dir (inv: funded-by) | person, organization -> organization, project, offering | amount, investment-status | -fundraise-channel, -portfolio |
	| customer-of | customer | dir (inv: vendor-to) | organization -> organization | — | -revenue, -vendor, customer-of:: |
	| engaged | customer | dir | person -> organization | valid-from | customer roster (era engagements) |
	| acquired-by | structural | dir (inv: acquired) | organization -> organization | valid-from | acquired-by |
	| merged-with | structural | sym | organization -> organization | valid-from | NOT acquired-by (merger != acquisition) |
	| introduced-by | network | dir (inv: introduced) | person -> person | — | -warm-intro-* |
	| intro-path-to | network | dir | person -> organization, person | via | -fundraise-channel |
	| connects | network | sym | person -> person | note | -adjacent, -orbit — LAST-RESORT, requires `note::` |
	| member-of | affiliation | dir | person -> organization | — | cohort memberships |
	| alumnus-of | affiliation | dir | person -> organization | — | -education |
	| based-in | geography | dir | person, organization -> location | — | plain-text location/headquarters values |
	| spouse-of | personal | sym | person -> person | — | family fixture |
	| partner-of | personal | sym | person -> person | — | family fixture |
	| parent-of | personal | dir (inv: child-of) | person -> person | — | family fixture |
	| sibling-of | personal | sym | person -> person | — | family-branch |
	| related-to | personal | sym | person -> person | relation | kinship catch-all |
	| estranged-from | personal | sym | person -> person | — | family fixture |
	| mentor-of | personal | dir (inv: mentored-by) | person -> person | — | concept |

	- Attributes, NOT predicates: `amount`, `investment-status`, `role`, `founded-year`, `relationship` (prose), `relationship-origin`, `scope`, `comparable-to`. Symmetric predicates store once on normalized endpoints (sort by stable `id::`, NOT mutable slug).
	- Reserved spine fields must not appear as attrs: `predicate`, `valid-from`, `valid-to`, `status`, `confidence`, `source`, endpoint ids, and endpoint types. Edge lifecycle `status` is distinct from capital-specific `investment-status`.
	- Schedule/recurrence fields are attributes on a temporal edge or occurrence series, not predicates: `timezone`, `recurrence_set`, `duration`, `exceptions`. `recurrence_set` is the single RFC 5545 recurrence block for `DTSTART`, `RRULE`, `RDATE`, and `EXDATE`; `RRULE` requires `DTSTART`, and `TZID` must match `timezone`.
- ## Occurrence predicates

	| predicate | direction | domain -> range | meaning |
	|---|---|---|---|
	| participant-in | dir | person, organization -> occurrence | endpoint participated in the happening |
	| occurred-at | dir | occurrence -> location | happening took place at a location |
	| hosted | dir | person, organization -> occurrence | endpoint hosted the happening |
	| discussed-at | dir | organization, project, topic -> occurrence | entity/topic was discussed during the happening |
	| about | dir | person, organization, project, occurrence -> topic | entity/happening is about a controlled topic |
	| related-topic | sym | topic -> topic | controlled topic association |
	| part-of-topic | dir | topic -> topic | controlled topic hierarchy |
	| offered-by | commerce | dir | offering -> organization | provider relationship |
	| instance-of | commerce | dir | item -> offering | concrete item to model/class/offering |
	| purchased-from | commerce | dir | person, organization -> organization | purchase source |
	| purchased | commerce | dir | person, organization -> offering, item | purchased thing |
	| owns | commerce | dir | person, organization -> item | ownership |
	| created | creation | dir | person, organization -> item, offering | made thing |
	| created-for | creation | dir | item, offering -> person, organization, project, offering | beneficiary/client/context |

	These rows are active in the updated schema contract. Writers must still
	enforce the same access, policy, and leakage checks used by every other
	temporal edge.
- ## Alias map (canonicalize; NEVER silently reverse direction)
	- `works-at`/`works-for`/`employee-of` -> employed-by · `advisor-to`/`advisor` -> advises · `investor-in`/`backs` -> invests-in · `client-of` -> customer-of · `co-founded` -> founder-of · `married-to` -> spouse-of · `sits-on-board-of` -> board-member-of · `knows`/`connected-to` -> connects.
	- `portfolio-company-of` is direction-sensitive; reject it or echo the stored `invests-in` edge with swapped endpoints. `funded-by` is an inverse label for `invests-in`, not a forward predicate.
	- **Direction-safety (HARD):** voice-flipping aliases (`manages` -> reports-to; active-voice `acquired`/`bought` -> acquired-by) must NOT be silently reversed — reject with "use <canonical> + swapped endpoints, confirm direction," OR accept and ECHO the stored edge back. Inverse labels (`employs`, `manages`, `acquired`, `led-by`, `board-includes`) are rejected as forward `predicate::` values.
- ## Enforcement
	- Hard reject at `write_edge`; edge-scoped audit gate in `graph_audit_v2.py` (separate from the global `hard_violations` sum) with `LOGSEQ_EDGE_AUDIT=warn` escape; quarantine on batch.
- ## Changelog
	- 2026-06-24: added `offering` and `item` endpoints plus commerce/creation predicates for products/services, tickets/reservations/devices, purchases, ownership, and created works.
	- 2026-06-23: added controlled `topic` endpoint and taxonomy predicates (`about`, `related-topic`, `part-of-topic`); expanded `discussed-at` to topic -> occurrence.
	- 2026-06-23: documented the endpoint/fact split, the `occurrence` endpoint target, recurrence attributes, and artifact/source/concept deferral.
	- 2026-06-23: removed `cluster` as a first-class node type, updated `member-of` range to `organization` only, and made clusters derived query/view output instead of persisted endpoints.
	- 2026-06-17 v4: grounded registry to synthetic fixtures and private-corpus audit lessons; +location/cluster endpoints (`cluster` superseded 2026-06-23); +family/based-in/member-of/alumnus-of/merged-with; founded -> founder-of (+ founded-year attr); lazy system-time; tiered/edge-scoped enforcement; alias direction-safety.
	- 2026-06-17 v1: initial closed ontology (superseded).
