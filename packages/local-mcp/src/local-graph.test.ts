import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ControlPlaneSnapshot, GraphObjectEnvelope } from "@living-atlas/contracts";
import {
  controlPlaneFixture,
  fixtureAuthorityId,
  fixtureLocalClientId,
  fixtureRemoteClientId,
  sensitiveBaitRegistry,
  syntheticGraphObjects
} from "@living-atlas/fixtures";
import { createFixtureLocalControlState } from "@living-atlas/local-control-store";
import { FileLocalGraphStore } from "@living-atlas/local-graph-store";
import {
  createDefaultLocalKeyring,
  decryptGraphObjectPayload,
  type LocalKeyringState
} from "@living-atlas/local-keyring";
import { InMemoryLocalMcpActivitySink } from "./activity";
import {
  createLocalMcpAuditEvent,
  FileLocalMcpAuditSink,
  InMemoryLocalMcpAuditSink
} from "./audit";
import { hashLocalMcpToken, InMemoryLocalMcpCredentialStore } from "./auth";
import {
  createFixtureLocalMcpContext,
  createLocalMcpContextFromControlState,
  localCreateObject,
  localCreateEdgeObject,
  localDeleteEdgeObject,
  localGraphStatus,
  localListObjects,
  localReadObject,
  localReadEdgeObject,
  localResolutionApply,
  localResolutionApplyBatch,
  localSearchObjects,
  localTombstoneObject,
  localTimelineQuery,
  localTraverseGraph,
  localUpdateEdgeObject,
  localUpdateObject,
  type LocalGraphSyntheticStoreLimits
} from "./local-graph";
import {
  FileLocalMcpMutationOutboxSink,
  InMemoryLocalMcpMutationOutboxSink
} from "./outbox";

const now = "2026-06-21T12:00:00.000Z";

function fixedHash(seed: string): `sha256:${string}` {
  return `sha256:${seed.repeat(64).slice(0, 64)}`;
}

function syntheticRemoteSafeObject(objectId: string): GraphObjectEnvelope {
  return {
    schema_version: 1,
    authority_id: fixtureAuthorityId,
    object_id: objectId,
    object_type: "page",
    version: 1,
    access_class: "remote-safe",
    encryption_class: "plaintext",
    created_at: now,
    updated_at: now,
    content_hash: fixedHash("a"),
    visible_metadata: {
      schema_namespace: "test/synthetic-create",
      tombstone: false,
      size_class: "tiny",
      remote_indexable: true
    },
    payload: {
      kind: "plaintext-json",
      data: {
        title: "Synthetic created object",
        body: "Fixture-only local MCP mutation payload."
      }
    }
  };
}

function sensitivePlaintextDraft(objectId: string) {
  return {
    schema_version: 1,
    authority_id: fixtureAuthorityId,
    object_id: objectId,
    object_type: "page",
    version: 1,
    access_class: "local-private",
    encryption_class: "plaintext",
    created_at: now,
    updated_at: now,
    content_hash: fixedHash("d"),
    visible_metadata: {
      schema_namespace: "test/sensitive-draft",
      tombstone: false,
      size_class: "tiny",
      remote_indexable: false
    },
    payload: {
      kind: "plaintext-json",
      data: {
        title: "Sensitive redacted-mode draft",
        body: "This draft should fail before persistence."
      }
    }
  };
}

function canonicalResolutionDrafts(reviewVersion: number) {
  const entityId = "la_object_resolutionentity0001";
  const evidenceId = "la_object_resolutionevidence0001";
  const factId = "la_object_resolutionfact0001";
  const reviewId = "la_object_resolutionreview0001";
  const parityId = "la_object_resolutionparity0001";
  const candidateId = "la_candidate_resolution0001";
  const coverageKey = "la_coverage_resolution0001";

  const draft = (objectId: string, objectType: string, version: number, data: Record<string, unknown>) => ({
    schema_version: 1 as const,
    authority_id: fixtureAuthorityId,
    object_id: objectId,
    object_type: objectType,
    version,
    access_class: "local-private" as const,
    encryption_class: "plaintext" as const,
    created_at: now,
    updated_at: now,
    content_hash: fixedHash(objectId.slice(-1)),
    visible_metadata: {
      schema_namespace: "atlas/synthetic-resolution",
      tombstone: false,
      size_class: "tiny" as const,
      remote_indexable: false
    },
    payload: { kind: "plaintext-json" as const, data }
  });

  const entity = draft(entityId, "entity", 1, {
    schema: "atlas.entity:v1",
    entity_id: entityId,
    type: "organization",
    subtype: "company",
    name: "Synthetic Resolution Company",
    aliases: [],
    created_at: now,
    updated_at: now
  });
  const evidence = draft(evidenceId, "evidence", 1, {
    schema: "atlas.evidence:v1",
    evidence_id: evidenceId,
    source_kind: "migration",
    locator: "synthetic://resolution/0001",
    content_hash: fixedHash("e"),
    retrieved_at: now,
    independence_key: "synthetic-resolution-source",
    excerpt: "Synthetic evidence for one canonical assertion."
  });
  const fact = draft(factId, "assertion", 1, {
    schema: "atlas.fact:v1",
    assertion_id: factId,
    subject_entity_id: entityId,
    predicate: "name",
    value: { kind: "text", value: "Synthetic Resolution Company" },
    recorded_at: now,
    lineage_action: "assert",
    supersedes: [],
    evidence_links: [{ evidence_id: evidenceId, stance: "supports" }],
    confidence: {
      band: "high",
      assessment_kind: "assertion",
      method: "synthetic-fixture",
      assessed_at: now,
      evidence_refs: [evidenceId]
    }
  });
  const review = draft(reviewId, "review", reviewVersion, {
    schema: "atlas.review-item:v1",
    review_id: reviewId,
    candidate_id: candidateId,
    source_coverage_keys: [coverageKey],
    recommendation: "auto-apply",
    resolution_state: "resolved",
    proposed_object_ids: [entityId, evidenceId, factId],
    recorded_at: now
  });
  const parity = draft(parityId, "manifest", 1, {
    schema: "atlas.parity-record:v1",
    parity_id: parityId,
    source_coverage_key: coverageKey,
    coverage_state: "represented",
    representation_kind: "fact",
    canonical_object_ids: [factId],
    idempotency_key: "la_idem_resolution0001",
    recorded_at: now
  });

  return { entity, evidence, fact, review, parity, candidateId };
}

type ResolutionDrafts = ReturnType<typeof canonicalResolutionDrafts>;
type ResolutionDraft = ResolutionDrafts["fact"];

function withResolutionPayload(draft: ResolutionDraft, patch: Record<string, unknown>): ResolutionDraft {
  return {
    ...draft,
    payload: {
      ...draft.payload,
      data: { ...draft.payload.data, ...patch }
    }
  };
}

function copyResolutionDraftWithId(
  draft: ResolutionDraft,
  objectId: string,
  semanticIdField: "review_id" | "parity_id"
): ResolutionDraft {
  return {
    ...draft,
    object_id: objectId,
    content_hash: fixedHash(semanticIdField === "review_id" ? "c" : "d"),
    payload: {
      ...draft.payload,
      data: { ...draft.payload.data, [semanticIdField]: objectId }
    }
  };
}

function canonicalResolutionDraft(
  base: ResolutionDraft,
  objectId: string,
  objectType: "assertion" | "edge" | "review",
  data: Record<string, unknown>
): ResolutionDraft {
  return {
    ...base,
    object_id: objectId,
    object_type: objectType,
    content_hash: fixedHash("f"),
    payload: { ...base.payload, data }
  };
}

function temporalEdgeObject(objectId: string): GraphObjectEnvelope {
  return {
    schema_version: 1,
    authority_id: fixtureAuthorityId,
    object_id: objectId,
    object_type: "edge",
    version: 1,
    access_class: "local-private",
    encryption_class: "plaintext",
    created_at: now,
    updated_at: now,
    content_hash: fixedHash("f"),
    visible_metadata: {
      schema_namespace: "test/encrypted-temporal-edge",
      tombstone: false,
      size_class: "tiny",
      remote_indexable: false
    },
    payload: {
      kind: "plaintext-json",
      data: {
        edge_id: "la_edge_encryptedquery0001",
        source_object_id: "la_object_sourceendpoint0001",
        source_type: "person",
        target_object_id: "la_object_targetendpoint0001",
        target_type: "project",
        predicate: "advises",
        valid_from: "2026-06",
        status: "active",
        confidence: "high",
        source: "synthetic encrypted local MCP query fixture"
      }
    }
  };
}

function decryptWithKeyring(keyring: LocalKeyringState) {
  return async (object: GraphObjectEnvelope) => decryptGraphObjectPayload(object, keyring);
}

function readonlyControlPlane(): ControlPlaneSnapshot {
  const localFullCapability = controlPlaneFixture.capabilities.find(
    (capability) => capability.capability_id === "la_cap_localfull0001"
  )!;
  const readonlyCapability: ControlPlaneSnapshot["capabilities"][number] = {
    ...localFullCapability,
    capability_id: "la_cap_localreadonly0001",
    profile: "local-readonly",
    operations: ["read", "search", "traverse", "decrypt", "audit-read"]
  };

  return {
    ...controlPlaneFixture,
    clients: controlPlaneFixture.clients.map((client) =>
      client.client_id === fixtureLocalClientId
        ? {
            ...client,
            allowed_profile: "local-readonly"
          }
        : client
    ),
    capabilities: [
      ...controlPlaneFixture.capabilities.filter((capability) => capability.capability_id !== "la_cap_localfull0001"),
      readonlyCapability
    ]
  };
}

function remoteSafeCrudControlPlane(): ControlPlaneSnapshot {
  const localClient = controlPlaneFixture.clients.find((client) => client.client_id === fixtureLocalClientId)!;
  const localFullCapability = controlPlaneFixture.capabilities.find(
    (capability) => capability.capability_id === "la_cap_localfull0001"
  )!;
  const crudCapability: ControlPlaneSnapshot["capabilities"][number] = {
    ...localFullCapability,
    capability_id: "la_cap_localcrud0001",
    profile: "local-crud",
    operations: ["read", "update", "audit-read"],
    access_classes: ["remote-safe"]
  };

  return {
	    ...controlPlaneFixture,
	    clients: [
	      ...controlPlaneFixture.clients.filter((client) => client.client_id !== fixtureLocalClientId),
	      {
	        ...localClient,
	        allowed_profile: "local-crud"
	      }
	    ],
	    capabilities: [
	      ...controlPlaneFixture.capabilities.filter((capability) => capability.capability_id !== "la_cap_localfull0001"),
	      crudCapability
	    ]
	  };
	}

