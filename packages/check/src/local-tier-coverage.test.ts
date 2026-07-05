import { describe, expect, it } from "vitest";
import {
  createDefaultLocalKeyring,
  encryptPlaintextGraphObjectDraft,
  type LocalKeyringState
} from "@living-atlas/local-keyring";
import { DEFAULT_TIERING_RULESET } from "@living-atlas/policy";
import { encryptEscalatedCloudUnlockObject } from "@living-atlas/cloudflare-worker/cloud-unlock-escalated";
import { runTierCoverage, scanBodyForExposure } from "./local-tier-coverage";
import type { TieringOptions } from "./local-tiering";
import type { GraphObjectEnvelope } from "@living-atlas/contracts";

const authorityId = "la_authority_tiercov0001";
const timestamp = "2026-07-04T00:00:00.000Z";

function sessionKey(): string {
  return Buffer.from(new Uint8Array(Array.from({ length: 32 }, (_, i) => (i * 5 + 1) % 256))).toString("base64");
}

function escalationKeyMaterial(): string {
  return Buffer.from(new Uint8Array(Array.from({ length: 32 }, (_, i) => (i * 13 + 7) % 256))).toString("base64");
}

async function localObject(keyring: LocalKeyringState, objectId: string, data: Record<string, unknown>): Promise<GraphObjectEnvelope> {
  const key = keyring.keys.find((k) => k.access_class === "local-private")!;
  return encryptPlaintextGraphObjectDraft(
    {
      schema_version: 1,
      authority_id: authorityId,
      object_id: objectId,
      object_type: "block",
      version: 1,
      access_class: "local-private",
      encryption_class: "client-encrypted",
      created_at: timestamp,
      updated_at: timestamp,
      content_hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      key_ref: key.key_id,
      visible_metadata: { tombstone: false, remote_indexable: false },
      payload: { kind: "plaintext-json", data }
    },
    keyring
  );
}

async function fixture(): Promise<{ objects: GraphObjectEnvelope[]; options: TieringOptions }> {
  const keyring = createDefaultLocalKeyring({ authorityId, createdAt: timestamp });
  const objects = [
    await localObject(keyring, "la_object_public0001", { text: "public roadmap" }),
    await localObject(keyring, "la_object_public0002", { text: "conference talk notes" }),
    await localObject(keyring, "la_object_immig0001", { text: "visa immigration case" }),
    await localObject(keyring, "la_object_health0001", { text: "medical diagnosis" })
  ];
  return {
    objects,
    options: {
      keyring,
      ruleset: DEFAULT_TIERING_RULESET,
      unlockKey: sessionKey(),
      escalationKey: escalationKeyMaterial()
    }
  };
}

describe("runTierCoverage", () => {
  it("proves every cloud-unlockable object decrypts under the session key and every super-sensitive stays local-only", async () => {
    const { objects, options } = await fixture();
    const result = await runTierCoverage(objects, options);
    expect(result.cloud_unlockable_objects).toBe(2);
    expect(result.super_sensitive_objects).toBe(2);
    expect(result.cloud_unlock_roundtrip_ok).toBe(2);
    expect(result.cloud_unlock_roundtrip_failed).toBe(0);
    expect(result.super_sensitive_in_cloud_unlock_class).toBe(0);
    expect(result.complete).toBe(true);
  });

  it("FAILS the gate when a super-sensitive object is already in the cloud-unlock class (accidental exposure)", async () => {
    const { objects, options } = await fixture();
    // Simulate an accidental exposure: mark a super-sensitive object as cloud-unlock-v1.
    const immig = objects.find((o) => o.object_id === "la_object_immig0001")!;
    if (immig.payload.kind !== "ciphertext-inline") throw new Error("bad fixture");
    const exposed: GraphObjectEnvelope = {
      ...immig,
      payload: { ...immig.payload, algorithm: "AES-GCM-256+cloud-unlock-v1" }
    };
    const tampered = objects.map((o) => (o.object_id === "la_object_immig0001" ? exposed : o));

    const result = await runTierCoverage(tampered, options);
    expect(result.super_sensitive_in_cloud_unlock_class).toBeGreaterThanOrEqual(1);
    expect(result.complete).toBe(false);
  });

  it("requires an unlock key to run the round-trip proof", async () => {
    const { objects, options } = await fixture();
    await expect(runTierCoverage(objects, { ...options, unlockKey: undefined })).rejects.toThrow(/unlock/i);
  });

  // DEF-2: the coverage gate must NOT rely solely on the same classifier it is
  // meant to guard. An INDEPENDENT full-body backstop decrypts EVERY
  // cloud-unlockable object and greps its full plaintext for high-signal ruleset
  // terms; any hit is a classifier false negative and fails the gate.
  it("scans 100% of cloud-unlockable objects with the independent backstop", async () => {
    const { objects, options } = await fixture();
    const result = await runTierCoverage(objects, options);
    // Both public objects are cloud-unlockable and clean.
    expect(result.exposure_backstop_scanned).toBe(result.cloud_unlockable_objects);
    expect(result.exposure_backstop_hits).toBe(0);
    expect(result.complete).toBe(true);
  });

  it("FAILS the gate when a cloud-unlockable object's full body hides a high-signal term the classifier missed", async () => {
    const keyring = createDefaultLocalKeyring({ authorityId, createdAt: timestamp });
    // This object's sensitive signal is buried in a field shape that (in a
    // regressed classifier) would be ignored, but its full plaintext body still
    // contains "immigration" — the independent backstop must catch it even
    // though the classifier cleared it as cloud-unlockable.
    const sneaky = await localObject(keyring, "la_object_sneaky0001", {
      unusual_field: "confidential immigration matter"
    });
    const options: TieringOptions & { sampleLimit?: number } = {
      keyring,
      ruleset: DEFAULT_TIERING_RULESET,
      unlockKey: sessionKey(),
      escalationKey: escalationKeyMaterial()
    };

    const result = await runTierCoverage([sneaky], {
      ...options,
      // Force the object to be treated as cloud-unlockable regardless of the
      // classifier, so the test isolates the independent backstop.
      classifierOverride: () => "cloud-unlockable"
    });

    expect(result.cloud_unlockable_objects).toBe(1);
    expect(result.exposure_backstop_scanned).toBe(1);
    expect(result.exposure_backstop_hits).toBeGreaterThanOrEqual(1);
    expect(result.exposure_backstop_hit_objects).toContain("la_object_sneaky0001");
    expect(result.complete).toBe(false);
  });
});

