export type JsonSchemaObject = Record<string, unknown>;

export type LivingAtlasMcpToolName =
  | "access_modes"
  | "activity_read"
  | "sensitive_decrypt"
  | "status"
  | "reconcile"
  | "object_list"
  | "object_read"
  | "object_create"
  | "object_update"
  | "object_delete"
  | "object_batch"
  | "search"
  | "traverse"
  | "timeline"
  | "edge_create"
  | "edge_read"
  | "edge_update"
  | "edge_delete"
  | "edge_batch"
  | "sync_status"
  | "sync_pull"
  | "sync_envelopes"
  | "usage_gate"
  | "usage_reconcile";

export type LivingAtlasMcpToolDefinition = {
  name: LivingAtlasMcpToolName;
  description: string;
  inputSchema: JsonSchemaObject;
};

const EndpointTypeMcpEnum = ["person", "organization", "project", "location", "occurrence", "topic"] as const;
const PredicateMcpEnum = [
  "employed-by",
  "reports-to",
  "founder-of",
  "board-member-of",
  "advises",
  "invests-in",
  "customer-of",
  "engaged",
  "acquired-by",
  "merged-with",
  "introduced-by",
  "intro-path-to",
  "connects",
  "member-of",
  "alumnus-of",
  "based-in",
  "participant-in",
  "occurred-at",
  "hosted",
  "discussed-at",
  "about",
  "related-topic",
  "part-of-topic",
  "spouse-of",
  "partner-of",
  "parent-of",
  "sibling-of",
  "related-to",
  "estranged-from",
  "mentor-of"
] as const;

export const TemporalEdgeAttrsMcpSchema = {
  type: "object",
  additionalProperties: true,
  not: {
    anyOf: [
      { required: ["edge_id"] },
      { required: ["source_object_id"] },
      { required: ["source_type"] },
      { required: ["target_object_id"] },
      { required: ["target_type"] },
      { required: ["predicate"] },
      { required: ["valid_from"] },
      { required: ["valid_to"] },
      { required: ["status"] },
      { required: ["confidence"] },
      { required: ["source"] },
      { required: ["recurrence"] },
      { required: ["recurrence_set"] },
      { required: ["rrule"] },
      { required: ["dtstart"] },
      { required: ["rdate"] },
      { required: ["exdate"] },
      { required: ["starts_at_local"] }
    ]
  },
  properties: {
    schedule: {
      type: "object",
      additionalProperties: false,
      required: ["timezone", "recurrence_set"],
      properties: {
        timezone: { type: "string", description: "IANA timezone. Any TZID inside recurrence_set must match this value." },
        recurrence_set: {
          type: "string",
          description: "Newline-delimited RFC 5545 recurrence lines. RRULE requires DTSTART. Use DTSTART/RRULE/RDATE/EXDATE lines here, not split fields."
        },
        duration: { type: "string", description: "RFC 5545 duration such as PT2H or P1D." },
        exceptions: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["date", "status"],
            properties: {
              date: { type: "string" },
              status: { type: "string", enum: ["canceled", "moved", "skipped", "extra"] },
              replacement_start: { type: "string" },
              replacement_end: { type: "string" },
              note: { type: "string" }
            }
          }
        }
      }
    },
    amount: { anyOf: [{ type: "string", minLength: 1 }, { type: "number" }] },
    investment_status: { type: "string", minLength: 1, description: "Capital-specific state for invests-in; do not use attrs.status." },
    role: { type: "string", minLength: 1 },
    via: { anyOf: [{ type: "string", minLength: 1 }, { type: "array", minItems: 1, items: { type: "string", minLength: 1 } }] },
    relation: { type: "string", minLength: 1 },
    note: { type: "string", minLength: 1 },
    scope: { type: "string", minLength: 1 },
    condition: { type: "string", minLength: 1 },
    relationship: { type: "string", minLength: 1 },
    relationship_origin: { type: "string", minLength: 1 },
    comparable_to: { anyOf: [{ type: "string", minLength: 1 }, { type: "array", minItems: 1, items: { type: "string", minLength: 1 } }] }
  }
} as const satisfies JsonSchemaObject;

