# Implementation Plan

## Phase 0: Architecture Baseline

Deliverables:

- PRD.
- Architecture requirements document.
- V1 architecture decision record.
- Security and access model.
- Runtime topology decision.
- Complete Cloudflare custody diagram.
- Design-review findings folded into active docs.

Exit gate:

- V1 topology is no longer open: Cloudflare-hosted remote MCP is the V1 remote
  path for remote-readable data.
- Sensitive plaintext CRUD is local/keyholding-client only.
- Federation and organization tenancy are explicitly outside V1.

## Phase 0.5: Required Contracts Before Code

Deliverables:

- Key management contract: hierarchy, envelopes, device enrollment,
  revocation, release expiry.
- Identity/configuration control-plane contract: authority/user/device records,
  MCP client setup, capabilities, recovery, and admin surfaces.
- Cloudflare-first bootstrap contract: one-time claim token, atomic first-claim
  lock, browser-keyed authority setup, local link, and sync.
- Public/private deployment contract: reusable public Terraform/Wrangler
  templates with personal config/state outside public git.
- Event subsystem contract: sync change log, durable audit ledger, live
  activity stream.
- Metadata leakage budget: opaque Cloudflare paths, manifest/index/audit
  constraints.
- Compaction and retention contract: tombstones, watermarks, long-offline
  clients, snapshots.
- Local MCP authentication contract: local capabilities and localhost threat
  model.
- Offline conflict degradation rules.

Exit gate:

- Docs define what Cloudflare may see, what it must not see, and how this is
  tested.
- No implementation work touches real private graph content.

## Phase 1: Repo Bootstrap And Synthetic Fixture

Deliverables:

- Package structure chosen.
- Public repo/private deployment layout chosen.
- Fixture-only test graph with intentionally sensitive names, titles, dates,
  relationships, attachments, and remote-readable content.
- Temporal edge/event fixture set based on
  `docs/temporal-edge-model/schema-edges.md` and
  `docs/temporal-edge-model/schema-events.md`.
- Shared contracts package for object envelopes, access classes, encryption
  classes, event ids, change ids, identity/config records, and capability
  profiles.
- Local check command.
- No private graph content committed.

Exit gate:

- Synthetic fixture tests run locally.
- Repository has a single command that runs lint/typecheck/tests once code
  exists.
- Fixture contains enough sensitive bait to prove leakage controls.
- Fixture proves temporal edge/event semantics without touching real graph data.

## Phase 2: Object Envelope, Policy, And Leakage Tests

Deliverables:

- Object envelope validator.
- Identity/configuration record validator.
- Temporal edge/event registry validator.
- Mixed-precision date parser and comparison tests.
- Access-class policy evaluator.
- Capability evaluator for local MCP, remote MCP, sync device, and admin.
- Metadata/path linter for Cloudflare-visible object names.
- Repository leakage linter for Terraform state, tfvars, Wrangler secrets,
  bootstrap tokens, and personal deployment overlays.
- Remote-output leakage tests against fixture bait strings.
- Remote audit redaction tests.

Exit gate:

- Default new object class is `local-private`.
- Remote-readable output contains no local-private fixture strings, titles,
  names, dates, embeddings, or sensitive edge labels.
- Denied/not-found responses do not reveal whether the sensitive object exists.
- Invalid predicates, invalid endpoint types, missing required attrs, and
  direction-flipping aliases are rejected or explicitly echoed before write.

## Phase 3: Local Replica, Local Index, And Local MCP

Deliverables:

- Local object store or database adapter.
- Full local index over fixture objects.
- Local MCP authenticated transport.
- Local MCP read/search/traversal tools.
- Guarded local CRUD tools.
- Local decrypt event emission.
- Local admin mode separated from normal local CRUD.
- Local link command/app flow for pairing a claimed Cloudflare authority to a
  local device.

Exit gate:

- Unauthenticated local MCP calls are rejected.
- Local authenticated MCP can CRUD the full authorized fixture.
- Local-sensitive reads/decrypts emit local audit events.
- Local admin tools are not exposed under ordinary local CRUD capability.
- Local link creates device record, local keyring references, sync cursor, and
  authenticated local MCP credential.

## Phase 4: Cloudflare Custody And Remote MCP

Deliverables:

- Sealed/unclaimed/claimed bootstrap state machine.
- One-time bootstrap claim token handling.
- Atomic first-claim lock.
- Cloudflare Worker remote MCP for remote-readable data.
- Cloudflare object custody adapter for complete graph bytes.
- Remote-readable CRUD tools.
- Sensitive ciphertext custody/version/tombstone paths.
- Remote denial and redaction behavior.
- Remote read/write audit events.
- No local tunnel dependency in the default V1 path.

Exit gate:

