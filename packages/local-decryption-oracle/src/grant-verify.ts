import { canonicalGrantString, type SignedEscalationGrant } from "@living-atlas/remote-crypto";

export interface NonceSeen {
  seenBefore(nonce: string): Promise<boolean>;
  remember(nonce: string, expiresAtMs: number): Promise<void>;
}

export class InMemoryNonceSeen implements NonceSeen {
  private seen = new Map<string, number>();
  async seenBefore(nonce: string): Promise<boolean> {
    return this.seen.has(nonce);
  }
  async remember(nonce: string, expiresAtMs: number): Promise<void> {
    this.seen.set(nonce, expiresAtMs);
  }
}

const encoder = new TextEncoder();
function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const norm = value.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(norm.padEnd(Math.ceil(norm.length / 4) * 4, "="));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  return fromBase64Url(value);
}
function toBufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

export type GrantVerifyResult =
  | { ok: true }
  | { ok: false; reason: "bad-signature" | "expired" | "replayed" };

export async function verifyEscalationGrant(
  signingKeyB64: string,
  grant: SignedEscalationGrant,
  ctx: { now_ms: number; seen: NonceSeen }
): Promise<GrantVerifyResult> {
  const key = await crypto.subtle.importKey(
    "raw",
    fromBase64(signingKeyB64),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const ok = await crypto.subtle.verify(
    "HMAC",
    key,
    fromBase64Url(grant.signature),
    toBufferSource(encoder.encode(canonicalGrantString(grant.payload)))
  );
  if (!ok) return { ok: false, reason: "bad-signature" };
  if (ctx.now_ms >= grant.payload.expires_at_ms) return { ok: false, reason: "expired" };
  if (await ctx.seen.seenBefore(grant.payload.nonce)) return { ok: false, reason: "replayed" };
  await ctx.seen.remember(grant.payload.nonce, grant.payload.expires_at_ms);
  return { ok: true };
}
