import type { GatewayEnv } from "./agent-catalog";

/**
 * The OAuthProvider `defaultHandler` handles every request the provider does not
 * own itself (`/token`, `/register`, `/.well-known/*` are the provider's). Its
 * job at authorize time is to run the owner passkey ceremony and, on success,
 * call `env.OAUTH_PROVIDER.completeAuthorization({ ..., props })` — the returned
 * `{ redirectTo }` (confirmed field name, @cloudflare/workers-oauth-provider
 * 0.8.1 `oauth-provider.d.ts`) is where the browser is sent back with a code.
 *
 * The routing/decision logic below is a pure function so it is node-unit-tested;
 * the full passkey UI + `navigator.credentials` ceremony and the actual
 * `completeAuthorization` call are a deployment gate (browser + live provider),
 * NOT runtime-verified here.
 */
export type AuthRouteDecision =
  | { kind: "authorize-owner-login-required" }
  | { kind: "not-found" };

export function decideAuthRoute(pathname: string): AuthRouteDecision {
  if (pathname === "/authorize") {
    return { kind: "authorize-owner-login-required" };
  }
  return { kind: "not-found" };
}

function plainNotFound(): Response {
  return new Response("Not Found\n", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }
  });
}

/**
 * Minimal `ExportedHandler`-shaped default handler. The real owner-login UI +
 * passkey verification are wired at deploy time (see `webauthn.ts` for the tested
 * server half); here we prove the provider delegates non-API traffic to us and
 * that the authorize route is reachable. NOT runtime-verified end-to-end.
 */
export const authHandler = {
  async fetch(request: Request, _env: GatewayEnv): Promise<Response> {
    const decision = decideAuthRoute(new URL(request.url).pathname);
    if (decision.kind === "authorize-owner-login-required") {
      return new Response("owner-login-required", {
        status: 401,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }
      });
    }
    return plainNotFound();
  }
};
