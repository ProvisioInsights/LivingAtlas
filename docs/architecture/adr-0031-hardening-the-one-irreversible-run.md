# ADR 0031: Hardening the One Irreversible Run

Status: Accepted for implementation
Date: 2026-08-06

## Context

ADR 0030 wired the migration's four ports to the durable core and gave
`real-data:migration-apply` three guards. An adversarial review of that entrypoint
— run against real behaviour rather than against the code's own comments — found
that several of its stated properties were not properties the code had. Each item
below is a defect that was measured, not one that was reasoned about.

The run this protects is irreversible and happens once. New-format backup is
deferred (ADR 0030), so a mistake made here has the frozen replica as its only
remedy, and only for what the migration read — never for what it wrote.

## Decision

### 1. A guard that could not check now says so, in the one case that mattered

`launchctlSyncDaemonProbe` treated every non-zero exit from `launchctl print` as
proof the sync daemon was not loaded. Measured on the operator's host:

| invocation | exit |
| --- | --- |
| `launchctl print gui/501/<a job that is loaded>` | 0 |
| `launchctl print gui/0/<the same job>` | 125 |
| `launchctl print gui/501/<a job that does not exist>` | 113 |
| `launchctl print gui/0` | 125 |

Only **113** ("Could not find specified service") answers the question. **125**
("Domain does not support specified action") means the domain was never reached —
which is what every probe returns from a context with no live GUI session: under
`sudo`, over ssh, or from a launchd-spawned shell. The guard therefore passed
while the daemon was loaded and writing, which is the two-writer catastrophe its
own comment says it exists to prevent. `process.getuid?.() ?? 0` made it worse by
defaulting to the single uid most likely to name an unreachable domain.

So: the not-loaded code is **whitelisted**, the domain is probed first, and a
missing `process.getuid` refuses instead of substituting zero. Everything else is
`undeterminable`, which was already a refusal.

### 2. The report is a write, and writes are guarded

`MIGRATION_APPLY_REPORT_OUT` was an operator-supplied path handed straight to a
truncating `writeFileSync`, with none of the treatment the target path gets. It
now runs through the same real-path, symlink-resolved comparison, against BOTH
protected trees:

- inside the frozen replica — the tree D-BACKUP designates as the entire recovery
  story, where a typo would truncate `snapshot.json` after a successful migration;
- inside the new store — where the same typo would truncate
  `provisional-blocks.jsonl`, every carried block, immediately after carrying them.

Its directory must also exist, checked in the preflight. Today's failure mode is a
full migration followed by `ENOENT` and no report at all, at the one moment the
report matters most. The same guard is applied to the dry-run and verify
entrypoints, whose "read-only by construction" claims had the identical hole.

### 3. A target holding a foreign store is refused before the first byte

The apply opened whatever directory it was handed and discovered contamination
only from the post-hoc census. Measured: a plan migrated under a different
authority, then the real plan at the same target — `ok:false`, **empty refusal
list**, three count mismatches, and **49 records already committed** into a store
that was not theirs.

Guard 4 takes a census of the target before the plane is opened and requires that
every record it holds belongs to THIS plan: entities by `provenance.basis`,
submissions and carried lines by idempotency key, alias rows by legacy object id.
A resume of the same plan passes — that is the whole design and a separate test
holds it. Anything else refuses with counts only, never ids.

### 4. The carried file gets the segment log's tail rule

`readProvisionalBlockLines` threw on any unparseable line and is called by both
the census and the plane's constructor, so an interrupted append left the store
**unopenable and the migration unresumable**: the operator could neither finish
the run nor find out what it had done. atlas-core states the rule directly —
"Damage is only ever repaired where damage is POSSIBLE — the tail of the final
segment" — and the file taking the overwhelming majority of the writes ignored it.

Now: a malformed COMPLETE line still refuses (that is corruption or tampering); a
torn FINAL line is tolerated, and truncated by the WRITER only, because torn bytes
left in place are welded into the middle of the file by the next append. The
discarded byte count and a SHA-256 of the discarded bytes are written to the audit
file before the run writes anything, surfaced on the apply report, and counted as
damage by the read-only verifier — so the tear is evidence rather than silence.

`writeSync` is also allowed to write fewer bytes than it was handed, and no call
site in this repo looped on the return value. `writeAllSync` in atlas-core does,
and every append now goes through it.

### 5. A run that dies still produces an event and a report

`applyProjectionPlan` recorded its single audit event only after both loops
completed, so any throw in between exited with records already durable and nothing
naming the run that wrote them. Measured: six commits then ENOSPC left seven
entities permanently in the identity log, zero audit events, and no audit file.

