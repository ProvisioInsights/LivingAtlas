import { createHash, timingSafeEqual } from "node:crypto";
import type { CredentialDirectory } from "../credentials.js";
import type { PrincipalResolution, PrincipalResolver } from "../principal.js";

/**
 * Who is calling, over HTTP.
 *
 * On stdio the pipe IS the trust boundary: a process that can write to the pipe
 * is already inside, and the `_meta` credential exists only to tell apart the
 * several consumers that share it. HTTP has no pipe. A loopback socket is
 * reachable by every process on the host and — absent the Origin check next door
 * — by every page the browser loads, so the request itself has to carry proof.
 *
 * ADR 0015 OPEN-5 asked what that proof is and whether `_meta` should then be
 * refused. Resolved here, in code:
 *
 *  1. **The bearer token is the credential.** `Authorization: Bearer <secret>`
 *     carries the same secret the `_meta` channel carries on stdio, and it is
 *     resolved through the SAME `CredentialDirectory`. One directory, one
 *     principal, one grant, whichever transport it arrived over — which is what
 *     makes the transport-parity claim structural rather than aspirational. The
 *     grant is therefore bound to the bearer token: no second credential concept
 *     exists for HTTP to drift away from.
 *
 *  2. **A disagreeing `_meta` credential is REFUSED, not ignored.** Silently
 *     preferring the bearer would let a caller that can set `_meta` but not the
 *     `Authorization` header believe it is acting as one principal while the
 *     server attributes its writes to another. That is the confused-deputy shape
 *     this package exists to prevent, and "silently ignored" is how it hides. An
 *     IDENTICAL `_meta` credential is allowed through, so a client that sends
 *     both channels keeps working.
 *
 *  3. **No fixed-principal shortcut.** `fixedPrincipalResolver` collapses every
 *     caller onto one `client_id`; on stdio it is a documented dead end for
 *     single-consumer deployments. Over HTTP it would mean an unauthenticated
 *     socket answering as a real principal, so `requireHttpCredentials` refuses
 *     to build a listener without a directory. That is the "refuse to start
 *     tokenless" rule, enforced at construction rather than per request.
 */

/** The `Authorization` scheme this server accepts. Compared case-insensitively, per RFC 9110. */
export const BEARER_SCHEME = "bearer";

/**
 * Constant-time equality for two secrets.
 *
 * Over the DIGESTS rather than the raw bytes, for two reasons. `timingSafeEqual`
 * throws when its inputs differ in length, and a throw that only happens for
 * unequal lengths is itself a length oracle; digesting makes every comparison
 * exactly 32 bytes. And the digest of a secret is not the secret, so the
 * comparison operates on values that are safe to hold.
 *
 * Used where BOTH sides are attacker-influenced — the `_meta`-versus-bearer
 * check below, where a caller controls `_meta` and is guessing at the bearer. A
 * `===` there would return faster on a longer shared prefix and hand back a byte
 * at a time.
 */
export function constantTimeEquals(left: string, right: string): boolean {
  const a = createHash("sha256").update(left, "utf8").digest();
  const b = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(a, b);
}

/**
 * The bearer secret presented on one request, or undefined.
 *
 * Undefined covers every malformed shape — absent header, wrong scheme, empty
 * token — deliberately collapsed into one answer. Distinguishing "no header"
 * from "wrong scheme" tells a prober how far it got, and neither case is one the
 * server can serve.
 */
export function presentedBearer(headers: Headers): string | undefined {
  const header = headers.get("authorization");
  if (header === null) return undefined;
  const space = header.indexOf(" ");
  if (space < 0) return undefined;
  if (header.slice(0, space).toLowerCase() !== BEARER_SCHEME) return undefined;
  const token = header.slice(space + 1).trim();
  return token.length > 0 ? token : undefined;
}

/**
 * Bind one request's bearer token to a principal resolver.
 *
 * The returned resolver is what the per-request server is built with, so the
 * ORIGINAL `resolvePrincipal` — the same one the stdio entry uses — remains the
 * only thing that turns a secret into a principal. This wrapper decides only
 * which secret is authoritative, never what it means.
 *
 * The `presented` argument it receives is whatever arrived in `_meta`; rule 2
 * above is applied to it here, before the underlying resolver ever sees it.
 */
export function bearerBoundResolver(inner: PrincipalResolver, bearer: string): PrincipalResolver {
  return (presentedInMeta: string | undefined): PrincipalResolution => {
    if (presentedInMeta !== undefined && !constantTimeEquals(presentedInMeta, bearer)) {
      // Reported as `credential-unknown` rather than a new reason code: from
      // this server's position a credential it will not honour is a credential
      // it does not recognise, and naming the conflict would confirm to a caller
      // that the OTHER value it holds is the real one.
      return { ok: false, reasonCode: "credential-unknown" };
    }
    return inner(bearer);
  };
}

/**
 * Refuse to build an HTTP listener that cannot tell its callers apart.
 *
 * Called at construction, not per request, because a deployment that starts
 * without credentials has already made the mistake — refusing the first request
 * would leave a listening socket that looks healthy. Returns the directory so
 * the check cannot be performed and then forgotten.
 *
 * The `size` probe is structural rather than part of `CredentialDirectory`:
 * `InMemoryCredentialDirectory` publishes one, a directory backed by something
 * else may not, and a directory that cannot report its size is taken at its word
 * rather than refused.
 */
export function requireHttpCredentials(directory: CredentialDirectory | undefined): CredentialDirectory {
  if (directory === undefined) {
    throw new Error(
      "an HTTP listener requires a credential directory: on stdio the pipe is the trust boundary and a fixed principal is a documented single-consumer dead end, but a loopback socket is reachable by every process on the host, so every request must carry a bearer token that resolves to a principal"
    );
  }
  const size = (directory as { size?: unknown }).size;
  if (typeof size === "number" && size === 0) {
    throw new Error(
      "the credential directory is empty: an HTTP listener built on it would refuse every request, so it is refused at construction instead of listening on a socket that can never serve anyone"
    );
  }
  return directory;
}
