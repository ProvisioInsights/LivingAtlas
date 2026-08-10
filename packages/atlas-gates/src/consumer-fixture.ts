import {
  callTool,
  listTools,
  seedAssertions,
  seedRelationship,
  seedWithheldAssertion,
  startHarness,
  syntheticGraph,
  type WireResponse
} from "@living-atlas/atlas-mcp/testing";
import { canonicalizeResponse, type LabelMap } from "./canonical.js";

/**
 * The one synthetic consumer fixture that gates 1 and 2 both drive.
 *
 * Everything here is fabricated in memory: three synthetic people, four seeded
 * assertions, one of them sealed so the withheld path is exercised. No gate in
 * this package reads a real graph, a real profile directory, or any path outside
 * the repository — the repo's privacy boundary is that policy, leakage, key and
 * audit behaviour is proven on synthetic fixtures BEFORE real data is imported,
 * and a build gate is exactly the wrong place to be on the other side of it.
 *
 * The clock is CONSTANT rather than incrementing. That is what makes a golden
 * reproducible without erasing its timestamps: an incrementing clock advances on
 * every read, so adding one `clock()` call anywhere shifts every stamp in every
 * fixture and the goldens fail for a reason that is not a change in behaviour. A
 * constant clock advances only where the store's own `Math.max(now, last + 1)`
 * monotone guard advances it — once per commit, once per audit event — which are
 * the advances a reader would want a golden to notice.
 */

export function constantClock(instant = "2026-08-04T12:00:00.000Z"): () => Date {
  const millis = new Date(instant).getTime();
  return () => new Date(millis);
}

/** A 32-byte synthetic HMAC key. Never a real one, and never read from anywhere. */
export const FIXTURE_REVEAL_KEY = "atlas-gates-synthetic-hmac-key-0";

export type CapturedCase = {
  /** Stable file-safe name; the golden's filename and its identity. */
  caseName: string;
  tool: string;
  /** What the case is for, so a reader knows what re-recording it would cost. */
  intent: string;
  /** The wire result, canonicalised. */
  captured: unknown;
  /** The same result, un-canonicalised, for gates that need the real ids. */
  raw: WireResponse;
};

type CaseSpec = { caseName: string; tool: string; intent: string; args: Record<string, unknown> };

function buildGraph() {
  const clock = constantClock();
  const graph = syntheticGraph({ clock, entityCount: 3 });
  seedAssertions(graph, 2);
  seedRelationship(graph, 0, 1);
  seedWithheldAssertion(graph);
  return { clock, graph };
}

function firstAssertionId(graph: ReturnType<typeof buildGraph>["graph"]): string {
  const page = graph.assertions.query({});
  if (!page.ok) throw new Error("the fixture graph refused its own unfiltered query");
  const hit = page.hits[0];
  if (!hit) throw new Error("the fixture graph committed no assertions");
  return hit.assertion.assertion_id;
}

/**
 * One case per published tool, in contract order, plus the two shapes that only
 * appear on a second round trip.
 *
 * Arguments are chosen to reach a COMPLETE result rather than an input
 * validation error, because gate 2 validates every golden against the tool's own
 * published output schema and an input error carries no structured content to
 * validate. A tool that can only be reached with arguments nobody would send is
 * a tool whose golden proves nothing.
 */
