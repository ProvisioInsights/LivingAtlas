# Getting Started — Install, Configure, Connect

This guide takes you from a fresh clone to an MCP client (Claude Desktop,
Claude Code, Codex, or any MCP-capable agent) reading and writing your Living
Atlas knowledge graph over the **local MCP** surface.

Living Atlas is a private-first, encrypted knowledge graph. Your data lives in
a local encrypted replica and — optionally — as host-blind ciphertext on
Cloudflare. The **local MCP** gives a trusted client full plaintext CRUD over
nodes and edges using keys held only on your machine. Nothing in this guide
sends your data anywhere; remote sync is opt-in and covered separately.

> Notation: `<repo-root>` is your local clone of this repository. `<env>` is a
> deployment/environment name you choose (e.g. `personal-prod`). Replace
> angle-bracket placeholders with your own values.

## 1. Prerequisites

- **Node.js 20+** and **pnpm** (the repo pins a version; `npx pnpm@<pinned>` works without a global install).
- **macOS** for the Keychain-backed secret flow below. On Linux/Windows, substitute your OS secret store or environment variables — the tooling resolves secrets from env vars if a Keychain service isn't configured.
- (Optional, for remote sync only) a **Cloudflare account** with Workers, D1, R2, and Durable Objects. See [Cloudflare-first bootstrap](architecture/cloudflare-first-bootstrap-and-local-sync.md).

## 2. Install

```bash
git clone https://github.com/ProvisioInsights/LivingAtlas.git
cd LivingAtlas
npx pnpm@<pinned> install     # see README for the pinned version
npx pnpm@<pinned> check       # typecheck + tests + repo-safety gate
```

## 3. Try it immediately (empty in-memory graph)

The fastest way to see the MCP surface — no real data, no keys:

```bash
npm run atlas-mcp:consumer -- --audit-log /tmp/living-atlas-audit.jsonl
```

This starts an MCP **stdio** server on protocol revision **2026-07-28** over an
**empty** in-memory graph, because no store was named. It serves the surface, not
data: `server/discover`, the twelve published tools, the envelope rules, and the
escalation path. Start with `atlas.contract.describe.v1` (the live vocabularies,
limits and history floor) and `atlas.scope.describe.v1` (your credential's
grant). Step 6 points the same binary at a store you already have.

> The server runs `legacy: 'reject'`. A client that opens with a 2025-era
> `initialize` is refused with `-32022` and told which revision is supported,
> rather than served responses it has no schema for. Point a 2026-07-28 client
> at it.

The operator plane — migration windows, sync control, usage, the review queue —
is a separate server sharing zero tool names:

```bash
npm run atlas-mcp:operator -- --audit-log /tmp/living-atlas-operator-audit.jsonl
```

When you're ready for your own encrypted graph, continue below.

## 4. Configure your encrypted local replica

Living Atlas keeps three things per environment, all outside the repo:

| Component | Purpose |
|---|---|
| **Keyring** (`keyring.json`) | Sealed access-class keys that encrypt your objects at rest. |
| **Control store** (`control-store.json`) | Encrypted identity/capability/config plane. |
| **Graph** (`graph/`) | Encrypted snapshot + append-only journal of your nodes and edges. |

The default replica directory is
`~/Library/Application Support/LivingAtlas/<env>` (override with
`LIVING_ATLAS_LOCAL_REPLICA_DIR`). Follow the first-run runbook to create and
seal these — [Development Readiness Checklist](development-readiness.md) and
[Cloudflare-first bootstrap](architecture/cloudflare-first-bootstrap-and-local-sync.md).

### Store secrets in the OS keychain (recommended)

Never keep passphrases in the replica's env file. Store them in the macOS
Keychain and reference them by **service name**:

