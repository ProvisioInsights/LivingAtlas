import type { Assertion } from "./assertion.js";
import type { AssertionId } from "./ids.js";
import { scanSegmentLog } from "./segment-reader.js";

/**
 * The read index: by `assertion_id`, by `(subject_entity_id, predicate)`, and
 * by `seq`.
 *
 * It is a cache and never a source of truth, and the design enforces that
 * rather than asserting it — the index is never written to disk. There is no
 * index file to go stale, no invalidation to get wrong, and no possibility of a
 * reader answering from an index that disagrees with the segments. Startup pays
 * a full scan; in exchange the class of bug where the index and the log tell
 * different stories cannot occur.
 */
export class LogIndex {
  private readonly byId = new Map<AssertionId, Assertion>();
  private readonly bySubjectPredicate = new Map<string, Assertion[]>();
  private readonly bySeq = new Map<number, Assertion>();

  /**
   * A NUL separator, because `predicate` is a caller-supplied free string.
   * With a printable separator a predicate containing it could forge a key for
   * a different subject, which is a lookup that silently returns another
   * entity's assertions.
   */
  private static key(subject: string, predicate: string): string {
    return `${subject}\u0000${predicate}`;
  }

  add(assertion: Assertion): void {
    this.byId.set(assertion.assertion_id, assertion);
    this.bySeq.set(assertion.seq, assertion);
    const key = LogIndex.key(assertion.subject_entity_id, assertion.predicate);
    const bucket = this.bySubjectPredicate.get(key);
    if (bucket) bucket.push(assertion);
    else this.bySubjectPredicate.set(key, [assertion]);
  }

  get(assertionId: AssertionId): Assertion | undefined {
    return this.byId.get(assertionId);
  }

  atSeq(seq: number): Assertion | undefined {
    return this.bySeq.get(seq);
  }

  /** Every assertion for the pair, superseded ones included — belief filtering
   * belongs to the query, not to the index. An index that hid superseded rows
   * would make the as-of read impossible to serve from it. */
  forSubjectPredicate(subject: string, predicate: string): Assertion[] {
    return this.bySubjectPredicate.get(LogIndex.key(subject, predicate)) ?? [];
  }

  get size(): number {
    return this.byId.size;
  }
}

export function buildIndex(assertions: Iterable<Assertion>): LogIndex {
  const index = new LogIndex();
  for (const assertion of assertions) index.add(assertion);
  return index;
}

/**
 * Rebuild the index from the segment files alone — no running store, no
 * snapshot, no sidecar. This is the executable form of "the index is
 * rebuildable", and the tests use it to prove a rebuilt index answers
 * identically to the one the live store has been maintaining.
 */
export function rebuildIndexFromSegments(directory: string): LogIndex {
  const scan = scanSegmentLog(directory, { repair: false });
  return buildIndex(scan.restored.assertions);
}
