import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AtlasToolRefusal, isAssertion, isRedaction, type AtlasAssertionRow } from "@living-atlas/atlas-client";
import {
  STORE_FIXTURE_ENTITY_NAMES,
  STORE_FIXTURE_FEED_EPOCH,
  STORE_FIXTURE_HISTORY_FLOOR,
  STORE_FIXTURE_PREDICATE,
  seedStoreDirectory,
  type SeededStoreDirectory
} from "@living-atlas/atlas-mcp/testing";
import { E2E_SCENARIO_TIMEOUT_MS } from "./harness.js";
import { connectShipped, startShippedServer, type ShippedServer } from "./shipped-server.js";
// These scenarios spawn real child processes; see E2E_SCENARIO_TIMEOUT_MS.
vi.setConfig({ testTimeout: E2E_SCENARIO_TIMEOUT_MS });

/**
 * STEP 13 — the shipped binary is pointed at a store that already exists.
 *
 * Every other scenario in this suite drives `server-entry.ts`, which is the real
 * server wired up by the harness. This one drives the binary the package
 * declares in `bin`, given nothing but an audit-log path and the environment an
 * operator would set. That difference is the whole point of #71: "the server
 * works when a harness composes it" and "the thing you install can be pointed at
 * your graph" are different claims, and only the second one is a product.
 *
 * The store is built by atlas-core DIRECTLY, in a temporary directory, and
 * closed before the server ever sees it — the way a migration would leave one.
 * Nothing here reads a profile directory, a configured path, or any location a
 * real graph could be at.
 */

function rowIdentity(row: AtlasAssertionRow): string {
  if (isAssertion(row)) return `assertion:${row.assertion_id}`;
  if (isRedaction(row)) return `redaction:${row.redaction_id}`;
  return `error:${row.code}`;
}

type Scenario = { root: string; servers: ShippedServer[] };

const running: Scenario[] = [];

function scenario(): Scenario {
  const entry: Scenario = { root: mkdtempSync(join(tmpdir(), "atlas-serve-store-")), servers: [] };
  running.push(entry);
  return entry;
}

/** The audit log lives OUTSIDE the store: where a plane logs is not graph state. */
function auditLogFor(entry: Scenario): string {
  return join(entry.root, "audit.log");
}

function storeRootFor(entry: Scenario): string {
  return join(entry.root, "store");
}

function seed(entry: Scenario): SeededStoreDirectory {
  return seedStoreDirectory(storeRootFor(entry), { withheld: true });
}

function boot(entry: Scenario, options: { storeDirectory?: string } = {}): ShippedServer {
  const server = startShippedServer({
    auditLog: auditLogFor(entry),
    ...(options.storeDirectory === undefined ? {} : { storeDirectory: options.storeDirectory })
  });
  entry.servers.push(server);
  return server;
}

afterEach(async () => {
  while (running.length > 0) {
    const entry = running.pop();
    if (!entry) continue;
    for (const server of entry.servers) await server.stop();
    rmSync(entry.root, { recursive: true, force: true });
  }
});

