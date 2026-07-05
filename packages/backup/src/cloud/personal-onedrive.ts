import type { ImmutableStore, PutOptions } from "../immutable-store";

/**
 * Minimal `fetch`-like transport for Microsoft Graph. Injected so tests never
 * touch the network and the package takes no Graph SDK dependency. At deployment
 * time this is satisfied by a thin adapter over global `fetch` that attaches a
 * consumer Microsoft-account bearer token to each request.
 */
export type GraphFetch = (
  url: string,
  init?: {
    method?: string;
    body?: Buffer | Uint8Array | string;
    headers?: Record<string, string>;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  arrayBuffer: () => Promise<ArrayBuffer>;
}>;

/** Graph simple-upload (PUT .../content) supports files up to 4 MiB. */
export const SIMPLE_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;

/** Max bytes per chunk PUT in an upload session (Graph tolerates up to ~60 MiB;
 *  we stay well under and use a multiple of 320 KiB as Graph recommends). */
const UPLOAD_SESSION_CHUNK_BYTES = 5 * 320 * 1024; // 1.6 MiB

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

export type PersonalOneDriveStoreConfig = {
  fetch: GraphFetch;
  /** Drive-root-relative folder that all backup objects live under. */
  rootFolder: string;
  /** Optional override of the Graph base URL (tests/mocks). */
  graphBase?: string;
};

/**
 * Soft redundant copy on the owner's personal (consumer) OneDrive.
 *
 * This is NOT WORM — consumer OneDrive cannot be made immutable (that is a
 * Business/Purview capability, out of scope). It exists purely as vendor-isolated
 * redundancy on top of R2, and leans on OneDrive's own versioning / recycle bin /
 * Files Restore / ransomware detection. Because it is deletable, `remove()` is a
 * real delete here.
 *
 * `retainUntilMs` is accepted (to satisfy the ImmutableStore contract) but has no
 * enforcement meaning on this backend.
 */
export class PersonalOneDriveStore implements ImmutableStore {
  private readonly fetch: GraphFetch;
  private readonly rootFolder: string;
  private readonly graphBase: string;

  constructor(config: PersonalOneDriveStoreConfig) {
    this.fetch = config.fetch;
    this.rootFolder = config.rootFolder.replace(/^\/+|\/+$/g, "");
    this.graphBase = (config.graphBase ?? GRAPH_BASE).replace(/\/+$/, "");
  }

  now(): number {
    return Date.now();
  }

  /** drive-root-relative path, each segment URL-encoded. */
  private drivePath(key: string): string {
    const clean = `${this.rootFolder}/${key}`.replace(/^\/+/, "");
    return clean
      .split("/")
      .map((seg) => encodeURIComponent(seg))
      .join("/");
  }

  private contentUrl(key: string): string {
    return `${this.graphBase}/me/drive/root:/${this.drivePath(key)}:/content`;
  }

  private itemUrl(key: string): string {
    return `${this.graphBase}/me/drive/root:/${this.drivePath(key)}`;
  }

  private sessionUrl(key: string): string {
    return `${this.graphBase}/me/drive/root:/${this.drivePath(key)}:/createUploadSession`;
  }

  async put(key: string, data: Buffer, _opts: PutOptions): Promise<void> {
    if (data.length > SIMPLE_UPLOAD_MAX_BYTES) {
      await this.putLarge(key, data);
      return;
    }
    const res = await this.fetch(this.contentUrl(key), {
      method: "PUT",
      body: data,
      headers: { "Content-Type": "application/octet-stream" },
    });
    if (!res.ok) {
      throw new Error(`OneDrive upload failed for ${key}: Graph status ${res.status}`);
    }
  }

  private async putLarge(key: string, data: Buffer): Promise<void> {
    const created = await this.fetch(this.sessionUrl(key), {
      method: "POST",
      body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": "replace" } }),
      headers: { "Content-Type": "application/json" },
    });
    if (!created.ok) {
      throw new Error(`OneDrive createUploadSession failed for ${key}: Graph status ${created.status}`);
    }
    const { uploadUrl } = (await created.json()) as { uploadUrl?: string };
    if (!uploadUrl) throw new Error(`OneDrive upload session for ${key} returned no uploadUrl`);

    const total = data.length;
    for (let start = 0; start < total; start += UPLOAD_SESSION_CHUNK_BYTES) {
      const end = Math.min(start + UPLOAD_SESSION_CHUNK_BYTES, total);
      const chunk = data.subarray(start, end);
      const res = await this.fetch(uploadUrl, {
        method: "PUT",
        body: chunk,
        headers: {
          "Content-Length": String(chunk.length),
          "Content-Range": `bytes ${start}-${end - 1}/${total}`,
        },
      });
      if (!res.ok) {
        throw new Error(
          `OneDrive chunk upload failed for ${key} (bytes ${start}-${end - 1}): Graph status ${res.status}`,
        );
      }
    }
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.fetch(this.contentUrl(key), { method: "GET" });
    if (!res.ok) throw new Error(`OneDrive download failed for ${key}: Graph status ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async remove(key: string): Promise<void> {
    const res = await this.fetch(this.itemUrl(key), { method: "DELETE" });
    // 404 is fine (already gone); anything else non-ok is an error.
    if (!res.ok && res.status !== 404) {
      throw new Error(`OneDrive delete failed for ${key}: Graph status ${res.status}`);
    }
  }
}
