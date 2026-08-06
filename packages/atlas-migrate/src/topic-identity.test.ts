import { describe, expect, it } from "vitest";
import {
  MigrationOrigin,
  MigrationRecordedAtFidelity,
  applyProjectionPlan,
  buildProjectionPlan,
  createInMemoryTargetPlane,
  createOccupationCollisionFixture,
  createTopicIdentityFixture,
  evaluateClosureGate,
  isEntityRecord,
  isLegacyObjectProvenance,
  isMintedEntityRecord,
  isMintedRelationshipRecord,
  legacyFixtureAuthorityId,
  legacyObjectIdOf,
  legacyTopicIdentityFixtureIds,
  legacyTopicIdentityFixtureWords,
  mintedTopicIdempotencyKey,
  mintedTopicSlot,
  normalizeTopicValue,
  projectionPlanDigest,
  recomputeProjectionBreakdown,
  renderProjectionPlanReport,
  type ClosureGateFindingCode,
  type ProjectedMintedEntityRecord,
  type ProjectedRecord,
  type ProjectionPlan,
  type TopicScheme
} from "./index.js";

const ids = legacyTopicIdentityFixtureIds;
const words = legacyTopicIdentityFixtureWords;

function planTopics(): ProjectionPlan {
  return buildProjectionPlan(createTopicIdentityFixture(), { authority_id: legacyFixtureAuthorityId });
}

function planOccupations(): ProjectionPlan {
  return buildProjectionPlan(createOccupationCollisionFixture(), { authority_id: legacyFixtureAuthorityId });
}

function codes(plan: ProjectionPlan): ClosureGateFindingCode[] {
  return evaluateClosureGate(plan).findings.map((item) => item.code);
}

type TopicView = { slot: string; scheme: TopicScheme | undefined; name: string };

function topicsOf(plan: ProjectionPlan): TopicView[] {
  const topics: TopicView[] = [];
  for (const record of plan.records) {
    if (record.record_kind !== "entity" && record.record_kind !== "minted-entity") {
      continue;
    }
    if (record.entity_type !== "topic") {
      continue;
    }
    topics.push({ slot: record.slot, scheme: record.topic_scheme, name: record.name });
  }
  return topics;
}

function topicsForWord(plan: ProjectionPlan, word: string): TopicView[] {
  const key = normalizeTopicValue(word);
  return topicsOf(plan).filter((topic) => normalizeTopicValue(topic.name) === key);
}

function slotInScheme(plan: ProjectionPlan, word: string, scheme: TopicScheme): string {
  const found = topicsForWord(plan, word).filter((topic) => topic.scheme === scheme);
  const only = found[0];
  if (found.length !== 1 || only === undefined) {
    throw new Error(`expected exactly one ${scheme} topic for the word, found ${found.length}`);
  }
  return only.slot;
}

function corpusTopicSlot(plan: ProjectionPlan, legacyObjectId: string): string {
  const record = plan.records
    .filter(isEntityRecord)
    .find((candidate) => legacyObjectIdOf(candidate) === legacyObjectId);
  if (!record) {
    throw new Error(`no entity projected for ${legacyObjectId}`);
  }
  return record.slot;
}

function classificationEdges(plan: ProjectionPlan, legacyObjectId: string) {
  return plan.records
    .filter(isMintedRelationshipRecord)
    .filter((record) => record.predicate === "has-type" && record.provenance.legacy_object_id === legacyObjectId);
}

/**
 * Adds a record and rebuilds everything the plan derives from its records, so
 * the gate judges the record rather than tripping over a stale digest or a stale
 * breakdown on the way there.
 */
function retallied(plan: ProjectionPlan, extra: ProjectedRecord): ProjectionPlan {
  const records = [...plan.records, extra].sort((left, right) =>
    left.idempotency_key < right.idempotency_key ? -1 : left.idempotency_key > right.idempotency_key ? 1 : 0
  );
  const content = {
    ...plan,
    records,
    minted_record_keys: [...plan.minted_record_keys, extra.idempotency_key].sort(),
    breakdown: recomputeProjectionBreakdown(plan.outcomes, records, plan.hand_review)
  };
  return { ...content, plan_digest: projectionPlanDigest(content) };
}

