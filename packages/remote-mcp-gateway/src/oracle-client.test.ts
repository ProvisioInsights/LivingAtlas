import { describe, expect, it } from "vitest";
import { callDecryptionOracle } from "./oracle-client";

describe("callDecryptionOracle", () => {
  it("returns plaintext on a 200 oracle response", async () => {
    const fakeFetch = async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.grant.payload.object_id).toBe("la_object_ssn0001");
      return new Response(
        JSON.stringify({ ok: true, plaintext: { kind: "plaintext-json", data: { ssn: "x" } } }),
        { status: 200 }
      );
    };
    const result = await callDecryptionOracle(fakeFetch as never, "https://oracle.internal/decrypt", {
      grant: { payload: { object_id: "la_object_ssn0001" }, signature: "s" } as never,
      object: { object_id: "la_object_ssn0001" } as never
    });
    expect(result).toEqual({ ok: true, plaintext: { kind: "plaintext-json", data: { ssn: "x" } } });
  });

  it("fails safe with owner-offline when the oracle is unreachable", async () => {
    const fakeFetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    const result = await callDecryptionOracle(fakeFetch as never, "https://oracle.internal/decrypt", {
      grant: { payload: { object_id: "o" }, signature: "s" } as never,
      object: { object_id: "o" } as never
    });
    expect(result).toEqual({ ok: false, reason: "owner-offline" });
  });
});
