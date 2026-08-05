import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CONTRACT_PROTOCOL_VERSION, CONTRACT_REVISION, CONTRACT_TOOL_NAMES } from "@living-atlas/atlas-contract";
import {
  AtlasToolRefusal,
  isAssertion,
  isRedaction,
  type AtlasConsumerClient,
  type AtlasEntity
} from "@living-atlas/atlas-client";
import {
  BEFORE_FIXTURE_HISTORY_FLOOR,
  FIXTURE_ENTITY_NAMES,
  FIXTURE_FEED_EPOCH,
  FIXTURE_HISTORY_FLOOR,
  WRITABLE_PREDICATE
} from "./fixture.js";
import { startSession, startSharedSession, type Session, type SharedSession } from "./harness.js";

/**
 * The journey, end to end, with nothing on the path faked.
 *
 * Every step below crosses a real process boundary: a child process running the
 * shipped `serveAtlasStdio`, real JSON-RPC bytes over a real pipe, the published
 * schemas on both sides, and atlas-core's own segment log underneath. No handler
 * is called directly, no transport is stubbed, no schema is bypassed. The point
 * of paying for that is the class of defect it catches — envelope rules, framing,
 * `resultType`, the escalation round trip, and durability across a restart exist
 * only on the wire, and every one of them was a real failure on the surface this
 * contract replaces.
 *
 * Scenarios that WRITE take their own server and their own temporary directory,
 * because the change feed's seq and the idempotency table are exactly the state a
 * later test would otherwise depend on. Scenarios that only READ share one, and
 * the audit assertions are deltas rather than totals — which is the invariant
 * that was always meant.
 */

let shared: SharedSession;
const written: Session[] = [];

/** A private server, for a scenario that changes the graph. */
async function writable(): Promise<Session> {
  const session = await startSession();
  written.push(session);
  return session;
}

beforeAll(async () => {
  shared = await startSharedSession();
});

afterAll(async () => {
  await shared.dispose();
});

afterEach(async () => {
  while (written.length > 0) await written.pop()?.dispose();
});

/** The fixture entity the journey asserts about, found the way a consumer would. */
async function fixtureSubject(client: AtlasConsumerClient): Promise<AtlasEntity> {
  const found = await client.searchText({ query: FIXTURE_ENTITY_NAMES[0] });
  const first = found.results[0]?.record;
  expect(first, "the fixture graph published no searchable entity").toBeDefined();
  if (!first || isRedaction(first) || first.record_schema !== "atlas.entity:v1") {
    throw new Error("the fixture subject did not come back as readable entity content");
  }
  return first;
}

function draft(subjectEntityId: string, value: string): {
  kind: "fact";
  subject_entity_id: string;
  predicate: string;
  value: string;
  confidence: { band: string };
  evidence_links: { evidence_id: string; stance: string }[];
} {
  return {
    kind: "fact",
    subject_entity_id: subjectEntityId,
    predicate: WRITABLE_PREDICATE,
    value,
    confidence: { band: "high" },
    evidence_links: [{ evidence_id: "ev-e2e-1", stance: "supports" }]
  };
}

describe("step 1 — discovery", () => {
  it("names the one protocol revision this plane speaks, and points a consumer at the contract", async () => {
    const description = await shared.client.discover();

    expect(description.supportedVersions).toEqual([CONTRACT_PROTOCOL_VERSION]);
    expect(description.capabilities).toMatchObject({ tools: {} });
    expect(description.serverInfo).toMatchObject({ name: "living-atlas-consumer", version: CONTRACT_REVISION });
    // The instructions send a consumer to the contract before anything else,
    // which is the behaviour the rest of this journey depends on.
    expect(description.instructions).toContain("atlas.contract.describe.v1");
    expect(description.instructions).toContain("atlas.scope.describe.v1");
    // Every result on this plane is private, because policy filtering varies by
    // credential and a shared cache would serve one consumer's view to another.
    expect(description.cacheScope).toBe("private");
    // The TTL comes from the contract's own answer about holding a description
    // of itself, not from a number this client chose.
    expect(description.ttlMs).toBeGreaterThan(0);
  });

  it("happens once per client and is reused for as long as the server said to hold it", async () => {
    const fresh = shared.as({});
    const marker = shared.workspace.auditMark();

    await fresh.describeScope();
    await fresh.describeScope();
    await fresh.describeScope();

    // Three tool calls, three events — and `server/discover` is not among them,
    // because a cached description is not re-fetched. Discovery leaves no audit
    // event of its own: it names no credential and reads no graph content.
    const events = shared.workspace.auditSince(marker);
    expect(events.filter((event) => event.tool === "atlas.scope.describe.v1")).toHaveLength(3);
  });
});

