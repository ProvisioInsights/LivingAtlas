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

## 3. Try it immediately (synthetic fixture mode)

The fastest way to see the local MCP work — no real data, no keys:

```bash
LIVING_ATLAS_LOCAL_MCP_TOKEN="dev-fixture-token" \
  npx tsx packages/local-mcp/src/cli.ts
```

This starts an MCP **stdio** server over a synthetic in-memory graph. Point any
MCP client at that command (see step 6) and you'll have `object_*`, `edge_*`,
`search`, `traverse`, and `timeline` tools against fixture data. When you're
ready for your own encrypted graph, continue below.

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
export LIVING_ATLAS_LOCAL_MCP_TOKEN="$(security find-generic-password -s io.livingatlas.<env>.mcp-token -w)"

cd "$REPO"
exec npx tsx packages/local-mcp/src/cli.ts
```

Save it (e.g. `run-local-mcp.sh`), `chmod +x` it, and use its path in the client
configs below.

## 6. Connect an MCP client

The local MCP is a **stdio** server, so it plugs into any local MCP host. Point
each at your wrapper script.

**Claude Code** — project `.mcp.json` at your repo root, or user-scoped:

```jsonc
{ "mcpServers": { "living-atlas-local": { "command": "/absolute/path/to/run-local-mcp.sh" } } }
```

Or: `claude mcp add -s user living-atlas-local /absolute/path/to/run-local-mcp.sh`

**Claude Desktop** — `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{ "mcpServers": { "living-atlas-local": { "command": "/absolute/path/to/run-local-mcp.sh" } } }
```

**Codex** — `~/.codex/config.toml`:

```toml
[mcp_servers.living-atlas-local]
command = "/absolute/path/to/run-local-mcp.sh"
```

Restart the app after editing its config so it picks up the new server.

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
