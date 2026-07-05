import { describe, expect, it } from "vitest";
import { R2ObjectLockStore, type S3PutObjectClient } from "./r2-objectlock";

/**
 * Fake S3-compatible client. Records puts, models COMPLIANCE Object-Lock
 * retention in memory, and lets a test suppress the lock to prove fail-closed.
 */
function fakeS3(opts: { suppressLock?: boolean } = {}) {
  const objects = new Map<string, { body: Buffer; mode?: string; retainUntil?: string }>();
  const client: S3PutObjectClient & {
    objects: typeof objects;
    puts: Array<{ Bucket: string; Key: string; ObjectLockMode?: string; ObjectLockRetainUntilDate?: string }>;
  } = {
    objects,
    puts: [],
    async putObject(input) {
      client.puts.push({
        Bucket: input.Bucket,
        Key: input.Key,
        ObjectLockMode: input.ObjectLockMode,
        ObjectLockRetainUntilDate: input.ObjectLockRetainUntilDate,
      });
      objects.set(input.Key, {
        body: input.Body,
        // suppressLock models a bucket/misconfig that silently dropped the lock
        mode: opts.suppressLock ? undefined : input.ObjectLockMode,
        retainUntil: opts.suppressLock ? undefined : input.ObjectLockRetainUntilDate,
      });
    },
    async getObject(input) {
      const o = objects.get(input.Key);
      if (!o) throw new Error(`no such key: ${input.Key}`);
      return { Body: o.body };
    },
    async getObjectRetention(input) {
      const o = objects.get(input.Key);
      if (!o || !o.mode || !o.retainUntil) return {};
      return { Mode: o.mode, RetainUntilDate: o.retainUntil };
    },
  };
  return client;
}

const BUCKET = "la-backup-worm-test";

function store(client: S3PutObjectClient, clock = () => 1_000_000) {
  return new R2ObjectLockStore({ client, bucket: BUCKET, clock });
}

describe("R2ObjectLockStore", () => {
  it("puts with COMPLIANCE mode and a retain-until derived from retainUntilMs", async () => {
    const c = fakeS3();
    const s = store(c);
    const retainUntilMs = Date.parse("2027-01-02T03:04:05.000Z");
    await s.put("b1/snapshot.enc", Buffer.from("ciphertext"), { retainUntilMs });

    expect(c.puts).toHaveLength(1);
    expect(c.puts[0]!.Bucket).toBe(BUCKET);
    expect(c.puts[0]!.Key).toBe("b1/snapshot.enc");
    expect(c.puts[0]!.ObjectLockMode).toBe("COMPLIANCE");
    expect(c.puts[0]!.ObjectLockRetainUntilDate).toBe("2027-01-02T03:04:05.000Z");
  });

  it("round-trips bytes through get", async () => {
    const c = fakeS3();
    const s = store(c);
    const data = Buffer.from("sealed-bytes");
    await s.put("b1/x", data, { retainUntilMs: 2_000_000 });
    expect(await s.get("b1/x")).toEqual(data);
  });

  it("fails closed when the object reports no retention lock after put", async () => {
    const c = fakeS3({ suppressLock: true });
    const s = store(c);
    await expect(
      s.put("b1/x", Buffer.from("a"), { retainUntilMs: 2_000_000 }),
    ).rejects.toThrow(/lock|retention|compliance/i);
  });

  it("fails closed when the object reports GOVERNANCE instead of COMPLIANCE", async () => {
    const c = fakeS3();
    // Force the retention read to report governance mode.
    const orig = c.getObjectRetention;
    c.getObjectRetention = async (input) => {
      const r = await orig(input);
      return r.Mode ? { ...r, Mode: "GOVERNANCE" } : r;
    };
    const s = store(c);
    await expect(
      s.put("b1/x", Buffer.from("a"), { retainUntilMs: 2_000_000 }),
    ).rejects.toThrow(/compliance|governance/i);
  });

  it("refuses to delete inside the retention window (mirrors compliance semantics)", async () => {
    const c = fakeS3();
    const s = store(c, () => 1_000_000);
    await s.put("b1/x", Buffer.from("a"), { retainUntilMs: 1_060_000 });
    await expect(s.remove("b1/x")).rejects.toThrow(/locked|retention|compliance/i);
  });

  it("rejects construction when configured for governance mode", () => {
    const c = fakeS3();
    expect(
      () =>
        new R2ObjectLockStore({
          client: c,
          bucket: BUCKET,
          // @ts-expect-error – governance is not an allowed mode, and is rejected at runtime too
          mode: "GOVERNANCE",
        }),
    ).toThrow(/governance|compliance/i);
  });
});
