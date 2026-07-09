# Data Tiering

Living Atlas stores every object as an encrypted envelope. Historically all of
personal-prod's live objects sat in the top-security tier — `local-private`
(plus `quarantine`), encrypted `AES-GCM-256+local-keyring-v1`, never
cloud-decryptable. That is maximally safe but also maximally inconvenient: none
of it can be read inside a Cloudflare cloud-unlock session, even the mundane
majority.

Data tiering re-architects this into a **two-key escalation** model. **All data
lives on Cloudflare as ciphertext** (the object bytes are already backed up
there). The tier decides only *what it takes to decrypt an object in the cloud*:
the normal majority opens with the primary unlock key; a small super-sensitive
tail additionally requires a **second escalation key**.

> **Supersedes the prior design.** An earlier version of this document described
> super-sensitive data as "local-only, never cloud-decryptable". That is no
> longer the model. Super-sensitive data IS cloud-decryptable — but only after an
> explicit escalation with a distinct second key.

## The two tiers

| Tier | Algorithm | What it takes to decrypt in the cloud | Population |
|------|-----------|----------------------------------------|------------|
| **normal** (DEFAULT) | `AES-GCM-256+cloud-unlock-v1` | The **primary** per-request cloud-unlock session key, inside a Cloudflare cloud-unlock session. | The vast majority (~22,514). |
| **super-sensitive** (escalated) | `AES-GCM-256+cloud-unlock-escalated-v1` | Also cloud-decryptable, but **only after an escalation** with a distinct **escalation key** (second header). | Small tail matched by the ruleset (~380). |

Both tiers are ciphertext on Cloudflare. The difference is the key custody an
attacker or a remote client must satisfy to read the plaintext.

**Locally, the keyring holds BOTH keys**, so a local holder decrypts everything —
normal and super-sensitive — with **no escalation friction**. The escalation gate
exists only for cloud (remote) unlock sessions.

The tiering is **additive** to the existing access-class / access-mode model
(see `access-modes.md`). Super-sensitive objects keep `local-private` /
`quarantine` access class and all existing host-blind guarantees. Tiering only
decides *which cloud-unlock algorithm class* an object carries, and therefore
whether opening it in a cloud session requires an escalation.

## The escalation flow

An AI/remote client hitting a super-sensitive object in a cloud-unlock session,
presenting only the primary key, gets an **`escalation-required`** response:

```json
{
  "ok": false,
  "reason": "escalation-required",
  "tier": "super-sensitive",
  "current_mode": "cloud-unlock-session",
  "object_id": "la_object_…",
  "escalation_required_header": "x-living-atlas-escalation-key",
  "host_blind_sensitive_plaintext": true
}
```

This is the *"this is super-sensitive — approve the second unlock?"* UX. The
object is **not** decrypted. If the client re-requests **with** a valid
escalation key (`x-living-atlas-escalation-key` header), the decrypt proceeds and
the response carries `tier: "super-sensitive"`, `escalated: true`, and the
plaintext payload. A normal object needs only the primary key and is never gated.

## Cloud-unlock encrypt/decrypt (two primitives)

The **normal** primitive is `packages/cloudflare-worker/src/cloud-unlock.ts`
(`encryptCloudUnlockObject` / `decryptCloudUnlockObject`, algorithm
`AES-GCM-256+cloud-unlock-v1`).

The **escalated** primitive is
`packages/cloudflare-worker/src/cloud-unlock-escalated.ts`
(`encryptEscalatedCloudUnlockObject` / `decryptEscalatedCloudUnlockObject`,
algorithm `AES-GCM-256+cloud-unlock-escalated-v1`). It mirrors the normal
primitive exactly:

- Fresh 12-byte random nonce per call (no nonce reuse).
- AES-GCM v2 authenticated-data binding to the stable cloud-unlock identity:
  `authority_id`, `object_id`, and the payload algorithm/tier.
- Mutable envelope and sync fields (`version`, generation/cursor state,
  timestamps, `key_ref`, and `visible_metadata`) are intentionally excluded from
  v2 AAD so bookkeeping updates do not make valid ciphertext undecryptable.
- Legacy v1 decrypt fallback is compatibility-only and still uses the original
  broader AAD over object type, version, access/encryption class, key ref,
  timestamps, and visible metadata.
- **Leak custody**: the escalation key derives only a non-extractable
  `CryptoKey` and is never written into the produced object; no plaintext
  survives in cleartext.

**Tier isolation** (proven in `cloud-unlock-escalated.test.ts`):

1. **By algorithm class** — the normal decrypt path returns
   `unsupported-algorithm` for an escalated object and vice-versa, so neither
   path ever attempts to open the other tier's payload.
2. **By AAD domain separation** — normal and escalated v2 AAD carry distinct
   domain-separation prefixes, so even under identical key material an
   escalated ciphertext cannot be authenticated by the normal primitive.
