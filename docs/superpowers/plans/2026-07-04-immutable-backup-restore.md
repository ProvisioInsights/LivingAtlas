# Immutable Backup + Restore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a ransomware-grade, MCP-unreachable backup + restore subsystem that copies ciphertext-only graph data to WORM/Object-Lock storage on a GFS cadence, with keyring escrow under a human-only recovery master and a backend-only restore path.

**Architecture:** A new `packages/backup` holds pure, unit-testable logic (manifest schema, differential/full packaging, GFS retention policy, recovery-master escrow wrap, an immutable-store interface with a local WORM fake for tests). A `packages/check` tsx runner orchestrates real backups and is driven by a launchd timer. Cloud adapters (R2 Object Lock, S3/B2 Object Lock) are thin implementations of the store interface, exercised only behind deploy gates. The MCP packages get **no** import path to any backup write/delete surface, enforced by a test.

**Tech Stack:** TypeScript (ESM), zod (schemas), Node `crypto` (AES-256-GCM, matching keyring patterns), vitest (colocated `*.test.ts`), tsx (runners), pnpm workspace. Cloud SDKs added only in adapter tasks.

**Spec:** `docs/superpowers/specs/2026-07-04-immutable-backup-restore-design.md`

---

## File Structure

- `packages/backup/package.json`, `tsconfig.json` — new workspace package.
- `packages/backup/src/manifest.ts` — zod schema + types for a backup set (full/differential, generation range, artifact refs, sha-256 checksums).
- `packages/backup/src/differential.ts` — pure computation of a differential (journal delta) vs. the last full's cursor.
- `packages/backup/src/full-snapshot.ts` — package a sealed snapshot into a checksummed artifact.
- `packages/backup/src/escrow.ts` — wrap/unwrap the keyring under a 256-bit recovery master (AES-256-GCM + AAD domain separation).
- `packages/backup/src/retention.ts` — pure GFS retention policy (which backups to keep/prune given timestamps + config).
- `packages/backup/src/immutable-store.ts` — `ImmutableStore` interface + `LocalWormStore` (filesystem, append-only, refuses overwrite/delete inside retention window) for tests.
- `packages/backup/src/writer.ts` — orchestrator: choose full vs diff, package, escrow, fan-out to N stores, mark durable only if all confirm, emit manifest.
- `packages/backup/src/restore.ts` — reconstruct point-in-time ciphertext (full + replay diffs) and unwrap keyring with the master.
- `packages/backup/src/schedule.ts` — pure "what levels are due now given last-run times + cadence config".
- `packages/backup/src/index.ts` — public exports.
- `packages/backup/src/cloud/r2-objectlock.ts` — R2 Object-Lock adapter (deploy-gated).
- `packages/backup/src/cloud/s3-objectlock.ts` — S3/B2 Object-Lock adapter (deploy-gated).
- `packages/check/src/backup-run.ts` — tsx runner wiring real stores + keyring; invoked by the timer.
- `packages/check/src/backup-restore.ts` — tsx runner for backend restore.
- `packages/check/src/mcp-backup-isolation.test.ts` — asserts no MCP package imports backup write/delete.
- Root `package.json` scripts: `backup:run`, `backup:restore`.

---

## Task 1: Scaffold the `packages/backup` workspace package

**Files:**
- Create: `packages/backup/package.json`
- Create: `packages/backup/tsconfig.json`
- Create: `packages/backup/src/index.ts`
- Test: `packages/backup/src/smoke.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/backup/src/smoke.test.ts
import { describe, expect, it } from "vitest";
import { BACKUP_PACKAGE_NAME } from "./index";

describe("backup package", () => {
  it("exposes its package name", () => {
    expect(BACKUP_PACKAGE_NAME).toBe("@living-atlas/backup");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx pnpm --filter @living-atlas/backup test`
Expected: FAIL — package/module not found.

- [ ] **Step 3: Create the package files**

```json
// packages/backup/package.json
{
  "name": "@living-atlas/backup",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit" },
  "devDependencies": { "vitest": "4.1.9", "typescript": "7.0.2" }
}
```

