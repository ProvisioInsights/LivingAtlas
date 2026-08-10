import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openAtlasStore, type AtlasStore } from "./store.js";
import {
  CONSUMER_PRINCIPAL,
  callTool,
  seedStoreDirectory,
  startHarness,
  syntheticGraph,
  withGrant,
  type Harness
} from "./testing.js";

/**
 * `atlas.entity.create.v1` and `atlas.entity.rename.v1` (ADR 0035).
 *
 * The two properties worth a test are the ones the tools could plausibly get
 * wrong and nobody would notice for a long time: that a created id is MINTED
 * rather than derived from the name, and that a rename is not a
 * re-identification. Everything else here is the refusal surface, which is the
 * part that decides whether publishing a write verb grants anybody anything.
 *
 * Every store below is built in `os.tmpdir()` two lines before it is opened.
 * Nothing reads a profile directory or any path a real graph could be at.
 */

const harnesses: Harness[] = [];
const opened: AtlasStore[] = [];
const roots: string[] = [];

afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()?.handle.close();
  while (opened.length > 0) opened.pop()?.close();
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

function harness(...args: Parameters<typeof startHarness>): Harness {
  const instance = startHarness(...args);
  harnesses.push(instance);
  return instance;
}

function emptyRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "atlas-entity-write-"));
  roots.push(root);
  return root;
}

function track(store: AtlasStore): AtlasStore {
  opened.push(store);
  return store;
}

function structured(response: { result?: Record<string, unknown> }): Record<string, unknown> {
  return (response.result?.["structuredContent"] ?? {}) as Record<string, unknown>;
}

/**
 * A refusal's `atlas.error:v1`, read out of the text block.
 *
 * A refusal is a complete contract result carrying the error record, so it
 * arrives in `content`, not in a JSON-RPC error — which is the whole point of
 * the refusal design and the reason this cannot just read `response.error`.
 */
function errorPayload(response: { result?: Record<string, unknown> }): Record<string, unknown> {
  const content = response.result?.["content"] as { text: string }[] | undefined;
  return JSON.parse(String(content?.[0]?.text ?? "{}")) as Record<string, unknown>;
}

describe("atlas.entity.create.v1", () => {
  it("mints an id rather than deriving one from the name, and returns the whole record", async () => {
    const graph = syntheticGraph();
    const { client } = harness({ graph });

    client.send(
      callTool({
        id: 1,
        name: "atlas.entity.create.v1",
        args: { type: "organization", display_name: "Test Cooperative", also_known_as: ["TC"] }
      })
    );
    const entity = structured(await client.await(1))["entity"] as Record<string, unknown>;

    expect(entity["record_schema"]).toBe("atlas.entity:v1");
    expect(entity["display_name"]).toBe("Test Cooperative");
    expect(entity["also_known_as"]).toEqual(["TC"]);
    expect(entity["type"]).toBe("organization");
    // Minted, never derived: the id is an Atlas id and carries no trace of the
    // name, so renaming later cannot move it.
    expect(String(entity["entity_id"])).toMatch(/^la_entity_/);
    expect(String(entity["entity_id"]).toLowerCase()).not.toContain("cooperative");
    // Owner-authored, because a human edited the graph — the same distinction
    // the assertion log draws between an authored claim and a mechanical import.
    expect((entity["provenance"] as Record<string, unknown>)["origin"]).toBe("owner-authored");
    expect((entity["provenance"] as Record<string, unknown>)["client_id"]).toBe(CONSUMER_PRINCIPAL.client_id);
  });

  it("does NOT deduplicate: two identical calls make two entities", async () => {
    // The property the tool's `idempotentHint: false` promises. Collapsing these
    // would silently swallow a real second person with the same name; the repair
    // for a genuine duplicate is a merge, which leaves a ledger row.
    const graph = syntheticGraph();
    const { client } = harness({ graph });

    for (const id of [1, 2]) {
      client.send(
        callTool({ id, name: "atlas.entity.create.v1", args: { type: "person", display_name: "Same Name" } })
      );
    }
    const first = structured(await client.await(1))["entity"] as Record<string, unknown>;
    const second = structured(await client.await(2))["entity"] as Record<string, unknown>;

    expect(first["entity_id"]).not.toBe(second["entity_id"]);
  });

  it("makes the new entity searchable, so text search does not under-report the graph", async () => {
    const graph = syntheticGraph();
    const { client } = harness({ graph });

    client.send(
      callTool({ id: 1, name: "atlas.entity.create.v1", args: { type: "place", display_name: "Findable Harbour" } })
    );
    await client.await(1);

    client.send(callTool({ id: 2, name: "atlas.text.search.v1", args: { query: "Findable Harbour" } }));
    const results = structured(await client.await(2))["results"] as { record: Record<string, unknown> }[];

    expect(results.map((hit) => hit.record["display_name"])).toContain("Findable Harbour");
  });

  it("refuses invalid-argument when the type is not one a consumer may request", async () => {
    const graph = syntheticGraph();
    const { client } = harness({ graph });

    client.send(
      callTool({ id: 1, name: "atlas.entity.create.v1", args: { type: "other", display_name: "Reserved Type" } })
    );
    const response = await client.await(1);

    // `other` is an output-side reserved member: a type introduced later reaches
    // a consumer as `other` plus a label, never as a token it may send back.
    expect(response.result?.["isError"] ?? errorPayload(response)["code"] !== undefined).toBeTruthy();
  });
});

