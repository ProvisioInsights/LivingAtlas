import { createHash } from "node:crypto";
import { GraphObjectEnvelopeSchema, type GraphObjectEnvelope, type ObjectType } from "@living-atlas/contracts";
import {
  LegacyRedirectSchemaNamespace,
  LogseqBlockSchemaNamespace,
  type LegacyPayloadResolver
} from "./legacy-source.js";

/**
 * A synthetic legacy graph shaped by the real contracts but containing invented
 * content only. Nothing here comes from a personal corpus, and the projector is
 * proved out against this fixture alone — the real run stays blocked on offline
 * backup media and must never be pointed at a live path.
 */
export const legacyFixtureAuthorityId = "la_authority_migratefx01";

const fixtureCreatedAt = "2024-03-04T09:00:00.000Z";
const fixtureUpdatedAt = "2025-11-19T17:30:00.000Z";

export const legacyFixtureIds = {
  person: "la_object_legacy_person_0",
  organization0: "la_object_legacy_org_0",
  organization1: "la_object_legacy_org_1",
  organizationTombstoned: "la_object_legacy_org_2",
  project: "la_object_legacy_project_0",
  location: "la_object_legacy_location_0",
  topic: "la_object_legacy_topic_0",
  offering: "la_object_legacy_offering_0",
  item: "la_object_legacy_item_0",
  occurrence: "la_object_legacy_occurrence_0",
  edgeEmployment: "la_object_legacy_edge_employ",
  edgeFounder: "la_object_legacy_edge_founder",
  edgeBasedIn: "la_object_legacy_edge_based",
  edgeAbout: "la_object_legacy_edge_about",
  edgeOfferedBy: "la_object_legacy_edge_offered",
  edgeInstanceOf: "la_object_legacy_edge_instance",
  edgeParticipant: "la_object_legacy_edge_participant",
  edgeInvestment: "la_object_legacy_edge_invest",
  edgeMembershipTombstoned: "la_object_legacy_edge_member",
  edgeDangling: "la_object_legacy_edge_dangle",
  edgeEndpointNotProjected: "la_object_legacy_edge_unproj",
  edgeEndpointTypeMismatch: "la_object_legacy_edge_mismatch",
  edgeInvalidPayload: "la_object_legacy_edge_invalid",
  edgeThroughRedirect: "la_object_legacy_edge_redirect",
  /**
   * The legacy PREDICATE vocabulary, one object per way an edge meets the
   * ratified twenty-two. Every one of these used to be refused as
   * `invalid-legacy-payload` at the parse, so the whole absorption table was
   * unreachable from the path that ships and no fixture could tell.
   */
  travelSegment: "la_object_legacy_travel_seg",
  edgeOwnsSegment: "la_object_legacy_edge_owns",
  edgeSafeAlias: "la_object_legacy_edge_alias",
  edgeAbsorbedRole: "la_object_legacy_edge_absorb",
  edgeAbsorptionNeedsValidTo: "la_object_legacy_edge_alum",
  edgeRetiredNoSuccessor: "la_object_legacy_edge_retired",
  edgeDirectionUnsafe: "la_object_legacy_edge_unsafe",
  edgeUnknownPredicate: "la_object_legacy_edge_unknown",
  edgeInvertedGeography: "la_object_legacy_edge_invert",
  tombstonedUnrecoverable: "la_object_legacy_opaque_lost",
  tombstonedUnavailable: "la_object_legacy_opaque_wait",
  tombstonedQuarantine: "la_object_legacy_quarantine_t",
  liveQuarantine: "la_object_legacy_quarantine_l",
  unreadableQuarantine: "la_object_legacy_quarantine_x",
  liveUnrecoverable: "la_object_legacy_opaque_live",
  liveUnavailable: "la_object_legacy_opaque_hold",
  narrativePage: "la_object_legacy_page_0",
  narrativeBlock: "la_object_legacy_block_0",
  aliasHop1: "la_object_legacy_alias_1",
  aliasHop2: "la_object_legacy_alias_2",
  unmappedObject: "la_object_legacy_index_0",
  /**
   * A derived lookup table, named by its SCHEMA NAMESPACE rather than by an
   * `index` object type. The two are different paths and only the first reaches
   * the `derived-index` branch, which is why the seeded `other` control above
   * could not stand in for it.
   */
  derivedIndex: "la_object_legacy_refindex_0",
  /** A tombstoned venue: two entities plus three derived and minted edges. */
  tombstonedVenue: "la_object_legacy_venue_dead",
  missingEndpoint: "la_object_legacy_missing_0"
} as const;

export const LegacyReferenceIndexSchemaNamespace = "import/logseq-semantic/reference-index";

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

type EnvelopeOptions = {
  tombstone?: boolean;
  schema_namespace?: string;
};

function plaintextEnvelope(
  objectId: string,
  objectType: ObjectType,
  data: Record<string, unknown>,
  options: EnvelopeOptions = {}
): GraphObjectEnvelope {
  const tombstone = options.tombstone ?? false;
  return GraphObjectEnvelopeSchema.parse({
    schema_version: 1,
    authority_id: legacyFixtureAuthorityId,
    object_id: objectId,
    object_type: objectType,
    version: tombstone ? 2 : 1,
    access_class: "remote-safe",
    encryption_class: "plaintext",
    created_at: fixtureCreatedAt,
    updated_at: fixtureUpdatedAt,
    content_hash: sha256(JSON.stringify(data)),
    visible_metadata: {
      ...(options.schema_namespace ? { schema_namespace: options.schema_namespace } : {}),
      tombstone,
      remote_indexable: false
    },
    payload: { kind: "plaintext-json", data }
  });
}

