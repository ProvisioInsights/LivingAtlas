import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RecordedAt } from "@living-atlas/atlas-core";
import {
  STORE_DIRECTORY_ENV,
  STORE_MODE_ENV,
  openAtlasStore,
  openStoreFromEnvironment,
  storeDirectoryFromEnvironment,
  storeLayout,
  storeModeFromEnvironment,
  type AtlasStore
} from "./store.js";
import {
  CONSUMER_PRINCIPAL,
  STORE_FIXTURE_FEED_EPOCH,
  STORE_FIXTURE_HISTORY_FLOOR,
  callTool,
  seedStoreDirectory,
  startHarness,
  withGrant,
  type Harness,
  type SeededStoreDirectory
} from "./testing.js";

/**
 * Opening a durable store, proven against a REAL segment log in a temporary
 * directory.
 *
 * Everything here is synthetic and lives under `os.tmpdir()`. Nothing reads a
 * profile directory, a configured path, or any location a real graph could be
 * at — the store these tests open is one they built two lines earlier.
 */

const roots: string[] = [];
const opened: AtlasStore[] = [];
const harnesses: Harness[] = [];

afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()?.handle.close();
});

afterEach(() => {
  // Closed before the directory goes, and closed even when a test failed: a
  // store left open holds this process's one handle on that path, and the next
  // test to open the same directory would fail for the wrong reason.
  while (opened.length > 0) opened.pop()?.close();
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

function track(store: AtlasStore): AtlasStore {
  opened.push(store);
  return store;
}

/** An empty directory that is not a store. */
function emptyRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "atlas-store-test-"));
  roots.push(root);
  return root;
}

/** The shared fixture, in a directory this file will remove. */
function seededStore(options: { assertions?: number; withheld?: boolean } = {}): SeededStoreDirectory {
  return seedStoreDirectory(emptyRoot(), options);
}

/** Every file under a directory tree, with its bytes. The evidence for "wrote nothing". */
function snapshot(directory: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const next = join(current, entry.name);
      if (entry.isDirectory()) walk(next, `${prefix}${entry.name}/`);
      else files[`${prefix}${entry.name}`] = readFileSync(next, "utf8");
    }
  };
  walk(directory, "");
  return files;
}

describe("an absent store is an error, never an empty one", () => {
  it("refuses a root directory that does not exist, and does not create it", () => {
    const absent = join(emptyRoot(), "not-a-store");

    expect(() => openAtlasStore({ directory: absent })).toThrow(/root directory does not exist/);
    expect(existsSync(absent)).toBe(false);
  });

  it("refuses a root that exists but holds no assertion log, and does not create one", () => {
    // The dangerous case: a real directory, pointed at by mistake. Creating the
    // two log directories inside it would serve an empty graph from somebody's
    // home directory and report it as a healthy store.
    const root = emptyRoot();

    expect(() => openAtlasStore({ directory: root })).toThrow(/assertion log directory does not exist/);
    expect(existsSync(storeLayout(root).assertions)).toBe(false);
    expect(existsSync(storeLayout(root).identity)).toBe(false);
  });

  it("refuses a root whose identity log is missing even when the assertion log is there", () => {
    const root = emptyRoot();
    mkdirSync(storeLayout(root).assertions, { recursive: true });

    expect(() => openAtlasStore({ directory: root })).toThrow(/identity log directory does not exist/);
    expect(existsSync(storeLayout(root).identity)).toBe(false);
  });

  it("refuses a path that exists but is a file", () => {
    const root = emptyRoot();
    const file = join(root, "store");
    writeFileSync(file, "not a store", "utf8");

    expect(() => openAtlasStore({ directory: file })).toThrow(/is not a directory/);
  });
});

