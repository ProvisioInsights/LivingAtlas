import { describe, expect, it, vi } from "vitest";
import type { ImmutableStore } from "@living-atlas/backup";
import { assembleBackupStores, fanOutBestEffort, type CloudStoreFactory } from "./backup-run";

function fakeStore(): ImmutableStore & { puts: string[]; fail?: boolean } {
  const s: ImmutableStore & { puts: string[]; fail?: boolean } = {
    puts: [],
    now: () => 1_000,
    async put(key) {
      if (s.fail) throw new Error("provider down");
      s.puts.push(key);
    },
    async get() {
      return Buffer.alloc(0);
    },
    async remove() {},
  };
  return s;
}

const staging = () => fakeStore();

describe("assembleBackupStores", () => {
  it("includes the R2 hard anchor as REQUIRED when configured", () => {
    const r2 = fakeStore();
    const factory: CloudStoreFactory = { r2: () => r2, oneDrive: () => undefined };
    const { required, bestEffort, notes } = assembleBackupStores(staging(), factory);
    expect(required).toContain(r2);
    expect(bestEffort).toHaveLength(0);
    expect(notes.join(" ")).toMatch(/onedrive/i);
  });

  it("puts OneDrive in the best-effort tier, never required", () => {
    const r2 = fakeStore();
    const od = fakeStore();
    const factory: CloudStoreFactory = { r2: () => r2, oneDrive: () => od };
    const { required, bestEffort } = assembleBackupStores(staging(), factory);
    expect(required).toContain(r2);
    expect(required).not.toContain(od);
    expect(bestEffort).toContain(od);
  });

  it("fails closed at assembly time if the R2 hard anchor is not configured", () => {
    const factory: CloudStoreFactory = { r2: () => undefined, oneDrive: () => undefined };
    expect(() => assembleBackupStores(staging(), factory)).toThrow(/R2|hard anchor|required/i);
  });

  it("always keeps local staging as a required store", () => {
    const s = staging();
    const r2 = fakeStore();
    const factory: CloudStoreFactory = { r2: () => r2, oneDrive: () => undefined };
    const { required } = assembleBackupStores(s, factory);
    expect(required).toContain(s);
  });
});

describe("fanOutBestEffort", () => {
  const items: Array<[string, Buffer]> = [
    ["b/manifest.json", Buffer.from("{}")],
    ["b/snapshot.enc", Buffer.from("x")],
  ];

  it("writes every item to every best-effort store and reports no errors on success", async () => {
    const od = fakeStore();
    const res = await fanOutBestEffort([od], items, 2_000);
    expect(res.errors).toHaveLength(0);
    expect(od.puts).toEqual(["b/manifest.json", "b/snapshot.enc"]);
  });

  it("collects errors without throwing when a best-effort store fails", async () => {
    const od = fakeStore();
    od.fail = true;
    const res = await fanOutBestEffort([od], items, 2_000);
    expect(res.errors.join()).toMatch(/provider down/);
  });

  it("is a no-op with no best-effort stores", async () => {
    const res = await fanOutBestEffort([], items, 2_000);
    expect(res.errors).toHaveLength(0);
  });
});
