import { createHash } from "node:crypto";
import {
  AssertionLog,
  EntityRegistry,
  canonicalRecordedAt,
  type AssertionDraft,
  type Entity,
  type EntityId,
  type RecordedAt
} from "@living-atlas/atlas-core";
import type { GraphSource } from "@living-atlas/atlas-mcp";

/**
 * THE FROZEN CORPUS GRAPH.
 *
 * Every claim in it exists to make one bitemporal rule observable, and the rules
 * chosen are the ones that a plausible, well-meaning "small fix" would silently
 * change:
 *
 *   unknown            an unknown world-time endpoint matches NO as-of point.
 *                      The old store mapped unknown to the string "9999", so it
 *                      sorted to the far future and satisfied every "before X"
 *                      filter. Someone restoring that behaviour would be making
 *                      more rows match, which reads like an improvement.
 *   approximate        widens by one unit of its OWN precision and can only ever
 *                      answer "possible". The old store stripped the "~" and
 *                      compared exactly. Someone removing the widening would be
 *                      making the comparison "more precise".
 *   half-open          [from, to) — the instant at `to` is NOT contained. An
 *                      off-by-one here is invisible except at the boundary, and
 *                      boundaries are where the corpus probes.
 *   ongoing            an absent `to` is unbounded, not "until now".
 *   supersession       what was believed at T2 is not what is believed at T4,
 *                      and asking as of T2 must return the T2 answer.
 *   history floor      a belief-time read below the floor is REFUSED, never
 *                      answered from present state.
 *
 * The clock is set explicitly between commits rather than allowed to run, so
 * every `recorded_at` in this fixture is a value chosen here. That is what lets
 * a pinned query name an absolute belief instant and mean it.
 */

export const CORPUS_EPOCH = "corpus-e1";
export const CORPUS_HISTORY_FLOOR: RecordedAt = canonicalRecordedAt("2026-01-01T00:00:00.000Z");

/**
 * The belief instants the corpus commits at, named so a pinned query can cite
 * one. Exactly one per claim, and never two claims at the same instant.
 *
 * That is not tidiness. `AssertionLog.stampNow` guarantees strictly increasing
 * belief time with `Math.max(clock(), last + 1)`, so two commits asked to land
 * at the same instant land one millisecond apart — and a query pinned to that
 * instant then answers about the monotone guard instead of about belief time.
 * The first draft of this corpus did exactly that and recorded an empty page as
 * if it meant something.
 */
export const BELIEF_TIMES = {
  T1: canonicalRecordedAt("2026-02-01T00:00:00.000Z"),
  T2: canonicalRecordedAt("2026-02-02T00:00:00.000Z"),
  T3: canonicalRecordedAt("2026-02-03T00:00:00.000Z"),
  T4: canonicalRecordedAt("2026-02-04T00:00:00.000Z"),
  T5: canonicalRecordedAt("2026-02-05T00:00:00.000Z"),
  T6: canonicalRecordedAt("2026-02-06T00:00:00.000Z"),
  /** The original job title. */
  T7: canonicalRecordedAt("2026-03-01T00:00:00.000Z"),
  /** The correction that supersedes it. */
  T8: canonicalRecordedAt("2026-04-01T00:00:00.000Z"),
  T9: canonicalRecordedAt("2026-05-01T00:00:00.000Z")
} as const;

export type BeliefTimeName = keyof typeof BELIEF_TIMES;

/** An instant below the floor. Reading here must be refused, never answered. */
export const BELOW_HISTORY_FLOOR: RecordedAt = canonicalRecordedAt("2025-06-01T00:00:00.000Z");

export type CorpusClaim = {
  /** The corpus's own name for a claim. Stable, readable, and not an id. */
  label: string;
  committedAt: BeliefTimeName;
  draft: Omit<AssertionDraft, "subject_entity_id" | "supersedes" | "lineage_action"> & {
    lineage_action?: AssertionDraft["lineage_action"];
  };
  /** The label of the claim this one supersedes, if any. */
  supersedes?: string;
  sealed?: boolean;
};

const evidence = (id: string) => [{ evidence_id: id, stance: "supports" as const }];
const high = { band: "high" as const };

