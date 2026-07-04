import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { wrapKeyringForEscrow, unwrapKeyringFromEscrow } from "./escrow";

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
});

function env_len(env: { ciphertext_b64: string }): number {
  return Buffer.from(env.ciphertext_b64, "base64").length;
}
