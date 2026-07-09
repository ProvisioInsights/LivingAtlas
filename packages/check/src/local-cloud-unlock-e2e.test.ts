import { describe, expect, it } from "vitest";
import { runCloudUnlockE2eProof } from "./local-cloud-unlock-e2e";

describe("runCloudUnlockE2eProof (synthetic two-key escalation e2e)", () => {
  it("proves the full escalation flow: normal→primary, escalated→escalation-required-then-decrypt, wrong keys fail", async () => {
    const proof = await runCloudUnlockE2eProof({ sampleCount: 3 });
    expect(proof.samples).toBe(3);
    // Normal tier.
    expect(proof.decrypted_ok).toBe(3);
    expect(proof.rematerialized_decrypted_ok).toBe(3);
    expect(proof.wrong_key_denied).toBe(3);
    expect(proof.aad_tamper_denied).toBe(3);
    // Escalated tier.
    expect(proof.escalated_decrypted_ok).toBe(3);
    expect(proof.escalated_rematerialized_decrypted_ok).toBe(3);
    expect(proof.escalation_required_without_key).toBe(3);
    expect(proof.escalated_wrong_key_denied).toBe(3);
    expect(proof.escalated_aad_tamper_denied).toBe(3);
    // Leak custody for BOTH keys and both plaintexts.
    expect(proof.session_key_leaked).toBe(false);
    expect(proof.escalation_key_leaked).toBe(false);
    expect(proof.plaintext_leaked).toBe(false);
    expect(proof.complete).toBe(true);
  });

  it("carries both tier algorithms with a 12-byte nonce", async () => {
    const proof = await runCloudUnlockE2eProof({ sampleCount: 2 });
    expect(proof.algorithm).toBe("AES-GCM-256+cloud-unlock-v1");
    expect(proof.escalated_algorithm).toBe("AES-GCM-256+cloud-unlock-escalated-v1");
    expect(proof.nonce_bytes).toBe(12);
  });
});
