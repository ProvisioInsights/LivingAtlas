import type {
  GraphObjectEnvelope,
  PraxisActivityAuditStreamResponse,
  SyncEnvelopePullResponse,
  SyncPullResponse,
  SyncStatus
} from "@living-atlas/contracts";

export type FetchLike = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;

export type AtlasClientTokenHeaders = {
  syncToken?: string;
  healthToken?: string;
  clientId?: string;
  capabilityId?: string;
  tokenId?: string;
  cloudUnlockKey?: string;
};

export type AtlasClientOptions = AtlasClientTokenHeaders & {
  endpoint: string | URL;
  fetchImpl?: FetchLike;
};

export type AtlasRequestOptions = Partial<AtlasClientTokenHeaders> & {
  headers?: HeadersInit;
  signal?: AbortSignal;
};

export type AtlasClientErrorCode =
  | "http-error"
  | "invalid-response"
  | "json-parse-error"
  | "json-rpc-error"
  | "network-error";

export type AtlasClientErrorInput = {
  code: AtlasClientErrorCode;
  message: string;
  status?: number;
  path?: string;
  method?: string;
  detail?: unknown;
  cause?: unknown;
};

export class AtlasClientError extends Error {
  readonly code: AtlasClientErrorCode;
  readonly status?: number;
  readonly path?: string;
  readonly method?: string;
  readonly detail?: unknown;

  constructor(input: AtlasClientErrorInput) {
    super(input.message, input.cause ? { cause: input.cause } : undefined);
    this.name = "AtlasClientError";
    this.code = input.code;
    this.status = input.status;
    this.path = input.path;
    this.method = input.method;
    this.detail = redactSecrets(input.detail);
  }
}

export type RemoteMcpToolName =
  | "remote_access_modes"
  | "remote_activity_audit"
  | "remote_sensitive_decrypt"
  | "remote_graph_status"
  | "remote_graph_reconcile"
  | "remote_graph_list"
  | "remote_graph_read"
  | "remote_graph_create"
  | "remote_graph_update"
  | "remote_graph_delete"
  | "remote_semantic_search"
  | "remote_graph_traverse"
  | "remote_timeline_query"
  | "remote_edge_create"
  | "remote_edge_read"
  | "remote_edge_update"
  | "remote_edge_delete"
  | "remote_sync_status"
  | "remote_sync_pull"
  | "remote_sync_envelopes"
  | "remote_usage_gate"
  | "remote_usage_reconcile";

export type JsonObject = Record<string, unknown>;
export type JsonRpcId = string | number | null;

export type RemoteMcpTool = {
  name: string;
  description?: string;
  inputSchema?: JsonObject;
};

export type RemoteMcpToolArguments = {
  remote_access_modes: Record<string, never>;
  remote_activity_audit: {
    authority_id?: string;
    operation_id?: string;
    trace_id?: string;
    event_type?: string;
    cursor?: string;
    limit?: number;
  };
  remote_sensitive_decrypt: {
    authority_id: string;
    object_id: string;
  };
  remote_graph_status: {
    authority_id: string;
    include_tombstones?: boolean;
    limit?: number;
  };
  remote_graph_reconcile: {
    authority_id: string;
    limit?: number;
  };
  remote_graph_list: {
    authority_id: string;
    object_type?: string;
    include_tombstones?: boolean;
    limit?: number;
  };
  remote_graph_read: {
    authority_id: string;
    object_id: string;
  };
  remote_graph_create: {
    object: GraphObjectEnvelope;
    idempotency_key?: string;
  };
  remote_graph_update: {
    authority_id: string;
    object_id: string;
    expected_version?: number;
    idempotency_key?: string;
    patch: JsonObject;
  };
  remote_graph_delete: {
    authority_id: string;
    object_id: string;
    expected_version?: number;
    idempotency_key?: string;
  };
  remote_semantic_search: {
    authority_id: string;
    query: string;
    object_type?: string;
    limit?: number;
  };
  remote_graph_traverse: {
    authority_id: string;
    start_object_id: string;
    direction?: "outbound" | "inbound" | "both";
    max_depth?: number;
    predicates?: string[];
    limit?: number;
  };
  remote_timeline_query: {
    authority_id: string;
    from?: string;
    to?: string;
    object_id?: string;
    predicate?: string;
    limit?: number;
  };
  remote_edge_create: {
    authority_id: string;
    edge: JsonObject;
    idempotency_key?: string;
  };
  remote_edge_read: {
    authority_id: string;
    edge_id: string;
  };
  remote_edge_update: {
    authority_id: string;
    edge_id: string;
    expected_version?: number;
    idempotency_key?: string;
    patch: JsonObject;
  };
  remote_edge_delete: {
    authority_id: string;
    edge_id: string;
    expected_version?: number;
    idempotency_key?: string;
  };
  remote_sync_status: Record<string, never>;
  remote_sync_pull: {
    authority_id: string;
    after_generation: number;
  };
  remote_sync_envelopes: {
    authority_id: string;
    after_generation: number;
  };
  remote_usage_gate: RemoteUsageGateArguments;
  remote_usage_reconcile: RemoteUsageReconciliationArguments;
};

