import { describe, expect, it } from "vitest";
import {
  PersonalOneDriveStore,
  SIMPLE_UPLOAD_MAX_BYTES,
  type GraphFetch,
} from "./personal-onedrive";

type Recorded = { method: string; url: string; body?: Buffer; headers: Record<string, string> };

/**
 * Fake Graph transport modeling just enough of consumer OneDrive:
 *   - simple PUT  /me/drive/root:/{path}:/content           (<= 4 MB)
 *   - POST        /me/drive/root:/{path}:/createUploadSession (> 4 MB), then
 *     chunk PUTs to the returned uploadUrl
 *   - GET         /me/drive/root:/{path}:/content
 *   - DELETE      /me/drive/root:/{path}
 */
function fakeGraph() {
  const objects = new Map<string, Buffer>();
  const calls: Recorded[] = [];
  const uploadSessionFor = new Map<string, string>(); // uploadUrl -> path

  const fetch: GraphFetch = async (url, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const bodyBuf =
      init?.body === undefined
        ? undefined
        : Buffer.isBuffer(init.body)
          ? init.body
          : Buffer.from(init.body);
    calls.push({ method, url, body: bodyBuf, headers: init?.headers ?? {} });

    // create upload session
    const sessionMatch = url.match(/root:\/(.+):\/createUploadSession$/);
    if (method === "POST" && sessionMatch) {
      const path = decodeURIComponent(sessionMatch[1]!);
      const uploadUrl = `https://upload.example/session/${encodeURIComponent(path)}`;
      uploadSessionFor.set(uploadUrl, path);
      return { ok: true, status: 200, json: async () => ({ uploadUrl }), arrayBuffer: async () => new ArrayBuffer(0) };
    }

    // chunk upload to a session url
    if (method === "PUT" && uploadSessionFor.has(url)) {
      const path = uploadSessionFor.get(url)!;
      const prev = objects.get(path) ?? Buffer.alloc(0);
      objects.set(path, Buffer.concat([prev, bodyBuf ?? Buffer.alloc(0)]));
      return { ok: true, status: 201, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
    }

    const contentMatch = url.match(/root:\/(.+):\/content$/);
    if (contentMatch) {
      const path = decodeURIComponent(contentMatch[1]!);
      if (method === "PUT") {
        objects.set(path, bodyBuf ?? Buffer.alloc(0));
        return { ok: true, status: 201, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
      }
      if (method === "GET") {
        const b = objects.get(path);
        if (!b) return { ok: false, status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
        const ab = new ArrayBuffer(b.byteLength);
        new Uint8Array(ab).set(b);
        return {
          ok: true,
          status: 200,
          json: async () => ({}),
          arrayBuffer: async () => ab,
        };
      }
    }

    const deleteMatch = url.match(/root:\/(.+)$/);
    if (method === "DELETE" && deleteMatch) {
      objects.delete(decodeURIComponent(deleteMatch[1]!));
      return { ok: true, status: 204, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
    }

    return { ok: false, status: 400, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
  };

  return { fetch, calls, objects };
}

function store(g: ReturnType<typeof fakeGraph>) {
  return new PersonalOneDriveStore({ fetch: g.fetch, rootFolder: "LivingAtlasBackups" });
}

describe("PersonalOneDriveStore", () => {
  it("round-trips small blobs through put/get", async () => {
    const g = fakeGraph();
    const s = store(g);
    const data = Buffer.from("sealed-snapshot");
    await s.put("la_backup_000001/snapshot.enc", data, { retainUntilMs: 0 });
    expect(await s.get("la_backup_000001/snapshot.enc")).toEqual(data);
  });

  it("puts a small blob via the simple content PUT at the expected Graph path", async () => {
    const g = fakeGraph();
    const s = store(g);
    await s.put("la_backup_000001/manifest.json", Buffer.from("{}"), { retainUntilMs: 0 });
    const put = g.calls.find((c) => c.method === "PUT");
    expect(put).toBeDefined();
    expect(put!.url).toContain(
      "/me/drive/root:/LivingAtlasBackups/la_backup_000001/manifest.json:/content",
    );
    // no upload session should have been created for a small blob
    expect(g.calls.some((c) => c.url.includes("createUploadSession"))).toBe(false);
  });

  it("uses an upload session for blobs larger than 4 MB", async () => {
    const g = fakeGraph();
    const s = store(g);
    const big = Buffer.alloc(SIMPLE_UPLOAD_MAX_BYTES + 1, 7);
    await s.put("la_backup_000002/snapshot.enc", big, { retainUntilMs: 0 });
    expect(g.calls.some((c) => c.url.includes("createUploadSession"))).toBe(true);
    // and the reassembled bytes must round-trip
    expect(await s.get("la_backup_000002/snapshot.enc")).toEqual(big);
    // Generous timeout: allocating + chunking a >4 MiB buffer is CPU-bound and can
    // exceed vitest's 5s default under parallel contention (heavy import graph).
  }, 20_000);

  it("deletes (soft copy — not WORM)", async () => {
    const g = fakeGraph();
    const s = store(g);
    await s.put("la_backup_000003/x", Buffer.from("a"), { retainUntilMs: 999_999_999_999 });
    await s.remove("la_backup_000003/x");
    expect(g.calls.some((c) => c.method === "DELETE")).toBe(true);
    await expect(s.get("la_backup_000003/x")).rejects.toThrow();
  });

  it("throws when the Graph transport reports a non-ok upload", async () => {
    const g = fakeGraph();
    const failing = { ...g, fetch: (async () => ({ ok: false, status: 507, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) })) as GraphFetch };
    const s = store(failing as ReturnType<typeof fakeGraph>);
    await expect(s.put("b/x", Buffer.from("a"), { retainUntilMs: 0 })).rejects.toThrow(/507|upload|graph/i);
  });
});
