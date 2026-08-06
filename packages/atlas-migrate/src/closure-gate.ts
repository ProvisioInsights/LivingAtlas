import {
  projectionPlanDigest,
  recomputeProjectionBreakdown,
  type ProjectionBreakdown,
  type ProjectionPlan,
  type SourceOutcome
} from "./projection.js";
import { normalizeTopicValue } from "./legacy-vocabulary.js";
import {
  ProjectedRecordSchema,
  isEntityRecord,
  isLegacyObjectProvenance,
  isMintedEntityRecord,
  isMintedRelationshipRecord,
  isProjectedFromLegacyObject,
  isRelationshipRecord,
  isRetractionRecord,
  slotMintedBy,
  type ProjectedRecord,
  type TopicScheme
} from "./target-plane.js";

/**
 * Findings are codes, not prose, so a gate failure is greppable and a new
 * failure mode cannot hide inside an existing message. Like every closed enum
 * here it carries "other", and a run that reports "other" is not certifiable.
 */
export const ClosureGateFindingCodeValues = [
  "closure-arithmetic-mismatch",
  "breakdown-mismatch",
  "plan-digest-mismatch",
  "invalid-record-shape",
  "unclassified-source-category",
  "unnamed-refusal-reason",
  "unnamed-source-disposition",
  "dangling-projected-endpoint",
  "retraction-target-missing",
  "duplicate-idempotency-key",
  "record-not-accounted",
  "minted-record-not-accounted",
  "duplicate-minted-topic",
  "duplicate-source-topic",
  "cross-scheme-topic-homonym",
  "unnamed-topic-scheme",
  "alias-row-missing",
  "alias-target-missing-record",
  "other"
] as const;
export type ClosureGateFindingCode = (typeof ClosureGateFindingCodeValues)[number];

/**
 * Whether a finding stops the plan certifying.
 *
 * `tolerated` exists for exactly one shape of problem: a condition the migration
 * FOUND rather than caused, that the owner has decided to carry across as it
 * stands. It is still counted, still named and still printed on every run — the
 * owner must not be able to stop learning about it — but refusing to certify
 * would block the migration forever on a state the source is already in, and no
 * amount of re-running the projector changes a fact about the corpus.
 *
 * It is NOT an acknowledgement flag or a suppression list. A code is tolerated
 * or it is not; there is no per-subject exemption, because an exemption is a
 * hole the size of whatever it exempts (ADR 0026, OPEN-19).
 */
export const ClosureGateSeverityValues = ["failure", "tolerated"] as const;
export type ClosureGateSeverity = (typeof ClosureGateSeverityValues)[number];

/**
 * The severity of each code, declared once and read by `finding`.
 *
 * A `Record` over the code union rather than a lookup with a default: a new code
 * fails to compile until somebody decides whether it blocks a migration, which
 * is the decision most likely to be made by accident. And because the severity
 * is derived from the code, one code can never be filed at two severities —
 * which is what makes "read the code, not the prose" a true statement.
 */
export const ClosureGateFindingSeverity: Record<ClosureGateFindingCode, ClosureGateSeverity> = {
  "closure-arithmetic-mismatch": "failure",
  "breakdown-mismatch": "failure",
  "plan-digest-mismatch": "failure",
  "invalid-record-shape": "failure",
  "unclassified-source-category": "failure",
  "unnamed-refusal-reason": "failure",
  "unnamed-source-disposition": "failure",
  "dangling-projected-endpoint": "failure",
  "retraction-target-missing": "failure",
  "duplicate-idempotency-key": "failure",
  "record-not-accounted": "failure",
  "minted-record-not-accounted": "failure",
  "duplicate-minted-topic": "failure",
  // The two tolerated codes. See `checkTopicVocabulary` for the argument.
  "duplicate-source-topic": "tolerated",
  "cross-scheme-topic-homonym": "tolerated",
  // A topic in no named scheme is the enum escape hatch, and it fails like every
  // other one: it means a mechanism started producing topics that nobody has
  // decided a vocabulary for, and its labels collide with nothing until somebody
  // does.
  "unnamed-topic-scheme": "failure",
  "alias-row-missing": "failure",
  "alias-target-missing-record": "failure",
  other: "failure"
};