function ciphertextEnvelope(
  objectId: string,
  objectType: ObjectType,
  options: EnvelopeOptions & { quarantine?: boolean } = {}
): GraphObjectEnvelope {
  const tombstone = options.tombstone ?? false;
  return GraphObjectEnvelopeSchema.parse({
    schema_version: 1,
    authority_id: legacyFixtureAuthorityId,
    object_id: objectId,
    object_type: objectType,
    version: tombstone ? 2 : 1,
    access_class: options.quarantine ? "quarantine" : "local-private",
    encryption_class: "client-encrypted",
    created_at: fixtureCreatedAt,
    updated_at: fixtureUpdatedAt,
    content_hash: sha256(`ciphertext:${objectId}`),
    key_ref: "la_key_legacyfixture01",
    visible_metadata: {
      ...(options.schema_namespace ? { schema_namespace: options.schema_namespace } : {}),
      tombstone,
      remote_indexable: false
    },
    payload: {
      kind: "ciphertext-inline",
      ciphertext: `legacy-fixture-ciphertext:${objectId}`,
      nonce: createHash("sha256").update(objectId).digest("hex").slice(0, 32),
      algorithm: "xchacha20-poly1305"
    }
  });
}

function endpointPayload(
  objectId: string,
  type: string,
  name: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    type,
    object_id: objectId,
    name,
    created_at: fixtureCreatedAt,
    updated_at: fixtureUpdatedAt,
    ...extra
  };
}

function edgePayload(
  edgeId: string,
  fields: {
    source_object_id: string;
    source_type: string;
    target_object_id: string;
    target_type: string;
    predicate: string;
    valid_from: string;
    valid_to?: string;
    status?: string;
    attrs?: Record<string, unknown>;
  }
): Record<string, unknown> {
  return {
    edge_id: edgeId,
    source_object_id: fields.source_object_id,
    source_type: fields.source_type,
    target_object_id: fields.target_object_id,
    target_type: fields.target_type,
    predicate: fields.predicate,
    valid_from: fields.valid_from,
    ...(fields.valid_to ? { valid_to: fields.valid_to } : {}),
    status: fields.status ?? "active",
    confidence: "medium",
    source: "legacy-fixture",
    attrs: fields.attrs ?? {}
  };
}

/**
 * Payloads a keyholding caller would be able to open. Keeping them beside the
 * envelopes lets the fixture exercise the decryptable-ciphertext path without
 * any key material: a projected record must not depend on whether the bytes
 * arrived as plaintext or as ciphertext the caller could open.
 */
const decryptableFixturePayloads: Record<string, Record<string, unknown>> = {
  [legacyFixtureIds.organization1]: endpointPayload(legacyFixtureIds.organization1, "organization", "Employer 1", {
    aliases: ["Employer One"]
  }),
  [legacyFixtureIds.edgeInvestment]: edgePayload("la_edge_legacy_invest_1", {
    source_object_id: legacyFixtureIds.person,
    source_type: "person",
    target_object_id: legacyFixtureIds.organization1,
    target_type: "organization",
    predicate: "invests-in",
    valid_from: "2022-06-01",
    attrs: { amount: "1000", investment_status: "committed" }
  }),
  [legacyFixtureIds.tombstonedQuarantine]: { note: "withheld synthetic content" },
  [legacyFixtureIds.liveQuarantine]: { note: "withheld synthetic content" }
};

const unrecoverableFixtureObjectIds = new Set<string>([
  legacyFixtureIds.tombstonedUnrecoverable,
  legacyFixtureIds.liveUnrecoverable
]);

export const legacyFixturePayloadResolver: LegacyPayloadResolver = (envelope) => {
  if (envelope.payload.kind === "plaintext-json") {
    return { kind: "plaintext", data: envelope.payload.data };
  }
  const decryptable = decryptableFixturePayloads[envelope.object_id];
  if (decryptable) {
    return { kind: "plaintext", data: decryptable };
  }
  if (unrecoverableFixtureObjectIds.has(envelope.object_id)) {
    return { kind: "unrecoverable", detail: "no surviving key material for this legacy object" };
  }
  return { kind: "unavailable", detail: "key material for this legacy object was not loaded for this run" };
};

/**
 * A synthetic legacy graph covering: typed entities of every endpoint type,
 * typed edges including exact / approximate / unknown world time, a tombstone of
 * each kind, an alias chain, the travel retype with the `owns` edge that must be
 * rewritten alongside it, the legacy predicate vocabulary in each of its shapes,
 * and one instance of every refusal the projector can name. The refusal cases
 * are deliberate — a fixture where everything projects proves nothing about the
 * closure gate, and a reason that stops firing shows up as a missing row.
 */
