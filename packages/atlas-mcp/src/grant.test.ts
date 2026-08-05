import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CONTRACT_LIMITS } from "@living-atlas/atlas-contract";
import { decideAssertion } from "./access.js";
import { InMemoryCredentialDirectory, credentialResolver, hashCredential } from "./credentials.js";
import {
  CapabilityGrantSchema,
  DISCOVERY_TOOLS,
  effectiveLimit,
  mayCallTool,
  reachesTier,
  sensitivityCeiling
} from "./grant.js";
import { PrincipalSchema, type Principal } from "./principal.js";
import {
  CONSUMER_GRANT,
  CONSUMER_PRINCIPAL,
  callTool,
  credentialEnvelope,
  listTools,
  seedAssertions,
  startHarness,
  syntheticGraph,
  withGrant,
  type Harness
} from "./testing.js";

const started: Harness[] = [];

function harness(...args: Parameters<typeof startHarness>): Harness {
  const instance = startHarness(...args);
  started.push(instance);
  return instance;
}

afterEach(async () => {
  while (started.length > 0) await started.pop()?.handle.close();
});

function structured(response: { result?: Record<string, unknown> }): Record<string, unknown> {
  return (response.result?.["structuredContent"] ?? {}) as Record<string, unknown>;
}

function errorPayload(response: { result?: Record<string, unknown> }): Record<string, unknown> {
  const content = response.result?.["content"] as { text: string }[] | undefined;
  return JSON.parse(String(content?.[0]?.text ?? "{}")) as Record<string, unknown>;
}

function proposal(predicate: string, subjectEntityId: string): Record<string, unknown> {
  return {
    kind: "fact",
    lineage_action: "assert",
    subject_entity_id: subjectEntityId,
    predicate,
    value: "synthetic value",
    confidence: { band: "high" },
    evidence_links: [{ evidence_id: "ev-1", stance: "supports" }],
    supersedes: []
  };
}

describe("the capability grant", () => {
  it("refuses a grant that gives one tier two ranks", () => {
    const outcome = CapabilityGrantSchema.safeParse({
      ...CONSUMER_GRANT,
      sensitivity_reachable: [
        { tier: "open", rank: 0 },
        { tier: "open", rank: 50 }
      ]
    });
    // Otherwise the ceiling depends on which entry is read first.
    expect(outcome.success).toBe(false);
  });

  it("reports the highest-ranked reachable tier as the ceiling", () => {
    const grant = CapabilityGrantSchema.parse({
      ...CONSUMER_GRANT,
      sensitivity_reachable: [
        { tier: "internal", rank: 10 },
        { tier: "open", rank: 0 },
        { tier: "sealed", rank: 90 }
      ]
    });
    expect(sensitivityCeiling(grant)).toEqual({ tier: "sealed", rank: 90 });
  });

  it("reaches a tier by NAME, not by rank, so an ungranted low tier stays unreachable", () => {
    const grant = CapabilityGrantSchema.parse({
      ...CONSUMER_GRANT,
      sensitivity_reachable: [
        { tier: "open", rank: 0 },
        { tier: "sealed", rank: 90 }
      ]
    });
    // rank 10 is far below the ceiling of 90 and is still unreachable: nobody
    // granted `internal`. A threshold would have admitted it.
    expect(reachesTier(grant, "internal")).toBe(false);
    expect(reachesTier(grant, "sealed")).toBe(true);
  });

  it("narrows a published limit and never widens one", () => {
    expect(effectiveLimit(200, 25)).toBe(25);
    expect(effectiveLimit(200, 5000)).toBe(200);
    expect(effectiveLimit(200, undefined)).toBe(200);
  });

  it("lets any grant reach its own plane's discovery tools and no other plane's", () => {
    const narrow = CapabilityGrantSchema.parse({ ...CONSUMER_GRANT, tools_permitted: [] });
    for (const tool of DISCOVERY_TOOLS.consumer) {
      expect(mayCallTool(narrow, "consumer", tool)).toBe(true);
    }
    for (const tool of DISCOVERY_TOOLS.operator) {
      // The operator plane's discovery tool is not inherited by a consumer
      // grant just because both planes have one.
      expect(mayCallTool(narrow, "consumer", tool)).toBe(false);
    }
    expect(mayCallTool(narrow, "consumer", "atlas.assertion.query.v1")).toBe(false);
  });
});