export const CORPUS_CLAIMS: readonly CorpusClaim[] = [
  {
    label: "exact-closed-span",
    committedAt: "T1",
    draft: {
      kind: "fact",
      predicate: "worked-at",
      value: "Acme Instruments",
      valid_from: { kind: "exact", value: "2019-01" },
      valid_to: { kind: "exact", value: "2022-01" },
      confidence: high,
      evidence_links: evidence("ev-acme")
    }
  },
  {
    label: "approximate-year-ongoing",
    committedAt: "T2",
    draft: {
      kind: "fact",
      predicate: "worked-at",
      value: "Borealis Works",
      // ~2019 widens to [2018-01-01, 2021-01-01) and every match through it is
      // "possible". No `valid_to`, so the interval is unbounded above.
      valid_from: { kind: "approximate", value: "2019" },
      confidence: high,
      evidence_links: evidence("ev-borealis")
    }
  },
  {
    label: "unknown-start",
    committedAt: "T3",
    draft: {
      kind: "fact",
      predicate: "worked-at",
      value: "Cygnus Holdings",
      valid_from: { kind: "unknown" },
      confidence: high,
      evidence_links: evidence("ev-cygnus")
    }
  },
  {
    label: "no-world-time",
    committedAt: "T4",
    draft: {
      kind: "fact",
      predicate: "worked-at",
      value: "Delta Foundry",
      confidence: high,
      evidence_links: evidence("ev-delta")
    }
  },
  {
    label: "exact-single-day",
    committedAt: "T5",
    draft: {
      kind: "fact",
      predicate: "attended",
      value: "Echo Summit",
      valid_from: { kind: "exact", value: "2020-06-15" },
      valid_to: { kind: "exact", value: "2020-06-16" },
      confidence: high,
      evidence_links: evidence("ev-echo")
    }
  },
  {
    label: "approximate-month",
    committedAt: "T6",
    draft: {
      kind: "fact",
      predicate: "attended",
      value: "Foxtrot Residency",
      // ~2020-06 widens to [2020-05-01, 2020-08-01); `valid_to` closes it at
      // 2020-08-01 exactly, so the interval's upper bound is exact and its lower
      // bound is not — which is why any match is still only "possible".
      valid_from: { kind: "approximate", value: "2020-06" },
      valid_to: { kind: "exact", value: "2020-08" },
      confidence: high,
      evidence_links: evidence("ev-foxtrot")
    }
  },
  {
    label: "belief-v1",
    committedAt: "T7",
    draft: {
      kind: "fact",
      predicate: "job-title",
      value: "Junior Metallurgist",
      valid_from: { kind: "exact", value: "2019-01" },
      confidence: high,
      evidence_links: evidence("ev-title-1")
    }
  },
  {
    label: "belief-v2",
    committedAt: "T8",
    supersedes: "belief-v1",
    draft: {
      kind: "fact",
      lineage_action: "correct",
      predicate: "job-title",
      value: "Senior Metallurgist",
      valid_from: { kind: "exact", value: "2019-01" },
      confidence: high,
      evidence_links: evidence("ev-title-2")
    }
  },
  {
    label: "sealed-note",
    committedAt: "T9",
    sealed: true,
    draft: {
      kind: "fact",
      predicate: "medical-note",
      value: "synthetic sealed value",
      valid_from: { kind: "exact", value: "2021-03" },
      confidence: high,
      evidence_links: evidence("ev-sealed")
    }
  }
];

export type CorpusGraph = GraphSource & {
  assertions: AssertionLog;
  registry: EntityRegistry;
  subject: Entity;
  /** assertion_id -> the corpus's label for that claim. */
  labelOf: Map<string, string>;
  /** label -> assertion_id, for a query that has to name one. */
  idOf: Map<string, string>;
};

/**
 * Build the corpus. A pure function of the constants above: same code, same
 * graph, every time — apart from the minted identifiers, which are random by
 * design and never appear in a recorded answer.
 */