export function createLegacyGraphFixture(): GraphObjectEnvelope[] {
  return [
    plaintextEnvelope(
      legacyFixtureIds.person,
      "entity",
      endpointPayload(legacyFixtureIds.person, "person", "Person 0", {
        aliases: ["P. Zero"],
        description: "Synthetic person used by migration fixtures."
      })
    ),
    plaintextEnvelope(
      legacyFixtureIds.organization0,
      "entity",
      endpointPayload(legacyFixtureIds.organization0, "organization", "Employer 0")
    ),
    ciphertextEnvelope(legacyFixtureIds.organization1, "entity"),
    plaintextEnvelope(
      legacyFixtureIds.organizationTombstoned,
      "entity",
      endpointPayload(legacyFixtureIds.organizationTombstoned, "organization", "Employer 2"),
      { tombstone: true }
    ),
    plaintextEnvelope(
      legacyFixtureIds.project,
      "entity",
      endpointPayload(legacyFixtureIds.project, "project", "Project 0")
    ),
    plaintextEnvelope(
      legacyFixtureIds.location,
      "entity",
      endpointPayload(legacyFixtureIds.location, "location", "City 0")
    ),
    plaintextEnvelope(
      legacyFixtureIds.topic,
      "entity",
      endpointPayload(legacyFixtureIds.topic, "topic", "Topic 0")
    ),
    plaintextEnvelope(
      legacyFixtureIds.offering,
      "entity",
      endpointPayload(legacyFixtureIds.offering, "offering", "Offering 0")
    ),
    plaintextEnvelope(
      legacyFixtureIds.item,
      "entity",
      endpointPayload(legacyFixtureIds.item, "item", "Item 0")
    ),
    plaintextEnvelope(
      legacyFixtureIds.occurrence,
      "entity",
      endpointPayload(legacyFixtureIds.occurrence, "occurrence", "Occurrence 0", {
        subtype: "meeting",
        occurred_on: "2023-09-12"
      })
    ),

    plaintextEnvelope(
      legacyFixtureIds.edgeEmployment,
      "edge",
      edgePayload("la_edge_legacy_employ_1", {
        source_object_id: legacyFixtureIds.person,
        source_type: "person",
        target_object_id: legacyFixtureIds.organization0,
        target_type: "organization",
        predicate: "employed-by",
        valid_from: "2019-04-01",
        attrs: { role: "Engineer" }
      })
    ),
    plaintextEnvelope(
      legacyFixtureIds.edgeFounder,
      "edge",
      edgePayload("la_edge_legacy_founder_1", {
        source_object_id: legacyFixtureIds.person,
        source_type: "person",
        target_object_id: legacyFixtureIds.organization0,
        target_type: "organization",
        predicate: "founder-of",
        valid_from: "~2018"
      })
    ),
    plaintextEnvelope(
      legacyFixtureIds.edgeBasedIn,
      "edge",
      edgePayload("la_edge_legacy_based_1", {
        source_object_id: legacyFixtureIds.organization0,
        source_type: "organization",
        target_object_id: legacyFixtureIds.location,
        target_type: "location",
        predicate: "based-in",
        valid_from: "unknown"
      })
    ),
    plaintextEnvelope(
      legacyFixtureIds.edgeAbout,
      "edge",
      edgePayload("la_edge_legacy_about_1", {
        source_object_id: legacyFixtureIds.project,
        source_type: "project",
        target_object_id: legacyFixtureIds.topic,
        target_type: "topic",
        predicate: "about",
        valid_from: "2021-01-01"
      })
    ),
    plaintextEnvelope(
      legacyFixtureIds.edgeOfferedBy,
      "edge",
      edgePayload("la_edge_legacy_offered_1", {
        source_object_id: legacyFixtureIds.offering,
        source_type: "offering",
        target_object_id: legacyFixtureIds.organization0,
        target_type: "organization",
        predicate: "offered-by",
        valid_from: "2020-02-02"
      })
    ),
    plaintextEnvelope(
      legacyFixtureIds.edgeInstanceOf,
      "edge",
      edgePayload("la_edge_legacy_instance_1", {
        source_object_id: legacyFixtureIds.item,
        source_type: "item",
        target_object_id: legacyFixtureIds.organization0,
        target_type: "organization",
        predicate: "sold-by",
        valid_from: "2020-05-05"
      })
    ),
    plaintextEnvelope(
      legacyFixtureIds.edgeParticipant,
      "edge",
      edgePayload("la_edge_legacy_participant_1", {
        source_object_id: legacyFixtureIds.person,
        source_type: "person",
        target_object_id: legacyFixtureIds.occurrence,
        target_type: "occurrence",
        predicate: "participant-in",
        valid_from: "2023-09-12"
      })
    ),
    ciphertextEnvelope(legacyFixtureIds.edgeInvestment, "edge"),
    plaintextEnvelope(
      legacyFixtureIds.edgeMembershipTombstoned,
      "edge",
      edgePayload("la_edge_legacy_member_1", {
        source_object_id: legacyFixtureIds.person,
        source_type: "person",
        target_object_id: legacyFixtureIds.organizationTombstoned,
        target_type: "organization",
        predicate: "member-of",
        valid_from: "2017-07-07",
        valid_to: "2019-03-31"
      }),
      { tombstone: true }
    ),
    plaintextEnvelope(
      legacyFixtureIds.edgeDangling,
      "edge",
      edgePayload("la_edge_legacy_dangle_1", {
        source_object_id: legacyFixtureIds.person,
        source_type: "person",
        target_object_id: legacyFixtureIds.missingEndpoint,
        target_type: "organization",
        predicate: "member-of",
        valid_from: "2020-01-01"
      })
    ),
    plaintextEnvelope(
      legacyFixtureIds.edgeEndpointNotProjected,
      "edge",
      edgePayload("la_edge_legacy_unproj_1", {
        source_object_id: legacyFixtureIds.person,
        source_type: "person",
        target_object_id: legacyFixtureIds.narrativePage,
        target_type: "organization",
        predicate: "member-of",
        valid_from: "2020-01-01"
      })
    ),
    plaintextEnvelope(
      legacyFixtureIds.edgeEndpointTypeMismatch,
      "edge",
      edgePayload("la_edge_legacy_mismatch_1", {
        source_object_id: legacyFixtureIds.organization0,
        source_type: "person",
        target_object_id: legacyFixtureIds.organizationTombstoned,
        target_type: "organization",
        predicate: "member-of",
        valid_from: "2020-01-01"
      })
    ),
    // Names the head of the alias chain rather than the person directly: the
    // projection must follow the redirect the legacy store already recorded.
    plaintextEnvelope(
      legacyFixtureIds.edgeThroughRedirect,
      "edge",
      edgePayload("la_edge_legacy_redirect_1", {
        source_object_id: legacyFixtureIds.aliasHop1,
        source_type: "person",
        target_object_id: legacyFixtureIds.organization0,
        target_type: "organization",
        predicate: "member-of",
        valid_from: "2021-03-03"
      })
    ),
    // Genuinely malformed: no `valid_from` at all, which the legacy edge shape
    // requires as much as the ratified one does. It used to carry a
    // direction-unsafe PREDICATE instead, which meant the only test of
    // `invalid-legacy-payload` was really a test of the predicate check wearing
    // the wrong reason — and it passed for exactly as long as every predicate
    // outside the ratified twenty-two was reported as a broken payload.
    plaintextEnvelope(legacyFixtureIds.edgeInvalidPayload, "edge", {
      edge_id: "la_edge_legacy_invalid_1",
      source_object_id: legacyFixtureIds.person,
      source_type: "person",
      target_object_id: legacyFixtureIds.organization0,
      target_type: "organization",
      predicate: "member-of",
      source: "legacy-fixture"
    }),

    // THE TRAVEL RETYPE AND ITS EDGE (gate G1a). The leg is stored as an `item`
    // and becomes an `occurrence/segment`; the `owns` edge pointing at it must
    // become `participant-in` in the same plan, because a person does not own a
    // journey and the ratified `owns` range exists to make that unwritable.
    plaintextEnvelope(
      legacyFixtureIds.travelSegment,
      "entity",
      endpointPayload(legacyFixtureIds.travelSegment, "item", "Leg 0", {
        subtype: "flight",
        route: "PT0-QR0",
        date: "2023-08-08"
      })
    ),
    plaintextEnvelope(
      legacyFixtureIds.edgeOwnsSegment,
      "edge",
      edgePayload("la_edge_legacy_owns_1", {
        source_object_id: legacyFixtureIds.person,
        source_type: "person",
        // Says `item`, faithfully, because that is what the legacy node was.
        target_object_id: legacyFixtureIds.travelSegment,
        target_type: "item",
        predicate: "owns",
        valid_from: "2023-08-08"
      })
    ),

    // A safe alias: same relation, same endpoint types, so it canonicalizes.
    plaintextEnvelope(
      legacyFixtureIds.edgeSafeAlias,
      "edge",
      edgePayload("la_edge_legacy_alias_1", {
        source_object_id: legacyFixtureIds.person,
        source_type: "person",
        target_object_id: legacyFixtureIds.organization1,
        target_type: "organization",
        predicate: "works-at",
        valid_from: "2016-01-01"
      })
    ),

    // An absorption that carries the retired name's meaning into attrs.role.
    plaintextEnvelope(
      legacyFixtureIds.edgeAbsorbedRole,
      "edge",
      edgePayload("la_edge_legacy_absorb_1", {
        source_object_id: legacyFixtureIds.person,
        source_type: "person",
        target_object_id: legacyFixtureIds.organization1,
        target_type: "organization",
        predicate: "board-member-of",
        valid_from: "2018-01-01"
      })
    ),

    // The same collapse WITHOUT the time bound that justifies it. `alumnus-of`
    // becomes `member-of` because the membership ended, so an edge that records
    // no end has nothing to collapse on and the year is not invented.
    plaintextEnvelope(
      legacyFixtureIds.edgeAbsorptionNeedsValidTo,
      "edge",
      edgePayload("la_edge_legacy_alum_1", {
        source_object_id: legacyFixtureIds.person,
        source_type: "person",
        target_object_id: legacyFixtureIds.organization1,
        target_type: "organization",
        predicate: "alumnus-of",
        valid_from: "2010-09-01"
      })
    ),

    // Retired with a successor that needs an endpoint this edge does not name.
    plaintextEnvelope(
      legacyFixtureIds.edgeRetiredNoSuccessor,
      "edge",
      edgePayload("la_edge_legacy_retired_1", {
        source_object_id: legacyFixtureIds.person,
        source_type: "person",
        target_object_id: legacyFixtureIds.person,
        target_type: "person",
        predicate: "reports-to",
        valid_from: "2021-01-01"
      })
    ),

    plaintextEnvelope(
      legacyFixtureIds.edgeDirectionUnsafe,
      "edge",
      edgePayload("la_edge_legacy_unsafe_1", {
        source_object_id: legacyFixtureIds.person,
        source_type: "person",
        target_object_id: legacyFixtureIds.organization0,
        target_type: "organization",
        predicate: "manages",
        valid_from: "2020-01-01"
      })
    ),

    plaintextEnvelope(
      legacyFixtureIds.edgeUnknownPredicate,
      "edge",
      edgePayload("la_edge_legacy_unknown_1", {
        source_object_id: legacyFixtureIds.person,
        source_type: "person",
        target_object_id: legacyFixtureIds.organization0,
        target_type: "organization",
        predicate: "frobnicates",
        valid_from: "2020-01-01"
      })
    ),

    // `based-in` kept its name and lost a direction. Written place -> business it
    // now says what `operated-by` says, so it is refused on the domain rule
    // rather than quietly rewritten into the predicate it resembles.
    plaintextEnvelope(
      legacyFixtureIds.edgeInvertedGeography,
      "edge",
      edgePayload("la_edge_legacy_invert_1", {
        source_object_id: legacyFixtureIds.location,
        source_type: "location",
        target_object_id: legacyFixtureIds.organization0,
        target_type: "organization",
        predicate: "based-in",
        valid_from: "unknown"
      })
    ),

    ciphertextEnvelope(legacyFixtureIds.tombstonedUnrecoverable, "page", { tombstone: true }),
    ciphertextEnvelope(legacyFixtureIds.tombstonedUnavailable, "page", { tombstone: true }),
    ciphertextEnvelope(legacyFixtureIds.tombstonedQuarantine, "page", { tombstone: true, quarantine: true }),
    ciphertextEnvelope(legacyFixtureIds.liveQuarantine, "page", { quarantine: true }),
    // Quarantined AND unreadable: the classification must still be driven by the
    // quarantine, so the run reports a withheld object rather than a lost one.
    ciphertextEnvelope(legacyFixtureIds.unreadableQuarantine, "page", { tombstone: true, quarantine: true }),
    ciphertextEnvelope(legacyFixtureIds.liveUnrecoverable, "page"),
    ciphertextEnvelope(legacyFixtureIds.liveUnavailable, "page"),

    plaintextEnvelope(legacyFixtureIds.narrativePage, "page", { title: "Note 0", body: "Synthetic narrative body." }),
    plaintextEnvelope(legacyFixtureIds.narrativeBlock, "block", { body: "Synthetic narrative block." }),

    // Deliberately not migrated, and refused under its OWN reason: the new plane
    // rebuilds this table, and a stale copy of an index answers confidently and
    // wrongly. Distinct from `other`, which means nobody decided.
    plaintextEnvelope(
      legacyFixtureIds.derivedIndex,
      "page",
      { entries: 3 },
      { schema_namespace: LegacyReferenceIndexSchemaNamespace }
    ),

    // A DELETED VENUE. One row that produced two entities, an operated-by edge
    // and a has-type edge per half — five records, all of which the deletion has
    // to reach.
    plaintextEnvelope(
      legacyFixtureIds.tombstonedVenue,
      "entity",
      endpointPayload(legacyFixtureIds.tombstonedVenue, "location", "Venue 2", { subtype: "restaurant" }),
      { tombstone: true }
    ),

    plaintextEnvelope(
      legacyFixtureIds.aliasHop1,
      "entity",
      { redirects_to: legacyFixtureIds.aliasHop2 },
      { schema_namespace: LegacyRedirectSchemaNamespace }
    ),
    plaintextEnvelope(
      legacyFixtureIds.aliasHop2,
      "entity",
      { redirects_to: legacyFixtureIds.person },
      { schema_namespace: LegacyRedirectSchemaNamespace }
    )
  ];
}

