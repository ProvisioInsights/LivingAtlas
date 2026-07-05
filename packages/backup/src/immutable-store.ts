import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

export type PutOptions = { retainUntilMs: number };

export interface ImmutableStore {
  put(key: string, data: Buffer, opts: PutOptions): Promise<void>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>; // only permitted past retention
  now(): number;
}

/** Filesystem WORM used in tests and as the local staging copy. Enforces
 *  write-once + retention at the app layer (cloud adapters enforce it in the
 *  provider). A sidecar `.lock` records retain-until. */
export class LocalWormStore implements ImmutableStore {
  constructor(private readonly root: string, private readonly clock: () => number = () => 0) {}

  now(): number {
    return this.clock();
  }

  private path(key: string): string {
    return join(this.root, key);
  }

  async put(key: string, data: Buffer, opts: PutOptions): Promise<void> {
    const p = this.path(key);
    if (existsSync(p)) throw new Error(`object is immutable and already exists: ${key}`);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, data);
    writeFileSync(`${p}.lock`, String(opts.retainUntilMs));
  }

  async get(key: string): Promise<Buffer> {
    return readFileSync(this.path(key));
  }

  async remove(key: string): Promise<void> {
    const p = this.path(key);
    const until = Number(existsSync(`${p}.lock`) ? readFileSync(`${p}.lock`, "utf8") : "0");
    if (this.now() < until) throw new Error(`object is locked by retention until ${until}`);
    rmSync(p, { force: true });
    rmSync(`${p}.lock`, { force: true });
  }
}
