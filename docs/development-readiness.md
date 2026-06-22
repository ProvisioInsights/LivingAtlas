# Development Readiness Checklist

Status: Draft  
Date: 2026-06-22

## Purpose

Give a developer a synthetic-only path from a clean checkout to local MCP
fixture mode, local deploy rehearsal, and Cloudflare dry-run/preflight without
touching real graph data or private deployment values.

This is the runbook to read before writing code or preparing any deployment.

## First-Run Runbook

All commands in this section use synthetic fixtures unless explicitly marked
live. They must not import real Logseq, Obsidian, journal, mailbox, CRM, or
meeting-derived content.

1. Install dependencies with the pinned package manager.

   ```bash
   npx pnpm@11.8.0 install
   ```

2. Run the local repo gate.

   ```bash
   npm run check
   ```

   This runs repo-safety/leakage checks, TypeScript typecheck, and Vitest.

3. Run the first local smoke path.

   ```bash
   npm run smoke:local
   ```

   This covers sealed local control-store creation, fixture local MCP startup,
   synthetic CRUD calls, activity-log leakage checks, and in-process Worker
   bootstrap/sync routes with fake D1/R2 bindings.

4. Exercise the full synthetic local deploy rehearsal.

   ```bash
   npm run local:deploy-synthetic
   ```

   This is the first-run local deployment rehearsal. It creates a temporary
   local profile, starts local MCP, claims bootstrap against the local Worker
   harness, pushes/pulls ciphertext sync batches, checks stale and token-binding
   rejection, and scans generated artifacts for token or sensitive-bait leaks.

5. Run the Cloudflare public-template dry-run smoke.

   ```bash
   npm run cloudflare:wrangler-smoke
   ```

   This builds the Worker with Wrangler `--dry-run` against
   `packages/cloudflare-worker/wrangler.example.jsonc` in a sanitized temporary
   environment. It validates the emitted bundle and required bindings, then
   checks the output for sensitive fixture bait. It does not deploy, claim an
   authority, upload graph bytes, or require personal Cloudflare values.

6. Run the full synthetic preflight before any real Cloudflare deployment work.

   ```bash
   npm run preflight:synthetic
   ```

   This chains `check`, `local:deploy-synthetic`, `stress:local`,
   `cloudflare:wrangler-smoke`, `infra:fmt`, and `infra:validate`.

Stop here for first-run readiness. A passing synthetic preflight means the
public scaffold and local workflow are ready for the next implementation slice;
it does not authorize real graph import or personal Cloudflare deployment.

## Local MCP Fixture Mode

There are two supported local MCP development modes.

Use token-only fixture mode when you want a stdio MCP server backed by generated
synthetic control state:

```bash
LIVING_ATLAS_LOCAL_MCP_TOKEN='replace-with-local-dev-token' \
npm run local-mcp:fixture
```

Run it from an MCP client or the MCP Inspector; a plain terminal invocation will
wait on stdio.

```bash
LIVING_ATLAS_LOCAL_MCP_TOKEN='replace-with-local-dev-token' \
npm run mcp:inspect:local
```

Use sealed-store fixture mode when you want to rehearse local initialization
with an encrypted synthetic control store:

```bash
LIVING_ATLAS_LOCAL_CONTROL_STORE=/tmp/living-atlas-control-store.json \
LIVING_ATLAS_LOCAL_CONTROL_STORE_PASSPHRASE='replace-with-local-dev-passphrase' \
LIVING_ATLAS_LOCAL_MCP_TOKEN='replace-with-local-dev-token' \
npm run local-control:fixture-store
```

Then launch local MCP from the sealed store:

```bash
LIVING_ATLAS_LOCAL_CONTROL_STORE=/tmp/living-atlas-control-store.json \
LIVING_ATLAS_LOCAL_CONTROL_STORE_PASSPHRASE='replace-with-local-dev-passphrase' \
npm run local-mcp:fixture
```

Optional activity-log capture for local MCP runs:

