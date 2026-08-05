import { afterEach, describe, expect, it } from "vitest";
import { CLIENT_CAPABILITIES_META_KEY } from "@modelcontextprotocol/server";
import { redactionId } from "../access.js";
import { MemoryAuditJournal } from "../audit.js";
import { credentialResolver } from "../credentials.js";
import {
  CONSUMER_PRINCIPAL,
  SYNTHETIC_SECRET,
  callTool,
  credentialEnvelope,
  fixedClock,
  seedAssertions,
  seedWithheldAssertion,
  startHarness,
  startHttpHarness,
  syntheticDirectory,
  syntheticGraph,
  type Harness,
  type HttpHarness,
  type SyntheticGraph,
  type WireResponse
} from "../testing.js";

/**
 * The one-contract promise, held to bytes.
 *
 * ADR 0013 publishes it and the server instructions repeat it to every client:
 * "Never branch on which transport you connected over." That is a claim about
 * RESULTS, and until there were two transports it could not be checked. Now it
 * can, so it is — for a read, a write, a change-feed page, the contract
 * description itself, and the refusal path that is hardest to keep identical
 * because each transport produces it by a different mechanism.
 *
 * The comparison is over the STRUCTURED result, which is the thing a consumer
 * consumes. The transport envelope around it legitimately differs — one side is
 * a framed line on a pipe, the other an HTTP response with a status and headers
 * — and comparing those would be comparing the two transports rather than the
 * one contract.
 *
 * ## What is normalised, and why that does not hollow out the test
 *
 * Ids are MINTED, never derived (`atlas-core/src/ids.ts`): ULID-shaped, sixteen
 * characters of `randomBytes`. Two servers therefore cannot mint the same id,
 * and no arrangement of fixtures can make them. So ids are replaced by
 * placeholders assigned IN FIRST-SEEN ORDER, per result. That keeps the property
 * that actually matters: if an entity id appears in three places in one result,
 * it becomes the same placeholder in all three, and the two transports must
 * agree on how many distinct ids there are, where each one appears, and which
 * positions co-refer. A transport that returned the right shape with the
 * cross-references scrambled would still fail.
 *
 * Nothing else is normalised. `recorded_at`, `seq`, coverage counts, withheld
 * counts, fidelity flags, tier labels, error codes, refusal messages and the
 * audit receipt's own digest-derived id are all compared literally — which is
 * why both sides are driven by a fixed clock and identically seeded fixtures.
 */

const MINTED_ID = /\bla_[a-z]+_[0-9a-z]{26}\b/g;
const CONTENT_DIGEST = /\bsha256:[a-f0-9]{64}\b/g;

/**
 * Replace nondeterministic values with first-seen-order placeholders.
 *
 * Over the SERIALISED result rather than by walking the object, so a value is
 * caught wherever it appears — as a field, inside a message a human will read,
 * or embedded in a cursor — and no code here has to know which fields hold one.
 *
 * `digests` is opt-in and is used ONLY by the `separate`-fixtures case, because
 * it is only there that a digest is nondeterministic. `request_digest` and
 * `claim_digest` are SHA-256 over the proposal's content, and that content names
 * the subject entity — a minted id. A digest over an input containing a minted
 * id inherits exactly the nondeterminism of the id, so normalising it is the
 * same concession already made for the id itself, not a new one. On `shared`
 * fixtures the ids are identical, the digests are identical, and they are
 * compared literally.
 */
export function normaliseMintedIds(value: unknown, options: { digests?: boolean } = {}): { text: string; count: number } {
  const seen = new Map<string, string>();
  const placeholder = (raw: string, label: string): string => {
    const existing = seen.get(raw);
    if (existing !== undefined) return existing;
    const minted = `<${label}#${seen.size}>`;
    seen.set(raw, minted);
    return minted;
  };

  let text = JSON.stringify(value).replace(MINTED_ID, (id) => placeholder(id, id.slice(0, id.lastIndexOf("_"))));
  if (options.digests === true) text = text.replace(CONTENT_DIGEST, (digest) => placeholder(digest, "sha256"));
  return { text, count: seen.size };
}

