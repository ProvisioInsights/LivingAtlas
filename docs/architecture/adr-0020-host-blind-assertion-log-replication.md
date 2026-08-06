# ADR 0020: Host-Blind Replication Of The Assertion Log To D1 And R2

Status: Accepted for implementation — design only, no worker code in this change
Date: 2026-08-04

Supersedes the replication half of
[Cloudflare-First Bootstrap And Local Sync](cloudflare-first-bootstrap-and-local-sync.md)
("Continuous Sync") and
[Offline Sync And Conflict Resolution](offline-sync-and-conflict-resolution.md).

Relates to: [ADR 0001](adr-0001-local-first-host-blind-sync.md),
[ADR 0011](adr-0011-segment-log-durability-and-compaction.md),
[ADR 0019](adr-0019-streamable-http-transport.md),
[Metadata Leakage Budget](metadata-leakage-budget.md)

Legacy remote-half trackers: **#21**, **#22**, **#24**.

## Context

The rewrite produced a durable local store — a segment log with an append-only
record union, a `seq`-ordered change feed, a published watermark that authorises
compaction, a history floor that refuses rather than lies, and repair records
that survive compaction. It produced a consumer contract and, in ADR 0019, two
transports for it.

It did not produce the remote half. `packages/cloudflare-worker` and
`packages/sync-agent` still describe the old store's world, and issues #21, #22
and #24 have sat open because the thing they track cannot be built from a design
that predates the log. The legacy sync design assumed a document store with
last-writer-wins reconciliation over mutable objects. The current store has none
of those properties: records are append-only, `superseded_at` is expressed as an
append rather than an edit, and ordering is a `seq` the store owns.

So the remote plane is not blocked on effort. It is blocked on a replication
design for *this* log. This ADR is that design.

One framing decision governs everything below, and it is worth stating before the
mechanics because half the legacy design's complexity came from not having made
it:

> **Replication is device-to-device synchronisation with an untrusted relay in
> the middle. It is not a remote read path for consumers.**

Consumers are served by the MCP planes of ADR 0014/0015/0019, which run where the
keys are. Cloudflare stores and orders ciphertext. It never becomes a place where
a query is answered, because a service that could answer a query about the graph
is a service that could read the graph — and AGENTS.md forbids designing one.

## Decision

### 1. The replicated unit is the commit group, and it is opaque

The log's atomicity boundary is already the commit group: the assertion and
supersession records of one submission, closed by the submission receipt written
last. A group without its receipt is a commit that died mid-write. That is
exactly the granularity replication needs, so replication adopts it rather than
inventing a second boundary that could disagree with the first.

Each group is serialised, AEAD-encrypted locally, and becomes one **envelope**:

```text
envelope := {
  header  (cleartext, authenticated as AAD)
  ciphertext
}

header := {
  format         "atlas.envelope:v1"
  feed_epoch     the seq space this belongs to
  seq_lo, seq_hi the seq range the group occupies
  envelope_id    opaque, minted, never derived from content
  key_id         which wrapped key opens this envelope
  prev_digest    digest of the previous envelope's header+ciphertext
  digest         digest of this envelope's ciphertext
  bytes          ciphertext length
}
```

Everything a relay needs to order, range-query, and hand back an envelope is in
the header. Everything about *what the graph says* is in the ciphertext. There is
no third category, and adding one is the change this design most needs a reviewer
to refuse.

`prev_digest` makes the feed a hash chain. That is not decoration: the relay is
untrusted, so a device must be able to detect a spliced, reordered, or omitted
envelope rather than trusting the order it was served in. Because the header is
the AEAD's associated data, a relay cannot restate an envelope's `seq` or epoch
without the device's decryption failing.

### 2. R2 holds bytes, D1 holds order

| | R2 | D1 |
| --- | --- | --- |
| Holds | one immutable object per envelope | one manifest row per envelope, plus head and cursor rows |
| Keyed by | `env/a=<opaque-authority>/e=<epoch>/<envelope_id>.bin` | `(feed_epoch, seq_lo)` |
| Written | once, never rewritten | append; head row advances |
| Answers | "give me these bytes" | "what comes after cursor N", "what is the head" |

The split follows from what each service can actually promise. R2 gives durable
immutable blobs but its listing is not an ordered transactional index. D1 gives
ordered range queries and a transactional head advance, which is what a cursor
needs, but is the wrong place for ciphertext bulk.