3. **By distinct keys** — the primary session key does not open an escalated
   object, and the escalation key does not open a normal object.

## Classification ruleset

Classification is an **explicit, data-driven, John-adjustable** ruleset
(`packages/policy/src/tiering.ts`, `DEFAULT_TIERING_RULESET`). It runs over the
**decrypted** content of each object and matches by:

- **tag** — Logseq wikilink tags (`[[Health Records]]`), hashtags (`#medical`),
  and `properties.tags`.
- **entity name** — canonical `endpoint.name` / `aliases`, and named entities
  appearing inline in body text (specific names are supplied via the private
  overlay; see [Private overlay](#private-overlay)).
- **keyword** — case-insensitive, word-boundary-anchored phrase matches (with a
  bounded inflection allowlist) against the object's free text.

An object is **super-sensitive** if any enabled rule matches; otherwise **normal**
(the default). Matching is conservative by design: the safe error is
over-inclusion (escalating something), never under-inclusion.

### Default super-sensitive rules

The shipped `DEFAULT_TIERING_RULESET` is **generic** — it carries only universal
category keywords and generic tags, and **no personal specifics**. Individual
names, places, and personal tags are layered in privately (see
[Private overlay](#private-overlay)).

| Rule id | Escalates | Generic signals (public) | Private specifics (overlay) |
|---------|-----------|--------------------------|-----------------------------|
| `immigration-legal` | Immigration / legal / citizenship / visa | keywords: immigration, citizenship, naturalization, visa, green card, USCIS, consulate, honorary consul, reacquisition, Staatsangehörigkeit, Einbürgerung · tags: immigration, legal, citizenship, visa | entities: `[configured privately]` (e.g. `<private legal firm>`, `<private attorney>`) |
| `inherited-land` | Inherited land / protected nature reserve | keywords: Naturschutzgebiet, nature reserve, inherited land/property · tags: inherited-land | keywords/tags: `<private place name(s)>` `[configured privately]` |
| `health-medical` | Health / medical | keywords: medical, diagnosis, prescription, doctor, physician, hospital, clinic, health record, medication, treatment plan, mental health | — |
| `security-clearance` | Security-clearance work | keywords: security clearance, clearance, classified information/document, top secret, TS/SCI, SCI, background investigation, polygraph | — |
| `immediate-family-private` | Immediate-family PRIVATE personal details | tags: family-private | entities: `<private family member(s)>` · tags: `[configured privately]` |

The family rule matches **private personal details only** — a plain family
mention with no private-detail signal stays normal.

### Private overlay

Personal specifics never live in the public source tree. The classifier loads an
optional **private overlay** at runtime from a path **outside the repository**:

- Resolved from `LIVING_ATLAS_TIERING_PRIVATE_RULESET` (a path), defaulting to
  `$HOME/Library/Application Support/LivingAtlas/personal-prod/tiering-private-ruleset.json`.
- If present, its per-rule `entity_names` / `keywords` / `tags` are **merged**
  (appended + de-duplicated) into the matching generic rule **by `id`**. It can
  only extend rules that already exist — it cannot introduce new rule ids.
- If absent or malformed, the generic default is used unchanged (fail-safe).

Overlay file shape:

```json
{
  "overlay_schema": "living-atlas-tiering-private-overlay:v1",
  "rules": [
    { "id": "immigration-legal", "entity_names": ["<private legal firm>", "<private attorney>"] },
    { "id": "inherited-land", "keywords": ["<private place>"], "tags": ["<private tag>"] },
    { "id": "immediate-family-private", "entity_names": ["<private family member>"], "tags": ["<private tag>"] }
  ]
}
```

The `real-data:tiering-dryrun` and `real-data:tier-coverage` tools call
`loadPrivateTieringRuleset()`, so a local run picks up the overlay automatically.
The independent full-body backstop (`resolvePrivateBackstopTerms`) folds the
overlay's terms in too, so a specific private name that the generic term list
cannot enumerate is still caught. The overlay is **never printed**.

### Adjusting the ruleset

The ruleset is plain data. To add or refine:

```ts
const custom = {
  ...DEFAULT_TIERING_RULESET,
  rules: [
    ...DEFAULT_TIERING_RULESET.rules,
    { id: "romania-mod", keywords: ["Minister of Defense", "Romania MoD"], entity_names: [], tags: [] }
  ]
};
```

Set `enabled: false` on a rule to disable it without deleting. Re-run the
dry-run after any change and eyeball the match list.

### Undecryptable objects

If an object cannot be decrypted (unknown algorithm, missing key), the
classifier holds it as **super-sensitive** and it is **not** re-encrypted into
either cloud tier — content that cannot be inspected is never exposed to the
cloud. It stays on `local-keyring-v1`. (In the current personal-prod graph all
live objects decrypt, so `undecryptable_held` is 0. This is the *only* case that
stays local-keyring-only under the corrected model.)

## Key management

Two distinct 32-byte secrets drive the model. See
`packages/local-keyring/src/escalation-key.ts`.

| Key | Purpose | Proposed Keychain service |
|-----|---------|---------------------------|
| **Primary cloud-unlock key** | Decrypts the normal tier. | `io.livingatlas.personal-prod.cloud-unlock-key` |
| **Escalation key** | Decrypts the super-sensitive tier (after escalation). | `io.livingatlas.personal-prod.escalation-key` |

- `generateTieringKeyMaterial()` mints a fresh, provably-distinct pair.
- `addTieringKeysToKeyring()` carries **both** keys into the local sealed keyring
  as `data-encryption` key records (stable ids `la_key_tiering_primary` /
  `la_key_tiering_escalation`), so a local holder decrypts everything with no
  escalation. Idempotent, lossless of existing access-class keys, and it survives
  the seal/open round-trip.
- Both secrets resolve at use via `resolveLocalSecret` (env override or macOS
  Keychain), exactly like the keyring/control-store/mcp-token secrets, and are
  **never printed**.

The generation/seal mechanism is proven on synthetic/temp keyrings in
`escalation-key.test.ts`. The real replica keyring is **not** modified in this
phase — provisioning the escalation key into it is a coordinated later step.

## Tooling

| Tool | npm script | What it does |
|------|-----------|--------------|
| Tiering classifier / planner | `real-data:tiering-dryrun` | DRY-RUN by default. Classifies every live object, writes tier counts + the full super-sensitive match list to `$R/tiering-dryrun.json`. Ack-gated apply (`LIVING_ATLAS_TIERING_APPLY_ACK=reencrypt-two-key-tiers-real-data`) is intentionally **not** wired to mutate the replica in this phase. |
| Tier-coverage gate | `real-data:tier-coverage` | Proves every normal object round-trips under the primary key; every super-sensitive object round-trips under the escalation key AND refuses without it (escalation gate fires); every object is cloud-decryptable in some tier (none stuck host-blind); plus the independent full-body backstop. Fails (exit 1) on any violation. Read-only, in-memory. |
| Synthetic escalation e2e | `cloud-unlock:e2e-proof` | Creates a normal + an escalated sample; proves normal→primary decrypt, escalated→escalation-required-without-the-key then decrypt-with-it, wrong-key and AAD-tamper denial, and leak custody for **both** keys. |
| Live cloud-unlock e2e | `cloudflare:live-cloud-unlock-proof` | Pushes samples to Cloudflare and unlocks via the remote MCP `sensitive_decrypt` tool (incl. the escalation header). Takes effect after a worker redeploy. |

The classifier, gate, and re-encrypt transforms share one module,
`packages/check/src/local-tiering.ts` (`classifyObjectTier`, `planTiering`,
`reencryptToTier`).

### Re-encryption properties

`reencryptToTier` routes each object into its target cloud tier:

- **normal** → `cloud-unlock-v1` under the **primary** key.
- **super-sensitive** → `cloud-unlock-escalated-v1` under the **escalation** key.
- **undecryptable** → held on `local-keyring-v1` (never cloud-exposed).
- **Lossless** — decrypting the result under the tier's key yields exactly the
  original plaintext; identity (id, version, access class, timestamps, key ref)
  is preserved.
- **Idempotent** — an object already in its correct target tier is skipped.
- **Nothing stays local-keyring-only** anymore except the conservative
  undecryptable hold.
- **Ack-gated, dry-run by default** — the CLI requires an explicit ack env var
  even to *consider* applying, and the apply path is deliberately not connected
  to any replica write in this phase.

## Dry-run over personal-prod (read-only)

Run 2026-07-04 against the live replica:

| Metric | Count |
|--------|-------|
| Total objects (incl. historical versions/tombstones) | 62,095 |
| Tombstoned/excluded | 39,201 |
| **Live objects** | **22,894** |
| → **normal** (cloud-unlock-v1) | 22,514 |
| → **escalated** / super-sensitive (cloud-unlock-escalated-v1) | 380 |
| → undecryptable held (local-keyring-v1) | 0 |
| already normal / already escalated | 0 / 0 |

The full match list — object id, matched rules, matched terms, and extracted
entity names — is written to `$R/tiering-dryrun.json` for eyeballing.

All 22,894 live objects currently remain `AES-GCM-256+local-keyring-v1` on the
replica; no real data has been re-encrypted. The two-tier layout above is the
**plan** the coordinated re-encryption phase will apply.

See `data-tiering-runbook.md` for the operational procedure, the escalation-key
provisioning step, and the **worker-redeploy requirement** (the escalation flow
only takes effect on Cloudflare after the worker is redeployed).
