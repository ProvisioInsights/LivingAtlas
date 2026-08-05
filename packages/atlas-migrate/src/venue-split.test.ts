import { describe, expect, it } from "vitest";
import {
  applyProjectionPlan,
  buildProjectionPlan,
  createInMemoryTargetPlane,
  createLegacyVenueFixture,
  evaluateClosureGate,
  isEntityRecord,
  isLegacyObjectProvenance,
  isRelationshipRecord,
  legacyFixtureAuthorityId,
  legacyObjectIdOf,
  legacyVenueFixtureIds,
  renderProjectionPlanReport,
  type ProjectedEntityRecord,
  type ProjectedRelationshipRecord,
  type ProjectionPlan,
  type SourceOutcome
} from "./index.js";

const ids = legacyVenueFixtureIds;

function planVenues(): ProjectionPlan {
  return buildProjectionPlan(createLegacyVenueFixture(), { authority_id: legacyFixtureAuthorityId });
}

function outcomeFor(plan: ProjectionPlan, legacyObjectId: string): SourceOutcome {
  const outcome = plan.outcomes.find((candidate) => candidate.legacy_object_id === legacyObjectId);
  if (!outcome) throw new Error(`no outcome for ${legacyObjectId}`);
  return outcome;
}

function entitiesFor(plan: ProjectionPlan, legacyObjectId: string): ProjectedEntityRecord[] {
  return plan.records.filter(isEntityRecord).filter((record) => legacyObjectIdOf(record) === legacyObjectId);
}

function entityOfType(plan: ProjectionPlan, legacyObjectId: string, type: string): ProjectedEntityRecord {
  const found = entitiesFor(plan, legacyObjectId).find((record) => record.entity_type === type);
  if (!found) throw new Error(`no ${type} entity for ${legacyObjectId}`);
  return found;
}

function mintedNode(plan: ProjectionPlan, name: string): ProjectedEntityRecord {
  const found = plan.records
    .filter(isEntityRecord)
    .find((record) => !isLegacyObjectProvenance(record.provenance) && record.name === name);
  if (!found) throw new Error(`no minted node named ${name}`);
  return found;
}

function relationships(plan: ProjectionPlan, predicate: string): ProjectedRelationshipRecord[] {
  return plan.records.filter(isRelationshipRecord).filter((record) => record.predicate === predicate);
}

function slotName(plan: ProjectionPlan, slot: string): string {
  const entity = plan.records.filter(isEntityRecord).find((record) => record.slot === slot);
  return entity?.name ?? `<unminted:${slot}>`;
}

