import { afterEach, describe, expect, it, vi } from "vitest";
import { isAssertion, isRedaction, type AtlasAssertionRow } from "@living-atlas/atlas-client";
import { FIXTURE_ENTITY_NAMES, WRITABLE_PREDICATE } from "./fixture.js";
import { E2E_SCENARIO_TIMEOUT_MS, connect, createWorkspace, startServer, type AtlasWorkspace, type ServerHandle } from "./harness.js";
// These scenarios spawn real child processes; see E2E_SCENARIO_TIMEOUT_MS.
vi.setConfig({ testTimeout: E2E_SCENARIO_TIMEOUT_MS });


/**
 * What identifies a row, whether it arrived as content or as a stub.
 *
 * Written as an exhaustive walk rather than an index, because the identifier a
 * withheld row carries is NOT the identifier the record would have carried: a
 * stub id is per-credential and derived, and comparing one against an
 * assertion id across a restart would be comparing two different things.
 */
function rowIdentity(row: AtlasAssertionRow): string {
  if (isAssertion(row)) return `assertion:${row.assertion_id}`;
  if (isRedaction(row)) return `redaction:${row.redaction_id}`;
  return `error:${row.code}`;
}

/**
 * The whole point: the process is shot, and a consumer cannot tell.
 *
 * Every other scenario in this suite would pass against a server that held its
 * graph in memory. This one is why the store exists. The server is killed with
 * SIGKILL — not stopped gracefully, because a graceful stop lets a process flush
 * and proves only that an ORDERLY shutdown loses nothing. Every commit is meant
 * to be on disk before its receipt was returned, so a process being shot should
 * cost nothing that was ever acknowledged.
 *
 * Three claims are checked separately because they fail separately:
 *
 *  - the ANSWERS are the same. Same ids, same seqs, same order.
 *  - the CURSOR still resolves. A consumer that was mid-scan resumes where it
 *    was, into the same total order — the feed epoch did not roll.
 *  - the RECEIPT still replays. `(client_id, idempotency_key)` outlives the
 *    process, so a client retrying after a crash gets its original ids back
 *    instead of committing a second copy of a submission it already has a
 *    receipt for.
 */

type Running = { workspace: AtlasWorkspace; servers: ServerHandle[] };

const running: Running[] = [];

function freshWorkspace(): Running {
  const entry: Running = { workspace: createWorkspace(), servers: [] };
  running.push(entry);
  return entry;
}

function boot(entry: Running): ServerHandle {
  const server = startServer(entry.workspace);
  entry.servers.push(server);
  return server;
}

afterEach(async () => {
  while (running.length > 0) {
    const entry = running.pop();
    if (!entry) continue;
    for (const server of entry.servers) await server.stop();
    entry.workspace.dispose();
  }
});