describe("the principal", () => {
  it("binds the operator plane to the operator credential class, in both directions", () => {
    const operatorPlaneConsumerClass = PrincipalSchema.safeParse({
      ...CONSUMER_PRINCIPAL,
      plane: "operator",
      credential_class: "consumer"
    });
    const consumerPlaneOperatorClass = PrincipalSchema.safeParse({
      ...CONSUMER_PRINCIPAL,
      plane: "consumer",
      credential_class: "operator"
    });
    expect(operatorPlaneConsumerClass.success).toBe(false);
    expect(consumerPlaneOperatorClass.success).toBe(false);
  });
});

describe("the credential directory", () => {
  const alice: Principal = { ...CONSUMER_PRINCIPAL, client_id: "consumer-alice" };
  const bob: Principal = { ...CONSUMER_PRINCIPAL, client_id: "consumer-bob" };
  const operator: Principal = {
    client_id: "operator-one",
    credential_class: "operator",
    plane: "operator",
    grant: CONSUMER_GRANT
  };

  const directory = new InMemoryCredentialDirectory([
    { token_hash: hashCredential("secret-alice"), principal: alice },
    { token_hash: hashCredential("secret-bob"), principal: bob },
    { token_hash: hashCredential("secret-operator"), principal: operator }
  ]);

  it("resolves two secrets to two client_ids", () => {
    const resolve = credentialResolver({ directory, plane: "consumer" });
    const first = resolve("secret-alice");
    const second = resolve("secret-bob");
    expect(first.ok && first.principal.client_id).toBe("consumer-alice");
    expect(second.ok && second.principal.client_id).toBe("consumer-bob");
  });

  it("refuses a credential granted a different plane", () => {
    const resolve = credentialResolver({ directory, plane: "consumer" });
    const outcome = resolve("secret-operator");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reasonCode).toBe("credential-plane-mismatch");
  });

  it("refuses when nothing is presented at all", () => {
    const resolve = credentialResolver({ directory, plane: "consumer" });
    expect(resolve(undefined)).toEqual({ ok: false, reasonCode: "credential-required" });
  });
});

describe("per-consumer attribution", () => {
  function twoConsumerHarness() {
    const graph = syntheticGraph();
    const alice: Principal = { ...CONSUMER_PRINCIPAL, client_id: "consumer-alice" };
    const bob: Principal = { ...CONSUMER_PRINCIPAL, client_id: "consumer-bob" };
    const directory = new InMemoryCredentialDirectory([
      { token_hash: hashCredential("secret-alice"), principal: alice },
      { token_hash: hashCredential("secret-bob"), principal: bob }
    ]);
    return {
      graph,
      instance: harness({ graph, resolvePrincipal: credentialResolver({ directory, plane: "consumer" }) })
    };
  }

  it("gives two consumers distinct client_ids on the assertions they commit", async () => {
    const { graph, instance } = twoConsumerHarness();
    const subject = graph.entityList[0];
    expect(subject).toBeDefined();
    if (!subject) return;

    instance.client.send(
      callTool({
        id: 1,
        name: "atlas.assertion.propose.v1",
        meta: credentialEnvelope("secret-alice"),
        args: { idempotency_key: "k-alice", proposals: [proposal("worked-at", subject.entity_id)] }
      })
    );
    await instance.client.await(1);

    instance.client.send(
      callTool({
        id: 2,
        name: "atlas.assertion.propose.v1",
        meta: credentialEnvelope("secret-bob"),
        args: { idempotency_key: "k-bob", proposals: [proposal("worked-at", subject.entity_id)] }
      })
    );
    await instance.client.await(2);

    const page = graph.assertions.query({});
    if (!page.ok) throw new Error("fixture query hit the floor");
    const authors = page.hits.map((hit) => hit.assertion.provenance.client_id).sort();
    // The prior daemon replaced every caller's credential with its own token, so
    // this would have been ["daemon", "daemon"] and no rule written in terms of
    // "assertions this credential authored" could be evaluated at all.
    expect(authors).toEqual(["consumer-alice", "consumer-bob"]);

    const auditors = instance.auditJournal.events.map((event) => event.client_id).sort();
    expect(auditors).toEqual(["consumer-alice", "consumer-bob"]);
  });

  it("refuses an unrecognised credential with one code whatever the cause", async () => {
    const { instance } = twoConsumerHarness();
    instance.client.send(
      callTool({ id: 1, name: "atlas.scope.describe.v1", meta: credentialEnvelope("not-a-real-secret") })
    );
    const response = await instance.client.await(1);

    expect(response.result?.["isError"]).toBe(true);
    expect(errorPayload(response)["code"]).toBe("credential-unrecognised");
    // The event carries the precise cause even though the wire does not: an
    // audit reader needs to tell an unknown secret from a wrong-plane one.
    expect(instance.auditJournal.events[0]).toMatchObject({
      outcome: "refused",
      reason_code: "credential-unknown",
      client_id: null,
      plane: "consumer"
    });
  });
});