export type RemoteMcpToolResults = {
  remote_access_modes: JsonObject;
  remote_activity_audit: PraxisActivityAuditStreamResponse;
  remote_sensitive_decrypt: JsonObject;
  remote_graph_status: JsonObject;
  remote_graph_reconcile: JsonObject;
  remote_graph_list: JsonObject;
  remote_graph_read: JsonObject;
  remote_graph_create: JsonObject;
  remote_graph_update: JsonObject;
  remote_graph_delete: JsonObject;
  remote_semantic_search: JsonObject;
  remote_graph_traverse: JsonObject;
  remote_timeline_query: JsonObject;
  remote_edge_create: JsonObject;
  remote_edge_read: JsonObject;
  remote_edge_update: JsonObject;
  remote_edge_delete: JsonObject;
  remote_sync_status: SyncStatus;
  remote_sync_pull: SyncPullResponse;
  remote_sync_envelopes: SyncEnvelopePullResponse;
  remote_usage_gate: UsageGateResponse;
  remote_usage_reconcile: UsageReconciliationResponse;
};

export type UsageStatusQuery = {
  windowHours?: number;
};

export type UsageGateQuery = UsageStatusQuery & {
  maxBudgetRatio?: number;
  minWorkerRequestsRemaining?: number;
  requireZero5xx?: boolean;
};

export type UsageReconciliationQuery = UsageStatusQuery & {
  maxR2Objects?: number;
};

export type RemoteUsageGateArguments = {
  window_hours?: number;
  max_budget_ratio?: number;
  min_worker_requests_remaining?: number;
  require_zero_5xx?: boolean;
};

export type RemoteUsageReconciliationArguments = {
  window_hours?: number;
  max_r2_objects?: number;
};

export type UsageBudgetView = {
  [metric: string]: unknown;
};

export type UsageServiceView = {
  observed: JsonObject;
  budgets: UsageBudgetView;
  notes?: string[];
  top_routes?: JsonObject[];
};

export type UsageStatusResponse = {
  ok: true;
  usage_schema: "living-atlas-usage-status:v1";
  generated_at: string;
  provider: string;
  plan: string;
  window: {
    hours: number;
    from: string;
    to: string;
  };
  budget_config: JsonObject;
  services: {
    workers: UsageServiceView;
    d1: UsageServiceView;
    r2: UsageServiceView;
    kv: UsageServiceView;
    durable_objects: UsageServiceView;
  };
  sync: JsonObject;
  portability?: JsonObject;
};

export type UsageGateResponse = {
  ok: boolean;
  gate_schema: "living-atlas-usage-gate:v1";
  generated_at: string;
  decision: "safe-to-test" | "stop-testing" | string;
  reason_codes: string[];
  usage?: UsageStatusResponse;
  policy?: JsonObject;
};

export type UsageReconciliationResponse = {
  ok: boolean;
  reconciliation_schema: "living-atlas-usage-reconciliation:v1";
  generated_at: string;
  provider: string;
  plan: string;
  decision: "reconciled" | "needs-review" | string;
  reason_codes: string[];
  policy?: JsonObject;
  app_observed?: JsonObject;
  provider_observed?: JsonObject;
};

export type ActivityEventsQuery = {
  authorityId?: string;
  operationId?: string;
  traceId?: string;
  eventType?: string;
  cursor?: string;
  limit?: number;
  path?: string;
};

export type ActivityEventsResponse = PraxisActivityAuditStreamResponse;

