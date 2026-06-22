# Development Readiness Checklist

Status: Draft  
Date: 2026-06-21

## Purpose

Turn the architecture work into concrete gates for starting implementation.

This is the short checklist a developer should read before writing code.

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

The first readiness slice exposes three check commands from
`packages/check/src/cli.ts`.

```bash
npx tsx packages/check/src/cli.ts all
npx tsx packages/check/src/cli.ts local
npx tsx packages/check/src/cli.ts cloudflare-deploy-readiness
npx tsx packages/check/src/cli.ts first-run-guardrails
```

`all` is the default when no command is passed.

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
  -> local MCP auth skeleton
  -> remote MCP skeleton
  -> leakage and denial tests
  -> operational Worker observability scaffold
```

After that, continue hardening persistent sync/conflict handling, then build the
full Atlas observability UI/replay experience on top of the audit, activity,
and operational event streams.
