import { createCipheriv, createDecipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, type KeyObject } from "node:crypto";

const ALGO = "AES-256-GCM+recovery-master-v1";
const AAD = Buffer.from("living-atlas/keyring-escrow/v1");
const RECOVERY_AAD = Buffer.from("living-atlas/recovery-bundle/v2");
const RECOVERY_ALGO = "X25519+AES-256-GCM+recovery-bundle-v2";

export type EscrowEnvelope = {
  algorithm: typeof ALGO;
  iv_b64: string;
  tag_b64: string;
  ciphertext_b64: string;
};

export type RecoveryBundleV2 = {
  schema: "living-atlas-recovery-bundle:v2";
  algorithm: typeof RECOVERY_ALGO;
  ephemeral_public_key_spki_b64: string;
  iv_b64: string;
  tag_b64: string;
  ciphertext_b64: string;
};

function recoveryKey(sharedSecret: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", sharedSecret, Buffer.alloc(0), RECOVERY_AAD, 32));
}

export function createRecoveryBundle(input: {
  authority_id: string;
  sealed_keyring_json: string;
  keyring_passphrase: string;
  recovery_public_key: KeyObject;
}): RecoveryBundleV2 {
  if (input.recovery_public_key.asymmetricKeyType !== "x25519") throw new Error("recovery-public-key-required");
  const ephemeral = generateKeyPairSync("x25519");
  const key = recoveryKey(diffieHellman({ privateKey: ephemeral.privateKey, publicKey: input.recovery_public_key }));
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(RECOVERY_AAD);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify({
    authority_id: input.authority_id,
    sealed_keyring_json: input.sealed_keyring_json,
    keyring_passphrase: input.keyring_passphrase
  })), cipher.final()]);
  return {
    schema: "living-atlas-recovery-bundle:v2", algorithm: RECOVERY_ALGO,
    ephemeral_public_key_spki_b64: ephemeral.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    iv_b64: iv.toString("base64"), tag_b64: cipher.getAuthTag().toString("base64"), ciphertext_b64: ciphertext.toString("base64")
  };
}

export function openRecoveryBundle(bundle: RecoveryBundleV2, recoveryPrivateKey: KeyObject): {
  authority_id: string; sealed_keyring_json: string; keyring_passphrase: string;
} {
  if (bundle.schema !== "living-atlas-recovery-bundle:v2" || bundle.algorithm !== RECOVERY_ALGO || recoveryPrivateKey.asymmetricKeyType !== "x25519") throw new Error("recovery-bundle-invalid");
  const publicKey = createPublicKey({ key: Buffer.from(bundle.ephemeral_public_key_spki_b64, "base64"), format: "der", type: "spki" });
  const decipher = createDecipheriv("aes-256-gcm", recoveryKey(diffieHellman({ privateKey: recoveryPrivateKey, publicKey })), Buffer.from(bundle.iv_b64, "base64"));
  decipher.setAAD(RECOVERY_AAD);
  decipher.setAuthTag(Buffer.from(bundle.tag_b64, "base64"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(bundle.ciphertext_b64, "base64")), decipher.final()]).toString("utf8")) as {
    authority_id: string; sealed_keyring_json: string; keyring_passphrase: string;
  };
}

export function wrapKeyringForEscrow(keyringJson: string, master: Buffer): EscrowEnvelope {
  if (master.length !== 32) throw new Error("recovery master must be 32 bytes");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", master, iv);
  cipher.setAAD(AAD);
  const ct = Buffer.concat([cipher.update(Buffer.from(keyringJson, "utf8")), cipher.final()]);
  return {
    algorithm: ALGO,
    iv_b64: iv.toString("base64"),
    tag_b64: cipher.getAuthTag().toString("base64"),
    ciphertext_b64: ct.toString("base64"),
  };
}

export function unwrapKeyringFromEscrow(env: EscrowEnvelope, master: Buffer): string {
  if (env.algorithm !== ALGO) throw new Error("unknown escrow algorithm");
  const decipher = createDecipheriv("aes-256-gcm", master, Buffer.from(env.iv_b64, "base64"));
  decipher.setAAD(AAD);
  decipher.setAuthTag(Buffer.from(env.tag_b64, "base64"));
  const pt = Buffer.concat([
    decipher.update(Buffer.from(env.ciphertext_b64, "base64")),
    decipher.final(), // throws on auth failure — no partial plaintext returned
  ]);
  return pt.toString("utf8");
}
