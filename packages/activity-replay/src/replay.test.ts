import { describe, expect, it } from "vitest";
import type { DurableAuditEvent, LiveActivityEvent, OperationalEvent } from "@living-atlas/contracts";
import { fixtureAuthorityId, sensitiveBaitRegistry } from "@living-atlas/fixtures";
import { scanForBaitStrings } from "@living-atlas/leakage";
import { buildReplayInspection } from "./index";

const operationId = "la_operation_replay0001";
const traceId = "la_trace_replay0001";
const objectId = "la_object_privatepage0001";

function auditEvent(overrides: Partial<DurableAuditEvent> = {}): DurableAuditEvent {
  return {
    audit_id: "la_audit_replay0001",
    authority_id: fixtureAuthorityId,
    operation_id: operationId,
    trace_id: traceId,
    recorded_at: "2026-06-22T12:00:00.000Z",
    actor_id: "la_user_fixture0001",
    mcp_profile: "local-full",
    operation: "read",
    event_type: "object.read",
    object_id: objectId,
    access_class: "local-private",
    redaction: "remote-redacted",
    summary: "Avery North read Blue Orchid Salary Negotiation",
    ...overrides
  };
}

function activityEvent(overrides: Partial<LiveActivityEvent> = {}): LiveActivityEvent {
  return {
    event_id: "la_event_replay0001",
    operation_id: operationId,
    trace_id: traceId,
    cursor: "20260622120000000001",
    recorded_at: "2026-06-22T12:00:01.000Z",
    plane: "local",
    crud: "read",
    policy_decision: "allow",
    graph_touch: {
      nodes: [objectId],
      edges: [],
      objects: [objectId],
      path: [objectId]
    },
    visibility: {
      mode: "metadata",
      contains_sensitive: true,
      redacted: true
    },
    summary: "Project Glass Lantern local read",
    ...overrides
  };
}

function operationalEvent(overrides: Partial<OperationalEvent> = {}): OperationalEvent {
  return {
    event_schema: "living-atlas-operational-event:v1",
    event_id: "la_observe_replay0001",
    recorded_at: "2026-06-22T12:00:02.000Z",
    severity: "info",
    plane: "local-mcp",
    event_kind: "request",
    trace_id: traceId,
    operation_id: operationId,
    route: "local-mcp/read",
    method: "TOOL",
    status: 200,
    duration_ms: 12,
    outcome: "ok",
    redaction: "operational-redacted",
    sensitive: false,
    message: "Avery North synthetic request completed",
    ...overrides
  };
}

describe("replay inspection model", () => {
  it("correlates audit, activity, and operational streams without leaking summaries", () => {
    const inspection = buildReplayInspection({
      audit_events: [auditEvent()],
      activity_events: [activityEvent()],
      operational_events: [operationalEvent()],
      generated_at: "2026-06-22T12:01:00.000Z"
    });

    expect(inspection.records.map((record) => record.stream)).toEqual(["audit", "activity", "operational"]);
    expect(inspection.operations).toHaveLength(1);
    expect(inspection.operations[0]!.streams_present).toEqual(["activity", "audit", "operational"]);
    expect(inspection.operations[0]!.contains_sensitive).toBe(true);
    expect(inspection.findings).toEqual([]);
    expect(scanForBaitStrings([{ name: "inspection", content: JSON.stringify(inspection) }], sensitiveBaitRegistry)).toEqual([]);
  });

  it("flags activity that lacks durable audit and remote sensitive unredacted records", () => {
    const inspection = buildReplayInspection({
      activity_events: [
        activityEvent({
          event_id: "la_event_replay0002",
          operation_id: "la_operation_replay0002",
          plane: "remote",
          visibility: {
            mode: "metadata",
            contains_sensitive: true,
            redacted: false
          }
        })
      ],
      operational_events: [
        operationalEvent({
          event_id: "la_observe_replay0002",
          operation_id: "la_operation_replay0002",
          severity: "error",
          outcome: "server-error",
          status: 500
        })
      ],
      generated_at: "2026-06-22T12:01:00.000Z"
    });

    expect(inspection.operations[0]!.flags).toEqual(expect.arrayContaining([
      "activity-without-audit",
      "operational-error",
      "remote-sensitive-touch"
    ]));
    expect(inspection.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining([
      "missing-durable-audit",
      "operational-error",
      "remote-sensitive-touch"
    ]));
  });
});
