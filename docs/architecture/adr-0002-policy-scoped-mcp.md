# ADR 0002: Policy-Scoped MCP Surfaces

Status: Accepted for V1 planning  
Date: 2026-06-21

## Context

The operator wants local agents to access the complete graph while remote AI
providers only receive approved information. The same graph cannot be exposed
through one undifferentiated MCP surface without risking leakage.

## Decision

Living Atlas will expose separate MCP authority profiles:

- `local-full`: trusted local process with full graph read authority and guarded
  write authority.
- `local-readonly`: trusted local process with full graph read authority but no
  mutations.
- `remote-readable-cloud`: Cloudflare-hosted remote profile with CRUD authority
  over remote-readable objects only.
- `sensitive-keyholding-client`: trusted client/browser path that decrypts
  sensitive content outside Cloudflare and submits authenticated ciphertext
  envelopes.
- `sync-device`: trusted sync agent profile for exchanging graph bytes,
  changes, manifests, and snapshots.
- `admin-raw`: local-only emergency/debug profile for direct mutation tools.

The MCP server must enforce policy in code before returning content.

## Consequences

Positive:

- Remote providers cannot accidentally retrieve local-private content.
- Tool permissions match the trust boundary.
- Tests can compare local and remote outputs for leakage.
- The UI can show "what this actor can see" clearly.

Negative:

- More capability and test complexity.
- Some remote tasks will need local/keyholding work or explicit release objects.
- Ambiguous content needs classification before remote use.

## Tool Surface Requirements

Remote profiles must not expose:

- raw file reads
- unrestricted search
- unfiltered backlinks
- unfiltered graph traversal
- raw mutating tools
- sensitive plaintext mutation tools
- full generated index downloads
- local path disclosure

Remote profiles may expose:

- search over remote-readable objects
- read approved snippets or release objects
- retrieve approved provenance summaries
- CRUD remote-readable objects
- custody/version/tombstone sensitive ciphertext envelopes supplied by a
  keyholding client
- log denials and unavailable context as events

## Policy Decision Output

Denied requests should return a minimal denial:

```json
{
  "ok": false,
  "error": "access_denied",
  "policy": "remote-readable-cloud cannot read this content",
  "request_id": "..."
}
```

The denial must not reveal the title or sensitive content of the denied object.
Where possible, sensitive denied/not-found responses should be indistinguishable
to remote callers.