const stdioHarnesses: Harness[] = [];
const httpHarnesses: HttpHarness[] = [];

afterEach(async () => {
  while (stdioHarnesses.length > 0) await stdioHarnesses.pop()?.handle.close();
  while (httpHarnesses.length > 0) await httpHarnesses.pop()?.close();
});

/** Seeds a fixture. Applied identically to whichever graphs the case uses. */
type Seed = (graph: SyntheticGraph) => void;

/**
 * How the two transports get their graph.
 *
 * `shared` is the default and the stronger arrangement: one graph behind both
 * servers means both answer about the SAME minted ids, so a read comparison has
 * nothing left to normalise and holds literal bytes. It is only available for
 * calls that do not mutate.
 *
 * `separate` exists for `assertion.propose`, which does. Two transports writing
 * the same idempotency key into one log is the replay path by design — the
 * second would receive the first's receipt with `state: "replayed"` — so the
 * write case gets two identically-seeded graphs instead, and pays for it by
 * having minted ids to normalise.
 */
type Fixtures = "shared" | "separate";

async function bothTransports(
  seed: Seed,
  fixtures: Fixtures
): Promise<{
  stdio: (message: Record<string, unknown>) => Promise<WireResponse>;
  http: (message: Record<string, unknown>) => Promise<WireResponse>;
  graphs: { stdio: SyntheticGraph; http: SyntheticGraph };
  audits: { stdio: MemoryAuditJournal; http: MemoryAuditJournal };
}> {
  const directory = syntheticDirectory(CONSUMER_PRINCIPAL);
  const resolvePrincipal = credentialResolver({ directory, plane: "consumer" });

  const build = (): SyntheticGraph => {
    const graph = syntheticGraph({ clock: fixedClock() });
    seed(graph);
    return graph;
  };

  const first = build();
  const second = fixtures === "shared" ? first : build();

  // Separate journals either way: each server writes its own, and comparing them
  // is part of the assertion rather than something to be arranged away.
  const audits = { stdio: new MemoryAuditJournal(), http: new MemoryAuditJournal() };

  // Each server gets its OWN clock, started at the same instant, so `recorded_at`
  // and the digest-derived audit `event_id` are compared literally rather than
  // normalised.
  const stdio = startHarness({
    graph: first,
    auditJournal: audits.stdio,
    resolvePrincipal,
    clock: fixedClock()
  });
  stdioHarnesses.push(stdio);

  // A real socket here, unlike most of the conformance file: the claim these
  // tests make is that the same call over a real HTTP transport yields the same
  // answer, and driving the handler in-process would be quietly weaker than the
  // sentence the ADR writes down.
  const http = await startHttpHarness({
    graph: second,
    auditJournal: audits.http,
    directory,
    clock: fixedClock(),
    socket: true
  });
  httpHarnesses.push(http);

  return {
    graphs: { stdio: first, http: second },
    audits,
    stdio: (message) => {
      stdio.client.send(message);
      return stdio.client.await(message["id"] as number);
    },
    http: (message) => http.send(message)
  };
}

/** The structured result a consumer consumes, or the error if the call refused on the wire. */
function comparable(response: WireResponse): unknown {
  if (response.error !== undefined) return { error: response.error };
  return {
    structuredContent: response.result?.["structuredContent"],
    isError: response.result?.["isError"] ?? false,
    resultType: response.result?.["resultType"]
  };
}

/**
 * Drive one call over both transports and assert the results are the same bytes.
 *
 * Returns the parsed stdio result so a case can make additional assertions about
 * WHAT was compared — a parity test that passed because both transports returned
 * an empty object would otherwise look identical to one that passed properly.
 */
