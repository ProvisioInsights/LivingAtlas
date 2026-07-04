import { describe, expect, it, vi } from "vitest";
import { writeBackup } from "./writer";
import type { ImmutableStore } from "./immutable-store";

function fakeStore(): ImmutableStore & { puts: string[] } {
  const puts: string[] = [];
  return {
    puts,
    now: () => 1_000,
    async put(key) { puts.push(key); },
    async get() { return Buffer.alloc(0); },
    async remove() {},
  };
}

const input = {
  authority_id: "la_authority_test0001",
  kind: "full" as const,
  base_generation: 0,
  target_generation: 5,
  artifactBytes: Buffer.from("sealed-snapshot"),
  escrowEnvelopeJson: JSON.stringify({ algorithm: "AES-256-GCM+recovery-master-v1" }),
  createdAtIso: "2026-07-04T00:00:00.000Z",
  backupId: "la_backup_000001",
  retainUntilMs: 2_000,
};

describe("writeBackup", () => {
  it("writes artifact+escrow+manifest to every store and reports durable", async () => {
    const a = fakeStore();
    const b = fakeStore();
    const res = await writeBackup([a, b], input);
    expect(res.durable).toBe(true);
    for (const s of [a, b]) {
      expect(s.puts).toEqual(expect.arrayContaining([
        "la_backup_000001/snapshot.enc",
        "la_backup_000001/keyring.escrow.json",
        "la_backup_000001/manifest.json",
      ]));
    }
  });

  it("reports NOT durable if any store fails, and surfaces the error", async () => {
    const ok = fakeStore();
    const bad = fakeStore();
    bad.put = vi.fn().mockRejectedValue(new Error("provider down"));
    const res = await writeBackup([ok, bad], input);
    expect(res.durable).toBe(false);
    expect(res.errors.join()).toMatch(/provider down/);
  });
});