export function buildCorpusGraph(): CorpusGraph {
  let now = new Date(CORPUS_HISTORY_FLOOR);
  const clock = (): Date => now;

  const registry = new EntityRegistry({ clock });
  const assertions = new AssertionLog({
    clock,
    feedEpoch: CORPUS_EPOCH,
    bitemporalSince: CORPUS_HISTORY_FLOOR
  });

  const subject = registry.register(
    { type: "person", display_name: "Corpus Subject", also_known_as: ["corpus-subject"] },
    { client_id: "corpus", sensitivity: { tier: "open", rank: 0, withheld: false } }
  );

  const labelOf = new Map<string, string>();
  const idOf = new Map<string, string>();

  for (const claim of CORPUS_CLAIMS) {
    now = new Date(BELIEF_TIMES[claim.committedAt]);
    const supersedes = claim.supersedes === undefined ? [] : [requireId(idOf, claim.supersedes)];
    const result = assertions.commit({
      client_id: "corpus",
      idempotency_key: `corpus-${claim.label}`,
      drafts: [
        {
          ...claim.draft,
          lineage_action: claim.draft.lineage_action ?? "assert",
          subject_entity_id: subject.entity_id,
          supersedes
        } as AssertionDraft
      ],
      // Explicit on BOTH branches. `commit` defaults unclassified content to
      // `local-private`, so a corpus that named a tier only for its sealed
      // claims would silently change what the other 18 answers mean the next
      // time a grant is narrowed.
      sensitivity:
        claim.sealed === true
          ? { tier: "sealed", rank: 90, withheld: true }
          : { tier: "open", rank: 0, withheld: false }
    });
    if (!result.ok) throw new Error(`the corpus could not commit ${claim.label}: ${result.code}`);
    const assertionId = result.receipt.assertion_ids[0];
    if (assertionId === undefined) throw new Error(`the corpus committed ${claim.label} with no id`);
    labelOf.set(assertionId, claim.label);
    idOf.set(claim.label, assertionId);
  }

  return {
    assertions,
    registry,
    subject,
    labelOf,
    idOf,
    entities: {
      read: (entityId: EntityId) => registry.read(entityId),
      resolve: (id: string) => registry.resolve(id)
    },
    searchableEntities: () => [subject],
    encryptedUnsearchable: () => 0,
    predicateRegistry: () => [
      { predicate: "worked-at", cardinality: "multi-valued", relational: false },
      { predicate: "attended", cardinality: "multi-valued", relational: false },
      { predicate: "job-title", cardinality: "functional", functional_key: ["subject_entity_id"], relational: false },
      { predicate: "medical-note", cardinality: "multi-valued", relational: false }
    ]
  };
}

function requireId(idOf: Map<string, string>, label: string): string {
  const found = idOf.get(label);
  if (found === undefined) throw new Error(`the corpus supersedes ${label} before committing it`);
  return found;
}

/**
 * An INDEPENDENT re-implementation of the claim-digest core.
 *
 * Independent is the whole point, so this calls nothing from `atlas-core`: its
 * own key-sorted serialiser, its own hash call, its own list of the five fields
 * the digest is allowed to cover. Two implementations that agree tell you
 * something; one implementation compared against itself tells you nothing, and
 * every existing digest test is of the second kind because they all compare a
 * stored digest to a freshly computed one from the same function.
 *
 * `claim_digest` is a dedup and contradiction key over the CLAIM CORE and
 * nothing else: subject, predicate, value, and the two world-time bounds. If it
 * grew to cover `recorded_at`, provenance, or confidence, two consumers
 * asserting the same fact at different moments would stop producing the same
 * digest, contradiction detection would quietly stop working, and nothing that
 * exists today would notice.
 */
export function independentClaimDigest(record: {
  subject_entity_id: string;
  predicate: string;
  value?: unknown;
  valid_from?: unknown;
  valid_to?: unknown;
}): string {
  const core = keySortedJson({
    subject_entity_id: record.subject_entity_id,
    predicate: record.predicate,
    value: record.value ?? null,
    valid_from: record.valid_from ?? null,
    valid_to: record.valid_to ?? null
  });
  return `sha256:${createHash("sha256").update(core, "utf8").digest("hex")}`;
}

function keySortedJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(keySortedJson).join(",")}]`;
  const pairs = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${keySortedJson(item)}`);
  return `{${pairs.join(",")}}`;
}