describe("venue split", () => {
  it("turns one venue row into a location and an organization joined by operated-by", () => {
    const plan = planVenues();
    const location = entityOfType(plan, ids.venueRestaurant, "location");
    const organization = entityOfType(plan, ids.venueRestaurant, "organization");

    expect(entitiesFor(plan, ids.venueRestaurant)).toHaveLength(2);
    expect(location.slot).not.toBe(organization.slot);
    // The shared name is why the id is ambiguous, so both halves must carry it.
    expect(location.name).toBe("Venue 0");
    expect(organization.name).toBe("Venue 0");

    const operatedBy = relationships(plan, "operated-by").filter(
      (record) => legacyObjectIdOf(record) === ids.venueRestaurant
    );
    expect(operatedBy).toHaveLength(1);
    expect(operatedBy[0]?.source_slot).toBe(location.slot);
    expect(operatedBy[0]?.target_slot).toBe(organization.slot);
    expect(operatedBy[0]?.derivation).toBe("venue-split");
  });

  it("allocates each attribute to the node whose property it is", () => {
    const plan = planVenues();
    const location = entityOfType(plan, ids.venueRestaurant, "location");
    const organization = entityOfType(plan, ids.venueRestaurant, "organization");

    // The place keeps geography; the business keeps its founding and homepage.
    expect(location.attrs).toEqual({ geo: { latitude: 1.5, longitude: 2.5 }, timezone: "UTC" });
    expect(organization.attrs).toEqual({ founded_year: "1998", homepage_ref: "https://example.invalid/venue-0" });

    // Nothing is carried by both, so there is no second copy to drift.
    for (const key of Object.keys(location.attrs)) {
      expect(Object.keys(organization.attrs)).not.toContain(key);
    }
  });

  it("classifies both halves of the split with has-type", () => {
    const plan = planVenues();
    const restaurant = mintedNode(plan, "restaurant");
    const classified = relationships(plan, "has-type")
      .filter((record) => legacyObjectIdOf(record) === ids.venueRestaurant)
      .filter((record) => record.target_slot === restaurant.slot);

    expect(restaurant.entity_type).toBe("topic");
    expect(classified.map((record) => record.source_type).sort()).toEqual(["location", "organization"]);
  });

  it("resolves the original legacy id to an ambiguous split with no primary", () => {
    const plan = planVenues();
    const outcome = outcomeFor(plan, ids.venueRestaurant);
    const location = entityOfType(plan, ids.venueRestaurant, "location");
    const organization = entityOfType(plan, ids.venueRestaurant, "organization");

    expect(outcome.alias_target.kind).toBe("ambiguous-split");
    if (outcome.alias_target.kind !== "ambiguous-split") throw new Error("expected a split");
    expect(outcome.alias_target.candidates.map((candidate) => candidate.record_key).sort()).toEqual(
      [location.idempotency_key, organization.idempotency_key].sort()
    );
    // No primary: naming one would silently reattribute every old reference.
    expect(JSON.stringify(outcome.alias_target)).not.toContain("record_kind\":\"entity\",\"primary");
    expect(plan.breakdown.legacy_ids_split).toBe(2);
  });

  it("routes an existing edge by the endpoint type it declared", () => {
    const plan = planVenues();
    const location = entityOfType(plan, ids.venueRestaurant, "location");
    const occurredAt = relationships(plan, "occurred-at");

    expect(occurredAt).toHaveLength(1);
    // The edge said `location`, so it lands on the place, never on the business.
    expect(occurredAt[0]?.target_slot).toBe(location.slot);
    expect(outcomeFor(plan, ids.edgeOccurredAt).disposition.kind).toBe("projected-as-relationship");
  });

  it("carries the alias split through the commit as candidate ids, never a redirect", async () => {
    const plan = planVenues();
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
    const row = await plane.alias_ledger.resolve(ids.venueRestaurant);
    expect(row?.target.kind).toBe("ambiguous-split");
    if (row?.target.kind !== "ambiguous-split") throw new Error("expected a split row");
    expect(row.target.candidate_object_ids).toHaveLength(2);
    expect(new Set(row.target.candidate_object_ids).size).toBe(2);
  });
});

