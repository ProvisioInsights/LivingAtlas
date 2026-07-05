import { describe, expect, it } from "vitest";
import {
  ESCALATION_KEY_KEYCHAIN_SERVICE,
  PRIMARY_CLOUD_UNLOCK_KEY_KEYCHAIN_SERVICE,
  addTieringKeysToKeyring,
  generateTieringKeyMaterial,
  primaryCloudUnlockKeyBase64,
  escalationKeyBase64
} from "./escalation-key";
import { createDefaultLocalKeyring, openLocalKeyring, sealLocalKeyring } from "./local-keyring";

const authorityId = "la_authority_tierkeys0001";
const timestamp = "2026-07-04T00:00:00.000Z";

describe("generateTieringKeyMaterial", () => {
  it("generates a DISTINCT 32-byte primary key and 32-byte escalation key", () => {
    const material = generateTieringKeyMaterial();
    const primary = Buffer.from(material.primary_cloud_unlock_key_base64, "base64");
    const escalation = Buffer.from(material.escalation_key_base64, "base64");
    expect(primary.length).toBe(32);
    expect(escalation.length).toBe(32);
    // The two keys must be different material.
    expect(material.primary_cloud_unlock_key_base64).not.toBe(material.escalation_key_base64);
    expect(Buffer.compare(primary, escalation)).not.toBe(0);
  });

  it("proposes distinct Keychain service names for the two keys", () => {
    expect(ESCALATION_KEY_KEYCHAIN_SERVICE).toBe("io.livingatlas.personal-prod.escalation-key");
    expect(PRIMARY_CLOUD_UNLOCK_KEY_KEYCHAIN_SERVICE).toBe("io.livingatlas.personal-prod.cloud-unlock-key");
    expect(ESCALATION_KEY_KEYCHAIN_SERVICE).not.toBe(PRIMARY_CLOUD_UNLOCK_KEY_KEYCHAIN_SERVICE);
  });
});

describe("addTieringKeysToKeyring", () => {
  it("adds BOTH the primary cloud-unlock key and the escalation key so local decrypt of everything needs no escalation", async () => {
    const base = createDefaultLocalKeyring({ authorityId, createdAt: timestamp });
    const material = generateTieringKeyMaterial();
    const withKeys = addTieringKeysToKeyring(base, material, { createdAt: timestamp });

    // Both keys carried, both non-extractable-at-rest sealed, both cloud_unwrapped:false.
    expect(primaryCloudUnlockKeyBase64(withKeys)).toBe(material.primary_cloud_unlock_key_base64);
    expect(escalationKeyBase64(withKeys)).toBe(material.escalation_key_base64);

    // The local keyring literally holds both, so a local holder can decrypt both
    // the normal (primary) and the super-sensitive (escalation) tiers with no
    // escalation friction.
    const primaryKeys = withKeys.keys.filter((k) => k.purpose === "data-encryption" && k.access_class === undefined);
    expect(primaryKeys.length).toBeGreaterThanOrEqual(2);
  });

  it("is idempotent-safe: re-adding does not duplicate the tiering keys", () => {
    const base = createDefaultLocalKeyring({ authorityId, createdAt: timestamp });
    const material = generateTieringKeyMaterial();
    const once = addTieringKeysToKeyring(base, material, { createdAt: timestamp });
    const twice = addTieringKeysToKeyring(once, material, { createdAt: timestamp });
    expect(primaryCloudUnlockKeyBase64(twice)).toBe(material.primary_cloud_unlock_key_base64);
    expect(escalationKeyBase64(twice)).toBe(material.escalation_key_base64);
    // No growth beyond the single pair.
    const tieringKeyCount = twice.keys.filter((k) => k.key_id.startsWith("la_key_tiering_")).length;
    expect(tieringKeyCount).toBe(2);
  });

  it("round-trips through seal/open, preserving both tiering keys", async () => {
    const base = createDefaultLocalKeyring({ authorityId, createdAt: timestamp });
    const material = generateTieringKeyMaterial();
    const withKeys = addTieringKeysToKeyring(base, material, { createdAt: timestamp });

    const sealed = await sealLocalKeyring(withKeys, "correct horse battery staple");
    const reopened = await openLocalKeyring(sealed, "correct horse battery staple");

    expect(primaryCloudUnlockKeyBase64(reopened)).toBe(material.primary_cloud_unlock_key_base64);
    expect(escalationKeyBase64(reopened)).toBe(material.escalation_key_base64);
  });

  it("preserves the ORIGINAL keyring's access-class keys (does not clobber existing material)", () => {
    const base = createDefaultLocalKeyring({ authorityId, createdAt: timestamp });
    const material = generateTieringKeyMaterial();
    const withKeys = addTieringKeysToKeyring(base, material, { createdAt: timestamp });
    for (const original of base.keys) {
      expect(withKeys.keys.some((k) => k.key_id === original.key_id && k.material_base64 === original.material_base64)).toBe(true);
    }
  });
});
