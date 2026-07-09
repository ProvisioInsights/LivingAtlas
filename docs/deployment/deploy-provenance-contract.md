# Deploy Provenance Contract

Status: M1 production-readiness contract

## Purpose

Every deployed Living Atlas Worker must be reproducible from reviewed source or
from an explicitly recorded emergency override. This document defines the
public-safe provenance contract. Environment-specific evidence belongs in a
private deployment overlay, not in this public repo.

The goal is to prevent three states from being confused:

- code exists in the public repo
- code is pinned by the private deployment overlay
- code is actually running in Cloudflare

## Required Provenance Fields

Each production deploy record must account for:

| Field | Public-safe location | Private overlay location |
| --- | --- | --- |
| Public source repo | Contract/docs | `versions.lock` |
| Public source ref | Generic examples only | exact commit SHA or tag |
| Source ref status | Contract/docs | reviewed PR/commit, dirty/patch status |
| Worker version | Contract/docs | exact Cloudflare Worker version id |
| Deployment id/time | Contract/docs | exact deployment id and timestamp |
| D1 migrations | Migration filenames are public-safe | applied migration range/result |
| Toolchain versions | Contract/docs | Wrangler, Node, Terraform/OpenTofu versions |
| Wrangler config | template shape only | private config path, resource bindings, and config digest |
| Verification commands | command names and expected evidence | exact command output summaries |
| Rollback pointer | contract field | previous known-good Worker version/ref |
| Open risks | public-safe category | private operational detail when needed |

Do not record raw tokens, bootstrap claim tokens, recovery material, unwrapped
keys, local profile state, decrypted payloads, source note paths, or private
graph plaintext in either repo.

## Public Source Requirements

Production deploys must use a pinned public source ref:

- `living_atlas_ref` is a full commit SHA or immutable tag.
- `main` or another moving branch is not acceptable for production.
- If an emergency deploy uses local patches, the private overlay must record
  the patch provenance before the lane is considered reconciled.
- After an emergency deploy, reconcile to a reviewed public ref or a durable
  private patch artifact with verification evidence.

The reusable public repo should define the contract and verification commands.
The private overlay should record the concrete environment values and runtime
evidence.

Production guardrails must bind ignored deployment inputs into provenance, not
only Git-visible files. At minimum, the private report should record the
Wrangler config path and a digest of the exact config file used by Worker
deploy, D1 migration, and Worker secret write commands.

## Verification Evidence

The production deploy record should include the latest result for these gates
when applicable:

- public repo gate: `npm run check`
- synthetic preflight: `npm run preflight:synthetic`
- Worker dry-run: `npx wrangler deploy --dry-run`
- D1 migration status or applied migration range
- live smoke for the deployed endpoint
- live usage gate
- live ops/reconciliation report
- normal and escalated cloud-unlock proof when tiered decrypt behavior changes
- rollback pointer and last-known-good Worker version

Live checks must stay count/status based. They must not print graph plaintext,
secret values, unlock keys, recovery material, or local source paths.

## Dirty Or Emergency Deploys

A dirty deploy is any deploy whose running behavior cannot be reproduced from
the pinned public source ref alone. Examples include local source patches,
manual Worker changes, unreconciled private build artifacts, or a private
overlay state that has not been recorded in the deployment ledger.

Allowed emergency posture:

1. Stop and record why the clean pinned path is insufficient.
2. Record the exact private evidence in the private deployment overlay.
3. Run the same verification gates as the normal path.
4. Open or update a follow-up issue to reconcile back to reviewed source.
5. Record the rollback pointer before treating the deploy as complete.

The public repo must not contain the private patch, deployment token, or
environment-specific values. It should only state that an emergency override
exists and point to the private tracker when that is safe.

## Completion Gate

A production deploy is provenance-complete only when:

- pinned source and running Worker version are both recorded
- migrations and verification gates are recorded
- ignored deployment config fingerprint is recorded and checked
- rollback pointer is recorded
- open risks are linked to GitHub issues
- any dirty/emergency override has a private evidence record
- public/private boundary checks pass
