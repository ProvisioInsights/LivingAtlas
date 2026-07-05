type:: schema
status:: draft v1 — endpoint/property support for temporal edges
authority:: implementation-guide.md is authoritative for full semantics
created:: 2026-06-21

- **Namespace:** `schema/properties` — node/page property conventions needed by the temporal edge model.
- **Purpose:** provide local endpoint/type validation inputs for `schema-edges.md`.
- **Schema map:** see `entity-temporal-schema-map.md` for how endpoint types,
  temporal facts, iCalendar recurrence, items, offerings, sources, and derived views fit
  together.
- ## Required endpoint type property
	- `type::` classifies a graph node/page for edge domain/range checks.
	- Implemented temporal edge endpoint values:
		- `person`
		- `organization`
		- `project`
		- `location`
		- `occurrence` — a thing that happened, is happening, or is scheduled to happen. Prefer this name over `event` so knowledge happenings are not confused with runtime audit/sync/change events.
		- `topic` — a controlled subject/theme node. Prefer this over broad `concept`; do not auto-create topics from every noun phrase.
		- `offering` — a reusable product, service, subscription, package, room type, travel class, ticket class, or experience.
		- `item` — a concrete device, document, ticket, reservation, receipt, seat, room, deliverable, or created work.
	- `event` is reserved for runtime/event-log language and should not be added as a temporal endpoint name.
	- `cluster` is not a persisted endpoint type. Topological clusters are derived dynamically from edges. Manual groups/cohorts should be modeled as `organization` or `project` nodes.
	- Broad `concept` and `source` are not temporal edge endpoints. Concepts remain storage/provenance/index concepts unless explicitly promoted through controlled schema rules; source/provenance remains metadata unless a concrete document, receipt, reservation, or file is intentionally promoted to `item`.
- ## Runtime mapping
	- `type::` is knowledge-schema metadata. It does not decide remote access.
	- Runtime access is controlled by `access_class`.
	- Runtime encryption is controlled by `encryption_class`.
	- Default imported nodes and edges are `access_class = local-private` unless explicitly classified otherwise.
- ## Mature migrated properties
	- `founded-year::` — organization/project attribute, not an edge.
	- `role::` — attribute on employment/governance/advisory edges where useful.
	- `relationship::` — prose texture attribute; do not promote directly to a predicate.
	- `relationship-origin::` — attribute describing how a relationship began.
	- `comparable-to::` — attribute, not V1 predicate.
- ## Changelog
	- 2026-06-21 v1: added local endpoint/property page so the temporal-edge package is self-contained.