async function assertParity(
  build: (graph: SyntheticGraph) => Record<string, unknown>,
  options: { seed?: Seed; fixtures?: Fixtures } = {}
): Promise<{ stdio: WireResponse; http: WireResponse; ids: number }> {
  const fixtures = options.fixtures ?? "shared";
  const both = await bothTransports(options.seed ?? (() => {}), fixtures);
  // Tied to the fixture arrangement rather than passed per case, so no case can
  // relax the comparison without also taking on separate fixtures and saying why.
  const norm = { digests: fixtures === "separate" };

  /**
   * The call is built per fixture rather than written once, because an argument
   * can legitimately NAME a minted id — `assertion.propose` has to say which
   * entity it is asserting about, and on separate fixtures that id is a
   * different string on each side.
   *
   * So that this cannot quietly become "two different calls", the two messages
   * are themselves compared through the normaliser first: after minted ids are
   * replaced they must be identical. A case that accidentally sent a different
   * page size, tool or argument to one transport fails here, before any result
   * is looked at.
   */
  const overStdioMessage = build(both.graphs.stdio);
  const overHttpMessage = build(both.graphs.http);
  expect(normaliseMintedIds(overHttpMessage).text).toBe(normaliseMintedIds(overStdioMessage).text);

  const [overStdio, overHttp] = await Promise.all([both.stdio(overStdioMessage), both.http(overHttpMessage)]);

  const left = normaliseMintedIds(comparable(overStdio), norm);
  const right = normaliseMintedIds(comparable(overHttp), norm);

  expect(right.text).toBe(left.text);
  expect(right.count).toBe(left.count);

  // The audit trail is part of the contract, not a side effect: one call in, one
  // event out, on either transport.
  expect(both.audits.http.events).toHaveLength(both.audits.stdio.events.length);
  expect(both.audits.http.events[0]?.["outcome"]).toBe(both.audits.stdio.events[0]?.["outcome"]);
  expect(both.audits.http.events[0]?.["plane"]).toBe(both.audits.stdio.events[0]?.["plane"]);

  return { stdio: overStdio, http: overHttp, ids: left.count };
}

/** The stdio side presents its credential on `_meta`; the HTTP side presents the same secret as a bearer. */
const meta = (overrides: Record<string, unknown> = {}) => credentialEnvelope(SYNTHETIC_SECRET, overrides);

