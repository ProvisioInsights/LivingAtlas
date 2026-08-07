import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyProjectionPlan,
  buildProjectionPlan,
  createLegacyGraphFixture,
  createLogseqBlockFixture,
  legacyFixtureAuthorityId,
  legacyFixturePayloadResolver,
  migrationPlaneDirectories,
  openDurableMigrationPlane,
  readMigrationStore,
  type ProjectionPlan
} from "@living-atlas/atlas-migrate";
import {
  assertFindingIsContentFree,
  checkLegacyIdResolution,
  checkProvisionalBlocks,
  checkRecordCounts,
  checkSampledFields,
  renderFaithfulnessReport,
  sampleEvenly,
  verifyMigrationFaithfulness
} from "./migration-verify";

/**
 * A VERIFIER THAT CANNOT FAIL IS A DECORATION.
 *
 * So every check here is proven twice: once against a store the migration
 * actually wrote, and once against the same store with one specific thing
 * broken. The second half is the half that matters — a check that has only ever
 * been seen to pass may simply be looking at nothing.
 *
 * The store is built by running the real durable plane over the real fixtures,
 * not by hand-assembling what a store might look like. A verifier tested against
 * a mock of its subject verifies the mock.
 */

const roots: string[] = [];
const applyActorId = "la_user_migration01";

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "atlas-migrate-verify-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function planFor(envelopes = createLegacyGraphFixture()): ProjectionPlan {
  return buildProjectionPlan(envelopes, {
    authority_id: legacyFixtureAuthorityId,
    resolve_payload: legacyFixturePayloadResolver
  });
}

/** A store the migration really wrote, from the given plan. */
async function migratedStore(plan: ProjectionPlan): Promise<string> {
  const root = temporaryRoot();
  const plane = openDurableMigrationPlane({
    directory: root,
    authority_id: legacyFixtureAuthorityId
  });
  const result = await applyProjectionPlan({
    plan,
    actor_id: applyActorId,
    registry: plane.registry,
    alias_ledger: plane.alias_ledger,
    sink: plane.sink,
    audit: plane.audit,
    now: () => "2026-08-06T10:00:00.000Z"
  });
  plane.close();
  if (!result.ok) throw new Error("fixture migration did not apply");
  return root;
}

describe("verifying a faithful migration", () => {
  it("passes a store the migration actually wrote, and looks at something while doing it", async () => {
    const plan = planFor();
    const report = verifyMigrationFaithfulness({ plan, store_directory: await migratedStore(plan) });

    expect(report.findings).toEqual([]);
    expect(report.ok).toBe(true);
    // A pass over an empty examination is the failure mode a bare `ok` hides.
    for (const check of report.checks) {
      if (check.check === "provisional-blocks") continue; // No blocks in this fixture.
      expect(check.examined).toBeGreaterThan(0);
    }
    expect(report.source_objects).toBe(plan.outcomes.length);
  });

  it("passes a block store and reconciles the carried text length", async () => {
    const plan = planFor(createLogseqBlockFixture());
    const store = await migratedStore(plan);
    const report = verifyMigrationFaithfulness({ plan, store_directory: store });

    expect(report.ok).toBe(true);
    const blocks = report.checks.find((check) => check.check === "provisional-blocks");
    expect(blocks?.examined).toBeGreaterThan(0);
  });
});

