import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { LivingAtlasRemoteMcp } from "./agent";
import { authHandler } from "./auth-handler";

export { LivingAtlasRemoteMcp };
export { authHandler, decideAuthRoute } from "./auth-handler";

/**
 * Gateway worker default export: an `@cloudflare/workers-oauth-provider@0.8.1`
 * OAuthProvider fronting the `LivingAtlasRemoteMcp` Durable Object agent.
 *
 * NOT runtime-verified — `@cloudflare/workers-oauth-provider` imports
 * `cloudflare:workers` at module top and `agents/mcp` pulls further
 * `cloudflare:`-scheme modules, so this default export cannot be loaded or
 * exercised under plain-node vitest. It is wired to the confirmed installed API
 * and typechecks; the OAuth discovery/token/authorize handshake and the
 * `McpAgent.serve("/mcp")` DO mount are a deploy-session smoke item
 * (`wrangler dev` + a live OAuth client). The node-loadable pieces it composes —
 * the tool catalog (`agent-catalog.ts`), the policy/guardrail/redaction/streaming
 * decision logic, and the `defaultHandler` routing (`auth-handler.ts`) — ARE
 * node-unit-tested.
 *
 * API confirmed against `oauth-provider.d.ts` (0.8.1):
 *  - `apiRoute` + `apiHandler` single-handler form; `apiHandler` accepts an
 *    `ExportedHandlerWithFetch` (what `McpAgent.serve` returns).
 *  - `disallowPublicClientRegistration: true` enforces allowlisted DCR (spec §5).
 *  - PKCE is on by default; `allowPlainPKCE` defaults true — S256 is always
 *    accepted. `accessTokenTTL` in seconds.
 *  - `completeAuthorization(...)` returns `{ redirectTo }` (OPEN QUESTION #3).
 */
export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: LivingAtlasRemoteMcp.serve("/mcp") as never,
  defaultHandler: authHandler as never,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  scopesSupported: ["mcp:remote"],
  disallowPublicClientRegistration: true, // allowlisted DCR per spec §5
  accessTokenTTL: 900
});