describe("runTierCoverage — two-key escalation invariants", () => {
  it("proves every escalated object decrypts under the ESCALATION key and REFUSES without it", async () => {
    const { objects, options } = await fixture();
    const result = await runTierCoverage(objects, options);

    // Two super-sensitive objects route to the escalated tier.
    expect(result.escalated_objects).toBe(2);
    expect(result.escalation_roundtrip_ok).toBe(result.sampled_escalated);
    expect(result.escalation_roundtrip_failed).toBe(0);
    // The escalation GATE fires: each sampled escalated object refuses to decrypt
    // when the escalation key is withheld.
    expect(result.escalation_gate_refusals_ok).toBe(result.sampled_escalated);
    expect(result.escalation_gate_refusals_failed).toBe(0);

    // No object is stuck host-blind: every live object is cloud-decryptable in SOME tier.
    expect(result.host_blind_stuck_objects).toBe(0);
    expect(result.every_object_cloud_decryptable).toBe(true);
    expect(result.complete).toBe(true);
  });

  it("requires an escalation key to run the escalated round-trip proof", async () => {
    const { objects, options } = await fixture();
    await expect(runTierCoverage(objects, { ...options, escalationKey: undefined })).rejects.toThrow(/escalation key/i);
  });

  it("FAILS the gate if an escalated object cannot be reopened with the CONFIGURED escalation key (would strand it host-blind)", async () => {
    const { options } = await fixture();
    // Seed an object already sealed in the escalated class under a DIFFERENT
    // escalation key than the one the gate is configured with. Its escalated
    // round-trip under the configured key must fail — that would strand it.
    const sealedUnderOtherKey = await encryptEscalatedCloudUnlockObject({
      envelope: {
        schema_version: 1,
        authority_id: authorityId,
        object_id: "la_object_wrongesc0001",
        object_type: "block",
        version: 1,
        access_class: "local-private",
        encryption_class: "client-encrypted",
        created_at: timestamp,
        updated_at: timestamp,
        key_ref: "la_key_wrongesc0001",
        visible_metadata: { tombstone: false, remote_indexable: false }
      },
      plaintext: { text: "sealed under a key the gate does not hold" },
      encodedEscalationKey: Buffer.from(new Uint8Array(Array.from({ length: 32 }, (_, i) => (i + 200) % 256))).toString("base64")
    });

    const result = await runTierCoverage([sealedUnderOtherKey], {
      ...options,
      // Force it into the escalated proof path regardless of classifier.
      classifierOverride: () => "super-sensitive"
    });
    expect(result.escalation_roundtrip_failed).toBeGreaterThanOrEqual(1);
    expect(result.complete).toBe(false);
  });
});

describe("scanBodyForExposure (independent backstop matcher)", () => {
  it("matches high-signal terms and their bounded inflections in the full body", () => {
    expect(scanBodyForExposure({ note: "mother was hospitalized" })).toContain("hospital");
    expect(scanBodyForExposure({ note: "national security clearances" })).toContain("security clearance");
    expect(scanBodyForExposure({ note: "they got green cards" })).toContain("green card");
    expect(scanBodyForExposure({ deep: { nested: { x: "visa timeline" } } })).toContain("visa");
  });

  it("does NOT flag unrelated longer tokens (safe over-inclusion boundary)", () => {
    // "VisaSQ" (an expert network) and "hospitality" must not count as exposures.
    expect(scanBodyForExposure({ vendor: "coleman/visasq expert network" })).not.toContain("visa");
    expect(scanBodyForExposure({ track: "cybersecurity hospitality" })).not.toContain("hospital");
  });

  it("returns no hits for a clean body", () => {
    expect(scanBodyForExposure({ text: "public product roadmap notes" })).toEqual([]);
  });
});