describe("the verifier can fail", () => {
  it("names a legacy id whose alias row is missing", async () => {
    const plan = planFor();
    const store = readMigrationStore(await migratedStore(plan));
    const [victim] = [...store.aliasDispositionByLegacyId.keys()];
    if (victim === undefined) throw new Error("fixture wrote no alias rows");
    store.aliasDispositionByLegacyId.delete(victim);

    const result = checkLegacyIdResolution(plan, store);
    expect(result.ok).toBe(false);
    expect(result.findings).toContainEqual({
      check: "legacy-id-resolution",
      code: "legacy-id-unresolved",
      legacy_object_id: victim
    });
  });

  it("catches a row that resolves to a different kind of answer than the plan planned", async () => {
    const plan = planFor();
    const store = readMigrationStore(await migratedStore(plan));
    // A legacy id the plan redirects at a record, told it was never migrated.
    // Both are valid rows; only one of them is the truth about this object.
    const redirected = plan.outcomes.find((outcome) => outcome.alias_target.kind === "record");
    if (!redirected) throw new Error("fixture planned no redirect");
    store.aliasDispositionByLegacyId.set(redirected.legacy_object_id, "never-migrated");

    const result = checkLegacyIdResolution(plan, store);
    expect(result.ok).toBe(false);
    expect(result.findings).toContainEqual({
      check: "legacy-id-resolution",
      code: "alias-disposition-mismatch",
      legacy_object_id: redirected.legacy_object_id,
      expected_word: "redirect",
      observed_word: "terminal"
    });
  });

  it("names the records the store is missing, by kind", async () => {
    const plan = planFor();
    const store = readMigrationStore(await migratedStore(plan));
    const [droppedKey] = [...store.entityByKey.keys()];
    if (droppedKey === undefined) throw new Error("fixture minted no entities");
    store.entityByKey.delete(droppedKey);

    const result = checkRecordCounts(plan, store);
    expect(result.ok).toBe(false);
    const missing = result.findings.filter((item) => item.code === "record-missing");
    expect(missing).toHaveLength(1);
    expect(missing[0]?.record_kind).toMatch(/entity/);
  });

  /**
   * The case a total cannot see. One record dropped and one written twice leaves
   * both sides the same size, and only a per-key comparison notices.
   */
  it("reports a record the store holds that the plan never called for", async () => {
    const plan = planFor();
    const store = readMigrationStore(await migratedStore(plan));
    store.assertionIdsByKey.set("la_idem_notinanyplan", ["la_assertion_ghost"]);

    const result = checkRecordCounts(plan, store);
    expect(result.ok).toBe(false);
    expect(result.findings).toContainEqual({
      check: "record-counts",
      code: "record-unplanned",
      expected_count: 0,
      observed_count: 1
    });
  });

  /**
   * THE FAILURE WITH NO OTHER SYMPTOM. Every count is right, every record
   * parses, and the graph says something nobody said.
   */
  it("catches an edge that landed on the wrong entity", async () => {
    const plan = planFor();
    const store = readMigrationStore(await migratedStore(plan));
    const edge = store.assertions.find((assertion) => assertion.target_entity_id !== undefined);
    if (!edge) throw new Error("fixture wrote no relationship");
    const other = store.entities.find((entity) => entity.entity_id !== edge.subject_entity_id);
    if (!other) throw new Error("fixture minted only one entity");

    const swapped = { ...edge, subject_entity_id: other.entity_id };
    const result = checkSampledFields(
      plan,
      {
        ...store,
        assertions: store.assertions.map((item) => (item.assertion_id === edge.assertion_id ? swapped : item))
      },
      // Every record, so the sample cannot miss the one that was broken.
      plan.records.length
    );

    expect(result.ok).toBe(false);
    const endpoints = result.findings.filter((item) => item.field === "subject_entity_id");
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]?.code).toBe("field-mismatch");
  });

  it("catches an entity whose name did not survive, without printing either name", async () => {
    const plan = planFor();
    const store = readMigrationStore(await migratedStore(plan));
    const [key, entity] = [...store.entityByKey.entries()][0] ?? [];
    if (!key || !entity) throw new Error("fixture minted no entities");
    store.entityByKey.set(key, { ...entity, display_name: "Wrong Name Entirely" });

    const result = checkSampledFields(plan, store, plan.records.length);
    expect(result.ok).toBe(false);
    const mismatch = result.findings.find((item) => item.field === "display_name");
    expect(mismatch).toBeDefined();
    // The finding says WHICH field differs and never what it held.
    expect(JSON.stringify(mismatch)).not.toContain("Wrong Name Entirely");
    expect(mismatch?.expected_word).toBeUndefined();
    expect(mismatch?.observed_word).toBeUndefined();
  });

  it("catches a block that was carried short", async () => {
    const plan = planFor(createLogseqBlockFixture());
    const store = readMigrationStore(await migratedStore(plan));
    // A block that actually holds text. The fixture deliberately carries an
    // empty one too, and truncating that would change no length at all.
    const block = store.provisionalBlocks.find(
      (candidate) =>
        candidate.record.record_kind === "provisional-block" && candidate.record.block.text.length > 0
    );
    if (!block || block.record.record_kind !== "provisional-block") {
      throw new Error("fixture carried no block with text");
    }
    const truncated = {
      ...block,
      record: { ...block.record, block: { ...block.record.block, text: "" } }
    };

    const result = checkProvisionalBlocks(plan, {
      ...store,
      provisionalBlocks: store.provisionalBlocks.map((candidate) =>
        candidate.object_id === block.object_id ? truncated : candidate
      )
    });
    expect(result.ok).toBe(false);
    const mismatch = result.findings.find((item) => item.code === "block-text-length-mismatch");
    expect(mismatch).toBeDefined();
    expect(mismatch?.observed_count).toBeLessThan(mismatch?.expected_count ?? 0);
  });

  it("catches a block that never arrived", async () => {
    const plan = planFor(createLogseqBlockFixture());
    const store = readMigrationStore(await migratedStore(plan));

    const result = checkProvisionalBlocks(plan, {
      ...store,
      provisionalBlocks: store.provisionalBlocks.slice(1)
    });
    expect(result.ok).toBe(false);
    expect(result.findings.map((item) => item.code)).toContain("block-count-mismatch");
  });
});