describe("step 10 — the server is killed and restarted on the same data", () => {
  it("gives the same answers, resumes the same cursor, and still replays the original receipt", async () => {
    const entry = freshWorkspace();
    const first = boot(entry);
    const before = connect(entry.workspace, first);

    // Find the fixture subject the way a consumer would, then write through the
    // governed path so there is something in the store this process put there.
    const found = await before.searchText({ query: FIXTURE_ENTITY_NAMES[0] });
    const subject = found.results[0]?.record;
    expect(subject?.record_schema).toBe("atlas.entity:v1");
    const subjectId = String((subject as { entity_id?: unknown })?.entity_id ?? "");
    expect(subjectId).toMatch(/^la_entity_[0-9a-z]{26}$/);

    const proposal = {
      idempotency_key: "e2e-survives-a-restart",
      proposals: [
        {
          kind: "fact" as const,
          subject_entity_id: subjectId,
          predicate: WRITABLE_PREDICATE,
          value: "Synthetic Employer Written Before The Crash",
          confidence: { band: "high" },
          evidence_links: [{ evidence_id: "ev-restart", stance: "supports" }]
        }
      ]
    };

    const receipt = await before.proposeAssertions(proposal);
    expect(receipt.committed).toBe(1);

    const queryBefore = await before.queryAssertions({ page_size: 200 });
    const idsBefore = queryBefore.results.map(rowIdentity);
    const seqsBefore = queryBefore.results.filter(isAssertion).map((row) => row.seq);

    // Mid-scan: two changes read, a cursor held, and then the process dies.
    const firstPage = await before.readChanges({ cursor_seq: 0, limit: 2 });
    expect(firstPage.has_more).toBe(true);
    const heldCursor = firstPage.next_cursor_seq;
    const heldEpoch = firstPage.feed_epoch;
    const remainingBefore = await before.readChanges({ cursor_seq: heldCursor, feed_epoch: heldEpoch, limit: 200 });

    const pid = first.pid;
    expect(pid, "the server was not running to be killed").toBeDefined();
    await first.kill();
    expect(first.pid).toBeUndefined();

    // A NEW process, and a NEW client that is told nothing about the old one.
    const second = boot(entry);
    const after = connect(entry.workspace, second);

    // (1) The same answers. Ids are minted once and never reused, so an id that
    // changed across a restart would mean the store re-derived it — the defect
    // "ids minted, never derived" exists to make impossible.
    const queryAfter = await after.queryAssertions({ page_size: 200 });
    expect(queryAfter.results.map(rowIdentity)).toEqual(idsBefore);
    expect(queryAfter.results.filter(isAssertion).map((row) => row.seq)).toEqual(seqsBefore);
    // The belief-time floor and the feed epoch came back from the log's own
    // header rather than from the entry's defaults, so a restart cannot silently
    // re-found the feed.
    expect(queryAfter.horizon.bitemporal_since).toBe(queryBefore.horizon.bitemporal_since);
    expect(queryAfter.horizon.feed_epoch).toBe(queryBefore.horizon.feed_epoch);
    expect(queryAfter.horizon.seq_watermark).toBe(queryBefore.horizon.seq_watermark);

    // (2) The cursor still resolves, into the same total order. A rolled epoch
    // would refuse it, and a re-founded feed would answer it with different rows.
    const remainingAfter = await after.readChanges({ cursor_seq: heldCursor, feed_epoch: heldEpoch, limit: 200 });
    expect(remainingAfter.changes.map((change) => change.change_id)).toEqual(
      remainingBefore.changes.map((change) => change.change_id)
    );

    // (3) The receipt still replays. This is the one a consumer feels: after a
    // crash it does not know whether its write landed, so it retries — and gets
    // the ORIGINAL ids rather than a duplicate.
    const replayed = await after.proposeAssertions(proposal);
    expect(replayed.submission.submission_id).toBe(receipt.submission.submission_id);
    expect(replayed.submission.assertion_ids).toEqual(receipt.submission.assertion_ids);
    expect(replayed.submission.committed_at).toBe(receipt.submission.committed_at);
    expect(replayed.submission.state).toBe("replayed");
    expect(replayed.committed).toBe(0);

    // And no second copy exists to be found afterwards.
    const finalQuery = await after.queryAssertions({ page_size: 200 });
    expect(finalQuery.results.map(rowIdentity)).toEqual(idsBefore);
  });

  it("does not re-seed the fixture on a restart, because the store is what says whether it is empty", async () => {
    const entry = freshWorkspace();
    const first = boot(entry);
    const before = connect(entry.workspace, first);
    const originally = await before.queryAssertions({ page_size: 200 });
    await first.kill();

    const second = boot(entry);
    const after = connect(entry.workspace, second);
    const later = await after.queryAssertions({ page_size: 200 });

    // A harness that seeded on every boot would double its graph here, and every
    // count in every other scenario would quietly depend on how many times the
    // server had been started.
    expect(later.results).toHaveLength(originally.results.length);
    const search = await after.searchText({ query: FIXTURE_ENTITY_NAMES[0] });
    expect(search.results).toHaveLength(1);
    // The searchable set was rebuilt from the identity log, so a restarted
    // server reports the same number of plaintext candidates rather than zero.
    expect(search.search_scope.plaintext_candidates).toBe(FIXTURE_ENTITY_NAMES.length);
    expect(search.search_scope.encrypted_unsearchable).toBe(0);
  });

  it("refuses a request once the process is gone, rather than hanging on a dead pipe", async () => {
    const entry = freshWorkspace();
    const server = boot(entry);
    const client = connect(entry.workspace, server);
    await client.describeScope();

    await server.kill();

    // A transport that silently queued this would turn a dead server into a
    // timeout minutes later, at a call site that had nothing to do with it.
    await expect(client.describeScope()).rejects.toThrow(/no longer running|exited/);
  });
});