describe("a credential-varying tools/list is observable", () => {
  it("writes one audit event per listing, naming the credential and how many tools it got", async () => {
    const narrow = withGrant(CONSUMER_PRINCIPAL, { tools_permitted: ["atlas.assertion.query.v1"] });
    const { client, auditJournal } = harness({ principal: narrow });

    client.send(listTools({ id: 1 }));
    const listed = ((await client.await(1)).result?.["tools"] ?? []) as { name: string }[];

    expect(auditJournal.events).toHaveLength(1);
    expect(auditJournal.events[0]).toMatchObject({
      tool: "tools/list",
      outcome: "ok",
      plane: "consumer",
      client_id: CONSUMER_PRINCIPAL.client_id,
      grant_id: narrow.grant.grant_id,
      counts: { returned: listed.length }
    });
    // The COUNT, never the names. Which tools a grant permits is derivable from
    // `grant_id`, which the event already carries.
    expect(auditJournal.events[0]?.subjects).toEqual([]);
  });

  it("records an unrecognised credential's empty listing, so enumeration is not silent", async () => {
    const directory = new Map([["good-secret", CONSUMER_PRINCIPAL]]);
    const { client, auditJournal } = harness({
      resolvePrincipal: (secret) => {
        if (secret === undefined) return { ok: false, reasonCode: "credential-required" };
        const principal = directory.get(secret);
        return principal ? { ok: true, principal } : { ok: false, reasonCode: "credential-unknown" };
      }
    });

    client.send(listTools({ id: 1, meta: credentialEnvelope("a-secret-nobody-issued") }));
    expect((await client.await(1)).result?.["tools"]).toEqual([]);

    // Without this event `tools/list` would be the only credential-varying
    // operation on the server that leaves no trace: an unrecognised credential
    // gets `[]`, a recognised one gets its set, and a caller could enumerate
    // credentials against the difference while producing nothing an audit
    // reader could see. The identical probe through `tools/call` always wrote
    // an event.
    expect(auditJournal.events).toHaveLength(1);
    expect(auditJournal.events[0]).toMatchObject({
      tool: "tools/list",
      outcome: "refused",
      reason_code: "credential-unknown",
      client_id: null,
      plane: "consumer",
      counts: { returned: 0 }
    });
  });
});