```bash
LIVING_ATLAS_ACTIVITY_LOG=/tmp/living-atlas-activity.jsonl \
LIVING_ATLAS_LOCAL_MCP_TOKEN='replace-with-local-dev-token' \
npm run local-mcp:fixture
```

Add `LIVING_ATLAS_LOCAL_GRAPH_DIR` when you want the local MCP to use the
durable local graph store instead of the in-memory fixture graph:

```bash
LIVING_ATLAS_LOCAL_GRAPH_DIR=/tmp/living-atlas-graph \
LIVING_ATLAS_LOCAL_MCP_TOKEN='replace-with-local-dev-token' \
npm run local-mcp:fixture
```

Create a sealed fixture keyring when you want the durable store to persist
encrypted payloads instead of redacted payload placeholders:

```bash
LIVING_ATLAS_LOCAL_KEYRING=/tmp/living-atlas-keyring.json \
LIVING_ATLAS_LOCAL_KEYRING_PASSPHRASE='replace-with-local-keyring-passphrase' \
npm run local-keyring:fixture-store
```

Then launch the local MCP with both the durable graph directory and keyring:

```bash
LIVING_ATLAS_LOCAL_GRAPH_DIR=/tmp/living-atlas-graph \
LIVING_ATLAS_LOCAL_KEYRING=/tmp/living-atlas-keyring.json \
LIVING_ATLAS_LOCAL_KEYRING_PASSPHRASE='replace-with-local-keyring-passphrase' \
LIVING_ATLAS_LOCAL_CONTROL_STORE=/tmp/living-atlas-control-store.json \
LIVING_ATLAS_LOCAL_CONTROL_STORE_PASSPHRASE='replace-with-local-dev-passphrase' \
LIVING_ATLAS_LOCAL_MCP_TOKEN='replace-with-local-dev-token' \
npm run local-mcp:fixture
```

With a keyring, `snapshot.json` and `journal.jsonl` use
`AES-GCM-256+local-keyring-v1` ciphertext for plaintext payloads. Without a
keyring, durable graph persistence redacts plaintext payloads by default. Set
`LIVING_ATLAS_LOCAL_GRAPH_PLAINTEXT=allow` only for an explicit local-only
debugging run; do not use it for public fixtures, deploy artifacts, or shared
test output.

The fixture graph intentionally contains sensitive bait and local-private
ciphertext references so policy and leakage checks have something to catch. Do
not replace those fixtures with personal graph content.

## Current V1 Direction

Build:

- one logical graph
- Cloudflare custody of complete graph bytes
- Cloudflare-first browser-keyed bootstrap with first-claim protection
- Cloudflare-hosted remote MCP for remote-readable CRUD
- public repo templates plus private/ignored personal deployment state
- complete local replica
- easy local link/sync from the claimed Cloudflare authority
- local MCP for full authorized graph CRUD
- sensitive plaintext only through local/keyholding-client paths
- temporal edge/event semantics as the knowledge model
- continuous sync with offline queues and conflict records
- visible CRUD/audit/activity surfaces

Do not build in V1:

- organization tenancy
- cross-authority federation
- project-scoped capsules as a distinct access class
- remote semantic CRUD over sensitive plaintext
- local tunnel as the default remote path
- cinematic full-graph live animation

## Before First Code

Architecture contracts that must exist:

- `docs/architecture/v1-architecture-decisions.md`
- `docs/architecture/key-management.md`
- `docs/architecture/identity-configuration-control-plane.md`
- `docs/architecture/cloudflare-first-bootstrap-and-local-sync.md`
- `docs/architecture/public-repo-personal-cloudflare-deployment.md`
- `docs/architecture/event-subsystems.md`
- `docs/architecture/metadata-leakage-budget.md`
- `docs/architecture/compaction-and-retention.md`
- `docs/architecture/local-mcp-authentication.md`
- `docs/architecture/offline-sync-and-conflict-resolution.md`

Already drafted. Keep them as the source of truth when implementation details
conflict with older exploratory wording.

## First Build Slice

Initial code bias:

- Use a TypeScript workspace for the first implementation slice because
  Cloudflare Workers/MCP and schema validators fit that path directly.
