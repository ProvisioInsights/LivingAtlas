import { createHash } from "node:crypto";
import type { ServerContext } from "@modelcontextprotocol/server";
import { PrincipalSchema, type Plane, type Principal, type PrincipalResolution, type PrincipalResolver } from "./principal.js";

/**
 * Credentials, and the one place a credential becomes a `client_id`.
 *
 * The defect this replaces: the prior daemon read whatever credential arrived
 * and then substituted its own environment token before doing anything with it.
 * Every consumer therefore committed under one identity. `provenance.client_id`
 * named the daemon, not the caller, so "assertions this credential authored" —
 * the rule supersession scope is written in terms of — could not be evaluated,
 * and a usage report could not attribute a single read.
 *
 * Here a credential is presented per request, resolved against a directory, and
 * the resolved principal is the ONLY source of `client_id`. No tool reads an
 * identity out of the request body, and there is no code path that replaces a
 * caller's credential with the server's own.
 */

/**
 * The `_meta` member a request presents its credential on.
 *
 * `_meta` rather than a tool argument, for two reasons. A tool argument would
 * have to appear in the published input schema of every tool, which would put a
 * secret inside the object that gets logged, echoed in error messages and
 * digested into the audit event's `arguments_digest`. And `_meta` rides the
 * REQUEST, so the credential is per-request input exactly as the revision's
 * tools/list rule describes it — not connection state a later request inherits.
 *
 * Namespaced to this project: the `io.modelcontextprotocol/` prefix is reserved
 * for keys the specification defines.
 */
export const CREDENTIAL_META_KEY = "io.livingatlas/credential";

/**
 * The credential presented on ONE request, or undefined.
 *
 * Read off the request's `_meta` and nowhere else. Notably not off the
 * connection, and notably not off the arguments: a tool that accepted an
 * identity as an argument would let a caller name its own `client_id`, which is
 * the whole defect.
 *
 * `mcpReq._meta` and not `mcpReq.envelope`, and the difference is not cosmetic.
 * Measured against `@modelcontextprotocol/server@2.0.0`: the inbound lift moves
 * only the RESERVED `io.modelcontextprotocol/*` keys into `envelope` and leaves
 * every other `_meta` member in `mcpReq._meta`. Reading a project-namespaced
 * key off `envelope` finds nothing, and finding nothing here is indistinguishable
 * from a caller that presented nothing — which fails closed, but for the wrong
 * reason and with a refusal nobody can act on.
 */
export function presentedCredential(context: ServerContext): string | undefined {
  const meta = context.mcpReq._meta as Record<string, unknown> | undefined;
  const presented = meta?.[CREDENTIAL_META_KEY];
  return typeof presented === "string" && presented.length > 0 ? presented : undefined;
}

export type CredentialRecord = {
  /** `sha256:<hex>` of the shared secret. The secret itself is never stored. */
  token_hash: string;
  principal: Principal;
};

export type CredentialDirectory = {
  /** The principal a presented secret resolves to, or undefined. */
  resolve(secret: string): Principal | undefined;
};

export function hashCredential(secret: string): string {
  return `sha256:${createHash("sha256").update(secret, "utf8").digest("hex")}`;
}

/**
 * A directory held in memory, keyed by token hash.
 *
 * Keyed by HASH rather than by the secret so the secret is not resident in the
 * process's data structures, and so a directory can be loaded from a file that
 * holds no secrets at all — which is what makes a credential set reviewable in
 * a diff without becoming a leak.
 */
export class InMemoryCredentialDirectory implements CredentialDirectory {
  private readonly byHash = new Map<string, Principal>();

  constructor(records: readonly CredentialRecord[]) {
    for (const record of records) {
      // Parsed, not trusted. A directory is configuration, and configuration is
      // exactly where a principal whose plane and credential class disagree
      // would otherwise be introduced.
      const principal = PrincipalSchema.parse(record.principal);
      if (this.byHash.has(record.token_hash)) {
        throw new Error(`two credentials share a token hash; one of them would be unreachable`);
      }
      this.byHash.set(record.token_hash, principal);
    }
  }

  get size(): number {
    return this.byHash.size;
  }

  resolve(secret: string): Principal | undefined {
    return this.byHash.get(hashCredential(secret));
  }
}

/**
 * Resolve the credential presented on one request, for one plane.
 *
 * The plane check is the whole of the operator/consumer separation on the
 * authorization side, and it is here rather than in a tool: a credential
 * granted the operator plane presents the same way as any other, so the server
 * that receives it decides whether that credential belongs to it at all. A
 * consumer credential on the operator server never reaches a handler, and an
 * operator credential on the consumer server never reaches one either.
 *
 * Note what the resolver does NOT consult: how the request arrived. Two
 * deployments of the same credential over different transports resolve to the
 * same principal, which is what makes transport parity testable rather than
 * aspirational.
 */
export function credentialResolver(options: { directory: CredentialDirectory; plane: Plane }): PrincipalResolver {
  return (presented) => {
    if (presented === undefined || presented.length === 0) {
      return { ok: false, reasonCode: "credential-required" };
    }
    const principal = options.directory.resolve(presented);
    if (principal === undefined) {
      return { ok: false, reasonCode: "credential-unknown" };
    }
    if (principal.plane !== options.plane) {
      return { ok: false, reasonCode: "credential-plane-mismatch" };
    }
    return { ok: true, principal };
  };
}

/**
 * A resolver that answers with one principal whatever is presented.
 *
 * For a deployment with a single credential and for tests. It is a deliberate
 * dead end: with one principal there is one `client_id`, so every assertion is
 * attributed to it and a usage report has one row. That is the collapse this
 * package exists to make impossible by accident — so it is available only by
 * asking for it by name, and the CLI says so when it is in use.
 */
export function fixedPrincipalResolver(principal: Principal): PrincipalResolver {
  const parsed = PrincipalSchema.parse(principal);
  return (): PrincipalResolution => ({ ok: true, principal: parsed });
}