export const TemporalEdgeMcpSchema = {
  type: "object",
  additionalProperties: false,
  required: ["edge_id", "source_object_id", "source_type", "target_object_id", "target_type", "predicate", "valid_from", "source"],
  properties: {
    edge_id: { type: "string", pattern: "^la_edge_[A-Za-z0-9_-]{8,}$" },
    source_object_id: { type: "string", pattern: "^la_object_[A-Za-z0-9_-]{8,}$" },
    source_type: { type: "string", enum: [...EndpointTypeMcpEnum] },
    target_object_id: { type: "string", pattern: "^la_object_[A-Za-z0-9_-]{8,}$" },
    target_type: { type: "string", enum: [...EndpointTypeMcpEnum] },
    predicate: { type: "string", enum: [...PredicateMcpEnum] },
    valid_from: { type: "string", description: "unknown, YYYY, YYYY-MM, YYYY-MM-DD, or approximate ~YYYY variant." },
    valid_to: { type: "string" },
    status: { type: "string", enum: ["active", "pending", "ended", "dormant"] },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    source: { type: "string", minLength: 1 },
    attrs: TemporalEdgeAttrsMcpSchema
  }
} as const satisfies JsonSchemaObject;

export const TemporalEdgePatchMcpSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    source_object_id: { type: "string", pattern: "^la_object_[A-Za-z0-9_-]{8,}$" },
    source_type: { type: "string", enum: [...EndpointTypeMcpEnum] },
    target_object_id: { type: "string", pattern: "^la_object_[A-Za-z0-9_-]{8,}$" },
    target_type: { type: "string", enum: [...EndpointTypeMcpEnum] },
    predicate: { type: "string", enum: [...PredicateMcpEnum] },
    valid_from: { type: "string" },
    valid_to: { type: "string" },
    status: { type: "string", enum: ["active", "pending", "ended", "dormant"] },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    source: { type: "string", minLength: 1 },
    attrs: TemporalEdgeAttrsMcpSchema
  },
  minProperties: 1
} as const satisfies JsonSchemaObject;

function objectSchema(properties: JsonSchemaObject, required: string[] = []): JsonSchemaObject {
  return {
    type: "object",
    additionalProperties: false,
    ...(required.length > 0 ? { required } : {}),
    properties
  };
}

const BatchLimitsMcpSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    max_items: { type: "integer", minimum: 1, maximum: 100 },
    max_bytes: { type: "integer", minimum: 1024, maximum: 1048576 }
  }
} as const satisfies JsonSchemaObject;

const BatchItemCommonProperties = {
  idempotency_key: { type: "string" },
  authority_id: { type: "string", description: "Optional per-item authority. If present, it must match the batch authority_id." }
} as const satisfies JsonSchemaObject;

const ObjectBatchItemMcpSchema = {
  oneOf: [
    objectSchema({
      ...BatchItemCommonProperties,
      op: { const: "create" },
      object: { type: "object" }
    }, ["op", "object"]),
    objectSchema({
      ...BatchItemCommonProperties,
      op: { const: "update" },
      object_id: { type: "string" },
      expected_version: { type: "integer", minimum: 0 },
      patch: { type: "object" }
    }, ["op", "object_id", "patch"]),
    objectSchema({
      ...BatchItemCommonProperties,
      op: { const: "delete" },
      object_id: { type: "string" },
      expected_version: { type: "integer", minimum: 0 }
    }, ["op", "object_id"])
  ]
} as const satisfies JsonSchemaObject;

const EdgeBatchItemMcpSchema = {
  oneOf: [
    objectSchema({
      ...BatchItemCommonProperties,
      op: { const: "create" },
      edge: TemporalEdgeMcpSchema
    }, ["op", "edge"]),
    objectSchema({
      ...BatchItemCommonProperties,
      op: { const: "update" },
      edge_id: { type: "string" },
      expected_version: { type: "integer", minimum: 0 },
      patch: TemporalEdgePatchMcpSchema
    }, ["op", "edge_id", "patch"]),
    objectSchema({
      ...BatchItemCommonProperties,
      op: { const: "delete" },
      edge_id: { type: "string" },
      expected_version: { type: "integer", minimum: 0 }
    }, ["op", "edge_id"])
  ]
} as const satisfies JsonSchemaObject;

