# Key Management

Status: Draft required before implementation  
Date: 2026-06-21

## Purpose

Define enough cryptographic architecture for implementation to begin without
turning "encrypted sync" into an undefined promise.

This document is still implementation-neutral. Library choices can be finalized
later, but the key hierarchy and envelope responsibilities are fixed here.

This document defines the cryptographic model. User/device/client setup,
capability grants, recovery UX, and admin surfaces are governed by
`identity-configuration-control-plane.md`.

## Security Goal

Cloudflare may store the complete graph bytes, but must not hold keys that
decrypt sensitive plaintext.

Remote-readable content may be visible to the Cloudflare-hosted remote MCP.
Sensitive content is encrypted client-side or locally before Cloudflare custody.

## Key Hierarchy

```text
Account Root Key (ARK)
  wraps authority keys

Authority Key (AK)
  one per graph authority, e.g. person:example
  wraps access-class keys

Access-Class Key (ACK)
  remote-safe key, sensitive key, release key
  wraps object/segment data encryption keys

Data Encryption Key (DEK)
  encrypts one object or segment payload

Device Wrapping Key (DWK)
  per trusted device
  wraps ARK/AK material for that device
```

V1 has one authority but keeps the hierarchy so organization/federation can be
added without rewriting object envelopes.

## Access And Encryption Classes

`access_class` controls policy and serving. `encryption_class` controls payload
handling. Do not collapse them into one field.

| `access_class` | Typical `encryption_class` | Remote MCP Plaintext | Use |
|---|---|---:|---|
| `remote-safe` | `plaintext` | yes | normal remote work |
| `shareable` | `plaintext` | yes | approved lower-risk sharing |
| `release` | `plaintext` | yes until expiry/revocation | operator-approved excerpts/projections |
| `local-private` | `client-encrypted` | no by default; cloud-unlock only with request key and cloud-unlock capability | sensitive graph objects in Cloudflare custody |
| `quarantine` | `client-encrypted` | no | uncertain or blocked material |

`local-only-index` is an `encryption_class`, not an `access_class`; it is for
local search/index material that must not become remote-readable.

## Object Envelope

Every encrypted object needs an authenticated envelope:

```json
{
  "schema_version": 1,
  "authority_id": "la_authority_example0001",
  "object_id": "la_object_example0001",
  "object_type": "page",
  "version": 123,
  "access_class": "local-private",
  "encryption_class": "client-encrypted",
  "created_at": "2026-06-22T00:00:00.000Z",
  "updated_at": "2026-06-22T00:00:00.000Z",
  "content_hash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "key_ref": "la_key_example0001",
  "visible_metadata": {
    "tombstone": false,
    "size_class": "tiny",
    "remote_indexable": false
  },
  "payload": {
    "kind": "ciphertext-ref",
    "storage": "r2",
    "path": "objects/a=example/p=aa/s=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json",
    "ciphertext_hash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "byte_size": 512,
    "algorithm": "xchacha20-poly1305"
  }
}
```

The authenticated associated data binds ciphertext to object id, authority,
version, and access class. This reduces ciphertext substitution risk.

## Object vs Segment Encryption

V1 decision:

- sensitive object payloads are encrypted at object level
- compacted segments may also be encrypted as containers
- mixed-access segments must never require a remote-readable key to unlock
  sensitive payloads

Reason:

- object-level encryption limits write amplification
- object-level encryption supports targeted key rotation and erasure
- segment-level encryption alone is too coarse for mixed access classes

## Key Rotation

Rotation is envelope-based:

- rotate wrapping keys first
- rewrap DEKs without rewriting object ciphertext when possible
- rotate object DEKs only when content is rewritten or exposure requires it
- keep key version in object envelope

Emergency rotation:

- mark compromised device wrapping key revoked
- stop issuing new envelopes to that device
- rewrap active ACKs for remaining devices
- decide whether historical cached ciphertext remains accepted risk

## Device Enrollment

V1 enrollment flow:

1. Existing trusted local device generates or approves a new Device Wrapping Key.
2. New device proves possession of its public wrapping key.
3. Existing device wraps required authority/access keys for the new device.
4. Enrollment writes an audit event.

Cloudflare may transport wrapped keys but must not receive unwrapped sensitive
keys.

Enrollment is a control-plane operation. The enrolled device, capability grant,
wrapped-key references, and audit event must all be recorded through the
identity/configuration control plane.

## Device Revocation

Revocation:

- adds device id to revocation list
- stops future key wrapping for that device
- rotates affected access-class wrapping keys
- writes audit event
- does not claim to erase data already cached by the revoked device

## Release Keys

Releases must not rely only on "check expiry before serving."

V1 release options:

- delete release object at expiry and tombstone it
- or encrypt release with a release key and destroy/stop serving the key at
  expiry

Release expiry is audited.

## Open Implementation Choices

- concrete AEAD: AES-256-GCM or XChaCha20-Poly1305
- KDF for passphrase recovery: Argon2id or platform keychain-only
- hardware binding: macOS Keychain/Secure Enclave where available
- exact device enrollment UX

These choices must be locked before encryption code is written.
