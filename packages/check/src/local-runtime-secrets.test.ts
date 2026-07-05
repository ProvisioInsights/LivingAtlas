import { describe, expect, it } from "vitest";

import { resolveRuntimeSecrets, serializeRuntimeEnvFile } from "./local-runtime-secrets";

const paths = {
  rootDir: "/tmp/atlas-test",
  controlStorePath: "/tmp/atlas-test/control-store.json",
  keyringPath: "/tmp/atlas-test/keyring.json",
  graphDir: "/tmp/atlas-test/graph",
  outboxDir: "/tmp/atlas-test/outbox",
  activityLogPath: "/tmp/atlas-test/activity.jsonl"
};

const generate = (label: string) => `la_${label}_generated`;

describe("resolveRuntimeSecrets", () => {
  it("keeps legacy cleartext env-file secrets working and re-serializes them unchanged", () => {
    const envFileText = [
      'LIVING_ATLAS_LOCAL_CONTROL_STORE_PASSPHRASE="la_control_legacy"',
      'LIVING_ATLAS_LOCAL_KEYRING_PASSPHRASE="la_keyring_legacy"',
      'LIVING_ATLAS_LOCAL_MCP_TOKEN="la_mcp_legacy"'
    ].join("\n");

    const secrets = resolveRuntimeSecrets({ envFileText, env: {}, generate });
    expect(secrets.keyringPassphrase).toEqual({ value: "la_keyring_legacy", source: "file" });

    const serialized = serializeRuntimeEnvFile({ paths, secrets });
    expect(serialized).toContain('LIVING_ATLAS_LOCAL_KEYRING_PASSPHRASE="la_keyring_legacy"');
  });

  it("resolves keychain-service env-file entries and never re-serializes cleartext", () => {
    const envFileText = [
      'LIVING_ATLAS_LOCAL_CONTROL_STORE_PASSPHRASE_KEYCHAIN_SERVICE="io.livingatlas.pp.control"',
      'LIVING_ATLAS_LOCAL_KEYRING_PASSPHRASE_KEYCHAIN_SERVICE="io.livingatlas.pp.keyring"',
      'LIVING_ATLAS_LOCAL_MCP_TOKEN_KEYCHAIN_SERVICE="io.livingatlas.pp.mcp"'
    ].join("\n");
    const vault: Record<string, string> = {
      "io.livingatlas.pp.control": "la_control_vaulted",
      "io.livingatlas.pp.keyring": "la_keyring_vaulted",
      "io.livingatlas.pp.mcp": "la_mcp_vaulted"
    };

    const secrets = resolveRuntimeSecrets({
      envFileText,
      env: {},
      generate,
      keychainReader: (service) => vault[service]
    });
    expect(secrets.keyringPassphrase).toEqual({
      value: "la_keyring_vaulted",
      source: "keychain",
      keychainService: "io.livingatlas.pp.keyring"
    });

    const serialized = serializeRuntimeEnvFile({ paths, secrets });
    expect(serialized).toContain('LIVING_ATLAS_LOCAL_KEYRING_PASSPHRASE_KEYCHAIN_SERVICE="io.livingatlas.pp.keyring"');
    expect(serialized).not.toContain("la_keyring_vaulted");
    expect(serialized).not.toContain("la_control_vaulted");
    expect(serialized).not.toContain("la_mcp_vaulted");
    expect(serialized).not.toMatch(/^LIVING_ATLAS_LOCAL_KEYRING_PASSPHRASE=/m);
  });

  it("prefers direct environment values over env-file entries", () => {
    const secrets = resolveRuntimeSecrets({
      envFileText: 'LIVING_ATLAS_LOCAL_KEYRING_PASSPHRASE="la_keyring_file"',
      env: { LIVING_ATLAS_LOCAL_KEYRING_PASSPHRASE: "la_keyring_env" },
      generate
    });
    expect(secrets.keyringPassphrase).toEqual({ value: "la_keyring_env", source: "env" });
  });

  it("generates fresh secrets when nothing is configured", () => {
    const secrets = resolveRuntimeSecrets({ env: {}, generate });
    expect(secrets.keyringPassphrase).toEqual({ value: "la_keyring_generated", source: "generated" });
    expect(secrets.controlPassphrase).toEqual({ value: "la_control_generated", source: "generated" });
    expect(secrets.localMcpToken).toEqual({ value: "la_mcp_generated", source: "generated" });
  });

  it("fails hard when an env-file keychain service has no stored secret", () => {
    expect(() =>
      resolveRuntimeSecrets({
        envFileText: 'LIVING_ATLAS_LOCAL_KEYRING_PASSPHRASE_KEYCHAIN_SERVICE="io.livingatlas.gone"',
        env: {},
        generate,
        keychainReader: () => undefined
      })
    ).toThrowError(/io\.livingatlas\.gone/);
  });
});
