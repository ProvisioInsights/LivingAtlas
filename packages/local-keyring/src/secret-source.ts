import { execFileSync } from "node:child_process";

/**
 * Local secret resolution for keyholding-boundary secrets (keyring and
 * control-store passphrases, local tokens).
 *
 * Resolution order for a secret named NAME:
 * 1. Direct environment variable NAME (legacy/dev path, always wins).
 * 2. If NAME_KEYCHAIN_SERVICE is set, the macOS login keychain generic
 *    password stored under that service name.
 *
 * A configured keychain service with no stored secret is a hard error rather
 * than a silent fall-through: callers such as the local sync daemon would
 * otherwise regenerate random passphrases and lock themselves out of the
 * existing sealed stores.
 */

export type KeychainReader = (service: string) => string | undefined;

export type ResolvedLocalSecret = {
  value: string;
  source: "env" | "keychain";
};

export type ResolveLocalSecretOptions = {
  env?: Record<string, string | undefined>;
  keychainReader?: KeychainReader;
};

export const keychainServiceSuffix = "_KEYCHAIN_SERVICE";

export function readMacosKeychainSecret(service: string): string | undefined {
  if (process.platform !== "darwin") {
    return undefined;
  }

  try {
    return execFileSync("/usr/bin/security", ["find-generic-password", "-s", service, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch {
    return undefined;
  }
}

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveLocalSecret(
  name: string,
  options: ResolveLocalSecretOptions = {}
): ResolvedLocalSecret | undefined {
  const env = options.env ?? process.env;

  const direct = nonBlank(env[name]);
  if (direct) {
    return { value: direct, source: "env" };
  }

  const service = nonBlank(env[`${name}${keychainServiceSuffix}`]);
  if (!service) {
    return undefined;
  }

  const reader = options.keychainReader ?? readMacosKeychainSecret;
  const secret = nonBlank(reader(service));
  if (!secret) {
    throw new Error(
      `secret ${name} is configured to use keychain service ${service}, but no keychain entry was found`
    );
  }

  return { value: secret, source: "keychain" };
}
