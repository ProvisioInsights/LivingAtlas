import {
  PlaintextJsonPayloadSchema,
  type GraphObjectEnvelope
} from "@living-atlas/contracts";

export const CloudUnlockObjectAlgorithm = "AES-GCM-256+cloud-unlock-v1";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export type CloudUnlockDecryptResult =
  | {
      ok: true;
      plaintext: {
        kind: "plaintext-json";
        data: Record<string, unknown>;
      };
    }
  | {
      ok: false;
      reason: "invalid-unlock-key" | "unsupported-payload" | "unsupported-algorithm" | "decrypt-failed";
    };

function bufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function fromBase64(value: string): Uint8Array | undefined {
  const normalized = value
    .trim()
    .replace(/^base64:/, "")
    .replace(/^base64url:/, "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(padded)) {
    return undefined;
  }

  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return undefined;
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function objectAdditionalData(object: GraphObjectEnvelope): Uint8Array {
  return textEncoder.encode([
    "living-atlas-cloud-unlock-object-payload:v1",
    object.authority_id,
    object.object_id,
    object.object_type,
    String(object.version),
    object.access_class,
    object.encryption_class,
    object.key_ref ?? "",
    object.created_at,
    object.updated_at,
    stableJson(object.visible_metadata)
  ].join(":"));
}

async function importAesKey(rawKey: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    bufferSource(rawKey),
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );
}

export async function decryptCloudUnlockObject(
  object: GraphObjectEnvelope,
  encodedUnlockKey: string
): Promise<CloudUnlockDecryptResult> {
  if (object.payload.kind !== "ciphertext-inline") {
    return { ok: false, reason: "unsupported-payload" };
  }

  if (object.payload.algorithm !== CloudUnlockObjectAlgorithm) {
    return { ok: false, reason: "unsupported-algorithm" };
  }

  const rawKey = fromBase64(encodedUnlockKey);
  const nonce = fromBase64(object.payload.nonce);
  const ciphertext = fromBase64(object.payload.ciphertext);
  if (!rawKey || rawKey.byteLength !== 32 || !nonce || nonce.byteLength !== 12 || !ciphertext) {
    return { ok: false, reason: "invalid-unlock-key" };
  }

  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: bufferSource(nonce),
        additionalData: bufferSource(objectAdditionalData(object))
      },
      await importAesKey(rawKey),
      bufferSource(ciphertext)
    );

    return {
      ok: true,
      plaintext: PlaintextJsonPayloadSchema.parse(JSON.parse(textDecoder.decode(plaintext)))
    };
  } catch {
    return { ok: false, reason: "decrypt-failed" };
  }
}
