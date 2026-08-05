# ADR 0011: Segment-Log Durability And Watermark-Safe Compaction

Status: Accepted for implementation
Date: 2026-08-04

## Context

`packages/atlas-core` holds the assertion log in memory. It has to become
durable without weakening any invariant the contract rests on: minted ids,
per-assertion gapless `seq`, `recorded_at` assigned at commit, the write-once
supersession stamp, `(client_id, idempotency_key)` idempotency, the belief-time
history floor, and reported rather than performed absence.

The prior local store failed at exactly this layer, in three distinct ways that
this design has to make structurally impossible:

1. **It rewrote committed state.** `Map<ObjectId, Envelope>` behind a snapshot
   plus a journal, with the envelope overwritten on every mutation. 169,205
   mutations left zero recoverable prior states.
2. **Its `compact()` destroyed history in one step.** It wrote a snapshot from
   its own in-memory belief and then called `atomicWriteText(journalPath, "")`.
   Production `journal.jsonl` is 0 bytes today, and nothing in the files
   distinguishes "no mutations were ever recorded" from "every mutation was
   erased".
3. **Partial writes left invisible residue.** A snapshot write died at a 44 MiB
   buffer boundary and left an orphan `.tmp` behind that no load path mentioned.

## Decision

### Append-only NDJSON segments, with the file as the evidence

Records append as newline-delimited JSON to segment files named by a zero-padded
ordinal, so lexical order is log order. There is no manifest and no on-disk
index: the directory listing is the manifest.

A committed line is never rewritten. The write-once `superseded_at` /
`superseded_by` stamp is expressed as an APPENDED supersession record that the
reader folds in on load, not as an edit to the line it supersedes. This is the
whole point of the format — the original bytes stay where they were written, so
"this record was not altered" is checkable by reading the file rather than by
trusting the process that wrote it.

Every segment opens with a header record. That is load-bearing rather than
decorative: it makes a zero-byte segment *detectable*, which is precisely what
the zeroed production journal was not.

### Durability before visibility

`commit()` appends the whole group and fsyncs before any in-memory state
changes, and before `seq` advances. A receipt is a claim about the past — "this
is written" — so the durability port is synchronous. If the append throws, no
`seq` was burned, nothing entered the index, and no receipt exists, so the
caller's retry is a fresh commit rather than a replay of something that only
ever existed in RAM.

### The receipt is the commit marker

Within a commit the receipt is written LAST. A group without its receipt is a
commit that died mid-write and was never acknowledged to anyone, so the reader
discards it. This gives an atomic commit boundary in an append-only file purely
by ordering, with no two-phase protocol.

Two supporting invariants make it work: a record is never split across
segments, and **a segment boundary is always a commit boundary** (the roll
decision happens between groups, never inside one). Together they confine a
half-written commit to the tail of the final segment.

### Repair only where damage is possible

A torn tail — bytes with no terminating newline — is truncated for real on
load, and a trailing group with no receipt is truncated with it. Anything
unparseable in a sealed segment is refused, not repaired: a sealed segment was
fsynced and closed before the next byte was written, so damage there is
corruption or tampering. Truncation is real rather than skip-on-read, because
leaving the bytes in place welds them into the middle of the file as soon as the
next commit appends past them.

A `repair` record naming the byte count and a SHA-256 of the discarded bytes is
appended afterwards, so the file carries its own repair history. The digest lets
a human compare against a backup without copying possibly-sensitive plaintext
into the audit trail a second time.

### Unknown record kinds refuse the load

A record kind this build does not recognise is a hard refusal, not a skip. This
is the one place the repo's "reserved `other` member" convention does not apply:
`other` exists so a consumer can *recognise* that it received something it does
not understand. A reader that silently skipped unknown records would serve reads
as complete and would then let compaction discard the originals of records it
could not even name.

### The index is a cache, enforced by never writing it down

Lookups by `assertion_id`, by `(subject_entity_id, predicate)`, and by `seq` are
built in memory from the segments at open. There is no index file, so there is
no invalidation to get wrong and no possibility of a reader answering from an
index that disagrees with the log. Startup pays a full scan in exchange.

### Compaction: watermark, supersession, AND the history floor

`compact()` reclaims whole segments and never rewrites a file. A segment is
reclaimable only when all of the following hold:

1. it is not the segment currently being appended to;
2. every assertion in it is at or below the published change-feed watermark;
3. every assertion in it is superseded, **and stopped being believed at or
   before the belief-time history floor**;
4. it holds no `repair` record (damage evidence is never reclaimed).

Receipts held by a reclaimed segment are re-appended to the live log first, and
a `compaction` record is appended before any unlink, carrying the high-water
`seq`, the highest belief instant, the watermark, and the floor.