export type ClosureGateFinding = {
  code: ClosureGateFindingCode;
  severity: ClosureGateSeverity;
  detail: string;
  /** Legacy ids or record keys, truncated for report size but counted in full. */
  subjects: string[];
  subject_count: number;
};

export const ClosureGateSchemaName = "living-atlas-migration-closure-gate:v1" as const;

export type ClosureGateResult = {
  gate_schema: typeof ClosureGateSchemaName;
  ok: boolean;
  plan_digest: string;
  breakdown: ProjectionBreakdown;
  findings: ClosureGateFinding[];
};

const MaxReportedSubjects = 20;

function finding(code: ClosureGateFindingCode, detail: string, subjects: string[]): ClosureGateFinding {
  return {
    code,
    severity: ClosureGateFindingSeverity[code],
    detail,
    subjects: subjects.slice(0, MaxReportedSubjects).sort(),
    subject_count: subjects.length
  };
}

/**
 * The whole point of the lane: for every source object,
 *
 *   count(source) == count(projected) + count(explicitly refused with a named reason)
 *
 * plus a dangling-endpoint check over what the projector actually produced. A
 * shape the author never mapped lands in "other" and FAILS here rather than
 * quietly disappearing between the two counts, because the failure mode this
 * gate exists to stop is a migration that reports success while leaving objects
 * behind with nobody to notice.
 */
export type ClosureGateOptions = {
  /**
   * Source count taken straight from the reader. Supplying it closes the last
   * gap: without it the gate can only compare the plan against itself, and a
   * source object lost between reading and planning would never be missed.
   */
  expected_source_object_count?: number;
};

export function evaluateClosureGate(plan: ProjectionPlan, options: ClosureGateOptions = {}): ClosureGateResult {
  const findings: ClosureGateFinding[] = [];
  const breakdown = recomputeProjectionBreakdown(plan.outcomes, plan.records, plan.hand_review);

  findings.push(...checkArithmetic(plan, breakdown, options));
  findings.push(...checkPlanIntegrity(plan));
  findings.push(...checkNamedCategories(plan.outcomes));
  findings.push(...checkRecordAccounting(plan.outcomes, plan.records));
  findings.push(...checkMintedRecords(plan));
  // A check in its own right rather than a branch of the minted-record
  // accounting it used to hang off: one of its two findings is about records the
  // migration never minted, and a check that can report on the corpus alone does
  // not belong inside a function named for what the plan mints.
  findings.push(...checkTopicVocabulary(plan.records));
  findings.push(...checkEndpointsResolve(plan.records));
  findings.push(...checkAliasRows(plan.outcomes, plan.records));

  return {
    gate_schema: ClosureGateSchemaName,
    // Certification turns on the FAILURES, never on the finding count. A
    // tolerated finding that suppressed `ok` would be a hard failure wearing a
    // softer word, and a caller reading `findings.length` instead of this flag
    // would reintroduce exactly that.
    ok: !findings.some((item) => item.severity === "failure"),
    plan_digest: plan.plan_digest,
    breakdown,
    findings
  };
}

function checkArithmetic(
  plan: ProjectionPlan,
  breakdown: ProjectionBreakdown,
  options: ClosureGateOptions
): ClosureGateFinding[] {
  const findings: ClosureGateFinding[] = [];

  if (breakdown.projected_count + breakdown.refused_count !== plan.source_object_count) {
    findings.push(
      finding(
        "closure-arithmetic-mismatch",
        `projected ${breakdown.projected_count} + refused ${breakdown.refused_count} != source ${plan.source_object_count}`,
        []
      )
    );
  }

  if (
    options.expected_source_object_count !== undefined &&
    options.expected_source_object_count !== plan.source_object_count
  ) {
    findings.push(
      finding(
        "closure-arithmetic-mismatch",
        `plan counted ${plan.source_object_count} source objects, the reader counted ${options.expected_source_object_count}`,
        []
      )
    );
  }

  if (plan.breakdown.projected_count + plan.breakdown.refused_count !== plan.source_object_count) {
    findings.push(
      finding(
        "closure-arithmetic-mismatch",
        "the plan's own summary does not balance against its source count",
        []
      )
    );
  }

  const categoryTotal = breakdown.by_category.reduce((total, entry) => total + entry.count, 0);
  const dispositionTotal = breakdown.by_disposition.reduce((total, entry) => total + entry.count, 0);
  if (categoryTotal !== plan.source_object_count || dispositionTotal !== plan.source_object_count) {
    findings.push(
      finding(
        "closure-arithmetic-mismatch",
        `per-category total ${categoryTotal} and per-disposition total ${dispositionTotal} must both equal source ${plan.source_object_count}`,
        []
      )
    );
  }

  const refusalTotal = breakdown.refusals_by_reason.reduce((total, entry) => total + entry.count, 0);
  if (refusalTotal !== breakdown.refused_count) {
    findings.push(
      finding(
        "closure-arithmetic-mismatch",
        `refusals by reason total ${refusalTotal} != refused ${breakdown.refused_count}`,
        []
      )
    );
  }

  // A plan that misreports its own numbers is as dangerous as one that loses
  // objects, so the gate recomputes instead of trusting the plan's summary.
  if (JSON.stringify(plan.breakdown) !== JSON.stringify(breakdown)) {
    findings.push(finding("breakdown-mismatch", "plan breakdown does not match a recount of its outcomes", []));
  }

  return findings;
}

