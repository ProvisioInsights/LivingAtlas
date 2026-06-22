# Identity, Configuration, And Key Control Plane

Status: Draft required before implementation  
Date: 2026-06-21

## Purpose

Define how Living Atlas configures users, authorities, devices, MCP clients,
capabilities, and key material.

MCP is the normal graph access path, but it cannot be the only control surface.
Some actions have to exist before MCP is usable or trusted:

- first-user bootstrap
- first-device setup
- local key generation
- MCP client token creation
- device enrollment and revocation
- recovery setup
- emergency key rotation
- remote Worker deployment configuration

This document separates the **control plane** from the graph **data plane**.

## Core Rule

Configuration is not prompt policy.

Every MCP call must be backed by explicit identity, device, capability, and key
state. AI prompts may request access, but code decides access.

## Data Plane vs Control Plane

| Plane | Purpose | Normal Surface | May Hold Sensitive Keys |
|---|---|---|---:|
| Graph data plane | read/search/traverse/CRUD graph objects | local MCP and remote MCP | local/keyholding only |
| Sync plane | move encrypted objects, manifests, changes, snapshots | sync agent and Cloudflare endpoints | no |
| Control plane | configure users, devices, capabilities, keys, recovery | local setup CLI/UI, guarded admin MCP tools | local/keyholding only |

The control plane may expose MCP tools after bootstrap, but bootstrap itself
cannot depend on an already-authenticated MCP.

## V1 Identity Model

V1 is single-authority but should not be hardcoded to one person forever.

Required records:

- `authority_id`: the graph authority, for example an operator-owned personal
  graph.
- `user_id`: human operator identity inside that authority.
- `device_id`: trusted device or sync device.
- `client_id`: MCP client, local app, CLI, browser, remote provider, or sync
  agent.
- `capability_id`: granted operation scope.
- `key_id`: key or wrapped-key reference.
- `policy_generation`: monotonically increasing policy/config version.

V1 does not implement organization tenancy or cross-authority federation, but
the record names must not block those later.

## Configuration Stores

### Local Control Store

Lives under the local profile, for example:

```text
~/.living-atlas/
  config/
    authority.json
    devices.json
    clients.json
    capabilities.json
    policy.json
  keyring/
    local keychain references
    encrypted wrapped-key cache
```

The local control store may contain sensitive local configuration and encrypted
wrapped-key material. Raw sensitive keys should live in the OS keychain, Secure
Enclave-backed storage where available, or an encrypted local keyring.

### Cloud Control Store

Cloudflare may store control-plane records needed for remote availability:

- opaque authority id
- device public keys
- client ids
- capability grants for remote MCP
- revocation lists
- wrapped keys encrypted to trusted devices
- policy generation manifests
- remote Worker configuration references

Cloudflare must not receive unwrapped sensitive keys. Cloud-visible control
records must avoid private titles, names, dates, project labels, and sensitive
relationship labels.

### Durable Audit

Every control-plane mutation writes an audit event:

- bootstrap
- device enrollment
- device revocation
- client token creation
- client token rotation
- capability grant/revoke
- release key creation/destruction
- recovery material creation/use
- emergency key rotation
- remote Worker secret/config update

Key and config events are security events even when no graph object changes.

## Bootstrap Flow

The preferred V1 first-run setup is Cloudflare-first but browser-keyed. The
operator deploys the Cloudflare app, then claims it from a keyholding browser or
client that generates sensitive keys locally.

The first-run setup flow:

1. Deploy Cloudflare Worker/storage in `sealed` or `unclaimed` state.
2. Generate a one-time bootstrap claim token during deployment.
3. Open setup from a keyholding browser/client.
4. Generate `authority_id`, `user_id`, and first `device_id`.
5. Generate Account Root Key and Authority Key locally.
6. Generate access-class keys locally.
7. Store raw key material only in local keychain/keyring, browser key storage,
   or encrypted keyholding profile.
8. Create first local admin capability.
9. Create initial policy generation.
10. Atomically claim the Cloudflare deployment with the one-time token.
11. Burn the setup token and permanently disable public setup.
12. Write bootstrap audit events.
13. Prompt the operator to create a recovery kit and link a local device.

