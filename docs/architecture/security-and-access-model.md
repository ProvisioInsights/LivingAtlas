# Security and Access Model

## Threat Model

Living Atlas assumes:

- The personal graph contains sensitive private and business context.
- Remote AI providers should not receive full graph access.
- Cloud infrastructure should not be trusted with full plaintext graph content.
- Local trusted devices are allowed to hold plaintext graph content.
- Bugs, prompts, tokens, and integrations can cause accidental over-disclosure.

The design protects against accidental and routine remote exposure. It does not
claim protection from a fully compromised trusted laptop.

## Security Claims

### At Rest

Local:

- Full graph bytes exist on trusted devices.
- Sensitive plaintext may exist in local decrypted indexes/caches only under
  local trust and local storage policy.
- Optional local disk encryption and encrypted local caches are recommended;
  platform disk encryption alone is not the product's only control.

Cloud:

- Cloudflare may store complete graph bytes.
- Remote-readable content may be readable by the Cloudflare-hosted remote MCP.
- Sensitive content must be encrypted before upload and remain ciphertext in
  Cloudflare custody.
- Cloud-provider encryption at rest is defense in depth, not the primary
  privacy guarantee.

### In Transit

- All remote access uses HTTPS/TLS.
- Sync objects are ciphertext before transport.

### In Use

- Full graph plaintext exists only on trusted local devices.
- Remote Workers and remote MCP services do not hold sensitive plaintext keys.
- Remote-safe plaintext may be exposed to remote MCP only by explicit
  classification or trusted bulk rule.
- Sensitive plaintext semantic CRUD requires a local/keyholding-client path.

## Data Classification

Canonical taxonomy:

- `access_class` controls policy and MCP visibility.
- `encryption_class` controls cryptographic handling.
- "remote-readable" is a descriptive capability category, not an
  `access_class` value. In V1, remote-readable content usually has
  `access_class = remote-safe`, `shareable`, or `release`.

| Label | Meaning | Remote Access |
|---|---|---|
| `local-private` | Personal or sensitive raw knowledge | Never as plaintext |
| `remote-safe` | Approved for remote provider use | Yes |
| `shareable` | Safe for export/collaboration | Yes |
| `quarantine` | Unreviewed or invalid | No |
| `release` | Explicit remote-readable output, often sensitive-origin | Yes until expiry/revocation |

Default new content is `local-private`.

V1 does not implement `project-scoped` capsules or `local-searchable` as
separate labels. Local-private content is locally searchable by authorized local
tools, and future project/org scopes should be implemented as explicit release
or federation objects after V1.

Labels inherit downward:

- Page label applies to blocks unless overridden stricter.
- Block label applies to derived chunks.
- Edge/event label applies to graph traversals.
- Embeddings inherit the strictest source label.

## Metadata Leakage Rules

Treat metadata as content unless proven otherwise.

For Cloudflare-visible paths, manifests, indexes, and remote audit, avoid
plaintext for:

- Page titles.
- Person names.
- Company names.
- Project names.
- Journal dates.
- Tags.
- Edge predicates involving sensitive relationships.
- Snippet hashes that can be dictionary-attacked.
- Embeddings of private text.

Use opaque IDs by default.

See `metadata-leakage-budget.md` for accepted V1 leakage and tests.

## Key Model

Required keys:

- Account root key or authority key: wrapped only for trusted/keyholding
  devices.
- Access-class keys: remote-readable, sensitive, release, local-only index.
- Data encryption keys: object or segment payload encryption.
- Device wrapping keys: per trusted device.

No cloud Worker or remote MCP profile may hold keys that decrypt sensitive
plaintext.

See `key-management.md` for hierarchy, object envelopes, rotation, device
enrollment, revocation, and release expiry.

See `identity-configuration-control-plane.md` for authority/user/device/client
records, capability grants, bootstrap, recovery, and admin configuration
surfaces.

## Access Enforcement

Policy checks run in this order:

1. Authenticate actor and device.
2. Determine MCP profile.
3. Determine requested operation.
4. Resolve object labels without revealing denied object content.
5. Check scope and purpose.
6. Return filtered result or generic denial/unavailable response.
7. Emit CRUD/policy ledger event.

Denied/not-found responses for sensitive objects should be indistinguishable to
remote callers. Operator-visible audit can record the redacted reason.

## Provider Profiles

### Local Full

- Full graph read.
- Write intent by default.
- Admin raw only with explicit local config.

### Local Readonly

- Full graph read.
- No writes.

### Remote Safe

- Remote-safe objects only.
- No raw search across private content.
- No plaintext local paths.
- CRUD allowed only within remote capability and object class.

### Release

- Explicit release object only.
- Expiration/revocation required.
- All reads logged.

### Sensitive Keyholding Client

- Decrypts sensitive content outside Cloudflare.
- Submits signed/enveloped ciphertext changes.
- Cannot turn the Cloudflare MCP into a sensitive plaintext processor.

## Security Tests

Minimum fixture tests:

- Private page cannot be found by remote search.
- Private title does not appear in remote index.
- Private edge does not appear in remote graph traversal.
- Private embedding is not sent to Vectorize or remote index.
- Denied access logs an event without leaking the denied title.
- Local full profile can access the same content.
- Cloud object names do not reveal fixture private titles.
- Remote MCP cannot semantically edit local-private plaintext.
- Sensitive ciphertext envelopes fail validation when object id, version,
  authority, or access class are tampered.
- Release expiry removes serving/index access, not only UI visibility.
