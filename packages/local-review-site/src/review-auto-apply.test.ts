import { describe, expect, it, vi } from "vitest";
import {
  CanonicalPayloadSchema,
  canonicalObjectTypeForPayload,
  canonicalPayloadObjectId,
  type CanonicalPayload,
  type GraphObjectEnvelope
} from "@living-atlas/contracts";
import { createCanonicalMarkdownMigration } from "@living-atlas/importer";
import { localResolutionApply } from "@living-atlas/local-mcp";
import { projectLocalReviewQueue, type LocalReviewQueue, type LocalReviewQueueItem } from "./review-projection";
import { applyExactPreservation, planExactPreservation } from "./review-auto-apply";

vi.mock("@living-atlas/local-mcp", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@living-atlas/local-mcp")>()),
  localResolutionApply: vi.fn()
}));

const now = "2026-07-10T12:00:00.000Z";

function envelope(payload: CanonicalPayload, encrypted = true): GraphObjectEnvelope {
  const objectId = canonicalPayloadObjectId(payload);
  return {
    schema_version: 1,
    authority_id: "la_authority_reviewautoapply0001",
    object_id: objectId,
    object_type: canonicalObjectTypeForPayload(payload),
    version: 1,
    access_class: "local-private",
    encryption_class: encrypted ? "client-encrypted" : "plaintext",
    created_at: now,
    updated_at: now,
    content_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ...(encrypted ? { key_ref: "la_key_reviewautoapply0001" } : {}),
    visible_metadata: { tombstone: false, remote_indexable: false },
    payload: encrypted
      ? { kind: "ciphertext-inline", ciphertext: "synthetic", nonce: "synthetic", algorithm: "synthetic" }
      : { kind: "plaintext-json", data: payload }
  };
}

async function queueForMigration(encrypted = true) {
  const migration = createCanonicalMarkdownMigration([
    {
      source_path: "pages/Synthetic Exact Person.md",
      markdown: "type:: person\nphone:: +1 555 0101",
      source_kind: "logseq"
    },
    {
      source_path: "pages/Synthetic Exact Empty.md",
      markdown: "",
      source_kind: "logseq"
    }
  ], {
    authority_id: "la_authority_reviewautoapply0001",
    created_at: now,
    path_redaction_secret: "synthetic-review-auto-apply-secret"
  });
  const payloads = new Map(migration.payloads.map((payload) => [canonicalPayloadObjectId(payload), payload]));
  const objects = migration.payloads.map((payload) => envelope(payload, encrypted));
  const queue = await projectLocalReviewQueue({
    objects,
    decryptPayload: async (object) => payloads.get(object.object_id)
  });
  return { migration, objects, payloads, queue };
}

function queueWith(items: LocalReviewQueueItem[]): LocalReviewQueue {
  return { owner_review: items, research: [], deferred: [], automatic: [] };
}

function cloneCandidate(base: LocalReviewQueueItem, suffix: string, patch: Partial<LocalReviewQueueItem>): LocalReviewQueueItem {
  const reviewId = `la_object_reviewauto${suffix}0001`;
  const candidateId = `la_candidate_reviewauto${suffix}0001`;
  return {
    ...structuredClone(base),
    review_id: reviewId,
    candidate_id: candidateId,
    review_record: {
      ...structuredClone(base.review_record),
      review_id: reviewId,
      candidate_id: candidateId
    },
    ...patch
  };
}