describe("atlas.entity.rename.v1", () => {
  it("changes what an entity is CALLED and never what it IS", async () => {
    const graph = syntheticGraph();
    const subject = graph.entityList[0];
    expect(subject).toBeDefined();
    if (!subject) return;
    const { client } = harness({ graph });

    client.send(
      callTool({
        id: 1,
        name: "atlas.entity.rename.v1",
        args: { entity_id: subject.entity_id, display_name: "Renamed Person" }
      })
    );
    const entity = structured(await client.await(1))["entity"] as Record<string, unknown>;

    expect(entity["display_name"]).toBe("Renamed Person");
    // The three that must not move. An id that moved on a rename would orphan
    // every reference to it — the precise defect the old name-derived id
    // scheme had.
    expect(entity["entity_id"]).toBe(subject.entity_id);
    expect(entity["registered_at"]).toBe(subject.registered_at);
    expect(entity["type"]).toBe(subject.type);
    // ...and the one that must.
    expect(String(entity["updated_at"]) > String(subject.registered_at)).toBe(true);
  });

  it("leaves the nickname list alone when only the display name is supplied", async () => {
    const graph = syntheticGraph();
    const subject = graph.entityList[0];
    expect(subject).toBeDefined();
    if (!subject) return;
    const { client } = harness({ graph });

    client.send(
      callTool({
        id: 1,
        name: "atlas.entity.rename.v1",
        args: { entity_id: subject.entity_id, display_name: "Only The Name" }
      })
    );
    const entity = structured(await client.await(1))["entity"] as Record<string, unknown>;

    expect(entity["also_known_as"]).toEqual(subject.also_known_as);
  });

  it("writes NOTHING when renamed to the names it already has, so the published idempotent hint is true", async () => {
    /**
     * `idempotentHint: true` tells a client that retrying after a lost response
     * is free. `EntityRegistry.rename` stamps a fresh `updated_at` and appends
     * another identity record on every call, so without the no-op the hint is a
     * lie and a retry drifts `updated_at` with the network.
     */
    const graph = syntheticGraph();
    const subject = graph.entityList[0];
    expect(subject).toBeDefined();
    if (!subject) return;
    const { client, auditJournal } = harness({ graph });

    client.send(
      callTool({
        id: 1,
        name: "atlas.entity.rename.v1",
        args: { entity_id: subject.entity_id, display_name: subject.display_name }
      })
    );
    const entity = structured(await client.await(1))["entity"] as Record<string, unknown>;

    expect(entity["display_name"]).toBe(subject.display_name);
    // The proof it wrote nothing: `updated_at` did not move.
    expect(entity["updated_at"]).toBe(subject.updated_at);
    // ...and the audit says so, so a replayed retry cannot read as a second edit.
    expect(auditJournal.events[0]?.counts).toMatchObject({ committed: 0 });

    // A real change still moves it.
    client.send(
      callTool({
        id: 2,
        name: "atlas.entity.rename.v1",
        args: { entity_id: subject.entity_id, display_name: "Genuinely Different" }
      })
    );
    const changed = structured(await client.await(2))["entity"] as Record<string, unknown>;
    expect(String(changed["updated_at"]) > String(subject.updated_at)).toBe(true);
  });

  it("treats an also_known_as list that matches the current one as a no-op too", async () => {
    const graph = syntheticGraph();
    const subject = graph.entityList[0];
    expect(subject).toBeDefined();
    if (!subject) return;
    const { client } = harness({ graph });

    client.send(
      callTool({
        id: 1,
        name: "atlas.entity.rename.v1",
        args: { entity_id: subject.entity_id, also_known_as: [...subject.also_known_as] }
      })
    );
    const entity = structured(await client.await(1))["entity"] as Record<string, unknown>;
    expect(entity["updated_at"]).toBe(subject.updated_at);
  });

  it("does NOT let the no-op shortcut answer for a merged-away id", async () => {
    /**
     * `entities.read` returns the historical record for a merged id, so a no-op
     * check built on it alone would report success — with the stale entity —
     * for exactly the id the contract says must be refused. The shortcut has to
     * resolve first, or it inverts the rule it sits in front of.
     */
    const graph = syntheticGraph();
    const [stale, canonical] = graph.entityList;
    expect(stale).toBeDefined();
    expect(canonical).toBeDefined();
    if (!stale || !canonical) return;
    graph.registry.merge({
      client_id: "fixture",
      basis: "mechanical-migration",
      from: stale.entity_id,
      into: canonical.entity_id,
      reason: "one thing, two records"
    });
    const { client } = harness({ graph });

    // The names MATCH the stale record — the exact case that would take the
    // no-op path and report success.
    client.send(
      callTool({
        id: 1,
        name: "atlas.entity.rename.v1",
        args: { entity_id: stale.entity_id, display_name: stale.display_name }
      })
    );
    const payload = errorPayload(await client.await(1));

    expect(payload["code"]).toBe("entity-redirected");
    expect((payload["remedy"] as Record<string, unknown> | undefined)?.["tool"]).toBe("atlas.entity.resolve.v1");
  });

  it("refuses a rename that changes nothing rather than answering a silent no-op", async () => {
    const graph = syntheticGraph();
    const subject = graph.entityList[0];
    expect(subject).toBeDefined();
    if (!subject) return;
    const { client } = harness({ graph });

    client.send(callTool({ id: 1, name: "atlas.entity.rename.v1", args: { entity_id: subject.entity_id } }));

    expect(errorPayload(await client.await(1))["code"]).toBe("invalid-argument");
  });

  it("refuses an id that was never registered", async () => {
    const graph = syntheticGraph();
    const { client } = harness({ graph });

    client.send(
      callTool({
        id: 1,
        name: "atlas.entity.rename.v1",
        args: { entity_id: "la_entity_00000000000000000000000000", display_name: "Nobody" }
      })
    );

    expect(errorPayload(await client.await(1))["code"]).toBe("unknown-entity");
  });

  it("refuses to rename an id that has been merged away, and names resolve as the remedy", async () => {
    // Editing a record that has been superseded changes history rather than the
    // present. The current entity is the one to rename, and `resolve` names it.
    const graph = syntheticGraph();
    const [stale, canonical] = graph.entityList;
    expect(stale).toBeDefined();
    expect(canonical).toBeDefined();
    if (!stale || !canonical) return;

    const merged = graph.registry.merge({
      client_id: "fixture",
      // `mechanical-migration`, not `owner-resolution`: the latter requires the
      // owner evidence block, and this merge is fixture scaffolding rather than
      // a decision the test is making a claim about.
      basis: "mechanical-migration",
      from: stale.entity_id,
      into: canonical.entity_id,
      reason: "one thing, two records"
    });
    expect(merged.ok).toBe(true);

    const { client } = harness({ graph });
    client.send(
      callTool({
        id: 1,
        name: "atlas.entity.rename.v1",
        args: { entity_id: stale.entity_id, display_name: "Should Not Apply" }
      })
    );
    const payload = errorPayload(await client.await(1));

    expect(payload["code"]).toBe("entity-redirected");
    expect((payload["remedy"] as Record<string, unknown> | undefined)?.["tool"]).toBe("atlas.entity.resolve.v1");
  });
});

