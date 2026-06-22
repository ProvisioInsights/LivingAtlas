# Runtime Topology Options

Status: Draft  
Date: 2026-06-21

## Purpose

This document focuses on architecture, not graph schema. The schema can evolve
separately. The topology decision is about where authority lives, where
plaintext is allowed to exist, and how local and Cloudflare-hosted components
link cleanly without turning into a messy split-brain system.

## Core Question

V1 is no longer choosing between equally likely modes. The accepted V1 topology
is:

```text
Cloudflare-hosted remote MCP for remote-readable data
  +
Cloudflare custody of complete graph bytes
  +
complete local replica for full authorized plaintext work
```

Other modes remain useful as future deployment profiles or diagnostic fallbacks,
but implementation should not branch around them until the V1 path is working.

## Architecture Principles

- One logical graph has two materializations: Cloudflare custody and local
  replica.
- Under normal operation, one object version has one canonical authority.
  Offline divergence creates conflict records, not silent split-brain truth.
- Cloudflare may hold complete graph bytes but does not receive sensitive
  plaintext keys.
- AI providers never access raw storage directly; they access MCP capability
  surfaces.
- Local and cloud are linked through manifests, capabilities, sync cursors, and
  audit events, not shared filesystem assumptions.
- Remote-readable objects are products of policy, not accidental subsets of the
  full graph.
- The same MCP contract should work across modes, but the available tools and
  data scope change by profile.

## Chosen V1: Cloudflare Custody With Local Sensitive Plaintext

### Shape

```text
Cloudflare
  complete graph byte custody
  remote MCP for remote-readable CRUD
  remote-readable indexes only
  opaque sensitive ciphertext
  change/audit/sync endpoints

Trusted local device
  complete graph replica
  local keyring
  local MCP for full authorized CRUD
  decrypted local indexes
  sync/conflict resolver
```

### What This Means

Cloudflare is the always-on custody and remote access plane. It stores all graph
bytes, serves remote-readable data through remote MCP, and syncs sensitive
ciphertext. The local device holds sensitive keys and performs full plaintext
work for sensitive data.

### Benefits

- Matches the target product: deploy to Cloudflare first while keeping
  sensitive plaintext out of Cloudflare.
- Remote AI/tools have a real always-on CRUD endpoint for remote-readable data.
- Full graph remains usable offline.
- Local tools can do rich search and analysis without exposing plaintext.
- The same logical graph exists in Cloudflare and locally.

### Costs

- Cloudflare can observe remote-readable plaintext and metadata.
- Sensitive semantic conflicts require a keyholding local/client path to
  resolve.
- Remote MCP cannot semantically edit sensitive plaintext.
- Key management, leakage budgets, and conflict behavior are first-order
  product requirements.

### Best For V1

Personal graph deployment with always-on remote access for approved data and
local full-trust access for sensitive data.

## Alternate Profile A: Local-First Full Graph

### Shape

```text
Trusted laptop
  full graph authority
  local index
  local MCP
  Atlas UI
  encryption/sync agent

Cloudflare
  encrypted object store
  opaque sync manifest
  auth/rendezvous
  optional tunnel to local remote-readable MCP
```

### What This Means

The laptop is authoritative for the full graph. Cloudflare stores ciphertext and
minimal metadata. Remote AI access goes through a restricted MCP profile, hosted
locally and optionally reached through a tunnel.

### Benefits

- Strongest fit for host-blind privacy.
- Full graph remains usable offline.
- Local tools can do rich search and analysis without exposing plaintext.
- Simple security claim: Cloudflare sync does not need the full decryption key.

### Costs

- Remote access may depend on a trusted device being online.
- Multi-device sync conflict resolution must happen on trusted devices.
- Mobile and lightweight clients need careful chunking and cache strategy.
- Server-side search over full private content is not available.

### Best For

Future high-privacy deployments or diagnostic fallback when remote access can
depend on a trusted device being online.

## Alternate Profile B: Cloudflare-First Plaintext Full Graph

### Shape

```text
Cloudflare
  primary API
  object/database storage
  remote MCP
  auth

Devices
  clients
  local caches
```

### What This Means

Cloudflare becomes the primary plaintext application backend.

### Benefits

- Always-on endpoint.
- Easier access from multiple devices.
- Rich server-side search and graph processing.
- Operationally simpler for availability and deployment.

### Costs

- Violates the sensitive host-blind goal.
- Increases subpoena/provider-access risk.
- Requires stronger organizational/legal trust in Cloudflare and the app
  operator.

### Best For

Public/shareable graphs, team spaces where the organization accepts hosted
plaintext, or deployments where convenience matters more than host-blind
privacy.

## Alternate Profile C: Split-Plane Federation

### Shape

```text
Local full graph plane
  full authority
  full local MCP
  local Atlas
  local policy engine

Cloud remote-safe plane
  remote-readable projection authority
  Cloudflare Worker/API
  R2/D1/KV as needed
  remote MCP for approved content only

Linking plane
  projection manifests
  opaque source references
  sync cursors
  capability tokens
  audit event replication
```

### What This Means

Different graph authorities exchange approved projections without becoming one
database. This is the future organization/personal/federation model, not the V1
implementation.

### Benefits

- Keeps the private graph host-blind.
- Gives remote providers an always-on endpoint for approved content.
- Keeps Cloudflare useful without pretending it is blind to content it serves.
- Makes policy review explicit: the remote plane is a projection, not the graph.

### Costs

