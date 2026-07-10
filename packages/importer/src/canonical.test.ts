import { describe, expect, it } from "vitest";
import { EndpointRecordSchema, canonicalObjectTypeForPayload } from "@living-atlas/contracts";
import { canonicalEntityPayloadFromEndpoint } from "./canonical";

const timestamp = "2026-07-09T12:00:00.000Z";

describe("canonical entity adapter", () => {
  it("converts a legacy endpoint into an Atlas entity payload without copying migration fields", () => {
    const endpoint = EndpointRecordSchema.parse({
      object_id: "la_object_entity0001",
      type: "organization",
      subtype: "company",
      name: "Synthetic Organization",
      aliases: ["Synthetic Org"],
      description: "Synthetic description",
      source_ref: "la_source_aaaaaaaaaaaaaaaaaaaaaaaa",
      confidence: "high",
      access_class: "local-private",
      founded_year: "2020",
      homepage_ref: "https://example.invalid",
      primary_location_ref: "la_object_location0001",
      created_at: timestamp,
      updated_at: timestamp
    });

    const payload = canonicalEntityPayloadFromEndpoint(endpoint);

    expect(payload).toEqual({
      schema: "atlas.entity:v1",
      entity_id: "la_object_entity0001",
      type: "organization",
      subtype: "company",
      name: "Synthetic Organization",
      aliases: ["Synthetic Org"],
      description: "Synthetic description",
      created_at: timestamp,
      updated_at: timestamp
    });
    expect(canonicalObjectTypeForPayload(payload)).toBe("entity");
    expect(JSON.stringify(payload)).not.toContain("source_ref");
    expect(JSON.stringify(payload)).not.toContain("confidence");
    expect(JSON.stringify(payload)).not.toContain("homepage_ref");
  });
});
