# ADR 0001: Cloudflare Custody With Local-Key Sensitive Sync

Status: Accepted for V1 planning  
Date: 2026-06-21

## Context

The knowledge graph contains personal, business, relationship, and operational
context. The operator wants Cloudflare-first availability and complete cloud
custody of graph bytes, but does not want Cloudflare to be able to read
sensitive plaintext.

Cloud provider encryption at rest is useful but insufficient for this threat
model. If a remote runtime decrypts or indexes plaintext, the host can
theoretically observe it. The design must distinguish remote-readable plaintext
from sensitive ciphertext.

## Decision

Living Atlas V1 will use Cloudflare as complete graph byte custody and keep a
complete local replica on trusted devices.

Cloudflare-hosted remote MCP can read and CRUD explicitly remote-readable
objects. Sensitive objects are stored in Cloudflare only as authenticated
ciphertext envelopes. Sensitive plaintext keys remain with local/keyholding
clients.

The cloud runtime must not hold keys that decrypt sensitive plaintext.

## Consequences

Positive:

- The operator gets an always-on Cloudflare endpoint for remote-readable work.
- Cloudflare can custody the complete graph without reading sensitive
  plaintext.
- The graph remains usable offline.
- Local tools can remain powerful without expanding remote attack surface.

Negative:

- Server-side search over private content is not available for the full graph.
- Cross-device key management becomes a real product requirement.
- Sensitive semantic conflict resolution must happen through a keyholding path.
- Cloudflare can still observe metadata, remote-readable content, timing, and
  storage shape.

## Implementation Notes

- Use object envelopes for nodes, edges, events, attachments, releases, audit
  records, and change segments.
- Use opaque object IDs by default.
- Keep plaintext labels, titles, people names, project names, and journal dates
  out of remote object paths unless explicitly classified as shareable.
- Use object-level encryption for sensitive payloads.
- Use separate access-class keys for remote-readable, sensitive, release, and
  local-only index material.
- Use generation manifests and change segments for sync.
- Treat metadata leakage as a tested budget, not an afterthought.

## Rejected Alternatives

### Hosted Plaintext Graph Database

Rejected as the default because it violates the sensitive host-blind
requirement.

### Remote Worker Decrypts Full Graph

Rejected because the Worker would become a full-trust processor.

### Local-Only Remote Access Through Tunnel

Rejected as the V1 default because it does not exercise the desired
Cloudflare-hosted remote MCP operating model. It remains a fallback or
diagnostic deployment profile.

### Prompt-Based Privacy

Rejected because tool output must be restricted before a remote model sees it.
