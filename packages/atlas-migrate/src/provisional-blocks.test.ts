import { describe, expect, it } from "vitest";
import type { GraphObjectEnvelope } from "@living-atlas/contracts";
import {
  ProjectedRecordSchema,
  UnmodelledRecordKinds,
  applyProjectionPlan,
  buildProjectionPlan,
  createInMemoryTargetPlane,
  createLegacyGraphFixture,
  createLogseqBlockFixture,
  evaluateClosureGate,
  isProvisionalBlockRecord,
  isRetractionRecord,
  legacyBlockFixtureIds,
  legacyBlockFixtureText,
  legacyFixtureAuthorityId,
  legacyFixturePayloadResolver,
  legacyObjectIdOf,
  renderProjectionPlanReport,
  type ProjectedProvisionalBlockRecord,
  type ProjectionPlan,
  type SourceOutcome
} from "./index.js";

/**
 * THE OWNER'S DECISION, AS TESTS.
 *
 * The Logseq outline blocks migrate now, carried across whole, with their
 * modelling decided later (ADR 0029). The decision came with a stated risk — an
 * unmodelled record type tends to stay unmodelled — so what is asserted here is
 * not only that the blocks arrive but that the deferral cannot go quiet:
 * nothing is dropped, nothing is published, and the count is on the review
 * surface of every run.
 *
 * Every payload is invented. `createLogseqBlockFixture` holds the shapes, not
 * anybody's words.
 */

function planFor(envelopes: GraphObjectEnvelope[] = createLogseqBlockFixture()): ProjectionPlan {
  return buildProjectionPlan(envelopes, {
    authority_id: legacyFixtureAuthorityId,
    resolve_payload: legacyFixturePayloadResolver
  });
}

function outcomeFor(plan: ProjectionPlan, legacyObjectId: string): SourceOutcome {
  const outcome = plan.outcomes.find((candidate) => candidate.legacy_object_id === legacyObjectId);
  if (!outcome) {
    throw new Error(`no outcome for ${legacyObjectId}`);
  }
  return outcome;
}

function blockFor(plan: ProjectionPlan, legacyObjectId: string): ProjectedProvisionalBlockRecord {
  const record = plan.records
    .filter(isProvisionalBlockRecord)
    .find((candidate) => legacyObjectIdOf(candidate) === legacyObjectId);
  if (!record) {
    throw new Error(`no provisional block record for ${legacyObjectId}`);
  }
  return record;
}

/** The payload as the source fixture wrote it, for a byte-level comparison. */
function sourcePayloadFor(legacyObjectId: string): Record<string, unknown> {
  const envelope = createLogseqBlockFixture().find((candidate) => candidate.object_id === legacyObjectId);
  if (!envelope || envelope.payload.kind !== "plaintext-json") {
    throw new Error(`no plaintext source payload for ${legacyObjectId}`);
  }
  return envelope.payload.data;
}

function refusalReason(plan: ProjectionPlan, legacyObjectId: string): string {
  const { disposition } = outcomeFor(plan, legacyObjectId);
  return disposition.kind === "refused" ? disposition.reason : `not-refused:${disposition.kind}`;
}

