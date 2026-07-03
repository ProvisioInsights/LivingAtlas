import { describe, expect, it } from "vitest";

import { resolveLocalSecret } from "./secret-source";

describe("resolveLocalSecret", () => {
  it("returns the direct environment value when set", () => {
    const resolved = resolveLocalSecret("LIVING_ATLAS_LOCAL_KEYRING_PASSPHRASE", {
      env: { LIVING_ATLAS_LOCAL_KEYRING_PASSPHRASE: "la_keyring_direct" },
      keychainReader: () => {
        throw new Error("keychain must not be consulted when env value exists");
      }
    });
    expect(resolved).toEqual({ value: "la_keyring_direct", source: "env" });
  });

  it("prefers the direct environment value over a configured keychain service", () => {
    const resolved = resolveLocalSecret("LIVING_ATLAS_LOCAL_KEYRING_PASSPHRASE", {
      env: {
        LIVING_ATLAS_LOCAL_KEYRING_PASSPHRASE: "la_keyring_direct",
        LIVING_ATLAS_LOCAL_KEYRING_PASSPHRASE_KEYCHAIN_SERVICE: "io.livingatlas.test"
      },
      keychainReader: () => "la_keyring_from_keychain"
    });
    expect(resolved).toEqual({ value: "la_keyring_direct", source: "env" });
  });

  it("resolves through the keychain service and trims trailing newlines", () => {
    const services: string[] = [];
    const resolved = resolveLocalSecret("LIVING_ATLAS_LOCAL_KEYRING_PASSPHRASE", {
      env: { LIVING_ATLAS_LOCAL_KEYRING_PASSPHRASE_KEYCHAIN_SERVICE: "io.livingatlas.personal-prod.keyring" },
      keychainReader: (service) => {
        services.push(service);
        return "la_keyring_from_keychain\n";
      }
    });
    expect(services).toEqual(["io.livingatlas.personal-prod.keyring"]);
    expect(resolved).toEqual({ value: "la_keyring_from_keychain", source: "keychain" });
  });

  it("ignores blank environment values and falls through to the keychain", () => {
    const resolved = resolveLocalSecret("LIVING_ATLAS_LOCAL_KEYRING_PASSPHRASE", {
      env: {
        LIVING_ATLAS_LOCAL_KEYRING_PASSPHRASE: "   ",
        LIVING_ATLAS_LOCAL_KEYRING_PASSPHRASE_KEYCHAIN_SERVICE: "io.livingatlas.test"
      },
      keychainReader: () => "la_keyring_from_keychain"
    });
    expect(resolved).toEqual({ value: "la_keyring_from_keychain", source: "keychain" });
  });

  it("throws when a keychain service is configured but the secret is missing", () => {
    expect(() =>
      resolveLocalSecret("LIVING_ATLAS_LOCAL_KEYRING_PASSPHRASE", {
        env: { LIVING_ATLAS_LOCAL_KEYRING_PASSPHRASE_KEYCHAIN_SERVICE: "io.livingatlas.missing" },
        keychainReader: () => undefined
      })
    ).toThrowError(/io\.livingatlas\.missing/);
  });

  it("never includes secret material in the missing-secret error", () => {
    try {
      resolveLocalSecret("LIVING_ATLAS_LOCAL_KEYRING_PASSPHRASE", {
        env: { LIVING_ATLAS_LOCAL_KEYRING_PASSPHRASE_KEYCHAIN_SERVICE: "io.livingatlas.missing" },
        keychainReader: () => undefined
      });
      expect.unreachable("resolveLocalSecret should have thrown");
    } catch (error) {
      expect(String(error)).not.toMatch(/PASSPHRASE=/);
    }
  });

  it("returns undefined when neither env value nor keychain service is configured", () => {
    expect(resolveLocalSecret("LIVING_ATLAS_LOCAL_KEYRING_PASSPHRASE", { env: {} })).toBeUndefined();
  });
});