/**
 * Binds the commit to the plan that was actually reviewed. A plan file edited by
 * hand between the dry run and the apply is the realistic way a reviewed
 * migration turns into a different one, and the record shapes are re-parsed for
 * the same reason: apply must never commit a record nobody validated.
 */
function checkPlanIntegrity(plan: ProjectionPlan): ClosureGateFinding[] {
  const findings: ClosureGateFinding[] = [];

  if (projectionPlanDigest(plan) !== plan.plan_digest) {
    findings.push(finding("plan-digest-mismatch", "plan content does not match the digest it carries", []));
  }

  const malformed = plan.records
    .filter((record) => !ProjectedRecordSchema.safeParse(record).success)
    .map((record) => String((record as { idempotency_key?: string }).idempotency_key ?? "<unkeyed>"));
  if (malformed.length > 0) {
    findings.push(finding("invalid-record-shape", "a projected record does not satisfy its schema", malformed));
  }

  return findings;
}

function checkNamedCategories(outcomes: SourceOutcome[]): ClosureGateFinding[] {
  const findings: ClosureGateFinding[] = [];

  const unclassified = outcomes
    .filter(
      (outcome) =>
        outcome.category === "other" ||
        (outcome.disposition.kind === "refused" && outcome.disposition.reason === "unclassified-source-category")
    )
    .map((outcome) => outcome.legacy_object_id);
  if (unclassified.length > 0) {
    findings.push(
      finding(
        "unclassified-source-category",
        "source objects landed in a category this projector never declared a mapping for",
        unclassified
      )
    );
  }

  const unnamedRefusals = outcomes
    .filter((outcome) => outcome.disposition.kind === "refused" && outcome.disposition.reason === "other")
    .map((outcome) => outcome.legacy_object_id);
  if (unnamedRefusals.length > 0) {
    findings.push(
      finding("unnamed-refusal-reason", "refusals must carry a named reason, not the enum escape hatch", unnamedRefusals)
    );
  }

  const unnamedDispositions = outcomes
    .filter((outcome) => outcome.disposition.kind === "other")
    .map((outcome) => outcome.legacy_object_id);
  if (unnamedDispositions.length > 0) {
    findings.push(
      finding(
        "unnamed-source-disposition",
        "source objects carry the disposition escape hatch instead of a declared disposition",
        unnamedDispositions
      )
    );
  }

  return findings;
}

/**
 * Minted records are owned by the PLAN, so they are checked against the plan's
 * own claim list rather than against the outcomes. A minted record nobody claims
 * is a node that would land in the plane with no reviewable reason for existing,
 * and a claim naming no record is a list that has stopped describing the plan.
 *
 * Whether the plan holds two nodes for one word is a different question, asked
 * by `checkTopicVocabulary` over every topic-typed record whatever produced it —
 * including the ones nothing minted.
 */