export const LivingAtlasMcpToolDefinitions = [
  {
    name: "access_modes",
    description: "Describe Living Atlas remote-safe, cloud-unlock, and local-keyholding access modes for this request.",
    inputSchema: objectSchema({})
  },
  {
    name: "activity_read",
    description: "Read recent activity and audit events. Remote responses are redacted and use stable cursors and hashed refs only.",
    inputSchema: objectSchema({
      authority_id: { type: "string" },
      operation_id: { type: "string" },
      trace_id: { type: "string" },
      event_type: { type: "string" },
      cursor: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 100 }
    })
  },
  {
    name: "sensitive_decrypt",
    description: "Decrypt a sensitive ciphertext object when the current transport and policy can hold the needed key for this request.",
    inputSchema: objectSchema({
      authority_id: { type: "string" },
      object_id: { type: "string" }
    }, ["authority_id", "object_id"])
  },
  {
    name: "status",
    description: "Read graph object counts and reconciliation state for an authority.",
    inputSchema: objectSchema({
      authority_id: { type: "string" },
      include_tombstones: { type: "boolean" },
      limit: { type: "integer", minimum: 1, maximum: 1000 }
    }, ["authority_id"])
  },
  {
    name: "reconcile",
    description: "Compare the graph index with committed sync state for an authority.",
    inputSchema: objectSchema({
      authority_id: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 1000 }
    }, ["authority_id"])
  },
  {
    name: "object_list",
    description: "List graph objects for an authority.",
    inputSchema: objectSchema({
      authority_id: { type: "string" },
      object_type: { type: "string" },
      include_tombstones: { type: "boolean" },
      limit: { type: "integer", minimum: 1, maximum: 1000 }
    }, ["authority_id"])
  },
  {
    name: "object_read",
    description: "Read one graph object by id.",
    inputSchema: objectSchema({
      authority_id: { type: "string" },
      object_id: { type: "string" }
    }, ["authority_id", "object_id"])
  },
  {
    name: "object_create",
    description: "Create one graph object idempotently.",
    inputSchema: objectSchema({
      object: { type: "object" },
      idempotency_key: { type: "string" }
    }, ["object"])
  },
  {
    name: "object_update",
    description: "Update one graph object idempotently with optimistic version support.",
    inputSchema: objectSchema({
      authority_id: { type: "string" },
      object_id: { type: "string" },
      expected_version: { type: "integer", minimum: 0 },
      idempotency_key: { type: "string" },
      patch: { type: "object" }
    }, ["authority_id", "object_id", "patch"])
  },
  {
    name: "object_delete",
    description: "Tombstone one graph object idempotently with optimistic version support.",
    inputSchema: objectSchema({
      authority_id: { type: "string" },
      object_id: { type: "string" },
      idempotency_key: { type: "string" },
      expected_version: { type: "integer", minimum: 0 }
    }, ["authority_id", "object_id"])
  },
  {
    name: "object_batch",
    description: "Run a bounded batch of object create/update/delete operations through the same policy and audit path as single-object tools.",
    inputSchema: objectSchema({
      authority_id: { type: "string" },
      idempotency_key: { type: "string" },
      items: { type: "array", minItems: 1, maxItems: 100, items: ObjectBatchItemMcpSchema },
      limits: BatchLimitsMcpSchema
    }, ["authority_id", "items"])
  },
  {
    name: "search",
    description: "Search graph object text and metadata. Current mode is deterministic text scoring; embedding/vector search can replace the scorer later.",
    inputSchema: objectSchema({
      authority_id: { type: "string" },
      query: { type: "string" },
      object_type: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 1000 }
    }, ["authority_id", "query"])
  },
  {
    name: "traverse",
    description: "Traverse edge objects from a start object.",
    inputSchema: objectSchema({
      authority_id: { type: "string" },
      start_object_id: { type: "string" },
      direction: { type: "string", enum: ["outbound", "inbound", "both"] },
      max_depth: { type: "integer", minimum: 1, maximum: 5 },
      predicates: { type: "array", items: { type: "string" } },
      limit: { type: "integer", minimum: 1, maximum: 1000 }
    }, ["authority_id", "start_object_id"])
  },
  {
    name: "timeline",
    description: "Query graph objects by created/updated, edge valid dates, or event dates.",
    inputSchema: objectSchema({
      authority_id: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      object_id: { type: "string" },
      predicate: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 1000 }
    }, ["authority_id"])
  },
  {
    name: "edge_create",
    description: "Create a typed temporal edge idempotently as a graph object. Edge attrs use canonical names: schedule for recurrence and investment_status for capital state.",
    inputSchema: objectSchema({
      authority_id: { type: "string" },
      edge: TemporalEdgeMcpSchema,
      idempotency_key: { type: "string" }
    }, ["authority_id", "edge"])
  },
  {
    name: "edge_read",
    description: "Read a typed edge by edge_id.",
    inputSchema: objectSchema({
      authority_id: { type: "string" },
      edge_id: { type: "string" }
    }, ["authority_id", "edge_id"])
  },
  {
    name: "edge_update",
    description: "Update a typed temporal edge idempotently by edge_id. Patch attrs use canonical names: schedule for recurrence and investment_status for capital state.",
    inputSchema: objectSchema({
      authority_id: { type: "string" },
      edge_id: { type: "string" },
      expected_version: { type: "integer", minimum: 0 },
      idempotency_key: { type: "string" },
      patch: TemporalEdgePatchMcpSchema
    }, ["authority_id", "edge_id", "patch"])
  },
  {
    name: "edge_delete",
    description: "Tombstone a typed temporal edge idempotently by edge_id.",
    inputSchema: objectSchema({
      authority_id: { type: "string" },
      edge_id: { type: "string" },
      idempotency_key: { type: "string" },
      expected_version: { type: "integer", minimum: 0 }
    }, ["authority_id", "edge_id"])
  },
  {
    name: "edge_batch",
    description: "Run a bounded batch of edge create/update/delete operations through the same policy and audit path as single-edge tools.",
    inputSchema: objectSchema({
      authority_id: { type: "string" },
      idempotency_key: { type: "string" },
      items: { type: "array", minItems: 1, maxItems: 100, items: EdgeBatchItemMcpSchema },
      limits: BatchLimitsMcpSchema
    }, ["authority_id", "items"])
  },
  {
    name: "sync_status",
    description: "Read sync cursor and counts for the authenticated authority.",
    inputSchema: objectSchema({})
  },
  {
    name: "sync_pull",
    description: "Read committed sync batch summaries after a generation.",
    inputSchema: objectSchema({
      authority_id: { type: "string" },
      after_generation: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1, maximum: 50 }
    }, ["authority_id", "after_generation"])
  },
  {
    name: "sync_envelopes",
    description: "Read committed sync envelopes after a generation. Sensitive objects remain ciphertext unless the transport is allowed to decrypt them.",
    inputSchema: objectSchema({
      authority_id: { type: "string" },
      after_generation: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1, maximum: 50 }
    }, ["authority_id", "after_generation"])
  },
  {
    name: "usage_gate",
    description: "Read observed usage and return a safe-to-test or stop-testing decision before live validation.",
    inputSchema: objectSchema({
      window_hours: { type: "integer", minimum: 1, maximum: 720 },
      max_budget_ratio: { type: "number", minimum: 0.01, maximum: 1 },
      min_worker_requests_remaining: { type: "integer", minimum: 0 },
      require_zero_5xx: { type: "boolean" }
    })
  },
  {
    name: "usage_reconcile",
    description: "Compare app-observed usage with provider-native inventory exposed through bound platform services.",
    inputSchema: objectSchema({
      window_hours: { type: "integer", minimum: 1, maximum: 720 },
      max_r2_objects: { type: "integer", minimum: 1, maximum: 100000 },
      inventory_mode: { type: "string", enum: ["full", "metadata"] }
    })
  }
] as const satisfies readonly LivingAtlasMcpToolDefinition[];

export const LivingAtlasMcpToolNames = LivingAtlasMcpToolDefinitions.map((tool) => tool.name);

export function livingAtlasMcpToolDefinition(name: LivingAtlasMcpToolName): LivingAtlasMcpToolDefinition {
  const definition = LivingAtlasMcpToolDefinitions.find((tool) => tool.name === name);
  if (!definition) {
    throw new Error(`Unknown Living Atlas MCP tool: ${name}`);
  }
  return definition;
}
