import {
  MAX_GRANT_TTL_SECONDS,
  canonicalGrantString,
  type EscalationGrantPayload,
  type SignedEscalationGrant
} from "@living-atlas/remote-crypto";

const encoder = new TextEncoder();

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const norm = value.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(norm.padEnd(Math.ceil(norm.length / 4) * 4, "="));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function toBufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}
function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function hmacKey(rawKeyB64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    fromBase64(rawKeyB64),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

export type SignGrantInput = {
  capability_id: string;
  authority_id: string;
  object_id: string;
  issued_at_ms: number;
  ttl_seconds: number;
  nonce: string;
};

export async function signEscalationGrant(
  signingKeyB64: string,
  input: SignGrantInput
): Promise<SignedEscalationGrant> {
  if (input.ttl_seconds > MAX_GRANT_TTL_SECONDS || input.ttl_seconds <= 0) {
    throw new Error(`escalation grant ttl must be 1..${MAX_GRANT_TTL_SECONDS} seconds`);
  }
  const payload: EscalationGrantPayload = {
    v: 1,
    capability_id: input.capability_id,
    authority_id: input.authority_id,
    object_id: input.object_id,
    issued_at_ms: input.issued_at_ms,
    expires_at_ms: input.issued_at_ms + input.ttl_seconds * 1000,
    nonce: input.nonce
  };
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      await hmacKey(signingKeyB64),
      toBufferSource(encoder.encode(canonicalGrantString(payload)))
    )
  );
  return { payload, signature: toBase64Url(sig) };
}
