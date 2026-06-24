import { describe, expect, it } from "vitest";
import { rekeyReviewResolutions } from "./logseq-semantic-review-resolution-rekey";

const oldPacket = {
  packet_schema: "living-atlas-logseq-semantic-review-packet:v1",
  plaintext_policy: "local-private-review-packet",
  source_path_policy: "redacted",
  generated_at: "2026-06-24T00:00:00.000Z",
  source_modes: ["markdown-only"],
  covered_file_count: 2,
  needs_review_file_count: 1,
  candidate_count: 1,
  grouped_candidate_count: 1,
  reason_counts: {
    "non-wikilink-organization-review": 1
  },
  groups: [{
    reason_code: "non-wikilink-organization-review",
    suggested_endpoint_types: ["organization"],
    target_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    target_value: "Example Org",
    occurrence_count: 2,
    property_keys: ["organization"],
    suffixes: [],
    source_refs: ["la_source_old000000000000001"]
  }]
} as const;

const oldResolutionMap = {
  resolution_schema: "living-atlas-logseq-semantic-review-resolution-map:v1",
  plaintext_policy: "local-private-review-resolution-map",
  resolutions: [{
    target_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    reason_code: "non-wikilink-organization-review",
    decision: "create-endpoint",
    endpoint_type: "organization",
    endpoint_title: "Example Org",
    aliases: [],
    confidence: "high"
  }]
} as const;

function mutable(value: unknown): any {
  return JSON.parse(JSON.stringify(value));
}

describe("Logseq semantic review resolution rekey", () => {
  it("rekeys reviewed decisions by normalized target value and reason", async () => {
    const newPacket = {
      ...oldPacket,
      groups: [{
        ...oldPacket.groups[0],
        target_hash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        target_value: " example org "
      }]
    } as const;

    const { report, resolutionMap } = await rekeyReviewResolutions({
      oldPacket: mutable(oldPacket),
      oldResolutionMap: mutable(oldResolutionMap),
      newPacket: mutable(newPacket)
    });

    expect(report).toMatchObject({
      old_group_count: 1,
      new_group_count: 1,
      old_resolution_count: 1,
      rekeyed_resolution_count: 1,
      plaintext_policy: "hash-counts-only"
    });
    expect(report.by_decision).toEqual({ "create-endpoint": 1 });
    expect(report.by_reason_code).toEqual({ "non-wikilink-organization-review": 1 });
    expect(resolutionMap.resolutions[0]).toMatchObject({
      target_hash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      endpoint_title: "Example Org"
    });
  });

  it("skips matches when the new packet no longer suggests the resolved endpoint type", async () => {
    const newPacket = {
      ...oldPacket,
      groups: [{
        ...oldPacket.groups[0],
        target_hash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        suggested_endpoint_types: ["person"]
      }]
    } as const;

    const { report, resolutionMap } = await rekeyReviewResolutions({
      oldPacket: mutable(oldPacket),
      oldResolutionMap: mutable(oldResolutionMap),
      newPacket: mutable(newPacket)
    });

    expect(report.rekeyed_resolution_count).toBe(0);
    expect(report.skipped_endpoint_type_mismatch_count).toBe(1);
    expect(resolutionMap.resolutions).toEqual([]);
  });

  it("skips duplicate normalized targets in the new packet", async () => {
    const newPacket = {
      ...oldPacket,
      groups: [
        {
          ...oldPacket.groups[0],
          target_hash: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
        },
        {
          ...oldPacket.groups[0],
          target_hash: "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
          target_value: " example org "
        }
      ]
    } as const;

    const { report, resolutionMap } = await rekeyReviewResolutions({
      oldPacket: mutable(oldPacket),
      oldResolutionMap: mutable(oldResolutionMap),
      newPacket: mutable(newPacket)
    });

    expect(report.rekeyed_resolution_count).toBe(0);
    expect(report.skipped_duplicate_normalized_target_count).toBe(1);
    expect(resolutionMap.resolutions).toEqual([]);
  });
});