- Do not introduce a Rust core until a concrete performance, safety, or
  packaging need appears.

Build in this order:

1. Synthetic fixture graph with sensitive bait.
2. Temporal edge/event fixture set using the temporal predicate and event
   registries.
3. Object envelope types and validators.
4. Identity/configuration record types and validators.
5. Access-class and capability policy evaluator.
6. Metadata/path leakage scanner.
7. Durable audit/checkpoint event types.
8. Sync change event types.
9. Local MCP authenticated transport skeleton.
10. Remote MCP Cloudflare Worker skeleton.

The first build slice should prove policy and leakage behavior before building
rich UI.

## Before Cloudflare Deploy

Required:

- Public repo contains no personal Cloudflare account values, Terraform state,
  tfvars, Wrangler secrets, bootstrap claim tokens, recovery material, or
  personal deployment overlays.
- Deployment starts `sealed` unless a one-time bootstrap claim secret is
  configured.
- Setup claim requires the bootstrap token and atomic first-claim lock.
- Setup token is burned after claim and setup is disabled once authority exists.
- Browser/keyholding-client setup generates sensitive keys outside Cloudflare.
- Remote MCP only exposes remote-readable CRUD tools.
- Sensitive objects are accepted only as authenticated ciphertext envelopes.
- Trusted bulk classification is disabled unless the rule is defined,
  audited, fixture-tested, and operator-approved.
- Object paths and manifests use opaque ids.
- Remote audit is redacted for sensitive objects.
- Denied/not-found sensitive responses are indistinguishable to remote callers.
- Release objects are disabled unless expiry/revocation removes serving and
  remote-index access.
- Rate limits and capability checks exist at the Worker boundary.
- No private fixture strings appear in remote output, indexes, paths, manifests,
  or audit.

## Check Commands

The first readiness slice exposes named checks from `packages/check/src/cli.ts`.

```bash
npx tsx packages/check/src/cli.ts all
npx tsx packages/check/src/cli.ts local
npx tsx packages/check/src/cli.ts cloudflare-deploy-readiness
npx tsx packages/check/src/cli.ts first-run-guardrails
npx tsx packages/check/src/cli.ts wrangler-local-runtime
```

`all` is the default when no command is passed. It runs `local`,
`cloudflare-deploy-readiness`, and `first-run-guardrails`.

Command map:

| Command | Real data | Cloudflare mutation | Use |
| --- | --- | --- | --- |
| `npm run check` | No | No | Default local gate for repo safety, types, and tests. |
| `npm run smoke:local` | No | No | First local install plus in-process Worker smoke. |
| `npm run local:deploy-synthetic` | No | No | End-to-end synthetic local deploy rehearsal. |
| `npm run stress:local` | No | No | Larger synthetic CRUD/sync/leakage stress gate. |
| `npm run cloudflare:wrangler-smoke` | No | No | Wrangler dry-run bundle validation for the public Worker template. |
| `npm run cloudflare:live-usage-gate` | No real graph data | No | Read-only deployed usage stoplight before live synthetic mutation. |
| `npm run cloudflare:live-ops-report` | No real graph data | No | Read-only deployed operator report with gate plus R2 inventory reconciliation. |
| `npm run cloudflare:live-crud-tiny` | No real graph data | Yes | Tiny deployed CRUD pass; requires gate pass and explicit tiny mutation acknowledgement. |
| `npm run preflight:synthetic` | No | No | Full synthetic preflight before real Cloudflare work. |
| `npm run cloudflare:live-concurrency-smoke` | No real graph data | Yes | Optional live deployed-Worker sync race smoke; requires explicit mutation acknowledgement. |

The deployed Cloudflare usage gate should run before any live mutating smoke or
stress:

```bash
npm run cloudflare:live-usage-gate
npm run cloudflare:live-ops-report
```

It calls `/api/usage/gate`, fails closed without an endpoint/token, and returns
`safe-to-test` only when configured budgets remain under the selected threshold,
Worker request headroom remains above the selected minimum, and no Worker 5xx
responses were observed when `require_zero_5xx` is enabled.

