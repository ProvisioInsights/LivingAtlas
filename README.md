# Living Atlas

[![CI](https://github.com/ProvisioInsights/LivingAtlas/actions/workflows/ci.yml/badge.svg)](https://github.com/ProvisioInsights/LivingAtlas/actions/workflows/ci.yml)

Living Atlas is a private-first knowledge graph system for a
Logseq/Obsidian-inspired graph. It stores complete graph bytes in a Cloudflare
deployment for anywhere access, keeps sensitive plaintext available only to
local/keyholding clients, and exposes policy-scoped MCP surfaces so local tools
can see the full authorized graph while remote AI providers only see approved
remote-readable data.

## System Layers

Living Atlas has two tightly linked halves:

- **Runtime architecture:** storage, Cloudflare/local materialization,
  encryption, sync, MCP access, CRUD, audit, conflict handling, and privacy
  boundaries.
- **Knowledge semantics:** nodes, edges, predicates, events, bitemporal dates,
  relationship vocabulary, and Logseq/Obsidian migration semantics.

They are one product. If the two tracks appear to conflict, runtime/security
architecture controls where data lives and who can access it; temporal-edge
docs control what graph facts mean.

## Document Map

- [PRD](docs/product/prd.md) - product goals, users, requirements, non-goals.
- [Architecture Requirements](docs/architecture/ard-0001-system-architecture.md) - system shape and constraints.
- [V1 Architecture Decisions](docs/architecture/v1-architecture-decisions.md) - accepted V1 runtime and privacy decisions.
- [Knowledge Schema Runtime Integration](docs/architecture/knowledge-schema-runtime-integration.md) - how temporal-edge semantics map onto the runtime/storage architecture.
- [ADR 0001](docs/architecture/adr-0001-local-first-host-blind-sync.md) - Cloudflare byte custody with local-key sensitive sync.
- [ADR 0002](docs/architecture/adr-0002-policy-scoped-mcp.md) - separate local and remote MCP authority.
- [ADR 0003](docs/architecture/adr-0003-append-only-crud-ledger.md) - visible, auditable CRUD history.
- [Runtime Topology Options](docs/architecture/runtime-topology-options.md) - chosen V1 topology plus alternate deployment profiles.
- [Cloudflare-First Bootstrap And Local Sync](docs/architecture/cloudflare-first-bootstrap-and-local-sync.md) - first deployment, safe authority claim, browser-keyed setup, local link, and sync.
- [Public Repo And Personal Cloudflare Deployment](docs/architecture/public-repo-personal-cloudflare-deployment.md) - public template/repo boundaries, Terraform/Wrangler split, and private personal deployment state.
- [Remote-Primary With Local Sensitive Path](docs/architecture/remote-primary-local-sensitive-federation.md) - remote MCP for normal work, local/keyholding path for sensitive plaintext, and future federation hooks.
- [Local MCP Boundary](docs/architecture/local-mcp-boundary.md) - local MCP as private authority and release producer, not a remote-call backend.
- [Complete Cloudflare Custody Diagram](docs/architecture/complete-cloudflare-custody-diagram.md) - Cloudflare stores the complete graph while sensitive content remains local-key-only.
- [Live Graph Activity And Audit](docs/architecture/live-graph-activity-and-audit.md) - near-live graph firing view plus repeatable CRUD audit/replay.
- [100M Scale Plan](docs/architecture/scale-plan-100m.md) - segmented storage, indexes, compaction, and sync design for large graphs.
- [Offline Sync And Conflict Resolution](docs/architecture/offline-sync-and-conflict-resolution.md) - continuous sync, offline queues, generations, and conflict handling.
- [Key Management](docs/architecture/key-management.md) - KEK/DEK hierarchy, envelopes, device enrollment, revocation, and release keys.
- [Access Modes](docs/architecture/access-modes.md) - remote-safe, cloud-unlock session, and local-keyholding security modes.
- [Identity, Configuration, And Key Control Plane](docs/architecture/identity-configuration-control-plane.md) - user/device/client setup, capability grants, key config, recovery, and admin surfaces.
- [Event Subsystems](docs/architecture/event-subsystems.md) - sync change log, durable audit ledger, and live activity stream.
- [MCP Tools](docs/mcp-tools.md) - canonical local/remote MCP tool catalog, access modes, batching, and Praxis integration notes.
- [Metadata Leakage Budget](docs/architecture/metadata-leakage-budget.md) - Cloudflare-visible metadata and path/index constraints.
- [Compaction And Retention](docs/architecture/compaction-and-retention.md) - tombstones, snapshots, long-offline clients, and erasure.
- [Local MCP Authentication](docs/architecture/local-mcp-authentication.md) - local auth, capabilities, admin mode, and localhost threat model.
- [Security and Access Model](docs/architecture/security-and-access-model.md) - trust tiers, encryption, policy enforcement.
- [CRUD Observability](docs/architecture/crud-observability.md) - how create/read/update/delete activity is seen and audited.
- [Implementation Plan](docs/implementation-plan.md) - build phases and validation gates.
- [Development Readiness Checklist](docs/development-readiness.md) - first build slice, pre-deploy gates, and before-real-data tests.
- [Private Cloudflare Deployment Overlay](docs/deployment/private-cloudflare-overlay-repo.md) - recommended private repo pattern for account-specific Cloudflare deployment state.
- [Temporal Edge Model](docs/temporal-edge-model/README.md) - schema package entrypoint for edge/event ontology and migration semantics.
- [Contributing](CONTRIBUTING.md), [Security](SECURITY.md), and [Code of Conduct](CODE_OF_CONDUCT.md) - public collaboration and reporting policies.

## Working Thesis

Living Atlas is not a single hosted plaintext brain. It is one knowledge graph
with Cloudflare complete custody, a local complete replica, access-classed
objects, and separate capability surfaces:

- Cloudflare custody: complete graph bytes, including sensitive ciphertext.
- Remote MCP: Cloudflare-hosted CRUD for remote-readable data.
- Local replica: complete graph bytes plus local decrypted/indexed views.
- Local MCP: full authorized graph CRUD with local keys.
- Cloud-unlock session: optional remote convenience mode where a transient key
  may unlock sensitive content in the cloud runtime, without key persistence,
  when runtime-memory exposure is acceptable.
- Sensitive objects: plaintext CRUD only through keyholding client/local path.
- Praxis-facing contracts: headless activity, audit, replay, and graph APIs
  that a UI or operator runtime can consume without moving UI code into Atlas.

## Current Status

Phase 1 scaffold exists as a TypeScript workspace. It includes contracts,
synthetic fixtures, access policy evaluation, metadata leakage scanning,
readiness check commands, Cloudflare first-claim bootstrap, fixture-backed local
MCP tools, a sealed local keyring, an encrypted local graph store, sync batch
persistence for remote-readable plaintext and sensitive ciphertext envelopes,
envelope pull/replay, a token-gated remote MCP with
remote-readable graph CRUD, edge CRUD, deterministic text search, bounded graph
traversal, timeline queries, cloud-unlock decrypt for v1 AES-GCM inline
ciphertext envelopes, and hash-only replay reporting over audit/activity/
operational events. It also includes a token-gated usage/budget endpoint that
reports provider-neutral observed usage against configurable limits. It does
not import real graph data or deploy personal Cloudflare resources.

## Development

For the complete first-run runbook, see
[Development Readiness Checklist](docs/development-readiness.md).

First-run synthetic sequence:

```bash
npx pnpm@11.8.0 install
npm run check
npm run smoke:local
npm run local:deploy-synthetic
npm run cloudflare:wrangler-smoke
npm run preflight:synthetic
```

These commands use synthetic fixtures and public-safe templates. They must not
import real graph data, claim a real authority, publish personal Cloudflare
values, or replace placeholder config with private deployment state.

Install with the pinned package manager:

```bash
npx pnpm@11.8.0 install
```

Run the local gate:

```bash
npm run check
```

Run the two synthetic local smoke flows:

```bash
npm run smoke:local
```

`local:install-smoke` exercises the local install mode: it creates a sealed
local control store and sealed local keyring, starts the local MCP over stdio,
calls the fixture graph read and synthetic CRUD tools, creates a local-private
plaintext draft through the MCP, and checks activity plus encrypted graph files
for token/sensitive-bait/plaintext leakage.
`cloudflare:local-smoke` exercises the Worker bootstrap and sync routes
in-process with fake D1/R2 bindings.

Run the full synthetic local deployment exercise before looking at Cloudflare:

```bash
npm run local:deploy-synthetic
```

This creates a temporary local profile, writes an encrypted local control
store, starts the local MCP over stdio, performs synthetic read/create/update/
tombstone operations, boots the local Worker harness, claims bootstrap, pushes
and pulls ciphertext sync batches through the sync daemon, checks stale and
bad-token-binding rejection, and scans the resulting local artifacts for
token/sensitive-bait leakage.

Run the local stress gate when changing CRUD, policy, sync, or leakage code:

```bash
npm run stress:local
```

Check deployed synthetic usage before running any live Cloudflare stress:

```bash
npm run cloudflare:live-usage-gate
npm run cloudflare:live-ops-report
npm run cloudflare:live-crud-tiny
```

This performs hundreds of synthetic local CRUD operations in one run, including
duplicate creates, stale updates, invalid versions, empty patches, oversized
objects, store-limit enforcement, tombstones, audit/activity checks, and leakage
scans. It also pushes many one-generation ciphertext sync batches through the
local Worker harness, verifies D1/R2 counts, pulls the batch summaries back, and
checks malformed, stale, generation-gap, replay, bad-token, bad-binding,
query-token, and invalid-pull behavior.

Run the full synthetic preflight before any Cloudflare deployment work:

```bash
npm run preflight:synthetic
```

This runs the repo gate, the full synthetic local deployment exercise, the
local stress gate, the Wrangler dry-run smoke, Terraform/OpenTofu formatting,
and Terraform/OpenTofu validation against public-safe example inputs.

`npm run check` runs the repo-safety/leakage check, TypeScript typecheck, and
Vitest suite. The check CLI's default `all` mode runs:

- `local`: contract, policy, leakage, path opacity, and repo-safety checks.
- `cloudflare-deploy-readiness`: synthetic public-template deploy readiness,
  including placeholder Cloudflare bindings, no private deploy values, complete
  fixture manifest coverage, opaque paths, and no sensitive bait in Cloudflare
  metadata.
- `first-run-guardrails`: synthetic bootstrap checks for sealed/unclaimed
  first-run behavior, token-required claim, token burn, concurrent first-claim
  lock behavior, and token-in-query guard coverage.

Run individual checks while iterating:

```bash
npx tsx packages/check/src/cli.ts local
npx tsx packages/check/src/cli.ts cloudflare-deploy-readiness
npx tsx packages/check/src/cli.ts first-run-guardrails
npx tsx packages/check/src/cli.ts wrangler-local-runtime
```

`npx pnpm@11.8.0 check` works too and uses the same underlying gate.

Validate the Cloudflare infrastructure skeleton:

```bash
npm run infra:fmt
npm run infra:validate
```

Build the Worker example without deploying:

```bash
npx wrangler@4.103.0 deploy --dry-run \
  --config packages/cloudflare-worker/wrangler.example.jsonc \
  --outdir /tmp/living-atlas-worker-dry-run
```

This dry run is synthetic-only. It should validate the public Worker template,
not claim an authority, upload real graph data, or publish personal Cloudflare
account values. A real deployment uses a private/ignored overlay for the
Cloudflare account, resource ids, deploy token, bootstrap claim-token hash, sync
token hash, domains, and state.

Workspace packages:

- `@living-atlas/contracts`: object envelopes, identity/config records,
  capability types, temporal edge/event validators, audit/change contracts, and
  operational observability events.
- `@living-atlas/fixtures`: synthetic-only fixture graph with sensitive bait and
  remote-safe content.
- `@living-atlas/policy`: capability-bound policy evaluator and output filters.
- `@living-atlas/leakage`: bait-string scanner, opaque Cloudflare path helpers,
  and public-repo safety scanner.
- `@living-atlas/check`: local scaffold verification CLI.
- `@living-atlas/cloudflare-worker`: Cloudflare Worker routes and Durable
  Object first-claim bootstrap lock skeleton, plus token-gated sync batch
  persistence/status, envelope pull through R2/D1 bindings, remote MCP
  remote-readable graph CRUD/search/traversal/timeline/edge tools, and redacted
  structured request observability.
- `@living-atlas/local-control-store`: encrypted local authority/control-plane
  state store, local profile path helpers, and fixture generation tooling.
- `@living-atlas/local-keyring`: sealed local keyring and AES-GCM payload
  encryption helpers for local install mode.
- `@living-atlas/local-graph-store`: durable snapshot/journal graph replica for
  local CRUD and sync replay, with redacted or local-keyring-encrypted
  persistence by policy.
- `@living-atlas/local-mcp`: local trusted-ingress MCP skeleton with bearer
  token capability checks, sealed control-store loading, fixture graph
  status/list/read plus synthetic CRUD tools backed by in-memory fixtures or the
  durable local graph store, redacted audit events, and optional durable
  mutation outbox files for bidirectional sync daemon pickup.
- `@living-atlas/sync-agent`: local sync-agent that builds ciphertext batches,
  drains durable local MCP outbox files through a bidirectional push handshake,
  submits to the Worker sync route, fetches remote summaries/envelopes, and
  applies pulled envelopes into the local graph store with version-conflict
  reporting and bounded conflict samples.
- `@living-atlas/atlas-client`: dependency-light TypeScript client helpers for
  Praxis and other consumers calling remote MCP, activity, and usage surfaces
  with token headers and redacted error details.
- `@living-atlas/activity-replay`: hash-only replay inspection and reporting
  over durable audit, live activity, and operational observability events.
- `@living-atlas/cloudflare-worker` also exposes `/api/usage/status` for
  health-token-gated observed usage and configurable budget ratios. The
  response shape is generic so non-Cloudflare deployments can implement the
  same contract with provider-specific collectors.
- The Worker and remote MCP also expose a `living-atlas-usage-gate:v1`
  safe-to-test/stop-testing decision. The gate is tunable per deployment and is
  intended to fail closed before live synthetic stress runs.
- `cloudflare:live-ops-report` adds a compact operator report over the gate and
  provider-side inventory available through bound Cloudflare services, including
  R2 object count/byte reconciliation.
- `cloudflare:live-local-outbox-drain` runs one live local replica outbox drain
  through the bidirectional push handshake after the deployed usage gate passes
  and the explicit mutation acknowledgement is set.

Semantic Logseq migration uses bounded, plaintext-free planning and ledger
commands:

```bash
npm run logseq:semantic-manifest
npm run logseq:semantic-estimate
npm run logseq:semantic-batch-plan
npm run logseq:semantic-local
npm run logseq:semantic-parity
npm run logseq:semantic-ledger-report
```

`logseq:semantic-manifest` creates a plaintext-free corpus manifest with one
entry per discovered file, including readable, empty, oversized, and ignored
files. `logseq:semantic-batch-plan` reads a configured private markdown root and
emits only counts, offsets, object totals, and opaque root refs.
`logseq:semantic-estimate` scans the selected source mode and emits counts-only
object and sync-batch estimates before any live mutation.
`logseq:semantic-local` preserves each original file as an encrypted source
capsule, runs local CRUD/leakage proof, and writes per-file parity refs into the
durable ledger without Cloudflare sync. `logseq:semantic-cloudflare` uses the
same parity path but requires an explicit sync mode plus mutation
acknowledgement before it can split and submit live Cloudflare sync batches.
`logseq:semantic-ledger-report`
can run as a hard completion gate with
`LIVING_ATLAS_LOGSEQ_SEMANTIC_REQUIRE_COMPLETE=1`. Manifest entries with a
terminal `skipped` or `quarantined` decision are reported as terminal accounting
outcomes; they do not require ledger objects unless they were readable semantic
markdown entries.

`LIVING_ATLAS_LOGSEQ_SEMANTIC_SYNC_MODE` defaults to `local-only`. Cloudflare
sync is paused unless `LIVING_ATLAS_LOGSEQ_SEMANTIC_SYNC_MODE=cloudflare` and
`LIVING_ATLAS_LOGSEQ_SEMANTIC_SYNC_ACK=sync-semantic-ciphertext-to-cloudflare`
are both set. Local-only mode rejects stale sync/backfill acknowledgements so a
shell with old mutation env vars cannot accidentally push. Local-only mode can
use larger bounded windows via `LIVING_ATLAS_LOGSEQ_SEMANTIC_FILE_COUNT`; live
Cloudflare and backfill modes stay capped to smaller mutation-safe windows.

Set `LIVING_ATLAS_LOGSEQ_SEMANTIC_SOURCE_MODE` to choose the corpus slice:

- `markdown-only`: only `.md` / `.markdown` files.
- `logseq-notes`: markdown files plus extensionless Logseq `pages/` and
  `journals/` notes.
- `logseq-extensionless-only`: only extensionless Logseq `pages/` and
  `journals/` notes.

Use separate ledger paths for materially different source modes. Offsets are
relative to the selected source mode and must not be mixed across ledgers.
Hidden filesystem artifacts and dotfiles, including `.fuse_hidden*` files, are
excluded from semantic source discovery.

For legacy semantic imports that already synced the graph objects before
source-capsule refs existed, set
`LIVING_ATLAS_LOGSEQ_SEMANTIC_SYNC_MODE=cloudflare` plus
`LIVING_ATLAS_LOGSEQ_SEMANTIC_SYNC_SCOPE=source-capsules-only` with the live
sync acknowledgement. That pushes only the encrypted source capsules and marks
the batch complete only when the old synced object count plus the new capsules
matches the recomputed plan.

Launch the fixture local MCP server with generated synthetic control state:

```bash
LIVING_ATLAS_LOCAL_MCP_TOKEN='replace-with-local-dev-token' \
npm run local-mcp:fixture
```

Run it from an MCP client or the Inspector; a direct terminal run waits on
stdio.

Create an encrypted synthetic local control store for local MCP development:

```bash
LIVING_ATLAS_LOCAL_CONTROL_STORE=/tmp/living-atlas-control-store.json \
LIVING_ATLAS_LOCAL_CONTROL_STORE_PASSPHRASE='replace-with-local-dev-passphrase' \
LIVING_ATLAS_LOCAL_MCP_TOKEN='replace-with-local-dev-token' \
npm run local-control:fixture-store
```

Then launch the fixture local MCP server from that sealed store:

```bash
LIVING_ATLAS_LOCAL_CONTROL_STORE=/tmp/living-atlas-control-store.json \
LIVING_ATLAS_LOCAL_CONTROL_STORE_PASSPHRASE='replace-with-local-dev-passphrase' \
npm run local-mcp:fixture
```

Cloudflare templates:

- `packages/cloudflare-worker/wrangler.example.jsonc`: public-safe Worker
  config example with placeholder bindings and no bootstrap secret.
- `infra/cloudflare/modules/living-atlas-single-authority`: reusable
  Terraform/OpenTofu module for R2, D1, and KV resources.
- `infra/cloudflare/examples/single-authority`: public-safe validation example
  that expects the Cloudflare account id from private environment input.

Cloudflare is the complete graph byte custodian, not the plaintext authority.
Sensitive/local-private graph content is stored in Cloudflare as ciphertext and
opaque metadata; only local or browser keyholding clients decrypt it and build
full private indexes. Remote MCP may serve explicitly remote-readable
projections, but that is separate from the private graph ciphertext source of
truth.