describe("a grant bounds what a consumer can do", () => {
  it("omits a tool the grant does not permit from tools/list AND refuses it by name", async () => {
    const narrow = withGrant(CONSUMER_PRINCIPAL, {
      tools_permitted: ["atlas.assertion.query.v1"]
    });
    const { client } = harness({ principal: narrow });

    client.send(listTools({ id: 1 }));
    const listed = ((await client.await(1)).result?.["tools"] ?? []) as { name: string }[];
    const names = listed.map((tool) => tool.name).sort();
    expect(names).toEqual(
      ["atlas.assertion.query.v1", "atlas.contract.describe.v1", "atlas.scope.describe.v1"].sort()
    );

    client.send(callTool({ id: 2, name: "atlas.text.search.v1", args: { query: "anything" } }));
    const refused = await client.await(2);
    // The listing and the refusal agree. A tool that is absent from one and
    // served by the other is the state a caller cannot reason about.
    expect(refused.result?.["isError"]).toBe(true);
    expect(errorPayload(refused)["code"]).toBe("tool-not-permitted");
  });

  it("withholds a record whose tier the grant does not name, even below the ceiling", () => {
    const graph = syntheticGraph();
    const subject = graph.entityList[0];
    expect(subject).toBeDefined();
    if (!subject) return;

    graph.assertions.commit({
      client_id: "fixture",
      idempotency_key: "internal-1",
      drafts: [proposal("worked-at", subject.entity_id) as never],
      sensitivity: { tier: "internal", rank: 10, withheld: false }
    });
    const page = graph.assertions.query({});
    if (!page.ok) throw new Error("fixture query hit the floor");
    const record = page.hits[0]?.assertion;
    expect(record).toBeDefined();
    if (!record) return;

    const broadCeiling = withGrant(CONSUMER_PRINCIPAL, {
      sensitivity_reachable: [
        { tier: "open", rank: 0 },
        { tier: "sealed", rank: 90 }
      ]
    });
    const decision = decideAssertion(record, broadCeiling);
    // Ceiling rank 90, record rank 10 — and still withheld, because nobody
    // granted `internal`. This is the whole difference between a named set and
    // a threshold.
    expect(decision.allowed).toBe(false);

    const granted = withGrant(broadCeiling, {
      sensitivity_reachable: [
        { tier: "open", rank: 0 },
        { tier: "internal", rank: 10 }
      ]
    });
    expect(decideAssertion(record, granted).allowed).toBe(true);
  });

  it("narrows the page size a grant caps, and publishes the narrowed number", async () => {
    const graph = syntheticGraph();
    seedAssertions(graph, 12);
    const capped = withGrant(CONSUMER_PRINCIPAL, { limits: { max_page_size: 3 } });
    const { client } = harness({ graph, principal: capped });

    client.send(callTool({ id: 1, name: "atlas.assertion.query.v1", args: { page_size: 50 } }));
    const page = (await client.await(1)).result?.["structuredContent"] as Record<string, unknown>;
    expect((page["page"] as Record<string, unknown>)["page_size"]).toBe(3);
    expect((page["results"] as unknown[]).length).toBe(3);

    client.send(callTool({ id: 2, name: "atlas.scope.describe.v1" }));
    const scope = structured(await client.await(2));
    expect(scope["limits"]).toEqual({
      max_page_size: 3,
      max_ids_per_request: CONTRACT_LIMITS.max_ids_per_request,
      max_batch_items: CONTRACT_LIMITS.max_batch_items
    });
  });

  it("does not let a grant WIDEN a published cap, at the seam and not only in the helper", async () => {
    const graph = syntheticGraph();
    seedAssertions(graph, 3);
    // A grant claiming far more than the contract publishes. The published caps
    // are transport-invariant, and a credential is not a way around them.
    const greedy = withGrant(CONSUMER_PRINCIPAL, { limits: { max_page_size: CONTRACT_LIMITS.max_page_size + 5000 } });
    const { client } = harness({ graph, principal: greedy });

    client.send(callTool({ id: 1, name: "atlas.scope.describe.v1" }));
    const scope = structured(await client.await(1));
    expect((scope["limits"] as Record<string, unknown>)["max_page_size"]).toBe(CONTRACT_LIMITS.max_page_size);

    client.send(callTool({ id: 2, name: "atlas.assertion.query.v1", args: { page_size: CONTRACT_LIMITS.max_page_size } }));
    const page = structured(await client.await(2))["page"] as Record<string, unknown>;
    expect(page["page_size"]).toBe(CONTRACT_LIMITS.max_page_size);
  });

  it("refuses a write to a predicate the grant does not name", async () => {
    const graph = syntheticGraph();
    const subject = graph.entityList[0];
    expect(subject).toBeDefined();
    if (!subject) return;

    const readOnlyish = withGrant(CONSUMER_PRINCIPAL, { predicates_writable: ["worked-at"] });
    const { client } = harness({ graph, principal: readOnlyish });

    client.send(
      callTool({
        id: 1,
        name: "atlas.assertion.propose.v1",
        args: { idempotency_key: "k1", proposals: [proposal("medical-note", subject.entity_id)] }
      })
    );
    const response = await client.await(1);
    expect(errorPayload(response)["code"]).toBe("predicate-not-writable");
    expect(graph.assertions.size).toBe(0);
  });

  it("refuses a commit at a tier the grant may not write", async () => {
    const graph = syntheticGraph();
    const subject = graph.entityList[0];
    expect(subject).toBeDefined();
    if (!subject) return;

    const noWrites = withGrant(CONSUMER_PRINCIPAL, { write_tiers_permitted: [] });
    const { client } = harness({ graph, principal: noWrites });

    client.send(
      callTool({
        id: 1,
        name: "atlas.assertion.propose.v1",
        args: { idempotency_key: "k1", proposals: [proposal("worked-at", subject.entity_id)] }
      })
    );
    expect(errorPayload(await client.await(1))["code"]).toBe("write-tier-not-permitted");
    expect(graph.assertions.size).toBe(0);
  });

  it("publishes the whole grant through atlas.scope.describe.v1", async () => {
    const { client } = harness();
    client.send(callTool({ id: 1, name: "atlas.scope.describe.v1" }));
    const scope = structured(await client.await(1));

    expect(scope).toMatchObject({
      client_id: CONSUMER_PRINCIPAL.client_id,
      grant_id: CONSUMER_GRANT.grant_id,
      plane: "consumer",
      sensitivity_reachable: CONSUMER_GRANT.sensitivity_reachable,
      // DERIVED from the reachable set, not stored beside it: the highest rank
      // the grant names. Written out rather than read back off the fixture, so
      // a server that published a stored ceiling instead of computing one would
      // fail here rather than agree with itself.
      sensitivity_ceiling: { tier: "local-private", rank: 10 },
      predicates_writable: CONSUMER_GRANT.predicates_writable,
      write_tiers_permitted: CONSUMER_GRANT.write_tiers_permitted
    });
  });
});

