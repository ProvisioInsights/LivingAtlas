import type { ImmutableStore, PutOptions } from "../immutable-store";

/**
 * Minimal S3-compatible client surface needed by {@link R2ObjectLockStore}.
 *
 * This is deliberately a tiny structural interface (not the full @aws-sdk/client-s3
 * surface) so the package stays light and every test can inject a fake. The real
 * AWS SDK client is adapted onto this shape at deployment time (see the runner),
 * NOT depended on by this package.
 *
 * Field names mirror the S3 REST/SDK wire contract so the deployment adapter is a
 * thin pass-through:
 *   - PutObject requires BOTH ObjectLockMode and ObjectLockRetainUntilDate together.
 *   - ObjectLockMode is case-sensitive: "COMPLIANCE" | "GOVERNANCE".
 *   - ObjectLockRetainUntilDate is an ISO-8601 instant (milliseconds precision).
 *   - GetObjectRetention returns { Mode, RetainUntilDate } (or empty if none).
 */
export interface S3PutObjectClient {
  putObject(input: {
    Bucket: string;
    Key: string;
    Body: Buffer;
    ObjectLockMode?: string;
    ObjectLockRetainUntilDate?: string;
  }): Promise<void>;
  getObject(input: { Bucket: string; Key: string }): Promise<{ Body: Buffer }>;
  getObjectRetention(input: {
    Bucket: string;
    Key: string;
  }): Promise<{ Mode?: string; RetainUntilDate?: string }>;
}

const COMPLIANCE = "COMPLIANCE" as const;

export type R2ObjectLockStoreConfig = {
  client: S3PutObjectClient;
  bucket: string;
  /** Only "COMPLIANCE" is permitted. Governance mode is rejected at construction. */
  mode?: typeof COMPLIANCE;
  clock?: () => number;
};

/**
 * The single hard anchor: an {@link ImmutableStore} backed by Cloudflare R2 (or
 * any S3-compatible endpoint) with Object Lock in COMPLIANCE mode.
 *
 * Guarantees enforced here:
 *   - Every put sets COMPLIANCE + a retain-until derived from `retainUntilMs`.
 *   - Fail-closed: after the put we read back the object's retention and THROW
 *     if the lock is missing or not COMPLIANCE. We never leave an unprotected
 *     object silently stored.
 *   - Governance mode is refused at construction (privileged users can bypass it).
 *   - remove() inside the retention window throws, mirroring the provider, which
 *     will itself reject the delete — so callers see the same failure locally.
 */
export class R2ObjectLockStore implements ImmutableStore {
  private readonly client: S3PutObjectClient;
  private readonly bucket: string;
  private readonly clock: () => number;
  /** Retain-until we last applied per key, so remove() can honor the window. */
  private readonly retainUntil = new Map<string, number>();

  constructor(config: R2ObjectLockStoreConfig) {
    const mode = config.mode ?? COMPLIANCE;
    if (mode !== COMPLIANCE) {
      throw new Error(
        `R2ObjectLockStore requires COMPLIANCE mode; refusing governance mode "${String(mode)}" (it can be bypassed by privileged users)`,
      );
    }
    this.client = config.client;
    this.bucket = config.bucket;
    this.clock = config.clock ?? (() => Date.now());
  }

  now(): number {
    return this.clock();
  }

  async put(key: string, data: Buffer, opts: PutOptions): Promise<void> {
    const retainUntilDate = new Date(opts.retainUntilMs).toISOString();
    await this.client.putObject({
      Bucket: this.bucket,
      Key: key,
      Body: data,
      ObjectLockMode: COMPLIANCE,
      ObjectLockRetainUntilDate: retainUntilDate,
    });

    // Fail-closed: verify the lock actually landed. A missing or non-COMPLIANCE
    // lock means the object is unprotected — treat it as a hard write failure.
    const retention = await this.client.getObjectRetention({ Bucket: this.bucket, Key: key });
    if (!retention.Mode || !retention.RetainUntilDate) {
      throw new Error(
        `R2 object ${key} has no Object-Lock retention after put (fail-closed): refusing to treat as durable`,
      );
    }
    if (retention.Mode !== COMPLIANCE) {
      throw new Error(
        `R2 object ${key} reported Object-Lock mode "${retention.Mode}", expected COMPLIANCE (fail-closed)`,
      );
    }
    if (retention.RetainUntilDate !== retainUntilDate) {
      throw new Error(
        `R2 object ${key} retain-until "${retention.RetainUntilDate}" does not match requested "${retainUntilDate}" (fail-closed)`,
      );
    }

    this.retainUntil.set(key, opts.retainUntilMs);
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.client.getObject({ Bucket: this.bucket, Key: key });
    return res.Body;
  }

  async remove(key: string): Promise<void> {
    const until = this.retainUntil.get(key) ?? 0;
    if (this.now() < until) {
      throw new Error(
        `R2 object ${key} is under COMPLIANCE retention until ${until}; delete refused (WORM)`,
      );
    }
    // Past the window, deletion of the R2 object is a provider-side lifecycle
    // concern (Object-Lock expiry + bucket lifecycle), not something this WORM
    // anchor performs. So this is a no-op past retention: mirrors compliance
    // semantics (never a same-window delete) without pretending to prune R2.
  }
}