describe("read-only is the default and it writes nothing", () => {
  it("serves what the store holds without touching a byte of it", () => {
    const { root, subjectEntityId } = seededStore();
    const before = snapshot(root);

    const store = track(openAtlasStore({ directory: root }));

    expect(store.mode).toBe("read-only");
    expect(store.graph.readOnly).toBe(true);

    const page = store.graph.assertions.query({});
    expect(page.ok).toBe(true);
    if (page.ok) expect(page.hits).toHaveLength(3);
    expect(store.graph.entities.read(subjectEntityId)?.display_name).toBe("Synthetic Person Alpha");
    expect([...store.graph.searchableEntities()]).toHaveLength(2);

    // The store's own header won, not the defaults: nothing was passed in.
    expect(store.graph.assertions.feedEpoch).toBe(STORE_FIXTURE_FEED_EPOCH);
    expect(store.graph.assertions.bitemporalSince).toBe(STORE_FIXTURE_HISTORY_FLOOR);

    // No header, no repair record, no new segment. If a read-only open ever
    // constructs a SegmentWriter this is what fails.
    expect(snapshot(root)).toEqual(before);
  });

  it("throws on commit rather than accepting a write into memory", () => {
    const { root, subjectEntityId } = seededStore();
    const store = track(openAtlasStore({ directory: root }));

    // The tool layer refuses this first — see the propose handler. The throw is
    // the second line: an AssertionLog with no journal would otherwise return a
    // receipt for bytes that vanish at exit, which is worse than a refusal.
    expect(() =>
      store.graph.assertions.commit({
        client_id: "prober",
        idempotency_key: "should-not-land",
        drafts: [
          {
            kind: "fact",
            lineage_action: "assert",
            subject_entity_id: subjectEntityId,
            predicate: "worked-at",
            value: "Never Committed",
            confidence: { band: "high" },
            evidence_links: [{ evidence_id: "ev-nope", stance: "supports" }],
            supersedes: []
          }
        ]
      })
    ).toThrow(/opened read-only/);

    expect(store.status().assertions).toBe(3);
  });

  it("throws on advancing the history floor, so a forfeiture cannot happen in memory", () => {
    const { root } = seededStore();
    const store = track(openAtlasStore({ directory: root }));

    expect(() => store.graph.assertions.advanceHistoryFloor("2026-07-01T00:00:00.000Z" as RecordedAt)).toThrow(
      /opened read-only/
    );
    expect(store.graph.assertions.bitemporalSince).toBe(STORE_FIXTURE_HISTORY_FLOOR);
  });
});

describe("read-write is opt-in and durable", () => {
  it("commits through the store and the bytes survive a reopen", () => {
    const { root, subjectEntityId } = seededStore();

    const first = openAtlasStore({ directory: root, mode: "read-write" });
    expect(first.graph.readOnly).toBe(false);
    const result = first.graph.assertions.commit({
      client_id: "writer",
      idempotency_key: "written-through-the-store",
      drafts: [
        {
          kind: "fact",
          lineage_action: "assert",
          subject_entity_id: subjectEntityId,
          predicate: "worked-at",
          value: "Synthetic Employer Written Through The Store",
          confidence: { band: "high" },
          evidence_links: [{ evidence_id: "ev-written", stance: "supports" }],
          supersedes: []
        }
      ],
      sensitivity: { tier: "open", rank: 0, withheld: false }
    });
    expect(result.ok).toBe(true);
    first.close();

    const second = track(openAtlasStore({ directory: root, mode: "read-write" }));
    expect(second.status().assertions).toBe(4);
    const page = second.graph.assertions.query({ predicate: "worked-at" });
    expect(page.ok).toBe(true);
    if (page.ok) {
      expect(page.hits.map((hit) => hit.assertion.value)).toContain("Synthetic Employer Written Through The Store");
    }
  });
});

describe("one handle per store per process", () => {
  it("refuses a second open of the same directory, and allows it again after close", () => {
    const { root } = seededStore();
    const first = openAtlasStore({ directory: root });

    // Two SegmentWriters on one log interleave records and corrupt the commit
    // groups the reader depends on. Spelling the path differently must not get
    // around it, so the guard keys on the resolved real path.
    expect(() => openAtlasStore({ directory: root })).toThrow(/already holds the Atlas store/);
    expect(() => openAtlasStore({ directory: `${root}/` })).toThrow(/already holds the Atlas store/);

    first.close();
    track(openAtlasStore({ directory: root }));
  });

  it("does not keep the handle when the open itself failed", () => {
    const root = emptyRoot();
    // Missing logs: the open fails after the guard was taken.
    expect(() => openAtlasStore({ directory: root })).toThrow(/assertion log directory does not exist/);

    mkdirSync(storeLayout(root).assertions, { recursive: true });
    mkdirSync(storeLayout(root).identity, { recursive: true });

    // The retry an operator makes next must fail for its own reason, or succeed.
    // A leaked handle would report "already open" about a store nobody opened.
    track(openAtlasStore({ directory: root }));
  });
});

