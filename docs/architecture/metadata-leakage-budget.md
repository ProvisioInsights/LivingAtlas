# Metadata Leakage Budget

Status: Draft required before implementation  
Date: 2026-06-21

## Purpose

Encrypted content is not enough. Cloudflare-visible metadata can still reveal
graph structure, work cadence, and relationship patterns. This document defines
what metadata V1 accepts, what it forbids, and what must be tested.

## Threat Boundary

Cloudflare may observe:

- request timing
- object sizes
- object counts
- bucket/key names
- segment counts
- ciphertext envelope counts, generations, and byte-size classes
- remote-readable plaintext
- remote audit records stored in Cloudflare

Cloudflare must not observe:

- sensitive plaintext
- complete private graph plaintext
- sensitive page titles
- sensitive person/company/project names
- sensitive journal dates in object paths
- sensitive edge labels/predicates
- sensitive embeddings or full-text terms
- local-only private index terms

## Complete Graph Ciphertext Boundary

Cloudflare custody is complete for graph bytes, but not for private plaintext.
For sensitive/local-private content, Cloudflare stores ciphertext envelopes,
opaque paths, wrapped key material, redacted audit/config records, and sync
metadata. Only local or browser keyholding clients decrypt that content and
build full private indexes.

Remote-readable projections are explicit exceptions. They may be stored or
served by Cloudflare only when the object is classified `remote-safe`,
`shareable`, or unexpired `release`. Those projections do not authorize
Cloudflare-side decryption of the complete private graph.

## R2 Path Rules

Forbidden in object paths:

- page titles
- names of people, companies, projects, clients
- journal dates when the object is sensitive
- semantic object types for sensitive-only segments if avoidable
- tags
- predicates

Preferred:

```text
objects/a=<opaque-authority>/p=<partition>/s=<segment-id>.bin
changes/a=<opaque-authority>/g=<generation>/seg=<segment-id>.bin
indexes/a=<opaque-authority>/g=<generation>/idx=<opaque-index-id>.bin
```

Avoid:

```text
authority=person:example/type=edge/yyyy=2026/mm=06/dd=21/...
pages/Sensitive-Title.md.enc
journals/2026-06-21.enc
```

## Accepted V1 Leakage

V1 accepts that Cloudflare may infer:

- account has a graph
- approximate storage size
- approximate sync cadence
- approximate number of opaque segments
- remote-readable content and its metadata

V1 does not accept leaking:

- sensitive titles/names/dates
- sensitive relationship labels
- sensitive full-text terms
- sensitive embeddings
- exact object-per-note mapping for sensitive content

## Mitigations

V1:

- opaque ids
- opaque path segments
- segment batching for sensitive objects
- redacted remote audit
- remote-readable indexes only include remote-readable content

Later:

- padding
- delayed/batched sync
- dummy segments
- traffic shaping
- private information retrieval is out of scope

## Tests

Before real data:

- run `npx tsx packages/check/src/cli.ts cloudflare-deploy-readiness`
- grep R2 keys for fixture names/titles/dates
- inspect manifests for sensitive labels or paths
- inspect remote indexes for sensitive terms
- inspect remote audit for sensitive plaintext
- verify object size/path patterns do not trivially map one note to one object