function caseSpecs(entityId: string, assertionId: string): CaseSpec[] {
  return [
    {
      caseName: "atlas.contract.describe.v1",
      tool: "atlas.contract.describe.v1",
      intent: "The published contract as the server reports it: revision, limits, history floor, tool table.",
      args: {}
    },
    {
      caseName: "atlas.scope.describe.v1",
      tool: "atlas.scope.describe.v1",
      intent: "The calling credential's grant, published so a consumer never has to infer it from a transport.",
      args: {}
    },
    {
      caseName: "atlas.entity.resolve.v1",
      tool: "atlas.entity.resolve.v1",
      intent: "One resolvable id and one that was never minted, so both outcomes are recorded side by side.",
      args: { ids: [entityId, "never-minted-by-atlas"] }
    },
    {
      caseName: "atlas.entity.read.v1",
      tool: "atlas.entity.read.v1",
      intent: "A whole entity record with its provenance and sensitivity block.",
      args: { entity_ids: [entityId] }
    },
    {
      caseName: "atlas.assertion.query.v1",
      tool: "atlas.assertion.query.v1",
      intent: "A bitemporal page that includes a withheld row as a redaction stub, so counts reconcile.",
      args: { subject_entity_id: entityId }
    },
    {
      caseName: "atlas.assertion.read.v1",
      tool: "atlas.assertion.read.v1",
      intent: "A direct read by id with lineage requested.",
      args: { assertion_ids: [assertionId], include_lineage: true }
    },
    {
      caseName: "atlas.graph.neighbors.v1",
      tool: "atlas.graph.neighbors.v1",
      intent: "A one-hop traversal, truncated by max_depth, reporting a partial horizon.",
      args: { entity_id: entityId }
    },
    {
      caseName: "atlas.text.search.v1",
      tool: "atlas.text.search.v1",
      intent: "Deterministic text scoring over the fixture's display names.",
      args: { query: "Synthetic Person 1" }
    },
    {
      caseName: "atlas.changes.read.v1",
      tool: "atlas.changes.read.v1",
      intent: "The change feed from the beginning of the epoch, with records inlined.",
      args: { cursor_seq: 0, include_records: true }
    },
    {
      caseName: "atlas.assertion.propose.v1",
      tool: "atlas.assertion.propose.v1",
      intent: "A one-item submission committed under the calling credential, with its receipt.",
      args: {
        idempotency_key: "atlas-gates-golden-propose",
        proposals: [
          {
            kind: "fact",
            lineage_action: "assert",
            subject_entity_id: entityId,
            predicate: "worked-at",
            value: "Golden Employer",
            confidence: { band: "high" },
            evidence_links: [{ evidence_id: "ev-golden", stance: "supports" }]
          }
        ]
      }
    },
    {
      caseName: "atlas.submission.read.v1",
      tool: "atlas.submission.read.v1",
      intent: "The same receipt read back by idempotency key, with the deduplication window's expiry.",
      args: { idempotency_key: "atlas-gates-golden-propose" }
    },
    {
      caseName: "atlas.sensitive.reveal.v1",
      tool: "atlas.sensitive.reveal.v1",
      intent: "A refusal that is still a complete contract result: unknown stub id, audit receipt attached.",
      args: { redaction_id: "la_redaction_00000000000000000000000000000000", reason: "gate fixture probe" }
    },
    {
      caseName: "atlas.entity.create.v1",
      tool: "atlas.entity.create.v1",
      intent:
        "A minted entity with the id Atlas chose, its owner-authored provenance and its sensitivity block. Records that the id is NOT derived from the name.",
      args: {
        type: "organization",
        display_name: "Golden Institute",
        also_known_as: ["GI"]
      }
    },
    {
      caseName: "atlas.entity.rename.v1",
      tool: "atlas.entity.rename.v1",
      intent:
        "A rename of a fixture entity: same entity_id and same registered_at, changed display_name and a moved updated_at — the record that proves a rename is not a re-identification.",
      args: { entity_id: entityId, display_name: "Synthetic Person 0 (renamed)" }
    }
  ];
}