async function createContextForToken(token: string, options?: {
  remoteSafe?: boolean;
  readonly?: boolean;
  syntheticStoreLimits?: Partial<LocalGraphSyntheticStoreLimits>;
}) {
  const auditSink = new InMemoryLocalMcpAuditSink();
  const activitySink = new InMemoryLocalMcpActivitySink();
  const credentialStore = new InMemoryLocalMcpCredentialStore([
    {
      credential_id: options?.remoteSafe
        ? "la_local_credential_remote0001"
        : options?.readonly
          ? "la_local_credential_readonly0001"
          : "la_local_credential_local0001",
      client_id: options?.remoteSafe ? fixtureRemoteClientId : fixtureLocalClientId,
      capability_id: options?.remoteSafe
        ? "la_cap_remotesafe0001"
        : options?.readonly
          ? "la_cap_localreadonly0001"
          : "la_cap_localfull0001",
      token_hash: await hashLocalMcpToken(token),
      created_at: now
    }
  ]);

  return {
    context: Object.assign(
      createFixtureLocalMcpContext({
        credentialStore,
        auditSink,
        activitySink,
        now,
        syntheticStoreLimits: options?.syntheticStoreLimits
      }),
      options?.readonly ? { controlPlane: readonlyControlPlane() } : {}
    ),
    auditSink,
    activitySink
  };
}