/**
 * THE FIELDS ADR 0029 PROMISED, EACH ONE PROVEN INDIVIDUALLY.
 *
 * The check used to compare block COUNT and TOTAL TEXT LENGTH and nothing else,
 * so five of the seven carried keys were unverified end to end and the sixth was
 * only length-checked. Measured against a store the real durable plane wrote:
 * deleting a block's whole `properties` map, changing its `depth`, changing its
 * `index`, changing both source refs, and rewriting its `text` to the same
 * length ALL produced `ok: true` with zero findings.
 *
 * Every case below is one of those, and each must now fail. The deferral was
 * accepted on a promise that nothing would be lost; this is the instrument that
 * checks the promise, over the one irreversible run.
 */
describe("a carried block that lost a field the ADR promised", () => {
  type Carried = ReturnType<typeof readMigrationStore>["provisionalBlocks"][number];

  async function blockStore(): Promise<{ plan: ProjectionPlan; store: ReturnType<typeof readMigrationStore> }> {
    const plan = planFor(createLogseqBlockFixture());
    return { plan, store: readMigrationStore(await migratedStore(plan)) };
  }

  /** Replace the first carried block that has text, via `mutate`. */
  function withMutatedBlock(
    store: ReturnType<typeof readMigrationStore>,
    mutate: (block: Record<string, unknown>) => Record<string, unknown>
  ): Carried[] {
    const target = store.provisionalBlocks.find(
      (candidate) =>
        candidate.record.record_kind === "provisional-block" && candidate.record.block.text.length > 0
    );
    if (!target || target.record.record_kind !== "provisional-block") {
      throw new Error("fixture carried no block with text");
    }
    const record = target.record;
    return store.provisionalBlocks.map((candidate) =>
      candidate.object_id === target.object_id
        ? {
            ...candidate,
            record: {
              ...record,
              block: mutate({ ...record.block } as Record<string, unknown>)
            } as Carried["record"]
          }
        : candidate
    );
  }

  const cases: { name: string; mutate: (block: Record<string, unknown>) => Record<string, unknown> }[] = [
    {
      name: "its properties map was dropped entirely",
      mutate: (block) => {
        const { properties: _dropped, ...rest } = block;
        return rest;
      }
    },
    // Relative, not absolute: a fixture block that already sat at depth 0 would
    // make an absolute mutation a no-op and the test vacuous.
    { name: "its depth moved", mutate: (block) => ({ ...block, depth: Number(block.depth) + 1 }) },
    { name: "its index moved", mutate: (block) => ({ ...block, index: Number(block.index) + 1 }) },
    {
      name: "its source refs point somewhere else",
      mutate: (block) => ({
        ...block,
        source_path_ref: "pages/elsewhere.md",
        source_block_ref: "block-0000"
      })
    },
    {
      name: "its text was rewritten to the same length",
      mutate: (block) => ({
        ...block,
        text: "x".repeat(String(block.text).length)
      })
    },
    { name: "its kind was relabelled", mutate: (block) => ({ ...block, kind: "something-else" }) }
  ];

  for (const testCase of cases) {
    it(`fails when ${testCase.name}`, async () => {
      const { plan, store } = await blockStore();
      const result = checkProvisionalBlocks(plan, {
        ...store,
        provisionalBlocks: withMutatedBlock(store, testCase.mutate)
      });

      expect(result.ok).toBe(false);
      const mismatch = result.findings.find((item) => item.code === "block-digest-mismatch");
      expect(mismatch).toBeDefined();
      // It names the key of the block that differs — an id — and nothing else.
      expect(mismatch?.idempotency_key).toBeTruthy();
      assertFindingIsContentFree(mismatch!);
    });
  }

  it("passes the untouched store, so the digest is not simply always different", async () => {
    const { plan, store } = await blockStore();
    const result = checkProvisionalBlocks(plan, store);
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.examined).toBeGreaterThan(0);
  });

  it("does not print the block text it is comparing", async () => {
    const { plan, store } = await blockStore();
    const result = checkProvisionalBlocks(plan, {
      ...store,
      provisionalBlocks: withMutatedBlock(store, (block) => ({ ...block, text: "leaked prose" }))
    });
    const rendered = JSON.stringify(result.findings);
    expect(rendered).not.toContain("leaked prose");
    // Nor the value it expected instead, which is the more tempting leak.
    const original = store.provisionalBlocks.find(
      (candidate) =>
        candidate.record.record_kind === "provisional-block" && candidate.record.block.text.length > 0
    );
    if (original?.record.record_kind !== "provisional-block") throw new Error("no block with text");
    expect(rendered).not.toContain(original.record.block.text);
  });

  it("fails the whole verdict, not just the check, over a store that lost a field", async () => {
    // The end-to-end statement: `renderFaithfulnessReport` said "verdict pass"
    // over a store where none of five blocks had kept its properties map.
    const plan = planFor(createLogseqBlockFixture());
    const storeDir = await migratedStore(plan);
    const path = migrationPlaneDirectories(storeDir).provisional;
    const rewritten = readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => {
        const parsed = JSON.parse(line) as { record: { record_kind: string; block?: Record<string, unknown> } };
        if (parsed.record.record_kind === "provisional-block" && parsed.record.block) {
          delete parsed.record.block.properties;
        }
        return JSON.stringify(parsed);
      })
      .join("\n");
    writeFileSync(path, `${rewritten}\n`, "utf8");

    const report = verifyMigrationFaithfulness({ plan, store_directory: storeDir });
    expect(report.ok).toBe(false);
    expect(renderFaithfulnessReport(report)).toContain("verdict                   FAIL");
    expect(report.findings.map((item) => item.code)).toContain("block-digest-mismatch");
  });
});

