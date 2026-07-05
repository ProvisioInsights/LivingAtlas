export type BackupRef = {
  backup_id: string;
  kind: "full" | "differential";
  created_at_ms: number;
  locked_until_ms: number; // Object-Lock retain-until; 0 if none
};

export type RetentionRule = { kind: "full" | "differential"; keepForMs: number };

/** Pure: returns ids eligible for deletion. Never returns an id whose
 *  Object-Lock window has not expired (WORM is the hard backstop). */
export function selectForDeletion(
  backups: BackupRef[],
  rules: RetentionRule[],
  nowMs: number,
): string[] {
  const keepFor = new Map(rules.map((r) => [r.kind, r.keepForMs]));
  const out: string[] = [];
  for (const b of backups) {
    if (b.locked_until_ms > nowMs) continue; // still immutable — never delete
    const window = keepFor.get(b.kind);
    if (window === undefined) continue; // unknown kind → keep, be safe
    if (nowMs - b.created_at_ms > window) out.push(b.backup_id);
  }
  return out;
}
