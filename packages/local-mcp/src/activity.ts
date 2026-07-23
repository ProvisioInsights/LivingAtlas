import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync
} from "node:fs";
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
  read?(limit: number): LiveActivityEvent[];
};

const ActivityReadChunkBytes = 1024 * 1024;
const ActivityMaximumLineBytes = 1024 * 1024;

function recentActivityLines(path: string, limit: number): string[] {
  if (limit <= 0) return [];
  const handle = openSync(path, "r");
  try {
    const size = fstatSync(handle).size;
    let position = size;
    let newlineCount = 0;
    let bufferedBytes = 0;
    const chunks: Buffer[] = [];
    while (position > 0 && newlineCount <= limit) {
      const bytes = Math.min(ActivityReadChunkBytes, position);
      position -= bytes;
      const chunk = Buffer.allocUnsafe(bytes);
      readSync(handle, chunk, 0, bytes, position);
      chunks.unshift(chunk);
      bufferedBytes += bytes;
      for (const byte of chunk) {
        if (byte === 0x0a) newlineCount += 1;
      }
      if (bufferedBytes > Math.max(ActivityMaximumLineBytes, ActivityReadChunkBytes * 16)) {
        throw new Error("local-mcp-activity-tail-window-too-large");
      }
    }
    return Buffer.concat(chunks).toString("utf8")
      .split("\n")
      .filter((line) => line.trim())
      .slice(-limit);
  } finally {
    closeSync(handle);
  }
}

export class InMemoryLocalMcpActivitySink implements LocalMcpActivitySink {
  readonly events: LiveActivityEvent[] = [];

  record(event: LiveActivityEvent): void {
    this.events.push(LiveActivityEventSchema.parse(event));
  }

  read(limit: number): LiveActivityEvent[] {
    return this.events.slice(-limit);
  }
}

export class FileLocalMcpActivitySink implements LocalMcpActivitySink {
  constructor(private readonly path: string) {}

  record(event: LiveActivityEvent): void {
    const parsed = LiveActivityEventSchema.parse(event);
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    appendFileSync(this.path, `${JSON.stringify(parsed)}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(this.path, 0o600);
  }

  read(limit: number): LiveActivityEvent[] {
    if (!existsSync(this.path)) {
      return [];
    }
    return recentActivityLines(this.path, limit)
      .map((line) => LiveActivityEventSchema.parse(JSON.parse(line)))
      .slice(-limit);
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