describe("the status is counts and health, never content or a path", () => {
  it("reports what the load found", () => {
    const { root } = seededStore({ withheld: true });
    const store = track(openAtlasStore({ directory: root }));
    const status = store.status();

    expect(status).toMatchObject({
      mode: "read-only",
      feed_epoch: STORE_FIXTURE_FEED_EPOCH,
      bitemporal_since: STORE_FIXTURE_HISTORY_FLOOR,
      assertions: 4,
      entities: 2,
      segment_repairs: 0,
      ignored_files: 0,
      conflicting_supersessions: 0,
      conflicting_alias_rows: 0
    });
    expect(status.assertion_segments).toBeGreaterThan(0);
    expect(status.identity_segments).toBeGreaterThan(0);

    // The directory is not in the result. The operator supplied it; a tool
    // result is not the place to publish where a deployment keeps its data.
    expect(JSON.stringify(status)).not.toContain(root);
  });

  it("counts a file that is not a segment rather than skipping it", () => {
    const { root } = seededStore();
    writeFileSync(join(storeLayout(root).assertions, "notes.txt"), "left behind", "utf8");

    const store = track(openAtlasStore({ directory: root }));
    expect(store.status().ignored_files).toBe(1);
  });

  it("opens a store that holds nothing and says so with a number", () => {
    // Present but empty is NOT the refused case: the refusal is about a
    // directory that is not there. A store with nothing in it is a fact an
    // operator has to be able to read, so it is reported rather than refused.
    const root = emptyRoot();
    mkdirSync(storeLayout(root).assertions, { recursive: true });
    mkdirSync(storeLayout(root).identity, { recursive: true });

    const store = track(openAtlasStore({ directory: root }));
    expect(store.status().assertions).toBe(0);
    expect(store.status().entities).toBe(0);
  });
});

describe("the derived predicate registry", () => {
  it("reports relational from the records and never guesses cardinality", () => {
    const { root } = seededStore();
    const store = track(openAtlasStore({ directory: root }));

    expect(store.graph.predicateRegistry()).toEqual([
      { predicate: "reports-to", cardinality: "multi-valued", relational: true },
      { predicate: "worked-at", cardinality: "multi-valued", relational: false }
    ]);
  });

  it("includes a predicate first asserted after the process started", () => {
    // atlas.contract.describe.v1 publishes this registry. A predicate committed
    // at runtime that did not appear in it would let one server publish a
    // vocabulary contradicting a record it had just returned.
    const { root, subjectEntityId } = seededStore();
    const store = track(openAtlasStore({ directory: root, mode: "read-write" }));
    expect(store.graph.predicateRegistry().map((entry) => entry.predicate)).not.toContain("lived-in");

    store.graph.assertions.commit({
      client_id: "writer",
      idempotency_key: "new-predicate",
      drafts: [
        {
          kind: "fact",
          lineage_action: "assert",
          subject_entity_id: subjectEntityId,
          predicate: "lived-in",
          value: "Synthetic Town",
          confidence: { band: "high" },
          evidence_links: [{ evidence_id: "ev-lived", stance: "supports" }],
          supersedes: []
        }
      ],
      sensitivity: { tier: "open", rank: 0, withheld: false }
    });

    expect(store.graph.predicateRegistry().map((entry) => entry.predicate)).toContain("lived-in");
  });
});

