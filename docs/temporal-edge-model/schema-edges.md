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
	- Open attrs: any other `key:: value` (amount, role, condition, scope, relationship [prose], note...). Nuance never becomes a predicate.
- ## Endpoint types (valid `src`/`dst`)
	- `person`, `organization`, `project`, `location`, `cluster`. (`event` endpoints = open decision, default deferred to v1.1.)
- ## Value enums (closed)
	- `status::` = active | pending | ended | dormant (two-tier derivation, see `implementation-guide.md` §5.8) · `confidence::` = high | medium | low · `category` = employment | governance | advisory | capital | structural | customer | network | affiliation | geography | personal.
- ## Predicate registry v4-draft (empirically grounded — evidence column)

	| predicate | category | direction | domain -> range | required | evidence |
	|---|---|---|---|---|---|
	| employed-by | employment | dir (inv: employs) | person -> organization | valid-from | org-style affiliation, employer-* |
	| reports-to | employment | dir (inv: manages) | person -> person | valid-from | concept |
	| founder-of | employment | dir (inv: founded-by) | person -> organization, project | valid-from | renamed off `founded::` (which is a YEAR -> `founded-year::`) |
	| board-member-of | governance | dir (inv: board-includes) | person -> organization | valid-from | chair:: |
	| advises | advisory | dir (inv: advised-by) | person -> organization, project | valid-from | -advisory-past (use `scope::` attr, not `advises-on`) |
	| invests-in | capital | dir (inv: funded-by) | person, organization -> organization, project | amount, status | -fundraise-channel, -portfolio |
	| customer-of | customer | dir (inv: vendor-to) | organization -> organization | — | -revenue, -vendor, customer-of:: |
	| engaged | customer | dir | person -> organization | valid-from | customer roster (era engagements) |
	| acquired-by | structural | dir (inv: acquired) | organization -> organization | valid-from | acquired-by |
	| merged-with | structural | sym | organization -> organization | valid-from | NOT acquired-by (merger != acquisition) |
	| introduced-by | network | dir (inv: introduced) | person -> person | — | -warm-intro-* |
	| intro-path-to | network | dir | person -> organization, person | via | -fundraise-channel |
	| connects | network | sym | person -> person | note | -adjacent, -orbit — LAST-RESORT, requires `note::` |
	| member-of | affiliation | dir | person -> organization, cluster | — | cohort and cluster memberships |
	| alumnus-of | affiliation | dir | person -> organization | — | -education |
	| based-in | geography | dir | person, organization -> location | — | plain-text location/headquarters values |
	| spouse-of | personal | sym | person -> person | — | family fixture |
	| partner-of | personal | sym | person -> person | — | family fixture |
	| parent-of | personal | dir (inv: child-of) | person -> person | — | family fixture |
	| sibling-of | personal | sym | person -> person | — | family-branch |
	| related-to | personal | sym | person -> person | relation | kinship catch-all |
	| estranged-from | personal | sym | person -> person | — | family fixture |
	| mentor-of | personal | dir (inv: mentored-by) | person -> person | — | concept |

	- Attributes, NOT predicates: `role`, `founded-year`, `relationship` (prose), `relationship-origin`, `scope`, `comparable-to`. Symmetric predicates store once on normalized endpoints (sort by stable `id::`, NOT mutable slug).
- ## Alias map (canonicalize; NEVER silently reverse direction)
	- `works-at`/`works-for`/`employee-of` -> employed-by · `advisor-to`/`advisor` -> advises · `investor-in`/`backs` -> invests-in · `client-of` -> customer-of · `co-founded` -> founder-of · `married-to` -> spouse-of · `sits-on-board-of` -> board-member-of · `knows`/`connected-to` -> connects.
	- `portfolio-company-of` is direction-sensitive; reject it or echo the stored `invests-in` edge with swapped endpoints. `funded-by` is an inverse label for `invests-in`, not a forward predicate.
	- **Direction-safety (HARD):** voice-flipping aliases (`manages` -> reports-to; active-voice `acquired`/`bought` -> acquired-by) must NOT be silently reversed — reject with "use <canonical> + swapped endpoints, confirm direction," OR accept and ECHO the stored edge back. Inverse labels (`employs`, `manages`, `acquired`, `led-by`, `board-includes`) are rejected as forward `predicate::` values.
- ## Enforcement
	- Hard reject at `write_edge`; edge-scoped audit gate in `graph_audit_v2.py` (separate from the global `hard_violations` sum) with `LOGSEQ_EDGE_AUDIT=warn` escape; quarantine on batch.
- ## Changelog
	- 2026-06-17 v4: grounded registry to synthetic fixtures and private-corpus audit lessons; +location/cluster endpoints; +family/based-in/member-of/alumnus-of/merged-with; founded -> founder-of (+ founded-year attr); lazy system-time; tiered/edge-scoped enforcement; alias direction-safety.
	- 2026-06-17 v1: initial closed ontology (superseded).