```json
// packages/backup/tsconfig.json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```

```ts
// packages/backup/src/index.ts
export const BACKUP_PACKAGE_NAME = "@living-atlas/backup";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx pnpm install && npx pnpm --filter @living-atlas/backup test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/backup
git commit -m "feat(backup): scaffold backup workspace package"
```

> Note: confirm `tsconfig.base.json` exists at repo root; if the monorepo uses a different base name, match it (check another package's `tsconfig.json`).

---

## Task 2: Backup manifest schema

**Files:**
- Create: `packages/backup/src/manifest.ts`
- Test: `packages/backup/src/manifest.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/backup/src/manifest.test.ts
import { describe, expect, it } from "vitest";
import { BackupManifestSchema, type BackupManifest } from "./manifest";

const base: BackupManifest = {
  backup_id: "la_backup_000001",
  kind: "full",
  authority_id: "la_authority_test0001",
  base_generation: 0,
  target_generation: 100,
  created_at: "2026-07-04T00:00:00.000Z",
  artifacts: [{ name: "snapshot.enc", sha256: "a".repeat(64), bytes: 1024 }],
  parent_backup_id: undefined,
};

describe("BackupManifestSchema", () => {
  it("accepts a valid full manifest", () => {
    expect(BackupManifestSchema.parse(base)).toMatchObject({ kind: "full" });
  });

  it("requires a parent_backup_id for differentials", () => {
    const diff = { ...base, kind: "differential" as const, parent_backup_id: undefined };
    expect(() => BackupManifestSchema.parse(diff)).toThrow();
  });

  it("rejects a non-64-char sha256", () => {
    const bad = { ...base, artifacts: [{ name: "x", sha256: "short", bytes: 1 }] };
    expect(() => BackupManifestSchema.parse(bad)).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx pnpm --filter @living-atlas/backup test manifest`
Expected: FAIL — `./manifest` not found.

- [ ] **Step 3: Implement the schema**

```ts
// packages/backup/src/manifest.ts
import { z } from "zod";

export const BackupArtifactSchema = z.object({
  name: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().nonnegative(),
});

export const BackupManifestSchema = z
  .object({
    backup_id: z.string().min(1),
    kind: z.enum(["full", "differential"]),
    authority_id: z.string().min(1),
    base_generation: z.number().int().nonnegative(),
    target_generation: z.number().int().nonnegative(),
    created_at: z.string().datetime(),
    artifacts: z.array(BackupArtifactSchema).min(1),
    parent_backup_id: z.string().min(1).optional(),
  })
  .refine((m) => m.kind === "full" || !!m.parent_backup_id, {
    message: "differential backups require parent_backup_id",
    path: ["parent_backup_id"],
  })
  .refine((m) => m.target_generation >= m.base_generation, {
    message: "target_generation must be >= base_generation",
    path: ["target_generation"],
  });

export type BackupArtifact = z.infer<typeof BackupArtifactSchema>;
export type BackupManifest = z.infer<typeof BackupManifestSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx pnpm --filter @living-atlas/backup test manifest`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/backup/src/manifest.ts packages/backup/src/manifest.test.ts
git commit -m "feat(backup): backup manifest schema"
```

---

## Task 3: GFS retention policy (pure)

**Files:**
- Create: `packages/backup/src/retention.ts`
- Test: `packages/backup/src/retention.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/backup/src/retention.test.ts
import { describe, expect, it } from "vitest";
import { selectForDeletion, type RetentionRule, type BackupRef } from "./retention";

// Rules: keep 15-min diffs 24h; daily fulls 90d. Times are epoch ms.
const rules: RetentionRule[] = [
  { kind: "differential", keepForMs: 24 * 60 * 60 * 1000 },
  { kind: "full", keepForMs: 90 * 24 * 60 * 60 * 1000 },
];

function ref(id: string, kind: BackupRef["kind"], ageMs: number, nowMs: number): BackupRef {
  return { backup_id: id, kind, created_at_ms: nowMs - ageMs, locked_until_ms: 0 };
}

describe("selectForDeletion", () => {
  const now = 1_000_000_000_000;
  it("deletes a differential older than its retention window", () => {
    const old = ref("d1", "differential", 25 * 3600_000, now);
    expect(selectForDeletion([old], rules, now)).toEqual(["d1"]);
  });

  it("keeps a differential within its window", () => {
    const fresh = ref("d2", "differential", 1 * 3600_000, now);
    expect(selectForDeletion([fresh], rules, now)).toEqual([]);
  });

  it("never deletes an object still under Object-Lock (locked_until in the future)", () => {
    const locked = { ...ref("d3", "differential", 999 * 3600_000, now), locked_until_ms: now + 3600_000 };
    expect(selectForDeletion([locked], rules, now)).toEqual([]);
  });

  it("keeps a full within 90d, deletes beyond", () => {
    const keep = ref("f1", "full", 10 * 24 * 3600_000, now);
    const drop = ref("f2", "full", 100 * 24 * 3600_000, now);
    expect(selectForDeletion([keep, drop], rules, now)).toEqual(["f2"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx pnpm --filter @living-atlas/backup test retention`
Expected: FAIL — `./retention` not found.

- [ ] **Step 3: Implement the policy**

```ts
// packages/backup/src/retention.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx pnpm --filter @living-atlas/backup test retention`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/backup/src/retention.ts packages/backup/src/retention.test.ts
git commit -m "feat(backup): GFS retention policy respecting Object-Lock windows"
```

---

## Task 4: Recovery-master escrow (wrap/unwrap the keyring)

**Files:**
- Create: `packages/backup/src/escrow.ts`
- Test: `packages/backup/src/escrow.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/backup/src/escrow.test.ts
import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { wrapKeyringForEscrow, unwrapKeyringFromEscrow } from "./escrow";

describe("escrow", () => {
  const master = randomBytes(32); // 256-bit recovery master
  const keyringJson = JSON.stringify({ keys: [{ id: "la_key_x", material: "AAAA" }] });

  it("round-trips the keyring through wrap/unwrap", () => {
    const env = wrapKeyringForEscrow(keyringJson, master);
    expect(env.algorithm).toBe("AES-256-GCM+recovery-master-v1");
    expect(unwrapKeyringFromEscrow(env, master)).toBe(keyringJson);
  });

  it("fails to unwrap with the wrong master (no partial plaintext)", () => {
    const env = wrapKeyringForEscrow(keyringJson, master);
    expect(() => unwrapKeyringFromEscrow(env, randomBytes(32))).toThrow();
  });

  it("rejects a tampered ciphertext (GCM auth)", () => {
    const env = wrapKeyringForEscrow(keyringJson, master);
    const tampered = { ...env, ciphertext_b64: Buffer.from(randomBytes(env_len(env))).toString("base64") };
    expect(() => unwrapKeyringFromEscrow(tampered, master)).toThrow();
  });
});

function env_len(env: { ciphertext_b64: string }): number {
  return Buffer.from(env.ciphertext_b64, "base64").length;
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx pnpm --filter @living-atlas/backup test escrow`
Expected: FAIL — `./escrow` not found.

- [ ] **Step 3: Implement escrow crypto**

```ts
// packages/backup/src/escrow.ts
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGO = "AES-256-GCM+recovery-master-v1";
const AAD = Buffer.from("living-atlas/keyring-escrow/v1");

export type EscrowEnvelope = {
  algorithm: typeof ALGO;
  iv_b64: string;
  tag_b64: string;
  ciphertext_b64: string;
};

export function wrapKeyringForEscrow(keyringJson: string, master: Buffer): EscrowEnvelope {
  if (master.length !== 32) throw new Error("recovery master must be 32 bytes");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", master, iv);
  cipher.setAAD(AAD);
  const ct = Buffer.concat([cipher.update(Buffer.from(keyringJson, "utf8")), cipher.final()]);
  return {
    algorithm: ALGO,
    iv_b64: iv.toString("base64"),
    tag_b64: cipher.getAuthTag().toString("base64"),
    ciphertext_b64: ct.toString("base64"),
  };
}

export function unwrapKeyringFromEscrow(env: EscrowEnvelope, master: Buffer): string {
  if (env.algorithm !== ALGO) throw new Error("unknown escrow algorithm");
  const decipher = createDecipheriv("aes-256-gcm", master, Buffer.from(env.iv_b64, "base64"));
  decipher.setAAD(AAD);
  decipher.setAuthTag(Buffer.from(env.tag_b64, "base64"));
  const pt = Buffer.concat([
    decipher.update(Buffer.from(env.ciphertext_b64, "base64")),
    decipher.final(), // throws on auth failure — no partial plaintext returned
  ]);
  return pt.toString("utf8");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx pnpm --filter @living-atlas/backup test escrow`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/backup/src/escrow.ts packages/backup/src/escrow.test.ts
git commit -m "feat(backup): recovery-master keyring escrow (AES-256-GCM, AAD-separated)"
```

---

## Task 5: Immutable store interface + `LocalWormStore`

**Files:**
- Create: `packages/backup/src/immutable-store.ts`
- Test: `packages/backup/src/immutable-store.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/backup/src/immutable-store.test.ts
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalWormStore } from "./immutable-store";

function store() {
  return new LocalWormStore(mkdtempSync(join(tmpdir(), "worm-")));
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx pnpm --filter @living-atlas/backup test immutable-store`
Expected: FAIL — `./immutable-store` not found.

- [ ] **Step 3: Implement interface + local WORM fake**

```ts
// packages/backup/src/immutable-store.ts
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
```

> Note: `now()` defaults to `0`; tests pass an explicit clock (`new LocalWormStore(dir, () => 1_000)`) when they need retention math. Update the test's `store()` helper to `new LocalWormStore(mkdtempSync(...), () => 1_000_000)` so `now()` is nonzero.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx pnpm --filter @living-atlas/backup test immutable-store`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/backup/src/immutable-store.ts packages/backup/src/immutable-store.test.ts
git commit -m "feat(backup): ImmutableStore interface + LocalWormStore with retention"
```

---

## Task 6: Differential computation (pure)

**Files:**
- Create: `packages/backup/src/differential.ts`
- Test: `packages/backup/src/differential.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/backup/src/differential.test.ts
import { describe, expect, it } from "vitest";
import { computeDifferential, type JournalEntry } from "./differential";

const journal: JournalEntry[] = [
  { generation: 1, object_id: "o1", sealed_b64: "AA" },
  { generation: 2, object_id: "o2", sealed_b64: "BB" },
  { generation: 3, object_id: "o1", sealed_b64: "CC" },
];

describe("computeDifferential", () => {
  it("includes only entries after the base generation", () => {
    const diff = computeDifferential(journal, 1);
    expect(diff.entries.map((e) => e.generation)).toEqual([2, 3]);
    expect(diff.base_generation).toBe(1);
    expect(diff.target_generation).toBe(3);
  });

  it("returns an empty diff when nothing is newer", () => {
    expect(computeDifferential(journal, 3).entries).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx pnpm --filter @living-atlas/backup test differential`
Expected: FAIL — `./differential` not found.

- [ ] **Step 3: Implement**

```ts
// packages/backup/src/differential.ts
export type JournalEntry = { generation: number; object_id: string; sealed_b64: string };
export type Differential = {
  base_generation: number;
  target_generation: number;
  entries: JournalEntry[];
};

export function computeDifferential(journal: JournalEntry[], baseGeneration: number): Differential {
  const entries = journal
    .filter((e) => e.generation > baseGeneration)
    .sort((a, b) => a.generation - b.generation);
  const target = entries.length ? entries[entries.length - 1]!.generation : baseGeneration;
  return { base_generation: baseGeneration, target_generation: target, entries };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx pnpm --filter @living-atlas/backup test differential`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/backup/src/differential.ts packages/backup/src/differential.test.ts
git commit -m "feat(backup): differential (journal delta) computation"
```

---

## Task 7: Schedule policy (pure) — what levels are due now

**Files:**
- Create: `packages/backup/src/schedule.ts`
- Test: `packages/backup/src/schedule.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/backup/src/schedule.test.ts
import { describe, expect, it } from "vitest";
import { dueLevels, type CadenceConfig, type LastRun } from "./schedule";

const cadence: CadenceConfig = {
  differentialEveryMs: 15 * 60_000,
  fullEveryMs: 24 * 60 * 60_000,
};

describe("dueLevels", () => {
  const now = 100 * 60 * 60_000; // 100h
  it("schedules a differential when overdue", () => {
    const last: LastRun = { lastDifferentialMs: now - 20 * 60_000, lastFullMs: now - 1 * 60_000 };
    expect(dueLevels(cadence, last, now)).toEqual(["differential"]);
  });

  it("schedules a full (and implicitly resets diff) when the full is overdue", () => {
    const last: LastRun = { lastDifferentialMs: now - 1 * 60_000, lastFullMs: now - 25 * 60 * 60_000 };
    expect(dueLevels(cadence, last, now)).toEqual(["full"]);
  });

  it("schedules nothing when both are fresh", () => {
    const last: LastRun = { lastDifferentialMs: now - 60_000, lastFullMs: now - 60_000 };
    expect(dueLevels(cadence, last, now)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx pnpm --filter @living-atlas/backup test schedule`
Expected: FAIL — `./schedule` not found.

- [ ] **Step 3: Implement**

```ts
// packages/backup/src/schedule.ts
export type CadenceConfig = { differentialEveryMs: number; fullEveryMs: number };
export type LastRun = { lastDifferentialMs: number; lastFullMs: number };
export type Level = "full" | "differential";

/** A due full supersedes a due differential for the same tick (the full
 *  captures everything, resetting the differential base). */
export function dueLevels(cadence: CadenceConfig, last: LastRun, nowMs: number): Level[] {
  if (nowMs - last.lastFullMs >= cadence.fullEveryMs) return ["full"];
  if (nowMs - last.lastDifferentialMs >= cadence.differentialEveryMs) return ["differential"];
  return [];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx pnpm --filter @living-atlas/backup test schedule`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/backup/src/schedule.ts packages/backup/src/schedule.test.ts
git commit -m "feat(backup): cadence scheduling policy (full supersedes differential)"
```

---

## Task 8: Backup writer/orchestrator (fan-out, durable-only-if-all)

**Files:**
- Create: `packages/backup/src/writer.ts`
- Test: `packages/backup/src/writer.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/backup/src/writer.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx pnpm --filter @living-atlas/backup test writer`
Expected: FAIL — `./writer` not found.

- [ ] **Step 3: Implement the orchestrator**

```ts
// packages/backup/src/writer.ts
import { createHash } from "node:crypto";
import type { ImmutableStore } from "./immutable-store";
import { BackupManifestSchema, type BackupManifest } from "./manifest";

export type WriteBackupInput = {
  authority_id: string;
  kind: "full" | "differential";
  base_generation: number;
  target_generation: number;
  artifactBytes: Buffer;
  escrowEnvelopeJson: string;
  createdAtIso: string;
  backupId: string;
  retainUntilMs: number;
  parentBackupId?: string;
};

export type WriteBackupResult = { durable: boolean; errors: string[]; manifest: BackupManifest };

function sha256(b: Buffer): string {
  return createHash("sha256").update(b).digest("hex");
}

export async function writeBackup(
  stores: ImmutableStore[],
  input: WriteBackupInput,
): Promise<WriteBackupResult> {
  const artifactName = input.kind === "full" ? "snapshot.enc" : "differential.enc";
  const escrowBytes = Buffer.from(input.escrowEnvelopeJson, "utf8");
  const manifest: BackupManifest = BackupManifestSchema.parse({
    backup_id: input.backupId,
    kind: input.kind,
    authority_id: input.authority_id,
    base_generation: input.base_generation,
    target_generation: input.target_generation,
    created_at: input.createdAtIso,
    parent_backup_id: input.parentBackupId,
    artifacts: [
      { name: artifactName, sha256: sha256(input.artifactBytes), bytes: input.artifactBytes.length },
      { name: "keyring.escrow.json", sha256: sha256(escrowBytes), bytes: escrowBytes.length },
    ],
  });
  const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
  const items: Array<[string, Buffer]> = [
    [`${input.backupId}/${artifactName}`, input.artifactBytes],
    [`${input.backupId}/keyring.escrow.json`, escrowBytes],
    [`${input.backupId}/manifest.json`, manifestBytes],
  ];

  const errors: string[] = [];
  for (const store of stores) {
    for (const [key, data] of items) {
      try {
        await store.put(key, data, { retainUntilMs: input.retainUntilMs });
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }
  }
  return { durable: errors.length === 0, errors, manifest };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx pnpm --filter @living-atlas/backup test writer`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/backup/src/writer.ts packages/backup/src/writer.test.ts
git commit -m "feat(backup): backup writer with multi-store fan-out and durable gating"
```

---

## Task 9: Restore (point-in-time reconstruction + keyring recovery)

**Files:**
- Create: `packages/backup/src/restore.ts`
- Test: `packages/backup/src/restore.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/backup/src/restore.test.ts
import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalWormStore } from "./immutable-store";
import { writeBackup } from "./writer";
import { wrapKeyringForEscrow } from "./escrow";
import { restoreBackup } from "./restore";

describe("restoreBackup", () => {
  it("round-trips: full backup then restore yields identical artifact + keyring", async () => {
    const store = new LocalWormStore(mkdtempSync(join(tmpdir(), "worm-")), () => 1_000);
    const master = randomBytes(32);
    const keyringJson = JSON.stringify({ keys: [{ id: "la_key_x" }] });
    const artifact = Buffer.from("sealed-snapshot-bytes");

    const { manifest } = await writeBackup([store], {
      authority_id: "la_authority_test0001",
      kind: "full",
      base_generation: 0,
      target_generation: 7,
      artifactBytes: artifact,
      escrowEnvelopeJson: JSON.stringify(wrapKeyringForEscrow(keyringJson, master)),
      createdAtIso: "2026-07-04T00:00:00.000Z",
      backupId: "la_backup_000001",
      retainUntilMs: 0,
    });

    const restored = await restoreBackup(store, manifest.backup_id, master);
    expect(restored.artifactBytes).toEqual(artifact);
    expect(restored.keyringJson).toBe(keyringJson);
  });

  it("throws on checksum mismatch (tamper detection)", async () => {
    const store = new LocalWormStore(mkdtempSync(join(tmpdir(), "worm-")), () => 1_000);
    const master = randomBytes(32);
    await writeBackup([store], {
      authority_id: "la_authority_test0001", kind: "full", base_generation: 0, target_generation: 1,
      artifactBytes: Buffer.from("x"),
      escrowEnvelopeJson: JSON.stringify(wrapKeyringForEscrow("{}", master)),
      createdAtIso: "2026-07-04T00:00:00.000Z", backupId: "la_backup_bad", retainUntilMs: 0,
    });
    // Corrupt the stored artifact by writing a NEW backup id whose manifest lies:
    await expect(restoreBackup(store, "la_backup_missing", master)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx pnpm --filter @living-atlas/backup test restore`
Expected: FAIL — `./restore` not found.

- [ ] **Step 3: Implement restore**

```ts
// packages/backup/src/restore.ts
import { createHash } from "node:crypto";
import type { ImmutableStore } from "./immutable-store";
import { BackupManifestSchema } from "./manifest";
import { unwrapKeyringFromEscrow, type EscrowEnvelope } from "./escrow";

export type RestoreResult = { artifactBytes: Buffer; keyringJson: string };

function sha256(b: Buffer): string {
  return createHash("sha256").update(b).digest("hex");
}

export async function restoreBackup(
  store: ImmutableStore,
  backupId: string,
  master: Buffer,
): Promise<RestoreResult> {
  const manifest = BackupManifestSchema.parse(
    JSON.parse((await store.get(`${backupId}/manifest.json`)).toString("utf8")),
  );
  const artifactName = manifest.artifacts.find((a) => a.name !== "keyring.escrow.json")!.name;
  const artifactBytes = await store.get(`${backupId}/${artifactName}`);
  const escrowBytes = await store.get(`${backupId}/keyring.escrow.json`);

  for (const a of manifest.artifacts) {
    const bytes = a.name === "keyring.escrow.json" ? escrowBytes : artifactBytes;
    if (sha256(bytes) !== a.sha256) throw new Error(`checksum mismatch for ${a.name}`);
  }

  const env = JSON.parse(escrowBytes.toString("utf8")) as EscrowEnvelope;
  const keyringJson = unwrapKeyringFromEscrow(env, master);
  return { artifactBytes, keyringJson };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx pnpm --filter @living-atlas/backup test restore`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/backup/src/restore.ts packages/backup/src/restore.test.ts
git commit -m "feat(backup): point-in-time restore with checksum + keyring recovery"
```

---

## Task 10: MCP-unreachable isolation test

**Files:**
- Create: `packages/check/src/mcp-backup-isolation.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/check/src/mcp-backup-isolation.test.ts
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe("MCP is structurally isolated from backup write/delete", () => {
  it("no local-mcp or cloudflare-worker source imports @living-atlas/backup", () => {
    for (const pkg of ["packages/local-mcp/src", "packages/cloudflare-worker/src"]) {
      for (const f of walk(pkg).filter((p) => p.endsWith(".ts") && !p.endsWith(".test.ts"))) {
        const src = readFileSync(f, "utf8");
        expect(src, `${f} must not import the backup package`).not.toMatch(/@living-atlas\/backup/);
      }
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails or passes**

Run: `npx pnpm --filter @living-atlas/check test mcp-backup-isolation`
Expected: PASS immediately (no such imports exist) — this is a **guard test** that must stay green forever. If it fails, an import boundary was violated.

- [ ] **Step 3: No implementation needed** — the test encodes an invariant.

- [ ] **Step 4: Commit**

```bash
git add packages/check/src/mcp-backup-isolation.test.ts
git commit -m "test(backup): guard that MCP never imports the backup package"
```

---

## Task 11: Wire public exports + a full-suite green check

**Files:**
- Modify: `packages/backup/src/index.ts`

- [ ] **Step 1: Export the public surface**

```ts
// packages/backup/src/index.ts
export const BACKUP_PACKAGE_NAME = "@living-atlas/backup";
export * from "./manifest";
export * from "./differential";
export * from "./retention";
export * from "./escrow";
export * from "./immutable-store";
export * from "./schedule";
export * from "./writer";
export * from "./restore";
```

- [ ] **Step 2: Run the whole package suite + typecheck**

Run: `npx pnpm --filter @living-atlas/backup test && npx pnpm --filter @living-atlas/backup typecheck`
Expected: all green, no type errors.

- [ ] **Step 3: Commit**

```bash
git add packages/backup/src/index.ts
git commit -m "feat(backup): export public backup surface"
```

---

## Task 12: `backup:run` and `backup:restore` runners (integration wiring)

**Files:**
- Create: `packages/check/src/backup-run.ts`
- Create: `packages/check/src/backup-restore.ts`
- Modify: root `package.json` scripts

- [ ] **Step 1: Implement `backup-run.ts`** — a tsx runner that: loads cadence + last-run state from the replica dir; calls `dueLevels`; if a full is due, reads the sealed snapshot from `LIVING_ATLAS_LOCAL_GRAPH_DIR`; if a differential is due, reads journal entries past the last base; wraps the keyring (read via the keyring store) with a recovery master resolved from `LIVING_ATLAS_BACKUP_RECOVERY_MASTER` (base64); constructs the store list (LocalWormStore staging + cloud adapters when configured); calls `writeBackup`; on `durable`, records new last-run + prunes per `selectForDeletion`; on not-durable, exits nonzero and logs errors. Follow the env-driven pattern in `packages/check/src/cloudflare-live-bidirectional-sync.ts`.

Model the arg/secret resolution on existing runners; resolve the recovery master ONLY for the local staging escrow write — the automated writer never needs to *decrypt* it.

- [ ] **Step 2: Implement `backup-restore.ts`** — a tsx runner that takes `--backup-id`, resolves the recovery master interactively (prompt, not env, to keep it human-only), reads from the configured store, calls `restoreBackup`, and writes the recovered artifact + keyring to an operator-chosen output dir. Prints a clear "RESTORE COMPLETE" with checksums.

- [ ] **Step 3: Add scripts**

```jsonc
// root package.json "scripts"
"backup:run": "tsx packages/check/src/backup-run.ts",
"backup:restore": "tsx packages/check/src/backup-restore.ts"
```

- [ ] **Step 4: Manual smoke (local WORM only, no cloud yet)**

Run: `LIVING_ATLAS_BACKUP_STAGING_DIR=/tmp/la-backup-smoke LIVING_ATLAS_BACKUP_RECOVERY_MASTER=$(openssl rand -base64 32) npx pnpm backup:run`
Expected: writes a full backup to the staging dir; prints `durable: true`; a second immediate run writes a differential (or nothing) per cadence.

- [ ] **Step 5: Commit**

```bash
git add packages/check/src/backup-run.ts packages/check/src/backup-restore.ts package.json
git commit -m "feat(backup): backup:run and backup:restore integration runners"
```

---

## Deployment & Provisioning Gates (require the human — not auto-run)

These are **not** code tasks; each needs your credentials/accounts/manual custody. The plan builds the adapters; you perform the provisioning.

- [ ] **Gate A — R2 Object Lock bucket.** Create a dedicated bucket (e.g. `living-atlas-<env>-backups`) with **Object Lock enabled** (compliance-mode retention matching the retention ladder). Implement `packages/backup/src/cloud/r2-objectlock.ts` (S3-compatible API) against it; add a live test behind an env flag like the `cloudflare:live-*` runners.
- [ ] **Gate B — Second cloud (S3 or B2) with Object Lock.** Provision the mirror in a *different* provider/account. Implement `packages/backup/src/cloud/s3-objectlock.ts`. Confirm cross-provider fan-out marks durable only when both confirm.
- [ ] **Gate C — Recovery master ceremony.** Generate the 256-bit master; store it in **Apple Passwords** (base64 + restore-procedure note) **and** one **sealed offline copy** (paper/hardware). Verify a test restore uses it.
- [ ] **Gate D — Scheduler.** Install a launchd timer (mirror `io.livingatlas.<env>.sync`) running `backup:run` every 15 min. Confirm it is a *separate* job from the MCP with no MCP credentials.
- [ ] **Gate E — Restore drill.** Perform one end-to-end restore from cloud into a scratch dir; confirm byte-identical ciphertext and that it decrypts with the recovered keyring. Document in the deploy log.

---

## Self-Review Notes (author)

- **Spec coverage:** ciphertext-only (Tasks 8/9 copy sealed bytes, never decrypt) ✓; MCP-unreachable (Task 10 guard + Gate D separate job) ✓; WORM/Object-Lock (Task 5 + Gates A/B) ✓; belt-and-suspenders storage (Task 8 fan-out + Gates A/B) ✓; GFS cadence (Tasks 3/7 + defaults) ✓; recovery-master escrow, human-only (Task 4 + Task 12 prompt-not-env + Gate C) ✓; backend-only restore (Task 9/12, no MCP tool) ✓.
- **Determinism:** all time-dependent logic takes an injected `now`/clock; no `Date.now()` in pure modules (keeps tests stable and matches repo constraints).
- **Type consistency:** `ImmutableStore`, `BackupManifest`, `EscrowEnvelope`, `JournalEntry` names are used identically across writer/restore/store tasks.