function checkMintedRecords(plan: ProjectionPlan): ClosureGateFinding[] {
  const findings: ClosureGateFinding[] = [];
  const claimed = new Set(plan.minted_record_keys);
  const minted = plan.records.filter(isMintedEntityRecord);

  const unaccounted = [
    ...minted.filter((record) => !claimed.has(record.idempotency_key)).map((record) => record.idempotency_key),
    ...plan.minted_record_keys.filter((key) => !minted.some((record) => record.idempotency_key === key))
  ];
  if (unaccounted.length > 0) {
    findings.push(
      finding(
        "minted-record-not-accounted",
        "every minted record must be claimed by the plan's minted list, and every claim must name a minted record",
        unaccounted
      )
    );
  }

  return findings;
}

/**
 * ONE SLOT PER (SCHEME, WORD) — and THREE ANSWERS, because two topic nodes
 * sharing a word are three different situations and only one of them is a bug.
 *
 * Keyed on the canonical NAME rather than on `minted_basis.legacy_value`, and
 * read off every topic-typed record rather than off the minted ones alone. The
 * old check could only ever see `minted-entity` records, and two of those with
 * one value share a slot and an idempotency key — so `duplicate-idempotency-key`
 * fired first and this branch was unreachable in practice. Meanwhile the plan
 * had three other ways to produce a topic node, which are now three declared
 * SCHEMES: the corpus's own topics, the occupations derived from `job_title`,
 * and the entity kinds minted from retired subtype values.
 *
 * The key comes from `normalizeTopicValue`, the same function the projector
 * resolves a classification with. Two spellings of "the same word" computed
 * differently in the two places is the failure that produces a plan the
 * projector considers clean and the gate considers broken, or worse the reverse.
 *
 * It keys on the display NAME only, and that is a stated gap rather than an
 * oversight: two nodes where one's ALIAS equals the other's name both answer to
 * the word and are not reported here. Two concepts sharing one alias is ordinary
 * and legitimate — an alias is a label, not an identity — so a finding on it
 * would fire on healthy corpora and teach the operator to ignore the code.
 *
 * SAME SCHEME, ONE OF THEM MINTED — `duplicate-minted-topic`, a FAILURE.
 * Two nodes inside one vocabulary, at least one made by this migration. Label
 * uniqueness within a scheme is the property that makes the scheme controlled,
 * so this is a defect however it arrived, and it is unchanged by the scheme
 * split: nine organizations saying `airline` must still reach one node.
 *
 * SAME SCHEME, BOTH FROM THE CORPUS — `duplicate-source-topic`, TOLERATED.
 * The corpus itself already holds two nodes for one word. The migration is
 * faithfully carrying a data-quality problem that predates it, and the owner has
 * decided that is the right thing to do: both nodes come across, both legacy ids
 * stay resolvable through the alias ledger, and the two are merged later inside
 * Atlas through the entity-merge path, where the decision has evidence and a
 * record. Failing here would block the migration forever on a condition no
 * re-run can change, and dropping or merging one of them would be the migration
 * silently making an identity decision.
 *
 * DIFFERENT SCHEMES — `cross-scheme-topic-homonym`, TOLERATED.
 * Not a duplicate at all. A person IS an investor and a firm IS an investment
 * firm: one word, two concepts, in two vocabularies, and SKOS scopes label
 * uniqueness per scheme precisely so this is expressible. Merging them would
 * force one word onto two things — which is why ADR 0026 OPEN-14 is resolved by
 * separating the schemes rather than by merging the labels.
 *
 * It is still REPORTED, because two schemes reaching for one word may genuinely
 * be one concept a curator wants to unify later, and an unreported homonym is
 * one nobody can choose about. Reported is not the same as wrong.
 *
 * Three separate CODES, not one code with a note in the detail, so no reader has
 * to parse prose to tell a defect from a legitimate homonym — and so a
 * regression that starts minting duplicates inside a scheme cannot hide inside
 * a tolerated bucket: it arrives under a code whose severity is `failure`, and
 * no plan carrying it certifies.
 *
 * ⚠ SUBJECTS ARE SLOTS, NEVER THE WORD ITSELF.
 *
 * An earlier version reported the colliding words, reasoning that naming them
 * helps the operator curate. It does — and it also put personal graph content
 * into an artifact whose own contract is "ids, types and counts only". The first
 * real-data run proved the cost: one of the two colliding words was a private
 * topic name, and it landed in the report file, on the terminal, and in
 * anything the operator might have pasted the report into.
 *
 * Slots are opaque and resolve to the word locally, so the operator loses
 * nothing they cannot recover on the machine that already holds the graph, and
 * the report stays shareable. A finding that has to leak content to be useful is
 * a finding that needs a different subject, not an exemption. This applies to
 * the tolerated finding exactly as hard as to the failing one: a duplicate the
 * owner has accepted is still a private topic name.
 */