function mintedTopic(input: { word: string; scheme: TopicScheme; fill: string }): ProjectedMintedEntityRecord {
  return {
    record_kind: "minted-entity",
    idempotency_key: `la_idem_${input.fill.repeat(32)}`,
    origin: MigrationOrigin,
    recorded_at_fidelity: MigrationRecordedAtFidelity,
    minted_basis: { kind: "retired-subtype-value", legacy_value: normalizeTopicValue(input.word) },
    slot: `slot_entity_${input.fill.repeat(24)}`,
    entity_type: "topic",
    topic_scheme: input.scheme,
    name: normalizeTopicValue(input.word),
    classified_node_count: 1
  };
}

describe("topic schemes", () => {
  /**
   * The scheme is a function of the mechanism that produced the node, never a
   * parameter anybody passes. Three producers, three vocabularies.
   */
  it("names the scheme of every topic, derived from the mechanism that made it", () => {
    const plan = planTopics();
    const occupations = planOccupations();

    for (const topic of topicsOf(plan)) {
      expect(topic.scheme).toBeDefined();
    }
    expect(topicsOf(plan).find((topic) => topic.slot === corpusTopicSlot(plan, ids.corpusTopic))?.scheme).toBe(
      "subject-matter"
    );
    expect(topicsForWord(plan, words.unmatched).map((topic) => topic.scheme)).toEqual(["entity-kind"]);
    expect(topicsOf(occupations).filter((topic) => topic.scheme === "occupation")).toHaveLength(1);
  });

  it("gives no scheme to an entity that is not a topic", () => {
    const plan = planTopics();
    const nonTopics = plan.records.filter(isEntityRecord).filter((record) => record.entity_type !== "topic");

    expect(nonTopics.length).toBeGreaterThan(0);
    for (const record of nonTopics) {
      expect(record.topic_scheme).toBeUndefined();
    }
  });

  /**
   * The scheme is in the SEED of both keys, and this pins it directly because
   * nothing else can. Today `mintedTopicSlot` is reached by one scheme, so
   * dropping the scheme from its seed changes no plan and every plan-level test
   * still passes — the separation would be an accident of there being one caller
   * rather than a property. The moment a second scheme mints through it, two
   * concepts would share a slot AND an idempotency key, and the second would be
   * replayed away as a duplicate of the first.
   */
  it("keys a minted topic by its scheme as well as its word", () => {
    const word = normalizeTopicValue(words.shared);

    expect(mintedTopicSlot(legacyFixtureAuthorityId, "entity-kind", word)).not.toBe(
      mintedTopicSlot(legacyFixtureAuthorityId, "occupation", word)
    );
    expect(mintedTopicIdempotencyKey(legacyFixtureAuthorityId, "entity-kind", word)).not.toBe(
      mintedTopicIdempotencyKey(legacyFixtureAuthorityId, "occupation", word)
    );
  });

  it("counts the topic nodes each scheme contributes", () => {
    const plan = planTopics();
    const gate = evaluateClosureGate(plan);
    const bySchemeEntries = new Map(plan.breakdown.topic_nodes_by_scheme.map((entry) => [entry.scheme, entry.count]));

    // Three corpus topics, and three minted kinds rather than four: the two
    // spellings of one subtype word share a node.
    expect(bySchemeEntries.get("subject-matter")).toBe(3);
    expect(bySchemeEntries.get("entity-kind")).toBe(3);
    expect(gate.breakdown.topic_nodes_by_scheme).toEqual(plan.breakdown.topic_nodes_by_scheme);
    expect(codes(plan)).not.toContain("breakdown-mismatch");
  });
});