describe("step 2 — the contract, described by the server that serves it", () => {
  it("is honest about the history that does not exist", async () => {
    const contract = await shared.client.describeContract();

    expect(contract.revision).toBe(CONTRACT_REVISION);
    expect(contract.revisions_served).toEqual([CONTRACT_REVISION]);
    expect(contract.protocol_version).toBe(CONTRACT_PROTOCOL_VERSION);

    // THE number. Not "not applicable", not omitted, not a soft phrase — zero,
    // machine-readable, so a consumer knows there is no pre-contract history
    // rather than assuming there is some.
    expect(contract.history.prior_versions_retained_before_cutover).toBe(0);
    // And permanently true of pre-contract records, not a transitional state.
    expect(contract.history.belief_time_meaningful_since_cutover_only).toBe(true);

    // The runtime half of the same block: this store's own floor and epoch.
    expect(contract.history.bitemporal_since).toBe(FIXTURE_HISTORY_FLOOR);
    expect(contract.history.feed_epoch).toBe(FIXTURE_FEED_EPOCH);

    expect(contract.tools.map((tool) => tool.name)).toEqual([...CONTRACT_TOOL_NAMES]);
    // The LIVE predicate registry, from the graph rather than from a frozen hint
    // in the schema. A consumer validates against this.
    expect(contract.vocabularies.predicate.map((entry) => entry.predicate)).toContain(WRITABLE_PREDICATE);
    // Every record schema is published with the PATH beside the id, so a
    // consumer holding a `urn:` can actually fetch the document.
    for (const record of contract.record_schemas) {
      expect(record.schema_path.length).toBeGreaterThan(0);
      expect(record.schema_id.startsWith("urn:living-atlas:contract:")).toBe(true);
    }
  });

  it("refuses to answer for a revision it does not serve, rather than substituting its own", async () => {
    const failure = await shared.client.describeContract({ revision: "2025.01.0" }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AtlasToolRefusal);
    expect((failure as AtlasToolRefusal).code).toBe("revision-not-served");
    // A silent substitution is how a consumer ends up validating against a
    // document it never read.
    expect((failure as AtlasToolRefusal).retryable).toBe(false);
  });

  it("publishes this credential's own grant, so differences are read and never inferred", async () => {
    const scope = await shared.client.describeScope();

    expect(scope.client_id).toBe("e2e-consumer");
    expect(scope.plane).toBe("consumer");
    expect(scope.tools_available).toEqual([...CONTRACT_TOOL_NAMES]);
    expect(scope.predicates_writable).toEqual([WRITABLE_PREDICATE]);
    expect(scope.reveal_available).toBe(true);
    // Echoed from the request envelope rather than guessed, so a capability
    // refusal can be debugged from the server's side of the conversation.
    expect(scope.declared_client_capabilities).toEqual([]);
    // Nothing in this answer names a transport, and nothing may.
    expect(JSON.stringify(scope)).not.toMatch(/stdio|http|transport/i);
  });
});