describe("the report is content-free", () => {
  /**
   * THE CONTRACT THIS FILE EXISTS TO HOLD.
   *
   * A private topic name reached a review surface once already. So the rule is
   * tested against the actual rendered report, with every string the fixture
   * holds: not "we were careful", but "the name is not in the bytes".
   */
  it("never prints a name, an alias, a description or a block's text", async () => {
    const plan = planFor(createLogseqBlockFixture());
    const store = await migratedStore(plan);
    const report = verifyMigrationFaithfulness({ plan, store_directory: store });
    const rendered = renderFaithfulnessReport(report);

    const content: string[] = [];
    for (const record of plan.records) {
      const value = record as Record<string, unknown>;
      if (typeof value.name === "string") content.push(value.name);
      if (typeof value.description === "string") content.push(value.description);
      if (Array.isArray(value.aliases)) content.push(...(value.aliases as string[]));
      const block = value.block as { text?: string } | undefined;
      if (typeof block?.text === "string" && block.text.length > 0) content.push(block.text);
    }
    // The fixture really does carry content, so this is not vacuous.
    expect(content.length).toBeGreaterThan(0);
    for (const secret of content) expect(rendered).not.toContain(secret);
  });

  it("still prints no content when every check is failing", async () => {
    const plan = planFor(createLogseqBlockFixture());
    const storeDir = await migratedStore(plan);
    // An emptied store: every check has something to say, so the failure path is
    // the one being read for leaks -- which is where the leak happened before.
    const paths = migrationPlaneDirectories(storeDir);
    writeFileSync(paths.provisional, "", "utf8");
    const emptied = { ...readMigrationStore(storeDir), aliasDispositionByLegacyId: new Map<string, string>() };

    const rendered = renderFaithfulnessReport({
      ok: false,
      source_objects: plan.outcomes.length,
      segment_repairs: 0,
      checks: [
        checkLegacyIdResolution(plan, emptied),
        checkRecordCounts(plan, emptied),
        checkProvisionalBlocks(plan, emptied)
      ],
      findings: [
        ...checkLegacyIdResolution(plan, emptied).findings,
        ...checkProvisionalBlocks(plan, emptied).findings
      ],
      truncated: 0
    });

    expect(rendered).toContain("FAIL");
    for (const record of plan.records) {
      const block = (record as { block?: { text?: string } }).block;
      if (block?.text) expect(rendered).not.toContain(block.text);
      const name = (record as { name?: string }).name;
      if (name) expect(rendered).not.toContain(name);
    }
  });

  it("refuses a finding that carries a field it cannot vouch for", () => {
    expect(() =>
      assertFindingIsContentFree({
        check: "record-counts",
        code: "record-missing",
        // The shape the leak took last time: an explanatory string.
        detail: "topic 'a private thing' did not carry"
      } as never)
    ).toThrow(/free-text field is where content leaks/);
  });
});