describe("exact source preservation auto-apply", () => {
  it("plans complete encrypted rich and explicit zero-meaning candidates, keeping unsafe candidates manual", async () => {
    const { queue } = await queueForMigration();
    const items = [...queue.owner_review, ...queue.research];
    const rich = items.find((item) => item.source_accounting.meaningful_units.length > 0)!;
    const zero = items.find((item) => item.source_accounting.meaningful_units.length === 0)!;
    const fact = rich.proposed_records.find((payload) => payload.schema === "atlas.fact:v1")!;
    const refuting = cloneCandidate(rich, "refuting", {
      proposed_records: rich.proposed_records.map((payload) => payload === fact ? {
        ...fact,
        evidence_links: fact.evidence_links.map((link, index) => index === 0 ? { ...link, stance: "refutes" } : link)
      } : payload)
    });
    const edit = cloneCandidate(rich, "edit", {
      proposed_records: rich.proposed_records.map((payload) => payload === fact ? {
        ...fact,
        lineage_action: "correct",
        supersedes: ["la_object_reviewautosuperseded0001"]
      } : payload)
    });
    const existingEntity = rich.proposed_records.find((payload) => payload.schema === "atlas.entity:v1")!;
    const secondEntity = CanonicalPayloadSchema.parse({
      ...existingEntity,
      entity_id: "la_object_reviewautoidentityentity0002",
      name: "Synthetic Exact Person Alternate"
    });
    if (secondEntity.schema !== "atlas.entity:v1") throw new Error("expected synthetic identity entity");
    const identityEvidenceId = rich.evidence[0]!.evidence_id;
    const identityResolution = CanonicalPayloadSchema.parse({
      schema: "atlas.entity-resolution:v1",
      resolution_id: "la_object_reviewautoidentityresolution0001",
      actor_id: "synthetic-review-auto-apply-test",
      observed_identifiers: ["synthetic-identity-conflict"],
      decision: "merge",
      candidate_entity_ids: [existingEntity.entity_id, secondEntity.entity_id],
      canonical_entity_id: existingEntity.entity_id,
      confidence: {
        band: "low",
        assessment_kind: "identity",
        method: "synthetic-fixture",
        assessed_at: now,
        evidence_refs: [identityEvidenceId]
      },
      evidence_refs: [identityEvidenceId],
      evidence_links: [{ evidence_id: identityEvidenceId, stance: "context" }],
      supersedes: [],
      recorded_at: now
    });
    const identity = cloneCandidate(rich, "identity", {
      proposed_records: [...rich.proposed_records, secondEntity, identityResolution]
    });
    const blocked = cloneCandidate(rich, "blocked", {
      review_record: {
        ...rich.review_record,
        review_id: "la_object_reviewautoblocked0001",
        candidate_id: "la_candidate_reviewautoblocked0001",
        auto_apply_blockers: ["typed-projection-missing-edge-endpoint"]
      } as never
    });
    const incomplete = cloneCandidate(rich, "incomplete", { resolution_mode: "incomplete" });
    const plaintext = cloneCandidate(rich, "plaintext", { exact_source_encrypted: false } as never);
    const missing = cloneCandidate(rich, "missing", { missing_references: ["la_object_reviewautomissing0001"] });
    const parityGap = cloneCandidate(rich, "paritygap", { parity_records: [] });
    const unitGap = cloneCandidate(rich, "unitgap", {
      unit_mappings: rich.unit_mappings.map((mapping, index) => index === 0 ? {
        ...mapping,
        observation_ids: [],
        destination_records: []
      } : mapping)
    });

    const plan = planExactPreservation(queueWith([
      rich,
      zero,
      refuting,
      edit,
      identity,
      blocked,
      incomplete,
      plaintext,
      missing,
      parityGap,
      unitGap
    ]));

    expect(plan.auto_apply).toEqual([rich.candidate_id, zero.candidate_id].sort());
    expect(plan.manual).toEqual([
      blocked.candidate_id,
      edit.candidate_id,
      identity.candidate_id,
      incomplete.candidate_id,
      missing.candidate_id,
      parityGap.candidate_id,
      plaintext.candidate_id,
      refuting.candidate_id,
      unitGap.candidate_id
    ].sort());
    expect(plan.plan_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("requires encrypted exact-source preservation evidence", async () => {
    const { queue } = await queueForMigration(false);
    const plan = planExactPreservation(queue);

    expect(plan.auto_apply).toEqual([]);
    expect(plan.manual).toHaveLength(2);
  });

  it("commits once through localResolutionApply and reports a counts-only, text-free stable retry", async () => {
    const { queue, objects, payloads } = await queueForMigration();
    const rich = [...queue.owner_review, ...queue.research]
      .find((item) => item.source_accounting.meaningful_units.length > 0)!;
    const richOnly = queueWith([rich]);
    const plan = planExactPreservation(richOnly);
    const operations = new Map<string, {
      idempotency_key: string;
      operation_id: string;
      generation: number;
      objects: GraphObjectEnvelope[];
    }>();
    const auditEvents: unknown[] = [];
    const outboxRecords: unknown[] = [];
    const mockedResolutionApply = vi.mocked(localResolutionApply);
    mockedResolutionApply.mockReset();
    mockedResolutionApply.mockImplementation(async (_context, request) => {
      if (!operations.has(request.idempotency_key)) {
        operations.set(request.idempotency_key, {
          idempotency_key: request.idempotency_key,
          operation_id: request.operation_id,
          generation: 1,
          objects: request.objects as GraphObjectEnvelope[]
        });
        auditEvents.push({ reason_code: "resolution-committed" });
        outboxRecords.push({ operation_id: request.operation_id });
      }
      return {
        ok: true,
        result: {
          local_commit: "committed",
          audit: "recorded",
          sync_queue: "queued",
          committed_object_ids: request.objects.map((object) => (object as GraphObjectEnvelope).object_id),
          generation: 1,
          journal_sequence: 1
        }
      } as never;
    });
    const context = {
      graphStore: {
        listObjects: () => objects,
        readObject: (objectId: string) => objects.find((object) => object.object_id === objectId),
        operationRecordForIdempotency: (key: string) => operations.get(key),
        status: () => ({ generation: operations.size })
      },
      decryptPayload: async (object: GraphObjectEnvelope) => payloads.get(object.object_id),
      auditSink: { events: auditEvents },
      outboxSink: { records: outboxRecords }
    };
    const acknowledgement = { authorization: "Bearer synthetic-local-token", plan_hash: plan.plan_hash };

    const first = await applyExactPreservation(context as never, plan, acknowledgement);
    const second = await applyExactPreservation(context as never, plan, acknowledgement);

    expect(first).toMatchObject({ attempted: 1, committed: 1, idempotent: 0, failed: 0 });
    expect(second).toMatchObject({ attempted: 1, committed: 0, idempotent: 1, failed: 0 });
    expect(mockedResolutionApply).toHaveBeenCalledTimes(2);
    expect(auditEvents).toHaveLength(1);
    expect(outboxRecords).toHaveLength(1);
    const receipt = JSON.stringify(second);
    expect(receipt).not.toMatch(/source_text|excerpt|locator|path|name|url/i);
    expect(receipt).not.toContain("Synthetic Exact Person");
    expect(receipt).not.toContain("+1 555 0101");
    expect(second.outcomes).toEqual([
      expect.objectContaining({ candidate_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/), outcome: "idempotent" })
    ]);
  });

  it("rejects a wrong or forged plan hash before calling the authoritative boundary", async () => {
    const { queue } = await queueForMigration();
    const plan = planExactPreservation(queue);
    const mockedResolutionApply = vi.mocked(localResolutionApply);
    mockedResolutionApply.mockReset();
    const context = { graphStore: {}, decryptPayload: async () => undefined };

    await expect(applyExactPreservation(context as never, plan, {
      authorization: "Bearer synthetic-local-token",
      plan_hash: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
    })).rejects.toThrow("acknowledgement mismatch");
    await expect(applyExactPreservation(context as never, {
      ...plan,
      auto_apply: [...plan.auto_apply, "la_candidate_forged0001"]
    }, {
      authorization: "Bearer synthetic-local-token",
      plan_hash: plan.plan_hash
    })).rejects.toThrow("acknowledgement mismatch");
    expect(mockedResolutionApply).not.toHaveBeenCalled();
  });

  it.each([
    "review-version",
    "review-state",
    "proposal",
    "evidence-stance",
    "parity-coverage",
    "unit-coverage",
    "blocker"
  ] as const)("rejects a stale %s plan before calling localResolutionApply", async (mutation) => {
    const baseline = await queueForMigration();
    const rich = [...baseline.queue.owner_review, ...baseline.queue.research]
      .find((item) => item.source_accounting.meaningful_units.length > 0)!;
    const plan = planExactPreservation(queueWith([rich]));
    const objects = structuredClone(baseline.objects);
    const payloads = new Map([...baseline.payloads].map(([id, payload]) => [id, structuredClone(payload)]));
    const review = payloads.get(rich.review_id)!;
    if (mutation === "review-version") {
      const envelope = objects.find((object) => object.object_id === rich.review_id)!;
      envelope.version += 1;
    } else if (mutation === "review-state" && review.schema === "atlas.review-item:v1") {
      payloads.set(rich.review_id, { ...review, resolution_state: "deferred-unknown" });
    } else if (mutation === "proposal" && review.schema === "atlas.review-item:v1") {
      payloads.set(rich.review_id, { ...review, proposed_object_ids: review.proposed_object_ids.slice(1) });
    } else if (mutation === "evidence-stance") {
      const fact = [...payloads.values()].find((payload) => payload.schema === "atlas.fact:v1")!;
      if (fact.schema === "atlas.fact:v1") payloads.set(fact.assertion_id, {
        ...fact,
        evidence_links: fact.evidence_links.map((link, index) => index === 0 ? { ...link, stance: "refutes" } : link)
      });
    } else if (mutation === "parity-coverage") {
      const parity = [...payloads.values()].find((payload) => payload.schema === "atlas.parity-record:v1"
        && payload.coverage_state === "represented")!;
      if (parity.schema === "atlas.parity-record:v1") payloads.set(parity.parity_id, {
        ...parity,
        canonical_object_ids: parity.canonical_object_ids.slice(1)
      });
    } else if (mutation === "unit-coverage") {
      const observation = [...payloads.values()].find((payload) => payload.schema === "atlas.observation:v1")!;
      if (observation.schema === "atlas.observation:v1") payloads.set(observation.assertion_id, {
        ...observation,
        evidence_refs: observation.evidence_refs.filter((id) => {
          const evidence = payloads.get(id);
          return evidence?.schema !== "atlas.evidence:v1" || evidence.extraction_method !== "canonical-source-unit-v1";
        })
      });
    } else if (mutation === "blocker" && review.schema === "atlas.review-item:v1") {
      payloads.set(rich.review_id, {
        ...review,
        auto_apply_blockers: ["typed-projection-missing-edge-endpoint"]
      });
    }
    const mockedResolutionApply = vi.mocked(localResolutionApply);
    mockedResolutionApply.mockReset();
    const context = {
      graphStore: {
        listObjects: () => objects,
        readObject: (objectId: string) => objects.find((object) => object.object_id === objectId),
        operationRecordForIdempotency: () => undefined,
        status: () => ({ generation: 0 })
      },
      decryptPayload: async (object: GraphObjectEnvelope) => payloads.get(object.object_id)
    };

    await expect(applyExactPreservation(context as never, plan, {
      authorization: "Bearer synthetic-local-token",
      plan_hash: plan.plan_hash
    })).resolves.toMatchObject({
      committed: 0,
      idempotent: 0,
      failed: 1,
      outcomes: [{ outcome: "failed", reason_code: "plan-stale" }]
    });
    expect(mockedResolutionApply).not.toHaveBeenCalled();
  });

  it("projects once across candidates, continues after a failed candidate, and requires clean reconciliation", async () => {
    const { queue, objects, payloads } = await queueForMigration();
    const plan = planExactPreservation(queue);
    const mockedResolutionApply = vi.mocked(localResolutionApply);
    mockedResolutionApply.mockReset();
    let applyCalls = 0;
    mockedResolutionApply.mockImplementation(async (_context, request) => {
      applyCalls += 1;
      if (applyCalls === 1) return { ok: false, reason: "generation-conflict" } as never;
      return {
        ok: true,
        result: {
          local_commit: "committed",
          audit: "recorded",
          sync_queue: "queued",
          committed_object_ids: request.objects.map((object) => (object as GraphObjectEnvelope).object_id),
          resolved_candidate_ids: [request.candidate_id],
          generation: 1,
          journal_sequence: 1
        }
      } as never;
    });
    let listCalls = 0;
    let decryptCalls = 0;
    const context = {
      graphStore: {
        listObjects: () => { listCalls += 1; return objects; },
        readObject: (objectId: string) => objects.find((object) => object.object_id === objectId),
        operationRecordForIdempotency: () => undefined,
        status: () => ({ generation: applyCalls > 1 ? 1 : 0 })
      },
      decryptPayload: async (object: GraphObjectEnvelope) => {
        decryptCalls += 1;
        return payloads.get(object.object_id);
      }
    };

    const receipt = await applyExactPreservation(context as never, plan, {
      authorization: "Bearer synthetic-local-token",
      plan_hash: plan.plan_hash
    });

    expect(receipt).toMatchObject({ attempted: 2, committed: 1, idempotent: 0, failed: 1 });
    expect(mockedResolutionApply).toHaveBeenCalledTimes(2);
    expect(listCalls).toBe(1);
    expect(decryptCalls).toBe(objects.length);
  });

  it("does not count an authoritative retry as idempotent until reconciliation is clean", async () => {
    const { queue, objects, payloads } = await queueForMigration();
    const rich = [...queue.owner_review, ...queue.research]
      .find((item) => item.source_accounting.meaningful_units.length > 0)!;
    const plan = planExactPreservation(queueWith([rich]));
    const entry = plan.entries[0]!;
    const priorObject = objects.find((object) => object.object_id === entry.review_id)!;
    const context = {
      graphStore: {
        operationRecordForIdempotency: () => ({ generation: 1, objects: [priorObject] })
      },
      decryptPayload: async (object: GraphObjectEnvelope) => payloads.get(object.object_id)
    };
    const mockedResolutionApply = vi.mocked(localResolutionApply);
    mockedResolutionApply.mockReset();
    mockedResolutionApply.mockResolvedValue({
      ok: true,
      result: {
        local_commit: "committed",
        audit: "reconciliation-required",
        sync_queue: "queued",
        committed_object_ids: [entry.review_id],
        resolved_candidate_ids: [entry.candidate_id]
      }
    } as never);

    const receipt = await applyExactPreservation(context as never, plan, {
      authorization: "Bearer synthetic-local-token",
      plan_hash: plan.plan_hash
    });

    expect(receipt).toMatchObject({ committed: 0, idempotent: 0, failed: 1 });
    expect(receipt.outcomes[0]).toMatchObject({ outcome: "failed", reason_code: "reconciliation-required" });
    expect(mockedResolutionApply).toHaveBeenCalledTimes(1);
  });
});
