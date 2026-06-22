# Cloudflare-First Bootstrap And Local Sync

Status: Accepted for V1 planning  
Date: 2026-06-21

## Purpose

Define the intended first-run experience:

1. Stand up Living Atlas on Cloudflare first.
2. Claim the uninitialized deployment safely.
3. Generate sensitive keys in a keyholding browser/client, not in Cloudflare.
4. Make local install and continuous sync easy immediately after claim.

This document turns "Cloudflare-first" into the V1 onboarding path while
preserving the host-blind sensitive-data boundary.

## Product Decision

V1 setup should feel Cloudflare-first:

```text
deploy Cloudflare app
  -> open setup URL
  -> claim authority
  -> browser generates keys locally
  -> Cloudflare stores encrypted custody/config
  -> remote MCP is available for remote-safe data
  -> install/link local replica
  -> local MCP gets full authorized graph access
```

The security root is still keyholding-client first. Cloudflare may host the
setup page and remote MCP, but it must not create or store keys that decrypt
sensitive plaintext.

Cloudflare is the complete graph byte custodian, not the private plaintext
authority. V1 should be described as complete graph ciphertext custody plus
explicit remote-readable projections:

- R2/D1/KV may hold the complete encrypted graph byte stream, opaque manifests,
  sync segments, wrapped keys, and redacted audit/config records.
- Workers may route, validate, persist, and synchronize ciphertext envelopes.
- Local or browser keyholding clients decrypt sensitive/local-private graph
  content and build full private text/semantic indexes.
- Remote MCP may serve explicitly `remote-safe`, `shareable`, or unexpired
  `release` projections, but those projections are not the private graph source
  of truth.

## First-Claim Race Condition

An uninitialized deployment must not be publicly claimable.

Bad pattern:

```text
first visitor to /setup becomes owner
```

Required pattern:

```text
deployer creates one-time bootstrap claim secret
  -> Worker starts sealed or unclaimed
  -> /setup can load but /api/bootstrap/claim requires the secret
  -> first valid claim atomically writes authority record
  -> claim secret is burned
  -> setup endpoint is permanently disabled unless operator resets it
```

## Bootstrap State Machine

```text
sealed
  no setup accepted
  default state if no bootstrap secret exists

unclaimed
  setup accepted only with one-time claim secret
  no graph authority exists yet

claimed
  authority exists
  setup disabled
  normal auth/MCP routes active

reset-pending
  explicit destructive operator reset only
  requires Cloudflare account/deployer control plus local confirmation where possible
```

The Worker must never infer ownership from "first successful page load."

## Claim Lock

Use a strongly consistent singleton claim lock.

Acceptable V1 implementation choices:

- a Durable Object that serializes bootstrap claim attempts
- a D1 transaction with a unique singleton bootstrap row

Do not rely on eventually consistent metadata for the first-claim decision.
The lock must guarantee that two simultaneous valid claim attempts cannot both
create an authority.

Claim record fields:

- `bootstrap_state`
- `authority_id`
- `claimed_at`
- `claimed_by_device_public_key_hash`
- `policy_generation`
- `claim_token_hash`
- `claim_token_burned_at`
- `reset_generation`

The claim token itself must not be stored in plaintext.

## Deployment-Time Setup

Cloudflare deployment starts with a setup command:

```text
living-atlas cloudflare prepare
  -> generate one-time bootstrap claim token locally
  -> store only token hash/verification material as a Worker secret or protected config
  -> print setup URL and token
  -> deploy Worker/R2/D1/KV/DO bindings
```

Public repo templates define the shape of this deployment. Personal account
ids, domains, Terraform/OpenTofu state, Wrangler secrets, bootstrap tokens, and
authority-specific values live in a private deployment repo or ignored local
overlay. See `public-repo-personal-cloudflare-deployment.md`.

## Public Repo To Private Deploy Flow

The public repo remains reusable and synthetic:

```text
public repo checkout
  -> install dependencies
  -> run check commands against synthetic fixtures
  -> run Terraform/Wrangler validation with placeholder-safe templates
  -> stop before deploy
```

A personal deployment adds a private/ignored overlay:

```text
private deploy overlay
  -> Cloudflare account and deploy credential
  -> concrete R2/D1/KV/DO names and ids
  -> optional route/domain configuration
  -> generated bootstrap token hash and expiry
  -> deploy Cloudflare resources
  -> open setup URL with token entered interactively
  -> claim authority and burn token
  -> link local/keyholding client
  -> keep real-data import disabled until synthetic gates pass
```

The public repo should never contain personal account ids, real resource ids,
raw claim tokens, token hashes for a live authority, route/domain values,
Terraform/OpenTofu state, Wrangler local state, `.dev.vars`, recovery material,
or local profile data.

Required private deploy inputs:

- Cloudflare account id and scoped deploy credential
- concrete R2, D1, KV, Durable Object, route, and domain values
- one-time bootstrap claim token generated locally and shown once
- Worker secret/protected config containing only token verification material
- bootstrap token expiry
- sync token hash before the sync endpoint accepts local batches
- private Terraform/OpenTofu state and variable files

