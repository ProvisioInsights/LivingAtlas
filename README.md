# Living Atlas

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
- [Identity, Configuration, And Key Control Plane](docs/architecture/identity-configuration-control-plane.md) - user/device/client setup, capability grants, key config, recovery, and admin surfaces.
- [Event Subsystems](docs/architecture/event-subsystems.md) - sync change log, durable audit ledger, and live activity stream.
- [Metadata Leakage Budget](docs/architecture/metadata-leakage-budget.md) - Cloudflare-visible metadata and path/index constraints.
- [Compaction And Retention](docs/architecture/compaction-and-retention.md) - tombstones, snapshots, long-offline clients, and erasure.
- [Local MCP Authentication](docs/architecture/local-mcp-authentication.md) - local auth, capabilities, admin mode, and localhost threat model.
- [Security and Access Model](docs/architecture/security-and-access-model.md) - trust tiers, encryption, policy enforcement.
- [CRUD Observability](docs/architecture/crud-observability.md) - how create/read/update/delete activity is seen and audited.
- [Implementation Plan](docs/implementation-plan.md) - build phases and validation gates.
- [Development Readiness Checklist](docs/development-readiness.md) - first build slice, pre-deploy gates, and before-real-data tests.
- [Temporal Edge Model](docs/temporal-edge-model/README.md) - schema package entrypoint for edge/event ontology and migration semantics.

## Working Thesis

Living Atlas is not a single hosted plaintext brain. It is one knowledge graph
with Cloudflare complete custody, a local complete replica, access-classed
objects, and separate capability surfaces:

- Cloudflare custody: complete graph bytes, including sensitive ciphertext.
- Remote MCP: Cloudflare-hosted CRUD for remote-readable data.
- Local replica: complete graph bytes plus local decrypted/indexed views.
- Local MCP: full authorized graph CRUD with local keys.
- Sensitive objects: plaintext CRUD only through keyholding client/local path.
- Atlas UI: read-oriented exploration surface with visible provenance and
  activity history.

## Current Status

Phase 1 scaffold exists as a TypeScript workspace. It includes contracts,
synthetic fixtures, access policy evaluation, metadata leakage scanning,
readiness check commands, a Cloudflare bootstrap skeleton, and a fixture-backed
local MCP server skeleton. It also includes an encrypted local control-store and
a ciphertext-only sync-agent/Worker storage skeleton, plus redacted Worker
operational observability events. It does not import real graph data or deploy
personal Cloudflare resources.

## Development

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
local control store, starts the local MCP over stdio, calls the fixture graph
read and synthetic CRUD tools, and checks the activity log for
token/sensitive-bait leakage.
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
  persistence/status through R2/D1 bindings and redacted structured request
  observability.
- `@living-atlas/local-control-store`: encrypted local authority/control-plane
  state store, local profile path helpers, and fixture generation tooling.
- `@living-atlas/local-mcp`: local trusted-ingress MCP skeleton with bearer
  token capability checks, sealed control-store loading, fixture graph
  status/list/read plus synthetic in-memory CRUD tools, and redacted audit
  events.
- `@living-atlas/sync-agent`: local sync-agent skeleton that builds
  ciphertext-only batches from the local graph, tracks an in-memory synthetic
  outbox/daemon plan, and submits to the Worker sync route after checking
  remote generation status.

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