describe("topic identity: one slot per (scheme, word)", () => {
  /**
   * WITHIN a scheme the word is the identity. Two carriers spelling one retired
   * subtype differently must reach one node, or "which of these are airlines"
   * answers with a fraction of the truth.
   */
  it("resolves two spellings of one subtype word to one entity-kind node", () => {
    const plan = planTopics();
    const kind = slotInScheme(plan, words.shared, "entity-kind");

    expect(classificationEdges(plan, ids.carrierOfCorpusWord)[0]?.target_slot).toBe(kind);
    expect(classificationEdges(plan, ids.carrierOfCorpusWordAgain)[0]?.target_slot).toBe(kind);
    expect(
      plan.records
        .filter(isMintedEntityRecord)
        .filter((record) => record.minted_basis.legacy_value === normalizeTopicValue(words.shared))
    ).toHaveLength(1);
  });

  /**
   * ACROSS schemes it is not. The corpus holds a `subject-matter` topic spelled
   * the same; landing a `has-type` classification on it would assert that the
   * owner's subject and this retired subtype word are one concept, on the
   * strength of a string. Two nodes, and the gate reports the homonym.
   */
  it("does not resolve a classification onto a corpus topic in another scheme", () => {
    const plan = planTopics();
    const corpus = corpusTopicSlot(plan, ids.corpusTopic);
    const kind = slotInScheme(plan, words.shared, "entity-kind");

    expect(kind).not.toBe(corpus);
    expect(topicsForWord(plan, words.shared).map((topic) => topic.scheme).sort()).toEqual([
      "entity-kind",
      "subject-matter"
    ]);
    expect(classificationEdges(plan, ids.carrierOfCorpusWord)[0]?.target_slot).not.toBe(corpus);
  });

  it("classifies every carrier, whichever node its word resolved to", () => {
    const plan = planTopics();

    for (const carrier of [
      ids.carrierOfCorpusWord,
      ids.carrierOfCorpusWordAgain,
      ids.carrierUnmatched,
      ids.carrierOfDuplicated
    ]) {
      expect(classificationEdges(plan, carrier)).toHaveLength(1);
    }
  });

  it("mints one occupation node for two spellings of one job title", () => {
    const plan = planOccupations();
    const occupations = plan.records
      .filter(isEntityRecord)
      .filter(
        (record) =>
          record.entity_type === "topic" &&
          !isLegacyObjectProvenance(record.provenance) &&
          record.provenance.legacy_attribute === "job_title"
      );

    expect(occupations).toHaveLength(1);
    expect(occupations[0]?.topic_scheme).toBe("occupation");
    expect(occupations[0]?.provenance).toMatchObject({ source_object_count: 2 });
  });

  it("produces the same plan on a re-run", () => {
    const first = planTopics();
    const second = planTopics();

    expect(second.plan_digest).toBe(first.plan_digest);
    expect(second.minted_record_keys).toEqual(first.minted_record_keys);
  });

  it("resolves the same nodes however the source objects are ordered", () => {
    const forward = buildProjectionPlan(createTopicIdentityFixture(), {
      authority_id: legacyFixtureAuthorityId
    });
    const reversed = buildProjectionPlan([...createTopicIdentityFixture()].reverse(), {
      authority_id: legacyFixtureAuthorityId
    });

    expect(reversed.plan_digest).toBe(forward.plan_digest);
  });
});