describe("carrying outline blocks across without modelling them", () => {
  /**
   * THE LOSSLESS PROPERTY, stated as one equality against the source payload.
   *
   * Deliberately a whole-object comparison rather than a field-by-field list:
   * a list of assertions has to be extended by whoever adds a field, and the
   * field nobody remembers to assert is exactly the one that goes missing. This
   * fails the moment the carry-over drops, renames or rewrites anything.
   */
  it("carries every measured key verbatim", () => {
    const plan = planFor();

    for (const legacyObjectId of [
      legacyBlockFixtureIds.block,
      legacyBlockFixtureIds.blockAtOrigin,
      legacyBlockFixtureIds.blockEmptyText,
      legacyBlockFixtureIds.blockWithoutProperties,
      legacyBlockFixtureIds.blockTombstoned
    ]) {
      expect(blockFor(plan, legacyObjectId).block).toEqual(sourcePayloadFor(legacyObjectId));
    }
  });

  /**
   * The falsy-zero trap, on its own, because the equality above would also fail
   * for a dozen other reasons and this is the failure most likely to be written
   * by accident: `index ? {index} : {}` drops the first bullet of every file and
   * every top-level block, and the outline silently stops being a tree.
   */
  it("keeps a zero index and a zero depth, which are positions and not absences", () => {
    const record = blockFor(planFor(), legacyBlockFixtureIds.blockAtOrigin);

    expect(record.block.index).toBe(0);
    expect(record.block.depth).toBe(0);
    expect(Object.keys(record.block)).toContain("index");
    expect(Object.keys(record.block)).toContain("depth");
  });

  it("carries an empty bullet rather than refusing it out of the outline", () => {
    const record = blockFor(planFor(), legacyBlockFixtureIds.blockEmptyText);

    expect(record.block.text).toBe("");
    expect(record.block.index).toBe(1);
  });

  /**
   * Absent in, absent out. The record IS the payload rather than a normalisation
   * of it, so a block that carried no properties must not gain an empty map —
   * the later modelling pass has to be able to tell "no properties" from "the
   * importer wrote an empty map", and a synthesised default destroys that.
   */
  it("does not invent a properties map for a block that carried none", () => {
    const plan = planFor();

    expect(Object.keys(blockFor(plan, legacyBlockFixtureIds.blockWithoutProperties).block)).not.toContain(
      "properties"
    );
    expect(blockFor(plan, legacyBlockFixtureIds.blockAtOrigin).block.properties).toEqual({});
  });

  it("keeps the block traceable to the legacy object and the namespace it was measured against", () => {
    const record = blockFor(planFor(), legacyBlockFixtureIds.block);

    expect(legacyObjectIdOf(record)).toBe(legacyBlockFixtureIds.block);
    expect(record.source_schema_namespace).toBe("import/logseq-semantic/block");
    expect(record.origin).toBe("pre-contract-import");
    expect(record.recorded_at_fidelity).toBe("import-artifact");
  });

  /**
   * The importer derived endpoints from blocks and never stored the link, so
   * there is no recorded edge from a block to the node it produced. The record
   * must therefore name NO entity: a field for one could only be filled by
   * inference, and inventing that link is the identity decision this migration
   * exists not to make.
   */
  it("names no entity, because the source never recorded one", () => {
    const record = blockFor(planFor(), legacyBlockFixtureIds.block);
    const keys = Object.keys(record);

    expect(keys).not.toContain("slot");
    expect(keys).not.toContain("entity_type");
    expect(keys).not.toContain("source_slot");
    expect(keys).not.toContain("target_slot");
  });

  it("gives a carried block its own disposition rather than counting it as a projected entity", () => {
    const outcome = outcomeFor(planFor(), legacyBlockFixtureIds.block);

    expect(outcome.category).toBe("outline-block");
    expect(outcome.disposition.kind).toBe("projected-as-provisional");
  });

  /**
   * The legacy id now resolves at the carried record instead of answering
   * "nothing carried this across", which is the whole point of moving them now.
   */
  it("redirects the legacy block id at the record that carries it", () => {
    const outcome = outcomeFor(planFor(), legacyBlockFixtureIds.block);

    expect(outcome.alias_target.kind).toBe("record");
    if (outcome.alias_target.kind !== "record") throw new Error("expected a redirect");
    expect(outcome.alias_target.record_kind).toBe("provisional-block");
    expect(outcome.record_keys).toContain(outcome.alias_target.record_key);
    // A block is not an entity, so the alias row names no slot to resolve to.
    expect(outcome.alias_target.slot).toBeUndefined();
  });

  /**
   * A deleted block is carried AND retracted, exactly like a deleted node.
   * Importing nothing would turn a recorded deletion into an absence of
   * history, which an append-only plane must never do.
   */
  it("carries a deleted block and retracts it in the same plan", () => {
    const plan = planFor();
    const carried = blockFor(plan, legacyBlockFixtureIds.blockTombstoned);
    const retraction = plan.records
      .filter(isRetractionRecord)
      .find((record) => legacyObjectIdOf(record) === legacyBlockFixtureIds.blockTombstoned);

    expect(carried.block.text).toBe(legacyBlockFixtureText.tombstoned);
    expect(retraction?.retracts_idempotency_key).toBe(carried.idempotency_key);
    expect(outcomeFor(plan, legacyBlockFixtureIds.blockTombstoned).disposition.kind).toBe(
      "projected-as-retraction"
    );
  });

  /**
   * A block whose payload does not fit the measured shape is refused BY NAME.
   * Not `invalid-legacy-payload`: the bytes are fine and our description of them
   * is short by a key, and those two send an operator to opposite remedies.
   */
  it("refuses a block carrying a key nobody measured, rather than dropping the key", () => {
    const plan = planFor();

    expect(refusalReason(plan, legacyBlockFixtureIds.blockUnmeasuredShape)).toBe("unmeasured-block-shape");
    expect(
      plan.records
        .filter(isProvisionalBlockRecord)
        .some((record) => legacyObjectIdOf(record) === legacyBlockFixtureIds.blockUnmeasuredShape)
    ).toBe(false);
  });

  it("leaves a block from an unmeasured namespace refused as narrative", () => {
    const plan = planFor();
    const outcome = outcomeFor(plan, legacyBlockFixtureIds.blockUnknownNamespace);

    expect(outcome.category).toBe("narrative-object");
    expect(refusalReason(plan, legacyBlockFixtureIds.blockUnknownNamespace)).toBe(
      "no-typed-target-representation"
    );
  });

  /**
   * PAGES AND ATTACHMENTS DO NOT RIDE ALONG — ADR 0029. Their shapes are
   * different and this lane measured neither, so carrying them would mean
   * inventing a second provisional shape from a guess. They stay refused under a
   * named reason, they stay readable in the frozen replica, and the gate still
   * balances.
   */
  it("leaves pages and attachments refused", () => {
    const plan = planFor();

    for (const legacyObjectId of [legacyBlockFixtureIds.page, legacyBlockFixtureIds.attachment]) {
      expect(outcomeFor(plan, legacyObjectId).category).toBe("narrative-object");
      expect(refusalReason(plan, legacyObjectId)).toBe("no-typed-target-representation");
    }
  });

  /**
   * Carrying blocks must not turn an unresolvable edge into a resolvable one. A
   * block is not an endpoint; an edge that names one has to keep refusing rather
   * than land on a record that has no type to satisfy the predicate's range.
   */
  it("does not make a block a resolvable edge endpoint", () => {
    expect(refusalReason(planFor(), legacyBlockFixtureIds.edgeAtBlock)).toBe("endpoint-not-projected");
  });
});