/**
 * The authorization modules, and the transport words that must not appear in
 * them.
 *
 * `stdio.ts` and `protocol-gate.ts` are deliberately absent: binding a
 * transport is their whole job. These five are where a credential turns into a
 * decision, and a decision that consults the wire is the defect this model
 * replaces — the prior control plane's profiles were named `local-*` and
 * `remote-*`, and the daemon rejected any profile that was not `local-`.
 */
const AUTHORIZATION_SOURCES = [
  "grant.ts",
  "principal.ts",
  "credentials.ts",
  "access.ts",
  "server.ts",
  join("operator", "server.ts"),
  join("operator", "tools.ts")
];

const TRANSPORT_WORDS = /\b(local|remote|stdio|https?|websocket|sse|loopback|transport|daemon|socket|pipe)\b/i;

function sourceOf(file: string): string {
  return readFileSync(join(dirname(fileURLToPath(import.meta.url)), file), "utf8");
}

/**
 * Source reduced to what could actually make a decision.
 *
 * Comments go, and so does PROSE — a string literal containing whitespace. Both
 * of these files argue about transports at length, in comments and in the
 * instruction and description strings they publish to clients, and an argument
 * that a transport must not matter is not an authorization decision that
 * consults one.
 *
 * A short string literal is kept, and that is the point of the whitespace rule
 * rather than dropping strings wholesale: an authorization decision compares
 * against tokens — `"local"`, `"stdio"`, `"local-readonly"` — never against a
 * sentence. `if (transport === "local")` survives this stripper twice over,
 * once as the identifier and once as the token.
 */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/`[^`]*\s[^`]*`/g, "``")
    .replace(/"[^"\n]*\s[^"\n]*"/g, '""')
    .replace(/'[^'\n]*\s[^'\n]*'/g, "''");
}

describe("no transport string appears in an authorization decision", () => {
  it("finds none in the code of any authorization module", () => {
    const offenders: string[] = [];
    for (const file of AUTHORIZATION_SOURCES) {
      codeOnly(sourceOf(file))
        .split("\n")
        .forEach((line, index) => {
          if (TRANSPORT_WORDS.test(line)) offenders.push(`${file}:${index + 1}: ${line.trim()}`);
        });
    }
    expect(offenders, "these lines make an authorization decision mention a transport").toEqual([]);
  });

  it("would have caught one, because the comments in those files DO mention transports", () => {
    // Without this the comment stripper could be deleting everything and the
    // test above would pass by vacuity. The prose in these files argues at
    // length about transports; the code must not.
    const withComments = AUTHORIZATION_SOURCES.map((file) => sourceOf(file)).join("\n");
    const stripped = AUTHORIZATION_SOURCES.map((file) => codeOnly(sourceOf(file))).join("\n");
    expect(TRANSPORT_WORDS.test(withComments)).toBe(true);
    expect(stripped.length).toBeGreaterThan(4000);
  });
});