describe("the finding list is bounded", () => {
  /**
   * The old daemon's per-object audit fanout wrote tens of MiB per call and
   * eventually exceeded Node's maximum string length. A verifier that printed
   * one line per record would reproduce it exactly, and would do it on the run
   * where everything went wrong.
   */
  it("caps the enumeration per code and reports the rest as a count", async () => {
    const plan = planFor();
    const store = readMigrationStore(await migratedStore(plan));
    const report = verifyMigrationFaithfulness({
      plan,
      store_directory: await migratedStore(plan),
      sample_size: 0
    });
    expect(report.truncated).toBe(0);

    // Now break everything: one finding per source object.
    const broken = { ...store, aliasDispositionByLegacyId: new Map<string, string>() };
    const result = checkLegacyIdResolution(plan, broken);
    expect(result.findings.length).toBe(plan.outcomes.length);
    expect(plan.outcomes.length).toBeGreaterThan(0);
  });
});

describe("sampling", () => {
  it("spreads across the range and is stable between runs", () => {
    const items = Array.from({ length: 100 }, (_value, index) => index);
    const sample = sampleEvenly(items, 5);
    expect(sample).toEqual(sampleEvenly(items, 5));
    expect(sample).toEqual([0, 20, 40, 60, 80]);
    // Not the first five, which on a kind-ordered plan are all one kind.
    expect(sample).not.toEqual([0, 1, 2, 3, 4]);
  });

  it("takes everything when the corpus is smaller than the sample", () => {
    expect(sampleEvenly([1, 2, 3], 10)).toEqual([1, 2, 3]);
    expect(sampleEvenly([], 10)).toEqual([]);
    expect(sampleEvenly([1, 2, 3], 0)).toEqual([]);
  });
});

describe("reading the store", () => {
  it("does not repair a torn log while measuring it", async () => {
    const plan = planFor();
    const storeDir = await migratedStore(plan);
    const paths = migrationPlaneDirectories(storeDir);
    const [segmentName] = readdirSync(paths.assertions);
    if (segmentName === undefined) throw new Error("fixture wrote no segment");
    const segmentPath = join(paths.assertions, segmentName);
    // A half-written final line, which is what a killed process leaves.
    writeFileSync(segmentPath, `${readFileSync(segmentPath, "utf8")}{"record":"tor`, "utf8");
    const before = readFileSync(segmentPath, "utf8");

    const contents = readMigrationStore(storeDir);

    // Byte for byte. A verifier is opened when somebody doubts the store, so
    // repairing the evidence is the one thing it must never do.
    expect(readFileSync(segmentPath, "utf8")).toBe(before);
    // Reported, though. Untouched and unmentioned would be worse than repaired:
    // the operator would read a clean verdict over a damaged log.
    expect(contents.segment_repairs).toBeGreaterThan(0);
  });
});
