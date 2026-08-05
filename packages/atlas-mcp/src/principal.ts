import { z } from "zod";
import { CapabilityGrantSchema, sensitivityCeiling, type CapabilityGrant, type SensitivityTier } from "./grant.js";

/**
 * Who is calling, and what that credential may reach.
 *
 * `client_id` is resolved HERE, from the credential, and is never read from
 * anything the caller sent. The prior server unconditionally replaced whatever
 * credential arrived with the daemon's own env token, which collapsed every
 * consumer to one identity: attribution became impossible, and so did any rule
 * expressed in terms of "assertions this credential authored".
 *
 * The split is deliberate. The principal says WHO is calling and on which
 * plane; the grant says WHAT may be done. Nothing about a transport appears in
 * either, so a correct consumer never branches on how it connected — it asks
 * `atlas.scope.describe.v1` what its grant is.
 *
 * Self-reported client info (`io.modelcontextprotocol/clientInfo`) is
 * deliberately absent from this type. It is a display string a caller chooses;
 * binding anything to it would let a caller pick its own principal.
 */

export const PLANES = ["consumer", "operator"] as const;
export type Plane = (typeof PLANES)[number];

export const PrincipalSchema = z
  .object({
    client_id: z.string().min(1),
    /**
     * The operator plane is bound to its own credential class. Not a convention:
     * the refinement below makes an operator-plane principal with a consumer
     * credential class unparseable, so a credential cannot acquire the operator
     * plane by having its plane field edited alone.
     */
    credential_class: z.enum(["consumer", "owner", "operator"]),
    plane: z.enum(PLANES),
    grant: CapabilityGrantSchema
  })
  .strict()
  .superRefine((principal, ctx) => {
    const operatorPlane = principal.plane === "operator";
    const operatorClass = principal.credential_class === "operator";
    if (operatorPlane !== operatorClass) {
      ctx.addIssue({
        code: "custom",
        path: ["credential_class"],
        message:
          "the operator plane is bound to the operator credential class: an operator-plane principal must carry credential_class 'operator', and no other plane may"
      });
    }
  });

export type Principal = z.infer<typeof PrincipalSchema>;

/** The published `sensitivity_ceiling`: a report of the grant's reachable set. */
export function ceilingOf(principal: Principal): SensitivityTier {
  return sensitivityCeiling(principal.grant);
}

/** The grant, for the readers that only care what may be done. */
export function grantOf(principal: Principal): CapabilityGrant {
  return principal.grant;
}

/**
 * Resolves a presented credential into a principal.
 *
 * Takes the credential PRESENTED ON THE REQUEST, because that is what the
 * protocol makes available: MCP 2026-07-28 has no session, and the tool set a
 * server answers with "MAY vary by the authorization presented on the request …
 * since credentials are per-request input, not connection state". A resolver
 * that took no argument could only ever answer with one principal per process,
 * which is exactly how every consumer collapsed onto one `client_id`.
 *
 * The refusal is typed rather than thrown so the dispatcher can write one audit
 * event for it: an unauthenticated call is a security-relevant event and a
 * thrown exception is not an event.
 */
export type PrincipalResolution =
  | { ok: true; principal: Principal }
  | { ok: false; reasonCode: "credential-required" | "credential-unknown" | "credential-plane-mismatch" };

export type PrincipalResolver = (presented: string | undefined) => PrincipalResolution;

/** How many buckets wide a bucketed count is rounded to. */
export const COVERAGE_BUCKET_WIDTH = 10;

/**
 * Round a count up to the bucket boundary.
 *
 * UP, not to-nearest: rounding down could report `withheld: 0` when something
 * was in fact withheld, which is the one lie this surface must never tell. Zero
 * stays zero — "nothing was withheld" is a true statement worth being able to
 * make, and bucketing it to 10 would make an unfiltered read look filtered.
 */
export function bucketCount(exact: number, width = COVERAGE_BUCKET_WIDTH): number {
  if (exact <= 0) return 0;
  return Math.ceil(exact / width) * width;
}

/** Apply the principal's counting basis to a raw count. */
export function reportCount(principal: Principal, exact: number): number {
  return principal.grant.coverage_counts_basis === "exact" ? exact : bucketCount(exact);
}
