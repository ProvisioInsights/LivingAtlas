type:: schema
status:: draft v1 — endpoint/property support for temporal edges
authority:: implementation-guide.md is authoritative for full semantics
created:: 2026-06-21

- **Namespace:** `schema/properties` — node/page property conventions needed by the temporal edge model.
- **Purpose:** provide local endpoint/type validation inputs for `schema-edges.md`.
- ## Required endpoint type property
	- `type::` classifies a graph node/page for edge domain/range checks.
	- V1 valid endpoint values:
		- `person`
		- `organization`
		- `project`
		- `location`
		- `cluster`
	- `event` endpoint values are deferred to V1.1.
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
