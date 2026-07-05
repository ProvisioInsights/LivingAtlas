import {
  PlaintextJsonPayloadSchema,
  type GraphObjectEnvelope
} from "@living-atlas/contracts";

/**
 * ESCALATED cloud-unlock crypto — the SECOND tier of the two-key escalation
 * model.
 *
 * Objects classified SUPER-SENSITIVE are sealed to
 * "AES-GCM-256+cloud-unlock-escalated-v1" under a DISTINCT escalation key
 * (separate from the primary per-request cloud-unlock session key). They live on
 * Cloudflare as ciphertext exactly like normal objects, but are only
 * cloud-decryptable after an ESCALATION: the caller must present the second
 * escalation key. This mirrors {@link ../cloud-unlock} exactly — fresh 12-byte
 * nonce, AAD identity binding, non-extractable derived key, key never in output
 * — with two isolation guarantees layered on top:
 *
 *   1. ALGORITHM CLASS isolation: an escalated object carries a distinct
 *      algorithm literal, so the primary decrypt path returns
 *      "unsupported-algorithm" and never attempts to open it (and vice-versa).
 *
 *   2. AAD DOMAIN SEPARATION: the escalated AAD prefix differs from the primary
 *      AAD prefix, so even if identical key material were (mis)used across the
 *      two tiers, an escalated ciphertext cannot be authenticated by the primary
 *      primitive. Tier isolation therefore does not rely on the keys differing —
 *      though in practice they always do.
 */
export const CloudUnlockEscalatedObjectAlgorithm = "AES-GCM-256+cloud-unlock-escalated-v1";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export type EscalatedCloudUnlockDecryptResult =
  | {
      ok: true;
      plaintext: {
        kind: "plaintext-json";
        data: Record<string, unknown>;
      };
    }
  | {
      ok: false;
      reason: "invalid-escalation-key" | "unsupported-payload" | "unsupported-algorithm" | "decrypt-failed";
    };

function bufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

async function sha256Hex(value: string): Promise<`sha256:${string}`> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(value));
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
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

/**
 * Escalated AAD binding. Identical field set to the primary cloud-unlock AAD but
 * with a DISTINCT domain-separation prefix ("...escalated-object-payload:v1"),
 * so the two tiers are cryptographically isolated even under identical key
 * material.
 */
function escalatedObjectAdditionalData(object: GraphObjectEnvelope): Uint8Array {
  return textEncoder.encode([
    "living-atlas-cloud-unlock-escalated-object-payload:v1",
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

async function importAesKey(rawKey: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    bufferSource(rawKey),
    { name: "AES-GCM", length: 256 },
    false,
    usages
  );
}

export type EscalatedCloudUnlockEncryptInput = {
  /**
   * The graph object identity without a content_hash or payload. The AAD binds
   * to this identity, so it must be the final identity the object will carry
   * once persisted.
   */
  envelope: Omit<GraphObjectEnvelope, "content_hash" | "payload">;
  /** The cleartext record to seal. Wrapped as a plaintext-json payload. */
  plaintext: Record<string, unknown>;
  /** Base64 (std or url-safe) encoded 32-byte ESCALATION key (distinct from the primary session key). */
  encodedEscalationKey: string;
};

/**
 * Escalated cloud-unlock ENCRYPT primitive — the inverse of
 * {@link decryptEscalatedCloudUnlockObject}. Seals `plaintext` under the
 * escalation key with AES-GCM-256, a fresh 12-byte nonce, and the escalated AAD
 * binding. The escalation key is used only to derive a non-extractable CryptoKey
 * and is never written into the returned object (leak-custody invariant).
 *
 * The returned envelope carries algorithm
 * "AES-GCM-256+cloud-unlock-escalated-v1" and is therefore only
 * cloud-decryptable after an escalation with the second key — the SUPER-SENSITIVE
 * tier.
 */
export async function encryptEscalatedCloudUnlockObject(
  input: EscalatedCloudUnlockEncryptInput
): Promise<GraphObjectEnvelope> {
  const rawKey = fromBase64(input.encodedEscalationKey);
  if (!rawKey || rawKey.byteLength !== 32) {
    throw new Error("invalid escalation key: expected 32 raw bytes (base64)");
  }

  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const draftForAad: GraphObjectEnvelope = {
    ...input.envelope,
    content_hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    payload: {
      kind: "ciphertext-inline",
      ciphertext: "pending",
      nonce: toBase64(nonce),
      algorithm: CloudUnlockEscalatedObjectAlgorithm
    }
  };

  const cryptoKey = await importAesKey(rawKey, ["encrypt"]);
  const sealed = new Uint8Array(await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: bufferSource(nonce),
      additionalData: bufferSource(escalatedObjectAdditionalData(draftForAad))
    },
    cryptoKey,
    bufferSource(textEncoder.encode(JSON.stringify({
      kind: "plaintext-json",
      data: input.plaintext
    })))
  ));
  const ciphertextBase64 = toBase64(sealed);

  return {
    ...input.envelope,
    content_hash: await sha256Hex(ciphertextBase64),
    payload: {
      kind: "ciphertext-inline",
      ciphertext: ciphertextBase64,
      nonce: toBase64(nonce),
      algorithm: CloudUnlockEscalatedObjectAlgorithm
    }
  };
}

export async function decryptEscalatedCloudUnlockObject(
  object: GraphObjectEnvelope,
  encodedEscalationKey: string
): Promise<EscalatedCloudUnlockDecryptResult> {
  if (object.payload.kind !== "ciphertext-inline") {
    return { ok: false, reason: "unsupported-payload" };
  }

  if (object.payload.algorithm !== CloudUnlockEscalatedObjectAlgorithm) {
    return { ok: false, reason: "unsupported-algorithm" };
  }

  const rawKey = fromBase64(encodedEscalationKey);
  const nonce = fromBase64(object.payload.nonce);
  const ciphertext = fromBase64(object.payload.ciphertext);
  if (!rawKey || rawKey.byteLength !== 32 || !nonce || nonce.byteLength !== 12 || !ciphertext) {
    return { ok: false, reason: "invalid-escalation-key" };
  }

  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: bufferSource(nonce),
        additionalData: bufferSource(escalatedObjectAdditionalData(object))
      },
      await importAesKey(rawKey, ["decrypt"]),
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