describe("the same call over stdio and over HTTP", () => {
  it("describes the contract identically", async () => {
    const { stdio } = await assertParity(() =>
      callTool({ id: 1, name: "atlas.contract.describe.v1", args: {}, meta: meta() })
    );

    // Guard against a vacuous pass: the thing compared is the real description.
    const structured = stdio.result?.["structuredContent"] as Record<string, unknown>;
    expect(structured["revision"]).toBeDefined();
    expect(structured["limits"]).toBeDefined();
  });

  it("answers a bitemporal query identically, redaction stubs and coverage included", async () => {
    const { stdio, ids } = await assertParity(
      () => callTool({ id: 1, name: "atlas.assertion.query.v1", args: {}, meta: meta() }),
      {
        seed: (graph) => {
          seedAssertions(graph, 3);
          seedWithheldAssertion(graph);
        }
      }
    );

    const structured = stdio.result?.["structuredContent"] as Record<string, unknown>;
    const results = structured["results"] as Record<string, unknown>[];
    expect(results.length).toBeGreaterThan(0);
    // The withheld row occupies its place on BOTH transports, and the counts
    // that make absence reportable rather than invisible matched byte for byte.
    expect(results.some((record) => record["record_schema"] === "atlas.redaction:v1")).toBe(true);
    expect(structured["coverage"]).toMatchObject({ withheld: 1 });
    // And the comparison was over real ids, not an empty page.
    expect(ids).toBeGreaterThan(0);
  });

  it("reads the change feed identically, in seq order with the same cursor", async () => {
    const { stdio } = await assertParity(
      () => callTool({ id: 1, name: "atlas.changes.read.v1", args: { cursor_seq: 0, limit: 2 }, meta: meta() }),
      { seed: (graph) => seedAssertions(graph, 4) }
    );

    const structured = stdio.result?.["structuredContent"] as Record<string, unknown>;
    expect((structured["changes"] as unknown[]).length).toBe(2);
    expect(structured["has_more"]).toBe(true);
    // `seq` is compared literally — it is not normalised — so the two transports
    // agreed on feed position, not merely on shape.
    expect((structured["changes"] as { seq: number }[]).map((change) => change.seq)).toEqual([1, 2]);
  });

  it("commits a proposal identically, down to the receipt's state", async () => {
    /**
     * A write, which is where parity is least likely to hold by accident. This
     * is the one case on `separate` fixtures, so the two servers mint their own
     * submission and assertion ids from their own `randomBytes` — the test
     * passes only because everything AROUND those ids is identical: the receipt
     * state, the per-proposal outcomes, the tier the content landed at, the
     * horizon, and the audit event the commit wrote.
     *
     * Each side names its own fixture's first entity, and `assertParity` proves
     * the two messages are the same call by normalising them before sending.
     */
    const { stdio, ids } = await assertParity(
      (graph) =>
        callTool({
          id: 1,
          name: "atlas.assertion.propose.v1",
          args: {
            idempotency_key: "parity-key",
            proposals: [
              {
                kind: "fact",
                subject_entity_id: graph.entityList[0]?.entity_id,
                predicate: "worked-at",
                value: "Acme",
                confidence: { band: "high" },
                evidence_links: [{ evidence_id: "e1", stance: "supports" }]
              }
            ]
          },
          meta: meta()
        }),
      { fixtures: "separate" }
    );

    const submission = (stdio.result?.["structuredContent"] as Record<string, unknown>)["submission"] as Record<
      string,
      unknown
    >;
    expect(submission["state"]).toBe("committed");
    expect((submission["assertion_ids"] as unknown[]).length).toBe(1);
    // Ids were present and were what got normalised — the submission id and the
    // minted assertion id at minimum.
    expect(ids).toBeGreaterThanOrEqual(2);
  });

  it("refuses a reveal without the elicitation capability identically, as -32021 on both", async () => {
    /**
     * The case most likely to diverge, because the two transports produce it by
     * different mechanisms: stdio swaps the outbound message at a transport
     * decorator, HTTP rewrites the response body, because `createMcpHandler`
     * owns its transport and leaves nothing to decorate. Both call the same
     * `capabilityErrorFor` to decide, and this asserts that the bytes that come
     * out the other end are the same — the numeric code, the
     * `requiredCapabilities` shape the spec's `data` member requires, and the
     * typed contract payload riding along in `data.result`.
     */
    const { stdio, http } = await assertParity(
      (graph) => {
        // The stub id is DERIVED from the withheld assertion's own minted id, so
        // it is read out of the fixture the call will run against rather than
        // written as a literal. On `shared` fixtures both sides read the same
        // one, which is why this case needs no normalisation to match.
        const page = graph.assertions.query({});
        if (!page.ok) throw new Error("the fixture query hit the history floor");
        const sealed = page.hits.find((hit) => hit.assertion.sensitivity.withheld);
        if (!sealed) throw new Error("the fixture holds no withheld assertion");

        return callTool({
          id: 1,
          name: "atlas.sensitive.reveal.v1",
          args: {
            redaction_id: redactionId(sealed.assertion.assertion_id, CONSUMER_PRINCIPAL),
            reason: "checking a citation"
          },
          meta: meta({ [CLIENT_CAPABILITIES_META_KEY]: {} })
        });
      },
      { seed: (graph) => seedWithheldAssertion(graph) }
    );

    for (const [label, response] of [["stdio", stdio], ["http", http]] as const) {
      expect(response.result, label).toBeUndefined();
      expect(response.error?.code, label).toBe(-32021);
      const data = response.error?.data as Record<string, unknown>;
      expect(data["requiredCapabilities"], label).toEqual({ elicitation: {} });
      expect((data["result"] as Record<string, unknown>)["outcome"], label).toBe("refused");
    }
  });
});

