import { randomBytes } from "node:crypto";
import {
  createRequestStateCodec,
  type RequestStateCodec,
  type ServerContext
} from "@modelcontextprotocol/server";
import { z } from "zod";

/**
 * The multi-round-trip `requestState` for `atlas.sensitive.reveal.v1`.
 *
 * `requestState` travels through the client and comes back as
 * ATTACKER-CONTROLLED input. The SDK is explicit that it applies no integrity
 * protection of its own: without a configured `ServerOptions.requestState.verify`
 * hook, `ctx.mcpReq.requestState()` hands the handler the raw wire string. Here
 * it decides whether a withheld record is disclosed, so it is integrity-
 * protected, bound, expiring, and rejected on any verification failure.
 *
 * Three protections, and they cover different attacks:
 *
 *  1. **HMAC-SHA256 over the payload** (`createRequestStateCodec`). Stops a
 *     caller editing which object it points at. Verified BEFORE the handler
 *     runs — the SDK's seam answers a frozen `-32602` and the handler is never
 *     entered, so a forged state cannot even reach the tool code.
 *
 *  2. **Binding to the principal and the method.** A state minted for one
 *     credential is refused when echoed by another, so an escalation the owner
 *     approved for client A cannot be replayed by client B. The binding value
 *     is stored as a keyed HMAC tag, never raw — the principal identifier does
 *     not appear in the string the client holds.
 *
 *  3. **Binding to the object, checked in the handler.** The redaction id is
 *     inside the signed payload; the handler compares it against the
 *     `redaction_id` argument and refuses a mismatch. This is the check the
 *     `bind` hook cannot do, because `bind` sees the context and not the
 *     arguments.
 *
 * The codec is SIGNED, not encrypted: a client can base64url-decode the payload
 * and read it. So the payload holds a redaction id and a request id and nothing
 * else — no key material, no plaintext, no sensitivity tier. Key material never
 * enters `requestState` and never enters a `_meta` annotation.
 */

export const REVEAL_STATE_TTL_SECONDS = 300;

/** Minimum HMAC key length the SDK enforces; restated so a caller sees the rule. */
export const REVEAL_STATE_MIN_KEY_BYTES = 32;

/**
 * What travels inside the signed envelope.
 *
 * Parsed on the way back out even though the MAC already proved nobody edited
 * it: the MAC proves the bytes are ours, not that they are the shape this
 * version of the code expects. A payload minted by an older build and echoed
 * after an upgrade is exactly the case where an unparsed `any` becomes an
 * undefined field read as an authorization decision.
 */
export const RevealStatePayloadSchema = z
  .object({
    request_id: z.string().min(1),
    redaction_id: z.string().min(1)
  })
  .strict();

export type RevealStatePayload = z.infer<typeof RevealStatePayloadSchema>;

export type RevealStateOptions = {
  /**
   * The identity a state is bound to, resolved from the credential presented on
   * THIS request.
   *
   * A function of the request rather than of the process: identity is
   * per-request input on this revision, so binding to a process-wide principal
   * would bind every credential on one pipe to the same value — and an
   * escalation approved for one consumer would then verify for another.
   *
   * It throws when the credential does not resolve, and that is the intended
   * behaviour on the verify path: a `requestState` echoed without a credential
   * this server recognises is refused at the SDK seam, before any handler.
   */
  resolveBindingIdentity: (context: ServerContext) => string;
  /**
   * The HMAC key. Optional, and a per-process random key is the right default
   * for THIS transport specifically: one stdio process serves every round of a
   * flow, so there is no second instance that would need the same key. A restart
   * therefore invalidates every outstanding escalation, which is the behaviour
   * we want — an owner decision that spans a server restart should fail closed
   * rather than be honoured by a process that has forgotten why it was asked.
   *
   * A shared-key deployment (any multi-instance HTTP surface) MUST supply one.
   * That surface is out of scope for this run; the option exists so adding it
   * later is configuration rather than a redesign.
   */
  key?: Uint8Array | string;
  ttlSeconds?: number;
};

export type RevealStateCodec = {
  codec: RequestStateCodec<RevealStatePayload>;
  /** Drop straight into `ServerOptions.requestState.verify`. */
  verify: (state: string, ctx: ServerContext) => Promise<RevealStatePayload>;
  ttlSeconds: number;
};

export function createRevealStateCodec(options: RevealStateOptions): RevealStateCodec {
  const ttlSeconds = options.ttlSeconds ?? REVEAL_STATE_TTL_SECONDS;
  const codec = createRequestStateCodec<RevealStatePayload>({
    key: options.key ?? randomBytes(REVEAL_STATE_MIN_KEY_BYTES),
    ttlSeconds,
    /**
     * The method is in the binding as well as the principal. Without it a state
     * minted by one method could be echoed into another that also reads
     * `requestState`, and the second method would see a payload that verified
     * cleanly against a decision nobody made about it.
     *
     * NUL separates the two halves because both are free strings: a printable
     * separator lets one client_id be chosen so that the concatenation collides
     * with another. Same rule, and the same reason, as `submissionKey()`.
     */
    bind: (ctx) => `${ctx.mcpReq.method}\u0000${options.resolveBindingIdentity(ctx)}`
  });

  return {
    codec,
    ttlSeconds,
    verify: async (state, ctx) => {
      const payload = await codec.verify(state, ctx);
      // Re-parse the decoded payload. `verify` proves authorship; this proves
      // shape. Both, or a field this build expects and an older build never
      // wrote reads as `undefined` inside an access decision.
      return RevealStatePayloadSchema.parse(payload);
    }
  };
}