If Cloudflare is initialized during bootstrap, upload only public keys, opaque
ids, wrapped keys, revocation metadata, and remote-readable configuration.

See `cloudflare-first-bootstrap-and-local-sync.md` for the first-claim lock,
race-condition controls, and local link flow.

## MCP Client Configuration

MCP clients are explicit configured actors, not ambient processes.

Required client fields:

- `client_id`
- `client_type`: local-ai, local-cli, local-ui, browser, remote-provider,
  sync-agent, admin-cli
- `device_id` or remote runtime binding
- allowed MCP profile
- allowed operations
- allowed access classes
- token/key credential reference
- expiry or rotation rule
- audit verbosity

V1 capability profiles:

| Profile | Intended Use | Sensitive Plaintext |
|---|---|---:|
| `local-full` | local trusted AI/client | yes |
| `local-readonly` | local viewer/search | yes, read only |
| `local-crud` | local guarded graph mutation | yes |
| `local-admin` | config/key/raw admin | yes, explicit elevation |
| `local-release` | publish release/projection | selected output only |
| `remote-safe` | Cloudflare remote MCP | no |
| `sensitive-keyholding-client` | trusted browser/client decrypting locally | yes, outside Cloudflare |
| `sync-device` | sync agent | no interactive plaintext reads |

The MCP server should expose only the tools allowed by the active profile.

## Remote Worker Configuration

Cloudflare Worker configuration must be deployable without sensitive graph
keys.

Allowed Worker secrets/config:

- remote MCP auth secrets
- remote-safe service credentials
- remote-readable key material only if the operator explicitly chooses encrypted
  remote-readable storage requiring Worker decrypt
- R2/D1/KV binding names
- policy generation pointer
- audit/checkpoint signing material that cannot decrypt sensitive graph content

Disallowed Worker secrets/config:

- Account Root Key
- Authority Key that wraps sensitive keys
- sensitive access-class key
- local-only index key
- recovery secrets that can decrypt sensitive graph content

## Recovery Policy

There is no cloud password reset that can recover sensitive plaintext.

Accepted recovery methods:

- at least two trusted keyholding devices
- local encrypted recovery kit stored by the operator
- printed/offline recovery phrase or split recovery shares
- hardware-backed local keychain backup where the operator accepts that trust

If all keyholding devices and recovery material are lost, sensitive-client
encrypted content is unrecoverable by design. Remote-readable content may still
be recoverable if its keys are intentionally available to the remote MCP.

Recovery setup and recovery use must both be audited locally.

## Revocation And Rotation

Revoking a device or client:

1. Mark the device/client revoked in the control store.
2. Stop accepting its tokens/capabilities.
3. Stop wrapping future keys for it.
4. Rotate affected access-class wrapping keys.
5. Write audit event.
6. Sync revocation metadata to Cloudflare.

Revocation does not erase plaintext already cached by a previously trusted
device. The UI and runbooks must say that plainly.

## Configuration Changes Through MCP

After bootstrap, local-admin MCP tools may manage configuration, but only with
explicit elevation.

Allowed local-admin tools:

- list devices and clients
- create/rotate/revoke local MCP tokens
- enroll device
- revoke device
- grant/revoke capability
- create release key
- expire release
- rotate keys
- export encrypted recovery kit

Remote MCP must not expose tools that grant sensitive access, enroll keyholding
devices, export recovery material, or rotate sensitive keys.

## Tests

Minimum fixture tests:

- first-run bootstrap creates local authority, first device, local admin
  capability, and audit event
- local MCP refuses calls before configured authentication exists
- local-admin capability can create a local-readonly client
- local-readonly client cannot mutate config or graph
- remote-safe client cannot enroll devices or grant sensitive access
- Cloudflare control records contain no raw sensitive keys
- revoked device cannot receive newly wrapped sensitive keys
- remote Worker config fixture contains no sensitive key ids or raw secrets
- recovery kit export is encrypted and audited
- losing recovery material is documented as unrecoverable in the runbook