`cloudflare:live-ops-report` also calls `/api/usage/reconcile`, which compares
app-observed sync/R2 metadata to provider inventory available through bound
Cloudflare services. Today that includes R2 object count and byte inventory via
the bucket binding. Workers billing counters, KV billing counters, and Durable
Object billing counters still require Cloudflare analytics/dashboard checks.

The tiny live CRUD tier runs the gate first, then mutates only a small synthetic
set by default:

```bash
LIVING_ATLAS_LIVE_TINY_CRUD_ACK=mutates-deployed-sync-state \
npm run cloudflare:live-crud-tiny
```

The deployed Cloudflare concurrency/race smoke is intentionally separate from
`all`, `check`, and `preflight:synthetic` because it mutates a live Worker's
sync state with synthetic ciphertext envelopes:

```bash
npm run cloudflare:live-concurrency-smoke
```

It refuses to run unless `LIVING_ATLAS_LIVE_SYNC_ENDPOINT`,
`LIVING_ATLAS_LIVE_SYNC_TOKEN`, and
`LIVING_ATLAS_LIVE_CONCURRENCY_ACK=mutates-deployed-sync-state` are set.
Optional token-binding headers can be supplied with
`LIVING_ATLAS_LIVE_SYNC_CLIENT_ID`,
`LIVING_ATLAS_LIVE_SYNC_CAPABILITY_ID`,
`LIVING_ATLAS_LIVE_SYNC_DEVICE_ID`, and
`LIVING_ATLAS_LIVE_SYNC_TOKEN_ID`. The live smoke uses a generated synthetic
authority by default and exercises idempotent replay, stale-generation rejection,
same-generation concurrent race rejection, generation-gap rejection, and pull
state after the race.

The local MCP server can be inspected with the MCP Inspector, which is the
closest current equivalent to a SwaggerUI-style developer surface for MCP:

```bash
npm run mcp:inspect:local
```

Use it for tool/resource/prompt discovery, schema inspection, test calls, and
notifications while developing the local MCP. It is not a persistent API
contract registry; the repo contracts and tests remain the source of truth.

The Cloudflare Worker now exposes a minimal token-gated remote MCP JSON-RPC
skeleton at `/mcp`. It supports `initialize`, `tools/list`, and `tools/call`
for sync status, pull summaries, ciphertext envelope pulls, and the read-only
`remote_usage_gate` stoplight. This is a developer contract surface for remote
sync/replay work; it is not yet the full remote-readable graph CRUD surface.

The sync replay path has two read levels:

- `/api/sync/pull`: committed batch summaries and cursors.
- `/api/sync/envelopes`: committed ciphertext object envelopes for local
  durable-store catch-up.

Local apply is intentionally conservative: idempotent same-version envelopes are
skipped, one-version-forward updates are applied, and version gaps/conflicts are
reported instead of silently overwriting local state.

The activity replay package also exposes a compact hash-only replay report over
audit, activity, and operational streams. It is meant for current CLI/test
inspection and as the future input to the visible Atlas activity UI.

## Usage And Budget Endpoint

The Worker exposes a token-gated usage endpoint:

```text
GET /api/usage/status?window_hours=24
GET /api/usage/gate?window_hours=24&max_budget_ratio=0.8&min_worker_requests_remaining=1000
GET /api/usage/reconcile?window_hours=24&max_r2_objects=10000
```

Use the health token header:

```text
x-living-atlas-health-token: <health token>
```

The response shape is provider-neutral (`living-atlas-usage-status:v1`) so
Cloudflare, local, or another future host can return the same top-level
contract. Cloudflare deployments populate what the app can observe:

- Worker request counts from retained operational metrics
- route-level request counts
- sync batch/object/change totals from D1
- R2 object and byte estimates from accepted sync envelopes
- R2 object and byte inventory through the bound R2 bucket when reconciliation
  is requested
- configured budget ratios from `LA_USAGE_BUDGETS_JSON`

