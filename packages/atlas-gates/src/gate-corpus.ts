import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { CONTRACT_REVISION } from "@living-atlas/atlas-contract";
import {
  callTool,
  startHarness,
  type WireResponse
} from "@living-atlas/atlas-mcp/testing";
import { firstDifference, stableJson } from "./canonical.js";
import { constantClock, FIXTURE_REVEAL_KEY } from "./consumer-fixture.js";
import {
  BELIEF_TIMES,
  BELOW_HISTORY_FLOOR,
  buildCorpusGraph,
  independentClaimDigest,
  type CorpusGraph
} from "./corpus-fixture.js";
import { PINNED_QUERIES, type PinnedQuery } from "./corpus-queries.js";
import { gateResult, type GateResult } from "./finding.js";
import { repoRoot } from "./sources.js";

/**
 * GATE 3 — ANSWER REPRODUCIBILITY.
 *
 * Gate 2 compares one implementation against another artifact of the same
 * build. This one compares a build against its own past, and it is the only gate
 * here that does. Nothing else in this repository would notice if a change to
 * `intervalContains` altered which assertions a 2019 query returns: every
 * existing test computes the expected answer with the same code it is testing,
 * so the test moves with the change and stays green.
 *
 * That is not a hypothetical failure mode. It is the exact shape of the defect
 * this store was built to replace: the old surface mapped an unknown date to the
 * string "9999" and stripped "~" before comparing, and both of those look like
 * small, sensible normalisations at the call site. Either one, reintroduced as a
 * patch release, rewrites history — a consumer's saved answer from last year and
 * the same query today disagree, with no version number between them saying so.
 *
 * So: ANY change to a recorded answer fails, and fails as BREAKING. Not "review
 * this diff". The remedy for an intended change is a new contract revision, not
 * a re-recorded file, and the failure text says so because the moment it does
 * not somebody will re-record it.
 *
 * What is recorded is the ANSWER and not the envelope: which claims matched, in
 * what order, with what match quality and world-time fidelity, the coverage
 * counts, and the refusal code when the store refuses. Deliberately not the
 * whole response — the published output schemas are OPEN and additive evolution
 * is permitted, so pinning every byte would make the gate fail for a change the
 * contract explicitly allows. The envelope is gate 2's job.
 */

export type RecordedAnswer = {
  query: {
    id: string;
    holds: string;
    subject: "corpus-subject";
    predicate?: string;
    as_of_valid?: string;
    as_of_recorded?: string;
    include_superseded?: boolean;
  };
  outcome: "page" | "refused";
  refusal_code?: string;
  /** In the order the store returned them. Order is part of an answer. */
  matched: {
    claim: string;
    match_quality?: string;
    valid_time_fidelity?: string;
    withheld: boolean;
  }[];
  coverage: Record<string, unknown>;
  recorded_at_fidelity_mixed?: boolean;
};

export type CorpusFile = {
  contract_revision: string;
  /** Why re-recording is not the remedy. Read before you edit this file. */
  contract: string;
  answers: RecordedAnswer[];
};

export const CORPUS_CONTRACT =
  "These are answers, not fixtures. A difference here means the same question now has a different " +
  "answer than it had when this file was recorded, which is a BREAKING change to the meaning of the " +
  "data — regardless of how small the code change was. The remedy is a new contract revision under " +
  "schema/, not a re-recorded file. Re-record only when the owner has decided the old answers were " +
  "wrong, and say so in the commit message.";

export function corpusPath(root = repoRoot()): string {
  return join(root, "packages", "atlas-gates", "corpus", "answers.json");
}

function beliefInstant(name: NonNullable<PinnedQuery["as_of_recorded"]>): string {
  return name === "below-history-floor" ? BELOW_HISTORY_FLOOR : BELIEF_TIMES[name];
}

function argumentsFor(query: PinnedQuery, subjectId: string): Record<string, unknown> {
  return {
    subject_entity_id: subjectId,
    ...(query.predicate === undefined ? {} : { predicate: query.predicate }),
    ...(query.as_of_valid === undefined ? {} : { as_of_valid: query.as_of_valid }),
    ...(query.as_of_recorded === undefined ? {} : { as_of_recorded: beliefInstant(query.as_of_recorded) }),
    ...(query.include_superseded === undefined ? {} : { include_superseded: query.include_superseded })
  };
}

