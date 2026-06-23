import { describe, expect, it } from "vitest";
import {
  liveUsageGateEnv,
  readCloudflareLiveUsageGateConfig,
  runCloudflareLiveUsageGate
} from "./cloudflare-live-usage-gate";

const baseEnv = {
  [liveUsageGateEnv.endpoint]: "https://living-atlas-live.example",
  [liveUsageGateEnv.usageToken]: "fixture-usage-token-value"
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json"
    }
  });
}

describe("Cloudflare live usage gate config", () => {
  it("fails closed without an endpoint and token", () => {
    const parsed = readCloudflareLiveUsageGateConfig({});
    expect("errors" in parsed && parsed.errors.join("\n")).toContain(liveUsageGateEnv.endpoint);
    expect("errors" in parsed && parsed.errors.join("\n")).toContain(liveUsageGateEnv.usageToken);
  });

  it("parses gate tuning without deriving values from token material", () => {
    const parsed = readCloudflareLiveUsageGateConfig({
      ...baseEnv,
      [liveUsageGateEnv.windowHours]: "6",
      [liveUsageGateEnv.maxBudgetRatio]: "0.75",
      [liveUsageGateEnv.minWorkerRequestsRemaining]: "2500",
      [liveUsageGateEnv.requireZero5xx]: "false"
    });

    expect("usageToken" in parsed && parsed.usageToken).toBe("fixture-usage-token-value");
    if ("usageToken" in parsed) {
      expect(parsed.endpoint).not.toContain("fixture-usage-token-value");
      expect(parsed.windowHours).toBe(6);
      expect(parsed.maxBudgetRatio).toBe(0.75);
      expect(parsed.minWorkerRequestsRemaining).toBe(2_500);
      expect(parsed.requireZero5xx).toBe(false);
    }
  });
});

describe("Cloudflare live usage gate runner", () => {
  it("passes when the deployed gate says safe-to-test", async () => {
    const seenRequests: URL[] = [];
    const result = await runCloudflareLiveUsageGate({
      env: baseEnv,
      fetchImpl: async (input, init) => {
        const url = input instanceof URL ? input : new URL(String(input));
        seenRequests.push(url);
        expect(new Headers(init?.headers).get("x-living-atlas-usage-token")).toBe("fixture-usage-token-value");
        return json(200, {
          ok: true,
          decision: "safe-to-test",
          reason_codes: [],
          usage: {
            window: { hours: 24 },
            services: {
              workers: {
                observed: { requests: 100, http_5xx: 0 },
                budgets: { requests: { used: 100, limit: 100_000, ratio: 0.001 } }
              },
              r2: { observed: { objects: 10, estimated_stored_bytes: 4096 } },
              d1: { observed: { window_estimated_rows_written: 50 } }
            },
            sync: { latest_generation: 2, object_count: 10, change_count: 10 }
          }
        });
      }
    });

    expect(result).toMatchObject({
      ok: true,
      decision: "safe-to-test",
      summary: {
        worker_requests: 100,
        worker_request_ratio: 0.001,
        sync_generation: 2
      }
    });
    expect(seenRequests[0]?.pathname).toBe("/api/usage/gate");
    expect(seenRequests[0]?.toString()).not.toContain("fixture-usage-token-value");
  });

  it("stops when the deployed gate says stop-testing", async () => {
    const result = await runCloudflareLiveUsageGate({
      env: baseEnv,
      fetchImpl: async () => json(200, {
        ok: false,
        decision: "stop-testing",
        reason_codes: ["budget-ratio-exceeded"],
        usage: {
          services: {
            workers: {
              observed: { requests: 90_000, http_5xx: 0 },
              budgets: { requests: { used: 90_000, limit: 100_000, ratio: 0.9 } }
            }
          }
        }
      })
    });

    expect(result).toMatchObject({
      ok: false,
      decision: "stop-testing",
      reason_codes: ["budget-ratio-exceeded"]
    });
  });
});
