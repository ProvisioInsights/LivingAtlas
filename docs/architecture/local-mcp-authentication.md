# Local MCP Authentication

Status: **Superseded by [ADR 0015](adr-0015-operator-plane-and-capability-grants.md) and [ADR 0017](adr-0017-retiring-the-legacy-local-surface.md)** (was: Draft required before implementation)  
Date: 2026-06-21  
Superseded: 2026-08-04

> The threat model here is still right — binding to `localhost` is not a
> security boundary, and a local server that can decrypt the graph must
> authenticate every caller. What is superseded is the mechanism. ADR 0015
> settles identity as **per-request input**: the credential rides `_meta` on the
> request rather than being connection state, one refusal code is returned on the
> wire for every cause while the audit event carries the precise one, and the
> grant the credential resolves to is published by `atlas.scope.describe.v1`.
> ADR 0017 records the removal of the server this document was written for.
>
> The body below is left as written.

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