/**
 * Project one response down to an answer.
 *
 * A returned record is named by the corpus's own label for its claim, resolved
 * through the assertion id. A withheld record arrives as a redaction stub whose
 * id is a per-credential hash and names nothing, so it is resolved by the `seq`
 * the stub carries — which is why the stub carries one.
 */
function projectAnswer(query: PinnedQuery, response: WireResponse, graph: CorpusGraph): RecordedAnswer {
  const base: RecordedAnswer["query"] = {
    id: query.id,
    holds: query.holds,
    subject: "corpus-subject",
    ...(query.predicate === undefined ? {} : { predicate: query.predicate }),
    ...(query.as_of_valid === undefined ? {} : { as_of_valid: query.as_of_valid }),
    ...(query.as_of_recorded === undefined ? {} : { as_of_recorded: query.as_of_recorded }),
    ...(query.include_superseded === undefined ? {} : { include_superseded: query.include_superseded })
  };

  const structured = response.result?.["structuredContent"] as Record<string, unknown> | undefined;
  if (structured === undefined) {
    const text = (response.result?.["content"] as { text?: string }[] | undefined)?.[0]?.text;
    let code = "unparseable";
    try {
      const parsed = JSON.parse(text ?? "") as { code?: string };
      if (typeof parsed.code === "string") code = parsed.code;
    } catch {
      code = response.error ? `jsonrpc:${response.error.code}` : "unparseable";
    }
    return { query: base, outcome: "refused", refusal_code: code, matched: [], coverage: {} };
  }

  const seqToLabel = new Map<number, string>();
  for (const [id, label] of graph.labelOf) {
    const assertion = graph.assertions.read(id as never);
    if (assertion) seqToLabel.set(assertion.seq, label);
  }

  const matched: RecordedAnswer["matched"] = [];
  for (const raw of (structured["results"] as unknown[] | undefined) ?? []) {
    const record = raw as Record<string, unknown>;
    if (record["record_schema"] === "atlas.redaction:v1") {
      const seq = typeof record["seq"] === "number" ? record["seq"] : -1;
      matched.push({ claim: seqToLabel.get(seq) ?? `unlabelled-seq-${seq}`, withheld: true });
      continue;
    }
    const id = record["assertion_id"];
    matched.push({
      claim: (typeof id === "string" ? graph.labelOf.get(id) : undefined) ?? `unlabelled:${String(id)}`,
      ...(typeof record["match_quality"] === "string" ? { match_quality: record["match_quality"] } : {}),
      ...(typeof record["valid_time_fidelity"] === "string"
        ? { valid_time_fidelity: record["valid_time_fidelity"] }
        : {}),
      withheld: false
    });
  }

  const horizonBlock = structured["horizon"] as Record<string, unknown> | undefined;
  return {
    query: base,
    outcome: "page",
    matched,
    coverage: (structured["coverage"] as Record<string, unknown> | undefined) ?? {},
    ...(typeof horizonBlock?.["recorded_at_fidelity_mixed"] === "boolean"
      ? { recorded_at_fidelity_mixed: horizonBlock["recorded_at_fidelity_mixed"] }
      : {})
  };
}

export type CorpusReplay = {
  answers: RecordedAnswer[];
  /** Records whose stored digest disagrees with the independent recomputation. */
  digestDisagreements: string[];
};

