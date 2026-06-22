import { describe, expect, it } from "vitest";
import { liveUsageGateEnv } from "./cloudflare-live-usage-gate";
import { runCloudflareLiveOpsReport } from "./cloudflare-live-ops-report";

const baseEnv = {
  [liveUsageGateEnv.endpoint]: "https://living-atlas-live.example",
  [liveUsageGateEnv.healthToken]: "fixture-health-token-value"
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json"
    }
  });
}

describe("Cloudflare live ops report", () => {
  it("combines the gate decision and provider reconciliation", async () => {
    const urls: string[] = [];
    const result = await runCloudflareLiveOpsReport({
      env: baseEnv,
      fetchImpl: async (input, init) => {
        const url = input instanceof URL ? input : new URL(String(input));
        urls.push(url.toString());
        expect(new Headers(init?.headers).get("x-living-atlas-health-token")).toBe("fixture-health-token-value");

        if (url.pathname === "/api/usage/gate") {
          return json(200, {
            ok: true,
            decision: "safe-to-test",
            reason_codes: [],
            usage: {
              services: {
                workers: {
                  observed: { requests: 12, http_5xx: 0 },
                  budgets: { requests: { used: 12, limit: 100_000, ratio: 0.00012 } }
                }
              }
            }
          });
        }

        return json(200, {
          ok: true,
          decision: "reconciled",
          reason_codes: [],
          app_observed: {
            sync_generation: 7,
            sync_object_count: 22,
            sync_change_count: 22,
            d1_retained_metric_rows: 12,
            d1_committed_batches: 4
          },
          provider_observed: {
            r2: {
              object_count: 22,
              total_bytes: 8192,
              list_calls: 1,
              truncated: false,
              object_delta_vs_app: 0,
              byte_delta_vs_app_estimate: 0
            }
          }
        });
      }
    });

    expect(result).toMatchObject({
      ok: true,
      gate: {
        decision: "safe-to-test"
      },
      reconciliation: {
        decision: "reconciled",
        r2_object_count: 22,
        r2_object_delta_vs_app: 0,
        sync_generation: 7
      }
    });
    expect(urls.some((url) => url.includes("/api/usage/gate"))).toBe(true);
    expect(urls.some((url) => url.includes("/api/usage/reconcile"))).toBe(true);
    expect(urls.join("\n")).not.toContain("fixture-health-token-value");
  });

  it("needs review when reconciliation fails", async () => {
    const result = await runCloudflareLiveOpsReport({
      env: baseEnv,
      fetchImpl: async (input) => {
        const url = input instanceof URL ? input : new URL(String(input));
        if (url.pathname === "/api/usage/gate") {
          return json(200, { ok: true, decision: "safe-to-test", reason_codes: [] });
        }

        return json(200, {
          ok: false,
          decision: "needs-review",
          reason_codes: ["r2-object-count-mismatch"]
        });
      }
    });

    expect(result).toMatchObject({
      ok: false,
      reconciliation: {
        decision: "needs-review",
        reason_codes: ["r2-object-count-mismatch"]
      }
    });
  });
});
