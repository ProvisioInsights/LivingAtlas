import { describe, expect, it } from "vitest";
import { PredicateRegistry, RetiredPredicates } from "@living-atlas/contracts";
import {
  EdgeAbsorptionRules,
  EdgeMigrationRefusalReasonValues,
  InMemoryMigrationGraph,
  MigrationTransactionRefused,
  applyEdgeMigration,
  findStateDomainViolations,
  planEdgeMigration,
  type EdgeMigrationAudit,
  type EdgeMigrationRefusalReason,
  type LegacyGraph,
  type MigrationTransaction
} from "./edge-migration.js";
import { createLegacyVocabularyGraph, legacyVocabularyIds } from "./legacy-vocabulary-fixture.js";

function collectingAuditSink(): { events: EdgeMigrationAudit[]; record: (event: EdgeMigrationAudit) => Promise<void> } {
  const events: EdgeMigrationAudit[] = [];
  return { events, record: async (event) => void events.push(event) };
}

function rewriteFor(transaction: MigrationTransaction, edgeId: string) {
  return transaction.edge_rewrites.find((rewrite) => rewrite.edge_id === edgeId);
}

function refusalFor(plan: ReturnType<typeof planEdgeMigration>, edgeId: string) {
  return plan.refusals.find((refusal) => refusal.edge_id === edgeId);
}

function countFor(
  rows: Array<{ reason: EdgeMigrationRefusalReason; count: number }>,
  reason: EdgeMigrationRefusalReason
): number {
  return rows.find((row) => row.reason === reason)?.count ?? 0;
}