- Uninitialized Cloudflare deployment cannot be claimed without the bootstrap
  token.
- Two simultaneous valid bootstrap claims create exactly one authority.
- Successful bootstrap burns setup token and disables setup.
- Remote MCP can CRUD remote-readable fixture objects.
- Remote MCP cannot retrieve, search, traverse, or semantically edit
  local-private/sensitive plaintext in the normal remote-safe mode.
- Cloud-unlock decrypt requires both a transient request key and a configured
  remote-cloud-unlock capability; the key is not stored by Cloudflare.
- Remote MCP may custody sensitive ciphertext through authenticated object
  envelopes from a keyholding client/local path.
- Cloudflare-visible keys/manifests/indexes pass leakage tests.

## Phase 5: Sync, Offline Queues, And Conflict Records

Deliverables:

- Append-only sync change log.
- Generation manifests and cursors.
- Durable local and remote pending queues.
- Bidirectional sync between Cloudflare custody and local replica.
- Mutation-triggered bidirectional push handshakes for both local and remote
  writes.
- Watchdog polling only as recovery for missed wakeups, process restart, and
  reconnect handling.
- Conflict records for divergent edits.
- Sensitive conflict fail-closed behavior.

Exit gate:

- Local MCP durable CRUD wakes the sync agent immediately after the local commit
  and starts a push handshake with no multi-minute sync delay.
- Remote MCP CRUD makes the new generation available immediately after the
  Cloudflare commit and announces push intent to linked replicas.
- Simultaneous local and remote CRUD on independent objects converges without
  operator review.
- Simultaneous local and remote CRUD on the same object creates conflict records
  rather than overwriting either side.
- Laptop-offline and Cloudflare-offline scenarios both converge after reconnect.
- Update/update, update/delete, rights/content, encrypted/plaintext, and
  release/source conflicts are detected.
- Sensitive conflicts do not become remotely readable while unresolved.
- Conflict resolution writes a new change event.

## Phase 6: Praxis UI And Atlas Observability

Deliverables:

- Full-local vs remote-filtered mode indicator.
- Sync health and generation view.
- Policy visibility panel.
- CRUD ledger table.
- Remote access and denial feed.
- Bounded live activity stream.
- Operation inspector linking live events to audit/change records.
- Conflict review surface.

Exit gate:

- UI visibly answers: what changed, who touched it, what can this actor see,
  what synced, and what is conflicted.
- Live activity is bounded/sampled for high-volume operations.
- Replay comes from audit/change indexes, not from ephemeral UI events alone.

## Phase 6.5: Synthetic Scale And Abuse Tests

Deliverables:

- 10K-100K object synthetic graph generator.
- Offline catch-up stress test.
- Read-event aggregation stress test.
- Segment/cursor sync stress test.
- Metadata leakage scan over generated Cloudflare paths/manifests/indexes.
- Corrupt segment and malformed envelope rejection tests.

Exit gate:

- Fixture passes policy, leakage, sync, conflict, audit, and basic performance
  budgets before any real graph is connected.

## Phase 7: Hardening Before Real Data

Deliverables:

- Threat model review.
- Key revocation tests.
- Device enrollment tests.
- User/client/capability configuration tests.
- Bootstrap claim-lock race tests.
- Release expiry tests.
- Compaction and tombstone tests.
- Recovery and rollback docs.
- Operational deployment runbook.

Exit gate:

- A private graph can be used locally while Cloudflare custody and
  remote-readable MCP are enabled without exposing local-private fixture
  content.

## Near-Term Build Order

1. Finish architecture contracts and keep them internally consistent.
2. Build synthetic fixture graph with intentionally sensitive bait content and
   temporal edge/event examples.
3. Implement temporal schema validators, object envelope, policy evaluator, and
   leakage tests.
4. Implement local authenticated MCP and local replica.
5. Implement Cloudflare-hosted remote MCP for remote-readable CRUD.
6. Implement sync/offline/conflict paths.
7. Build Atlas observability surfaces.
8. Run 10K-100K synthetic stress before connecting real graph data.

## First Implementation PR

The first implementation PR should be:

- TypeScript workspace/package scaffold.
- Synthetic fixture graph.
- Temporal edge/event registry fixtures.
- Object envelope types.
- Policy/access-class validator.
- Metadata leakage scanner skeleton.
- Local check command that runs the fixture/schema/leakage tests.

It should not import real Logseq data, build the Praxis UI, or deploy to
Cloudflare.

## Open Decisions Before Encryption Code

- Whether a Rust core is needed later for performance, safety, or packaging.
- Concrete AEAD library and key wrapping implementation.
- Local database choices for object store, search, audit, and Atlas analytics.
- Local ledger storage path and encryption policy.
- Whether the new repo absorbs the current prototype package or starts clean.