export type AtlasClient = {
  fetchActivityEvents(query?: ActivityEventsQuery, options?: AtlasRequestOptions): Promise<ActivityEventsResponse>;
  fetchUsageStatus(query?: UsageStatusQuery, options?: AtlasRequestOptions): Promise<UsageStatusResponse>;
  fetchUsageGate(query?: UsageGateQuery, options?: AtlasRequestOptions): Promise<UsageGateResponse>;
  fetchUsageReconciliation(query?: UsageReconciliationQuery, options?: AtlasRequestOptions): Promise<UsageReconciliationResponse>;
  listRemoteMcpTools(options?: AtlasRequestOptions): Promise<RemoteMcpTool[]>;
  callRemoteMcpTool<Name extends RemoteMcpToolName>(
    name: Name,
    args: RemoteMcpToolArguments[Name],
    options?: AtlasRequestOptions & { id?: JsonRpcId }
  ): Promise<RemoteMcpToolResults[Name]>;
};

type RequestAuthMode = "sync" | "health" | "all";

type JsonRpcResponse =
  | {
      jsonrpc: "2.0";
      id: JsonRpcId;
      result: unknown;
    }
  | {
      jsonrpc: "2.0";
      id: JsonRpcId;
      error: {
        code: number;
        message: string;
        data?: unknown;
      };
    };

const defaultActivityPath = "/api/activity/audit";
const sensitiveSearchParamPattern = /(authorization|bearer|token|secret|password|cloud[_-]?unlock[_-]?key|key)$/i;
const sensitiveHeaderNames = new Set([
  "authorization",
  "x-living-atlas-sync-token",
  "x-living-atlas-health-token",
  "x-living-atlas-cloud-unlock-key"
]);
const sensitiveKeyPattern = /(^|[_-])(authorization|bearer|token|secret|password|cloud[_-]?unlock[_-]?key|key)($|[_-])/i;

export function createAtlasClient(options: AtlasClientOptions): AtlasClient {
  return {
    fetchActivityEvents: (query, requestOptions) => fetchActivityEvents({ ...options, ...requestOptions, query }),
    fetchUsageStatus: (query, requestOptions) => fetchUsageStatus({ ...options, ...requestOptions, query }),
    fetchUsageGate: (query, requestOptions) => fetchUsageGate({ ...options, ...requestOptions, query }),
    fetchUsageReconciliation: (query, requestOptions) => fetchUsageReconciliation({ ...options, ...requestOptions, query }),
    listRemoteMcpTools: (requestOptions) => listRemoteMcpTools({ ...options, ...requestOptions }),
    callRemoteMcpTool: (name, args, requestOptions) => callRemoteMcpTool({ ...options, ...requestOptions, name, args })
  };
}

export async function fetchActivityEvents(options: AtlasClientOptions & AtlasRequestOptions & {
  query?: ActivityEventsQuery;
}): Promise<ActivityEventsResponse> {
  const query = options.query ?? {};
  const url = buildUrl(options.endpoint, query.path ?? defaultActivityPath, {
    authority_id: query.authorityId,
    operation_id: query.operationId,
    trace_id: query.traceId,
    event_type: query.eventType,
    cursor: query.cursor,
    limit: query.limit
  });
  const body = await requestJson(options, url, {
    method: "GET",
    authMode: "sync"
  });
  return parseActivityEventsResponse(body, url.pathname);
}

export async function fetchUsageStatus(options: AtlasClientOptions & AtlasRequestOptions & {
  query?: UsageStatusQuery;
}): Promise<UsageStatusResponse> {
  const url = buildUrl(options.endpoint, "/api/usage/status", usageStatusSearchParams(options.query));
  const body = await requestJson(options, url, {
    method: "GET",
    authMode: "health"
  });
  return expectObjectWithLiteral<UsageStatusResponse>(body, "usage_schema", "living-atlas-usage-status:v1", url.pathname);
}

export async function fetchUsageGate(options: AtlasClientOptions & AtlasRequestOptions & {
  query?: UsageGateQuery;
}): Promise<UsageGateResponse> {
  const url = buildUrl(options.endpoint, "/api/usage/gate", {
    ...usageStatusSearchParams(options.query),
    max_budget_ratio: options.query?.maxBudgetRatio,
    min_worker_requests_remaining: options.query?.minWorkerRequestsRemaining,
    require_zero_5xx: options.query?.requireZero5xx
  });
  const body = await requestJson(options, url, {
    method: "GET",
    authMode: "health"
  });
  return expectObjectWithLiteral<UsageGateResponse>(body, "gate_schema", "living-atlas-usage-gate:v1", url.pathname);
}