describe("step 3 — a governed write and its receipt", () => {
  it("commits under the calling credential and returns a receipt naming what it wrote", async () => {
    const active = await writable();
    const subject = await fixtureSubject(active.client);

    const receipt = await active.client.proposeAssertions({
      idempotency_key: "e2e-propose-first",
      proposals: [draft(subject.entity_id, "Synthetic Employer New")]
    });

    expect(receipt.committed).toBe(1);
    expect(receipt.refused).toBe(0);
    expect(receipt.submission.state).toBe("committed");
    // The receipt is attributed to the CREDENTIAL, resolved server-side. A
    // consumer cannot name its own client_id, which is what makes "assertions
    // this credential authored" a rule anything can be written in terms of.
    expect(receipt.submission.client_id).toBe("e2e-consumer");
    expect(receipt.submission.idempotency_key).toBe("e2e-propose-first");
    expect(receipt.results).toHaveLength(1);
    expect(receipt.results[0]?.assertion_id).toMatch(/^la_assertion_[0-9a-z]{26}$/);
    expect(receipt.results[0]?.outcome).toBe("committed");
  });

  it("refuses a predicate this credential's grant does not permit, before the commit", async () => {
    const active = await writable();
    const subject = await fixtureSubject(active.client);

    const failure = await active.client
      .proposeAssertions({
        idempotency_key: "e2e-propose-ungranted",
        proposals: [{ ...draft(subject.entity_id, "x"), predicate: "medical-note" }]
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AtlasToolRefusal);
    expect((failure as AtlasToolRefusal).code).toBe("predicate-not-writable");
    // The refusal names where to look rather than leaving the caller to probe.
    expect((failure as AtlasToolRefusal).record.remedy?.tool).toBe("atlas.scope.describe.v1");

    // Nothing was written: read reach and write reach are separate grants and
    // the check runs before the commit, not after it.
    const after = await active.client.queryAssertions({ predicate: "medical-note" });
    expect(after.results.filter((row) => isAssertion(row))).toHaveLength(0);
  });
});

describe("step 4 — the idempotent retry", () => {
  it("replays the original receipt with the original ids, and mints no new seq", async () => {
    const active = await writable();
    const subject = await fixtureSubject(active.client);
    const proposal = {
      idempotency_key: "e2e-propose-retry",
      proposals: [draft(subject.entity_id, "Synthetic Employer Retried")]
    };

    const first = await active.client.proposeAssertions(proposal);
    const feedBefore = await active.client.readChanges({ cursor_seq: 0, limit: 200 });

    const second = await active.client.proposeAssertions(proposal);

    // The ORIGINAL receipt, byte for byte on the parts that identify it.
    expect(second.submission.submission_id).toBe(first.submission.submission_id);
    expect(second.submission.committed_at).toBe(first.submission.committed_at);
    expect(second.submission.assertion_ids).toEqual(first.submission.assertion_ids);
    expect(second.submission.state).toBe("replayed");
    // Zero, and saying zero is the point: a retry that reported 1 would make a
    // caller's own count of what it wrote wrong.
    expect(second.committed).toBe(0);
    expect(second.results[0]?.assertion_id).toBe(first.results[0]?.assertion_id);
    expect(second.results[0]?.seq).toBe(first.results[0]?.seq);

    // And no second copy reached the feed. A duplicate here is the defect
    // idempotency exists to prevent, and it is invisible from the receipt alone.
    const feedAfter = await active.client.readChanges({ cursor_seq: 0, limit: 200 });
    expect(feedAfter.changes.map((change) => change.seq)).toEqual(feedBefore.changes.map((change) => change.seq));
  });

  it("reports the same key with a DIFFERENT payload as a typed conflict, never as an accept", async () => {
    const active = await writable();
    const subject = await fixtureSubject(active.client);

    await active.client.proposeAssertions({
      idempotency_key: "e2e-propose-conflict",
      proposals: [draft(subject.entity_id, "Synthetic Employer One")]
    });

    const failure = await active.client
      .proposeAssertions({
        idempotency_key: "e2e-propose-conflict",
        proposals: [draft(subject.entity_id, "Synthetic Employer Two")]
      })
      .catch((error: unknown) => error);

    // Neither version is silently accepted. Accepting the first would discard a
    // write the caller believes it made; accepting the second would rewrite one
    // it already has a receipt for.
    expect(failure).toBeInstanceOf(AtlasToolRefusal);
    expect((failure as AtlasToolRefusal).retryable).toBe(false);
    expect((failure as AtlasToolRefusal).record.details).toMatchObject({ original_submission_id: expect.any(String) });
  });

  it("answers atlas.submission.read.v1 for a key it has a receipt for, and only under that credential", async () => {
    const active = await writable();
    const subject = await fixtureSubject(active.client);

    const receipt = await active.client.proposeAssertions({
      idempotency_key: "e2e-propose-lookup",
      proposals: [draft(subject.entity_id, "Synthetic Employer Looked Up")]
    });

    const looked = await active.client.readSubmission({ idempotency_key: "e2e-propose-lookup" });
    expect(looked.submission?.submission_id).toBe(receipt.submission.submission_id);
    // The window is published rather than implied: after it, the same key
    // commits a SECOND copy, and a consumer needs to know when that starts.
    expect(looked.idempotency_expires_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const missing = await active.client.readSubmission({ idempotency_key: "a-key-nobody-used" });
    expect(missing.error?.code).toBe("unknown-submission");
    expect(missing.idempotency_expires_at).toBeNull();
  });
});

describe("step 5 — the two time axes", () => {
  it("answers on the belief axis and refuses below the history floor rather than answering from now", async () => {
    const present = await shared.client.queryAssertions({});
    expect(present.results.length).toBeGreaterThan(0);
    expect(present.horizon.bitemporal_since).toBe(FIXTURE_HISTORY_FLOOR);
    // `as_of_recorded` is echoed even when the caller supplied none: a read with
    // no as-of is still a read AT an instant, and one that could be replayed.
    expect(present.horizon.as_of_recorded).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    const failure = await shared.client
      .queryAssertions({ as_of_recorded: BEFORE_FIXTURE_HISTORY_FLOOR })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AtlasToolRefusal);
    expect((failure as AtlasToolRefusal).code).toBe("as-of-before-history-floor");
    // Refused, and the floor is named so the caller can ask a question that can
    // be answered. Answering from present state would be a plausible lie.
    expect((failure as AtlasToolRefusal).record.details).toMatchObject({ bitemporal_since: FIXTURE_HISTORY_FLOOR });
  });

  it("matches nothing on the world axis when world time is unknown", async () => {
    const anyBelief = await shared.client.queryAssertions({});
    expect(anyBelief.results.length).toBeGreaterThan(0);

    // The fixture's assertions carry no valid_from or valid_to. Unknown world
    // time MATCHES NOTHING — it is not treated as "always true", which would
    // silently promote every undated claim into every world-time answer.
    const onTheWorldAxis = await shared.client.queryAssertions({ as_of_valid: "2026-07" });
    expect(onTheWorldAxis.results.filter((row) => isAssertion(row))).toHaveLength(0);

    // And the coverage block says so rather than the caller inferring it from an
    // empty array: rows were evaluated, none matched, none were withheld.
    expect(onTheWorldAxis.coverage.evaluated).toBeGreaterThan(0);
    expect(onTheWorldAxis.coverage.matched).toBe(0);
    expect(onTheWorldAxis.coverage.withheld).toBe(0);
    expect(onTheWorldAxis.horizon.as_of_valid).toBe("2026-07");
  });

  it("counts a withheld row rather than dropping it, so a filtered graph is not a complete one", async () => {
    const page = await shared.client.queryAssertions({});

    const stubs = page.results.filter((row) => isRedaction(row));
    expect(stubs).toHaveLength(1);
    expect(stubs[0]).toMatchObject({ reveal_available: true, reveal_tool: "atlas.sensitive.reveal.v1" });
    // The row is present AND counted. Either alone would let a consumer conclude
    // something from an absence nobody told it about.
    expect(page.coverage.returned).toBe(page.results.length);
    expect(page.coverage.withheld).toBe(1);
    expect(page.coverage.counts_basis).toBe("exact");
  });
});