Sensitive key material is not a deploy input. Account Root Key plaintext,
Authority Key plaintext, access-class key plaintext, local-only index keys, and
recovery secret plaintext remain in keyholding browser/local clients.

The setup token:

- is high entropy
- is shown once
- is never placed in a query string
- is never logged
- is accepted only by `unclaimed` deployments
- is burned after successful claim
- expires if unused

Optional hardening:

- put setup route behind Cloudflare Access during bootstrap
- restrict setup route by temporary allowlist
- require a local CLI challenge/response in addition to the token

These are defense in depth. The one-time claim token plus atomic claim lock are
the required controls.

## Browser-Keyed Claim Flow

First owner claim:

1. Operator opens setup URL.
2. Browser asks for the bootstrap claim token.
3. Browser generates `authority_id`, `user_id`, first `device_id`, and device
   public/private keypair.
4. Browser generates Account Root Key, Authority Key, access-class keys, and
   initial remote-safe/release keys locally.
5. Browser stores raw key material only in local key storage or an encrypted
   keyholding profile.
6. Browser creates an encrypted recovery kit before real data import is
   enabled.
7. Browser submits claim proof, public device key, opaque authority metadata,
   wrapped keys, and initial policy generation.
8. Cloudflare claim lock atomically accepts or rejects claim.
9. If accepted, Worker burns setup token, creates initial manifests/config, and
   writes bootstrap audit records.
10. Browser receives first local-admin/session capability.

Cloudflare receives:

- opaque authority id
- public device key
- wrapped keys encrypted to the first keyholding device
- remote-safe configuration
- bootstrap audit event
- initial empty/encrypted graph manifests

Cloudflare does not receive:

- Account Root Key plaintext
- sensitive Authority Key plaintext
- sensitive access-class key plaintext
- local-only index key
- recovery secret plaintext

## Setup Completion Gate

Before real graph import is enabled, setup must confirm:

- claim lock state is `claimed`
- setup token is burned
- first keyholding device exists
- local recovery kit exists or operator explicitly accepts unrecoverable risk
- local-admin capability exists
- remote-safe capability exists
- no sensitive keys exist in Worker config
- Cloudflare-visible object paths are opaque
- fixture leakage test passes
- only synthetic objects have crossed the deploy/check path
- Cloudflare has ciphertext custody for sensitive graph bytes but no local
  decrypt authority

## Local Install And Sync

After Cloudflare claim, local install should be easy:

```text
Living Atlas web app
  -> "Add this computer"
  -> shows pairing code or QR

local CLI/app
  -> living-atlas local link <cloudflare-url>
  -> generates local device keypair
  -> proves pairing code
  -> receives wrapped authority/access keys
  -> creates ~/.living-atlas profile
  -> starts sync
  -> starts local MCP with authenticated local credential
```

The keyholding browser/client wraps keys for the new local device. Cloudflare
may transport wrapped keys, but it never unwraps sensitive keys.

Local link creates:

- local device record
- local control store
- local keyring references
- sync cursor
- local MCP credential
- local audit/checkpoint store
- local object/index stores

## Continuous Sync

Normal sync after local link:

```text
remote MCP or keyholding browser writes remote-safe/ciphertext change
  -> Cloudflare change log
  -> local sync pulls generation
  -> local decrypt/index if keys allow

local MCP writes full authorized change
  -> local change queue
  -> encrypt/envelope
  -> push to Cloudflare
  -> remote MCP sees only allowed remote-safe/plaintext or sensitive ciphertext
```

Cloudflare stores the complete ciphertext custody stream needed for recovery
and sync. The local replica stores the same graph bytes plus decrypted/indexed
views when its keys allow. Cloudflare-side services must not build full private
indexes, embeddings, summaries, or MCP answers from sensitive plaintext.

Offline behavior:

- local device queues changes while offline
- Cloudflare accepts remote-safe changes while local is offline
- reconnect compares base versions and generations
- divergent edits create conflict records
- sensitive conflicts fail closed remotely until a keyholding client resolves
  them

## Reset And Reclaim

Reclaiming an already-claimed deployment is a destructive operator action, not a
public setup path.

Required reset controls:

- Cloudflare account/deployer control
- explicit reset command
- backup/export warning
- new setup token
- new reset generation
- audit event if old authority is still readable by a keyholding device

If all keyholding devices and recovery material are lost, sensitive content is
unrecoverable by design. Reset can create a new authority; it cannot decrypt old
sensitive ciphertext.

## Tests

Minimum tests before real deployment:

- `npx tsx packages/check/src/cli.ts cloudflare-deploy-readiness` passes
- `npx tsx packages/check/src/cli.ts first-run-guardrails` passes
- unconfigured Worker starts in `sealed`, not public-claimable
- setup claim without token is rejected
- setup token in query string is rejected
- invalid token is rejected
- expired token is rejected
- two simultaneous valid claims produce exactly one authority
- valid first claim burns token
- second claim after success is rejected
- reset requires explicit destructive operator path
- Worker config fixture contains no sensitive key plaintext
- browser-keyed claim uploads only public/wrapped key material
- local link creates device record, local keyring references, sync cursor, and
  authenticated local MCP credential
- local sync can pull encrypted Cloudflare graph state and build local indexes
- offline local changes converge or produce conflict records after reconnect
