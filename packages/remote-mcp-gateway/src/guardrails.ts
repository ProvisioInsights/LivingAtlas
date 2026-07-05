export type T2AuditEvent = {
  event_type: "object.decrypt";
  outcome: "allowed";
  capability_id: string;
  authority_id: string;
  object_id: string;
  recorded_at: string;
  tier: "super-sensitive";
};
export type T2Alert = { authority_id: string; object_id: string; capability_id: string; at: string };

export type GuardrailSinks = {
  appendAudit: (event: T2AuditEvent) => Promise<void>;
  alert: (alert: T2Alert) => Promise<void>;
};

export async function recordT2Decrypt(
  sinks: GuardrailSinks,
  ctx: { capability_id: string; authority_id: string; object_id: string; at_iso: string }
): Promise<void> {
  await sinks.appendAudit({
    event_type: "object.decrypt",
    outcome: "allowed",
    capability_id: ctx.capability_id,
    authority_id: ctx.authority_id,
    object_id: ctx.object_id,
    recorded_at: ctx.at_iso,
    tier: "super-sensitive"
  });
  await sinks.alert({
    authority_id: ctx.authority_id,
    object_id: ctx.object_id,
    capability_id: ctx.capability_id,
    at: ctx.at_iso
  });
}

export function parseRevocationSet(json: string | undefined): Set<string> {
  if (!json) return new Set();
  try {
    const parsed = JSON.parse(json);
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}
export function isRevoked(revoked: Set<string>, capabilityId: string): boolean {
  return revoked.has(capabilityId);
}
export function assertNotRevoked(revoked: Set<string>, capabilityId: string): void {
  if (revoked.has(capabilityId)) throw new Error("kill-switch-revoked");
}