It is not a Cloudflare billing authority. D1 row-read/row-write billing, exact
R2 Class A/B operation counts, KV operation counts, and Durable Object storage
usage still require provider-native metrics or dashboard/API data. Keep the
endpoint conservative and label estimates as estimates.

Tunable environment variables:

```text
LA_USAGE_PROVIDER=cloudflare
LA_USAGE_PLAN=free
LA_USAGE_WINDOW_HOURS=24
LA_USAGE_BUDGETS_JSON={"services":{"workers":{"requests":100000}}}
```

For non-Cloudflare deployments, keep the same response shape and replace the
collector/budget config with provider-specific counters. Keep the gate contract
stable (`living-atlas-usage-gate:v1`) so operators and MCP clients can ask the
same safe-to-test question regardless of host.

`local` verifies the current synthetic scaffold:

- object, temporal edge/event, control-plane, audit, and sync fixtures parse
- remote-safe policy output withholds local-private content
- generated Cloudflare paths and envelope R2 paths are opaque
- sensitive bait does not appear in remote-visible outputs
- repo scan finds no public-repo secret/state files or committed deploy values

`cloudflare-deploy-readiness` is synthetic-only. It verifies:

- `packages/cloudflare-worker/wrangler.example.jsonc` points at an existing
  Worker entrypoint
- the public template has the bootstrap Durable Object, R2, D1, and KV bindings
- D1/KV ids are placeholders, not personal resource ids
- private deploy values and token hashes are absent from the public template
- the synthetic Cloudflare manifest covers the complete fixture graph
- Cloudflare-visible paths remain opaque
- sensitive/local-private fixtures are ciphertext-only and not remote-indexable
- sensitive bait does not appear in Cloudflare-visible manifests or paths

`first-run-guardrails` verifies:

- a deployment without bootstrap verification material starts `sealed`
- a sealed deployment rejects claim attempts
- a deployment with valid bootstrap verification material starts `unclaimed`
- missing, invalid, and expired tokens are rejected
- concurrent valid first claims create exactly one authority
- successful claim burns setup token state and leaves the deployment `claimed`
- Worker route source covers token-in-query rejection for bootstrap and sync

Passing these checks does not authorize real graph import. It only proves the
public scaffold, synthetic deploy posture, and first-run guardrails are ready
for the next implementation slice.

## Cloudflare Dry-Run And Preflight

Use the script wrapper for the normal public-template dry run:

```bash
npm run cloudflare:wrangler-smoke
```

The wrapper runs Wrangler from a sanitized temporary home directory, keeps
metrics disabled, validates the dry-run bundle, and removes its temporary output
unless `LIVING_ATLAS_KEEP_WRANGLER_SMOKE=1` is set.

For direct inspection, the equivalent manual dry run is:

```bash
npx wrangler@4.103.0 deploy --dry-run \
  --config packages/cloudflare-worker/wrangler.example.jsonc \
  --outdir /tmp/living-atlas-worker-dry-run
```

This must stay synthetic-only. The public example config may contain placeholder
bindings and non-secret Worker vars, but it must not contain account ids,
resource ids, routes/domains, raw bootstrap or sync tokens, token hashes,
Terraform/OpenTofu state, `.dev.vars`, or private deployment overlays.

Run the full synthetic preflight before preparing a private deployment overlay:

```bash
npm run preflight:synthetic
```

Preflight requires the normal Node/pnpm toolchain plus `terraform` for the
infrastructure formatting and validation scripts. A preflight failure should be
treated as a deployment blocker until the synthetic artifact or public template
is fixed.

## Private Deploy Inputs

A real personal deployment must supply these outside the public repo:

- Cloudflare account id and deploy credential, from environment or a private
  deployment repo
- concrete R2, D1, KV, Durable Object, route, and domain values
- Worker secret/protected config containing the hash or verification material
  for the one-time bootstrap claim token
- bootstrap token expiry
- sync token hash before the local sync endpoint is enabled
- private Terraform/OpenTofu state and variable files
- any authority-specific reset, recovery, or overlay material

