import { describe, expect, it } from "vitest";
import { decideAuthRoute } from "./auth-handler";

/**
 * The worker default export in `index.ts` is `new OAuthProvider(...)`, which
 * imports `cloudflare:workers` at module top (and `agents/mcp` pulls further
 * `cloudflare:`-scheme modules). That default export therefore CANNOT be
 * imported under plain-node vitest — doing so throws
 * "Only URLs with a scheme in: file, data, and node are supported". Its behavior
 * (OAuth discovery/token/authorize + `McpAgent.serve("/mcp")` mount) is a
 * deploy-session smoke item, NOT runtime-verified here. See `index.ts`.
 *
 * We assert the node-loadable pieces `index.ts` composes: the `defaultHandler`
 * routing that the provider delegates unauthenticated/non-API traffic to. The
 * `/authorize` route is where the owner passkey ceremony runs before
 * `completeAuthorization`; everything else falls through to a plain 404 (the
 * provider itself owns `/token`, `/register`, and `/.well-known/*`).
 */
describe("gateway worker entry (node-loadable surface)", () => {
  it("delegates /authorize to the owner login gate via the default handler", () => {
    expect(decideAuthRoute("/authorize")).toEqual({ kind: "authorize-owner-login-required" });
  });

  it("falls through to not-found for a non-OAuth path", () => {
    expect(decideAuthRoute("/nope")).toEqual({ kind: "not-found" });
  });
});
