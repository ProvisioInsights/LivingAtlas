# Remote-Primary With Local Sensitive Path

Status: Draft  
Date: 2026-06-21

## Purpose

Define the V1 remote/local split for remote-readable and sensitive graph work.

V1 is remote-primary for approved remote-readable work: the Cloudflare-hosted
remote MCP is the always-on ingress for normal remote CRUD. V1 is local-key
first for sensitive plaintext: the local MCP or another keyholding client is
the only path that can read or semantically edit sensitive content.

This document is architecture-only. It does not define node/edge schema.

## Core Idea

Use one logical graph with access-classed objects:

```text
Remote path
  remote AI/browser/API
  -> Cloudflare-hosted remote MCP
  -> CRUD remote-readable objects
  -> custody/version/tombstone sensitive ciphertext envelopes
  -> audit/change/sync events

Local sensitive path
  local AI/operator/client
  -> local MCP with local authentication
  -> decrypt and CRUD full authorized graph
  -> optionally publish approved release objects
  -> audit/change/sync events
```

The remote MCP does not call the local MCP in V1. It also does not create local
access request work items. If a task needs sensitive plaintext, the operator
uses the local AI/local MCP path and may separately publish a deliberate
release.

## V1 Data Handling Classes

| Class | Cloudflare Custody | Remote MCP | Local MCP |
|---|---:|---|---|
| `remote-safe` | yes, readable | plaintext semantic CRUD | plaintext semantic CRUD |
| `local-private` | yes, ciphertext | ciphertext custody/version/tombstone only | plaintext semantic CRUD |
| `shareable` | yes, readable | read/export/CRUD within capability | plaintext semantic CRUD |
| `quarantine` | yes, usually ciphertext/redacted | no semantic access | review and classify |
| `release` | yes, readable until expiry/revocation | read/serve within capability | create/revoke/expire |

Default new content is `local-private`.

## Request Routing

When an MCP request arrives:

```text
1. Authenticate actor and client.
2. Determine MCP profile and capability.
3. Resolve object class through opaque identifiers.
4. If remote-readable: allow remote CRUD within capability.
5. If sensitive/local-private:
   - remote MCP denies plaintext read/search/traverse/edit
   - remote MCP may custody a signed ciphertext envelope
   - local/keyholding path handles plaintext CRUD
6. If release: serve only if current, unexpired, and allowed.
7. Append audit/change/live events as required.
```

Denied remote responses should not reveal whether a sensitive object exists.
They should be indistinguishable from unavailable context except for redacted
audit records visible to the operator.

## How Sensitive Context Gets Used

Sensitive plaintext work uses the local path:

```text
1. Local AI asks local MCP.
2. Local MCP authenticates the client and checks capability.
3. Local MCP decrypts and performs full authorized CRUD locally.
4. Operator or local policy decides whether any output should become
   remote-readable.
5. Local MCP publishes an approved release object if explicitly approved.
6. Remote MCP can later read that release until expiry/revocation.
```

This keeps remote MCP useful for normal work without pretending it can reason
over sensitive plaintext it cannot decrypt.

## Storage Shape

Cloudflare stores:

- complete graph bytes
- remote-readable plaintext objects
- sensitive ciphertext envelopes
- release objects
- generation manifests and sync cursors
- remote-readable indexes
- redacted remote audit and sync events

Trusted local devices store:

- complete graph bytes
- local key material through the key management contract
- decrypted local indexes
- local-only search/embedding indexes
- rich local audit detail
- conflict review state

## Colored Boundary Diagram

