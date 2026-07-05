# Access Modes

Living Atlas separates identity profile from access mode.

- Profile answers: who is calling and what capability grant do they hold?
- Access mode answers: where is sensitive plaintext allowed to exist?

The MCP contract is transport-neutral. Remote HTTP MCP and local stdio MCP expose
the same canonical tool names; only delivery, policy enforcement, and available
key custody differ. Tool names must not encode `remote` or `local`.
See `docs/architecture/dual-ingress-shared-graph-service.md` for the shared
service diagram.

V1 defines three modes.

## Mode A: Remote-Safe Only

`remote-safe-only` is the default Cloudflare remote MCP mode.

- Cloudflare may return `remote-safe`, `shareable`, and unexpired `release`
  plaintext when policy allows.
- Cloudflare may store and sync sensitive ciphertext envelopes.
- Cloudflare must not decrypt `local-private` or `quarantine` objects.
- Sensitive keys are not supplied to the remote runtime.

This is the host-blind remote mode.

## Mode B: Cloud-Unlock Session

`cloud-unlock-session` is an explicit convenience mode.

- A remote request may include a transient unlock key.
- The key must be supplied in an HTTP header, never in a query string.
- The key must not be persisted, echoed, logged, stored in D1/KV/R2, or placed in
  telemetry.
- Decrypt happens inside the Cloudflare runtime for that request/session.
- Cloud-unlock decrypt supports synced `ciphertext-inline` object envelopes in
  two tiers:
  - **normal** — `AES-GCM-256+cloud-unlock-v1`, opened with the primary key.
  - **super-sensitive** — `AES-GCM-256+cloud-unlock-escalated-v1`, opened only
    after an **escalation** with a second key (see below).
- The encrypted payload is authenticated to the object authority, object id,
  type, version, access class, encryption class, key ref, timestamps, and
  visible metadata so ciphertext cannot be silently swapped onto another object.

### Two-key escalation

Within a cloud-unlock session the object's payload algorithm class decides what
it takes to decrypt:

- A **normal** object decrypts with the primary key
  (`x-living-atlas-cloud-unlock-key`) as before.
- A **super-sensitive** object is host-blind to the primary key alone. Requested
  with only the primary key, the tool returns
  `{ ok: false, reason: "escalation-required", tier: "super-sensitive",
  escalation_required_header: "x-living-atlas-escalation-key", … }` and does
  **not** decrypt. Re-requested with a valid escalation key in
  `x-living-atlas-escalation-key`, it decrypts and returns
  `tier: "super-sensitive"`, `escalated: true`, and the payload.

Neither the primary key nor the escalation key may be persisted, echoed, logged,
stored in D1/KV/R2, or placed in telemetry — both are subject to the same
key-custody invariant, proven adversarially across success, escalation-required,
wrong-key, and malformed paths.

This is not host-blind while the request is active. It reduces stored-key and
subpoena-at-rest exposure, but the cloud runtime can theoretically observe key
material and plaintext during unlock.

Current implementation status: implemented for the inline envelope format, both
tiers. The remote MCP rejects unlock keys in query strings, requires the
transient primary key in `x-living-atlas-cloud-unlock-key` and (for
super-sensitive objects) the escalation key in `x-living-atlas-escalation-key`,
refuses quarantine objects, rejects unsupported ciphertext formats, and does not
return or persist either supplied key. **The escalation branch only takes effect
on Cloudflare after the worker is redeployed.** `ciphertext-ref` blob decrypt is
intentionally outside this tool until the external blob payload format is
finalized.

## Mode C: Local-Keyholding Only

`local-keyholding-only` is the strongest sensitive-data mode.

- Decryption happens only in the local MCP, trusted local app, or keyholding
  browser/client.
- Cloudflare receives ciphertext or explicit approved projections.
- Local graph files can persist encrypted payloads with the sealed local keyring.
- Remote providers do not receive sensitive plaintext unless the operator has
  intentionally released or projected it.

This remains the default for truly sensitive graph work.

## Decision Table

| Mode | Cloud stores complete graph bytes | Cloud sees sensitive plaintext | Key persisted by Cloudflare | Best use |
|---|---:|---:|---:|---|
| `remote-safe-only` | yes | no | no | normal remote AI/MCP work |
| `cloud-unlock-session` | yes | during active unlock | no | convenience when runtime-memory risk is acceptable |
| `local-keyholding-only` | yes, as ciphertext | no | no | private/sensitive work |

## Contract Hooks

- `CapabilityGrant.access_mode` records the expected mode.
- `remote-safe` capabilities must use `remote-safe-only`.
- `remote-cloud-unlock` capabilities must use `cloud-unlock-session`.
- Local/keyholding profiles use `local-keyholding-only`.
- Remote MCP query strings reject unlock keys and tokens.
- Remote MCP mode discovery uses `access_modes`.
- Remote MCP sensitive decrypt uses `sensitive_decrypt` with
  `authority_id` and `object_id`; the primary key rides in
  `x-living-atlas-cloud-unlock-key` and the escalation key (for super-sensitive
  objects) in `x-living-atlas-escalation-key`.