/** Replay every pinned query against a freshly built corpus, over the wire. */
export async function replayCorpus(): Promise<CorpusReplay> {
  const graph = buildCorpusGraph();
  const harness = startHarness({
    graph,
    clock: constantClock("2026-06-01T00:00:00.000Z"),
    revealStateKey: FIXTURE_REVEAL_KEY
  });

  try {
    const answers: RecordedAnswer[] = [];
    let id = 500;
    for (const query of PINNED_QUERIES) {
      id += 1;
      harness.client.send(
        callTool({ id, name: "atlas.assertion.query.v1", args: argumentsFor(query, graph.subject.entity_id) })
      );
      answers.push(projectAnswer(query, await harness.client.await(id), graph));
    }

    // The claim digest covers the claim core and nothing else. Checked against a
    // second implementation, in this package, that shares no code with the one
    // that produced the stored value.
    const digestDisagreements: string[] = [];
    const page = graph.assertions.query({});
    if (page.ok) {
      for (const hit of page.hits) {
        const expected = independentClaimDigest(hit.assertion);
        if (expected !== hit.assertion.claim_digest) {
          digestDisagreements.push(
            `${graph.labelOf.get(hit.assertion.assertion_id) ?? hit.assertion.assertion_id}: stored ` +
              `${hit.assertion.claim_digest}, independent recomputation over the claim core alone ` +
              `gives ${expected}`
          );
        }
      }
    }

    return { answers, digestDisagreements };
  } finally {
    await harness.client.close();
  }
}

export function corpusFileFor(replay: CorpusReplay): CorpusFile {
  return { contract_revision: CONTRACT_REVISION, contract: CORPUS_CONTRACT, answers: replay.answers };
}

export async function runCorpusGate(root = repoRoot()): Promise<GateResult> {
  const path = corpusPath(root);
  const shown = relative(root, path).split("\\").join("/");
  const replay = await replayCorpus();
  const failures: string[] = [];

  for (const disagreement of replay.digestDisagreements) {
    failures.push(
      "BREAKING: the claim digest no longer covers the claim core alone.\n" +
        `    ${disagreement}\n` +
        "    Two consumers asserting the same fact at different moments must produce the SAME digest; " +
        "that is what makes it a contradiction key. A digest that covers belief time, provenance or " +
        "confidence silently stops detecting contradictions, and every test that compares a digest to " +
        "itself keeps passing."
    );
  }

  if (!existsSync(path)) {
    failures.push(
      `No answer corpus at ${shown}. Record it with \`npm run gates -- --write-corpus\` and read what ` +
        "it recorded: from that moment on, every one of those answers is a promise."
    );
    return gateResult("3. answer reproducibility", failures, { queries: replay.answers.length });
  }

  const recorded = JSON.parse(readFileSync(path, "utf8")) as CorpusFile;
  const current = corpusFileFor(replay);

  const recordedIds = recorded.answers.map((answer) => answer.query.id);
  const currentIds = current.answers.map((answer) => answer.query.id);

  for (const id of recordedIds) {
    if (!currentIds.includes(id)) {
      failures.push(
        `BREAKING: pinned query "${id}" is recorded and is no longer replayed. A query removed from ` +
          "the corpus is an answer nobody is holding anymore. If the question genuinely stopped " +
          "existing, say which revision retired it."
      );
    }
  }
  for (const id of currentIds) {
    if (!recordedIds.includes(id)) {
      failures.push(
        `Pinned query "${id}" is replayed and has no recorded answer. Adding a query is safe and ` +
          "welcome — record it in the same commit that adds it, so its first answer is reviewed by " +
          "the person who chose the question."
      );
    }
  }

  for (const answer of current.answers) {
    const before = recorded.answers.find((candidate) => candidate.query.id === answer.query.id);
    if (before === undefined) continue;
    // The prose is documentation, not an answer; comparing it would make
    // improving a comment a breaking change.
    const strip = (value: RecordedAnswer): unknown => ({ ...value, query: { ...value.query, holds: undefined } });
    const difference = firstDifference(strip(before), strip(answer));
    if (difference === undefined) continue;

    failures.push(
      `BREAKING: pinned query "${answer.query.id}" now has a different answer.\n` +
        `    ${difference}\n` +
        `    This query holds: ${before.query.holds}\n` +
        "    A change here rewrites history: a consumer that saved this answer and re-asks the same " +
        "question today gets a different one, with no revision between them saying it changed. The " +
        "remedy is a new revision under schema/, not a re-recorded corpus."
    );
  }

  return gateResult("3. answer reproducibility", failures, {
    queries: current.answers.length,
    corpus: shown,
    claims: replay.answers.length
  });
}

export function serializeCorpus(file: CorpusFile): string {
  return stableJson(file);
}