```mermaid
flowchart TB
  classDef cloud fill:#dbeafe,stroke:#2563eb,color:#111827
  classDef local fill:#dcfce7,stroke:#16a34a,color:#111827
  classDef sensitive fill:#fee2e2,stroke:#dc2626,color:#111827
  classDef ai fill:#f3e8ff,stroke:#7e22ce,color:#111827
  classDef audit fill:#fef3c7,stroke:#d97706,color:#111827
  classDef graph fill:#f8fafc,stroke:#475569,color:#111827

  subgraph I["Ingress"]
    direction LR
    RAI["Remote AI/provider\nremote CRUD path"]:::ai
    LAI["Local AI/operator\nlocal CRUD path"]:::ai
  end

  subgraph M["MCP Access"]
    direction LR
    RMCP["Remote MCP\nCloudflare-hosted\nremote-readable CRUD"]:::cloud
    LMCP["Local MCP\nauthenticated trusted device\nfull authorized CRUD"]:::local
  end

  subgraph G["One Logical Graph With Access Rights"]
    direction LR
    Whole["One logical graph"]:::graph
    RemoteSlice["Remote-readable objects\nplaintext remote CRUD"]:::cloud
    SensitiveSlice["Local-private objects\nciphertext remote custody\nplaintext local CRUD"]:::sensitive
    Release["Approved releases\nremote-readable until expiry"]:::cloud
  end

  subgraph S["Storage / Materialization"]
    direction LR
    CF["Cloudflare complete graph custody"]:::cloud
    Local["Local complete replica"]:::local
    Keys["Local/keyholding keys"]:::sensitive
    Sync["Change log + sync reconciler"]:::audit
  end

  subgraph O["Observability"]
    direction LR
    RAudit["Remote redacted audit"]:::audit
    LAudit["Local rich audit"]:::audit
    Activity["Bounded live activity"]:::audit
  end

  RAI --> RMCP
  LAI --> LMCP
  RMCP --> RemoteSlice
  RMCP --> Release
  RMCP -. "no key / ciphertext custody only" .-> SensitiveSlice
  LMCP --> Whole
  Keys --> LMCP
  Whole --> RemoteSlice
  Whole --> SensitiveSlice
  Whole --> Release
  CF --> Whole
  Local --> Whole
  RMCP --> Sync
  LMCP --> Sync
  Sync <--> CF
  Sync <--> Local
  RMCP --> RAudit
  LMCP --> LAudit
  RMCP --> Activity
  LMCP --> Activity

  RMCP -. "no direct local tool calls in V1" .- LMCP
```

## Future Federation Hooks

V1 does not implement organization tenancy, employee-owned graphs, org-owned
graphs, cross-authority grants, or eDiscovery/retention consoles.

The V1 object envelope still keeps these fields compatible with future
federation:

- `authority_id`
- `access_class`
- `encryption_class`
- `release_id`
- `source_ref`
- `policy_generation`

Future federation will use explicit boundary objects:

- grant
- projection
- capsule
- release
- revocation
- audit event

Do not federate by giving one MCP raw access to another authority's storage.

## Ownership Rules For Later

When organization support is introduced:

- Personal graph data remains person-owned unless explicitly projected.
- Organization graph data remains org-owned under org retention and access
  policy.
- Local-sensitive personal data is not pulled into org graphs by default.
- Cross-boundary movement creates audit events.
- Revocation stops future access but cannot recall plaintext already disclosed
  to a provider.

These rules are future constraints, not V1 deliverables.

## V1 Recommendation

Build only:

- Cloudflare remote MCP for remote-readable personal graph CRUD.
- Local MCP for full authorized graph CRUD.
- Cloudflare custody of complete graph bytes.
- Local/keyholding sensitive plaintext path.
- Release objects for explicit sensitive-origin outputs.
- Audit events for remote reads, remote writes, local releases, denials, key
  events, and conflicts.

Defer:

- full organization tenancy
- employee/org ownership workflows
- project-scoped capsules as a distinct V1 access class
- eDiscovery/retention consoles
- cross-org collaboration
- automated bulk federation

## Open Architecture Questions

- Which content can be classified `remote-safe` by trusted bulk rule? V1
  default: no trusted bulk rule is enabled until the rule is defined, audited,
  fixture-tested, and operator-approved.
- What is the first keyholding remote/browser client UX, if any?
- How long should released snippets live by default?
- Is release expiry enforced by deletion, release-key destruction, or both? V1
  gate: release objects stay disabled until expiry/revocation removes serving
  and remote-index access.
- What synthetic fixture best models future org/personal boundary risk without
  adding org tenancy to V1?
