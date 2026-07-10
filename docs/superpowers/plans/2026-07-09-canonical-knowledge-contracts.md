# Canonical Knowledge Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement issue #44's versioned canonical entity, assertion,
relationship, evidence, identity-resolution, review, parity, and portable
export contracts without changing legacy migration output.

**Architecture:** Add a `knowledge.ts` contract module inside
`@living-atlas/contracts`. It defines encrypted-payload shapes and maps each
payload to a non-legacy runtime object type. A narrow importer adapter converts
an already-normalized legacy endpoint to `atlas.entity:v1`; the existing Logseq
importer continues to emit migration-only records. Export is a pure versioned
in-memory contract; file encryption, sync, lineage behavior, and mutation
commands remain in issues #45–#49.

**Tech Stack:** TypeScript ESM, Zod 4, Vitest, pnpm workspaces.

## Global Constraints

- Work only on #44; do not implement assertion history/query semantics (#45),
  resolution transactions (#47), merge/split behavior (#46), parity cutover
  behavior (#48), or typed client transport (#49).
- New canonical payloads use `atlas.*:v1` or `atlas.relationship:v2` and map to
  `entity`, `assertion`, `edge`, `evidence`, `review`, or `manifest` object
  types; they never map to `page`, `block`, or `logseq-*` kinds.
- Canonical payload schema names stay inside encrypted payloads. Do not add them
  to `visible_metadata.schema_namespace`.
- Existing Logseq/Obsidian import objects and readers remain migration-only and
  compatible.
- Use only synthetic fixtures; never open or mutate a real profile, hosted
  system, or deployment.

---

### Task 1: Add canonical runtime object categories

**Files:**

- Modify: `packages/contracts/src/classification.ts`
- Modify: `packages/contracts/src/contracts.test.ts`

**Interfaces:**

- Produces `ObjectType` values `entity`, `assertion`, `evidence`, and `review`.
- Existing values remain accepted for migration compatibility.

- [x] **Step 1: Write the failing test**

```ts
expect(ObjectTypeSchema.safeParse("entity").success).toBe(true);
expect(ObjectTypeSchema.safeParse("assertion").success).toBe(true);
expect(ObjectTypeSchema.safeParse("evidence").success).toBe(true);
expect(ObjectTypeSchema.safeParse("review").success).toBe(true);
expect(ObjectTypeSchema.safeParse("page").success).toBe(true);
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/contracts/src/contracts.test.ts`

Expected: failure because `entity` is not in `ObjectTypeValues`.

- [x] **Step 3: Write minimal implementation**

Add the four canonical values to `ObjectTypeValues`; preserve every existing
legacy and runtime value.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/contracts/src/contracts.test.ts`

Expected: PASS.

### Task 2: Define canonical payload schemas and canonical-write mapping

**Files:**

- Create: `packages/contracts/src/knowledge.ts`
- Create: `packages/contracts/src/knowledge.test.ts`
- Modify: `packages/contracts/src/index.ts`

**Interfaces:**

- Produces `CanonicalEntityPayloadSchema`, `CanonicalFactPayloadSchema`,
  `CanonicalObservationPayloadSchema`, `CanonicalRelationshipPayloadSchema`,
  `CanonicalEvidencePayloadSchema`, `CanonicalEntityResolutionPayloadSchema`,
  `CanonicalReviewItemPayloadSchema`, `CanonicalParityRecordPayloadSchema`,
  `CanonicalPayloadSchema`, `canonicalObjectTypeForPayload`, and
  `CanonicalWriteSchema`.
- Consumes `ObjectIdSchema`, `IsoTimestampSchema`, `Sha256HashSchema`,
  endpoint/subtype schemas, predicate schema, and access classes from existing
  contracts.

- [x] **Step 1: Write the failing tests**

```ts
const observation = CanonicalObservationPayloadSchema.parse({
  schema: "atlas.observation:v1",
  assertion_id: "la_object_observation0001",
  statement: "Synthetic ambiguous context",
  resolution_state: "deferred-unknown",
  recorded_at: timestamp,
  evidence_refs: ["la_object_evidence0001"]
});
expect(canonicalObjectTypeForPayload(observation)).toBe("assertion");

expect(CanonicalWriteSchema.parse({ payload: observation })).toMatchObject({
  object_type: "assertion"
});
expect(() => CanonicalWriteSchema.parse({
  object_type: "page",
  payload: observation
})).toThrow();
```

Add fixtures proving each canonical payload schema parses, facts require a
subject/predicate/typed value, relationships use a registered predicate and
knowledge timestamp, evidence requires a content hash and bounded support,
identity decisions require candidate ids, and parity records require canonical
ids when represented.

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/contracts/src/knowledge.test.ts`

Expected: module/import failure because `knowledge.ts` does not exist.

- [x] **Step 3: Write minimal implementation**

Implement the schemas with strict objects and discriminated `schema` literals.
Use the following payload-to-object mapping:

```ts
{
  "atlas.entity:v1": "entity",
  "atlas.fact:v1": "assertion",
  "atlas.observation:v1": "assertion",
  "atlas.relationship:v2": "edge",
  "atlas.evidence:v1": "evidence",
  "atlas.entity-resolution:v1": "review",
  "atlas.review-item:v1": "review",
  "atlas.parity-record:v1": "manifest"
}
```

`CanonicalWriteSchema` derives this object type from the payload and rejects a
caller-supplied mismatch. It does not construct an envelope or expose schema
names in visible metadata.

- [x] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/contracts/src/knowledge.test.ts`

Expected: PASS.

### Task 3: Add portable canonical export/import contract coverage

**Files:**

- Modify: `packages/contracts/src/knowledge.ts`
- Modify: `packages/contracts/src/knowledge.test.ts`

**Interfaces:**

- Produces `CanonicalExportRecordSchema`, `CanonicalExportSchema`,
  `parseCanonicalExport`, and `canonicalExportObjectType`.
- A record contains object id, authority id, object type, access class, version,
  content hash, and one canonical payload.

- [x] **Step 1: Write the failing test**

```ts
const roundTripped = parseCanonicalExport(JSON.parse(JSON.stringify({
  export_schema: "living-atlas-canonical-export:v1",
  authority_id: "la_authority_contract0001",
  exported_at: timestamp,
  records: [canonicalEntityExportRecord]
})));
expect(roundTripped.records[0]).toEqual(canonicalEntityExportRecord);
```

Also assert that a record with `object_type: "page"` and an
`atlas.entity:v1` payload is rejected.

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/contracts/src/knowledge.test.ts`

Expected: failure because the export symbols are absent.

- [x] **Step 3: Write minimal implementation**

Define the export schema as a local-keyholding portable contract only. Validate
that each record's object type is exactly the canonical mapping for its payload.
Do not add file I/O, encryption routines, sync, or hosted transport.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/contracts/src/knowledge.test.ts`

Expected: PASS.

### Task 4: Add a narrow legacy endpoint-to-canonical entity adapter

**Files:**

- Create: `packages/importer/src/canonical.ts`
- Create: `packages/importer/src/canonical.test.ts`
- Modify: `packages/importer/src/index.ts`

**Interfaces:**

- Produces `canonicalEntityPayloadFromEndpoint(endpoint: EndpointRecord)`.
- Consumes only an already-parsed legacy endpoint and returns
  `CanonicalEntityPayload`.

- [x] **Step 1: Write the failing test**

```ts
const payload = canonicalEntityPayloadFromEndpoint(legacyEndpoint);
expect(payload).toMatchObject({
  schema: "atlas.entity:v1",
  entity_id: legacyEndpoint.object_id,
  type: "organization"
});
expect(JSON.stringify(payload)).not.toContain("source_ref");
expect(JSON.stringify(payload)).not.toContain("confidence");
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/importer/src/canonical.test.ts`

Expected: module/import failure because the adapter does not exist.

- [x] **Step 3: Write minimal implementation**

Create the adapter from identity/display fields only: id, type, subtype, name,
aliases, optional description, and legacy timestamps. Do not copy `source_ref`,
legacy confidence, access class, notes refs, or sourced property fields into the
canonical entity payload.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/importer/src/canonical.test.ts`

Expected: PASS.

### Task 5: Verify #44 boundaries and commit

**Files:**

- Modify only files from Tasks 1–4 and this plan if corrections are needed.

- [x] **Step 1: Run focused tests**

Run: `pnpm vitest run packages/contracts/src/contracts.test.ts packages/contracts/src/knowledge.test.ts packages/importer/src/canonical.test.ts`

Expected: PASS with no warnings.

- [x] **Step 2: Run full verification**

Run: `pnpm check`

Expected: repo-safety checks, typecheck, and all tests pass.

- [x] **Step 3: Perform boundary audit**

Run: `rg -n 'logseq-|object_type: "page"|object_type: "block"' packages/contracts/src/knowledge.ts packages/importer/src/canonical.ts`

Expected: no matches in canonical writer code.

- [ ] **Step 4: Update tracker and commit**

Post public-safe test and scope evidence to #44 and #43. Commit only the #44
contract, adapter, tests, and plan changes. Do not push, deploy, or begin
#45–#49.
