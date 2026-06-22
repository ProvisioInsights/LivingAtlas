import { describe, expect, it } from "vitest";
import {
  ControlPlaneSnapshotSchema,
  DurableAuditEventSchema,
  GraphObjectEnvelopeSchema,
  SyncChangeEventSchema,
  TemporalEdgeSchema,
  TemporalEventSchema
} from "@living-atlas/contracts";
import {
  auditEventFixture,
  baitRegistry,
  controlPlaneFixture,
  remoteSafeBaitRegistry,
  sensitiveBaitRegistry,
  syncChangeFixture,
  syntheticGraphObjects,
  syntheticPlaintextFixtures,
  temporalEdges,
  temporalEvents
} from "./index";

describe("synthetic fixture graph", () => {
  it("contains sensitive bait but no real graph import", () => {
    expect(sensitiveBaitRegistry.length).toBeGreaterThanOrEqual(5);
    expect(remoteSafeBaitRegistry.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(syntheticPlaintextFixtures)).toContain("Avery North");
    expect(JSON.stringify(baitRegistry)).toContain("Living Atlas public fixture");
  });

  it("validates every graph envelope", () => {
    for (const object of syntheticGraphObjects) {
      expect(GraphObjectEnvelopeSchema.parse(object)).toEqual(object);
    }
  });

  it("validates temporal edge and event fixtures", () => {
    for (const edge of temporalEdges) {
      expect(TemporalEdgeSchema.parse(edge)).toEqual(edge);
    }

    for (const event of temporalEvents) {
      expect(TemporalEventSchema.parse(event)).toEqual(event);
    }
  });

  it("validates control, audit, and sync fixture contracts", () => {
    expect(ControlPlaneSnapshotSchema.parse(controlPlaneFixture)).toEqual(controlPlaneFixture);
    expect(DurableAuditEventSchema.parse(auditEventFixture)).toEqual(auditEventFixture);
    expect(SyncChangeEventSchema.parse(syncChangeFixture)).toEqual(syncChangeFixture);
  });
});
