import type { GraphObjectEnvelope } from "@living-atlas/contracts";
import {
  CloudUnlockEscalatedObjectAlgorithm,
  decryptCloudUnlockObject,
  type SignedEscalationGrant
} from "@living-atlas/remote-crypto";
import { decideTierAccess, type CapabilityPolicy } from "./policy";
import type { OracleClientResult } from "./oracle-client";

type Plain = { kind: "plaintext-json"; data: Record<string, unknown> };

export type ResolveDecryptInput = {
  policy: CapabilityPolicy;
  object: GraphObjectEnvelope;
  cloudUnlockKeyB64: string;
  signGrant: (object: GraphObjectEnvelope) => Promise<SignedEscalationGrant>;
  callOracle: (grant: SignedEscalationGrant, object: GraphObjectEnvelope) => Promise<OracleClientResult>;
  recordT2: (ctx: {
    capability_id: string;
    authority_id: string;
    object_id: string;
    at_iso: string;
  }) => Promise<void>;
  nowIso: string;
};

export type ResolveDecryptResult =
  | { ok: true; tier: "T1" | "T2"; plaintext: Plain }
  | { ok: false; tier: "T1" | "T2"; reason: string };

function objectTier(object: GraphObjectEnvelope): "T1" | "T2" {
  return object.payload.kind === "ciphertext-inline" &&
    object.payload.algorithm === CloudUnlockEscalatedObjectAlgorithm
    ? "T2"
    : "T1";
}

export async function resolveDecrypt(input: ResolveDecryptInput): Promise<ResolveDecryptResult> {
  const tier = objectTier(input.object);
  const requested = tier === "T2" ? "T2" : "T1";
  const decision = decideTierAccess(input.policy, requested);
  if (!decision.allowed) {
    return { ok: false, tier, reason: "above-ceiling" };
  }
  if (tier === "T1") {
    const decrypted = await decryptCloudUnlockObject(input.object, input.cloudUnlockKeyB64);
    return decrypted.ok
      ? { ok: true, tier, plaintext: decrypted.plaintext }
      : { ok: false, tier, reason: decrypted.reason };
  }
  const grant = await input.signGrant(input.object);
  const oracleResult = await input.callOracle(grant, input.object);
  if (!oracleResult.ok) {
    return { ok: false, tier, reason: oracleResult.reason };
  }
  await input.recordT2({
    capability_id: input.policy.capability_id,
    authority_id: input.object.authority_id,
    object_id: input.object.object_id,
    at_iso: input.nowIso
  });
  return { ok: true, tier, plaintext: oracleResult.plaintext };
}
