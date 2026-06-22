# Product Requirements Document: Living Atlas

## Summary

Living Atlas is a Cloudflare-custodied, local-key-aware private knowledge graph
system inspired by Logseq, Obsidian, and the existing Living Atlas prototype. It
gives the operator a trustworthy way to capture, traverse, query, visualize,
sync, and audit personal and business knowledge while controlling exactly what
local tools, remote AI providers, and shared contexts are allowed to see.

The product must support anywhere access without turning sensitive private
knowledge into remotely readable plaintext. Cloudflare may hold complete graph
bytes, but sensitive objects remain client/local-key encrypted. Remote-readable
objects are available to the Cloudflare-hosted remote MCP by explicit policy.

## Why Now

The current Logseq-based workflow has proven the value of:

- Markdown-first authoring.
- MCP-based guarded read/write access.
- A read-oriented Living Atlas visualization layer.
- Typed temporal edges and event records.
- Agent-visible write intent and checkpoint behavior.

The next version should make these ideas explicit in one system:

- A durable knowledge fabric with Cloudflare custody and a complete local
  replica.
- Continuous bidirectional sync with offline queues and conflict records.
- Policy-scoped Cloudflare-hosted remote MCP access for remote-readable data.
- Local MCP access for full authorized graph work with local keys.
- Visible CRUD activity across humans, agents, sync, and automation.

## Users

Primary user:

- An operator-builder maintaining a personal and business knowledge graph
  across local notes, browser workflows, daily briefs, project systems,
  outreach, meetings, and local automations.

Secondary users:

- Local AI clients running on a trusted device with full operator-approved graph
  access.
- Remote AI providers or hosted coding/research agents with constrained graph
  access.
- Future collaborators who may receive explicit release/projection context
  without receiving the full graph.

## Core Product Promise

Living Atlas lets the operator ask:

- What do I know?
- Why do I believe it?
- When did I learn it?
- What changed?
- Who or what touched it?
- Which parts can this agent see?
- Can I safely sync and use it from anywhere?

## Goals

1. Preserve local markdown/import-export compatibility while using object ids,
   changes, manifests, and indexes as the runtime architecture.
2. Provide a full-trust local MCP with complete authorized graph access.
3. Provide Cloudflare-hosted remote MCP access for remote-readable data.
4. Keep Cloudflare and local materializations continuously synchronized, while
   tolerating either side being offline.
5. Keep the cloud host blind to sensitive plaintext whenever possible.
6. Make create, read, update, and delete operations visible and auditable.
7. Support typed temporal edges and event records as first-class graph concepts.
8. Support Obsidian/Logseq-style authoring without requiring either app to be
   the runtime.
9. Make Living Atlas a useful working surface, not just a pretty graph view.

## Non-Goals

- Replacing Logseq or Obsidian as the only authoring UI in v1.
- Storing the full graph as plaintext in a hosted database.
- Letting prompt instructions substitute for hard access controls.
- Building collaborative multi-tenant enterprise administration in v1.
- Building server-side semantic search over private plaintext in v1.
- Moving the source of truth to D1, Vectorize, Postgres, or another database in
  v1.
- Implementing federation, organization tenancy, or cross-authority grants in
  v1.
- Allowing Cloudflare-hosted remote MCP to semantically edit sensitive plaintext.
- Shipping cinematic live graph animation before the durable audit/change
  foundations work.

## Product Scope

### V1 Must Have

- Cloudflare custody of complete graph bytes.
- Complete local replica that can decrypt sensitive objects with local keys.
- Object envelope with stable id, authority, access class, encryption class,
  version, content hash, and change id.
- Cloudflare-hosted remote MCP with full CRUD on remote-readable objects.
- Sensitive-object plaintext CRUD only through a keyholding client/local MCP
  path.
- Append-only sync change log for every mutation.
- Durable audit ledger for remote reads, denials, decrypts, releases, key/device
  events, policy changes, and sync/conflict events.
- Bounded live activity stream for graph-firing UI and operation inspection.
- Offline queues and conflict records for local or remote downtime.
- Key management contract: KEK/DEK hierarchy, envelopes, device enrollment,
  revocation, release expiry.
- Local MCP authentication and capability classes.
- Metadata leakage budget and object path opacity rules.
- Synthetic fixture graph with sensitive content and leakage tests.

### V1 Should Have

- Local-only indexed search over decrypted content.
- Remote-readable indexed search over explicitly remote-readable content.
- Basic Atlas surfaces for sync health, policy visibility, recent activity,
  CRUD ledger, and conflict review.
- Local notification when remote tools read or attempt to read sensitive
  scopes.
- Recovery command to inspect and revert recent graph mutations.
- Synthetic 10K-100K object stress fixture before real graph connection.

### Later

- Multi-device conflict resolution UI.
- Obsidian plugin.
- Browser extension capture.
- Mobile read client.
- Server-side Vectorize projection for explicitly remote-safe content.
- Shared team spaces with separate policy domains.
- Federation, organization tenancy, grants, cross-authority revocation, and
  collaboration.
