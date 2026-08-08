# ADR 0032: The Credential Directory, And The Owner's Grant

Status: Accepted for implementation
Date: 2026-08-08

## Context

The consumer plane is served (ADR 0028) and the store it serves is the applied
migration (ADR 0030, ADR 0031). The store holds records **cleartext at rest**
behind `0600`/`0700` permissions: there is no keyring in its read path, and
withholding a record is an **authorization decision made per read** against the
caller's grant, not encryption. `access.ts` is that decision — `reachesTier` is a
membership test, and a record whose tier the grant does not name comes back as an
`atlas.redaction:v1` stub.

The shipped stdio entry (`cli.ts`) authenticates nobody. It serves ONE hardcoded
principal, `local-consumer`, whose grant reaches `open` alone. Because
`local-private` is the tier atlas-core stamps on anything committed without an
explicit classification — nearly all of a migrated graph — the owner opening
their own graph in Claude Desktop sees redaction stubs, not content. The consumer
cutover doc (`LivingAtlas-Deploy/docs/atlas-consumer-cutover.md`) says so in as
many words and defers the fix: "Reading further needs a credential directory and
a grant that names the tier. That is a separate piece of work and is not wired
here."

This ADR is that separate piece of work. The grant machinery already exists —
ADR 0015 defined the capability grant (`sensitivity_reachable`, `tools_permitted`,
`predicates_writable`, `write_tiers_permitted`, `limits`), and `credentialResolver`
already maps a presented secret to a principal through an `InMemoryCredentialDirectory`.
What is missing is the piece that maps an on-disk configuration to those
principals, and a grant that reaches the tier the owner's own content sits at.

Three constraints bound the design, and each is a failure mode named so it can be
tested rather than hoped for:

- **Unlocking is a GRANT, not a decrypt.** There is no key in the read path to
  hand over. Widening what the owner may read is widening a `sensitivity_reachable`
  set, and this ADR introduces no key material anywhere.
- **The sealed tier stays behind MRTR.** The two-key sealed/escalation reveal
  (ADR 0014) is a deliberate, audited gate. A grant that reached the sealed tier
  by listing it would make that gate decorative.
- **A misconfiguration must FAIL, not degrade.** A server that silently fell back
  to the open-only principal would serve stubs while looking healthy; one that
  fell back to reaching everything would be a privilege escalation by way of a
  typo. Both are refused at startup.

## Decision

### 1. A credential directory on disk, named by the environment

`LIVING_ATLAS_CREDENTIAL_DIR` (house style `LIVING_ATLAS_*`, matching
`LIVING_ATLAS_STORE_DIR`) names a **directory** of one-record-per-file JSON
documents. Each file holds a `{ token_hash, principal }` record — the same shape
the operator plane already loads (`operator/cli.ts`), now shared through one
`parseCredentialRecord` so the two config surfaces cannot drift on what a valid
record is.

A directory of files rather than a single array file, deliberately: one principal
per file is reviewable on its own, can carry its own `0600` permissions, and
adding a principal is adding a file rather than editing a shared array. The
operator plane keeps its single admin-managed array file — a different surface
with a different custodian — and the two share only the record shape.

The file holds a `sha256:` **hash** of the shared secret, never the secret. That
is what keeps a credential set reviewable in a diff without being a leak, and it
is enforced: `parseCredentialRecord` refuses a `token_hash` that is not a hash,
and `PrincipalSchema` parses (never trusts) the principal, so a principal whose
plane and credential class disagree is refused when the file is read rather than
when a call finally arrives against it.

### 2. Absent env is unchanged behaviour

`credentialDirectoryFromEnvironment` returns `undefined` when the variable is
unset or empty (`VAR=` is how a shell leaves a variable unset). The entry point
then keeps its hardcoded open-only `local-consumer` principal and prints the same
"no credential directory: every call is attributed to …" line it prints today.
Nothing existing breaks, and a deployment that never sets the variable is
byte-for-byte the server it was.

### 3. How a request becomes a principal, on each transport

`directoryPrincipalResolver` wraps `credentialResolver` with one addition:

