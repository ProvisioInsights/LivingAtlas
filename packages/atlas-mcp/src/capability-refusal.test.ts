import { describe, expect, it } from "vitest";
import { CapabilityRefusalSink, capabilityErrorFor } from "./capability-refusal.js";

function refusal(): Parameters<CapabilityRefusalSink["park"]>[1] {
  return {
    requiredCapabilities: { elicitation: {} },
    message: "needs an owner decision",
    result: { outcome: "refused", audit: { event_id: "la_audit_x", recorded_at: "2026-08-04T12:00:00.000Z" } }
  };
}

describe("the capability-refusal swap", () => {
  it("replaces the result response for the request that parked a refusal", () => {
    const sink = new CapabilityRefusalSink();
    sink.park(7, refusal());

    const swapped = capabilityErrorFor({ jsonrpc: "2.0", id: 7, result: { isError: true } }, sink) as {
      id: number;
      error: { code: number; message: string; data: Record<string, unknown> };
    };

    expect(swapped.id).toBe(7);
    expect(swapped.error.code).toBe(-32021);
    expect(swapped.error.data["requiredCapabilities"]).toEqual({ elicitation: {} });
    // The typed payload and its audit receipt survive the change of channel:
    // the tool's own contract requires the receipt on every outcome, including
    // a refusal, and dropping it here would break that on this one path.
    expect(swapped.error.data["result"]).toMatchObject({ outcome: "refused" });
  });

  it("consumes the parked refusal, so a later response reusing the id is untouched", () => {
    const sink = new CapabilityRefusalSink();
    sink.park(7, refusal());

    expect(capabilityErrorFor({ jsonrpc: "2.0", id: 7, result: {} }, sink)).toBeDefined();
    expect(sink.size).toBe(0);
    expect(capabilityErrorFor({ jsonrpc: "2.0", id: 7, result: {} }, sink)).toBeUndefined();
  });

  it("leaves an ERROR response alone, because replacing one error with another hides the first", () => {
    const sink = new CapabilityRefusalSink();
    sink.park(7, refusal());

    const message = { jsonrpc: "2.0", id: 7, error: { code: -32602, message: "invalid" } };
    expect(capabilityErrorFor(message, sink)).toBeUndefined();
    // And the refusal is still parked: nothing was consumed by a message the
    // rule declined to act on.
    expect(sink.size).toBe(1);
  });

  it("leaves every response with no parked refusal alone", () => {
    const sink = new CapabilityRefusalSink();
    sink.park(7, refusal());

    expect(capabilityErrorFor({ jsonrpc: "2.0", id: 8, result: {} }, sink)).toBeUndefined();
    // A notification has no id to answer on, so it can never be swapped.
    expect(capabilityErrorFor({ jsonrpc: "2.0", method: "notifications/x" }, sink)).toBeUndefined();
    expect(capabilityErrorFor("not a message", sink)).toBeUndefined();
  });
});
