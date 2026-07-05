export const MAX_GRANT_TTL_SECONDS = 900;

export type EscalationGrantPayload = {
  v: 1;
  capability_id: string;
  authority_id: string;
  object_id: string;
  issued_at_ms: number;
  expires_at_ms: number;
  nonce: string;
};

export type SignedEscalationGrant = {
  payload: EscalationGrantPayload;
  signature: string; // base64url HMAC-SHA-256 over canonicalGrantString(payload)
};

export function canonicalGrantString(p: EscalationGrantPayload): string {
  return [
    "living-atlas-escalation-grant:v1",
    p.capability_id,
    p.authority_id,
    p.object_id,
    String(p.issued_at_ms),
    String(p.expires_at_ms),
    p.nonce
  ].join(":");
}