/**
 * WHICH MECHANISM PUT THIS TOPIC IN THE PLAN — a code constant, never content.
 *
 * The plan has three ways to produce a topic node and the remedy differs for
 * each, so a finding that reports only slots leaves the operator unable to tell
 * a reuse failure from a cross-namespace collision. That is not hypothetical: a
 * dry run reported two colliding slots, the pair was read as "the migration
 * minted a node beside one the corpus already held", and the real pair was an
 * occupation topic beside a subtype topic — neither from the corpus, and no
 * amount of resolving against it would have removed either. A round of work went
 * into looking for a bug that was not there.
 *
 * A namespace name and a record kind are facts about the software. Printing them
 * stays inside the ids-types-and-counts contract that keeps subjects as slots.
 */
function topicMechanism(record: ProjectedRecord): string {
  if (record.record_kind === "minted-entity") {
    return "minted-from-subtype";
  }
  if (record.record_kind !== "entity") {
    return "other";
  }
  return isLegacyObjectProvenance(record.provenance)
    ? CorpusTopicMechanism
    : `derived-from-${record.provenance.legacy_attribute}`;
}

/**
 * `alwaysReport` names mechanisms that are printed even at zero. A count that is
 * absent reads as "not measured"; `projected-from-corpus=0` reads as "reuse had
 * nothing to resolve onto", which is the sentence that was got wrong once.
 */