Everything not reclaimed is reported as a typed refusal with the rule that
stopped it. `compact()` re-reads the segments rather than trusting in-memory
state, and refuses entirely if the log needs repair.

## The fork: "superseded" is not sufficient for lossless

The task specification said a segment may be reclaimed when it is *entirely
below the watermark and entirely superseded*, and separately that compaction
must be *provably lossless*. Those two requirements conflict.

A superseded assertion is invisible to a present-tense read but fully visible to
an as-of read at any belief instant between its `recorded_at` and its
`superseded_at`. Discarding it on the strength of supersession alone silently
changes the answer to every as-of read in that window — reintroducing, in a
narrower form, exactly the defect the rewrite exists to eliminate.

**Decision: the stricter rule is implemented.** Condition 3 adds
`superseded_at <= history_floor`. Below the floor, belief-time reads are already
refused outright, so no permitted query can reach an instant where the record
was still current. That is what makes the discard provably lossless rather than
merely lossless-looking.

The consequence is that compaction can only ever reclaim what an owner has
explicitly forfeited. `advanceHistoryFloor()` is therefore added as a deliberate,
journalled, never-reversible act. **You cannot compact history you are still
promising to answer for.** This is reversible if the owner disagrees: relaxing
condition 3 is a one-line change, with the ADR recording what it costs.

## Consequences

- A reclaimed id resolves to a `ReclamationNote` (`seq`, when, from which
  segment), never to a bare "not found". A dangling reference and a typo are
  distinguishable, which they were not before.
- `changesSince()` publishes the watermark, and the advance is journalled only
  when it actually moves, so an idle poller appends nothing. The feed page also
  reports `retention_floor_seq` and `cursor_before_retention_floor`, so a
  consumer whose cursor predates retained history is told rather than silently
  resumed past a hole.
- A crash mid-compaction leaves a superset of the truth: the compaction record
  exists but the segments do not, and the reader treats the bodies as
  authoritative, dropping reclamation claims for assertions still on disk.
- Files that are not segments are reported as `ignored_files` rather than
  skipped, which is what would have surfaced the orphan `.tmp`.
- Startup cost is a full scan of the retained segments. Accepted: the
  alternative is a persisted index that can disagree with the log.

## Rejected Alternatives

### Snapshot plus journal

Rejected. It is the shape that failed. A snapshot is a rewrite of committed
state, and the journal-truncation step that pairs with it is what took the
production journal to zero bytes.

### In-place supersession stamping

Rejected. A writer that can seek to stamp one field can seek anywhere, which
makes every prior line unverifiable. Appending the stamp costs one line and
keeps the file as evidence.

### A persisted index or manifest

Rejected. Both can disagree with the segments, and the disagreement is always
resolved in favour of whichever the reader happened to trust.

### Skipping unrecognised record kinds for forward compatibility

Rejected. It converts a version mismatch into silent under-reporting, and then
lets compaction make the loss permanent.

## Implementation

- `packages/atlas-core/src/log-record.ts` — the on-disk record union
  (`header`, `assertion`, `supersession`, `submission`, `watermark`,
  `history-floor`, `compaction`, `repair`) and the commit-group rule.
- `packages/atlas-core/src/segment-writer.ts` — synchronous append, size-bounded
  roll at commit boundaries, fsync per group, owner-only file modes.
- `packages/atlas-core/src/segment-reader.ts` — parse, tail repair, typed load
  refusals, and the fold that reconstructs the log.
- `packages/atlas-core/src/log-index.ts` — the in-memory index and
  `rebuildIndexFromSegments()`.
- `packages/atlas-core/src/durable-log.ts` — `DurableAssertionLog.open()` and
  `compact()`.
- `packages/atlas-core/src/store.ts` — the `LogJournal` port, restore-on-open,
  `advanceHistoryFloor()`, the published watermark, and reclamation notes.

## Verification

- `durable-log.test.ts` — round-trip of assertions and receipts; feed epoch and
  history floor restored rather than re-derived; belief time still increasing
  after a restart under a rewound clock; supersession surviving a reload and
  still write-once; idempotent replay and payload-conflict refusal after a
  reload; index rebuilt from segments answering identically; compaction refusing
  above the watermark, refusing within the floor, refusing a believed record,
  and running losslessly across a reload; the floor never lowering; a failed
  commit burning no `seq`.
- `segment-reader.test.ts` — torn tail truncated with the rest surviving and the
  repair journalled; a torn record in a sealed segment refused; an unclosed
  commit discarded at the tail and refused mid-log; zero-byte segment, unknown
  record kind, malformed record, ordinal mismatch and feed-epoch mismatch all
  refused; an orphan `.tmp` reported.
