import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalWormStore } from "./immutable-store";

function store() {
  return new LocalWormStore(mkdtempSync(join(tmpdir(), "worm-")), () => 1_000_000);
}

describe("LocalWormStore", () => {
  it("writes then reads back identical bytes", async () => {
    const s = store();
    const data = Buffer.from("ciphertext");
    await s.put("b1/snapshot.enc", data, { retainUntilMs: 0 });
    expect(await s.get("b1/snapshot.enc")).toEqual(data);
  });

  it("refuses to overwrite an existing object (WORM)", async () => {
    const s = store();
    await s.put("b1/x", Buffer.from("a"), { retainUntilMs: 0 });
    await expect(s.put("b1/x", Buffer.from("b"), { retainUntilMs: 0 })).rejects.toThrow(/immutable|exists/i);
  });

  it("refuses to delete inside the retention window", async () => {
    const s = store();
    await s.put("b1/x", Buffer.from("a"), { retainUntilMs: Date_nowPlus(s, 60_000) });
    await expect(s.remove("b1/x")).rejects.toThrow(/locked|retention/i);
  });
});

// helper avoids Date.now() flakiness by reading the store's clock hook
function Date_nowPlus(s: LocalWormStore, ms: number): number {
  return s.now() + ms;
}
