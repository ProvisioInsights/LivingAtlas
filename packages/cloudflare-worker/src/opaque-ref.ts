const textEncoder = new TextEncoder();
const DefaultPersistenceRefKey = "living-atlas-cloudflare-persistence-opaque-ref:v1";

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(value));
  return toHex(new Uint8Array(digest));
}

async function hmacSha256Hex(scope: string, value: string, keySeed = DefaultPersistenceRefKey): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(keySeed),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, textEncoder.encode(`${scope}:${value}`));
  return toHex(new Uint8Array(signature));
}

export async function opaquePersistenceHash(scope: string, value: string, keySeed?: string): Promise<`sha256:${string}`> {
  return `sha256:${await hmacSha256Hex(scope, value, keySeed)}`;
}

export async function opaquePersistenceRef(scope: string, value: string, keySeed?: string): Promise<`sha256:${string}`> {
  return opaquePersistenceHash(`ref:${scope}`, value, keySeed);
}