Object paths carry no titles, names, dates, predicates, or tags, per the
[R2 path rules](metadata-leakage-budget.md#r2-path-rules). `epoch` and an opaque
authority are the only structure.

**Write-once is enforced, not conventional.** An envelope id that already exists
in the manifest is never overwritten. A re-push of the same `(epoch, seq_lo)`
must carry the identical digest or be refused as a typed conflict — the same rule
the local store applies to idempotent commits, for the same reason: silently
accepting a second version of a committed fact is how a log stops being a log.

### 3. The head is signed, because a relay can lie by omission

A relay cannot read or forge envelopes, but nothing above stops it from serving a
*stale* head — replaying an earlier state and hiding recent commits. Encryption
does not address rollback.

So the head row is a record signed by the writing device:

```text
head := signed({ feed_epoch, high_seq, chain_digest, published_at })
```

Devices remember the highest `(epoch, high_seq)` they have seen and **refuse a
head that moves backwards**. A relay can therefore withhold the feed — which is
visible as a stall, and which no design can prevent — but it cannot convincingly
present a shorter history as the current one.

### 4. Epoch is about seq continuity; key rotation is not an epoch change

`feed_epoch` names one continuous `seq` space. It changes only when continuity
itself cannot be guaranteed — a restore from backup, or any event that could
reissue a `seq`. On change, the new epoch is a fresh namespace and the old one is
**retained, not deleted**, until every device has crossed over.

A device presenting a cursor from a superseded epoch is refused with a typed
error naming the current epoch, and never silently resumed. This is the same rule
`atlas.changes.read.v1` already applies locally with `feed-epoch-mismatch`, and
it exists because a consumer that resumes across an epoch boundary reads a
different history than the one its cursor described.

Key rotation deliberately does **not** rotate the epoch. Each envelope names its
`key_id`, so rotating forward leaves older envelopes readable by devices holding
the older wrapped keys. Conflating the two would force a full re-replication on
every rotation, which is the kind of cost that gets rotation quietly disabled.

### 5. Replication acknowledgement bounds local compaction

The local invariant is that compaction never crosses the published watermark and
never reclaims repair records. Replication adds a second consumer, and it is a
consumer whose lag is not observable from inside the process.

The rule: **local compaction may not reclaim above the lowest durably
acknowledged replication cursor.** An envelope is acknowledged when D1 holds its
manifest row *and* R2 holds its object — manifest last, so a crash leaves bytes
without a row (invisible, harmless) rather than a row without bytes (a hole a
device would read as corruption).

The remote retention floor is tracked separately and may sit *below* the local
one: the relay is the archive, and an archive that forgot faster than the origin
would be pointless. A device resuming from a cursor below the remote floor is
refused with the floor's value, never served a silently truncated range — the
history-floor rule, applied to the remote.

### 6. What the worker can and cannot serve

**Can, with no keys:**

- `GET /head` — signed head: epoch, high seq, chain digest.
- `GET /feed?epoch=&after=&limit=` — manifest rows in `seq` order.
- `GET /env/<envelope_id>` — ciphertext bytes.
- `PUT /env/<envelope_id>` — write-once accept from the lease-holding writer.
- Authenticate a device, count its calls, rate-limit it, and refuse it.

**Cannot, by construction:**

- Decrypt an envelope, or learn a subject, predicate, value, or sensitivity tier.
- Filter, search, aggregate, or answer any question about graph content.
- Reorder or omit without detection, or move the head backwards undetected.
- Decide access per record. Authorisation is per *device*, all-or-nothing over
  the feed, because per-record authorisation requires reading the record.

That last line is the load-bearing one. It means there is no such thing as a
remote consumer that reads graph content without keys, and it forecloses the
gradual slide — one plaintext field for filtering, then another — that turns a
host-blind relay into a host that can read everything. `remote-safe` and
`shareable` projections remain a separate, explicitly classified export path and
are out of scope here.

### 7. V1 has one writer, and says so

The legacy design promised offline multi-writer reconciliation. This one does not
attempt it. A single device holds a **writer lease**; every other device is a
read-only replica that applies the feed. Two devices appending to one `seq` space
is not a conflict to resolve, it is a corrupted log.

This is a real capability reduction relative to what the legacy documents
described, and it is deliberate: multi-writer needs per-device seq spaces merged
by `(device, seq)` with a defined interleaving, and inventing that now — before
anything replicates at all — would be designing the hard half first and the
useful half never. See OPEN-14.

### 8. Leakage this accepts

Consistent with the existing budget: the relay learns that an account has a
graph, roughly how large it is, roughly how often it commits, and how many
envelopes exist. One envelope per commit group means envelope count tracks commit
count, which is a finer-grained cadence signal than the batched segments the
budget anticipated. Accepted for v1 and named as OPEN-13 rather than mitigated
with padding now, because padding and batching trade against resume latency and
that trade should be made with a real workload in front of it.

## Consequences

- #21, #22 and #24 have a design to be implemented against, and their legacy
  premises — mutable objects, last-writer-wins — are formally withdrawn.
- The worker's surface is small enough to review in one sitting, and every route
  on it is answerable without a key. A route that needs one is a design error,
  not a feature request.
- The local store needs one new durable concept, the replication cursor, and it
  bounds compaction. Nothing else about the log changes.
- Restoring from backup is an epoch change, which is a visible, refusing event
  for every device rather than a silent divergence.

## Open questions

- **OPEN-12: envelope key management.** `key_id` names a wrapped key; which
  keyholding path wraps it for which device, and how a device is added or
  revoked, is `packages/local-keyring` and `packages/remote-crypto` territory and
  is not settled here. Revocation in particular is unresolved: a revoked device
  keeps any envelope it already fetched, so revocation bounds future reads only.
- **OPEN-13: cadence leakage from per-group envelopes.** One object per commit
  group publishes commit timing at commit granularity. Packing consecutive groups
  into fixed-size objects with padding would blunt it at the cost of resume
  latency and a dedup story for re-packed ranges.
- **OPEN-14: multi-writer.** Per-device seq spaces merged by `(device, seq)` is
  the obvious shape, but the interleaving rule, its interaction with
  `superseded_at` write-once, and what a lease failure looks like are all
  undecided. V1 refuses a second writer rather than guessing.
- **OPEN-15: how the writer lease is held and lost.** A lease needs a holder, an
  expiry, and a safe hand-off. Whether that is a D1 row with a fencing token or
  something stronger is not decided, and a lease that can be held by two devices
  at once is the failure that produces the corrupted log §7 refuses.
- **OPEN-16: chain verification cost on first sync.** A device joining an
  established feed must verify a chain from the remote retention floor forward.
  Whether periodic signed checkpoints should let it start mid-chain — and what
  that concedes to a relay that withholds the segment before a checkpoint — is
  open.