describe("a write that crosses transports", () => {
  it("replays the original receipt rather than committing twice", async () => {
    /**
     * The strongest form of the parity claim for a mutation, and the one
     * byte-equality cannot express: idempotency is keyed on
     * `(client_id, idempotency_key)` and NOTHING about the transport is in that
     * key. So a proposal made over stdio and retried over HTTP — the shape a
     * client takes when it reconnects differently after a timeout — must return
     * the FIRST receipt, not commit a second assertion.
     *
     * One graph behind both servers, because that is the deployment this
     * describes: one Atlas, two ways in.
     */
    const graph = syntheticGraph({ clock: fixedClock() });
    const directory = syntheticDirectory(CONSUMER_PRINCIPAL);
    const resolvePrincipal = credentialResolver({ directory, plane: "consumer" });

    const stdio = startHarness({
      graph,
      auditJournal: new MemoryAuditJournal(),
      resolvePrincipal,
      clock: fixedClock()
    });
    stdioHarnesses.push(stdio);
    const http = await startHttpHarness({
      graph,
      auditJournal: new MemoryAuditJournal(),
      directory,
      clock: fixedClock(),
      socket: true
    });
    httpHarnesses.push(http);

    const message = callTool({
      id: 1,
      name: "atlas.assertion.propose.v1",
      args: {
        idempotency_key: "crosses-transports",
        proposals: [
          {
            kind: "fact",
            subject_entity_id: graph.entityList[0]?.entity_id,
            predicate: "worked-at",
            value: "Acme",
            confidence: { band: "high" },
            evidence_links: [{ evidence_id: "e1", stance: "supports" }]
          }
        ]
      },
      meta: meta()
    });

    stdio.client.send(message);
    const first = (await stdio.client.await(1)).result?.["structuredContent"] as Record<string, unknown>;
    const second = (await http.send(message)).result?.["structuredContent"] as Record<string, unknown>;

    const committed = first["submission"] as Record<string, unknown>;
    const replayed = second["submission"] as Record<string, unknown>;

    expect(committed["state"]).toBe("committed");
    expect(replayed["state"]).toBe("replayed");
    // The original receipt, not a new one: same submission id, same assertion
    // ids, same commit instant.
    expect(replayed["submission_id"]).toBe(committed["submission_id"]);
    expect(replayed["assertion_ids"]).toEqual(committed["assertion_ids"]);
    expect(replayed["committed_at"]).toBe(committed["committed_at"]);
    // And the log grew by exactly one, so the retry wrote nothing.
    const page = graph.assertions.query({});
    expect(page.ok && page.hits).toHaveLength(1);
  });
});

describe("the normaliser itself", () => {
  it("gives co-referring ids the same placeholder and distinct ids different ones", () => {
    const a = "la_entity_00000000000000000000000001";
    const b = "la_entity_00000000000000000000000002";
    const { text, count } = normaliseMintedIds({ x: a, y: a, z: b });

    expect(count).toBe(2);
    expect(text).toBe(JSON.stringify({ x: "<la_entity#0>", y: "<la_entity#0>", z: "<la_entity#1>" }));
  });

  it("would NOT hide a scrambled cross-reference", () => {
    // The property the parity comparison depends on: two results whose ids
    // co-refer differently must not normalise to the same text.
    const a = "la_entity_00000000000000000000000001";
    const b = "la_entity_00000000000000000000000002";
    expect(normaliseMintedIds({ x: a, y: a }).text).not.toBe(normaliseMintedIds({ x: a, y: b }).text);
  });
});