export const legacyVenueFixtureIds = {
  venueRestaurant: "la_object_legacy_venue_r",
  venueHotel: "la_object_legacy_venue_h",
  city: "la_object_legacy_venue_city",
  lawFirm: "la_object_legacy_venue_firm",
  segment: "la_object_legacy_venue_seg",
  conflictedSegment: "la_object_legacy_venue_bad",
  personOneEmployer: "la_object_legacy_venue_p1",
  personNoEmployer: "la_object_legacy_venue_p0",
  personTwoEmployers: "la_object_legacy_venue_p2",
  employerA: "la_object_legacy_venue_ea",
  employerB: "la_object_legacy_venue_eb",
  edgeOccurredAt: "la_object_legacy_venue_eoc",
  edgeEmployOne: "la_object_legacy_venue_e1",
  edgeEmployTwoA: "la_object_legacy_venue_e2a",
  edgeEmployTwoB: "la_object_legacy_venue_e2b"
} as const;

/**
 * A legacy graph in the OLD vocabulary — retired subtypes and the denormalised
 * attributes that the venue split and the attribute deduplication exist to fix.
 *
 * It is separate from `createLegacyGraphFixture` on purpose. That fixture now
 * speaks the target vocabulary and proves the projector still reads a modern
 * export unchanged; this one proves it reads what the old store actually wrote.
 * A projector tested only against the new shape would pass every test and refuse
 * the entire real corpus.
 *
 * Content is invented. `Venue 0`, `Employer A` and `Person 1` are placeholders.
 */