`MigrationApplyAudit["outcome"]` gains `aborted`, carrying the counters as of the
throw; `runMigrationApply` catches, still takes the census, and still renders and
writes the report. The abort's MESSAGE stays off the report and goes to stderr —
it can name an idempotency key, which carries a legacy object id, and the report
is content-free.

### 6. The store is local-private, including its most content-bearing file

The plane pre-created the two log directories with a mode-less `mkdirSync`, which
landed them at 0755 and made `SegmentWriter`'s explicit 0700 a no-op — `mkdirSync`
does not chmod a directory that already exists. Both sidecars were opened with no
mode and landed at 0644. Measured after a successful apply: `d 755` root, `d 755`
assertions and identity (with `- 600` segments inside), `- 644 migration-apply.jsonl`,
`- 644 provisional-blocks.jsonl` — the file holding the source's outline prose
verbatim was the only file in the store anybody on the machine could read.

Modes are now taken from atlas-core (`LocalPrivateFileMode` /
`LocalPrivateDirectoryMode`) rather than re-typed, existing directories are
tightened rather than trusted, and a test stats every path under the target root
and fails on anything looser.

### 7. The faithfulness harness checks the fields the ADR promised

Check 4 compared block COUNT and TOTAL TEXT LENGTH only. Measured against a store
the real durable plane wrote: deleting a block's whole `properties` map, changing
its `depth`, changing its `index`, changing both source refs, and rewriting its
`text` to the same length ALL returned `ok: true` with zero findings — five of the
seven promised fields unverified end to end, the sixth only length-checked. The
verifier certified exactly the loss the deferral was accepted on a promise not to
cause.

It now compares a SHA-256 over each canonicalised block as a multiset — content-free
like a length, sensitive to every field, and reporting `block-digest-mismatch`
naming an idempotency key rather than a value. Sorted keys, with absent and empty
`properties` still distinguishable, because ADR 0029 leaves that difference
explicitly open and a canonicaliser that normalised it away would certify the loss
of the very distinction the ADR says must be preserved.

### 8. The apply report's arithmetic is stated in full

The report explained the gap between `assertions minted` and the store's assertion
count with one line — "of which absence" — and asserted in a comment that the
difference was "exactly the absences". That stopped being true when blocks were
carried. On the real corpus the headline would have read ~18,000 assertions minted
against a near-zero assertion count, with the only reconciling line naming
absences; an operator reading the review surface of the irreversible run would
have concluded 18,000 assertions had vanished. Two sub-lines are added, both
printed on every run, and a test asserts the equation over the block fixture so a
third non-assertion kind cannot silently reopen the gap.

## Consequences

- **The exposure D-BACKUP accepted is unchanged and still open.** New-format
  backup is deferred. The frozen old store plus its verified backup covers what
  the migration READ; nothing covers what it WROTE. Everything in this ADR reduces
  the chance of needing that recovery; none of it provides one.
- The launchd probe now refuses on hosts where launchd cannot be reached at all.
  That is deliberate: this is a macOS operator tool and a host that cannot answer
  the question is a host the migration must not run on.
- Guard 4 costs a full census of the target before every run, including resumes.
  On a store the size of this corpus that is a few seconds against an irreversible
  write.
- One `stat` per event is added to the consumer plane's audit journal, which now
  reopens when rotation renames its file out from under it. Without it, rotation
  moved the audit trail out of the documented path for the rest of the session and
  outside the rotator's own glob permanently — measured over a live server.
- `provisional-blocks.jsonl` can now be REPAIRED, which means a torn tail no longer
  blocks a resume. It also means bytes are discarded. They are named by digest in
  the audit file so they can be compared against a backup, and the run that
  discarded them says so on its report.

**OPEN — not decided here:**

- **OPEN-31.1** Whether the daemon should be re-probed AFTER the run and the
  report failed if it appeared mid-migration. The guard is evaluated once and the
  run is long; a daemon loaded at minute forty is a second writer the report
  currently would not mention.
- **OPEN-31.2** Whether `rotate-atlas-logs.sh` should skip files a live process
  holds open, now that the writer follows a rename. Today it rotates them and the
  writer follows; a generation that was already growing before this change is
  reported but not rotated.
- **OPEN-31.3** What a later pass does with a store whose carried file was
  repaired. The discarded bytes are named but not recoverable from the store
  itself; recovering them means going back to the frozen replica, which is only
  possible while it exists.
