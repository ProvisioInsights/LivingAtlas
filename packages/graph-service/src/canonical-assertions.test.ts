import { describe, expect, it } from "vitest";
import type { CanonicalFactPayload, GraphObjectEnvelope } from "@living-atlas/contracts";
import {
  loadCanonicalAssertionsFromObjects,
  projectCanonicalAssertions
} from "./canonical-assertions";

const evidenceId = "la_object_evidence0001";
const confidence = {
  band: "high",
  assessment_kind: "assertion",
  method: "synthetic-lineage-test",
  assessed_at: "2026-06-01T00:00:00.000Z",
  evidence_refs: [evidenceId]
} satisfies CanonicalFactPayload["confidence"];

function fact(input: Pick<CanonicalFactPayload, "assertion_id" | "recorded_at"> & Partial<Omit<CanonicalFactPayload, "assertion_id" | "recorded_at">>): CanonicalFactPayload {
  const { assertion_id, recorded_at, ...overrides } = input;
  return {
    schema: "atlas.fact:v1",
    assertion_id,
    subject_entity_id: "la_object_entity0001",
    predicate: "status",
    value: { kind: "text", value: "Synthetic status" },
    valid_from: "2026",
    recorded_at,
    lineage_action: "assert",
    supersedes: [],
    evidence_links: [{ evidence_id: evidenceId, stance: "supports" }],
    confidence,
    ...overrides
  };
}

describe("canonical assertion projection", () => {
  it("uses knowledge time for corrections without collapsing contradictions", () => {
    const original = fact({
      assertion_id: "la_object_assertion0001",
      recorded_at: "2026-06-01T00:00:00.000Z"
    });
    const correction = fact({
      assertion_id: "la_object_assertion0002",
      recorded_at: "2026-07-01T00:00:00.000Z",
      lineage_action: "correct",
      supersedes: [original.assertion_id],
      value: { kind: "text", value: "Corrected synthetic status" }
    });
    const contradiction = fact({
      assertion_id: "la_object_assertion0003",
      recorded_at: "2026-06-02T00:00:00.000Z",
      value: { kind: "text", value: "Contradictory synthetic status" }
    });

    expect(projectCanonicalAssertions([original, correction, contradiction], {
      valid_at: "2026-06",
      known_at: "2026-07-01T00:00:00.000Z"
    }).assertions.map((item) => item.assertion_id)).toEqual([
      contradiction.assertion_id,
      correction.assertion_id
    ]);

    expect(projectCanonicalAssertions([original, correction], {
      known_at: "2026-06-15T00:00:00.000Z"
    }).assertions.map((item) => item.assertion_id)).toEqual([original.assertion_id]);
  });

  it("keeps retraction history opt-in and omits unknown world time from a valid-time query", () => {
    const retracted = fact({
      assertion_id: "la_object_assertion0004",
      recorded_at: "2026-07-02T00:00:00.000Z",
      lineage_action: "retract",
      supersedes: ["la_object_assertion0001"]
    });
    const unknownDatedFact = fact({
      assertion_id: "la_object_assertion0005",
      recorded_at: "2026-07-03T00:00:00.000Z",
      valid_from: "unknown"
    });

    expect(projectCanonicalAssertions([retracted], {
      include_retracted: true
    }).assertions).toEqual([retracted]);
    expect(projectCanonicalAssertions([unknownDatedFact], {
      valid_at: "2026"
    }).assertions).toEqual([]);
  });

  it("loads only decrypted canonical assertion envelopes in deterministic order", async () => {
    const first = fact({
      assertion_id: "la_object_assertion0006",
      recorded_at: "2026-07-04T00:00:00.000Z"
    });
    const second = fact({
      assertion_id: "la_object_assertion0007",
      recorded_at: "2026-07-05T00:00:00.000Z"
    });
    const envelopes: GraphObjectEnvelope[] = [
      encryptedEnvelope("la_object_assertion0007", "assertion", "2026-07-05T00:00:00.000Z"),
      encryptedEnvelope("la_object_legacy0001", "page", "2026-07-03T00:00:00.000Z"),
      encryptedEnvelope("la_object_assertion0006", "assertion", "2026-07-04T00:00:00.000Z")
    ];
    const payloads = new Map([
      ["la_object_assertion0006", first],
      ["la_object_assertion0007", second]
    ]);

    await expect(loadCanonicalAssertionsFromObjects(envelopes, async (object) => {
      if (object.object_type === "page") {
        throw new Error("legacy envelope must not be decrypted by canonical assertion loader");
      }
      return payloads.get(object.object_id);
    })).resolves.toEqual([first, second]);
  });
});

function encryptedEnvelope(objectId: string, objectType: GraphObjectEnvelope["object_type"], updatedAt: string): GraphObjectEnvelope {
  return {
    schema_version: 1,
    authority_id: "la_authority_assertions0001",
    object_id: objectId,
    object_type: objectType,
    version: 1,
    access_class: "local-private",
    encryption_class: "client-encrypted",
    created_at: updatedAt,
    updated_at: updatedAt,
    content_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    key_ref: "la_key_assertions0001",
    visible_metadata: {
      tombstone: false,
      remote_indexable: false
    },
    payload: {
      kind: "ciphertext-inline",
      ciphertext: `synthetic-ciphertext-${objectId}`,
      nonce: "synthetic-nonce",
      algorithm: "xchacha20-poly1305"
    }
  };
}
