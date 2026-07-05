export type Tier = "T1" | "T2";
export function currentKeyVersion(
  env: { T1_KEY_VERSION?: string; T2_KEY_VERSION?: string },
  tier: Tier
): string {
  const value = tier === "T1" ? env.T1_KEY_VERSION : env.T2_KEY_VERSION;
  if (!value) throw new Error(`missing key version for tier ${tier}`);
  return value;
}
export function selectStaleForRotation<T extends { key_version: string }>(
  objects: readonly T[],
  activeVersion: string,
  maxSweep: number
): T[] {
  return objects.filter((o) => o.key_version !== activeVersion).slice(0, maxSweep);
}