describe("local fixture graph tools", () => {
  it("rejects an invalid bulk resolution without committing an earlier valid decision", async () => {
    const token = "local-token-resolution-batch-atomic-0001";
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-local-resolution-batch-"));
    try {
      const controlState = await createFixtureLocalControlState(token);
      const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
      const graphStore = await FileLocalGraphStore.open({ directory, authorityId: controlState.authority_id, plaintextPersistence: "encrypt", keyring });
      const drafts = canonicalResolutionDrafts(1);
      await graphStore.createObject({ object: { ...drafts.review, payload: { ...drafts.review.payload, data: { ...drafts.review.payload.data, resolution_state: "pending" } }, version: 1 }, expected_generation: 0, actor_id: fixtureLocalClientId, recorded_at: now });
      const context = createLocalMcpContextFromControlState({ controlState, graphStore, decryptPayload: decryptWithKeyring(keyring), now });

      await expect(localResolutionApplyBatch(context, {
        authorization: `Bearer ${token}`,
        operation_id: "la_operation_resolutionbatch0001",
        idempotency_key: "la_idem_resolutionbatch0001",
        expected_generation: 1,
        resolutions: [
          { candidate_id: drafts.candidateId, expected_review_version: 1, objects: [drafts.entity, drafts.evidence, drafts.fact, drafts.review, drafts.parity] },
          { candidate_id: "la_candidate_resolutionbad0001", expected_review_version: 1, objects: [] }
        ]
      })).resolves.toEqual({ ok: false, reason: "resolution-invalid-request" });

      expect(graphStore.status()).toMatchObject({ generation: 1, object_count: 1 });
      expect(graphStore.readObject(drafts.fact.object_id)).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("requires durable local storage for semantic resolution", async () => {
    const token = "local-token-resolution-no-store-0001";
    const context = createFixtureLocalMcpContext({
      credentialStore: new InMemoryLocalMcpCredentialStore([
        {
          credential_id: "la_local_credential_resolution0001",
          client_id: fixtureLocalClientId,
          capability_id: "la_cap_localfull0001",
          token_hash: await hashLocalMcpToken(token),
          created_at: now
        }
      ]),
      now
    });

    await expect(localResolutionApply(context, {
      authorization: `Bearer ${token}`,
      operation_id: "la_operation_resolution0001",
      idempotency_key: "la_idem_resolution0001",
      candidate_id: "la_candidate_resolution0001",
      expected_generation: 0,
      expected_review_version: 1,
      objects: []
    })).resolves.toEqual({ ok: false, reason: "resolution-requires-durable-local-store" });
  });

  it("commits a complete resolution once and labels its review update in the local outbox", async () => {
    const token = "local-token-resolution-atomic-0001";
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-local-resolution-"));
    try {
      const controlState = await createFixtureLocalControlState(token);
      const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
      const graphStore = await FileLocalGraphStore.open({
        directory,
        authorityId: controlState.authority_id,
        plaintextPersistence: "encrypt",
        keyring
      });
      const drafts = canonicalResolutionDrafts(2);
      await expect(graphStore.createObject({
        object: { ...drafts.review, version: 1, payload: { ...drafts.review.payload, data: {
          ...drafts.review.payload.data,
          resolution_state: "pending"
        } } },
        expected_generation: 0,
        actor_id: fixtureLocalClientId,
        recorded_at: now
      })).resolves.toMatchObject({ ok: true, generation: 1 });

      const auditSink = new InMemoryLocalMcpAuditSink();
      const outboxSink = new InMemoryLocalMcpMutationOutboxSink();
      const context = createLocalMcpContextFromControlState({
        controlState,
        graphStore,
        decryptPayload: decryptWithKeyring(keyring),
        auditSink,
        outboxSink,
        now
      });

      const request = {
        authorization: `Bearer ${token}`,
        operation_id: "la_operation_resolution0001",
        idempotency_key: "la_idem_resolution0001",
        candidate_id: drafts.candidateId,
        expected_generation: 1,
        expected_review_version: 1,
        objects: [drafts.entity, drafts.evidence, drafts.fact, drafts.review, drafts.parity]
      };

      await expect(localResolutionApply(context, request)).resolves.toMatchObject({
        ok: true,
        result: {
          local_commit: "committed",
          audit: "recorded",
          sync_queue: "queued",
          committed_object_ids: expect.arrayContaining([
            drafts.entity.object_id,
            drafts.evidence.object_id,
            drafts.fact.object_id,
            drafts.review.object_id,
            drafts.parity.object_id
          ]),
          generation: 2,
          journal_sequence: 2
        }
      });

      await expect(localResolutionApply(context, request)).resolves.toMatchObject({
        ok: true,
        result: {
          local_commit: "committed",
          audit: "recorded",
          sync_queue: "queued",
          generation: 2,
          journal_sequence: 2
        }
      });

      expect(graphStore.status()).toMatchObject({ generation: 2, object_count: 5 });
      expect(outboxSink.records.map((record) => record.mutation)).toEqual([
        "created", "created", "created", "updated", "created"
      ]);
      expect(outboxSink.records.map((record) => record.generation)).toEqual([2, 2, 2, 2, 2]);
      expect(outboxSink.records.every((record) => record.object.payload.kind === "ciphertext-inline")).toBe(true);
      expect(outboxSink.records).toEqual(expect.arrayContaining([
        expect.objectContaining({
          operation_id: request.operation_id,
          idempotency_key: request.idempotency_key,
          change_id: expect.stringMatching(/^la_change_/)
        })
      ]));
      const resolutionEvents = auditSink.events.filter((event) => (
        event.tool_name === "resolution_apply" && event.reason_code === "resolution-committed"
      ));
      expect(resolutionEvents).toEqual([expect.objectContaining({
        event_type: "tool.allowed",
        tool_name: "resolution_apply",
        reason_code: "resolution-committed",
        operation_id: request.operation_id,
        idempotency_key: request.idempotency_key
      })]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a resolution without represented parity before writing any canonical object", async () => {
    const token = "local-token-resolution-parity-0001";
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-local-resolution-parity-"));
    try {
      const controlState = await createFixtureLocalControlState(token);
      const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
      const graphStore = await FileLocalGraphStore.open({
        directory,
        authorityId: controlState.authority_id,
        plaintextPersistence: "encrypt",
        keyring
      });
      const drafts = canonicalResolutionDrafts(1);
      const context = createLocalMcpContextFromControlState({ controlState, graphStore, now });

      await expect(localResolutionApply(context, {
        authorization: `Bearer ${token}`,
        operation_id: "la_operation_resolutionparity0001",
        idempotency_key: "la_idem_resolutionparity0001",
        candidate_id: drafts.candidateId,
        expected_generation: 0,
        expected_review_version: 1,
        objects: [drafts.entity, drafts.evidence, drafts.fact, drafts.review]
      })).resolves.toEqual({ ok: false, reason: "resolution-parity-mismatch" });

      expect(graphStore.status()).toMatchObject({ generation: 0, object_count: 0 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("accepts represented parity backed by an existing active canonical object omitted from the drafts", async () => {
    const token = "local-token-resolution-existing-parity-0001";
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-local-resolution-existing-parity-"));
    try {
      const controlState = await createFixtureLocalControlState(token);
      const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
      const graphStore = await FileLocalGraphStore.open({
        directory,
        authorityId: controlState.authority_id,
        plaintextPersistence: "encrypt",
        keyring
      });
      const drafts = canonicalResolutionDrafts(2);
      const observationId = "la_object_resolutionobservation0001";
      const observation = {
        ...drafts.fact,
        object_id: observationId,
        payload: {
          ...drafts.fact.payload,
          data: {
            schema: "atlas.observation:v1",
            assertion_id: observationId,
            statement: "Existing synthetic observation.",
            candidate_entity_ids: [],
            resolution_state: "owner-review",
            recorded_at: now,
            evidence_refs: [drafts.evidence.object_id]
          }
        }
      };
      const resolvedReview = {
        ...drafts.review,
        payload: {
          ...drafts.review.payload,
          data: { ...drafts.review.payload.data, proposed_object_ids: [observationId] }
        }
      };
      const pendingReview = {
        ...resolvedReview,
        version: 1,
        payload: {
          ...resolvedReview.payload,
          data: { ...resolvedReview.payload.data, resolution_state: "pending" }
        }
      };
      const parity = {
        ...drafts.parity,
        payload: {
          ...drafts.parity.payload,
          data: {
            ...drafts.parity.payload.data,
            representation_kind: "observation",
            canonical_object_ids: [observationId]
          }
        }
      };
      await expect(graphStore.initializeFromObjects([drafts.evidence, observation, pendingReview] as never)).resolves.toMatchObject({ ok: true });
      const context = createLocalMcpContextFromControlState({
        controlState,
        graphStore,
        decryptPayload: decryptWithKeyring(keyring),
        now
      });

      await expect(localResolutionApply(context, {
        authorization: `Bearer ${token}`,
        operation_id: "la_operation_resolutionexistingparity0001",
        idempotency_key: "la_idem_resolutionexistingparity0001",
        candidate_id: drafts.candidateId,
        expected_generation: 0,
        expected_review_version: 1,
        objects: [resolvedReview, parity]
      })).resolves.toMatchObject({
        ok: true,
        result: {
          local_commit: "committed",
          committed_object_ids: [resolvedReview.object_id, parity.object_id]
        }
      });
      expect(graphStore.readObject(observationId)).toMatchObject({ version: 1, updated_at: now });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["missing", "tombstoned"] as const)("rejects represented parity backed by a %s existing object", async (mode) => {
    const token = `local-token-resolution-${mode}-parity-0001`;
    const directory = await mkdtemp(join(tmpdir(), `living-atlas-local-resolution-${mode}-parity-`));
    try {
      const controlState = await createFixtureLocalControlState(token);
      const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
      const graphStore = await FileLocalGraphStore.open({
        directory,
        authorityId: controlState.authority_id,
        plaintextPersistence: "encrypt",
        keyring
      });
      const drafts = canonicalResolutionDrafts(2);
      const pendingReview = {
        ...drafts.review,
        version: 1,
        payload: {
          ...drafts.review.payload,
          data: { ...drafts.review.payload.data, resolution_state: "pending" }
        }
      };
      const existingObjects = mode === "tombstoned"
        ? [
            drafts.entity,
            drafts.evidence,
            { ...drafts.fact, visible_metadata: { ...drafts.fact.visible_metadata, tombstone: true } },
            pendingReview
          ]
        : [drafts.entity, drafts.evidence, pendingReview];
      await expect(graphStore.initializeFromObjects(existingObjects as never)).resolves.toMatchObject({ ok: true });
      const context = createLocalMcpContextFromControlState({
        controlState,
        graphStore,
        decryptPayload: decryptWithKeyring(keyring),
        now
      });

      await expect(localResolutionApply(context, {
        authorization: `Bearer ${token}`,
        operation_id: `la_operation_resolution${mode}parity0001`,
        idempotency_key: `la_idem_resolution${mode}parity0001`,
        candidate_id: drafts.candidateId,
        expected_generation: 0,
        expected_review_version: 1,
        objects: [drafts.review, drafts.parity]
      })).resolves.toEqual({ ok: false, reason: "resolution-parity-mismatch" });
      expect(graphStore.status()).toMatchObject({ generation: 0 });
      expect(graphStore.readObject(drafts.parity.object_id)).toBeUndefined();
      expect(graphStore.readObject(drafts.review.object_id)).toMatchObject({ version: 1 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    {
      label: "duplicate review coverage keys",
      expectedReason: "resolution-review-mismatch",
      objects: (drafts: ResolutionDrafts) => [
        drafts.entity,
        drafts.evidence,
        drafts.fact,
        withResolutionPayload(drafts.review, {
          source_coverage_keys: ["la_coverage_resolution0001", "la_coverage_resolution0001"]
        }),
        drafts.parity
      ]
    },
    {
      label: "multiple reviews for the requested candidate",
      expectedReason: "resolution-review-mismatch",
      objects: (drafts: ResolutionDrafts) => [
        drafts.entity,
        drafts.evidence,
        drafts.fact,
        drafts.review,
        copyResolutionDraftWithId(drafts.review, "la_object_resolutionreview0002", "review_id"),
        drafts.parity
      ]
    },
    {
      label: "a review for another candidate",
      expectedReason: "resolution-review-mismatch",
      objects: (drafts: ResolutionDrafts) => [
        drafts.entity,
        drafts.evidence,
        drafts.fact,
        drafts.review,
        withResolutionPayload(
          copyResolutionDraftWithId(drafts.review, "la_object_resolutionreview0003", "review_id"),
          { candidate_id: "la_candidate_resolution0002" }
        ),
        drafts.parity
      ]
    },
    {
      label: "duplicate parity coverage records",
      expectedReason: "resolution-parity-mismatch",
      objects: (drafts: ResolutionDrafts) => [
        drafts.entity,
        drafts.evidence,
        drafts.fact,
        drafts.review,
        drafts.parity,
        copyResolutionDraftWithId(drafts.parity, "la_object_resolutionparity0002", "parity_id")
      ]
    },
    {
      label: "review and parity coverage-set mismatch",
      expectedReason: "resolution-parity-mismatch",
      objects: (drafts: ResolutionDrafts) => [
        drafts.entity,
        drafts.evidence,
        drafts.fact,
        withResolutionPayload(drafts.review, {
          source_coverage_keys: ["la_coverage_resolutionother0001"]
        }),
        drafts.parity
      ]
    },
    {
      label: "an extra parity coverage key",
      expectedReason: "resolution-parity-mismatch",
      objects: (drafts: ResolutionDrafts) => [
        drafts.entity,
        drafts.evidence,
        drafts.fact,
        drafts.review,
        drafts.parity,
        withResolutionPayload(
          copyResolutionDraftWithId(drafts.parity, "la_object_resolutionparity0003", "parity_id"),
          { source_coverage_key: "la_coverage_resolutionextra0001" }
        )
      ]
    }
  ])("rejects $label before committing", async ({ expectedReason, objects }) => {
    const token = `local-token-${expectedReason}-0001`;
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-local-resolution-coverage-"));
    try {
      const controlState = await createFixtureLocalControlState(token);
      const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
      const graphStore = await FileLocalGraphStore.open({
        directory,
        authorityId: controlState.authority_id,
        plaintextPersistence: "encrypt",
        keyring
      });
      const drafts = canonicalResolutionDrafts(1);
      const context = createLocalMcpContextFromControlState({ controlState, graphStore, now });

      await expect(localResolutionApply(context, {
        authorization: `Bearer ${token}`,
        operation_id: "la_operation_resolutioncoverage0001",
        idempotency_key: "la_idem_resolutioncoverage0001",
        candidate_id: drafts.candidateId,
        expected_generation: 0,
        expected_review_version: 1,
        objects: objects(drafts)
      })).resolves.toEqual({ ok: false, reason: expectedReason });

      expect(graphStore.status()).toMatchObject({ generation: 0, object_count: 0 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    {
      label: "a missing entity reference",
      build: (drafts: ResolutionDrafts) => ({
        objects: [
          drafts.entity,
          drafts.evidence,
          withResolutionPayload(drafts.fact, { subject_entity_id: "la_object_missingentity0001" }),
          drafts.review,
          drafts.parity
        ]
      })
    },
    {
      label: "an entity reference to the wrong object type",
      build: (drafts: ResolutionDrafts) => ({
        objects: [
          drafts.entity,
          drafts.evidence,
          withResolutionPayload(drafts.fact, { subject_entity_id: drafts.evidence.object_id }),
          drafts.review,
          drafts.parity
        ]
      })
    },
    {
      label: "a missing evidence link",
      build: (drafts: ResolutionDrafts) => ({
        objects: [
          drafts.entity,
          drafts.evidence,
          withResolutionPayload(drafts.fact, {
            evidence_links: [{ evidence_id: "la_object_missingevidence0001", stance: "supports" }]
          }),
          drafts.review,
          drafts.parity
        ]
      })
    },
    {
      label: "an evidence link to the wrong object type",
      build: (drafts: ResolutionDrafts) => ({
        objects: [
          drafts.entity,
          drafts.evidence,
          withResolutionPayload(drafts.fact, {
            evidence_links: [{ evidence_id: drafts.entity.object_id, stance: "supports" }]
          }),
          drafts.review,
          drafts.parity
        ]
      })
    },
    {
      label: "a missing confidence evidence reference",
      build: (drafts: ResolutionDrafts) => ({
        objects: [
          drafts.entity,
          drafts.evidence,
          withResolutionPayload(drafts.fact, {
            confidence: {
              band: "high",
              assessment_kind: "assertion",
              method: "synthetic-fixture",
              assessed_at: now,
              evidence_refs: ["la_object_missingconfidence0001"]
            }
          }),
          drafts.review,
          drafts.parity
        ]
      })
    },
    {
      label: "a confidence evidence reference to the wrong object type",
      build: (drafts: ResolutionDrafts) => ({
        objects: [
          drafts.entity,
          drafts.evidence,
          withResolutionPayload(drafts.fact, {
            confidence: {
              band: "high",
              assessment_kind: "assertion",
              method: "synthetic-fixture",
              assessed_at: now,
              evidence_refs: [drafts.entity.object_id]
            }
          }),
          drafts.review,
          drafts.parity
        ]
      })
    },
    {
      label: "a missing fact lineage predecessor",
      build: (drafts: ResolutionDrafts) => ({
        objects: [
          drafts.entity,
          drafts.evidence,
          withResolutionPayload(drafts.fact, {
            lineage_action: "correct",
            supersedes: ["la_object_missingassertion0001"]
          }),
          drafts.review,
          drafts.parity
        ]
      })
    },
    {
      label: "a fact lineage predecessor of the wrong object type",
      build: (drafts: ResolutionDrafts) => ({
        objects: [
          drafts.entity,
          drafts.evidence,
          withResolutionPayload(drafts.fact, {
            lineage_action: "correct",
            supersedes: [drafts.entity.object_id]
          }),
          drafts.review,
          drafts.parity
        ]
      })
    },
    {
      label: "a tombstoned referenced object",
      build: (drafts: ResolutionDrafts) => ({
        existing: [{
          ...drafts.entity,
          visible_metadata: { ...drafts.entity.visible_metadata, tombstone: true }
        } as unknown as GraphObjectEnvelope],
        objects: [drafts.evidence, drafts.fact, drafts.review, drafts.parity]
      })
    },
    {
      label: "a missing proposed object",
      build: (drafts: ResolutionDrafts) => ({
        objects: [
          drafts.entity,
          drafts.evidence,
          drafts.fact,
          withResolutionPayload(drafts.review, {
            proposed_object_ids: [
              drafts.entity.object_id,
              drafts.evidence.object_id,
              drafts.fact.object_id,
              "la_object_missingproposed0001"
            ]
          }),
          drafts.parity
        ]
      })
    },
    {
      label: "a proposed object that is not canonical",
      build: (drafts: ResolutionDrafts) => {
        const page = syntheticRemoteSafeObject("la_object_resolutionpage0001");
        return {
          existing: [page],
          objects: [
            drafts.entity,
            drafts.evidence,
            drafts.fact,
            withResolutionPayload(drafts.review, {
              proposed_object_ids: [
                drafts.entity.object_id,
                drafts.evidence.object_id,
                drafts.fact.object_id,
                page.object_id
              ]
            }),
            drafts.parity
          ]
        };
      }
    },
    {
      label: "a missing parity object",
      expectedReason: "resolution-parity-mismatch",
      build: (drafts: ResolutionDrafts) => ({
        objects: [
          drafts.entity,
          drafts.evidence,
          drafts.fact,
          withResolutionPayload(drafts.review, {
            proposed_object_ids: [
              drafts.entity.object_id,
              drafts.evidence.object_id,
              drafts.fact.object_id,
              "la_object_missingparitytarget0001"
            ]
          }),
          withResolutionPayload(drafts.parity, {
            canonical_object_ids: ["la_object_missingparitytarget0001"]
          })
        ]
      })
    },
    {
      label: "a parity object that is not canonical",
      expectedReason: "resolution-parity-mismatch",
      build: (drafts: ResolutionDrafts) => {
        const page = syntheticRemoteSafeObject("la_object_resolutionpage0002");
        return {
          existing: [page],
          objects: [
            drafts.entity,
            drafts.evidence,
            drafts.fact,
            withResolutionPayload(drafts.review, {
              proposed_object_ids: [
                drafts.entity.object_id,
                drafts.evidence.object_id,
                drafts.fact.object_id,
                page.object_id
              ]
            }),
            withResolutionPayload(drafts.parity, { canonical_object_ids: [page.object_id] })
          ]
        };
      }
    },
    {
      label: "a parity object omitted from the review proposal",
      expectedReason: "resolution-parity-mismatch",
      build: (drafts: ResolutionDrafts) => ({
        objects: [
          drafts.entity,
          drafts.evidence,
          drafts.fact,
          withResolutionPayload(drafts.review, {
            proposed_object_ids: [drafts.entity.object_id, drafts.evidence.object_id]
          }),
          drafts.parity
        ]
      })
    }
  ])("rejects $label before committing", async ({ build, expectedReason }) => {
    const token = "local-token-resolution-reference-0001";
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-local-resolution-reference-"));
    try {
      const controlState = await createFixtureLocalControlState(token);
      const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
      const graphStore = await FileLocalGraphStore.open({
        directory,
        authorityId: controlState.authority_id,
        plaintextPersistence: "encrypt",
        keyring
      });
      const drafts = canonicalResolutionDrafts(1);
      const scenario = build(drafts) as { objects: unknown[]; existing?: GraphObjectEnvelope[] };
      if (scenario.existing) {
        await expect(graphStore.initializeFromObjects(scenario.existing)).resolves.toMatchObject({ ok: true });
      }
      const context = createLocalMcpContextFromControlState({
        controlState,
        graphStore,
        decryptPayload: decryptWithKeyring(keyring),
        now
      });

      await expect(localResolutionApply(context, {
        authorization: `Bearer ${token}`,
        operation_id: "la_operation_resolutionreference0001",
        idempotency_key: "la_idem_resolutionreference0001",
        candidate_id: drafts.candidateId,
        expected_generation: 0,
        expected_review_version: 1,
        objects: scenario.objects
      })).resolves.toEqual({ ok: false, reason: expectedReason ?? "resolution-missing-reference" });

      expect(graphStore.status()).toMatchObject({ generation: 0 });
      expect(graphStore.readObject(drafts.parity.object_id)).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    {
      label: "an observation candidate with the wrong object type",
      build: (drafts: ResolutionDrafts) => {
        const observationId = "la_object_resolutionobservation0002";
        const observation = canonicalResolutionDraft(drafts.fact, observationId, "assertion", {
          schema: "atlas.observation:v1",
          assertion_id: observationId,
          statement: "Synthetic unresolved observation.",
          candidate_entity_ids: [drafts.evidence.object_id],
          resolution_state: "owner-review",
          recorded_at: now,
          evidence_refs: [drafts.evidence.object_id]
        });
        return [
          drafts.entity,
          drafts.evidence,
          observation,
          withResolutionPayload(drafts.review, {
            proposed_object_ids: [drafts.entity.object_id, drafts.evidence.object_id, observationId]
          }),
          withResolutionPayload(drafts.parity, {
            representation_kind: "observation",
            canonical_object_ids: [observationId]
          })
        ];
      }
    },
    {
      label: "an observation predecessor with the wrong object type",
      build: (drafts: ResolutionDrafts) => {
        const observationId = "la_object_resolutionobservation0003";
        const observation = canonicalResolutionDraft(drafts.fact, observationId, "assertion", {
          schema: "atlas.observation:v1",
          assertion_id: observationId,
          statement: "Synthetic corrected observation.",
          candidate_entity_ids: [drafts.entity.object_id],
          resolution_state: "owner-review",
          recorded_at: now,
          evidence_refs: [drafts.evidence.object_id],
          supersedes: [drafts.entity.object_id]
        });
        return [
          drafts.entity,
          drafts.evidence,
          observation,
          withResolutionPayload(drafts.review, {
            proposed_object_ids: [drafts.entity.object_id, drafts.evidence.object_id, observationId]
          }),
          withResolutionPayload(drafts.parity, {
            representation_kind: "observation",
            canonical_object_ids: [observationId]
          })
        ];
      }
    },
    {
      label: "a relationship endpoint with the wrong object type",
      build: (drafts: ResolutionDrafts) => {
        const relationshipId = "la_object_resolutionrelationship0001";
        const relationship = canonicalResolutionDraft(drafts.fact, relationshipId, "edge", {
          schema: "atlas.relationship:v2",
          assertion_id: relationshipId,
          edge_id: "la_edge_resolutionrelationship0001",
          source_entity_id: drafts.evidence.object_id,
          source_type: "organization",
          target_entity_id: drafts.entity.object_id,
          target_type: "organization",
          predicate: "customer-of",
          valid_from: "2026",
          recorded_at: now,
          lineage_action: "assert",
          supersedes: [],
          evidence_links: [{ evidence_id: drafts.evidence.object_id, stance: "supports" }],
          confidence: {
            band: "high",
            assessment_kind: "assertion",
            method: "synthetic-fixture",
            assessed_at: now,
            evidence_refs: [drafts.evidence.object_id]
          },
          attrs: {}
        });
        return [
          drafts.entity,
          drafts.evidence,
          relationship,
          withResolutionPayload(drafts.review, {
            proposed_object_ids: [drafts.entity.object_id, drafts.evidence.object_id, relationshipId]
          }),
          withResolutionPayload(drafts.parity, {
            representation_kind: "relationship",
            canonical_object_ids: [relationshipId]
          })
        ];
      }
    },
    {
      label: "a relationship predecessor with the wrong object type",
      build: (drafts: ResolutionDrafts) => {
        const relationshipId = "la_object_resolutionrelationship0002";
        const relationship = canonicalResolutionDraft(drafts.fact, relationshipId, "edge", {
          schema: "atlas.relationship:v2",
          assertion_id: relationshipId,
          edge_id: "la_edge_resolutionrelationship0002",
          source_entity_id: drafts.entity.object_id,
          source_type: "organization",
          target_entity_id: drafts.entity.object_id,
          target_type: "organization",
          predicate: "customer-of",
          valid_from: "2026",
          recorded_at: now,
          lineage_action: "correct",
          supersedes: [drafts.entity.object_id],
          evidence_links: [{ evidence_id: drafts.evidence.object_id, stance: "supports" }],
          confidence: {
            band: "high",
            assessment_kind: "assertion",
            method: "synthetic-fixture",
            assessed_at: now,
            evidence_refs: [drafts.evidence.object_id]
          },
          attrs: {}
        });
        return [
          drafts.entity,
          drafts.evidence,
          relationship,
          withResolutionPayload(drafts.review, {
            proposed_object_ids: [drafts.entity.object_id, drafts.evidence.object_id, relationshipId]
          }),
          withResolutionPayload(drafts.parity, {
            representation_kind: "relationship",
            canonical_object_ids: [relationshipId]
          })
        ];
      }
    },
    {
      label: "an entity-resolution candidate with the wrong object type",
      build: (drafts: ResolutionDrafts) => {
        const resolutionId = "la_object_resolutiondecision0001";
        const resolution = canonicalResolutionDraft(drafts.fact, resolutionId, "review", {
          schema: "atlas.entity-resolution:v1",
          resolution_id: resolutionId,
          actor_id: fixtureLocalClientId,
          observed_identifiers: ["synthetic-identifier"],
          candidate_entity_ids: [drafts.evidence.object_id],
          decision: "link",
          canonical_entity_id: drafts.evidence.object_id,
          evidence_refs: [drafts.evidence.object_id],
          evidence_links: [{ evidence_id: drafts.evidence.object_id, stance: "supports" }],
          confidence: {
            band: "high",
            assessment_kind: "identity",
            method: "synthetic-fixture",
            assessed_at: now,
            evidence_refs: [drafts.evidence.object_id]
          },
          recorded_at: now,
          supersedes: []
        });
        return [
          drafts.entity,
          drafts.evidence,
          drafts.fact,
          resolution,
          withResolutionPayload(drafts.review, {
            proposed_object_ids: [
              drafts.entity.object_id,
              drafts.evidence.object_id,
              drafts.fact.object_id,
              resolutionId
            ]
          }),
          drafts.parity
        ];
      }
    },
    {
      label: "an entity-resolution predecessor with the wrong object type",
      build: (drafts: ResolutionDrafts) => {
        const resolutionId = "la_object_resolutiondecision0002";
        const resolution = canonicalResolutionDraft(drafts.fact, resolutionId, "review", {
          schema: "atlas.entity-resolution:v1",
          resolution_id: resolutionId,
          actor_id: fixtureLocalClientId,
          observed_identifiers: ["synthetic-identifier"],
          candidate_entity_ids: [drafts.entity.object_id],
          decision: "split",
          evidence_refs: [drafts.evidence.object_id],
          evidence_links: [{ evidence_id: drafts.evidence.object_id, stance: "supports" }],
          confidence: {
            band: "high",
            assessment_kind: "identity",
            method: "synthetic-fixture",
            assessed_at: now,
            evidence_refs: [drafts.evidence.object_id]
          },
          recorded_at: now,
          supersedes: [drafts.entity.object_id]
        });
        return [
          drafts.entity,
          drafts.evidence,
          drafts.fact,
          resolution,
          withResolutionPayload(drafts.review, {
            proposed_object_ids: [
              drafts.entity.object_id,
              drafts.evidence.object_id,
              drafts.fact.object_id,
              resolutionId
            ]
          }),
          drafts.parity
        ];
      }
    }
  ])("rejects $label before committing", async ({ build }) => {
    const token = "local-token-resolution-reference-types-0001";
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-local-resolution-reference-types-"));
    try {
      const controlState = await createFixtureLocalControlState(token);
      const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
      const graphStore = await FileLocalGraphStore.open({
        directory,
        authorityId: controlState.authority_id,
        plaintextPersistence: "encrypt",
        keyring
      });
      const drafts = canonicalResolutionDrafts(1);
      const context = createLocalMcpContextFromControlState({ controlState, graphStore, now });

      await expect(localResolutionApply(context, {
        authorization: `Bearer ${token}`,
        operation_id: "la_operation_resolutionreferencetypes0001",
        idempotency_key: "la_idem_resolutionreferencetypes0001",
        candidate_id: drafts.candidateId,
        expected_generation: 0,
        expected_review_version: 1,
        objects: build(drafts)
      })).resolves.toEqual({ ok: false, reason: "resolution-missing-reference" });

      expect(graphStore.status()).toMatchObject({ generation: 0, object_count: 0 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a pending review as an unresolved semantic resolution", async () => {
    const token = "local-token-resolution-pending-0001";
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-local-resolution-pending-"));
    try {
      const controlState = await createFixtureLocalControlState(token);
      const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
      const graphStore = await FileLocalGraphStore.open({
        directory,
        authorityId: controlState.authority_id,
        plaintextPersistence: "encrypt",
        keyring
      });
      const drafts = canonicalResolutionDrafts(1);
      const pendingReview = {
        ...drafts.review,
        payload: {
          ...drafts.review.payload,
          data: { ...drafts.review.payload.data, resolution_state: "pending" }
        }
      };
      const context = createLocalMcpContextFromControlState({ controlState, graphStore, now });

      await expect(localResolutionApply(context, {
        authorization: `Bearer ${token}`,
        operation_id: "la_operation_resolutionpending0001",
        idempotency_key: "la_idem_resolutionpending0001",
        candidate_id: drafts.candidateId,
        expected_generation: 0,
        expected_review_version: 1,
        objects: [drafts.entity, drafts.evidence, drafts.fact, pendingReview, drafts.parity]
      })).resolves.toEqual({ ok: false, reason: "resolution-review-not-resolved" });

      expect(graphStore.status()).toMatchObject({ generation: 0, object_count: 0 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports an outbox failure for reconciliation after the local resolution commit", async () => {
    const token = "local-token-resolution-outbox-0001";
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-local-resolution-outbox-"));
    try {
      const controlState = await createFixtureLocalControlState(token);
      const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
      const graphStore = await FileLocalGraphStore.open({
        directory,
        authorityId: controlState.authority_id,
        plaintextPersistence: "encrypt",
        keyring
      });
      const drafts = canonicalResolutionDrafts(1);
      const auditSink = new InMemoryLocalMcpAuditSink();
      const outboxSink = new InMemoryLocalMcpMutationOutboxSink();
      const enqueue = outboxSink.enqueue.bind(outboxSink);
      let failAfterSecondRecord = true;
      outboxSink.enqueue = async (record) => {
        await enqueue(record);
        if (failAfterSecondRecord && outboxSink.records.length === 2) {
          failAfterSecondRecord = false;
          throw new Error("synthetic outbox outage");
        }
      };
      const context = createLocalMcpContextFromControlState({
        controlState,
        graphStore,
        auditSink,
        outboxSink,
        now
      });

      const request = {
        authorization: `Bearer ${token}`,
        operation_id: "la_operation_resolutionoutbox0001",
        idempotency_key: "la_idem_resolutionoutbox0001",
        candidate_id: drafts.candidateId,
        expected_generation: 0,
        expected_review_version: 1,
        objects: [drafts.entity, drafts.evidence, drafts.fact, drafts.review, drafts.parity]
      };

      await expect(localResolutionApply(context, request)).resolves.toMatchObject({
        ok: true,
        result: {
          local_commit: "committed",
          audit: "recorded",
          sync_queue: "reconciliation-required"
        }
      });
      expect(outboxSink.records).toHaveLength(2);

      await expect(localResolutionApply(context, request)).resolves.toMatchObject({
        ok: true,
        result: {
          local_commit: "committed",
          audit: "recorded",
          sync_queue: "queued",
          generation: 1,
          journal_sequence: 1
        }
      });

      expect(graphStore.status()).toMatchObject({ generation: 1, object_count: 5 });
      expect(outboxSink.records).toHaveLength(5);
      expect(new Set(outboxSink.records.map((record) => record.object.object_id)).size).toBe(5);
      expect(auditSink.events.filter((event) => (
        event.tool_name === "resolution_apply" && event.reason_code === "resolution-committed"
      ))).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reconciles a failed resolution audit without duplicating queued objects", async () => {
    const token = "local-token-resolution-audit-reconcile-0001";
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-local-resolution-audit-reconcile-"));
    try {
      const controlState = await createFixtureLocalControlState(token);
      const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
      const graphStore = await FileLocalGraphStore.open({
        directory,
        authorityId: controlState.authority_id,
        plaintextPersistence: "encrypt",
        keyring
      });
      const drafts = canonicalResolutionDrafts(1);
      const recordedAudit = new InMemoryLocalMcpAuditSink();
      let failResolutionAudit = true;
      const auditSink = {
        record(event: Parameters<InMemoryLocalMcpAuditSink["record"]>[0]) {
          if (failResolutionAudit && event.tool_name === "resolution_apply") {
            failResolutionAudit = false;
            throw new Error("synthetic audit outage");
          }
          recordedAudit.record(event);
        }
      };
      const outboxSink = new InMemoryLocalMcpMutationOutboxSink();
      const context = createLocalMcpContextFromControlState({
        controlState,
        graphStore,
        auditSink,
        outboxSink,
        now
      });
      const request = {
        authorization: `Bearer ${token}`,
        operation_id: "la_operation_resolutionaudit0001",
        idempotency_key: "la_idem_resolutionaudit0001",
        candidate_id: drafts.candidateId,
        expected_generation: 0,
        expected_review_version: 1,
        objects: [drafts.entity, drafts.evidence, drafts.fact, drafts.review, drafts.parity]
      };

      await expect(localResolutionApply(context, request)).resolves.toMatchObject({
        ok: true,
        result: {
          local_commit: "committed",
          audit: "reconciliation-required",
          sync_queue: "queued",
          generation: 1,
          journal_sequence: 1
        }
      });
      expect(outboxSink.records).toHaveLength(5);

      await expect(localResolutionApply(context, request)).resolves.toMatchObject({
        ok: true,
        result: {
          local_commit: "committed",
          audit: "recorded",
          sync_queue: "queued",
          generation: 1,
          journal_sequence: 1
        }
      });

      expect(graphStore.status()).toMatchObject({ generation: 1, object_count: 5 });
      expect(outboxSink.records).toHaveLength(5);
      expect(recordedAudit.events.filter((event) => (
        event.tool_name === "resolution_apply" && event.reason_code === "resolution-committed"
      ))).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("runs local create policy for every resolution member before its atomic commit", async () => {
    const token = "local-token-resolution-readonly-0001";
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-local-resolution-readonly-"));
    try {
      const controlState = await createFixtureLocalControlState(token);
      controlState.control_plane = readonlyControlPlane();
      controlState.local_credentials[0]!.capability_id = "la_cap_localreadonly0001";
      const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
      const graphStore = await FileLocalGraphStore.open({
        directory,
        authorityId: controlState.authority_id,
        plaintextPersistence: "encrypt",
        keyring
      });
      const drafts = canonicalResolutionDrafts(1);
      const context = createLocalMcpContextFromControlState({ controlState, graphStore, now });

      await expect(localResolutionApply(context, {
        authorization: `Bearer ${token}`,
        operation_id: "la_operation_resolutionreadonly0001",
        idempotency_key: "la_idem_resolutionreadonly0001",
        candidate_id: drafts.candidateId,
        expected_generation: 0,
        expected_review_version: 1,
        objects: [drafts.entity, drafts.evidence, drafts.fact, drafts.review, drafts.parity]
      })).resolves.toEqual({ ok: false, reason: "capability-operation-denied" });

      expect(graphStore.status()).toMatchObject({ generation: 0, object_count: 0 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a canonical payload whose semantic identifier differs from its envelope identifier", async () => {
    const token = "local-token-resolution-object-id-0001";
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-local-resolution-object-id-"));
    try {
      const controlState = await createFixtureLocalControlState(token);
      const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
      const graphStore = await FileLocalGraphStore.open({
        directory,
        authorityId: controlState.authority_id,
        plaintextPersistence: "encrypt",
        keyring
      });
      const drafts = canonicalResolutionDrafts(1);
      const mismatchedReview = { ...drafts.review, object_id: "la_object_mismatchedreview0001" };
      const context = createLocalMcpContextFromControlState({ controlState, graphStore, now });

      await expect(localResolutionApply(context, {
        authorization: `Bearer ${token}`,
        operation_id: "la_operation_resolutionobjectid0001",
        idempotency_key: "la_idem_resolutionobjectid0001",
        candidate_id: drafts.candidateId,
        expected_generation: 0,
        expected_review_version: 1,
        objects: [drafts.entity, drafts.evidence, drafts.fact, mismatchedReview, drafts.parity]
      })).resolves.toEqual({ ok: false, reason: "resolution-object-id-mismatch" });

      expect(graphStore.status()).toMatchObject({ generation: 0, object_count: 0 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns local status for an authenticated local client", async () => {
    const token = "local-token-graph-status-0001";
    const { context } = await createContextForToken(token);
    const result = await localGraphStatus(context, { authorization: `Bearer ${token}` });

    expect(result).toEqual({
      ok: true,
      result: expect.objectContaining({
        authority_id: "la_authority_fixture0001",
        object_count: 6,
        profile: "local-full"
      })
    });
  });

  it("rejects local graph status for revoked capabilities", async () => {
    const token = "local-token-graph-status-revoked-0001";
    const { context } = await createContextForToken(token);
    context.controlPlane = {
      ...context.controlPlane,
      capabilities: context.controlPlane.capabilities.map((capability) =>
        capability.capability_id === "la_cap_localfull0001"
          ? {
              ...capability,
              revoked_at: "2026-06-21T11:59:00.000Z"
            }
          : capability
      )
    };

    await expect(localGraphStatus(context, { authorization: `Bearer ${token}` })).resolves.toEqual({
      ok: false,
      reason: "capability-revoked"
    });
  });

  it("allows a local-full client to list local-private envelopes", async () => {
    const token = "local-token-graph-list-0001";
    const { context } = await createContextForToken(token);
    const result = await localListObjects(context, { authorization: `Bearer ${token}` });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.objects.map((object) => object.object_id)).toContain("la_object_privatepage0001");
      expect(result.result.objects.find((object) => object.object_id === "la_object_privatepage0001")).toMatchObject({
        access_class: "local-private",
        payload: expect.objectContaining({ kind: "ciphertext-ref" })
      });
    }
  });

  it("denies remote-safe credentials before local graph policy runs", async () => {
    const token = "local-token-graph-remote-0001";
    const { context } = await createContextForToken(token, { remoteSafe: true });

    await expect(localReadObject(context, {
      authorization: `Bearer ${token}`,
      object_id: "la_object_privatepage0001"
    })).resolves.toEqual({
      ok: false,
      reason: "non-local-profile"
    });
  });

  it("audits reads without emitting synthetic sensitive bait strings", async () => {
    const token = "local-token-graph-audit-0001";
    const { context, auditSink } = await createContextForToken(token);

    await localReadObject(context, {
      authorization: `Bearer ${token}`,
      object_id: "la_object_privatepage0001"
    });

    const serializedAudit = JSON.stringify(auditSink.events);
    expect(auditSink.events).toContainEqual(expect.objectContaining({
      event_type: "tool.allowed",
      object_id: "la_object_privatepage0001",
      access_class: "local-private",
      redaction: "local-redacted"
    }));

    for (const bait of sensitiveBaitRegistry) {
      expect(serializedAudit).not.toContain(bait.value);
    }
  });

  it("emits redacted live activity for local graph reads", async () => {
    const token = "local-token-graph-activity-0001";
    const { context, activitySink } = await createContextForToken(token);

    await localReadObject(context, {
      authorization: `Bearer ${token}`,
      object_id: "la_object_privatepage0001"
    });

    expect(activitySink.events).toContainEqual(expect.objectContaining({
      crud: "read",
      policy_decision: "allow",
      graph_touch: expect.objectContaining({
        objects: ["la_object_privatepage0001"]
      }),
      visibility: {
        mode: "metadata",
        contains_sensitive: true,
        redacted: true
      }
    }));
    const serializedActivity = JSON.stringify(activitySink.events);
    for (const bait of sensitiveBaitRegistry) {
      expect(serializedActivity).not.toContain(bait.value);
    }
  });

  it("creates a synthetic in-memory graph object for a local mutation-capable client", async () => {
    const token = "local-token-graph-create-0001";
    const { context, auditSink, activitySink } = await createContextForToken(token);
    const object = syntheticRemoteSafeObject("la_object_created0001");

    const result = await localCreateObject(context, {
      authorization: `Bearer ${token}`,
      object
    });

    expect(result).toEqual({
      ok: true,
      result: expect.objectContaining({
        mutation: "created",
        persistence: "synthetic-in-memory",
        object_count: 7,
        new_version: 1,
        object: expect.objectContaining({
          object_id: "la_object_created0001",
          plaintext_available: true
        })
      })
    });

    await expect(localReadObject(context, {
      authorization: `Bearer ${token}`,
      object_id: "la_object_created0001"
    })).resolves.toEqual({
      ok: true,
      result: expect.objectContaining({
        object: expect.objectContaining({
          object_id: "la_object_created0001",
          version: 1
        })
      })
    });

    expect(auditSink.events).toContainEqual(expect.objectContaining({
      event_type: "tool.allowed",
      operation: "create",
      tool_name: "object_create",
      object_id: "la_object_created0001",
      redaction: "local-redacted"
    }));
    expect(activitySink.events).toContainEqual(expect.objectContaining({
      crud: "create",
      policy_decision: "allow",
      graph_touch: expect.objectContaining({
        objects: ["la_object_created0001"]
      }),
      visibility: expect.objectContaining({
        redacted: true
      })
    }));

    const serializedAudit = JSON.stringify(auditSink.events);
    const serializedActivity = JSON.stringify(activitySink.events);
    for (const bait of sensitiveBaitRegistry) {
      expect(serializedAudit).not.toContain(bait.value);
      expect(serializedActivity).not.toContain(bait.value);
    }
  });

  it("supports local edge CRUD, search, traversal, and timeline through the same graph contract", async () => {
    const token = "local-token-graph-edge-parity-0001";
    const { context, auditSink } = await createContextForToken(token);
    const edge = {
      edge_id: "la_edge_localparity0001",
      source_object_id: "la_object_remotesafe0001",
      source_type: "person",
      target_object_id: "la_object_shareable0001",
      target_type: "project",
      predicate: "advises",
      valid_from: "2026-06",
      status: "active",
      confidence: "high",
      source: "synthetic local MCP parity test",
      attrs: {
        scope: "local parity traversal"
      }
    };

    await expect(localCreateEdgeObject(context, {
      authorization: `Bearer ${token}`,
      authority_id: fixtureAuthorityId,
      edge
    })).resolves.toEqual({
      ok: true,
      result: expect.objectContaining({
        mutation: "created",
        object: expect.objectContaining({
          object_type: "edge",
          version: 1
        })
      })
    });

    await expect(localSearchObjects(context, {
      authorization: `Bearer ${token}`,
      authority_id: fixtureAuthorityId,
      query: "parity traversal"
    })).resolves.toEqual({
      ok: true,
      result: expect.objectContaining({
        search_mode: "deterministic-text-v1",
        results: expect.arrayContaining([
          expect.objectContaining({
            object: expect.objectContaining({ object_type: "edge" })
          })
        ])
      })
    });

    await expect(localTraverseGraph(context, {
      authorization: `Bearer ${token}`,
      authority_id: fixtureAuthorityId,
      start_object_id: "la_object_remotesafe0001",
      direction: "outbound",
      predicates: ["advisor-to"]
    })).resolves.toEqual({
      ok: true,
      result: expect.objectContaining({
        visited_object_ids: expect.arrayContaining(["la_object_remotesafe0001", "la_object_shareable0001"]),
        edges: expect.arrayContaining([
          expect.objectContaining({ object_type: "edge" })
        ])
      })
    });

    await expect(localTimelineQuery(context, {
      authorization: `Bearer ${token}`,
      authority_id: fixtureAuthorityId,
      from: "2026-06",
      to: "2026-06-30",
      predicate: "advises"
    })).resolves.toEqual({
      ok: true,
      result: expect.objectContaining({
        results: expect.arrayContaining([
          expect.objectContaining({
            field: "edge.valid_from",
            timeline_at: "2026-06"
          })
        ])
      })
    });

    await expect(localUpdateEdgeObject(context, {
      authorization: `Bearer ${token}`,
      authority_id: fixtureAuthorityId,
      edge_id: "la_edge_localparity0001",
      expected_version: 1,
      patch: {
        status: "ended",
        valid_to: "2026-06-22"
      }
    })).resolves.toEqual({
      ok: true,
      result: expect.objectContaining({
        mutation: "updated",
        new_version: 2
      })
    });

    await expect(localReadEdgeObject(context, {
      authorization: `Bearer ${token}`,
      authority_id: fixtureAuthorityId,
      edge_id: "la_edge_localparity0001"
    })).resolves.toEqual({
      ok: true,
      result: expect.objectContaining({
        object: expect.objectContaining({
          version: 2,
          payload: expect.objectContaining({
            data: expect.objectContaining({ status: "ended" })
          })
        })
      })
    });

    await expect(localDeleteEdgeObject(context, {
      authorization: `Bearer ${token}`,
      authority_id: fixtureAuthorityId,
      edge_id: "la_edge_localparity0001",
      expected_version: 2
    })).resolves.toEqual({
      ok: true,
      result: expect.objectContaining({
        mutation: "tombstoned",
        new_version: 3
      })
    });

    await expect(localReadEdgeObject(context, {
      authorization: `Bearer ${token}`,
      authority_id: fixtureAuthorityId,
      edge_id: "la_edge_localparity0001"
    })).resolves.toEqual({
      ok: false,
      reason: "edge-not-found"
    });

    expect(auditSink.events).toContainEqual(expect.objectContaining({
      event_type: "tool.allowed",
      operation: "create",
      tool_name: "edge_create"
    }));
    expect(auditSink.events).toContainEqual(expect.objectContaining({
      event_type: "tool.allowed",
      operation: "update",
      tool_name: "edge_update"
    }));
    expect(auditSink.events).toContainEqual(expect.objectContaining({
      event_type: "tool.allowed",
      operation: "delete",
      tool_name: "edge_delete"
    }));
  });

  it("updates a synthetic in-memory graph object with an optimistic version guard", async () => {
    const token = "local-token-graph-update-0001";
    const { context, auditSink, activitySink } = await createContextForToken(token);

    const result = await localUpdateObject(context, {
      authorization: `Bearer ${token}`,
      object_id: "la_object_remotesafe0001",
      expected_version: 1,
      patch: {
        content_hash: fixedHash("b"),
        visible_metadata: {
          size_class: "medium"
        },
        payload: {
          kind: "plaintext-json",
          data: {
            title: "Living Atlas public fixture revised",
            body: "Synthetic update produced by local MCP tests."
          }
        }
      }
    });

    expect(result).toEqual({
      ok: true,
      result: expect.objectContaining({
        mutation: "updated",
        persistence: "synthetic-in-memory",
        previous_version: 1,
        new_version: 2,
        object: expect.objectContaining({
          object_id: "la_object_remotesafe0001",
          version: 2,
          visible_metadata: expect.objectContaining({
            size_class: "medium"
          })
        })
      })
    });

    await expect(localUpdateObject(context, {
      authorization: `Bearer ${token}`,
      object_id: "la_object_remotesafe0001",
      expected_version: 1,
      patch: {
        visible_metadata: {
          size_class: "large"
        }
      }
    })).resolves.toEqual({
      ok: false,
      reason: "version-conflict"
    });

    expect(auditSink.events).toContainEqual(expect.objectContaining({
      event_type: "tool.allowed",
      operation: "update",
      tool_name: "object_update",
      object_id: "la_object_remotesafe0001"
    }));
    expect(activitySink.events).toContainEqual(expect.objectContaining({
      crud: "update",
      policy_decision: "allow",
      graph_touch: expect.objectContaining({
        objects: ["la_object_remotesafe0001"]
      })
    }));
  });

  it("denies updates that try to launder a pre-patch local-private object into an allowed access class", async () => {
    const token = "local-token-graph-update-launder-0001";
    const auditSink = new InMemoryLocalMcpAuditSink();
    const activitySink = new InMemoryLocalMcpActivitySink();
    const credentialStore = new InMemoryLocalMcpCredentialStore([
      {
        credential_id: "la_local_credential_crud0001",
        client_id: fixtureLocalClientId,
        capability_id: "la_cap_localcrud0001",
        token_hash: await hashLocalMcpToken(token),
        created_at: now
      }
    ]);
    const context = createFixtureLocalMcpContext({
      credentialStore,
      auditSink,
      activitySink,
      now
    });
    context.controlPlane = remoteSafeCrudControlPlane();

    await expect(localUpdateObject(context, {
      authorization: `Bearer ${token}`,
      object_id: "la_object_privatepage0001",
      expected_version: 1,
      patch: {
        access_class: "remote-safe",
        encryption_class: "plaintext",
        content_hash: fixedHash("c"),
        payload: {
          kind: "plaintext-json",
          data: {
            title: "Attempted access-class laundering",
            body: "This should not be accepted."
          }
        },
        visible_metadata: {
          remote_indexable: true
        }
      }
    })).resolves.toEqual({
      ok: false,
      reason: "capability-access-class-denied"
    });

    expect(context.graphObjects.find((object) => object.object_id === "la_object_privatepage0001")).toEqual(
      expect.objectContaining({
        access_class: "local-private",
        version: 1
      })
    );
    expect(auditSink.events).toContainEqual(expect.objectContaining({
      event_type: "tool.denied",
      operation: "update",
      tool_name: "object_update",
      object_id: "la_object_privatepage0001",
      access_class: "local-private",
      reason_code: "capability-access-class-denied"
    }));
  });

  it("tombstones a synthetic in-memory graph object without hard-deleting it", async () => {
    const token = "local-token-graph-tombstone-0001";
    const { context, auditSink, activitySink } = await createContextForToken(token);

    const result = await localTombstoneObject(context, {
      authorization: `Bearer ${token}`,
      object_id: "la_object_privatepage0001",
      expected_version: 1
    });

    expect(result).toEqual({
      ok: true,
      result: expect.objectContaining({
        mutation: "tombstoned",
        persistence: "synthetic-in-memory",
        previous_version: 1,
        new_version: 2,
        object: expect.objectContaining({
          object_id: "la_object_privatepage0001",
          version: 2,
          visible_metadata: expect.objectContaining({
            tombstone: true
          })
        })
      })
    });
    expect(context.graphObjects.find((object) => object.object_id === "la_object_privatepage0001")).toEqual(
      expect.objectContaining({
        visible_metadata: expect.objectContaining({
          tombstone: true
        })
      })
    );
    expect(context.graphObjects).toHaveLength(6);
    expect(auditSink.events).toContainEqual(expect.objectContaining({
      event_type: "tool.allowed",
      operation: "delete",
      tool_name: "object_delete",
      object_id: "la_object_privatepage0001",
      redaction: "local-redacted"
    }));
    expect(activitySink.events).toContainEqual(expect.objectContaining({
      crud: "delete",
      policy_decision: "allow",
      visibility: {
        mode: "metadata",
        contains_sensitive: true,
        redacted: true
      }
    }));

    const serializedAudit = JSON.stringify(auditSink.events);
    const serializedActivity = JSON.stringify(activitySink.events);
    for (const bait of sensitiveBaitRegistry) {
      expect(serializedAudit).not.toContain(bait.value);
      expect(serializedActivity).not.toContain(bait.value);
    }
  });

  it("denies local-readonly mutation attempts through the existing policy path", async () => {
    const token = "local-token-graph-readonly-0001";
    const { context, auditSink } = await createContextForToken(token, { readonly: true });

    await expect(localCreateObject(context, {
      authorization: `Bearer ${token}`,
      object: syntheticRemoteSafeObject("la_object_readonlycreate0001")
    })).resolves.toEqual({
      ok: false,
      reason: "capability-operation-denied"
    });
    await expect(localUpdateObject(context, {
      authorization: `Bearer ${token}`,
      object_id: "la_object_remotesafe0001",
      patch: {
        visible_metadata: {
          size_class: "medium"
        }
      }
    })).resolves.toEqual({
      ok: false,
      reason: "capability-operation-denied"
    });
    await expect(localTombstoneObject(context, {
      authorization: `Bearer ${token}`,
      object_id: "la_object_remotesafe0001"
    })).resolves.toEqual({
      ok: false,
      reason: "capability-operation-denied"
    });

    expect(context.graphObjects).toHaveLength(6);
    expect(auditSink.events).toContainEqual(expect.objectContaining({
      event_type: "tool.denied",
      operation: "create",
      tool_name: "object_create",
      reason_code: "capability-operation-denied"
    }));
    expect(auditSink.events).toContainEqual(expect.objectContaining({
      event_type: "tool.denied",
      operation: "update",
      tool_name: "object_update",
      reason_code: "capability-operation-denied"
    }));
    expect(auditSink.events).toContainEqual(expect.objectContaining({
      event_type: "tool.denied",
      operation: "delete",
      tool_name: "object_delete",
      reason_code: "capability-operation-denied"
    }));
  });

  it("bounds the synthetic in-memory object count", async () => {
    const token = "local-token-graph-bounded-0001";
    const { context, auditSink } = await createContextForToken(token, {
      syntheticStoreLimits: {
        maxObjects: 6
      }
    });

    await expect(localCreateObject(context, {
      authorization: `Bearer ${token}`,
      object: syntheticRemoteSafeObject("la_object_storefull0001")
    })).resolves.toEqual({
      ok: false,
      reason: "synthetic-store-full"
    });

    expect(context.graphObjects).toHaveLength(6);
    expect(auditSink.events).toContainEqual(expect.objectContaining({
      event_type: "tool.denied",
      operation: "create",
      tool_name: "object_create",
      reason_code: "synthetic-store-full"
    }));
  });

  it("records denied activity when policy passes but durable persistence rejects", async () => {
    const token = "local-token-graph-rejected-persist-0001";
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-local-mcp-reject-"));
    try {
      const controlState = await createFixtureLocalControlState(token);
      const graphStore = await FileLocalGraphStore.open({
        directory,
        authorityId: controlState.authority_id,
        plaintextPersistence: "redact"
      });
      const auditSink = new InMemoryLocalMcpAuditSink();
      const activitySink = new InMemoryLocalMcpActivitySink();
      const outboxSink = new InMemoryLocalMcpMutationOutboxSink();
      const context = createLocalMcpContextFromControlState({
        controlState,
        graphStore,
        auditSink,
        activitySink,
        outboxSink,
        now
      });

      await expect(localCreateObject(context, {
        authorization: `Bearer ${token}`,
        object: sensitivePlaintextDraft("la_object_rejectedpersist0001")
      })).resolves.toEqual({
        ok: false,
        reason: "invalid-object"
      });

      expect(auditSink.events).toContainEqual(expect.objectContaining({
        event_type: "tool.denied",
        operation: "create",
        tool_name: "object_create",
        object_id: "la_object_rejectedpersist0001",
        access_class: "local-private",
        reason_code: "invalid-object"
      }));
      expect(activitySink.events).toContainEqual(expect.objectContaining({
        crud: "create",
        policy_decision: "deny",
        graph_touch: expect.objectContaining({
          objects: ["la_object_rejectedpersist0001"]
        }),
        visibility: {
          mode: "metadata",
          contains_sensitive: true,
          redacted: true
        }
      }));

      const serializedAudit = JSON.stringify(auditSink.events);
      const serializedActivity = JSON.stringify(activitySink.events);
      expect(serializedAudit).not.toContain("Sensitive redacted-mode draft");
      expect(serializedActivity).not.toContain("Sensitive redacted-mode draft");
      expect(outboxSink.records).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not fall back to fixture objects when the durable replica is empty", async () => {
    const token = "local-token-graph-authoritative-store-0001";
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-local-mcp-authoritative-"));
    try {
      const controlState = await createFixtureLocalControlState(token);
      const graphStore = await FileLocalGraphStore.open({
        directory,
        authorityId: controlState.authority_id,
        plaintextPersistence: "redact"
      });
      const context = createLocalMcpContextFromControlState({ controlState, graphStore, now });

      await expect(localReadObject(context, {
        authorization: `Bearer ${token}`,
        object_id: "la_object_privatepage0001"
      })).resolves.toEqual({ ok: false, reason: "object-missing" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("persists local MCP CRUD through the durable local graph store with redacted plaintext", async () => {
    const token = "local-token-graph-durable-0001";
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-local-mcp-"));
    try {
      const controlState = await createFixtureLocalControlState(token);
      const graphStore = await FileLocalGraphStore.open({
        directory,
        authorityId: controlState.authority_id,
        plaintextPersistence: "redact"
      });
      const initialized = await graphStore.initializeFromObjects(syntheticGraphObjects, {
        created_at: now
      });
      expect(initialized.ok).toBe(true);

      const context = createLocalMcpContextFromControlState({
        controlState,
        graphStore,
        now
      });
      const result = await localCreateObject(context, {
        authorization: `Bearer ${token}`,
        object: syntheticRemoteSafeObject("la_object_durable0001")
      });

      expect(result).toEqual({
        ok: true,
        result: expect.objectContaining({
          mutation: "created",
          persistence: "snapshot+journal",
          generation: 1,
          journal_sequence: 1,
          object_count: 7
        })
      });

      const reopened = await FileLocalGraphStore.open({
        directory,
        authorityId: controlState.authority_id,
        plaintextPersistence: "redact"
      });
      expect(reopened.readObject("la_object_durable0001")).toEqual(expect.objectContaining({
        object_id: "la_object_durable0001",
        version: 1,
        payload: expect.objectContaining({
          kind: "ciphertext-inline"
        })
      }));

      const persisted = [
        await readFile(join(directory, "snapshot.json"), "utf8"),
        await readFile(join(directory, "journal.jsonl"), "utf8")
      ].join("\n");
      expect(persisted).not.toContain("Synthetic created object");
      expect(persisted).not.toContain("Fixture-only local MCP mutation payload.");
      for (const bait of sensitiveBaitRegistry) {
        expect(persisted).not.toContain(bait.value);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses the authenticated local keyring to query encrypted imported graph content", async () => {
    const token = "local-token-graph-encrypted-query-0001";
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-local-mcp-encrypted-query-"));
    try {
      const controlState = await createFixtureLocalControlState(token);
      const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
      const graphStore = await FileLocalGraphStore.open({
        directory,
        authorityId: controlState.authority_id,
        plaintextPersistence: "encrypt",
        keyring
      });
      await graphStore.createObject({
        object: temporalEdgeObject("la_object_encryptedquery0001"),
        expected_generation: 0,
        actor_id: fixtureLocalClientId,
        recorded_at: now
      });
      const context = createLocalMcpContextFromControlState({
        controlState,
        graphStore,
        decryptPayload: decryptWithKeyring(keyring),
        now
      });

      await expect(localReadObject(context, {
        authorization: `Bearer ${token}`,
        object_id: "la_object_encryptedquery0001"
      })).resolves.toEqual(expect.objectContaining({
        ok: true,
        result: expect.objectContaining({
          object: expect.objectContaining({ payload: expect.objectContaining({ kind: "plaintext-json" }) })
        })
      }));
      await expect(localSearchObjects(context, {
        authorization: `Bearer ${token}`,
        query: "encrypted local MCP query"
      })).resolves.toEqual(expect.objectContaining({
        ok: true,
        result: expect.objectContaining({ results: [expect.anything()] })
      }));
      await expect(localTraverseGraph(context, {
        authorization: `Bearer ${token}`,
        start_object_id: "la_object_sourceendpoint0001"
      })).resolves.toEqual(expect.objectContaining({
        ok: true,
        result: expect.objectContaining({ visited_object_ids: expect.arrayContaining(["la_object_targetendpoint0001"]) })
      }));
      await expect(localTimelineQuery(context, {
        authorization: `Bearer ${token}`,
        predicate: "advises"
      })).resolves.toEqual(expect.objectContaining({
        ok: true,
        result: expect.objectContaining({ results: expect.arrayContaining([expect.objectContaining({ field: "edge.valid_from" })]) })
      }));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects opaque ciphertext patches that cannot be re-encrypted with updated authenticated metadata", async () => {
    const token = "local-token-graph-opaque-patch-0001";
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-local-mcp-opaque-patch-"));
    try {
      const controlState = await createFixtureLocalControlState(token);
      const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
      const graphStore = await FileLocalGraphStore.open({
        directory,
        authorityId: controlState.authority_id,
        plaintextPersistence: "encrypt",
        keyring
      });
      await graphStore.createObject({
        object: temporalEdgeObject("la_object_opaquepatch0001"),
        expected_generation: 0,
        actor_id: fixtureLocalClientId,
        recorded_at: now
      });
      const encrypted = graphStore.readObject("la_object_opaquepatch0001")!;
      const context = createLocalMcpContextFromControlState({
        controlState,
        graphStore,
        decryptPayload: decryptWithKeyring(keyring),
        now
      });

      await expect(localUpdateObject(context, {
        authorization: `Bearer ${token}`,
        object_id: encrypted.object_id,
        expected_version: 1,
        patch: { payload: encrypted.payload, visible_metadata: { size_class: "small" } }
      })).resolves.toEqual({ ok: false, reason: "encrypted-payload-update-requires-plaintext" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("queues successful durable local MCP mutations for bidirectional sync", async () => {
    const token = "local-token-graph-outbox-0001";
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-local-mcp-outbox-"));
    try {
      const controlState = await createFixtureLocalControlState(token);
      const graphStore = await FileLocalGraphStore.open({
        directory,
        authorityId: controlState.authority_id,
        plaintextPersistence: "redact"
      });
      const initialized = await graphStore.initializeFromObjects(syntheticGraphObjects, {
        created_at: now
      });
      expect(initialized.ok).toBe(true);
      const outboxSink = new InMemoryLocalMcpMutationOutboxSink();
      const context = createLocalMcpContextFromControlState({
        controlState,
        graphStore,
        outboxSink,
        now
      });

      const created = await localCreateObject(context, {
        authorization: `Bearer ${token}`,
        object: syntheticRemoteSafeObject("la_object_outbox0001")
      });
      expect(created.ok).toBe(true);

      const updated = await localUpdateObject(context, {
        authorization: `Bearer ${token}`,
        object_id: "la_object_outbox0001",
        expected_version: 1,
        patch: {
          content_hash: fixedHash("e"),
          visible_metadata: {
            size_class: "small"
          }
        }
      });
      expect(updated.ok).toBe(true);

      const tombstoned = await localTombstoneObject(context, {
        authorization: `Bearer ${token}`,
        object_id: "la_object_outbox0001",
        expected_version: 2
      });
      expect(tombstoned.ok).toBe(true);

      expect(outboxSink.records.map((record) => record.mutation)).toEqual(["created", "updated", "tombstoned"]);
      expect(outboxSink.records.map((record) => record.generation)).toEqual([1, 2, 3]);
      expect(outboxSink.records.map((record) => record.journal_sequence)).toEqual([1, 2, 3]);
      expect(outboxSink.records.map((record) => record.object.object_id)).toEqual([
        "la_object_outbox0001",
        "la_object_outbox0001",
        "la_object_outbox0001"
      ]);
      expect(outboxSink.records.every((record) => record.object.payload.kind !== "plaintext-json")).toBe(true);
      expect(outboxSink.records[2]!.object.visible_metadata.tombstone).toBe(true);
      expect(JSON.stringify(outboxSink.records)).not.toContain("Synthetic created object");
      for (const bait of sensitiveBaitRegistry) {
        expect(JSON.stringify(outboxSink.records)).not.toContain(bait.value);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("writes daemon-compatible outbox files for durable local MCP mutations", async () => {
    const token = "local-token-graph-file-outbox-0001";
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-local-mcp-file-outbox-"));
    const outboxDirectory = join(directory, "outbox");
    try {
      const controlState = await createFixtureLocalControlState(token);
      const graphStore = await FileLocalGraphStore.open({
        directory: join(directory, "graph"),
        authorityId: controlState.authority_id,
        plaintextPersistence: "redact"
      });
      const initialized = await graphStore.initializeFromObjects(syntheticGraphObjects, {
        created_at: now
      });
      expect(initialized.ok).toBe(true);
      const context = createLocalMcpContextFromControlState({
        controlState,
        graphStore,
        outboxSink: new FileLocalMcpMutationOutboxSink(outboxDirectory),
        now
      });

      await expect(localCreateObject(context, {
        authorization: `Bearer ${token}`,
        object: syntheticRemoteSafeObject("la_object_fileoutbox0001")
      })).resolves.toMatchObject({
        ok: true
      });

      const files = await readdir(outboxDirectory);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^queued-g1-j1-[a-f0-9]{16}\.json$/);
      const queued = JSON.parse(await readFile(join(outboxDirectory, files[0]!), "utf8")) as {
        record_schema: string;
        mutation: string;
        objects: GraphObjectEnvelope[];
      };
      expect(queued).toMatchObject({
        record_schema: "living-atlas-local-mcp-outbox:v1",
        mutation: "created",
        objects: [expect.objectContaining({
          object_id: "la_object_fileoutbox0001",
          payload: expect.objectContaining({
            kind: "ciphertext-inline"
          })
        })]
      });
      expect(JSON.stringify(queued)).not.toContain("Synthetic created object");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("deduplicates durable resolution audit and outbox records with stable metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-local-resolution-sinks-"));
    const auditPath = join(directory, "audit", "events.jsonl");
    const outboxDirectory = join(directory, "outbox");
    try {
      const operationId = "la_operation_resolutionsinks0001";
      const idempotencyKey = "la_idem_resolutionsinks0001";
      const audit = createLocalMcpAuditEvent({
        event_type: "tool.allowed",
        client_id: fixtureLocalClientId,
        profile: "local-full",
        operation: "create",
        tool_name: "resolution_apply",
        reason_code: "resolution-committed",
        summary: "Local MCP tool call allowed",
        operation_id: operationId,
        idempotency_key: idempotencyKey
      });
      const auditSink = new FileLocalMcpAuditSink(auditPath);
      auditSink.record(audit);
      auditSink.record(audit);
      expect(auditSink.read(10)).toEqual([expect.objectContaining({
        operation_id: operationId,
        idempotency_key: idempotencyKey
      })]);

      const outboxSink = new FileLocalMcpMutationOutboxSink(outboxDirectory);
      const outboxRecord = {
        mutation: "created" as const,
        object: syntheticRemoteSafeObject("la_object_resolutionsinks0001"),
        actor_id: fixtureLocalClientId,
        recorded_at: now,
        generation: 4,
        journal_sequence: 7,
        operation_id: operationId,
        idempotency_key: idempotencyKey,
        change_id: "la_change_resolutionsinks0001"
      };
      await outboxSink.enqueue(outboxRecord);
      await outboxSink.enqueue(outboxRecord);

      const files = await readdir(outboxDirectory);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^queued-g4-j7-[a-f0-9]{16}\.json$/);
      const queued = JSON.parse(await readFile(join(outboxDirectory, files[0]!), "utf8"));
      expect(queued).toMatchObject({
        operation_id: operationId,
        idempotency_key: idempotencyKey,
        change_id: outboxRecord.change_id
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