export async function fetchUsageReconciliation(options: AtlasClientOptions & AtlasRequestOptions & {
  query?: UsageReconciliationQuery;
}): Promise<UsageReconciliationResponse> {
  const url = buildUrl(options.endpoint, "/api/usage/reconcile", {
    ...usageStatusSearchParams(options.query),
    max_r2_objects: options.query?.maxR2Objects
  });
  const body = await requestJson(options, url, {
    method: "GET",
    authMode: "health"
  });
  return expectObjectWithLiteral<UsageReconciliationResponse>(
    body,
    "reconciliation_schema",
    "living-atlas-usage-reconciliation:v1",
    url.pathname
  );
}

export async function listRemoteMcpTools(options: AtlasClientOptions & AtlasRequestOptions): Promise<RemoteMcpTool[]> {
  const body = await remoteMcpJsonRpc(options, {
    id: 1,
    method: "tools/list"
  });
  if (!isRecord(body) || !Array.isArray(body.tools)) {
    throw new AtlasClientError({
      code: "invalid-response",
      message: "Remote MCP tools/list response did not include tools",
      path: "/mcp",
      method: "POST",
      detail: body
    });
  }
  return body.tools.map((tool) => {
    if (!isRecord(tool) || typeof tool.name !== "string") {
      throw new AtlasClientError({
        code: "invalid-response",
        message: "Remote MCP tools/list response included an invalid tool entry",
        path: "/mcp",
        method: "POST",
        detail: tool
      });
    }
    return tool as RemoteMcpTool;
  });
}

export async function callRemoteMcpTool<Name extends RemoteMcpToolName>(
  options: AtlasClientOptions & AtlasRequestOptions & {
    name: Name;
    args: RemoteMcpToolArguments[Name];
    id?: JsonRpcId;
  }
): Promise<RemoteMcpToolResults[Name]> {
  const result = await remoteMcpJsonRpc(options, {
    id: options.id ?? 1,
    method: "tools/call",
    params: {
      name: options.name,
      arguments: options.args
    }
  });

  if (isRecord(result) && "structuredContent" in result) {
    return result.structuredContent as RemoteMcpToolResults[Name];
  }

  return result as RemoteMcpToolResults[Name];
}

async function remoteMcpJsonRpc(
  options: AtlasClientOptions & AtlasRequestOptions,
  body: JsonObject
): Promise<unknown> {
  const url = buildUrl(options.endpoint, "/mcp");
  const responseBody = await requestJson(options, url, {
    method: "POST",
    authMode: "all",
    body: JSON.stringify({
      jsonrpc: "2.0",
      ...body
    })
  });

  const rpc = parseJsonRpcResponse(responseBody, url.pathname);
  if ("error" in rpc) {
    throw new AtlasClientError({
      code: "json-rpc-error",
      message: `Remote MCP JSON-RPC error: ${rpc.error.message}`,
      path: url.pathname,
      method: "POST",
      detail: rpc.error
    });
  }
  return rpc.result;
}

async function requestJson(
  options: AtlasClientOptions & AtlasRequestOptions,
  url: URL,
  request: {
    method: "GET" | "POST";
    authMode: RequestAuthMode;
    body?: string;
  }
): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new AtlasClientError({
      code: "network-error",
      message: "No fetch implementation is available",
      path: url.pathname,
      method: request.method
    });
  }

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: request.method,
      headers: buildHeaders(options, request.authMode, request.body !== undefined),
      body: request.body,
      signal: options.signal
    });
  } catch (error) {
    throw new AtlasClientError({
      code: "network-error",
      message: `Living Atlas request failed: ${url.pathname}`,
      path: url.pathname,
      method: request.method,
      cause: error
    });
  }

  const body = await parseResponseJson(response, url.pathname, request.method);
  if (!response.ok) {
    throw new AtlasClientError({
      code: "http-error",
      message: `Living Atlas request failed with HTTP ${response.status}: ${url.pathname}`,
      status: response.status,
      path: url.pathname,
      method: request.method,
      detail: body
    });
  }
  return body;
}

