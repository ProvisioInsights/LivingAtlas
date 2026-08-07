import { describe, expect, it } from "vitest";
import type { GraphObjectEnvelope } from "@living-atlas/contracts";
import {
  LogseqBlockSchemaNamespace,
  classifyLegacySource,
  type LegacyPayloadResolver
} from "./legacy-source.js";

/**
 * These pin the storage-shape-vs-meaning distinction that the first real-data
 * dry run exposed.
 *
 * The classifier used to ask `object_type === "entity"`, and no real graph has
 * ever stored a node that way — a typed endpoint is persisted as
 * `object_type: "page"`. So the entity branch was unreachable, all 1,999 nodes
 * were filed as narrative prose and refused, and every edge that referenced one
 * died a hop later as `endpoint-not-projected`. The whole knowledge layer turned
 * on one field being read as if it meant something it does not.
 *
 * Every case below fails against the pre-fix classifier.
 */

const resolver: LegacyPayloadResolver = () => ({ kind: "plaintext", data: { probe: true } });

function envelope(overrides: {
  object_type: string;
  schema_namespace?: string;
  tombstone?: boolean;
  access_class?: string;
}): GraphObjectEnvelope {
  return {
    object_id: "la_object_classifyprobe000000000001",
    object_type: overrides.object_type,
    authority_id: "la_authority_migratefx01",
    schema_version: 1,
    version: 1,
    access_class: overrides.access_class ?? "local-private",
    encryption_class: "client-encrypted",
    content_hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    visible_metadata: {
      schema_namespace: overrides.schema_namespace,
      tombstone: overrides.tombstone ?? false
    },
    payload: { kind: "plaintext-json", data: { probe: true } }
  } as unknown as GraphObjectEnvelope;
}

describe("meaning beats storage shape", () => {
  it("reads a typed endpoint stored as a page as a node, not as prose", () => {
    const result = classifyLegacySource(
      envelope({ object_type: "page", schema_namespace: "import/logseq-semantic/typed-endpoint" }),
      resolver
    );
    expect(result.category).toBe("entity-record");
  });

  it("keeps that true for a tombstoned endpoint", () => {
    const result = classifyLegacySource(
      envelope({
        object_type: "page",
        schema_namespace: "import/logseq-semantic/typed-endpoint",
        tombstone: true
      }),
      resolver
    );
    expect(result.category).toBe("tombstoned-entity-record");
  });

  it("reads promoted topics and connector enrichments as nodes too", () => {
    for (const namespace of [
      "import/logseq-topic-review/promoted",
      "import/connector-enrichment/promoted"
    ]) {
      expect(
        classifyLegacySource(envelope({ object_type: "page", schema_namespace: namespace }), resolver)
          .category
      ).toBe("entity-record");
    }
  });

  it("still reads a genuine page as narrative", () => {
    // The fix must not swallow real prose into the entity branch — that would
    // trade one silent misclassification for another.
    expect(
      classifyLegacySource(
        envelope({ object_type: "page", schema_namespace: "import/logseq-semantic/page" }),
        resolver
      ).category
    ).toBe("narrative-object");
  });

  /**
   * The owner decided the outline blocks migrate now and are modelled later
   * (ADR 0029), so the block namespace is no longer prose the projector refuses.
   * It has to be read BEFORE the narrative check, because a block is stored as
   * `object_type: "block"` and the narrative set claims that word — the same
   * storage-shape-beats-meaning defect this file was written for.
   */
  it("reads a measured outline block as its own category, not as prose", () => {
    expect(
      classifyLegacySource(
        envelope({ object_type: "block", schema_namespace: LogseqBlockSchemaNamespace }),
        resolver
      ).category
    ).toBe("outline-block");
    expect(
      classifyLegacySource(
        envelope({ object_type: "block", schema_namespace: LogseqBlockSchemaNamespace, tombstone: true }),
        resolver
      ).category
    ).toBe("tombstoned-outline-block");
  });

  /**
   * The carry-over is scoped to a shape somebody has MEASURED, and the namespace
   * is what says so. A block-shaped object from an importer nobody has looked at
   * stays narrative and stays refused — carrying it would put an unmeasured
   * shape into the store under a schema written for a different one.
   */
  it("leaves a block the measured namespace does not claim as narrative", () => {
    expect(
      classifyLegacySource(
        envelope({ object_type: "block", schema_namespace: "import/some-other-importer/block" }),
        resolver
      ).category
    ).toBe("narrative-object");
    expect(classifyLegacySource(envelope({ object_type: "block" }), resolver).category).toBe("narrative-object");
  });

  it("still lets quarantine win over the block namespace", () => {
    expect(
      classifyLegacySource(
        envelope({
          object_type: "block",
          schema_namespace: LogseqBlockSchemaNamespace,
          access_class: "quarantine"
        }),
        resolver
      ).category
    ).toBe("quarantined-object");
  });

  it("routes a derived index away from both, so a cache is never migrated as knowledge", () => {
    const result = classifyLegacySource(
      envelope({ object_type: "index", schema_namespace: "import/logseq-semantic/reference-index" }),
      resolver
    );
    expect(result.category).toBe("derived-index");
    expect(result.category).not.toBe("other");
  });

  it("classifies both edge namespaces as typed edges", () => {
    for (const namespace of ["edge/temporal", "import/logseq-semantic/typed-edge"]) {
      expect(
        classifyLegacySource(envelope({ object_type: "edge", schema_namespace: namespace }), resolver)
          .category
      ).toBe("typed-edge");
    }
  });

  it("still sends a shape nobody declared to other, so the gate can refuse it", () => {
    expect(
      classifyLegacySource(
        envelope({ object_type: "sequence", schema_namespace: "some/unmapped-shape" }),
        resolver
      ).category
    ).toBe("other");
  });

  it("lets quarantine win over every namespace signal", () => {
    const result = classifyLegacySource(
      envelope({
        object_type: "page",
        schema_namespace: "import/logseq-semantic/typed-endpoint",
        access_class: "quarantine"
      }),
      resolver
    );
    expect(result.category).toBe("quarantined-object");
  });
});