describe("topic identity: the gate tells the three cases apart", () => {
  /**
   * THE OWNER'S RULING, as a test. A person IS an investor and a firm IS an
   * investment firm: one word, two schemes, two concepts. It is reported so a
   * curator can still decide they are one — and it does not block the migration,
   * because the schemes are exactly what say they are not a duplicate.
   */
  it("tolerates a word that names concepts in two schemes and still certifies", () => {
    const plan = planOccupations();
    const gate = evaluateClosureGate(plan, {
      expected_source_object_count: createOccupationCollisionFixture().length
    });
    const homonym = gate.findings.find((item) => item.code === "cross-scheme-topic-homonym");

    expect(gate.ok).toBe(true);
    expect(gate.findings.map((item) => item.code)).not.toContain("duplicate-minted-topic");
    expect(homonym?.severity).toBe("tolerated");
    expect(homonym?.subject_count).toBe(2);
    expect(homonym?.detail).toContain("entity-kind=1");
    expect(homonym?.detail).toContain("occupation=1");
  });

  it("still fails a duplicate inside one scheme, whoever minted it", () => {
    const plan = planTopics();
    const duplicate = mintedTopic({ word: words.unmatched, scheme: "entity-kind", fill: "e" });
    const gate = evaluateClosureGate(retallied(plan, duplicate));
    const collision = gate.findings.find((item) => item.code === "duplicate-minted-topic");

    expect(gate.ok).toBe(false);
    expect(collision?.severity).toBe("failure");
    expect(collision?.subjects).toContain(duplicate.slot);
    expect(collision?.subjects).toContain(slotInScheme(plan, words.unmatched, "entity-kind"));
    expect(collision?.detail).toContain("entity-kind=2");
  });

  /**
   * A duplicate the corpus itself holds, and a homonym on the SAME word. Both
   * findings must fire with their own subject sets: one bucket swallowing the
   * other is how a defect hides inside an accepted condition.
   */
  it("reports a same-scheme corpus duplicate beside the homonym on that word", () => {
    const plan = planTopics();
    const gate = evaluateClosureGate(plan);
    const duplicate = gate.findings.find((item) => item.code === "duplicate-source-topic");
    const homonym = gate.findings.find((item) => item.code === "cross-scheme-topic-homonym");

    expect(gate.ok).toBe(true);
    expect(duplicate?.severity).toBe("tolerated");
    expect(duplicate?.subject_count).toBe(2);
    expect(duplicate?.detail).toContain("subject-matter=2");
    // The word also spans two schemes, so the homonym covers three slots: the two
    // corpus nodes and the entity kind minted beside them.
    expect(homonym?.subjects).toEqual(
      expect.arrayContaining(topicsForWord(plan, words.duplicated).map((topic) => topic.slot))
    );
  });

  it("fails a topic filed under no named scheme", () => {
    const plan = planTopics();
    const unnamed = mintedTopic({ word: "topic 9", scheme: "other", fill: "f" });
    const gate = evaluateClosureGate(retallied(plan, unnamed));
    const finding = gate.findings.find((item) => item.code === "unnamed-topic-scheme");

    expect(gate.ok).toBe(false);
    expect(finding?.severity).toBe("failure");
    expect(finding?.subjects).toEqual([unnamed.slot]);
  });

  it("names the colliding slots and never the word, in every one of the three", () => {
    const gate = evaluateClosureGate(planTopics());
    const topicFindings = gate.findings.filter((item) =>
      ["duplicate-source-topic", "cross-scheme-topic-homonym", "duplicate-minted-topic"].includes(item.code)
    );

    expect(topicFindings.length).toBeGreaterThan(0);
    for (const item of topicFindings) {
      for (const subject of item.subjects) {
        expect(subject).toMatch(/^slot_entity_[a-f0-9]{24}$/);
      }
      expect(item.subjects).not.toContain(words.duplicated);
      expect(item.subjects).not.toContain(normalizeTopicValue(words.duplicated));
    }
  });

  it("keeps both ids of a corpus-side duplicate resolvable through the alias ledger", async () => {
    const plan = planTopics();
    const plane = createInMemoryTargetPlane();
    const result = await applyProjectionPlan({
      plan,
      actor_id: "la_user_migration01",
      registry: plane.registry,
      alias_ledger: plane.alias_ledger,
      sink: plane.sink,
      audit: plane.audit,
      now: () => "2026-01-01T00:00:00.000Z"
    });

    expect(result.ok).toBe(true);
    const first = await plane.alias_ledger.resolve(ids.duplicateTopicA);
    const second = await plane.alias_ledger.resolve(ids.duplicateTopicB);

    expect(first?.target.kind).toBe("redirect");
    expect(second?.target.kind).toBe("redirect");
    if (first?.target.kind !== "redirect" || second?.target.kind !== "redirect") {
      throw new Error("expected both duplicate ids to redirect to a committed record");
    }
    expect(first.target.object_id).not.toBe(second.target.object_id);
  });

  it("prints the schemes and the tolerated findings without printing a word", () => {
    const plan = planTopics();
    const report = renderProjectionPlanReport(plan, evaluateClosureGate(plan));

    expect(report).toContain("topic-schemes");
    expect(report).toContain("subject-matter");
    expect(report).toContain("entity-kind");
    expect(report).toContain("cross-scheme-topic-homonym [tolerated]");
    expect(report).toContain("duplicate-source-topic [tolerated]");
    expect(report).not.toContain(words.shared);
    expect(report).not.toContain(words.duplicated);
  });
});