- **A presented secret resolves through the directory**, unchanged. HTTP presents
  it as a bearer token (ADR 0019 / `http/auth.ts`); a consumer sharing one stdio
  pipe presents it in `_meta`. Same secret, same directory, same principal,
  whichever channel — the transport-parity property ADR 0015 made structural.
- **A request that presents NOTHING speaks as the connection's default
  principal**, selected by `--client-id` from the directory. This is the
  single-owner stdio case: on the pipe the connection itself is the trust
  boundary (`auth.ts`: "a process that can write to the pipe is already inside"),
  and Claude Desktop sends no per-request credential. Serving the connection's
  configured principal there is exactly the posture the shipped entry has today
  with its fixed `local-consumer` — only now the principal, and its grant, come
  from the directory instead of being hardcoded.

The default's plane is checked, so a directory whose selected principal belongs
to another plane refuses rather than serving it. The decision consults whether a
credential was presented and never how the request arrived, so it names no
transport. Over HTTP the bearer is always present by the time the resolver runs
(`http/serve.ts` rejects a tokenless POST with 401 before the server is built),
so the default branch is a stdio affordance in practice, not an HTTP one.

### 4. The owner grant reaches `local-private`, and stops there

The owner grant names `open` and `local-private` in `sensitivity_reachable`, and
nothing else. Because reachability is membership **by name** and not a rank
threshold, naming `local-private` (rank 10) grants nothing about `sealed` (rank
90): the sealed tier is unreachable through the owner grant, and a sealed record
is withheld from the owner twice over — the record is marked `withheld`, and the
grant does not name its tier. The owner reaches the sealed tier only through the
two-key MRTR reveal, which writes its own audit event; a grant broad enough to
skip that would make the escalation model decorative, so the owner grant stops at
`local-private` explicitly.

Reads remain reads. The owner grant lists no writable predicate and no writable
tier: widening what one principal may READ is a different decision from letting it
WRITE, and this lane makes only the first. The store is served read-only
regardless (ADR 0031 keeps `LIVING_ATLAS_STORE_MODE=read-only`), and enabling
writes stays a separate, later decision.

### 5. Enforcement stays in tool code

This ADR adds no enforcement path. `access.ts` already decides disclosure with
`reachesTier`; a grant that does not reach a tier still yields a redaction stub
with the named reason `sensitivity-withheld`. The credential directory only
widens which tiers ONE principal's grant names. The check that turns a grant into
a disclosure is unchanged and remains the single place the decision is made.

### 6. Refuse to start, never degrade

`loadCredentialDirectory` throws — and the entry point exits — when the directory
cannot be read, is not a directory, holds no credential files, holds a file that
is not valid JSON, holds a record whose `token_hash` is not a hash or whose
principal fails to parse, names one principal id twice, or shares a token hash
between two records. There is no path from a set `LIVING_ATLAS_CREDENTIAL_DIR` to
a running server that authenticates nobody, and none to a running server that
reaches everything. This mirrors `store.ts`, which refuses a missing store rather
than serving an empty one.

## Consequences

- The owner reads their own graph as content by pointing
  `LIVING_ATLAS_CREDENTIAL_DIR` at a directory holding one owner record and
  setting `--client-id` to that principal. Every call is attributed to the
  owner's `client_id` rather than the collapsed `local-consumer`.
- The sealed tier is not reachable by any grant this lane ships, and the MRTR gate
  is untouched.
- No key material is introduced; "unlocking" a read is and stays an authorization
  widening, consistent with the store holding records cleartext at rest.
- The example owner directory, the Claude Desktop env line, and an install note
  live in the private `LivingAtlas-Deploy` repo, not here — a public repo holds no
  deployment credential material, only the loader and its synthetic-fixture tests.

## Open questions

- **OPEN — secret rotation for a single record.** The directory refuses two
  records that share a `client_id`, so rotating a secret is editing the one
  record's `token_hash` in place. Whether an overlap window (two live secrets for
  one principal) is ever needed is deferred; nothing here forecloses adding it as
  a per-record list of hashes later.
- **OPEN — a durable/attested credential store.** The directory is plain files at
  `0600`. Whether a keychain- or TPM-backed store is warranted for the owner
  credential, versus filesystem permissions plus the local trust boundary, is not
  decided here.