export function createLegacyVenueFixture(): GraphObjectEnvelope[] {
  const ids = legacyVenueFixtureIds;
  return [
    // The parent place a venue is contained in.
    plaintextEnvelope(ids.city, "entity", endpointPayload(ids.city, "location", "City 1", { subtype: "city" })),

    // THE VENUE SPLIT: one row meaning a place AND a business. Carries attributes
    // of both kinds so the allocation rule has something to divide.
    plaintextEnvelope(
      ids.venueRestaurant,
      "entity",
      endpointPayload(ids.venueRestaurant, "location", "Venue 0", {
        subtype: "restaurant",
        parent_location_ref: ids.city,
        geo: { latitude: 1.5, longitude: 2.5 },
        timezone: "UTC",
        founded_year: "1998",
        homepage_ref: "https://example.invalid/venue-0"
      })
    ),
    plaintextEnvelope(
      ids.venueHotel,
      "entity",
      endpointPayload(ids.venueHotel, "location", "Venue 1", {
        subtype: "hotel",
        parent_location_ref: ids.city
      })
    ),

    // A non-venue subtype: classification without a split.
    plaintextEnvelope(
      ids.lawFirm,
      "entity",
      endpointPayload(ids.lawFirm, "organization", "Employer C", { subtype: "law-firm" })
    ),

    // provider/airline/merchant, three date names, and both participant lists.
    plaintextEnvelope(
      ids.segment,
      "entity",
      endpointPayload(ids.segment, "occurrence", "Segment 0", {
        subtype: "segment",
        airline: "Carrier 0",
        merchant: "Agency 0",
        date: "2023-04-05",
        purchase_date: "2023-04-05",
        participant_refs: [ids.personNoEmployer],
        organizer_refs: [ids.personOneEmployer]
      })
    ),
    // G8 said provider and airline never co-occur. This one makes them disagree,
    // so the enforcement has something to refuse.
    plaintextEnvelope(
      ids.conflictedSegment,
      "entity",
      endpointPayload(ids.conflictedSegment, "occurrence", "Segment 1", {
        subtype: "segment",
        provider: "Carrier 0",
        airline: "Carrier 1",
        date: "2023-06-07"
      })
    ),

    plaintextEnvelope(ids.employerA, "entity", endpointPayload(ids.employerA, "organization", "Employer A")),
    plaintextEnvelope(ids.employerB, "entity", endpointPayload(ids.employerB, "organization", "Employer B")),

    // Exactly one employer: job_title becomes attrs.role on that edge.
    plaintextEnvelope(
      ids.personOneEmployer,
      "entity",
      endpointPayload(ids.personOneEmployer, "person", "Person 1", { job_title: "Title 1" })
    ),
    // No employer edge, but company_current names one: backfill, then the title
    // has exactly one edge to land on.
    plaintextEnvelope(
      ids.personNoEmployer,
      "entity",
      endpointPayload(ids.personNoEmployer, "person", "Person 2", {
        company_current: "Employer D",
        job_title: "Title 2"
      })
    ),
    // Two employers: the title cannot be placed without choosing one.
    plaintextEnvelope(
      ids.personTwoEmployers,
      "entity",
      endpointPayload(ids.personTwoEmployers, "person", "Person 3", { job_title: "Title 3" })
    ),

    plaintextEnvelope(
      ids.edgeOccurredAt,
      "edge",
      edgePayload("la_edge_legacy_venue_occ", {
        source_object_id: ids.segment,
        source_type: "occurrence",
        // Declares `location`, which is how it routes to the location half.
        target_object_id: ids.venueRestaurant,
        target_type: "location",
        predicate: "occurred-at",
        valid_from: "2023-04-05"
      })
    ),
    plaintextEnvelope(
      ids.edgeEmployOne,
      "edge",
      edgePayload("la_edge_legacy_venue_em1", {
        source_object_id: ids.personOneEmployer,
        source_type: "person",
        target_object_id: ids.employerA,
        target_type: "organization",
        predicate: "employed-by",
        valid_from: "2020-01-01"
      })
    ),
    plaintextEnvelope(
      ids.edgeEmployTwoA,
      "edge",
      edgePayload("la_edge_legacy_venue_em2", {
        source_object_id: ids.personTwoEmployers,
        source_type: "person",
        target_object_id: ids.employerA,
        target_type: "organization",
        predicate: "employed-by",
        valid_from: "2019-01-01"
      })
    ),
    plaintextEnvelope(
      ids.edgeEmployTwoB,
      "edge",
      edgePayload("la_edge_legacy_venue_em3", {
        source_object_id: ids.personTwoEmployers,
        source_type: "person",
        target_object_id: ids.employerB,
        target_type: "organization",
        predicate: "employed-by",
        valid_from: "2021-01-01"
      })
    )
  ];
}