function buildUrl(endpoint: string | URL, path: string, query: Record<string, unknown> = {}): URL {
  const url = new URL(path, endpoint);
  rejectSensitiveSearchParams(url);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (sensitiveSearchParamPattern.test(key)) {
      throw new AtlasClientError({
        code: "invalid-response",
        message: `Refusing to put sensitive value in URL search parameter: ${key}`,
        path: url.pathname,
        method: "GET"
      });
    }
    url.searchParams.set(key, String(value));
  }
  rejectSensitiveSearchParams(url);
  return url;
}

function rejectSensitiveSearchParams(url: URL): void {
  for (const key of url.searchParams.keys()) {
    if (sensitiveSearchParamPattern.test(key)) {
      throw new AtlasClientError({
        code: "invalid-response",
        message: `Refusing URL with sensitive search parameter: ${key}`,
        path: url.pathname
      });
    }
  }
}

function usageStatusSearchParams(query: UsageStatusQuery | undefined): Record<string, unknown> {
  return {
    window_hours: query?.windowHours
  };
}

function buildHeaders(options: AtlasClientOptions & AtlasRequestOptions, authMode: RequestAuthMode, hasBody: boolean): Headers {
  const headers = new Headers(options.headers);
  if (hasBody && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  if ((authMode === "sync" || authMode === "all") && options.syncToken) {
    headers.set("x-living-atlas-sync-token", options.syncToken);
  }
  if ((authMode === "health" || authMode === "all") && options.healthToken) {
    headers.set("x-living-atlas-health-token", options.healthToken);
  }
  if ((authMode === "sync" || authMode === "all") && options.clientId) {
    headers.set("x-living-atlas-sync-client-id", options.clientId);
  }
  if ((authMode === "sync" || authMode === "all") && options.capabilityId) {
    headers.set("x-living-atlas-sync-capability-id", options.capabilityId);
  }
  if ((authMode === "sync" || authMode === "all") && options.tokenId) {
    headers.set("x-living-atlas-sync-token-id", options.tokenId);
  }
  if (authMode === "all" && options.cloudUnlockKey) {
    headers.set("x-living-atlas-cloud-unlock-key", options.cloudUnlockKey);
  }

  for (const name of sensitiveHeaderNames) {
    const value = headers.get(name);
    if (value !== null && value.trim() === "") {
      headers.delete(name);
    }
  }

  return headers;
}

async function parseResponseJson(response: Response, path: string, method: string): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw new AtlasClientError({
      code: "json-parse-error",
      message: `Living Atlas response was not valid JSON: ${path}`,
      status: response.status,
      path,
      method,
      cause: error
    });
  }
}

function parseJsonRpcResponse(value: unknown, path: string): JsonRpcResponse {
  if (!isRecord(value) || value.jsonrpc !== "2.0" || !("id" in value)) {
    throw new AtlasClientError({
      code: "invalid-response",
      message: "Remote MCP response was not a JSON-RPC 2.0 envelope",
      path,
      method: "POST",
      detail: value
    });
  }
  if ("error" in value) {
    if (!isRecord(value.error) || typeof value.error.code !== "number" || typeof value.error.message !== "string") {
      throw new AtlasClientError({
        code: "invalid-response",
        message: "Remote MCP error response was malformed",
        path,
        method: "POST",
        detail: value
      });
    }
    return value as JsonRpcResponse;
  }
  if (!("result" in value)) {
    throw new AtlasClientError({
      code: "invalid-response",
      message: "Remote MCP response did not include result",
      path,
      method: "POST",
      detail: value
    });
  }
  return value as JsonRpcResponse;
}

function parseActivityEventsResponse(value: unknown, path: string): ActivityEventsResponse {
  if (!isRecord(value) || !Array.isArray(value.events)) {
    throw new AtlasClientError({
      code: "invalid-response",
      message: "Activity events response did not include an events array",
      path,
      method: "GET",
      detail: value
    });
  }
  return value as ActivityEventsResponse;
}

function expectObjectWithLiteral<T>(value: unknown, key: string, expected: string, path: string): T {
  if (!isRecord(value) || value[key] !== expected) {
    throw new AtlasClientError({
      code: "invalid-response",
      message: `Living Atlas response did not include ${key}=${expected}`,
      path,
      method: "GET",
      detail: value
    });
  }
  return value as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactSecrets(entry));
  }
  if (!isRecord(value)) {
    return value;
  }
  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    redacted[key] = sensitiveKeyPattern.test(key) ? "[redacted]" : redactSecrets(entry);
  }
  return redacted;
}
