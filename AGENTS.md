# Agent Instructions

## Repository Scope

Treat this checkout as the active Living Atlas repository for code, docs,
tests, infrastructure templates, and synthetic fixtures.

## System Layers

Architecture docs govern runtime/storage/access:

- Cloudflare custody
- local replica
- encryption/key management
- identity/configuration control plane
- sync/offline/conflict behavior
- MCP access
- CRUD/audit/activity
- metadata leakage and privacy boundaries

Temporal-edge docs govern knowledge semantics:

- edge/event ontology
- predicates and endpoint types
- bitemporal date semantics
- relationship vocabulary
- Logseq/Obsidian migration rules

When these conflict, runtime/security architecture wins for where data lives and
who can access it. Temporal-edge docs win for what graph facts mean.

## Privacy Boundary

This repository is a planning and implementation surface for Living Atlas. Do
not copy personal Logseq, Obsidian, journal, mailbox, CRM, or meeting contents
into this repo unless that exact content is explicitly approved for inclusion.

Use neutral examples and synthetic fixtures for docs, tests, and screenshots.

Do not commit personal Cloudflare deployment values, Terraform/OpenTofu state,
tfvars, Wrangler secrets, bootstrap claim tokens, recovery material, authority
secrets, or local `.living-atlas` profile data. Public repo content should stay
reusable; personal deployment config/state belongs in a private repo or ignored
local overlay.

## Architecture Bias

- Keep sensitive plaintext local/keyholding-client first.
- Treat Cloudflare as complete graph custody for bytes, not full-trust plaintext
  authority for sensitive data.
- Treat Cloudflare-first setup as browser/keyholding-client keyed, with
  first-claim protection before any public bootstrap endpoint can initialize an
  authority.
- Do not design a remote service that can decrypt the full graph.
- Enforce access restrictions in MCP/tool code, not in AI prompts.
- Every mutating operation must produce a durable, inspectable event.
- Reads by remote providers are also security-relevant events and must be
  observable.
- Default new content to `local-private` unless explicitly classified otherwise.
- No real personal graph data should be imported until synthetic fixture tests
  prove policy, leakage, sync, conflict, key, and audit behavior.

## Document Style

- Prefer concrete requirements and validation gates over broad positioning.
- Keep security guarantees explicit: at rest, in transit, and in use are
  different claims.
- Mark open questions as open; do not quietly decide product or privacy policy
  without evidence.