function mechanismBreakdown(mechanisms: string[], alwaysReport: string[] = []): string {
  const counts = new Map<string, number>(alwaysReport.map((mechanism) => [mechanism, 0]));
  for (const mechanism of mechanisms) {
    counts.set(mechanism, (counts.get(mechanism) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([mechanism, count]) => `${mechanism}=${count}`)
    .join(" ");
}

const CorpusTopicMechanism = "projected-from-corpus";

/** One topic node, as the vocabulary check sees it. */
type TopicNode = { slot: string; scheme: TopicScheme; mechanism: string };

/** `by scheme: … | by mechanism: …`, the two counts every topic finding carries. */
function topicBreakdown(nodes: TopicNode[], alwaysReport: string[] = []): string {
  return (
    `By scheme: ${mechanismBreakdown(nodes.map((node) => node.scheme))}` +
    ` | by mechanism: ${mechanismBreakdown(nodes.map((node) => node.mechanism), alwaysReport)}`
  );
}

function checkTopicVocabulary(records: ProjectedRecord[]): ClosureGateFinding[] {
  /** canonical word -> the topic nodes that answer to it, whatever their scheme. */
  const nodesByWord = new Map<string, TopicNode[]>();
  const unnamedScheme: string[] = [];

  for (const record of records) {
    if (record.record_kind !== "entity" && record.record_kind !== "minted-entity") {
      continue;
    }
    if (record.entity_type !== "topic" || record.topic_scheme === undefined) {
      // A topic with no scheme at all fails its own record schema, so it is
      // already reported as `invalid-record-shape`; counting it here too would
      // report one defect twice under two codes.
      continue;
    }
    if (record.topic_scheme === "other") {
      unnamedScheme.push(record.slot);
    }
    const word = normalizeTopicValue(record.name);
    const nodes = nodesByWord.get(word) ?? [];
    // Keyed by slot so one node counted twice — the same record reached through
    // two lists — cannot look like a collision.
    if (!nodes.some((node) => node.slot === record.slot)) {
      nodes.push({ slot: record.slot, scheme: record.topic_scheme, mechanism: topicMechanism(record) });
    }
    nodesByWord.set(word, nodes);
  }

  const minted: TopicNode[] = [];
  const source: TopicNode[] = [];
  const homonyms: TopicNode[] = [];

  for (const nodes of nodesByWord.values()) {
    const bySchemeEntries = new Map<TopicScheme, TopicNode[]>();
    for (const node of nodes) {
      bySchemeEntries.set(node.scheme, [...(bySchemeEntries.get(node.scheme) ?? []), node]);
    }

    // WITHIN a scheme: label uniqueness is the property that makes the scheme
    // controlled, so two nodes here are a duplicate whoever made them.
    for (const sameScheme of bySchemeEntries.values()) {
      if (sameScheme.length < 2) {
        continue;
      }
      // One migration-created node among them is enough: the duplicate exists
      // because this run created a node, whatever the other slot came from.
      const bucket = sameScheme.some((node) => node.mechanism !== CorpusTopicMechanism) ? minted : source;
      bucket.push(...sameScheme);
    }

    // ACROSS schemes: not a duplicate. Reported so a curator can decide, never
    // failed, because the schemes are what say the two are different concepts.
    if (bySchemeEntries.size > 1) {
      homonyms.push(...nodes);
    }
  }

  const findings: ClosureGateFinding[] = [];
  if (minted.length > 0) {
    findings.push(
      finding(
        "duplicate-minted-topic",
        "this migration created a second topic node inside one concept scheme for a word that scheme " +
          "already holds; label uniqueness within a scheme is what makes it controlled, and no query " +
          "rejoins the two. Subjects are the colliding slots — resolve them to their words locally. " +
          topicBreakdown(minted, [CorpusTopicMechanism]),
        minted.map((node) => node.slot)
      )
    );
  }
  if (source.length > 0) {
    findings.push(
      finding(
        "duplicate-source-topic",
        "topic nodes the corpus itself holds share a word inside one scheme; the migration is reporting " +
          "a duplicate that predates it. Carried across as they stand, every id stays resolvable " +
          "through the alias ledger, and merging them is a curation step inside Atlas. Subjects are " +
          `the colliding slots — resolve them to their words locally. ${topicBreakdown(source)}`,
        source.map((node) => node.slot)
      )
    );
  }
  if (homonyms.length > 0) {
    findings.push(
      finding(
        "cross-scheme-topic-homonym",
        "one word names concepts in more than one scheme — an occupation and an entity kind, say, " +
          "which are two things a person and a firm can each be. Not a duplicate and not a defect: " +
          "label uniqueness is scoped per scheme. Reported because two schemes reaching for one word " +
          "may still be one concept a curator wants to unify, and that is a decision with evidence " +
          `rather than a string match. Subjects are the slots — resolve them locally. ${topicBreakdown(homonyms)}`,
        homonyms.map((node) => node.slot)
      )
    );
  }
  if (unnamedScheme.length > 0) {
    findings.push(
      finding(
        "unnamed-topic-scheme",
        "a topic node carries the scheme escape hatch instead of a declared concept scheme; some " +
          "mechanism is producing topics for a vocabulary nobody has named, and its labels collide " +
          "with nothing until somebody does",
        unnamedScheme
      )
    );
  }
  return findings;
}

function checkRecordAccounting(outcomes: SourceOutcome[], records: ProjectedRecord[]): ClosureGateFinding[] {
  const findings: ClosureGateFinding[] = [];

  const seenKeys = new Set<string>();
  const duplicates: string[] = [];
  for (const record of records) {
    if (seenKeys.has(record.idempotency_key)) {
      duplicates.push(record.idempotency_key);
    }
    seenKeys.add(record.idempotency_key);
  }
  if (duplicates.length > 0) {
    findings.push(
      finding(
        "duplicate-idempotency-key",
        "two records share an idempotency key; apply would treat the second as a replay of the first",
        duplicates
      )
    );
  }

  const claimed = new Set<string>();
  const claimedTwice: string[] = [];
  const claimedMissing: string[] = [];
  for (const outcome of outcomes) {
    for (const key of outcome.record_keys) {
      if (claimed.has(key)) {
        claimedTwice.push(key);
      }
      claimed.add(key);
      if (!seenKeys.has(key)) {
        claimedMissing.push(key);
      }
    }
  }

  /**
   * A record is accounted for in exactly one of two ways, and which one is
   * readable off the record itself rather than off a list the plan asserts.
   *
   * A record PROJECTED from a legacy object must be claimed by that object's
   * outcome — that is the closure property. A node the migration MINTED has no
   * source object, so it must be claimed by NO outcome: a minted node appearing
   * in some object's record_keys would mean one arbitrary contributor had been
   * made to own a node shared by hundreds, and the shortfall would never show up
   * in the arithmetic.
   *
   * `isProjectedFromLegacyObject` answers this for both minted kinds at once —
   * the entity that has no provenance field and the derived node whose
   * provenance variant is `derived`. Minted entities remain checked, not
   * skipped: `checkMintedRecords` holds them to the plan-level claim, so they
   * are accounted for once rather than never.
   */
  const unclaimed = records
    .filter((record) => isProjectedFromLegacyObject(record))
    .map((record) => record.idempotency_key)
    .filter((key) => !claimed.has(key));
  const mintedButClaimed = records
    .filter((record) => !isProjectedFromLegacyObject(record))
    .map((record) => record.idempotency_key)
    .filter((key) => claimed.has(key));

  const accountingProblems = [...claimedTwice, ...claimedMissing, ...unclaimed, ...mintedButClaimed];
  if (accountingProblems.length > 0) {
    findings.push(
      finding(
        "record-not-accounted",
        "a projected record must be claimed by exactly one source outcome, and a minted node by none",
        accountingProblems
      )
    );
  }

  const retractionTargets = records
    .filter(isRetractionRecord)
    .filter((record) => !seenKeys.has(record.retracts_idempotency_key))
    .map((record) => record.idempotency_key);
  if (retractionTargets.length > 0) {
    findings.push(
      finding(
        "retraction-target-missing",
        "a retraction names a record this plan does not create; the deletion would apply to nothing",
        retractionTargets
      )
    );
  }

  return findings;
}

/**
 * Every relationship endpoint must resolve through the identity map that this
 * plan itself mints. The projector already refuses dangling edges, so a finding
 * here means the projector produced an edge it should have refused — which is
 * exactly the class of bug that put unreachable edges in the old store.
 */
function checkEndpointsResolve(records: ProjectedRecord[]): ClosureGateFinding[] {
  // Every slot the plan puts into the plane, imported or minted. Reading only
  // the imported ones would report every `has-type` edge as dangling, because
  // its target slot is by definition one this plan minted rather than imported.
  const mintedSlots = new Set<string>(
    records.map(slotMintedBy).filter((slot): slot is string => slot !== undefined)
  );

  const dangling = [...records.filter(isRelationshipRecord), ...records.filter(isMintedRelationshipRecord)]
    .filter((record) => !mintedSlots.has(record.source_slot) || !mintedSlots.has(record.target_slot))
    .map((record) => record.idempotency_key);

  if (dangling.length === 0) {
    return [];
  }

  return [
    finding(
      "dangling-projected-endpoint",
      "a projected relationship names an entity slot that this plan does not mint",
      dangling
    )
  ];
}

function checkAliasRows(outcomes: SourceOutcome[], records: ProjectedRecord[]): ClosureGateFinding[] {
  const findings: ClosureGateFinding[] = [];
  const recordKeys = new Set(records.map((record) => record.idempotency_key));

  const missingAliasTargets = outcomes
    .filter((outcome) => outcome.alias_target === undefined)
    .map((outcome) => outcome.legacy_object_id);
  if (missingAliasTargets.length > 0) {
    findings.push(
      finding(
        "alias-row-missing",
        "every legacy id must plan an alias row, including the ids that carried nothing across",
        missingAliasTargets
      )
    );
  }

  // A split names candidates instead of a target, and EVERY candidate has to
  // exist. A split with one reachable candidate is worse than a plain redirect:
  // it tells a caller the id is ambiguous and then hands them a list they cannot
  // fully resolve.
  const brokenTargets = outcomes
    .filter((outcome) => {
      if (outcome.alias_target.kind === "record") {
        return !recordKeys.has(outcome.alias_target.record_key);
      }
      if (outcome.alias_target.kind === "ambiguous-split") {
        return outcome.alias_target.candidates.some((candidate) => !recordKeys.has(candidate.record_key));
      }
      return false;
    })
    .map((outcome) => outcome.legacy_object_id);
  if (brokenTargets.length > 0) {
    findings.push(
      finding(
        "alias-target-missing-record",
        "an alias row points at a record this plan does not create",
        brokenTargets
      )
    );
  }

  return findings;
}