describe("edge migration onto the ratified vocabulary", () => {
  it("accounts for every legacy edge exactly once, as a rewrite or as a named refusal", () => {
    const graph = createLegacyVocabularyGraph();
    const plan = planEdgeMigration(graph);
    const transaction = plan.transactions[0]!;

    const seen = [
      ...transaction.edge_rewrites.map((rewrite) => rewrite.edge_id),
      ...plan.refusals.map((refusal) => refusal.edge_id)
    ].sort();
    const expected = graph.edges.map((edge) => edge.edge_id).sort();

    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(seen.length);
    expect(plan.breakdown.migrated_count + plan.breakdown.refused_count).toBe(graph.edges.length);
    expect(plan.breakdown.legacy_edge_count).toBe(graph.edges.length);
  });

  it("retypes travel items to occurrence/segment and leaves a possession an item", () => {
    const plan = planEdgeMigration(createLegacyVocabularyGraph());
    const transaction = plan.transactions[0]!;

    expect(transaction.node_retypes.map((retype) => retype.object_id).sort()).toEqual(
      [legacyVocabularyIds.ride, legacyVocabularyIds.flight, legacyVocabularyIds.train].sort()
    );
    for (const retype of transaction.node_retypes) {
      expect(retype.from_type).toBe("item");
      expect(retype.to_type).toBe("occurrence");
      expect(retype.to_subtype).toBe("segment");
    }
    // The laptop is owned, not travelled. Retyping it would turn a possession
    // into an event on the strength of the word "owns" alone.
    expect(transaction.node_retypes.some((retype) => retype.object_id === legacyVocabularyIds.laptop)).toBe(false);
    expect(rewriteFor(transaction, "la_edge_fx_owns_laptop")?.edge.predicate).toBe("owns");
    expect(rewriteFor(transaction, "la_edge_fx_owns_laptop")?.edge.target_type).toBe("item");
  });

  it("rewrites owns to participant-in in the SAME transaction that retypes its target", () => {
    const plan = planEdgeMigration(createLegacyVocabularyGraph());

    const retypedIn = new Map<string, number>();
    for (const transaction of plan.transactions) {
      for (const retype of transaction.node_retypes) {
        retypedIn.set(retype.object_id, transaction.ordinal);
      }
    }

    const travelOwns = ["la_edge_fx_owns_ride", "la_edge_fx_owns_fly", "la_edge_fx_owns_trn"];
    expect(travelOwns.length).toBe(3);

    for (const edgeId of travelOwns) {
      const transaction = plan.transactions.find((each) => rewriteFor(each, edgeId) !== undefined);
      expect(transaction, `${edgeId} must be rewritten somewhere`).toBeDefined();
      const rewrite = rewriteFor(transaction!, edgeId)!;

      expect(rewrite.legacy_predicate).toBe("owns");
      expect(rewrite.edge.predicate).toBe("participant-in");
      expect(rewrite.edge.target_type).toBe("occurrence");
      // The retype of the very node this edge points at must be in the same
      // transaction. Anywhere else and a state exists where the node is an
      // occurrence and the edge still says a person owns it.
      expect(retypedIn.get(rewrite.edge.target_object_id)).toBe(transaction!.ordinal);
    }
  });

  it("never lets a person own an event in any state the graph is asked to enter", async () => {
    const graph = createLegacyVocabularyGraph();
    const plan = planEdgeMigration(graph);
    const store = new InMemoryMigrationGraph(graph);
    const audit = collectingAuditSink();

    const result = await applyEdgeMigration({
      plan,
      actor_id: "la_user_edgemigtest1",
      graph: store,
      audit,
      now: () => "2026-08-05T00:00:00.000Z"
    });

    expect(result.ok).toBe(true);

    const history = store.history();
    expect(history.length).toBe(plan.transactions.length);
    expect(history.length).toBeGreaterThan(0);

    for (const state of history) {
      // The domain rules say owns cannot target an occurrence, so this single
      // assertion IS "no person owns an event" — plus every other rule.
      expect(findStateDomainViolations(state)).toEqual([]);

      const typeById = new Map(state.nodes.map((node) => [node.object_id, node.type]));
      const ownedOccurrences = state.edges.filter(
        (edge) => edge.predicate === "owns" && typeById.get(edge.target_object_id) === "occurrence"
      );
      expect(ownedOccurrences).toEqual([]);
    }
  });

  it("refuses a plan that retypes the travel items without rewriting the owns edges", () => {
    const graph = createLegacyVocabularyGraph();
    const plan = planEdgeMigration(graph);
    const whole = plan.transactions[0]!;

    // The mistake this lane exists to make impossible: retype first, rewrite
    // after. Both halves of the work are present and correct; only the atomicity
    // is gone.
    const split: MigrationTransaction[] = [
      { ordinal: 0, node_retypes: whole.node_retypes, edge_rewrites: [], edge_withdrawals: [] },
      { ordinal: 1, node_retypes: [], edge_rewrites: whole.edge_rewrites, edge_withdrawals: whole.edge_withdrawals }
    ];

    const store = new InMemoryMigrationGraph(graph);
    let refusal: MigrationTransactionRefused | undefined;
    try {
      store.commitTransaction(split[0]!);
    } catch (error) {
      refusal = error as MigrationTransactionRefused;
    }

    expect(refusal).toBeInstanceOf(MigrationTransactionRefused);
    expect(refusal!.ordinal).toBe(0);

    const ownedEvents = refusal!.violations.filter(
      (violation) => violation.predicate === "owns" && violation.code === "predicate-range-violation"
    );
    expect(ownedEvents.map((violation) => violation.edge_id).sort()).toEqual(
      ["la_edge_fx_owns_ride", "la_edge_fx_owns_fly", "la_edge_fx_owns_trn"].sort()
    );

    // A refused transaction is not a partly applied one.
    expect(store.history()).toEqual([]);
    const nodes = new Map(store.state().nodes.map((node) => [node.object_id, node.type]));
    expect(nodes.get(legacyVocabularyIds.ride)).toBe("item");
  });

  it("stops the run at a refused transaction and reports what it actually committed", async () => {
    const graph = createLegacyVocabularyGraph();
    const plan = planEdgeMigration(graph);
    const whole = plan.transactions[0]!;
    const audit = collectingAuditSink();

    const result = await applyEdgeMigration({
      plan: {
        ...plan,
        transactions: [
          { ordinal: 0, node_retypes: whole.node_retypes, edge_rewrites: [], edge_withdrawals: [] },
          { ordinal: 1, node_retypes: [], edge_rewrites: whole.edge_rewrites, edge_withdrawals: whole.edge_withdrawals }
        ]
      },
      actor_id: "la_user_edgemigtest1",
      graph: new InMemoryMigrationGraph(graph),
      audit,
      now: () => "2026-08-05T00:00:00.000Z"
    });

    expect(result.ok).toBe(false);
    expect(audit.events).toHaveLength(1);
    const event = audit.events[0]!;
    expect(event.outcome).toBe("transaction-refused");
    expect(event.transactions_planned).toBe(2);
    expect(event.transactions_committed).toBe(0);
    // Counted off what committed, not off what was planned. A run that reported
    // the plan's totals here would claim to have retyped three nodes it did not.
    expect(event.nodes_retyped).toBe(0);
    expect(event.edges_migrated).toBe(0);
    expect(event.edges_withdrawn).toBe(0);
  });

  it("preserves what each absorption absorbed as a role, a relation or a status", () => {
    const plan = planEdgeMigration(createLegacyVocabularyGraph());
    const transaction = plan.transactions[0]!;

    const board = rewriteFor(transaction, "la_edge_fx_board")!;
    expect(board.edge.predicate).toBe("member-of");
    expect(board.edge.attrs.role).toBe("board-member");

    const advises = rewriteFor(transaction, "la_edge_fx_advises")!;
    expect(advises.edge.predicate).toBe("member-of");
    expect(advises.edge.attrs.role).toBe("advisor");

    const mentor = rewriteFor(transaction, "la_edge_fx_mentor")!;
    expect(mentor.edge.predicate).toBe("connects");
    expect(mentor.edge.attrs.relation).toBe("mentor");

    const partner = rewriteFor(transaction, "la_edge_fx_partner")!;
    expect(partner.edge.predicate).toBe("connects");
    expect(partner.edge.attrs.relation).toBe("partner");

    // related-to carries the relation it HAD and does not gain one it never had.
    const relatedWithAttr = rewriteFor(transaction, "la_edge_fx_related_attr")!;
    expect(relatedWithAttr.edge.predicate).toBe("connects");
    expect(relatedWithAttr.edge.attrs.relation).toBe("former colleague");
    const relatedBare = rewriteFor(transaction, "la_edge_fx_related_bare")!;
    expect(relatedBare.edge.predicate).toBe("connects");
    expect(relatedBare.edge.attrs.relation).toBeUndefined();

    const engaged = rewriteFor(transaction, "la_edge_fx_engaged")!;
    expect(engaged.edge.predicate).toBe("spouse-of");
    expect(engaged.edge.status).toBe("pending");

    const purchased = rewriteFor(transaction, "la_edge_fx_purch_item")!;
    expect(purchased.edge.predicate).toBe("sold-by");
    expect(purchased.edge.source_type).toBe("item");
    expect(purchased.edge.target_type).toBe("organization");

    const created = rewriteFor(transaction, "la_edge_fx_created_for")!;
    expect(created.edge.predicate).toBe("created");
    expect(created.edge.attrs.created_for).toBe(legacyVocabularyIds.person1);
    // The legacy key is gone, not duplicated: two keys for one fact is how the
    // next migration ends up carrying the stale one.
    expect(created.edge.attrs.beneficiary).toBeUndefined();
  });

  it("keeps the alumnus time bound and refuses an alumnus edge that has none", () => {
    const plan = planEdgeMigration(createLegacyVocabularyGraph());
    const transaction = plan.transactions[0]!;

    const alumnus = rewriteFor(transaction, "la_edge_fx_alumnus")!;
    expect(alumnus.edge.predicate).toBe("member-of");
    expect(alumnus.edge.attrs.role).toBe("alumnus");
    expect(alumnus.edge.valid_to).toBe("2008-06-30");

    const open = refusalFor(plan, "la_edge_fx_alumnus_open")!;
    expect(open.reason).toBe("absorption-requires-valid-to");
    expect(rewriteFor(transaction, "la_edge_fx_alumnus_open")).toBeUndefined();
  });

  it("refuses an absorption that would have to invent an endpoint the edge never named", () => {
    const plan = planEdgeMigration(createLegacyVocabularyGraph());

    const fromBuyer = refusalFor(plan, "la_edge_fx_purch_buyer")!;
    expect(fromBuyer.reason).toBe("absorption-endpoints-unavailable");
    expect(fromBuyer.detail).toContain("sold-by");

    const atBeneficiary = refusalFor(plan, "la_edge_fx_created_benef")!;
    expect(atBeneficiary.reason).toBe("absorption-endpoints-unavailable");

    // A retired name with no ratified absorption is refused WITH the contract's
    // own successor text, so the operator is not told the word never existed.
    const reports = refusalFor(plan, "la_edge_fx_reports")!;
    expect(reports.reason).toBe("retired-predicate-without-absorption");
    expect(reports.detail).toBe(RetiredPredicates["reports-to"]);
  });

  it("refuses to overwrite an attr the legacy edge already held", () => {
    const plan = planEdgeMigration(createLegacyVocabularyGraph());
    const conflict = refusalFor(plan, "la_edge_fx_board_conflict")!;
    expect(conflict.reason).toBe("absorption-attr-conflict");
    expect(conflict.detail).toContain("role");
  });

  it("enforces the domain rule on a predicate whose name survived the ratification", () => {
    const plan = planEdgeMigration(createLegacyVocabularyGraph());

    const inverted = refusalFor(plan, "la_edge_fx_basedin_inv")!;
    expect(inverted.reason).toBe("predicate-domain-violation");
    expect(inverted.detail).toContain("person|organization -> location");
    expect(inverted.detail).toContain("got location -> organization");

    // The correctly written one is untouched, so the refusal is about direction
    // and not about the predicate.
    expect(plan.transactions[0]!.edge_rewrites.find((r) => r.edge_id === "la_edge_fx_basedin_ok")).toBeDefined();

    // A violation of the RANGE alone, which reports separately from a domain
    // violation so the count says which half of the rule the corpus breaks.
    const venue = refusalFor(plan, "la_edge_fx_contained_org")!;
    expect(venue.reason).toBe("predicate-range-violation");
    expect(venue.detail).toContain("location -> location");
  });

  it("refuses a dangling endpoint and invents no target for it", () => {
    const graph = createLegacyVocabularyGraph();
    const plan = planEdgeMigration(graph);

    for (const edgeId of ["la_edge_fx_owns_dangle", "la_edge_fx_basedin_dangle"]) {
      const refusal = refusalFor(plan, edgeId)!;
      expect(refusal.reason).toBe("dangling-edge-endpoint");
    }
    expect(countFor(plan.breakdown.refusals_by_reason, "dangling-edge-endpoint")).toBe(2);

    // Nothing was minted to stand in for the missing id.
    const nodeIds = new Set(graph.nodes.map((node) => node.object_id));
    expect(nodeIds.has(legacyVocabularyIds.missing)).toBe(false);
    for (const rewrite of plan.transactions[0]!.edge_rewrites) {
      expect(rewrite.edge.source_object_id).not.toBe(legacyVocabularyIds.missing);
      expect(rewrite.edge.target_object_id).not.toBe(legacyVocabularyIds.missing);
    }
  });

  it("counts every refusal reason it can name and names every reason it counts", () => {
    const plan = planEdgeMigration(createLegacyVocabularyGraph());

    const counted = plan.breakdown.refusals_by_reason.reduce((total, row) => total + row.count, 0);
    expect(counted).toBe(plan.refusals.length);

    for (const row of plan.breakdown.refusals_by_reason) {
      expect(EdgeMigrationRefusalReasonValues).toContain(row.reason);
    }
    // The fixture is the coverage argument: every reason this module can produce
    // has an instance, so a reason that stopped firing would show up as a zero.
    const exercised = new Set(plan.refusals.map((refusal) => refusal.reason));
    for (const reason of EdgeMigrationRefusalReasonValues) {
      if (reason === "invalid-migrated-edge") {
        continue;
      }
      expect(exercised, `no fixture edge exercises ${reason}`).toContain(reason);
    }
  });

  it("refuses a migrated edge the contract itself would reject", () => {
    // invalid-migrated-edge is the backstop for anything the per-rule checks let
    // through. Driven with an `invests-in` edge whose required attrs are absent,
    // because that is a contract rule this module does not re-implement.
    const graph: LegacyGraph = {
      authority_id: "la_authority_edgemigfx01",
      nodes: [
        { object_id: legacyVocabularyIds.person0, type: "person" },
        { object_id: legacyVocabularyIds.org0, type: "organization" }
      ],
      edges: [
        {
          edge_id: "la_edge_fx_invest_bare",
          source_object_id: legacyVocabularyIds.person0,
          target_object_id: legacyVocabularyIds.org0,
          predicate: "invests-in",
          valid_from: "2022-01-01",
          source: "legacy-vocabulary-fixture"
        }
      ]
    };

    const plan = planEdgeMigration(graph);
    const refusal = refusalFor(plan, "la_edge_fx_invest_bare")!;
    expect(refusal.reason).toBe("invalid-migrated-edge");
    expect(refusal.detail).toContain("invests-in requires");
    expect(plan.transactions[0]!.edge_rewrites).toEqual([]);
  });

  it("leaves no unratified predicate in the committed state", async () => {
    const graph = createLegacyVocabularyGraph();
    const plan = planEdgeMigration(graph);
    const store = new InMemoryMigrationGraph(graph);

    await applyEdgeMigration({
      plan,
      actor_id: "la_user_edgemigtest1",
      graph: store,
      audit: collectingAuditSink(),
      now: () => "2026-08-05T00:00:00.000Z"
    });

    const finalState = store.state();
    for (const edge of finalState.edges) {
      expect(Object.keys(PredicateRegistry)).toContain(edge.predicate);
    }
    // The refused edges were withdrawn rather than left behind asserting a
    // relation the vocabulary no longer defines.
    expect(finalState.edges.map((edge) => edge.edge_id)).not.toContain("la_edge_fx_reports");
    expect(finalState.edges).toHaveLength(plan.breakdown.migrated_count);
  });

  it("writes exactly one audit event per apply call, with aggregate counts and no record ids", async () => {
    const graph = createLegacyVocabularyGraph();
    const plan = planEdgeMigration(graph);
    const audit = collectingAuditSink();

    await applyEdgeMigration({
      plan,
      actor_id: "la_user_edgemigtest1",
      graph: new InMemoryMigrationGraph(graph),
      audit,
      now: () => "2026-08-05T00:00:00.000Z"
    });

    expect(audit.events).toHaveLength(1);
    const event = audit.events[0]!;
    expect(event.event_schema).toBe("living-atlas-migration-edge-apply:v1");
    expect(event.outcome).toBe("committed");
    expect(event.recorded_at).toBe("2026-08-05T00:00:00.000Z");
    expect(event.plan_digest).toBe(plan.plan_digest);
    expect(event.edges_migrated).toBe(plan.breakdown.migrated_count);
    expect(event.edges_withdrawn).toBe(plan.breakdown.refused_count);
    expect(event.nodes_retyped).toBe(3);

    // Aggregate counts only: no edge id and no object id may reach the audit
    // log, or the log becomes a second copy of the graph.
    const serialized = JSON.stringify(event);
    for (const edge of graph.edges) {
      expect(serialized).not.toContain(edge.edge_id);
    }
    for (const node of graph.nodes) {
      expect(serialized).not.toContain(node.object_id);
    }
  });

  it("plans deterministically, so a re-run diffs as source drift rather than run noise", () => {
    const first = planEdgeMigration(createLegacyVocabularyGraph());
    const second = planEdgeMigration(createLegacyVocabularyGraph());
    expect(second.plan_digest).toBe(first.plan_digest);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("absorbs every ratified name into a predicate the vocabulary defines", () => {
    for (const [legacy, rule] of Object.entries(EdgeAbsorptionRules)) {
      // A rule may only exist for a name the contract actually retired,
      // otherwise this module is inventing history.
      expect(RetiredPredicates[legacy], `${legacy} is not a retired predicate`).toBeDefined();
      expect(Object.keys(PredicateRegistry)).toContain(rule.predicate);
      const carriesSomething =
        rule.set_attrs !== undefined ||
        rule.carry_attrs !== undefined ||
        rule.status !== undefined ||
        rule.predicate === "sold-by";
      expect(carriesSomething, `${legacy} collapses without carrying anything across`).toBe(true);
    }
  });
});
