# Local MCP Authentication

Status: Draft required before implementation  
Date: 2026-06-21

## Purpose

The local MCP can decrypt and mutate the full graph. Binding to `localhost` is
not a security boundary. Any local process could otherwise call it.

## Requirements

Local MCP must authenticate every client.

Client identities, capability grants, token rotation, and admin elevation are
configured through `identity-configuration-control-plane.md`.

V1 acceptable mechanisms:

- Unix domain socket with restrictive filesystem permissions
- high-entropy local bearer token stored in OS keychain or protected local file
- per-client capability token for local AI/CLI/browser

V1 must not expose unauthenticated HTTP on localhost.

## Capability Classes

| Capability | Scope |
|---|---|
| `local-read` | full local reads allowed by local policy |
| `local-crud` | create/update/delete through guarded local policy |
| `local-admin` | raw/admin operations; explicit elevation only |
| `local-release` | publish remote-readable release/projection |
| `sync-device` | sync only, no interactive graph reads |

Admin capability must be separate from ordinary local CRUD.

Local-admin is a control-plane capability. It can configure users, devices,
clients, tokens, capabilities, recovery, and keys only through explicit local
elevation.

## Token Handling

- tokens are generated with high entropy
- tokens are never written to the graph
- tokens are rotated on demand
- failed auth attempts are logged
- admin tokens are short-lived or require explicit local confirmation

## Browser Risk

If a browser UI talks to local MCP:

- use same-origin protections
- require token/capability
- reject cross-origin requests by default
- avoid putting bearer tokens in URLs

## Tests

- unauthenticated local request is rejected
- invalid token is rejected
- local-read token cannot mutate
- local-crud token cannot use admin tools
- remote/cloud token is rejected by local MCP
- failed attempts produce audit events without sensitive plaintext
