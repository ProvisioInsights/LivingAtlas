import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  type AccessClass,
  type GraphObjectEnvelope,
  type LiveActivityEvent,
  LiveActivityEventSchema,
  type McpProfile,
  type Operation
} from "@living-atlas/contracts";

export type LocalMcpActivitySink = {
  record(event: LiveActivityEvent): void;
};

export class InMemoryLocalMcpActivitySink implements LocalMcpActivitySink {
  readonly events: LiveActivityEvent[] = [];

  record(event: LiveActivityEvent): void {
    this.events.push(LiveActivityEventSchema.parse(event));
  }
}

export class FileLocalMcpActivitySink implements LocalMcpActivitySink {
  constructor(private readonly path: string) {}

  record(event: LiveActivityEvent): void {
    const parsed = LiveActivityEventSchema.parse(event);
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(parsed)}\n`, { encoding: "utf8" });
  }
}

let eventCounter = 0;

function nextId(prefix: "la_event" | "la_operation" | "la_trace"): string {
  eventCounter += 1;
  return `${prefix}_${Date.now().toString(36)}${eventCounter.toString(36).padStart(4, "0")}`;
}

function nextCursor(): string {
  eventCounter += 1;
  return `${Date.now()}${eventCounter.toString().padStart(6, "0")}`;
}

function crudFromOperation(operation: Operation): LiveActivityEvent["crud"] {
  switch (operation) {
    case "create":
      return "create";
    case "update":
      return "update";
    case "delete":
      return "delete";
    case "restore":
      return "restore";
    case "search":
      return "search";
    case "traverse":
      return "traverse";
    case "sync-read":
      return "sync-pull";
    case "sync-write":
      return "sync-push";
    case "decrypt":
      return "decrypt";
    default:
      return "read";
  }
}

function policyDecision(allowed: boolean): LiveActivityEvent["policy_decision"] {
  return allowed ? "allow" : "deny";
}

function accessClassContainsSensitive(accessClass: AccessClass | undefined): boolean {
  return accessClass === "local-private" || accessClass === "quarantine";
}

function graphTouchForObject(object: GraphObjectEnvelope | undefined) {
  if (!object) {
    return {
      nodes: [],
      edges: [],
      objects: [],
      path: []
    };
  }
  return {
    nodes: object.object_type === "edge" ? [] : [object.object_id],
    edges: object.object_type === "edge" ? [object.object_id] : [],
    objects: [object.object_id],
    path: [object.object_id]
  };
}

export function createLocalMcpLiveActivityEvent(input: {
  client_id?: string;
  profile?: McpProfile;
  operation: Operation;
  tool_name: string;
  object?: GraphObjectEnvelope;
  allowed: boolean;
  reason_code: string;
  recorded_at?: string;
}): LiveActivityEvent {
  const containsSensitive = accessClassContainsSensitive(input.object?.access_class);
  const crud = crudFromOperation(input.operation);
  return LiveActivityEventSchema.parse({
    event_id: nextId("la_event"),
    operation_id: nextId("la_operation"),
    trace_id: nextId("la_trace"),
    cursor: nextCursor(),
    recorded_at: input.recorded_at ?? new Date().toISOString(),
    plane: "local",
    crud,
    policy_decision: policyDecision(input.allowed),
    graph_touch: graphTouchForObject(input.object),
    visibility: {
      mode: "metadata",
      contains_sensitive: containsSensitive,
      redacted: true
    },
    summary: `${input.tool_name} ${crud} ${input.allowed ? "allowed" : "denied"}`,
    visual: {
      motion: input.allowed ? (crud === "read" ? "pulse" : "connect") : "block",
      intensity: input.allowed ? 0.7 : 0.9,
      color_role: input.allowed ? (crud === "update" ? "updated" : "created") : "denied"
    }
  });
}