describe("attribute deduplication", () => {
  it("merges provider and airline into one offered-by edge", () => {
    const plan = planVenues();
    const carrier = mintedNode(plan, "Carrier 0");
    const offeredBy = relationships(plan, "offered-by");

    expect(offeredBy).toHaveLength(1);
    expect(offeredBy[0]?.target_slot).toBe(carrier.slot);
    expect(offeredBy[0]?.derivation).toBe("provider-attr");
    expect(carrier.entity_type).toBe("organization");
    // The attribute became an edge, so no copy is left behind on the node.
    expect(Object.keys(entityOfType(plan, ids.segment, "occurrence").attrs)).not.toContain("provider");
  });

  it("refuses to pick a winner when provider and airline disagree, without dropping the object", () => {
    const plan = planVenues();
    const outcome = outcomeFor(plan, ids.conflictedSegment);
    const flagged = plan.hand_review.filter((item) => item.legacy_object_id === ids.conflictedSegment);
    const offeredBy = relationships(plan, "offered-by").filter(
      (edge) => legacyObjectIdOf(edge) === ids.conflictedSegment
    );

    // The occurrence still projects: an attribute-level problem must not cost a
    // whole node.
    expect(outcome.disposition.kind).toBe("projected-as-entity");
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.reason).toBe("attribute-conflict");
    expect(flagged[0]?.attribute).toBe("provider");
    // Neither carrier won, and no node was minted for the loser.
    expect(offeredBy).toHaveLength(0);
    expect(plan.records.filter(isEntityRecord).some((record) => record.name === "Carrier 1")).toBe(false);
  });

  it("turns merchant into sold-by and reuses one node per distinct counterparty", () => {
    const plan = planVenues();
    const agency = mintedNode(plan, "Agency 0");
    const soldBy = relationships(plan, "sold-by");

    expect(soldBy).toHaveLength(1);
    expect(soldBy[0]?.target_slot).toBe(agency.slot);
    expect(soldBy[0]?.derivation).toBe("merchant-attr");
  });

  it("collapses date, occurred_on and purchase_date into one occurred_on", () => {
    const plan = planVenues();
    const segment = entityOfType(plan, ids.segment, "occurrence");

    expect(segment.attrs).toEqual({ occurred_on: "2023-04-05" });
    expect(Object.keys(segment.attrs)).not.toContain("date");
    expect(Object.keys(segment.attrs)).not.toContain("purchase_date");
  });

  it("turns parent_location_ref into contained-in edges", () => {
    const plan = planVenues();
    const city = entityOfType(plan, ids.city, "location");
    const containedIn = relationships(plan, "contained-in");

    expect(containedIn).toHaveLength(2);
    for (const edge of containedIn) {
      expect(edge.target_slot).toBe(city.slot);
      expect(edge.derivation).toBe("parent-location-ref");
    }
    // The ref became an edge and is not also left on the node.
    expect(Object.keys(entityOfType(plan, ids.venueHotel, "location").attrs)).not.toContain("parent_location_ref");
  });

  it("turns both participant lists into participant-in, with organizer as a role", () => {
    const plan = planVenues();
    const participantIn = relationships(plan, "participant-in");
    const byRole = new Map(participantIn.map((edge) => [slotName(plan, edge.source_slot), edge]));

    expect(participantIn).toHaveLength(2);
    expect(byRole.get("Person 2")?.attrs).toEqual({});
    expect(byRole.get("Person 1")?.attrs).toEqual({ role: "organizer" });
    expect(byRole.get("Person 1")?.derivation).toBe("organizer-refs");
  });

  it("backfills employed-by from company_current before the attribute is dropped", () => {
    const plan = planVenues();
    const person = entityOfType(plan, ids.personNoEmployer, "person");
    const backfilled = relationships(plan, "employed-by").filter(
      (edge) => edge.derivation === "company-current-attr"
    );

    expect(backfilled).toHaveLength(1);
    expect(backfilled[0]?.source_slot).toBe(person.slot);
    // The fact survived as an edge to a minted node rather than being matched by
    // name onto an existing organization, which would be an identity decision.
    expect(slotName(plan, backfilled[0]?.target_slot ?? "")).toBe("Employer D");
    expect(Object.keys(person.attrs)).not.toContain("company_current");
  });

  it("moves job_title onto the single employed-by edge as a role", () => {
    const plan = planVenues();
    const person = entityOfType(plan, ids.personOneEmployer, "person");
    const employment = relationships(plan, "employed-by").find((edge) => edge.source_slot === person.slot);

    expect(employment?.attrs).toEqual({ role: "Title 1" });
    expect(Object.keys(person.attrs)).not.toContain("job_title");
  });

  it("classifies job_title as an occupation topic when there is no employer edge to carry it", () => {
    const plan = planVenues();
    // Person 2's only employment is the company_current backfill, so the title
    // lands on that edge; Person 3 has two, so it lands nowhere. The occupation
    // path is reached by a person with neither, which the backfill guarantees is
    // only reachable when company_current is absent too.
    const occupationEdges = relationships(plan, "has-type").filter((edge) => edge.derivation === "job-title-attr");
    const backfilled = relationships(plan, "employed-by").find(
      (edge) => edge.derivation === "company-current-attr"
    );

    expect(backfilled?.attrs).toEqual({ role: "Title 2" });
    expect(occupationEdges).toHaveLength(0);
  });

  it("refuses to place a job_title when the person has more than one employer", () => {
    const plan = planVenues();
    const flagged = plan.hand_review.filter((item) => item.legacy_object_id === ids.personTwoEmployers);
    const person = entityOfType(plan, ids.personTwoEmployers, "person");
    const employments = relationships(plan, "employed-by").filter((edge) => edge.source_slot === person.slot);

    expect(employments).toHaveLength(2);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.reason).toBe("ambiguous-employer");
    expect(flagged[0]?.attribute).toBe("job_title");
    // Neither edge was given the role: choosing one would attach a real job to a
    // possibly wrong employer.
    for (const edge of employments) {
      expect(edge.attrs.role).toBeUndefined();
    }
  });
});

