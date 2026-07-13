import { describe, expect, it } from "vitest";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { createRecoveryBundle, openRecoveryBundle, wrapKeyringForEscrow, unwrapKeyringFromEscrow } from "./escrow";

describe("escrow", () => {
  const master = randomBytes(32); // 256-bit recovery master
  const keyringJson = JSON.stringify({ keys: [{ id: "la_key_x", material: "AAAA" }] });

  it("round-trips the keyring through wrap/unwrap", () => {
    const env = wrapKeyringForEscrow(keyringJson, master);
    expect(env.algorithm).toBe("AES-256-GCM+recovery-master-v1");
    expect(unwrapKeyringFromEscrow(env, master)).toBe(keyringJson);
  });

  it("fails to unwrap with the wrong master (no partial plaintext)", () => {
    const env = wrapKeyringForEscrow(keyringJson, master);
    expect(() => unwrapKeyringFromEscrow(env, randomBytes(32))).toThrow();
  });

  it("rejects a tampered ciphertext (GCM auth)", () => {
    const env = wrapKeyringForEscrow(keyringJson, master);
    const tampered = { ...env, ciphertext_b64: Buffer.from(randomBytes(env_len(env))).toString("base64") };
    expect(() => unwrapKeyringFromEscrow(tampered, master)).toThrow();
  });

  it("seals a self-sufficient recovery bundle to an X25519 public key", () => {
    const { publicKey, privateKey } = generateKeyPairSync("x25519");
    const bundle = createRecoveryBundle({
      authority_id: "la_authority_test0001",
      sealed_keyring_json: keyringJson,
      keyring_passphrase: "synthetic-passphrase",
      recovery_public_key: publicKey
    });
    expect(bundle.schema).toBe("living-atlas-recovery-bundle:v2");
    expect(JSON.stringify(bundle)).not.toContain("synthetic-passphrase");
    expect(openRecoveryBundle(bundle, privateKey)).toEqual({
      authority_id: "la_authority_test0001",
      sealed_keyring_json: keyringJson,
      keyring_passphrase: "synthetic-passphrase"
    });
  });
});

function env_len(env: { ciphertext_b64: string }): number {
  return Buffer.from(env.ciphertext_b64, "base64").length;
}