describe("publishing an entity-write tool grants nobody anything", () => {
  it("refuses both tools against a read-only store, and writes no byte", async () => {
    const seeded = seedStoreDirectory(emptyRoot(), {});
    const store = track(openAtlasStore({ directory: seeded.root }));
    const { client, auditJournal } = harness({ graph: store.graph });

    client.send(
      callTool({ id: 1, name: "atlas.entity.create.v1", args: { type: "person", display_name: "Denied" } })
    );
    const created = errorPayload(await client.await(1));
    expect(created["code"]).toBe("store-read-only");
    // Retryable: reopening the store read-write makes the identical request
    // succeed, and reopening is not something the caller does.
    expect(created["retryable"]).toBe(true);

    client.send(
      callTool({
        id: 2,
        name: "atlas.entity.rename.v1",
        args: { entity_id: seeded.subjectEntityId, display_name: "Denied" }
      })
    );
    expect(errorPayload(await client.await(2))["code"]).toBe("store-read-only");

    // Refusals are auditable. A refusal nobody can see in the log is a refusal
    // nobody can reconcile against.
    expect(auditJournal.events.map((event) => event.reason_code)).toEqual([
      "store-read-only",
      "store-read-only"
    ]);
  });

  it("names the STORE rather than the grant when both would refuse", async () => {
    // Order matters: answering `write-tier-not-permitted` first would send the
    // caller to ask for a grant that no grant could satisfy.
    const seeded = seedStoreDirectory(emptyRoot(), {});
    const store = track(openAtlasStore({ directory: seeded.root }));
    const cannotWrite = withGrant(CONSUMER_PRINCIPAL, { predicates_writable: [], write_tiers_permitted: [] });
    const { client } = harness({ graph: store.graph, principal: cannotWrite });

    client.send(
      callTool({ id: 1, name: "atlas.entity.create.v1", args: { type: "person", display_name: "Denied" } })
    );

    expect(errorPayload(await client.await(1))["code"]).toBe("store-read-only");
  });

  it("refuses a credential that may WRITE the tier but may not READ it", async () => {
    /**
     * Read reach and write reach are deliberately independent, so this grant is
     * legal — and without the read check it is a disclosure channel: both tools
     * answer with the WHOLE entity record, and for a rename that is a record the
     * caller never supplied. A credential that cannot read `local-private` could
     * learn any entity's names and provenance by renaming it to the name it
     * already has.
     */
    const graph = syntheticGraph();
    const subject = graph.entityList[0];
    expect(subject).toBeDefined();
    if (!subject) return;
    const writeOnly = withGrant(CONSUMER_PRINCIPAL, {
      sensitivity_reachable: [{ tier: "open", rank: 0 }],
      write_tiers_permitted: ["local-private"]
    });
    const { client } = harness({ graph, principal: writeOnly });

    client.send(
      callTool({
        id: 1,
        name: "atlas.entity.rename.v1",
        args: { entity_id: subject.entity_id, display_name: "Should Not Be Disclosed" }
      })
    );
    const payload = errorPayload(await client.await(1));

    expect(payload["code"]).toBe("sensitivity-withheld");
    // And nothing leaked: the refusal carries no entity record.
    expect(JSON.stringify(payload)).not.toContain(subject.display_name);

    client.send(
      callTool({ id: 2, name: "atlas.entity.create.v1", args: { type: "person", display_name: "Also Refused" } })
    );
    expect(errorPayload(await client.await(2))["code"]).toBe("sensitivity-withheld");
  });

  it("refuses a credential whose grant does not carry the write tier, on a writable graph", async () => {
    const graph = syntheticGraph();
    const before = graph.entityList.length;
    const noWrites = withGrant(CONSUMER_PRINCIPAL, { write_tiers_permitted: [] });
    const { client } = harness({ graph, principal: noWrites });

    client.send(
      callTool({ id: 1, name: "atlas.entity.create.v1", args: { type: "person", display_name: "Ungranted" } })
    );
    const payload = errorPayload(await client.await(1));

    expect(payload["code"]).toBe("write-tier-not-permitted");
    expect((payload["remedy"] as Record<string, unknown> | undefined)?.["tool"]).toBe("atlas.scope.describe.v1");
    // Nothing was minted.
    expect(graph.entityList).toHaveLength(before);
  });

  it("makes a durably-created entity findable by search, not only readable by id", async () => {
    /**
     * The regression this exists for, measured against the running service.
     *
     * `openReadWrite` used to compute the searchable set ONCE at open, with a
     * comment saying a plane that ever gained an entity-write tool would find
     * `atlas.text.search.v1` reporting fewer candidates than the graph holds.
     * 2026.08.3 is that plane: the created entity was readable by id and
     * invisible to search — in the store, absent from the tool used to find it.
     */
    const seeded = seedStoreDirectory(emptyRoot(), {});
    const store = track(openAtlasStore({ directory: seeded.root, mode: "read-write" }));
    const { client } = harness({ graph: store.graph });

    client.send(
      callTool({ id: 1, name: "atlas.entity.create.v1", args: { type: "place", display_name: "Findable Harbour" } })
    );
    await client.await(1);

    client.send(callTool({ id: 2, name: "atlas.text.search.v1", args: { query: "Findable Harbour" } }));
    const page = structured(await client.await(2));
    const names = (page["results"] as { record: Record<string, unknown> }[]).map((hit) => hit.record["display_name"]);

    expect(names).toContain("Findable Harbour");
    // The count the coverage block reports has to move too, or the page says it
    // evaluated fewer records than the store holds.
    expect((page["coverage"] as Record<string, number>)["evaluated"]).toBeGreaterThan(0);
  });

  it("makes a rename findable under the NEW name and not the old one", async () => {
    const seeded = seedStoreDirectory(emptyRoot(), {});
    const store = track(openAtlasStore({ directory: seeded.root, mode: "read-write" }));
    const before = store.graph.entities.read(seeded.subjectEntityId as never)?.display_name;
    expect(before).toBeDefined();
    const { client } = harness({ graph: store.graph });

    client.send(
      callTool({
        id: 1,
        name: "atlas.entity.rename.v1",
        args: { entity_id: seeded.subjectEntityId, display_name: "Renamed For Search" }
      })
    );
    await client.await(1);

    client.send(callTool({ id: 2, name: "atlas.text.search.v1", args: { query: "Renamed For Search" } }));
    const found = (structured(await client.await(2))["results"] as { record: Record<string, unknown> }[]).map(
      (hit) => hit.record["display_name"]
    );
    expect(found).toContain("Renamed For Search");

    // The old name must be GONE from the searchable set: an append would leave
    // the entity findable under a name it no longer has.
    client.send(callTool({ id: 3, name: "atlas.text.search.v1", args: { query: String(before) } }));
    const stale = (structured(await client.await(3))["results"] as { record: Record<string, unknown> }[]).map(
      (hit) => hit.record["display_name"]
    );
    expect(stale).not.toContain(before);
  });

  it("succeeds over the same durable store opened read-write, and the record is durable", async () => {
    const seeded = seedStoreDirectory(emptyRoot(), {});
    const store = track(openAtlasStore({ directory: seeded.root, mode: "read-write" }));
    const { client } = harness({ graph: store.graph });

    client.send(
      callTool({
        id: 1,
        name: "atlas.entity.create.v1",
        args: { type: "organization", display_name: "Durably Created" }
      })
    );
    const entity = structured(await client.await(1))["entity"] as Record<string, unknown>;
    const entityId = String(entity["entity_id"]);
    expect(entityId).toMatch(/^la_entity_/);

    // Re-read through a SECOND handle on the same directory, after closing the
    // first: the proof that the bytes reached the identity log rather than only
    // this process's memory.
    store.close();
    opened.length = 0;
    const reopened = track(openAtlasStore({ directory: seeded.root }));
    expect(reopened.graph.entities.read(entityId as never)?.display_name).toBe("Durably Created");
  });
});
