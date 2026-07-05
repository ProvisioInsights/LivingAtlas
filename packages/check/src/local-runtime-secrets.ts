import { resolveLocalSecret, type KeychainReader } from "@living-atlas/local-keyring";

/**
 * Runtime secret resolution and env-file serialization for the local replica.
 *
 * Secrets may live in three places, in priority order:
 * 1. Direct environment variables (including *_KEYCHAIN_SERVICE indirection).
 * 2. The replica's local-runtime.env file, either as a *_KEYCHAIN_SERVICE
 *    reference (preferred) or as legacy cleartext.
 * 3. Freshly generated values on first bootstrap.
 *
 * Serialization preserves the source: keychain-backed secrets are written
 * back as *_KEYCHAIN_SERVICE references only, so a migrated env file never
 * re-materializes cleartext passphrases on subsequent daemon cycles.
 */

const secretEnvNames = {
  controlPassphrase: "LIVING_ATLAS_LOCAL_CONTROL_STORE_PASSPHRASE",
  keyringPassphrase: "LIVING_ATLAS_LOCAL_KEYRING_PASSPHRASE",
  localMcpToken: "LIVING_ATLAS_LOCAL_MCP_TOKEN"
} as const;

const generateLabels = {
  controlPassphrase: "control",
  keyringPassphrase: "keyring",
  localMcpToken: "mcp"
} as const;

export type RuntimeSecretName = keyof typeof secretEnvNames;

export type ResolvedRuntimeSecret = {
  value: string;
  source: "env" | "keychain" | "file" | "generated";
  keychainService?: string;
};

export type RuntimeSecretSet = Record<RuntimeSecretName, ResolvedRuntimeSecret>;

export type RuntimeEnvPaths = {
  rootDir: string;
  controlStorePath: string;
  keyringPath: string;
  graphDir: string;
  outboxDir: string;
  activityLogPath: string;
};

type ParsedRuntimeEnvFile = {
  cleartext: Partial<Record<RuntimeSecretName, string>>;
  keychainServices: Partial<Record<RuntimeSecretName, string>>;
};

function parseEnvLineValue(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.startsWith("\"") && trimmed.endsWith("\"") ? (JSON.parse(trimmed) as string) : trimmed;
}

export function parseRuntimeEnvFile(text: string): ParsedRuntimeEnvFile {
  const parsed: ParsedRuntimeEnvFile = { cleartext: {}, keychainServices: {} };
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!match) {
      continue;
    }
    for (const name of Object.keys(secretEnvNames) as RuntimeSecretName[]) {
      if (match[1] === secretEnvNames[name]) {
        parsed.cleartext[name] = parseEnvLineValue(match[2] ?? "");
      }
      if (match[1] === `${secretEnvNames[name]}_KEYCHAIN_SERVICE`) {
        parsed.keychainServices[name] = parseEnvLineValue(match[2] ?? "");
      }
    }
  }
  return parsed;
}

export type ResolveRuntimeSecretsOptions = {
  envFileText?: string;
  env?: Record<string, string | undefined>;
  keychainReader?: KeychainReader;
  generate: (label: string) => string;
};

export function resolveRuntimeSecrets(options: ResolveRuntimeSecretsOptions): RuntimeSecretSet {
  const env = options.env ?? process.env;
  const fromFile = options.envFileText ? parseRuntimeEnvFile(options.envFileText) : { cleartext: {}, keychainServices: {} };

  const resolveOne = (name: RuntimeSecretName): ResolvedRuntimeSecret => {
    const envName = secretEnvNames[name];

    const direct = resolveLocalSecret(envName, { env, keychainReader: options.keychainReader });
    if (direct) {
      return direct.source === "keychain"
        ? { value: direct.value, source: "keychain", keychainService: env[`${envName}_KEYCHAIN_SERVICE`]?.trim() }
        : { value: direct.value, source: "env" };
    }

    const fileService = fromFile.keychainServices[name]?.trim();
    if (fileService) {
      const resolved = resolveLocalSecret(envName, {
        env: { [`${envName}_KEYCHAIN_SERVICE`]: fileService },
        keychainReader: options.keychainReader
      });
      if (!resolved) {
        throw new Error(`secret ${envName} keychain service ${fileService} did not resolve`);
      }
      return { value: resolved.value, source: "keychain", keychainService: fileService };
    }

    const fileValue = fromFile.cleartext[name]?.trim();
    if (fileValue) {
      return { value: fileValue, source: "file" };
    }

    return { value: options.generate(generateLabels[name]), source: "generated" };
  };

  return {
    controlPassphrase: resolveOne("controlPassphrase"),
    keyringPassphrase: resolveOne("keyringPassphrase"),
    localMcpToken: resolveOne("localMcpToken")
  };
}

function secretLines(name: RuntimeSecretName, secret: ResolvedRuntimeSecret): string[] {
  const envName = secretEnvNames[name];
  if (secret.source === "keychain") {
    if (!secret.keychainService) {
      throw new Error(`keychain-sourced secret ${envName} is missing its keychain service name`);
    }
    return [`${envName}_KEYCHAIN_SERVICE=${JSON.stringify(secret.keychainService)}`];
  }
  return [`${envName}=${JSON.stringify(secret.value)}`];
}

export function serializeRuntimeEnvFile(options: { paths: RuntimeEnvPaths; secrets: RuntimeSecretSet }): string {
  const { paths, secrets } = options;
  return [
    "# Local LivingAtlas runtime secrets. Do not commit.",
    `LIVING_ATLAS_LOCAL_REPLICA_DIR=${JSON.stringify(paths.rootDir)}`,
    `LIVING_ATLAS_LOCAL_CONTROL_STORE=${JSON.stringify(paths.controlStorePath)}`,
    ...secretLines("controlPassphrase", secrets.controlPassphrase),
    `LIVING_ATLAS_LOCAL_KEYRING=${JSON.stringify(paths.keyringPath)}`,
    ...secretLines("keyringPassphrase", secrets.keyringPassphrase),
    `LIVING_ATLAS_LOCAL_GRAPH_DIR=${JSON.stringify(paths.graphDir)}`,
    `LIVING_ATLAS_LOCAL_SYNC_OUTBOX_DIR=${JSON.stringify(paths.outboxDir)}`,
    ...secretLines("localMcpToken", secrets.localMcpToken),
    `LIVING_ATLAS_ACTIVITY_LOG=${JSON.stringify(paths.activityLogPath)}`,
    ""
  ].join("\n");
}
