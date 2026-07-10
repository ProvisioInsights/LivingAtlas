import {
  CanonicalEntityPayloadSchema,
  type CanonicalEntityPayload,
  type EndpointRecord
} from "@living-atlas/contracts";

/**
 * Converts only stable identity/display fields from a legacy endpoint. Sourced
 * properties, confidence, classification, and migration references are kept out
 * of the canonical entity payload for fact, evidence, and policy contracts.
 */
export function canonicalEntityPayloadFromEndpoint(endpoint: EndpointRecord): CanonicalEntityPayload {
  return CanonicalEntityPayloadSchema.parse({
    schema: "atlas.entity:v1",
    entity_id: endpoint.object_id,
    type: endpoint.type,
    subtype: endpoint.subtype,
    name: endpoint.name,
    aliases: endpoint.aliases,
    ...(endpoint.description ? { description: endpoint.description } : {}),
    created_at: endpoint.created_at,
    updated_at: endpoint.updated_at
  });
}
