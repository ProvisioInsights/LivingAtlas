import type { LegacyGraph, LegacyGraphEdge, LegacyGraphNode } from "./edge-migration.js";

/**
 * A synthetic legacy graph that still speaks the PRE-ratification vocabulary.
 *
 * `legacy-fixture.ts` was rewritten to the new vocabulary when the contract
 * landed, which left nothing in the repo carrying a retired predicate — and a
 * migration proved only against edges that never needed migrating proves
 * nothing. Every retired name this lane absorbs appears here, and so does one
 * instance of every refusal the migration can name.
 *
 * Invented content only. Nothing here comes from any personal corpus.
 */
export const legacyVocabularyAuthorityId = "la_authority_edgemigfx01";

export const legacyVocabularyIds = {
  person0: "la_object_fx_person_0",
  person1: "la_object_fx_person_1",
  person2: "la_object_fx_person_2",
  person3: "la_object_fx_person_3",
  org0: "la_object_fx_org_0",
  org1: "la_object_fx_org_1",
  university: "la_object_fx_org_2",
  city: "la_object_fx_city_0",
  laptop: "la_object_fx_item_0",
  ride: "la_object_fx_item_ride0",
  flight: "la_object_fx_item_fly0",
  train: "la_object_fx_item_trn0",
  offering: "la_object_fx_offering_0",
  /** Named by two edges and present as a node in neither direction. */
  missing: "la_object_fx_missing_0"
} as const;

function node(object_id: string, type: LegacyGraphNode["type"], subtype?: string): LegacyGraphNode {
  return { object_id, type, ...(subtype === undefined ? {} : { subtype }) };
}

function edge(
  edge_id: string,
  source_object_id: string,
  predicate: string,
  target_object_id: string,
  extra: Partial<Pick<LegacyGraphEdge, "valid_from" | "valid_to" | "status" | "attrs">> = {}
): LegacyGraphEdge {
  return {
    edge_id,
    source_object_id,
    target_object_id,
    predicate,
    valid_from: extra.valid_from ?? "2021-01-01",
    ...(extra.valid_to === undefined ? {} : { valid_to: extra.valid_to }),
    ...(extra.status === undefined ? {} : { status: extra.status }),
    source: "legacy-vocabulary-fixture",
    ...(extra.attrs === undefined ? {} : { attrs: extra.attrs })
  };
}

/**
 * The three travel items are typed `item` here exactly as the legacy plane typed
 * them, and each is the target of an `owns` edge. That pairing is the fixture's
 * whole reason for existing: it is the only way to observe whether the retype
 * and the rewrite travel together.
 */
export function createLegacyVocabularyGraph(): LegacyGraph {
  const ids = legacyVocabularyIds;
  return {
    authority_id: legacyVocabularyAuthorityId,
    nodes: [
      node(ids.person0, "person"),
      node(ids.person1, "person"),
      node(ids.person2, "person"),
      node(ids.person3, "person"),
      node(ids.org0, "organization"),
      node(ids.org1, "organization"),
      node(ids.university, "organization"),
      node(ids.city, "location"),
      node(ids.laptop, "item", "device"),
      node(ids.ride, "item", "rideshare"),
      node(ids.flight, "item", "flight"),
      node(ids.train, "item", "train"),
      node(ids.offering, "offering")
    ],
    edges: [
      // --- the transactional retype (G1a) -------------------------------------
      edge("la_edge_fx_owns_ride", ids.person0, "owns", ids.ride),
      edge("la_edge_fx_owns_fly", ids.person0, "owns", ids.flight),
      edge("la_edge_fx_owns_trn", ids.person0, "owns", ids.train),
      // A possession, not a journey: stays `owns` and its node stays an item.
      edge("la_edge_fx_owns_laptop", ids.person0, "owns", ids.laptop),

      // --- absorptions --------------------------------------------------------
      edge("la_edge_fx_board", ids.person0, "board-member-of", ids.org0),
      edge("la_edge_fx_advises", ids.person1, "advises", ids.org0),
      edge("la_edge_fx_alumnus", ids.person1, "alumnus-of", ids.university, {
        valid_from: "2004-09-01",
        valid_to: "2008-06-30"
      }),
      edge("la_edge_fx_mentor", ids.person0, "mentor-of", ids.person2),
      edge("la_edge_fx_partner", ids.person0, "partner-of", ids.person3),
      edge("la_edge_fx_related_attr", ids.person1, "related-to", ids.person2, {
        attrs: { relation: "former colleague" }
      }),
      // No `relation` attr: connects requires no discriminator, so the migration
      // must carry nothing rather than invent a word for the relationship.
      edge("la_edge_fx_related_bare", ids.person1, "related-to", ids.person3),
      edge("la_edge_fx_engaged", ids.person2, "engaged", ids.person3, { valid_from: "2023-05-05" }),
      edge("la_edge_fx_purch_item", ids.laptop, "purchased-from", ids.org1),
      edge("la_edge_fx_created_for", ids.person0, "created-for", ids.offering, {
        attrs: { beneficiary: legacyVocabularyIds.person1 }
      }),

      // --- carried forward unchanged -----------------------------------------
      edge("la_edge_fx_employed", ids.person0, "works-at", ids.org0),
      edge("la_edge_fx_basedin_ok", ids.org0, "based-in", ids.city),

      // --- refusals, one of each ---------------------------------------------
      // An alumnus edge with no end date. The collapse's whole argument is that
      // the membership ENDED; there is no year here to say when.
      edge("la_edge_fx_alumnus_open", ids.person2, "alumnus-of", ids.university),
      // attrs.role is already occupied by a value the absorption would overwrite.
      edge("la_edge_fx_board_conflict", ids.person1, "board-member-of", ids.org1, {
        attrs: { role: "chair" }
      }),
      // purchased-from written from the BUYER. sold-by's source is the thing
      // sold, which this edge does not name.
      edge("la_edge_fx_purch_buyer", ids.person0, "purchased-from", ids.org1),
      // created-for pointing at the beneficiary. The artifact is not named.
      edge("la_edge_fx_created_benef", ids.person0, "created-for", ids.person1),
      // Retired with no ratified absorption: its successor needs an employer this
      // edge does not carry.
      edge("la_edge_fx_reports", ids.person1, "reports-to", ids.person0),
      // based-in written backwards. The name survived the ratification, so only
      // the domain rule catches it.
      edge("la_edge_fx_basedin_inv", ids.city, "based-in", ids.org0),
      // A venue the legacy plane modelled as one node: the place is contained in
      // the business that runs it. The source is a location so the domain holds
      // and only the RANGE catches it. Its successor is operated-by, which is
      // not a mechanical rewrite — the two nodes D3 calls for do not exist yet.
      edge("la_edge_fx_contained_org", ids.city, "contained-in", ids.org0),
      edge("la_edge_fx_manages", ids.person0, "manages", ids.org1),
      edge("la_edge_fx_unknown", ids.person0, "vibes-with", ids.person1),
      // The 12 owns and 6 based-in dangles measured on the graph, in miniature.
      edge("la_edge_fx_owns_dangle", ids.person0, "owns", ids.missing),
      edge("la_edge_fx_basedin_dangle", ids.person0, "based-in", ids.missing)
    ]
  };
}