export const legacyTopicIdentityFixtureIds = {
  corpusTopic: "la_object_legacy_topic_reuse",
  carrierOfCorpusWord: "la_object_legacy_topic_byname",
  carrierOfCorpusWordAgain: "la_object_legacy_topic_byname2",
  carrierUnmatched: "la_object_legacy_topic_fresh",
  duplicateTopicA: "la_object_legacy_topic_dupa",
  duplicateTopicB: "la_object_legacy_topic_dupb",
  carrierOfDuplicated: "la_object_legacy_topic_dupc",
  occupationCarrier: "la_object_legacy_topic_occup",
  subtypeCarrierOfOccupation: "la_object_legacy_topic_occos",
  occupationCarrierOtherCase: "la_object_legacy_topic_occup2"
} as const;

/**
 * THE SHAPE THE IMPORTER ACTUALLY WRITES, and the reason these builders exist
 * instead of the flat `object_type: "entity"` envelope the older fixtures use.
 *
 * A typed endpoint reaches the migration as `object_type: "page"` under the
 * schema namespace `import/logseq-semantic/typed-endpoint`, with the record
 * WRAPPED as `{kind, source_path_ref, endpoint}` — see
 * `packages/importer/src/logseq-semantic.ts`. A fixture that builds a flat
 * `entity` envelope exercises the same projector branch but not the same
 * construction path, so it cannot fail for the reasons a real corpus fails:
 * a regression in the unwrap, in the namespace table, or in the endpoint schema
 * would leave every such fixture green while the real run refused every node.
 *
 * ONE AXIS IS DELIBERATELY NOT FAITHFUL: the real objects are `local-private`
 * and client-encrypted, and the envelope schema forbids a plaintext payload on
 * those, so these carry `remote-safe` plaintext. The decrypt path is a property
 * of the payload RESOLVER rather than of the record, and it is covered by
 * `createLegacyGraphFixture`, which projects a decryptable ciphertext entity
 * through the same branch.
 */
function importedEndpointEnvelope(
  objectId: string,
  endpoint: Record<string, unknown>,
  options: EnvelopeOptions = {}
): GraphObjectEnvelope {
  return plaintextEnvelope(
    objectId,
    "page",
    { kind: "logseq-endpoint", source_path_ref: `ref_${objectId}`, endpoint },
    { ...options, schema_namespace: "import/logseq-semantic/typed-endpoint" }
  );
}

/**
 * The endpoint record the importer writes, which is an `EndpointRecord` and
 * therefore carries the four fields beyond the obvious ones. They are here
 * because the strict contract schema is tried FIRST: an endpoint that satisfies
 * it takes the canonical lane, and one that does not takes the legacy mapper —
 * two different lanes, and a fixture that only ever produced one of them would
 * leave the other untested.
 */
function importedEndpoint(
  objectId: string,
  type: string,
  name: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    object_id: objectId,
    type,
    name,
    aliases: [],
    access_class: "remote-safe",
    source_ref: `ref_${objectId}`,
    confidence: "high",
    created_at: fixtureCreatedAt,
    updated_at: fixtureUpdatedAt,
    ...extra
  };
}

/**
 * A curated topic node as the TOPIC-REVIEW PROMOTION path writes it: a third
 * namespace, a different wrapper `kind`, and the two extra endpoint fields that
 * path sets. This is the most plausible way a `topic` node exists in a real
 * corpus at all, so a fixture that only built topics the typed-endpoint way
 * would not be testing the path the owner's topics arrive on.
 */
function promotedTopicEnvelope(objectId: string, name: string, aliases: string[] = []): GraphObjectEnvelope {
  return plaintextEnvelope(
    objectId,
    "page",
    {
      kind: "logseq-topic-review-promotion",
      target_hash: `hash_${objectId}`,
      reason_code: "fixture-promoted",
      decision: "promote",
      endpoint: {
        ...importedEndpoint(objectId, "topic", name, { aliases }),
        controlled: true,
        tags: []
      }
    },
    { schema_namespace: "import/logseq-topic-review/promoted" }
  );
}

/**
 * The word the corpus topic and its carriers share. Invented, like every value
 * in this file: the real collision that motivated the change was a private topic
 * name, and a fixture is not a place to record one.
 */
const FixtureSharedTopicName = "Topic 3";
const FixtureSharedTopicAlias = "Topic Three";
const FixtureDuplicatedTopicName = "Topic 4";
/** Held by a person as a job title AND by an organization as a retired subtype. */
const FixtureOccupationName = "Topic 8";

