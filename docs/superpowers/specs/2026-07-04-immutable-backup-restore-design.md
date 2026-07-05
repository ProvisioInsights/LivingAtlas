# Immutable, MCP-Unreachable Backup + Restore — Design

**Status:** Draft — 2026-07-04. Decisions locked via brainstorming; pending spec review.
**Relationship:** independent of the remote-MCP auth spec (`2026-07-04-remote-mcp-auth-tiered-decryption-design.md`). Can be built in parallel.

## 1. Problem & goals

Provide **ransomware-grade, "just-in-case"** backups of the graph that:

- **the MCP can never delete or tamper with** (accidental or malicious);
- stay **ciphertext-only** — a backup never creates a plaintext exposure;
- run **automatically** on a differential + full cadence with tiered retention;
- can be **restored from a backend, out-of-band path** that is never an MCP tool;
- survive the loss or full compromise of any single storage provider (including Cloudflare).

## 2. Non-goals

- Backups are **not** an MCP-visible feature. No `backup_*` or `restore_*` tool exists, by design.
- Backups do not decrypt or re-tier data; they copy sealed bytes.
- Not a sync mechanism — this is one-way, append-only, immutable retention.

## 3. What is backed up

- The **encrypted graph**: snapshot(s) + append-only journal, exactly as sealed under the keyring's access-class keys (T0/T1/T2). Bytes are already ciphertext; no plaintext ever leaves the boundary.
- A **wrapped copy of the keyring** (the access-class keys), sealed under a **recovery master key**. Stored alongside the ciphertext but useless without the master. Without recovered keys, restored ciphertext cannot be decrypted — so key preservation is part of the backup, not an afterthought.

## 4. MCP-unreachable guarantee (three independent barriers)

1. **Separate privileged writer.** Backups are produced by a dedicated process (extending the sync daemon or a sibling agent), *not* the MCP server. The writer needs only append/write-to-WORM authority — never decrypt authority.
2. **No capability.** The MCP capability set has **no backup-store credentials or routes at all**. A fully compromised MCP cannot address the backup store.
3. **WORM / Object-Lock retention.** The store enforces write-once, immutable retention windows, so even a compromised *host* (including the writer) cannot delete or overwrite within the window.

## 5. Storage — one hard anchor + a soft redundant copy

The overriding invariant is **no data loss, ever**. The design meets it with a single **hard-immutable anchor** (undeletable by anyone within the retention window) plus an independent, vendor-isolated **soft redundant copy** for durability.

- **Hard anchor — Cloudflare R2 with Object Lock (compliance mode).** Same stack, low egress; ciphertext-only, so Cloudflare cannot read it. **Compliance mode** (not governance mode) means *no one — not the account owner, not an attacker with account access, not ransomware — can delete or shorten a locked object until its retention expires.* This single copy carries the zero-loss guarantee, so the writer treats it as critical:
  - **Fail-closed on lock:** every R2 write verifies the `retain-until` lock was actually applied; if Object-Lock retention is missing/misconfigured, the write is a **hard failure** (never silently store an unprotected object).
  - Compliance-mode is mandatory; governance-mode is rejected at config time (it can be bypassed by privileged users).
- **Soft redundant copy — personal (consumer) OneDrive.** The owner's existing personal OneDrive (no Business/M365 tenant, **no Purview, no eDiscovery**), written via simple Graph uploads. Provides vendor-isolated durability plus OneDrive's own versioning, recycle bin, 30-day *Files Restore* rollback, and ransomware detection. **Not hard-WORM** — files here are ultimately deletable — so it is *redundancy*, not the immutability guarantee. (Consumer OneDrive cannot be made WORM; that is a Business/Purview-only capability, explicitly out of scope per owner decision.)
  - **Auth note:** personal OneDrive uses a **consumer Microsoft-account credential**, distinct from any Business/M365 tenant; the writer holds this separately.
- Writes fan out to both; a backup is **"durable" only once the R2 hard anchor confirms with its lock verified** (the OneDrive copy is best-effort redundancy — its failure is logged/alerted but does not by itself define durability, since the hard guarantee lives in R2).
- **Accepted tradeoff (owner decision 2026-07-04):** a single hard anchor rather than two. If R2's locked copy were ever catastrophically lost, the OneDrive fallback is deletable rather than WORM. A local WORM physical drive (the built `LocalWormStore`) remains available as a drop-in second hard anchor if that tradeoff is revisited.

## 6. Cadence & retention (GFS, configurable)

Grandfather-father-son with differential + full. **Default schedule (all configurable):**

| Level | Frequency | Retention |
|---|---|---|
| Differential | every **15 min** | 24 h |
| Differential rollup | hourly | 7 d |
| **Full** | **daily** | 90 d |
| Full | weekly | 1 y |
| Full | monthly | 5 y |

Differentials capture journal deltas since the last full; fulls capture a complete sealed snapshot. Retention tiers prune automatically **outside** any active Object-Lock window (locked objects age out only when their retention expires).

## 7. Key escrow — recovery master

- A single high-entropy **recovery master key** (~256-bit) unwraps the escrowed keyring.
- It is **human-only**: the automated writer never holds it (so a compromised writer can neither read data nor forge a restore).
- **Escrow is pluggable.** Reference owner install: **Apple Passwords (iCloud Keychain)** as primary — E2E-encrypted, synced across the owner's Apple devices, stored as a password entry (base64 key + restore-procedure note) — **plus one sealed offline copy** (paper in a safe or a hardware token) as break-glass. Two different failure domains: an Apple-account loss/compromise alone does not lose or leak the master.
- **Generic default for non-Apple adopters:** offline paper/hardware, or their OS keychain, plus one break-glass copy.

## 8. Restore

- **Backend-only, out-of-band operator action.** Never an MCP tool.
- Procedure: retrieve the recovery master → unwrap the escrowed keyring → fetch the target ciphertext backup (full + replay differentials to the chosen point in time) → decrypt with recovered keys.
- Point-in-time selectable at differential granularity.
- Restore requires physical possession of the recovery master, so a remote attacker with cloud access alone cannot restore (or exfiltrate a usable copy).

## 9. Error handling

- One provider write fails → backup marked **not durable**, retried; alert the owner; never report success on a single-provider write.
- Object-Lock misconfiguration (retention not applied) → hard failure, not a silent unprotected write.
- Writer lacks WORM authority → refuse to run rather than write deletable backups.
- Restore with a wrong/missing master → clean failure; no partial-plaintext leakage.

## 10. Testing

- **MCP cannot delete:** assert no backup capability/route is reachable from any MCP surface; attempt deletion via a compromised-writer simulation and confirm WORM refuses.
- **Ciphertext-only:** scan every backup artifact for plaintext; must be zero.
- **Dual-provider durability:** kill one provider mid-write; confirm not-durable handling and recovery.
- **Restore correctness:** round-trip full+differential restore to a point in time; byte-identical ciphertext; decrypts with recovered keyring.
- **Escrow separation:** confirm neither cloud store alone can restore without the master.

## 11. Deferred / future

- Backup-integrity attestation (periodic verify-restore drills).
- Configurable retention presets per deployment size.
- Optional third escrow location for higher-assurance deployments.