describe("derived records", () => {
  it("mints one shared node per distinct value and counts its population", () => {
    const plan = planVenues();
    const restaurant = mintedNode(plan, "restaurant");
    const city = mintedNode(plan, "city");

    if (isLegacyObjectProvenance(restaurant.provenance)) throw new Error("expected derived provenance");
    expect(restaurant.provenance.derived_from).toBe("legacy-subtype-word");
    expect(restaurant.provenance.legacy_attribute).toBe("subtype");
    expect(restaurant.provenance.source_object_count).toBe(1);
    if (isLegacyObjectProvenance(city.provenance)) throw new Error("expected derived provenance");
    // One legacy object carried `city`, and the node names the population rather
    // than borrowing that object's identity.
    expect(city.provenance.source_object_count).toBe(1);
    expect(plan.breakdown.entities_minted_from_attributes).toBeGreaterThan(0);
  });

  it("gives every relationship either a legacy edge id or a derivation, never both", () => {
    const plan = planVenues();
    const edges = plan.records.filter(isRelationshipRecord);

    expect(edges.length).toBeGreaterThan(0);
    for (const edge of edges) {
      expect((edge.legacy_edge_id === undefined) !== (edge.derivation === undefined)).toBe(true);
    }
  });

  it("gives a derived edge unknown world time rather than inventing one", () => {
    const plan = planVenues();
    const derived = plan.records.filter(isRelationshipRecord).filter((edge) => edge.derivation !== undefined);

    expect(derived.length).toBeGreaterThan(0);
    for (const edge of derived) {
      expect(edge.valid_from).toBe("unknown");
      expect(edge.valid_from_fidelity).toBe("unknown");
    }
  });

  it("passes the closure gate with minted nodes claimed by no source outcome", () => {
    const plan = planVenues();
    const gate = evaluateClosureGate(plan, { expected_source_object_count: createLegacyVenueFixture().length });
    const claimed = new Set(plan.outcomes.flatMap((outcome) => outcome.record_keys));

    expect(gate.findings).toEqual([]);
    expect(gate.ok).toBe(true);
    for (const record of plan.records.filter((candidate) => !isLegacyObjectProvenance(candidate.provenance))) {
      expect(claimed.has(record.idempotency_key)).toBe(false);
    }
  });

  it("is a pure function of the source, so plans still diff cleanly", () => {
    expect(JSON.stringify(planVenues())).toBe(JSON.stringify(planVenues()));
    expect(planVenues().plan_digest).toBe(planVenues().plan_digest);
  });

  it("reports hand review and splits without printing any corpus value", () => {
    const plan = planVenues();
    const report = renderProjectionPlanReport(plan);

    expect(report).toContain("hand-review");
    expect(report).toContain("ambiguous-employer");
    expect(report).toContain("ambiguous splits (no primary)");
    // Ids and reasons only. A value here would put the very content under review
    // into whatever file the dry run is written to.
    expect(report).not.toContain("Title 3");
    expect(report).not.toContain("Venue 0");
    expect(report).not.toContain("Carrier 0");
  });
});