describe("the tool layer refuses the write before the log has to throw", () => {
  function errorPayload(response: { result?: Record<string, unknown> }): Record<string, unknown> {
    const content = response.result?.["content"] as { text: string }[] | undefined;
    return JSON.parse(String(content?.[0]?.text ?? "{}")) as Record<string, unknown>;
  }

  function proposeAgainst(store: AtlasStore, subjectEntityId: string, principal = CONSUMER_PRINCIPAL): Harness {
    const harness = startHarness({ graph: store.graph as never, principal });
    harnesses.push(harness);
    harness.client.send(
      callTool({
        id: 1,
        name: "atlas.assertion.propose.v1",
        args: {
          idempotency_key: "against-a-read-only-store",
          proposals: [
            {
              kind: "fact",
              lineage_action: "assert",
              subject_entity_id: subjectEntityId,
              predicate: "worked-at",
              value: "synthetic value",
              confidence: { band: "high" },
              evidence_links: [{ evidence_id: "ev-1", stance: "supports" }],
              supersedes: []
            }
          ]
        }
      })
    );
    return harness;
  }

  it("answers store-read-only, and the store is untouched", async () => {
    const { root, subjectEntityId } = seededStore();
    const before = snapshot(root);
    const store = track(openAtlasStore({ directory: root }));

    const harness = proposeAgainst(store, subjectEntityId);
    const payload = errorPayload(await harness.client.await(1));

    expect(payload["code"]).toBe("store-read-only");
    // Retryable, because reopening the store read-write makes the identical
    // request succeed and reopening is not something the caller does.
    expect(payload["retryable"]).toBe(true);
    expect(store.status().assertions).toBe(3);
    expect(snapshot(root)).toEqual(before);

    // One event, naming the reason. A refusal nobody can see in the log is a
    // refusal nobody can reconcile against.
    expect(harness.auditJournal.events).toHaveLength(1);
    expect(harness.auditJournal.events[0]?.reason_code).toBe("store-read-only");
  });

  it("names the store rather than the grant, even for a credential that could never write", async () => {
    // Order matters. `predicate-not-writable` would send the caller to
    // atlas.scope.describe.v1 and then to whoever issues grants, for a refusal
    // no grant can lift.
    const { root, subjectEntityId } = seededStore();
    const store = track(openAtlasStore({ directory: root }));
    const cannotWrite = withGrant(CONSUMER_PRINCIPAL, { predicates_writable: [], write_tiers_permitted: [] });

    const harness = proposeAgainst(store, subjectEntityId, cannotWrite);
    expect(errorPayload(await harness.client.await(1))["code"]).toBe("store-read-only");
  });

  it("does not refuse over the same store opened read-write", async () => {
    const { root, subjectEntityId } = seededStore();
    const store = track(openAtlasStore({ directory: root, mode: "read-write" }));

    const harness = proposeAgainst(store, subjectEntityId);
    const response = await harness.client.await(1);
    expect(response.result?.["structuredContent"]).toBeDefined();
    expect((response.result?.["structuredContent"] as Record<string, unknown>)["committed"]).toBe(1);
  });
});

describe("the environment names the store", () => {
  it("treats an unset or empty directory variable as no store at all", () => {
    expect(storeDirectoryFromEnvironment({})).toBeUndefined();
    // `VAR=` in a profile is how a variable is unset; opening the directory
    // named by the empty string would refuse to start a server nobody pointed
    // anywhere.
    expect(storeDirectoryFromEnvironment({ [STORE_DIRECTORY_ENV]: "" })).toBeUndefined();
    expect(openStoreFromEnvironment({})).toBeUndefined();
  });

  it("defaults the mode to read-only and refuses a value it does not understand", () => {
    expect(storeModeFromEnvironment({})).toBe("read-only");
    expect(storeModeFromEnvironment({ [STORE_MODE_ENV]: "" })).toBe("read-only");
    expect(storeModeFromEnvironment({ [STORE_MODE_ENV]: "read-write" })).toBe("read-write");
    // No fallback. A typo in the one variable that decides whether a server may
    // write must not silently select an answer.
    expect(() => storeModeFromEnvironment({ [STORE_MODE_ENV]: "readonly" })).toThrow(/must be one of/);
    expect(() => storeModeFromEnvironment({ [STORE_MODE_ENV]: "rw" })).toThrow(/must be one of/);
  });

  it("opens what both planes would open, from the same two variables", () => {
    const { root } = seededStore();
    const store = openStoreFromEnvironment({ [STORE_DIRECTORY_ENV]: root, [STORE_MODE_ENV]: "read-write" });
    expect(store).toBeDefined();
    if (store !== undefined) {
      track(store);
      expect(store.mode).toBe("read-write");
      expect(store.status().assertions).toBe(3);
    }
  });
});