describe("the deferral stays counted", () => {
  it("closes the gate with every source object projected or refused by name", () => {
    const source = createLogseqBlockFixture();
    const gate = evaluateClosureGate(planFor(source));

    expect(gate.ok).toBe(true);
    expect(gate.breakdown.projected_count + gate.breakdown.refused_count).toBe(source.length);
    expect(gate.breakdown.by_category.reduce((total, entry) => total + entry.count, 0)).toBe(source.length);
    expect(gate.breakdown.by_disposition.reduce((total, entry) => total + entry.count, 0)).toBe(source.length);
    expect(gate.breakdown.refusals_by_reason.reduce((total, entry) => total + entry.count, 0)).toBe(
      gate.breakdown.refused_count
    );
  });

  /**
   * The blocks moved from the refused side of the identity to the projected
   * side. Asserted against a plan built from the SAME objects with the carry
   * turned off — the namespace stripped — so the equality is about the decision
   * and not about a number somebody typed into a test.
   */
  it("moves the blocks out of the refused count without changing the total", () => {
    const carried = planFor();
    const asNarrative = planFor(
      createLogseqBlockFixture().map((envelope) => ({
        ...envelope,
        visible_metadata: { ...envelope.visible_metadata, schema_namespace: "import/unmeasured/block" }
      }))
    );

    const blocksCarried = carried.records.filter(isProvisionalBlockRecord).length;
    expect(blocksCarried).toBeGreaterThan(0);
    expect(carried.breakdown.refused_count).toBe(asNarrative.breakdown.refused_count - blocksCarried);
    expect(carried.breakdown.projected_count).toBe(asNarrative.breakdown.projected_count + blocksCarried);
    expect(carried.breakdown.source_object_count).toBe(asNarrative.breakdown.source_object_count);
  });

  it("counts the carried records as unmodelled in the breakdown", () => {
    const plan = planFor();
    const carried = plan.records.filter(isProvisionalBlockRecord).length;

    expect(plan.breakdown.unmodelled_records).toEqual([{ record_kind: "provisional-block", count: carried }]);
    expect(evaluateClosureGate(plan).breakdown.unmodelled_records).toEqual(plan.breakdown.unmodelled_records);
  });

  /**
   * The gate finding is the part the owner cannot skim past: the dry-run
   * entrypoint prints every finding to stderr with its severity. Tolerated, not
   * a failure — the records are exactly what was asked for, so failing would
   * mean no plan could ever certify.
   */
  it("reports the deferral as a tolerated closure-gate finding on every run that carries one", () => {
    const gate = evaluateClosureGate(planFor());
    const finding = gate.findings.find((candidate) => candidate.code === "unmodelled-record-carried");

    expect(finding?.severity).toBe("tolerated");
    expect(finding?.subject_count).toBe(planFor().records.filter(isProvisionalBlockRecord).length);
    expect(gate.ok).toBe(true);
  });

  /**
   * And it does NOT fire on a plan that defers nothing. A finding that is always
   * present is a finding nobody reads, and it would stop being evidence that
   * this run in particular carried something.
   */
  it("says nothing when a run carries no unmodelled record", () => {
    const gate = evaluateClosureGate(
      buildProjectionPlan(createLegacyGraphFixture(), {
        authority_id: legacyFixtureAuthorityId,
        resolve_payload: legacyFixturePayloadResolver
      })
    );

    expect(gate.findings.map((finding) => finding.code)).not.toContain("unmodelled-record-carried");
  });

  /**
   * Printed at ZERO too. An absent section reads as "not measured"; a zero reads
   * as "this run deferred nothing", which is the sentence that makes the run
   * where it stops being zero noticeable.
   */
  it("prints the deferral on the report whether or not the run deferred anything", () => {
    const withBlocks = renderProjectionPlanReport(planFor());
    const withoutBlocks = renderProjectionPlanReport(
      buildProjectionPlan(createLegacyGraphFixture(), {
        authority_id: legacyFixtureAuthorityId,
        resolve_payload: legacyFixturePayloadResolver
      })
    );

    expect(withBlocks).toContain("unmodelled-records");
    expect(withBlocks).toContain("provisional-block");
    expect(withoutBlocks).toContain("unmodelled-records");
    expect(withoutBlocks).toContain("carried (no contract, no revision)");
    expect(withoutBlocks).toMatch(/carried \(no contract, no revision\) *0/);
  });

  /**
   * The report is the review surface and a block's text is the most
   * content-bearing thing the plan holds. None of it belongs in a file somebody
   * might paste somewhere — the same rule that made the topic findings report
   * slots instead of words.
   */
  it("keeps block text out of the review surface", () => {
    const report = renderProjectionPlanReport(planFor(), evaluateClosureGate(planFor()));

    for (const text of Object.values(legacyBlockFixtureText)) {
      expect(report).not.toContain(text);
    }
    expect(report).not.toContain("synthetic-value");
    expect(report).not.toContain("pages/synthetic-note.md");
  });
});

