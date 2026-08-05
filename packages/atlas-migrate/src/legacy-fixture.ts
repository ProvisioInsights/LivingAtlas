import { createHash } from "node:crypto";
import { GraphObjectEnvelopeSchema, type GraphObjectEnvelope, type ObjectType } from "@living-atlas/contracts";
import { LegacyRedirectSchemaNamespace, type LegacyPayloadResolver } from "./legacy-source.js";

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
  missingEndpoint: "la_object_legacy_missing_0"
} as const;

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
 * Thirty-three legacy objects covering: typed entities of every endpoint type,
 * typed edges including exact / approximate / unknown world time, a tombstone of
 * each kind, an alias chain, and one instance of every refusal the projector can
 * name. The refusal cases are deliberate — a fixture where everything projects
 * proves nothing about the closure gate.
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
    plaintextEnvelope(legacyFixtureIds.edgeInvalidPayload, "edge", {
      edge_id: "la_edge_legacy_invalid_1",
      source_object_id: legacyFixtureIds.person,
      source_type: "person",
      target_object_id: legacyFixtureIds.organization0,
      target_type: "organization",
      predicate: "manages",
      valid_from: "2020-01-01",
      source: "legacy-fixture"
    }),

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