```bash
# Store (once, per environment):
security add-generic-password -U -a "$USER" -s io.livingatlas.<env>.keyring        -w '<keyring-passphrase>'
security add-generic-password -U -a "$USER" -s io.livingatlas.<env>.control-store  -w '<control-store-passphrase>'
security add-generic-password -U -a "$USER" -s io.livingatlas.<env>.mcp-token      -w '<local-mcp-token>'
```

The tooling resolves a secret from `<VAR>` directly, or from a Keychain service
named in `<VAR>_KEYCHAIN_SERVICE`. Your replica's `local-runtime.env` should
therefore contain only service references, e.g.:

```
LIVING_ATLAS_LOCAL_KEYRING_PASSPHRASE_KEYCHAIN_SERVICE="io.livingatlas.<env>.keyring"
LIVING_ATLAS_LOCAL_CONTROL_STORE_PASSPHRASE_KEYCHAIN_SERVICE="io.livingatlas.<env>.control-store"
LIVING_ATLAS_LOCAL_MCP_TOKEN_KEYCHAIN_SERVICE="io.livingatlas.<env>.mcp-token"
```

### (Optional) import an existing Logseq/Obsidian graph

If you have a Logseq or markdown vault, see the semantic import flow
(`logseq:semantic-local-import` and the `docs/temporal-edge-model/` schema).
Import runs locally and encrypts as it goes; nothing leaves your machine.

## 5. A launch wrapper for the local MCP

Create a small wrapper that resolves secrets from the keychain and launches the
local MCP against your real replica. Keep it outside the public repo (e.g. in a
private deploy overlay). Example:

```bash
#!/usr/bin/env bash
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"
REPLICA="$HOME/Library/Application Support/LivingAtlas/<env>"
REPO="<repo-root>"

export LIVING_ATLAS_LOCAL_REPLICA_DIR="$REPLICA"
export LIVING_ATLAS_LOCAL_CONTROL_STORE="$REPLICA/control-store.json"
export LIVING_ATLAS_LOCAL_KEYRING="$REPLICA/keyring.json"
export LIVING_ATLAS_LOCAL_GRAPH_DIR="$REPLICA/graph"
export LIVING_ATLAS_LOCAL_SYNC_OUTBOX_DIR="$REPLICA/outbox"
export LIVING_ATLAS_ACTIVITY_LOG="$REPLICA/activity.jsonl"
export LIVING_ATLAS_AUDIT_LOG="$REPLICA/audit.jsonl"
# Secrets resolved from the keychain at launch (never written to disk):
export LIVING_ATLAS_LOCAL_CONTROL_STORE_PASSPHRASE="$(security find-generic-password -s io.livingatlas.<env>.control-store -w)"
export LIVING_ATLAS_LOCAL_KEYRING_PASSPHRASE="$(security find-generic-password -s io.livingatlas.<env>.keyring -w)"
```

These are the paths and secrets the local tooling in `packages/check` resolves —
the backup, restore, import, reconciliation and readiness runners. Source this
file before running any of them.

## 6. Connect an MCP client

The 30-tool local server — with its daemon, its `0600` Unix-socket proxy and its
loopback Streamable HTTP listener — is retired (see
[ADR 0017](architecture/adr-0017-retiring-the-legacy-local-surface.md)). Its
replacement is `packages/atlas-mcp`.

**Pointing it at a store.** `LIVING_ATLAS_STORE_DIR` names a durable store that
already exists — one root holding `assertions/` and `identity/` segment logs. It
is opened **read-only** unless `LIVING_ATLAS_STORE_MODE=read-write`, because
new-format backup does not exist yet and anything written into the new store is
unprotected until it does. A directory that is not there is a startup failure,
never an empty graph. See
[ADR 0028](architecture/adr-0028-serving-a-durable-store-from-a-directory.md).

⚠ **Still open, and open rather than decided.** Migrating your own data INTO that
store is a separate act, and this entry point authenticates nobody: it holds one
fixed credential whose grant reaches the `open` tier only, so content at
`local-private` — the tier anything unclassified is stamped with — arrives as
redaction stubs rather than records. A credential directory on this entry point
has not been built. Your legacy replica is untouched and read-only either way,
and `packages/backup` still backs it up.