/**
 * THE THREE OUTCOMES OF THE TOPIC CHECK, in one fixture, because they are three
 * different situations and a fixture carrying one cannot tell the paths apart.
 *
 * REUSE WITHIN A SCHEME. Two carriers name one retired subtype word in two
 * spellings — case, a trailing space and a doubled internal space between them —
 * and both must reach ONE `entity-kind` node. Nine organizations that each said
 * `airline` reaching nine nodes is the failure this property exists to stop.
 *
 * A HOMONYM ACROSS SCHEMES. The corpus holds a `subject-matter` topic whose name
 * is that same word. It is NOT reused: a `has-type` classification landing on the
 * owner's subject would assert the two are one concept on the strength of a
 * string. Two nodes, two schemes, reported and tolerated.
 *
 * A DUPLICATE INSIDE ONE SCHEME. Two `subject-matter` topics the corpus itself
 * holds under one name. The migration did not cause it and cannot fix it: both
 * come across, both ids stay resolvable, and the merge is a curation step inside
 * Atlas. A carrier of that same word is present too, so the word spans both a
 * duplicate AND a homonym — which proves the two findings are computed
 * independently rather than one swallowing the other.
 *
 * A further carrier names a word nothing else holds, so a test that minting was
 * not simply disabled has a control to read.
 */
export function createTopicIdentityFixture(): GraphObjectEnvelope[] {
  const ids = legacyTopicIdentityFixtureIds;
  return [
    promotedTopicEnvelope(ids.corpusTopic, FixtureSharedTopicName, [FixtureSharedTopicAlias]),
    // Case, a trailing space and a doubled internal space — every operation the
    // canonical key performs, in one value, so a key that stopped doing any one
    // of them stops matching the spelling below.
    importedEndpointEnvelope(
      ids.carrierOfCorpusWord,
      importedEndpoint(ids.carrierOfCorpusWord, "organization", "Employer G", { subtype: " topic  3 " })
    ),
    importedEndpointEnvelope(
      ids.carrierOfCorpusWordAgain,
      importedEndpoint(ids.carrierOfCorpusWordAgain, "organization", "Employer H", { subtype: "TOPIC 3" })
    ),
    importedEndpointEnvelope(
      ids.carrierUnmatched,
      importedEndpoint(ids.carrierUnmatched, "organization", "Employer I", { subtype: "topic 5" })
    ),

    // The duplicated pair arrives on the TYPED-ENDPOINT path rather than the
    // promotion path, so the fixture covers a corpus topic from each of the two
    // namespaces a topic can reach the migration through.
    importedEndpointEnvelope(
      ids.duplicateTopicA,
      importedEndpoint(ids.duplicateTopicA, "topic", FixtureDuplicatedTopicName)
    ),
    importedEndpointEnvelope(
      ids.duplicateTopicB,
      importedEndpoint(ids.duplicateTopicB, "topic", FixtureDuplicatedTopicName)
    ),
    importedEndpointEnvelope(
      ids.carrierOfDuplicated,
      importedEndpoint(ids.carrierOfDuplicated, "organization", "Employer J", {
        subtype: FixtureDuplicatedTopicName
      })
    )
  ];
}

/**
 * THE COLLISION THE REAL CORPUS ACTUALLY PRODUCED, which no fixture here held.
 *
 * A person's `job_title` mints an occupation topic through the derived-node
 * registry; an organization's retired `subtype` mints a classification topic
 * through the ratified table. One word, two nodes, and BOTH created by this
 * migration — so no amount of resolving against the corpus removes it, because
 * the corpus holds neither.
 *
 * It is a separate builder from `createTopicIdentityFixture` because a plan
 * carrying it cannot certify, and the reuse fixture must stay one that does.
 *
 * The third node is the same occupation word in another case: the derived
 * registry keys on the raw value, so two spellings of one job title used to
 * mint two occupation topics — a duplicate inside a single namespace, with no
 * question of merging anything across one.
 */
export function createOccupationCollisionFixture(): GraphObjectEnvelope[] {
  const ids = legacyTopicIdentityFixtureIds;
  return [
    importedEndpointEnvelope(
      ids.occupationCarrier,
      importedEndpoint(ids.occupationCarrier, "person", "Person 5", { job_title: FixtureOccupationName })
    ),
    importedEndpointEnvelope(
      ids.occupationCarrierOtherCase,
      importedEndpoint(ids.occupationCarrierOtherCase, "person", "Person 6", {
        job_title: FixtureOccupationName.toLowerCase()
      })
    ),
    importedEndpointEnvelope(
      ids.subtypeCarrierOfOccupation,
      importedEndpoint(ids.subtypeCarrierOfOccupation, "organization", "Employer L", {
        subtype: FixtureOccupationName
      })
    )
  ];
}

export const legacyTopicIdentityFixtureWords = {
  shared: FixtureSharedTopicName,
  sharedAlias: FixtureSharedTopicAlias,
  duplicated: FixtureDuplicatedTopicName,
  occupation: FixtureOccupationName,
  unmatched: "topic 5"
} as const;

/**
 * Seeded negative control for the closure gate: an object_type this projector
 * never declared a mapping for. It must FAIL the gate rather than pass through
 * uncounted, which is the exact failure the gate exists to catch.
 */
export function createUnmappedCategoryFixture(): GraphObjectEnvelope[] {
  return [
    ...createLegacyGraphFixture(),
    plaintextEnvelope(legacyFixtureIds.unmappedObject, "index", { entries: 3 })
  ];
}

export const legacyBlockFixtureIds = {
  /** Nested, with properties, non-zero index and depth. */
  block: "la_object_legacy_lsblock_0",
  /**
   * The FALSY-ZERO case: first block of a file, at the top of the outline.
   * `index: 0` and `depth: 0` are real positions and a carry-over written with
   * a truthiness check drops both without failing anything else.
   */
  blockAtOrigin: "la_object_legacy_lsblock_1",
  /** An empty bullet. A node of the outline whose text happens to be "". */
  blockEmptyText: "la_object_legacy_lsblock_2",
  /** No `properties` key at all, which is the ordinary case in an outline. */
  blockWithoutProperties: "la_object_legacy_lsblock_3",
  /** Deleted: carried AND retracted, exactly like a deleted node. */
  blockTombstoned: "la_object_legacy_lsblock_4",
  /** Carries a key the shape measurement never saw, so it must be refused. */
  blockUnmeasuredShape: "la_object_legacy_lsblock_5",
  /** A block-shaped object in no namespace this projector measured. */
  blockUnknownNamespace: "la_object_legacy_lsblock_6",
  /** A page and an attachment, which stay refused — see ADR 0029. */
  page: "la_object_legacy_lspage_0",
  attachment: "la_object_legacy_lsattach_0",
  /**
   * A node that projects, so the edge below fails on the END it is about. With
   * an absent source the edge would refuse as `dangling-edge-endpoint` and the
   * assertion would pass for a reason that has nothing to do with blocks.
   */
  author: "la_object_legacy_lsblock_person",
  /** An edge naming a block. Carrying blocks must not make it resolvable. */
  edgeAtBlock: "la_object_legacy_lsblock_edge"
} as const;

