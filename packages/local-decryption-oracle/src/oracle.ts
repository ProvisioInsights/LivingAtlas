import { decryptEscalatedCloudUnlockObject, type SignedEscalationGrant } from "@living-atlas/remote-crypto";
import type { GraphObjectEnvelope } from "@living-atlas/contracts";
import { verifyEscalationGrant, InMemoryNonceSeen, type NonceSeen } from "./grant-verify";

export { InMemoryNonceSeen } from "./grant-verify";

export type OracleConfig = {
  signingKeyB64: string;
  escalationKeyB64: string;
  seen: NonceSeen;
  now: () => number;
};

export type OracleDecryptResult =
  | { ok: true; plaintext: { kind: "plaintext-json"; data: Record<string, unknown> } }
  | {
      ok: false;
      reason:
        | "grant-object-mismatch"
        | "bad-signature"
        | "expired"
        | "replayed"
        | "decrypt-failed"
        | "unsupported-algorithm"
        | "unsupported-payload"
        | "invalid-escalation-key";
    };

export function createLocalOracle(config: OracleConfig) {
  return {
    async decrypt(input: {
      grant: SignedEscalationGrant;
      object: GraphObjectEnvelope;
    }): Promise<OracleDecryptResult> {
      if (
        input.grant.payload.object_id !== input.object.object_id ||
        input.grant.payload.authority_id !== input.object.authority_id
      ) {
        return { ok: false, reason: "grant-object-mismatch" };
      }
      const verified = await verifyEscalationGrant(config.signingKeyB64, input.grant, {
        now_ms: config.now(),
        seen: config.seen
      });
      if (!verified.ok) return { ok: false, reason: verified.reason };
      const decrypted = await decryptEscalatedCloudUnlockObject(input.object, config.escalationKeyB64);
      return decrypted.ok ? { ok: true, plaintext: decrypted.plaintext } : { ok: false, reason: decrypted.reason };
    }
  };
}