Do not store raw bootstrap tokens, raw sync tokens, Account Root Key plaintext,
Authority Key plaintext, access-class key plaintext, recovery secret plaintext,
or local `.living-atlas` profile state in Cloudflare config or the public repo.

## Before Local Full-Graph Use

Required:

- Local MCP rejects unauthenticated localhost callers.
- Local capabilities separate read, CRUD, release, sync, and admin.
- Local decrypt events are audited.
- Local admin/raw tools are explicit elevation only.
- User, device, MCP client, capability, and key configuration changes are
  audited.
- Local indexes are rebuildable from graph bytes and change segments.
- Local encrypted caches/storage policy is decided.

## Before Real Graph Data

The no-real-data boundary remains in force after synthetic deploy readiness
passes. Real Logseq, Obsidian, journal, mailbox, CRM, or meeting-derived graph
content must not be imported until the tests below pass with synthetic data and
their artifacts are reviewed.

Immediate stop rules:

- Do not put personal graph content in fixtures, test snapshots, docs examples,
  Wrangler config, Terraform/OpenTofu variables, local control-store fixtures, or
  committed smoke artifacts.
- Do not point local MCP fixture mode at a real local graph path.
- Do not run a real Cloudflare deploy from the public example config alone; use
  a private/ignored overlay for personal account, resource, secret, route, and
  state values.
- Do not run `npm run cloudflare:live-concurrency-smoke` unless intentionally
  testing a deployed synthetic Worker and the mutation acknowledgement
  environment variable is set.
- Do not treat `npm run preflight:synthetic` as permission to import real graph
  data. It only proves the synthetic scaffold and guardrails.

Required tests:

- remote cannot retrieve local-private plaintext
- remote cannot semantically edit local-private plaintext
- denied/not-found responses do not leak existence
- Cloudflare-visible paths leak no titles/names/dates
- remote indexes contain no sensitive fixture strings
- remote audit contains no sensitive plaintext
- repository scan finds no Terraform state, tfvars, Wrangler secret files,
  bootstrap claim tokens, or personal deployment overlays
- unauthenticated local MCP is rejected
- first-run bootstrap creates a local authority, device, local admin
  capability, and audit event
- uninitialized Cloudflare deployment cannot be claimed without the bootstrap
  token
- concurrent bootstrap attempts create exactly one authority
- successful bootstrap burns setup token and disables setup
- local link creates a local replica profile, keyring references, sync cursor,
  and local MCP credential
- local MCP durable graph mode writes redacted snapshot/journal files and
  survives process restart
- Worker envelope pull returns ciphertext envelopes for local catch-up
- sync-agent applies pulled envelopes idempotently and reports version conflicts
- remote MCP skeleton exposes token-gated sync tools
- replay report summarizes audit/activity/operational streams without raw
  summaries
- remote-safe clients cannot grant sensitive access or enroll keyholding
  devices
- revoked device cannot decrypt newly synced sensitive objects
- offline local and remote edits produce conflict records
- sensitive conflicts fail closed remotely
- release expiry removes serving/index access
- trusted bulk classification cannot promote local-private fixture content
- corrupt segment/envelope is rejected
- long-offline client can catch up through retained changes or snapshot
- 10K-100K synthetic stress passes for sync, index, audit, and leakage basics
- temporal mixed-precision date tests pass for as-of and uncertain comparisons
- invalid predicates and direction-flipping aliases are rejected or explicitly
  echoed before write

## First Milestone Definition

The first engineering milestone is not "import the real graph."

The first milestone is:

```text
Synthetic graph
  -> object envelopes
  -> temporal edge/event schema validation
  -> local policy evaluator
  -> identity/config control-plane validator
  -> Cloudflare bootstrap claim-lock validator
  -> Cloudflare path/manifest generator
  -> local MCP auth plus durable local graph CRUD skeleton
  -> remote MCP sync skeleton
  -> sync envelope pull/apply skeleton
  -> leakage and denial tests
  -> operational Worker observability and replay report scaffold
```

After that, continue hardening persistent sync/conflict handling, then build the
full Atlas observability UI/replay experience on top of the audit, activity,
and operational event streams.