Omit the variable and the config below connects to the surface: every tool
answers with an empty result.

```jsonc
// Claude Code .mcp.json / Claude Desktop claude_desktop_config.json
{
  "mcpServers": {
    "living-atlas": {
      "command": "npx",
      "args": ["tsx", "packages/atlas-mcp/src/cli.ts", "--audit-log", "/absolute/path/to/audit.jsonl"],
      "cwd": "/absolute/path/to/LivingAtlas",
      // Omit `env` entirely for the surface-only server. With it, the store must
      // already exist: a directory that is not there is a startup failure.
      "env": { "LIVING_ATLAS_STORE_DIR": "/absolute/path/to/store" }
    }
  }
}
```

> **Client protocol revision matters.** The server accepts **2026-07-28 only**.
> Clients still on a 2025 revision will be refused with `-32022` until they
> update. That is intended: a dual-era server would have to guess which contract
> a response is being validated against.

> **ChatGPT and other remote/web clients** cannot spawn a local stdio process —
> they need a hosted HTTP MCP URL. That is the **remote** MCP surface, which
> requires deploying the Cloudflare worker and (for private data) the cloud-unlock
> access mode. See [Access Modes](architecture/access-modes.md) and
> [Data Tiering](architecture/data-tiering.md).

## Local-only MVP proof and recovery

Before using any owner corpus, run the synthetic, no-network acceptance proof:

```bash
npm run mvp:local-proof
```

It creates and removes its own temporary sealed control store, keyring, graph,
activity/audit logs, WORM backup, and separate restored replica. Its output is
limited to status, counts, and hashes. It proves import, authenticated query and
correction, restart persistence, backup, restore, and failed-restore source
protection without reading an owner profile or corpus.

The one-corpus local import command requires an explicit acknowledgement and
private paths supplied only in the operator's environment. It records redacted
per-source terminal outcomes (`imported`, `quarantined`, or `skipped`) and
defaults imported content to `local-private`; ambiguous relationships remain
quarantined. Do not run it against an owner corpus without that owner's explicit
approval for that operation.

For recovery, `npm run backup:restore -- --backup-id <id> --store <local-worm-store> --out <empty-dir>`
prompts for the recovery master and reconstructs `<empty-dir>/graph/snapshot.json`,
an empty journal, and `<empty-dir>/keyring.json`. It refuses a non-empty output
directory and never alters the source replica. Restore currently accepts only a
full backup; it deliberately rejects a differential backup until chain restore
is implemented.

## 7. Verify

After restarting your client, it should list the Living Atlas tools. A quick
`status` call returns your authority id and object counts. The full toolset:

- **Nodes:** `object_list`, `object_read`, `object_create`, `object_update`, `object_delete`, `object_batch`
- **Edges:** `edge_create`, `edge_read`, `edge_update`, `edge_delete`, `edge_batch`
- **Query:** `search`, `traverse`, `timeline`
- **Ops:** `status`, `activity_read`, `access_modes`, `sync_status`, and (in cloud-unlock sessions) `sensitive_decrypt`

## 8. Next steps

- **Relationship model** — the typed edge/entity ontology: [Temporal Edge Model](temporal-edge-model/README.md), [MCP Tools](mcp-tools.md).
- **Remote sync (optional)** — put your graph on Cloudflare as host-blind ciphertext: [Cloudflare-first bootstrap](architecture/cloudflare-first-bootstrap-and-local-sync.md), [Private overlay repo](deployment/private-cloudflare-overlay-repo.md).
- **Data tiering (optional)** — make normal data cloud-decryptable while keeping sensitive data behind a second escalation key: [Data Tiering](architecture/data-tiering.md).
- **Security model** — [Access Modes](architecture/access-modes.md), [Security & Access Model](architecture/security-and-access-model.md).