- Two planes must stay linked and understandable.
- Reclassification requires projection invalidation.
- Remote-safe content can still be cached by providers once disclosed.
- Requires very clear UI showing "full local" vs "remote-safe cloud" mode.

### Best For

Future organization tenancy, project capsules, client graphs, and
cross-authority collaboration.

## Recommended Direction

Build the chosen V1 path:

- Cloudflare-hosted remote MCP for remote-readable CRUD.
- Cloudflare custody of complete graph bytes.
- Complete local replica and local MCP for full authorized CRUD.
- Sensitive plaintext CRUD only through local/keyholding-client paths.
- Cloudflare-first browser-keyed bootstrap with a one-time claim lock.
- Guided local link flow for local replica, local keyring, local MCP, and sync.
- Federation and organization tenancy deferred behind object-envelope
  compatibility hooks.

Do not implement local tunnel mode as the primary remote path in V1.

## Clean Linking Model

The clean link between local and Cloudflare is not "same database in two
places." It is a set of narrow contracts:

### 1. Manifest

The sync/policy layer emits manifests describing current graph generation,
object segments, access classes, and remote-readable index availability.

The manifest contains:

- authority id
- generation number
- policy profile
- opaque object ids or segment ids
- content hashes
- required capabilities
- expiry, tombstone, or revocation metadata

It must not contain sensitive plaintext names, titles, dates, or relationship
labels.

### 2. Opaque Source References

Remote-readable objects can carry opaque source references. Sensitive objects
use opaque identifiers only. This lets a local inspector trace provenance
without exposing private paths or titles in Cloudflare-visible metadata.

### 3. Capability Tokens

All access is mediated by tokens or signed capabilities:

- local-full capability
- local-readonly capability
- remote-safe capability
- sync-device capability

Capabilities define what MCP tools are visible and what object classes can be
read or mutated.

### 4. Control-Plane Configuration

User, device, MCP client, capability, key, recovery, and Worker configuration
are managed by the identity/configuration control plane.

Bootstrap and emergency recovery cannot depend on an already-authenticated MCP.
After bootstrap, local-admin MCP tools may manage configuration with explicit
elevation. Remote MCP must not grant sensitive access or enroll keyholding
devices.

### 5. Bootstrap Claim Lock

An uninitialized Cloudflare deployment starts sealed or unclaimed, never
publicly claimable by first visitor. Claim requires a one-time bootstrap token
and an atomic first-claim lock. After claim, setup is disabled and local devices
are added through explicit enrollment.

### 6. Local Link

Local install links to the claimed Cloudflare authority through device
enrollment:

- local app/CLI generates a device keypair
- keyholding browser/client approves pairing
- keys are wrapped to the local device
- local profile, sync cursor, keyring references, and local MCP credential are
  created

Cloudflare transports wrapped keys but does not unwrap sensitive key material.

### 7. Sync Cursors

Sync state is separate from graph meaning. A cursor says what generation a
materialization has seen. If local and Cloudflare diverge, conflict records
represent that divergence until resolved.

### 8. Audit Events

Local and remote ingress both produce audit events. Atlas shows a unified
activity feed:

- local writes
- local reads where configured
- remote-readable reads
- remote denials
- sync pushes and pulls
- release creation and invalidation

## MCP Contract Across Modes

Keep one conceptual MCP contract with different profiles:

| Profile | Runtime | Data Scope | Writes |
|---|---|---|---|
| local-full | trusted laptop | full authorized graph | guarded CRUD |
| local-readonly | trusted laptop | full graph | none |
| remote-readable-cloud | Cloudflare runtime | remote-readable objects | CRUD within capability |
| sensitive-keyholding-client | trusted client/browser | sensitive plaintext locally | submits encrypted envelopes |
| sync-device | trusted device sync agent | encrypted sync objects | sync only |

This keeps clients simple: they ask the MCP server what tools are available for
the current profile.

## What Cloudflare Can Be In Each Mode

| Mode | Cloudflare Role | Cloudflare Sees |
|---|---|---|
| Chosen V1 | custody + remote MCP | remote-readable plaintext, sensitive ciphertext, metadata |
| Local-first full graph | encrypted sync/rendezvous | ciphertext, object sizes, timing, opaque ids |
| Local-first with tunnel | transport to local MCP | connection metadata and tunnel traffic metadata |
| Federation profile | projection API/MCP | approved projection plaintext and metadata |
| Cloudflare-first plaintext | primary app backend | full plaintext handled by the app |

The product should name the active mode in UI and logs.

## Decision Gates

Before code depends on a topology, these V1 answers are binding:

- Full graph bytes: Cloudflare custody plus complete local replica.
- Remote MCP: Cloudflare-hosted.
- Cloudflare-visible plaintext: remote-readable data and releases only.
- Sensitive plaintext: local/keyholding-client only.
- Revocation: tombstone/revoke remote-readable or release material, rotate keys
  where needed, and emit audit/change events.
- Disagreement: create conflict records; fail closed for sensitive remote
  access while unresolved.
- Observability: remote reads/writes/denials emit audit and live activity
  events.

## Draft Recommendation For V1

V1 is:

- Cloudflare-hosted remote MCP for remote-readable data.
- Cloudflare custody of complete graph bytes.
- Complete local replica and local MCP for full authorized graph access.
- Sensitive plaintext CRUD through local/keyholding-client paths only.
- Local tunnel mode as fallback/diagnostic only.
- Federation and org tenancy as future hooks, not V1 features.

This matches the desired Cloudflare-first deployment posture without claiming
Cloudflare can privately compute on sensitive plaintext it cannot decrypt.
