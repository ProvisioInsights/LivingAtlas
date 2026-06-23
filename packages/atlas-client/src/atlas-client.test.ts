import { describe, expect, it } from "vitest";
import {
  AtlasClientError,
  callRemoteMcpTool,
  createAtlasClient,
  fetchActivityEvents,
  fetchUsageGate,
  listRemoteMcpTools,
  type FetchLike
} from "./index";

type CapturedRequest = {
  url: URL;
  init: RequestInit | undefined;
  headers: Headers;
  body: unknown;
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json"
    },
    ...init
  });
}

function captureFetch(handler: (request: CapturedRequest) => Response | Promise<Response>): {
  fetchImpl: FetchLike;
  requests: CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];
  return {
    requests,
    fetchImpl: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const headers = new Headers(init?.headers);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      const request = { url, init, headers, body };
      requests.push(request);
      return handler(request);
    }
  };
}

describe("atlas client", () => {
  it("calls usage gate with a health token header and no token query params", async () => {
    const token = "fixture-health-token-client-0001";
    const fake = captureFetch((request) => {
      expect(request.url.pathname).toBe("/api/usage/gate");
      expect(request.url.searchParams.get("window_hours")).toBe("6");
      expect(request.url.searchParams.get("max_budget_ratio")).toBe("0.8");
      expect(request.url.searchParams.get("min_worker_requests_remaining")).toBe("2");
      expect(request.url.searchParams.get("require_zero_5xx")).toBe("true");
      expect(request.url.toString()).not.toContain(token);
      expect(request.headers.get("x-living-atlas-health-token")).toBe(token);
      expect(request.headers.has("x-living-atlas-sync-token")).toBe(false);

      return jsonResponse({
        ok: true,
        gate_schema: "living-atlas-usage-gate:v1",
        generated_at: "2026-06-22T18:00:00.000Z",
        decision: "safe-to-test",
        reason_codes: []
      });
    });

    await expect(fetchUsageGate({
      endpoint: "https://living-atlas.example",
      healthToken: token,
      fetchImpl: fake.fetchImpl,
      query: {
        windowHours: 6,
        maxBudgetRatio: 0.8,
        minWorkerRequestsRemaining: 2,
        requireZero5xx: true
      }
    })).resolves.toMatchObject({
      gate_schema: "living-atlas-usage-gate:v1",
      decision: "safe-to-test"
    });
  });

  it("lists remote MCP tools with sync token headers", async () => {
    const token = "fixture-sync-token-client-0001";
    const fake = captureFetch((request) => {
      expect(request.url.pathname).toBe("/mcp");
      expect(request.url.toString()).not.toContain(token);
      expect(request.headers.get("content-type")).toBe("application/json");
      expect(request.headers.get("x-living-atlas-sync-token")).toBe(token);
      expect(request.body).toMatchObject({
        jsonrpc: "2.0",
        method: "tools/list"
      });
      return jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        result: {
          tools: [
            {
              name: "remote_sync_status",
              description: "Read status",
              inputSchema: { type: "object" }
            }
          ]
        }
      });
    });

    await expect(listRemoteMcpTools({
      endpoint: "https://living-atlas.example",
      syncToken: token,
      fetchImpl: fake.fetchImpl
    })).resolves.toEqual([
      expect.objectContaining({ name: "remote_sync_status" })
    ]);
  });

  it("unwraps structuredContent for remote MCP tool calls", async () => {
    const syncToken = "fixture-sync-token-client-0002";
    const healthToken = "fixture-health-token-client-0002";
    const fake = captureFetch((request) => {
      expect(request.url.pathname).toBe("/mcp");
      expect(request.headers.get("x-living-atlas-sync-token")).toBe(syncToken);
      expect(request.headers.get("x-living-atlas-health-token")).toBe(healthToken);
      expect(request.body).toMatchObject({
        jsonrpc: "2.0",
        id: 42,
        method: "tools/call",
        params: {
          name: "remote_usage_gate",
          arguments: {
            window_hours: 6
          }
        }
      });
      return jsonResponse({
        jsonrpc: "2.0",
        id: 42,
        result: {
          content: [{ type: "text", text: "{}" }],
          structuredContent: {
            ok: true,
            gate_schema: "living-atlas-usage-gate:v1",
            generated_at: "2026-06-22T18:01:00.000Z",
            decision: "safe-to-test",
            reason_codes: []
          }
        }
      });
    });

    await expect(callRemoteMcpTool({
      endpoint: "https://living-atlas.example",
      syncToken,
      healthToken,
      fetchImpl: fake.fetchImpl,
      name: "remote_usage_gate",
      args: {
        window_hours: 6
      },
      id: 42
    })).resolves.toMatchObject({
      gate_schema: "living-atlas-usage-gate:v1",
      decision: "safe-to-test"
    });
  });

  it("fetches redacted activity audit events from the headless activity endpoint", async () => {
    const token = "fixture-sync-token-client-0003";
    const fake = captureFetch((request) => {
      expect(request.url.pathname).toBe("/api/activity/audit");
      expect(request.url.searchParams.get("cursor")).toBe("1700000000000:la_audit_client0001");
      expect(request.url.searchParams.get("authority_id")).toBe("la_authority_client0001");
      expect(request.url.searchParams.get("limit")).toBe("25");
      expect(request.url.toString()).not.toContain(token);
      expect(request.headers.get("x-living-atlas-sync-token")).toBe(token);
      return jsonResponse({
        ok: true,
        stream_schema: "living-atlas-praxis-activity-audit-stream:v1",
        generated_at: "2026-06-22T18:00:00.000Z",
        limit: 25,
        events: [
          {
            cursor: "1700000000001:la_audit_client0002",
            audit: {
              audit_id: "la_audit_client0002",
              operation_id: "la_operation_client0001",
              trace_id: "la_trace_client0001",
              recorded_at: "2026-06-22T18:00:00.000Z",
              operation: "read",
              event_type: "object.read",
              outcome: "allowed",
              redaction: "remote-redacted",
              summary: "Remote object read allowed"
            },
            refs: {
              authority_ref: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              object_ref: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
            },
            mcp_profile: "remote-safe"
          }
        ],
        next_cursor: "1700000000001:la_audit_client0002",
        has_more: false
      });
    });

    await expect(fetchActivityEvents({
      endpoint: "https://living-atlas.example",
      syncToken: token,
      fetchImpl: fake.fetchImpl,
      query: {
        authorityId: "la_authority_client0001",
        cursor: "1700000000000:la_audit_client0001",
        limit: 25
      }
    })).resolves.toMatchObject({
      events: [
        expect.objectContaining({
          audit: expect.objectContaining({
            event_type: "object.read",
            redaction: "remote-redacted"
          }),
          refs: expect.objectContaining({
            object_ref: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)
          })
        })
      ],
      has_more: false
    });
  });

  it("redacts secrets from HTTP and JSON-RPC errors", async () => {
    const syncToken = "fixture-sync-token-client-secret";
    const fakeHttp = captureFetch(() => jsonResponse({
      ok: false,
      error: "denied",
      sync_token: syncToken,
      nested: {
        authorization: `Bearer ${syncToken}`
      }
    }, { status: 403 }));

    await expect(fetchUsageGate({
      endpoint: "https://living-atlas.example",
      healthToken: syncToken,
      fetchImpl: fakeHttp.fetchImpl
    })).rejects.toMatchObject({
      code: "http-error",
      status: 403,
      detail: {
        sync_token: "[redacted]",
        nested: {
          authorization: "[redacted]"
        }
      }
    });

    const fakeRpc = captureFetch(() => jsonResponse({
      jsonrpc: "2.0",
      id: 1,
      error: {
        code: -32000,
        message: "missing-or-invalid-health-token",
        data: {
          health_token: syncToken
        }
      }
    }));

    await expect(callRemoteMcpTool({
      endpoint: "https://living-atlas.example",
      syncToken,
      fetchImpl: fakeRpc.fetchImpl,
      name: "remote_sync_status",
      args: {}
    })).rejects.toMatchObject({
      code: "json-rpc-error",
      detail: {
        data: {
          health_token: "[redacted]"
        }
      }
    });
  });

	  it("refuses token-bearing query parameters even on custom activity paths", async () => {
	    const client = createAtlasClient({
	      endpoint: "https://living-atlas.example",
      syncToken: "fixture-sync-token-client-0004",
      fetchImpl: async () => {
        throw new Error("fetch should not be called");
      }
    });

    await expect(client.fetchActivityEvents({
      path: "/api/activity/audit?sync_token=secret"
    })).rejects.toBeInstanceOf(AtlasClientError);
    await expect(client.fetchActivityEvents({
      path: "/api/activity/audit?sync_token=secret"
	    })).rejects.toMatchObject({
	      code: "invalid-response"
	    });
    });

    it("refuses cross-origin activity path overrides before attaching sync token headers", async () => {
      const client = createAtlasClient({
        endpoint: "https://living-atlas.example",
        syncToken: "fixture-sync-token-client-0005",
        fetchImpl: async () => {
          throw new Error("fetch should not be called");
        }
      });

      await expect(client.fetchActivityEvents({
        path: "https://attacker.example/api/activity/audit"
      })).rejects.toMatchObject({
        code: "invalid-response"
      });
    });
	});
