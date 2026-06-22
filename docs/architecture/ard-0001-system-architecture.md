# ARD 0001: Living Atlas System Architecture Requirements

Status: Draft  
Date: 2026-06-21

## Purpose

Define the architecture requirements for the new Living Atlas repo before
implementation begins. This is not a final low-level design. It sets the
constraints the implementation must satisfy.

## Architectural Position

Living Atlas is a Cloudflare-custodied private knowledge graph with a complete
local replica, local-key protection for sensitive plaintext, and policy-scoped
MCP access for local and remote AI tools.

It is not:

- A hosted plaintext graph database.
- A remote-first plaintext SaaS note app.
- A visualization-only toy.
- A prompt-only privacy system.

## System Components

### Local Graph Store

Complete local materialization:

- Complete graph bytes synced from Cloudflare custody.
- Sensitive plaintext only after local decrypt.
- Local generated indexes.
- Optional markdown import/export or authoring compatibility.

The graph must remain usable locally without cloud connectivity.

### Local Indexer

Responsibilities:

- Watch source files.
- Parse imported/exported pages, blocks, properties, links, edges, and events
  where markdown compatibility is enabled.
- Validate ontology and policy labels.
- Build full local index.
- Build remote-readable indexes from allowed content.
- Emit graph health and quarantine reports.

### Local MCP

Responsibilities:

- Full graph read access under local operator control.
- Guarded write intents by default.
- Raw admin writes only in explicit local admin mode.
- Authenticated local transport and per-client capabilities.
- CRUD ledger emission for every read, write, denial, and policy decision.
- Local search and local semantic search over decrypted data.

### Identity And Configuration Control Plane

Responsibilities:

- Bootstrap the first authority, user, trusted device, local admin capability,
  and local MCP credential.
- Configure MCP clients, capability grants, policy generations, device
  enrollment, revocation, recovery, and key rotation.
- Store local sensitive configuration in the local profile/keyring.
- Store only opaque/public/wrapped control records in Cloudflare.
- Emit audit events for every user, device, client, capability, recovery, and
  key configuration change.

### Atlas UI

Responsibilities:

- Read-oriented graph exploration.
- Temporal and provenance inspection.
- Policy visibility inspection.
- Activity and CRUD ledger inspection.
- Review queues for quarantined facts, invalid ontology entries, and policy
  gaps.

### Sync Agent

Responsibilities:

- Package graph changes into encrypted remote objects.
- Pull remote encrypted objects for trusted devices.
- Maintain local sync state.
- Detect conflicts.
- Avoid leaking sensitive content through object names or manifests.
- Exchange generation manifests, change segments, and snapshots without listing
  the full object store.

### Cloud Sync Endpoint

Responsibilities:

- Authenticate device or remote MCP clients.
- Store and retrieve complete graph bytes.
- Store remote-readable plaintext objects and sensitive ciphertext envelopes.
- Enforce rate limits and coarse authorization.
- Store minimal metadata needed for sync.
- Avoid holding keys that decrypt sensitive plaintext.

### Remote MCP

Responsibilities:

- Expose a constrained MCP tool surface to remote AI providers.
- Run on Cloudflare in V1.
- Serve and CRUD only remote-readable objects.
- Custody/version/tombstone sensitive ciphertext envelopes without semantic
  plaintext access.
- Deny access outside scope.
- Log both reads and denied attempts.
- Never gain sensitive plaintext decryption authority.

## Data Flow

```text
Cloudflare custody
  -> sync pull
  -> local complete replica
  -> local decrypt/index
  -> local MCP and Atlas

Local/keyholding client
  -> sensitive plaintext CRUD
  -> authenticated encrypted envelope
  -> Cloudflare custody
  -> sync to local replicas

Remote AI provider
  -> remote MCP auth
  -> policy check
  -> remote-readable objects only
  -> CRUD/read ledger event
```

## Required Trust Boundaries

1. Local trusted device boundary.
2. Remote cloud storage boundary.
3. Remote AI provider boundary.
4. Human collaborator boundary.
5. Generated projection boundary.

The system must make these boundaries visible in code, configuration, and UI.

## Storage Requirements

### Local

- Complete graph bytes and local indexes are canonical for the running system.
- Markdown compatibility remains important for import/export and authoring, but
  markdown files are not the only runtime store.
- Generated indexes are rebuildable.
- Local caches can use SQLite, DuckDB, or JSON as implementation detail.
- Local private data can be plaintext on trusted disk only if the operator
  accepts local machine trust.

### Cloud

- Store complete graph bytes.
- Store remote-readable plaintext objects where explicitly classified.
- Store sensitive objects as ciphertext envelopes.
- Store opaque manifests.
- Store only minimal metadata.
- Treat object path naming as part of the privacy model.
- Avoid remote plaintext D1/Vectorize indexes for private graph content.

## Policy Requirements

Policy enforcement must happen before tool output is produced.

Required policy dimensions:

- Authority/user identity.
- Actor: user, local agent, remote provider, sync agent, automation.
- Device: trusted laptop, other trusted device, cloud runtime.
- MCP client and capability grant.
- Scope: full graph, remote-safe, shareable, release, quarantine.
- Operation: create, read, update, delete, sync, classify, export.
- Data class: page, block, edge, event, attachment, index, embedding, summary.

## CRUD Ledger Requirements

Every security-relevant operation must emit an event:

- `create`
- `read`
- `update`
- `delete`
- `archive`
- `redact`
- `sync-push`
- `sync-pull`
- `policy-allow`
- `policy-deny`
- `quarantine`
- `decrypt`
- `export`

Events must include:

- event id
- event type
- actor id
- provider/client id
- device id
- operation
- object reference
- policy decision
- timestamp
- source tool call id when available
- before/after hashes where relevant
- checkpoint or segment hash for tamper evidence

## Security Requirements

- Full graph decryption keys do not exist in the remote MCP or cloud Worker.
- Sensitive plaintext keys do not exist in the remote MCP or cloud Worker.
- Remote-readable indexes must contain only allowed content.
- Embeddings are sensitive and must inherit the strictest source label.
- Remote reads must be logged even when they return no content.
- Deletes must be recoverable locally unless explicitly cryptographic erasure is
  requested and confirmed.

## Validation Gates

Before implementation is considered viable:

- Unit tests prove policy filters exclude private content from remote outputs.
- Golden fixture tests prove derived indexes do not contain private source
  strings.
- Integration tests prove local MCP can access full fixture while remote MCP
  cannot.
- CRUD ledger tests prove read/write/delete/deny events are emitted.
- Sync tests prove cloud objects are ciphertext and use opaque names.
- Remote-readable CRUD tests prove Cloudflare-hosted remote MCP works without
  local tunnel dependency.
- Local MCP auth tests prove localhost access is authenticated.
- Metadata leakage tests prove Cloudflare-visible paths/manifests/indexes do
  not contain fixture secrets.
- Atlas screenshot tests show policy mode and activity ledger surfaces.

## Open Architecture Questions

- Which local database, if any, should back the hot query cache?
- Should sync conflict resolution be CRDT-based, checkpoint-based, or
  intent-ledger-based in v1?
- Should remote-safe bundles be re-encrypted per provider or per device?
- How much of the ledger should be stored inside the graph versus outside it?