describe("the carried shape is not published", () => {
  /**
   * REQUIREMENT, NOT AN OBSERVATION. The kind is unpublished precisely because
   * its shape is expected to change, and a released revision cannot be edited
   * once it ships — so a kind that leaked into one would be frozen by accident,
   * which is the failure the whole deferral is arranged to avoid.
   *
   * Asserted against the published contract files on disk rather than against a
   * TypeScript import, because that is what a client actually reads.
   */
  it("appears in no released contract revision", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");

    // packages/atlas-migrate/src -> repository root
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const schemaRoot = join(root, "packages", "atlas-contract", "schema");

    const files: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory)) {
        const full = join(directory, entry);
        if (statSync(full).isDirectory()) walk(full);
        else files.push(full);
      }
    };
    walk(schemaRoot);
    expect(files.length).toBeGreaterThan(0);

    for (const kind of UnmodelledRecordKinds) {
      for (const file of files) {
        expect({ file, contains: readFileSync(file, "utf8").includes(kind) }).toEqual({
          file,
          contains: false
        });
      }
    }
  });

  it("still satisfies the migration package's own record schema", () => {
    for (const record of planFor().records.filter(isProvisionalBlockRecord)) {
      expect(ProjectedRecordSchema.safeParse(record).success).toBe(true);
    }
  });
});

describe("applying a carried block", () => {
  const applyActorId = "la_principal_blockapply01";

  it("commits it as its own resolution and replays it on a second run", async () => {
    const plan = planFor();
    const plane = createInMemoryTargetPlane();
    const input = {
      plan,
      actor_id: applyActorId,
      registry: plane.registry,
      alias_ledger: plane.alias_ledger,
      sink: plane.sink,
      audit: plane.audit,
      now: () => "2026-08-06T10:00:00.000Z"
    };

    const first = await applyProjectionPlan(input);
    expect(first.ok).toBe(true);

    const committed = plane.sink.commits.filter((request) => request.record.record_kind === "provisional-block");
    expect(committed.length).toBe(plan.records.filter(isProvisionalBlockRecord).length);
    for (const request of committed) {
      // Named, never swept into the absence default: an absence says content did
      // NOT come across, which is the inverse of what this record is.
      expect(request.resolved.record_kind).toBe("provisional-block");
    }

    const second = await applyProjectionPlan(input);
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.audit.records_committed).toBe(0);
      expect(second.audit.records_replayed).toBe(plan.records.length);
    }
  });

  it("makes the legacy block id resolve at the committed record", async () => {
    const plan = planFor();
    const plane = createInMemoryTargetPlane();
    await applyProjectionPlan({
      plan,
      actor_id: applyActorId,
      registry: plane.registry,
      alias_ledger: plane.alias_ledger,
      sink: plane.sink,
      audit: plane.audit,
      now: () => "2026-08-06T10:00:00.000Z"
    });

    const row = await plane.alias_ledger.resolve(legacyBlockFixtureIds.block);
    const target = row?.target;
    expect(target?.kind).toBe("redirect");
    if (target?.kind !== "redirect") throw new Error("expected a redirect row");
    expect(target.record_kind).toBe("provisional-block");

    const commit = plane.sink.commits.find((request) => request.object_id === target.object_id);
    expect(commit?.record.record_kind).toBe("provisional-block");
  });
});
