import { describe, expect, it } from "vitest";
import { decideAuthRoute, authHandler } from "./auth-handler";

describe("OAuth defaultHandler routing", () => {
  it("routes /authorize to the owner passkey login gate", () => {
    expect(decideAuthRoute("/authorize")).toEqual({ kind: "authorize-owner-login-required" });
  });

  it("treats every other path as not-found (provider owns /token, /register, /.well-known/*)", () => {
    for (const p of ["/nope", "/token", "/register", "/.well-known/oauth-authorization-server"]) {
      expect(decideAuthRoute(p)).toEqual({ kind: "not-found" });
    }
  });

  it("serves a 401 owner-login gate on /authorize and a plain 404 elsewhere", async () => {
    const env = { OAUTH_KV: {} } as never;
    const authorize = await authHandler.fetch(new Request("https://gw.example/authorize"), env);
    expect(authorize.status).toBe(401);
    expect(await authorize.text()).toBe("owner-login-required");

    const other = await authHandler.fetch(new Request("https://gw.example/elsewhere"), env);
    expect(other.status).toBe(404);
    expect(other.headers.get("content-type")).toContain("text/plain");
  });
});
