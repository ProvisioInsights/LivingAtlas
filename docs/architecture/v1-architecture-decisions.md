# V1 Architecture Decisions

Status: Accepted for V1 planning  
Date: 2026-06-21

## Purpose

Collapse the post-review architecture into implementable V1 decisions. These
decisions supersede older exploratory wording in the planning docs when there is
a conflict.

## Decision 1: Cloudflare-Hosted Remote MCP Is The V1 Remote Path

V1 uses a Cloudflare-hosted remote MCP for remote-readable data.

The intended first-run experience is Cloudflare-first: deploy the Cloudflare
app, safely claim it from a keyholding browser/client, then link local devices
and local MCP through sync.

Local tunnel mode remains a diagnostic/fallback option, not the default V1
architecture.

Why:

- The target product is Cloudflare-first custody and remote availability.
- Remote and local ingress both need CRUD paths.
- Cloudflare-hosted remote MCP is the only V1 mode that exercises the actual
  remote operating model.

Security boundary:

- Remote MCP can see remote-readable plaintext.
- Remote MCP cannot decrypt sensitive plaintext in normal remote-safe mode.
- Cloud-unlock decrypt is explicit: a request must carry a transient unlock key
  and a configured remote-cloud-unlock capability; Cloudflare must not store the
  key.
- Cloudflare can see metadata and remote-readable data; this is an explicit V1
  tradeoff.

## Decision 2: One Logical Graph, Two Materializations

There is one logical graph.

It is materialized in:

- Cloudflare custody: complete graph bytes, including encrypted sensitive bytes.
- Local replica: complete graph bytes plus local decrypted/indexed views when
  local keys are available.

Cloudflare custody is the always-on remote materialization. Local replica is the
trusted plaintext materialization for sensitive content.

## Decision 3: Both Ingress Paths Support CRUD

Both paths support create, read, update, and delete:

```text
remote ingress -> remote MCP -> capability check -> change log -> sync
local ingress  -> local MCP  -> capability check -> change log -> sync
```

CRUD capability differs by object access class.

## Decision 4: Sensitive Plaintext CRUD Requires A Keyholding Client

Remote MCP must not perform semantic CRUD on sensitive plaintext because it
does not hold sensitive keys.

V1 sensitive-object rules:

- Remote MCP may store, version, sync, tombstone, and replicate sensitive
  ciphertext.
- Remote MCP may not inspect or semantically edit sensitive plaintext.
- Remote AI providers do not receive sensitive plaintext unless it has been
  explicitly published as a release.
- A keyholding client may create/update sensitive content by validating and
  encrypting locally, then sending a signed/enveloped ciphertext change.
- Local MCP is the trusted full plaintext CRUD path for sensitive content.

This avoids the confused-deputy failure where Cloudflare accepts arbitrary
opaque ciphertext as a meaningful sensitive edit.

## Decision 5: Default Access Class Is `local-private`

New content defaults to `local-private`.

Remote-readable content requires explicit classification or a trusted bulk
classification rule.

## Decision 6: V1 Is Single-Authority

V1 keeps one graph authority for the operator.

Future federation terms such as authority, grant, projection, and revocation
may remain as compatibility hooks, but V1 does not implement organization
tenancy, cross-authority grants, or federation workflows.

## Decision 7: Event Systems Are Separate

V1 has three event systems:

- Sync change log: mutation/version source for sync.
- Durable audit ledger: security and accountability record.
- Live activity stream: low-latency UI/inspection stream.

They share operation identifiers but have separate schemas and retention rules.

## Decision 8: 100M Scale Is A Storage Contract, Not A V1 Load Claim

V1 must use object ids, change logs, manifests, sharding, and index-shaped APIs
so 100M scale is not precluded.

V1 does not need to operate a 100M graph in production.

Before real private data is connected, a synthetic 10K-100K object stress test
must pass.

## Decision 9: Metadata Leakage Is Tracked Explicitly

Cloudflare-visible metadata is part of the threat model.

V1 accepts some metadata exposure for availability and remote usefulness, but it
must be documented, minimized, and tested:

- object paths must not contain plaintext titles, names, dates, or project names
- remote indexes must not contain sensitive plaintext
- audit events about sensitive objects are sensitive or redacted

## Decision 10: No Real Data Before Prerequisite Contracts

Do not connect the real graph until these contracts exist:

- key management
- identity/configuration control plane
- local MCP authentication
- event subsystem separation
- metadata leakage budget
- compaction and retention
- offline conflict degradation behavior
- synthetic stress test plan

## Decision 11: First Claim Requires A Bootstrap Lock

An uninitialized Cloudflare deployment must not be claimed by the first random
visitor.

V1 requires:

- sealed-by-default deployment when no bootstrap claim secret exists
- one-time high-entropy bootstrap claim token
- atomic first-claim lock, using a strongly consistent mechanism such as a
  Durable Object or D1 transaction
- setup token burned after successful claim
- setup disabled after authority creation
- destructive reset path only through explicit operator/deployer control

Browser-keyed setup is allowed and preferred, but sensitive keys must be
generated and kept in the keyholding client, not in the Worker.