describe("step 13 — the shipped binary serves a store from the environment", () => {
  it("reads back what atlas-core wrote, through the real client", async () => {
    const entry = scenario();
    const seeded = seed(entry);
    const client = connectShipped(boot(entry, { storeDirectory: storeRootFor(entry) }));

    // The entity, found the way a consumer would find one. A restarted or
    // misconfigured server that reported zero candidates would be reporting an
    // absence that is not there.
    const found = await client.searchText({ query: STORE_FIXTURE_ENTITY_NAMES[0] });
    expect(found.results).toHaveLength(1);
    expect(found.search_scope.plaintext_candidates).toBe(STORE_FIXTURE_ENTITY_NAMES.length);
    expect(found.search_scope.encrypted_unsearchable).toBe(0);
    const subject = found.results[0]?.record as { entity_id?: unknown } | undefined;
    expect(String(subject?.entity_id ?? "")).toBe(seeded.subjectEntityId);

    // The assertions, by value. This is the claim: bytes another process wrote
    // into a directory come back out of the shipped server's published tools.
    const page = await client.queryAssertions({ page_size: 200 });
    const values = page.results.filter(isAssertion).map((row) => row.value);
    for (const seededValue of seeded.openValues) expect(values).toContain(seededValue);

    // The store's own header won over any default the entry could have supplied.
    expect(page.horizon.feed_epoch).toBe(STORE_FIXTURE_FEED_EPOCH);
    expect(page.horizon.bitemporal_since).toBe(STORE_FIXTURE_HISTORY_FLOOR);

    // The sealed record occupies a row rather than going missing. The access
    // layer is live over a durable store, not only over the in-memory fixture.
    expect(page.results.filter(isRedaction)).toHaveLength(1);
  });

  it("gives the same answers after the process is killed and restarted on the same directory", async () => {
    const entry = scenario();
    seed(entry);
    const first = boot(entry, { storeDirectory: storeRootFor(entry) });
    const before = connectShipped(first);

    const queryBefore = await before.queryAssertions({ page_size: 200 });
    const idsBefore = queryBefore.results.map(rowIdentity);
    const seqsBefore = queryBefore.results.filter(isAssertion).map((row) => row.seq);
    expect(idsBefore.length).toBeGreaterThan(0);

    // Mid-scan: a cursor held, then the process dies. SIGKILL, not a graceful
    // stop — serving from disk is only worth anything if it survives the case
    // where the server was given no chance to tidy up.
    const firstPage = await before.readChanges({ cursor_seq: 0, limit: 2 });
    expect(firstPage.has_more).toBe(true);
    const heldCursor = firstPage.next_cursor_seq;
    const heldEpoch = firstPage.feed_epoch;
    const remainingBefore = await before.readChanges({ cursor_seq: heldCursor, feed_epoch: heldEpoch, limit: 200 });

    expect(first.pid, "the server was not running to be killed").toBeDefined();
    await first.kill();
    expect(first.pid).toBeUndefined();

    // A NEW process, and a NEW client that is told nothing about the old one.
    const after = connectShipped(boot(entry, { storeDirectory: storeRootFor(entry) }));

    const queryAfter = await after.queryAssertions({ page_size: 200 });
    // Ids are minted once and never reused, so an id that changed across a
    // restart would mean the store re-derived it.
    expect(queryAfter.results.map(rowIdentity)).toEqual(idsBefore);
    expect(queryAfter.results.filter(isAssertion).map((row) => row.seq)).toEqual(seqsBefore);
    expect(queryAfter.horizon.feed_epoch).toBe(queryBefore.horizon.feed_epoch);
    expect(queryAfter.horizon.bitemporal_since).toBe(queryBefore.horizon.bitemporal_since);

    // The cursor still resolves, into the same total order. A re-founded feed
    // would answer it with different rows; a rolled epoch would refuse it.
    const remainingAfter = await after.readChanges({ cursor_seq: heldCursor, feed_epoch: heldEpoch, limit: 200 });
    expect(remainingAfter.changes.map((change) => change.change_id)).toEqual(
      remainingBefore.changes.map((change) => change.change_id)
    );
  });

  it("refuses a proposal because the store is read-only, and the bytes stay unwritten", async () => {
    const entry = scenario();
    const seeded = seed(entry);
    const client = connectShipped(boot(entry, { storeDirectory: storeRootFor(entry) }));

    const before = await client.queryAssertions({ page_size: 200 });

    const refusal = await client
      .proposeAssertions({
        idempotency_key: "against-a-read-only-store",
        proposals: [
          {
            kind: "fact",
            subject_entity_id: seeded.subjectEntityId,
            predicate: STORE_FIXTURE_PREDICATE,
            value: "Never Committed",
            confidence: { band: "high" },
            evidence_links: [{ evidence_id: "ev-refused", stance: "supports" }]
          }
        ]
      })
      .then(
        () => undefined,
        (cause: unknown) => cause
      );

    expect(refusal).toBeInstanceOf(AtlasToolRefusal);
    expect((refusal as AtlasToolRefusal).code).toBe("store-read-only");

    const after = await client.queryAssertions({ page_size: 200 });
    expect(after.results.map(rowIdentity)).toEqual(before.results.map(rowIdentity));
  });

  it("serves the empty in-memory graph when the environment names no store", async () => {
    // The unchanged path. Every existing test and the whole fixture harness
    // depend on this entry still starting with nothing behind it.
    const entry = scenario();
    seed(entry);
    const server = boot(entry);
    const client = connectShipped(server);

    const page = await client.queryAssertions({ page_size: 200 });
    expect(page.results).toEqual([]);
    // The store on disk is right there and untouched — the variable is what
    // decides, not the presence of a directory next door.
    expect(existsSync(join(storeRootFor(entry), "assertions"))).toBe(true);
    expect(server.diagnostics.join("\n")).toContain("serving an EMPTY in-memory graph");
  });

  it("exits rather than serving an empty graph when the store directory is not there", async () => {
    // The failure this whole lane exists to make impossible: a typo'd path
    // answering every query with an empty page, which looks exactly like a
    // healthy server over a graph that has nothing in it.
    const entry = scenario();
    const absent = join(entry.root, "not-a-store");
    const server = boot(entry, { storeDirectory: absent });

    const code = await server.exited;
    expect(code).toBe(2);
    expect(server.diagnostics.join("\n")).toContain("does not exist");
    // And it did not help by creating one.
    expect(existsSync(absent)).toBe(false);

    // A client gets a dead pipe rather than an empty answer.
    await expect(connectShipped(server).queryAssertions({})).rejects.toThrow(/no longer running|exited/);
  });
});
