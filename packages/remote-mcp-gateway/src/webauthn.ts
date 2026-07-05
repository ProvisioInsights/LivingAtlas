import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse
} from "@simplewebauthn/server";
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture
} from "@simplewebauthn/server";

const CHALLENGE_TTL_SECONDS = 300;

export async function putChallenge(kv: KVNamespace, key: string, challenge: string): Promise<void> {
  await kv.put(key, challenge, { expirationTtl: CHALLENGE_TTL_SECONDS });
}

export async function takeChallenge(kv: KVNamespace, key: string): Promise<string | undefined> {
  const value = await kv.get(key);
  if (value === null) return undefined;
  await kv.delete(key);
  return value;
}

export type OwnerRpConfig = {
  rpID: string;
  rpName: string;
  ownerUserId: string;
  ownerUserName: string;
};

export async function beginOwnerRegistration(kv: KVNamespace, cfg: OwnerRpConfig) {
  const options = await generateRegistrationOptions({
    rpName: cfg.rpName,
    rpID: cfg.rpID,
    userName: cfg.ownerUserName,
    attestationType: "none",
    authenticatorSelection: { residentKey: "required", userVerification: "required" }
  });
  await putChallenge(kv, `webauthn:reg:${cfg.ownerUserId}`, options.challenge);
  return options;
}

export type OwnerCredential = { id: string; publicKey: Uint8Array<ArrayBuffer>; counter: number };

export type FinishRegistrationConfig = {
  rpID: string;
  expectedOrigin: string;
  ownerUserId: string;
};

export type FinishRegistrationResult =
  | { ok: true; credential: OwnerCredential }
  | { ok: false; reason: "owner-already-bound" | "challenge-missing" | "verification-failed" };

export async function finishOwnerRegistration(
  kv: KVNamespace,
  cfg: FinishRegistrationConfig,
  response: RegistrationResponseJSON,
  lookupExistingOwner: () => OwnerCredential | { id: string } | undefined
): Promise<FinishRegistrationResult> {
  if (lookupExistingOwner()) {
    return { ok: false, reason: "owner-already-bound" };
  }
  const expectedChallenge = await takeChallenge(kv, `webauthn:reg:${cfg.ownerUserId}`);
  if (!expectedChallenge) {
    return { ok: false, reason: "challenge-missing" };
  }
  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: cfg.expectedOrigin,
    expectedRPID: cfg.rpID
  });
  if (!verification.verified || !verification.registrationInfo) {
    return { ok: false, reason: "verification-failed" };
  }
  const { credential } = verification.registrationInfo;
  return {
    ok: true,
    credential: { id: credential.id, publicKey: credential.publicKey, counter: credential.counter }
  };
}

export async function beginOwnerAuthentication(
  kv: KVNamespace,
  cfg: { rpID: string; ownerUserId: string },
  allowCredentials: Array<{ id: string; transports?: AuthenticatorTransportFuture[] }>
) {
  const options = await generateAuthenticationOptions({
    rpID: cfg.rpID,
    allowCredentials,
    userVerification: "required"
  });
  await putChallenge(kv, `webauthn:auth:${cfg.ownerUserId}`, options.challenge);
  return options;
}

export type FinishAuthResult =
  | { ok: true; newCounter: number }
  | { ok: false; reason: "challenge-missing" | "verification-failed" };

export async function finishOwnerAuthentication(
  kv: KVNamespace,
  cfg: { rpID: string; expectedOrigin: string; ownerUserId: string },
  response: AuthenticationResponseJSON,
  credential: OwnerCredential & { transports?: AuthenticatorTransportFuture[] }
): Promise<FinishAuthResult> {
  const expectedChallenge = await takeChallenge(kv, `webauthn:auth:${cfg.ownerUserId}`);
  if (!expectedChallenge) {
    return { ok: false, reason: "challenge-missing" };
  }
  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: cfg.expectedOrigin,
    expectedRPID: cfg.rpID,
    credential: {
      id: credential.id,
      publicKey: credential.publicKey,
      counter: credential.counter,
      transports: credential.transports
    }
  });
  return verification.verified
    ? { ok: true, newCounter: verification.authenticationInfo.newCounter }
    : { ok: false, reason: "verification-failed" };
}