/**
 * Invented outline text. Long enough to be recognisable in an assertion that the
 * plan REPORT does not contain it — a block's text is the most content-bearing
 * thing the plan holds, and the review surface must stay free of it.
 */
export const legacyBlockFixtureText = {
  nested: "Synthetic outline bullet about a fictional errand.",
  origin: "Synthetic first bullet of a synthetic file.",
  withoutProperties: "Synthetic bullet carrying no properties at all.",
  tombstoned: "Synthetic bullet that was later deleted."
} as const;

function blockPayload(fields: {
  source_path_ref: string;
  source_block_ref: string;
  index: number;
  depth: number;
  text: string;
  properties?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    kind: "block",
    source_path_ref: fields.source_path_ref,
    source_block_ref: fields.source_block_ref,
    index: fields.index,
    depth: fields.depth,
    text: fields.text,
    ...(fields.properties === undefined ? {} : { properties: fields.properties })
  };
}

/**
 * The outline blocks the owner decided to carry across now and model later
 * (ADR 0029), beside the two shapes that must NOT ride along with them.
 *
 * Separate from `createLegacyGraphFixture` on purpose. That fixture's job is to
 * be a plan with no gate findings at all, and a carried block legitimately
 * produces a tolerated one — folding these in would have cost the repository its
 * only "a clean plan is completely silent" assertion in exchange for nothing.
 *
 * Every payload is invented. The shapes are the ones the carry-over was written
 * against; the words are not from anybody's graph.
 */
export function createLogseqBlockFixture(): GraphObjectEnvelope[] {
  const ids = legacyBlockFixtureIds;
  const blockNamespace = { schema_namespace: LogseqBlockSchemaNamespace };
  return [
    plaintextEnvelope(
      ids.block,
      "block",
      blockPayload({
        source_path_ref: "pages/synthetic-note.md",
        source_block_ref: "block-ref-0001",
        index: 3,
        depth: 2,
        text: legacyBlockFixtureText.nested,
        properties: { "synthetic-key": "synthetic-value", "synthetic-count": 2 }
      }),
      blockNamespace
    ),
    plaintextEnvelope(
      ids.blockAtOrigin,
      "block",
      blockPayload({
        source_path_ref: "pages/synthetic-note.md",
        source_block_ref: "block-ref-0002",
        index: 0,
        depth: 0,
        text: legacyBlockFixtureText.origin,
        properties: {}
      }),
      blockNamespace
    ),
    plaintextEnvelope(
      ids.blockEmptyText,
      "block",
      blockPayload({
        source_path_ref: "pages/synthetic-note.md",
        source_block_ref: "block-ref-0003",
        index: 1,
        depth: 1,
        text: "",
        properties: {}
      }),
      blockNamespace
    ),
    plaintextEnvelope(
      ids.blockWithoutProperties,
      "block",
      blockPayload({
        source_path_ref: "pages/synthetic-other.md",
        source_block_ref: "block-ref-0004",
        index: 0,
        depth: 0,
        text: legacyBlockFixtureText.withoutProperties
      }),
      blockNamespace
    ),
    plaintextEnvelope(
      ids.blockTombstoned,
      "block",
      blockPayload({
        source_path_ref: "pages/synthetic-other.md",
        source_block_ref: "block-ref-0005",
        index: 1,
        depth: 0,
        text: legacyBlockFixtureText.tombstoned,
        properties: {}
      }),
      { ...blockNamespace, tombstone: true }
    ),

    // A key nobody measured. Refused BY NAME rather than carried with the key
    // dropped: a carry-over that calls itself lossless can never produce a
    // record that quietly holds less than its source did.
    plaintextEnvelope(
      ids.blockUnmeasuredShape,
      "block",
      {
        ...blockPayload({
          source_path_ref: "pages/synthetic-other.md",
          source_block_ref: "block-ref-0006",
          index: 2,
          depth: 0,
          text: "Synthetic bullet from a later importer."
        }),
        collapsed: true
      },
      blockNamespace
    ),

    // Block-shaped, in a namespace this projector has not measured. It stays
    // narrative and stays refused, which is what keeps the carry-over scoped to
    // a shape somebody has actually looked at.
    plaintextEnvelope(
      ids.blockUnknownNamespace,
      "block",
      { body: "Synthetic block from an importer nobody has measured." },
      { schema_namespace: "import/some-other-importer/block" }
    ),

    // PAGES AND ATTACHMENTS DO NOT RIDE ALONG — ADR 0029. A page has a different
    // shape and this lane measured none of it; an attachment's content is a file
    // the store never held. Both stay refused under a named reason, both stay
    // readable in the frozen replica, and the closure gate still balances.
    plaintextEnvelope(ids.page, "page", { title: "Synthetic Note", body: "Synthetic page body." }),
    plaintextEnvelope(ids.attachment, "attachment", { filename: "synthetic.pdf", byte_length: 11 }),

    plaintextEnvelope(ids.author, "entity", endpointPayload(ids.author, "person", "Reader 0")),

    // An edge whose target is a carried block. It must STILL be refused: a block
    // is not an endpoint, and carrying one must not turn an unresolvable edge
    // into an edge pointing at a record with no type.
    plaintextEnvelope(
      ids.edgeAtBlock,
      "edge",
      edgePayload("la_edge_legacy_lsblock_1", {
        source_object_id: ids.author,
        source_type: "person",
        target_object_id: ids.block,
        target_type: "topic",
        predicate: "about",
        valid_from: "2024-01-01"
      })
    )
  ];
}
