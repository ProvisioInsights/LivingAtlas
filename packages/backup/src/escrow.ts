import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGO = "AES-256-GCM+recovery-master-v1";
const AAD = Buffer.from("living-atlas/keyring-escrow/v1");

export type EscrowEnvelope = {
  algorithm: typeof ALGO;
  iv_b64: string;
  tag_b64: string;
  ciphertext_b64: string;
};

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