- Full cinematic "neurons firing" animation beyond bounded activity summaries.

## Trust and Access Requirements

Access must be governed by capability and location:

| Context | Expected Authority |
|---|---|
| Trusted laptop local MCP | Full authorized graph CRUD, subject to local safety guards |
| Trusted laptop Atlas UI | Full authorized read/inspect; writes through MCP/policy |
| Cloudflare remote MCP | CRUD on remote-readable objects; sensitive ciphertext custody only |
| Keyholding remote/browser client | Client-side encrypted sensitive CRUD where explicitly supported |
| Cloudflare object store | Complete graph bytes; sensitive payloads ciphertext |
| Future collaborator | Explicit release/projection only |

The system must assume that a remote AI provider can be helpful but is not a
trusted custodian of the entire graph.

## Policy Labels

V1 labels:

- `local-private`: never exposed remotely.
- `remote-safe`: retrievable by approved remote providers.
- `shareable`: safe to export or attach.
- `quarantine`: parsed but withheld until reviewed.

Default new content is `local-private`.

Remote-readable content requires explicit classification or a trusted bulk rule.
V1 does not implement `project-scoped` capsules or `local-searchable` as a
separate class. Local-private content is searchable locally by authorized local
tools.

Policy must apply to derived data as well as source data. A remote-readable index
must not contain private terms, embeddings, titles, snippets, or metadata that
would reveal withheld content.

## CRUD Visibility Requirements

The operator must be able to see:

- Who or what created a note, edge, event, property, file, index entry, or sync
  object.
- Who or what read a note, block, query result, search result, release, or
  remote-readable object.
- What changed during an update, with before/after metadata and source file
  references.
- What was deleted, archived, invalidated, redacted, or superseded.
- Which policy allowed or denied a read/write.
- Which MCP client, device, token, provider, and tool call triggered the event.
- Whether the event was local, remote, automated, manual, or sync-driven.

Reads by remote providers are first-class audit events. They are not passive.

## Functional Requirements

### Graph Model

- Support pages, journals, blocks, links, typed edges, events, attachments, and
  generated projections.
- Support state edges with `valid-from`, `valid-to`, `recorded-at`, and
  `superseded-at`.
- Support point events with `occurred-on`, optional `occurred-until`, and
  `recorded-at`.
- Preserve mixed-precision dates.
- Quarantine invalid ontology entries instead of silently dropping them.

### MCP

- Provide separate local and remote profiles.
- Remote profile runs on Cloudflare for V1 and serves remote-readable data.
- Remote profile cannot decrypt or semantically edit sensitive plaintext.
- Hide raw mutating tools unless running in local admin mode.
- Default writes to durable intent flow.
- Require idempotency keys for mutations.
- Emit CRUD ledger events for both successful and rejected operations.
- Include policy explanation in remote read denials.

### Sync

- Continuously sync between Cloudflare custody and local replicas.
- Queue changes durably while either side is offline.
- Never require the cloud Worker to decrypt the full graph.
- Support opaque object IDs to avoid leaking titles and names through object
  paths.
- Track sync cursors and conflicts without storing private plaintext remotely.

### Atlas UI

- Show graph overview, source detail, temporal scrubber, activity ledger,
  policy visibility, and review queues.
- Make it obvious whether the current view is full-local or remote-filtered.
- Show recent CRUD operations and remote read attempts.
- Provide drilldown from a visible graph fact to source, provenance, and ledger
  events.
- Show sync health, generation skew, queued changes, and conflict records.

## Security Requirements

- Encrypt content before remote upload.
- Keep full graph keys local to trusted devices.
- Use per-device keys and revocation.
- Use scoped keys or separate encrypted bundles for remote-safe subsets.
- Avoid remote plaintext indexes for sensitive content.
- Avoid object names that reveal page titles, people, companies, projects, or
  journal dates unless explicitly allowed.
- Log all remote reads and denied accesses.
- Treat embeddings as sensitive derived data.
- Keep private fixtures out of the repo.

## Success Criteria

- A trusted laptop can maintain a complete graph locally and query it through
  local MCP.
- A Cloudflare-hosted remote MCP client can CRUD remote-readable content and
  cannot retrieve local-private/sensitive plaintext.
- Attempts to access forbidden content are denied and visible.
- Every write creates an auditable event and a recoverable checkpoint.
- Cloud storage can be inspected and shows ciphertext, opaque IDs, and minimal
  metadata only.
- Atlas can answer "what changed, who touched it, and what can this provider
  see?" without reading logs manually.
- A synthetic 10K-100K object fixture passes sync, policy, leakage, conflict,
  and audit tests before any real graph is connected.

## Open Questions

- Should v1 use one encrypted bundle per page, per block, or per chunk?
- How should local-only semantic search be packaged across devices?
- Should delete mean archive, tombstone, redaction, or cryptographic erasure per
  policy tier?
- What client-side UX supports keyholding remote/browser sensitive edits without
  giving Cloudflare the key?