async function drive(
  options: { revealEscalationInBand?: boolean },
  run: (send: (spec: CaseSpec) => Promise<WireResponse>, entityId: string, assertionId: string) => Promise<void>
): Promise<{ advertised: unknown[]; results: { spec: CaseSpec; response: WireResponse }[] }> {
  const { clock, graph } = buildGraph();
  const harness = startHarness({
    graph,
    clock,
    revealStateKey: FIXTURE_REVEAL_KEY,
    ...(options.revealEscalationInBand === undefined ? {} : { revealEscalationInBand: options.revealEscalationInBand })
  });

  try {
    harness.client.send(listTools({ id: 1 }));
    const listed = await harness.client.await(1);
    const advertised = (listed.result?.["tools"] as unknown[] | undefined) ?? [];

    const entityId = graph.entityList[0]?.entity_id;
    if (entityId === undefined) throw new Error("the fixture graph registered no entities");
    const assertionId = firstAssertionId(graph);

    const results: { spec: CaseSpec; response: WireResponse }[] = [];
    let id = 100;
    const send = async (spec: CaseSpec): Promise<WireResponse> => {
      id += 1;
      harness.client.send(callTool({ id, name: spec.tool, args: spec.args }));
      const response = await harness.client.await(id);
      results.push({ spec, response });
      return response;
    };

    await run(send, entityId, assertionId);
    return { advertised, results };
  } finally {
    await harness.client.close();
  }
}

/** Dig the redaction stub's id out of a query page, so the reveal case names a real one. */
function stubIdFrom(response: WireResponse): string {
  const structured = response.result?.["structuredContent"] as { results?: unknown[] } | undefined;
  for (const record of structured?.results ?? []) {
    const candidate = record as { record_schema?: string; redaction_id?: string };
    if (candidate.record_schema === "atlas.redaction:v1" && typeof candidate.redaction_id === "string") {
      return candidate.redaction_id;
    }
  }
  throw new Error("the fixture query returned no redaction stub, so no reveal case can be recorded");
}

export type ConsumerCapture = {
  /** `tools/list` as the server published it, for byte-identity checks. */
  advertised: { name: string; inputSchema: unknown; outputSchema: unknown }[];
  cases: CapturedCase[];
};

let cached: Promise<ConsumerCapture> | undefined;

/**
 * Drive the consumer server over a real pipe and record every case.
 *
 * Memoised, because gate 1 and gate 2 both want it and starting the server twice
 * would double the runtime of `npm run gates` for no extra signal. The capture is
 * a pure function of the fixture, so a shared result and two separate ones are
 * the same result.
 */
export function captureConsumerCases(): Promise<ConsumerCapture> {
  cached ??= captureUncached();
  return cached;
}

async function captureUncached(): Promise<ConsumerCapture> {
  const labels: LabelMap = new Map();

  const main = await drive({}, async (send, entityId, assertionId) => {
    for (const spec of caseSpecs(entityId, assertionId)) await send(spec);
  });

  // A second server, because `revealEscalationInBand` is a different server
  // configuration and not a different argument. The same fixture is rebuilt, so
  // the escalation case is recorded against the same graph the refusal was.
  const escalation = await drive({ revealEscalationInBand: true }, async (send, entityId) => {
    const query: CaseSpec = {
      caseName: "reveal-escalation-precondition",
      tool: "atlas.assertion.query.v1",
      intent: "Not recorded: run only to obtain a real redaction stub id for the escalation case.",
      args: { subject_entity_id: entityId }
    };
    const page = await send(query);
    await send({
      caseName: "atlas.sensitive.reveal.v1.escalation",
      tool: "atlas.sensitive.reveal.v1",
      intent:
        "The in-band escalation: a complete result carrying outcome input-required and a signed request_state.",
      args: { redaction_id: stubIdFrom(page), reason: "gate fixture escalation" }
    });
  });

  const cases: CapturedCase[] = [];
  for (const { spec, response } of main.results) {
    cases.push({
      caseName: spec.caseName,
      tool: spec.tool,
      intent: spec.intent,
      captured: canonicalizeResponse(response.result ?? { jsonrpc_error: response.error }, labels),
      raw: response
    });
  }
  for (const { spec, response } of escalation.results) {
    if (spec.caseName === "reveal-escalation-precondition") continue;
    cases.push({
      caseName: spec.caseName,
      tool: spec.tool,
      intent: spec.intent,
      captured: canonicalizeResponse(response.result ?? { jsonrpc_error: response.error }, labels),
      raw: response
    });
  }

  return {
    advertised: main.advertised as ConsumerCapture["advertised"],
    cases
  };
}
