import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { chmodSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  CanonicalFactPayload,
  CanonicalRelationshipPayload,
  CanonicalResearchConnectorKind,
  ControlPlaneSnapshot,
  GraphObjectEnvelope
} from "@living-atlas/contracts";
import {
  controlPlaneFixture,
  fixtureAuthorityId,
  fixtureLocalClientId,
  fixtureRemoteClientId,
  sensitiveBaitRegistry,
  syntheticGraphObjects
} from "@living-atlas/fixtures";
import { createFixtureLocalControlState } from "@living-atlas/local-control-store";
import {
  canonicalResearchEvidenceId,
  canonicalResearchMutationFingerprint,
  canonicalResearchResultId,
  canonicalResearchRunId
} from "@living-atlas/graph-service";
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
  localSearchObjects,
  localTombstoneObject,
  localTimelineQuery,
  localTraverseGraph,
  localUpdateEdgeObject,
  localUpdateObject,
  localMigrationOpen,
  localMigrationSeal,
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

function researchHash(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
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
    excerpt: "Synthetic evidence for one canonical assertion.",
    extraction_method: "canonical-markdown-lossless-v1"
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
    source_evidence_ids: [evidenceId],
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

function nonMeaningfulResolutionDrafts(reviewVersion: number, parityVersion: number) {
  const drafts = canonicalResolutionDrafts(reviewVersion);
  return {
    ...drafts,
    evidence: {
      ...drafts.evidence,
      payload: {
        ...drafts.evidence.payload,
        data: {
          ...drafts.evidence.payload.data,
          content_hash: fixedHash("0"),
          excerpt: ""
        }
      }
    },
    review: {
      ...drafts.review,
      version: reviewVersion,
      payload: {
        ...drafts.review.payload,
        data: {
          ...drafts.review.payload.data,
          recommendation: "auto-apply",
          resolution_state: "auto-applied",
          proposed_object_ids: []
        }
      }
    },
    parity: {
      ...drafts.parity,
      version: parityVersion,
      payload: {
        ...drafts.parity.payload,
        data: {
          ...drafts.parity.payload.data,
          coverage_state: "unrepresented",
          meaning_state: "non-meaningful",
          representation_kind: undefined,
          canonical_object_ids: []
        }
      }
    }
  };
}

function researchResolutionDrafts(options: {
  connectors?: CanonicalResearchConnectorKind[];
  independenceKeys?: string[];
  stances?: Array<"supports" | "refutes" | "context">;
  identityStates?: Array<"resolved" | "ambiguous">;
  namespace?: string;
  factPredicate?: CanonicalFactPayload["predicate"];
  factValue?: CanonicalFactPayload["value"];
} = {}) {
  const base = canonicalResolutionDrafts(2);
  const connectors = options.connectors ?? ["public-web"];
  const namespace = options.namespace ?? "default";
  const independenceKeys = options.independenceKeys
    ?? connectors.map((_, index) => `synthetic-independent-${namespace}-${index + 1}`);
  const stances = options.stances ?? connectors.map(() => "supports" as const);
  const identityStates = options.identityStates ?? connectors.map(() => "resolved" as const);
  const sourceUnitId = fixedHash("1");
  const algorithmVersion = "synthetic-task4-v1";
  const normalizedQueryHash = researchHash("synthetic task 4 query");
  const researchEvidence = connectors.map((connector, index) => {
    const upstreamIdentity = `synthetic-upstream-${namespace}-${index + 1}`;
    const locator = `https://synthetic.invalid/research/${namespace}/${index + 1}`;
    const excerpt = `Synthetic research excerpt bait ${namespace} ${index + 1}.`;
    const evidenceContentHash = researchHash(excerpt);
    const evidenceId = canonicalResearchEvidenceId({
      upstream_identity: upstreamIdentity,
      locator,
      content_hash: evidenceContentHash
    });
    const sourceKind = connector === "linkedin"
      ? "linkedin"
      : connector === "local-corpus"
        ? "connector"
        : "public-web";
    return {
      ...base.evidence,
      object_id: evidenceId,
      content_hash: fixedHash(String((index + 4) % 10)),
      payload: {
        ...base.evidence.payload,
        data: {
          schema: "atlas.evidence:v1",
          evidence_id: evidenceId,
          source_kind: sourceKind,
          locator,
          content_hash: evidenceContentHash,
          retrieved_at: now,
          independence_key: independenceKeys[index]!,
          excerpt,
          extraction_method: `canonical-research-${connector}-v1`
        }
      }
    };
  });
  const provisionalFact = {
    ...(base.fact.payload.data as CanonicalFactPayload),
    assertion_id: "la_object_researchproposalplaceholder0001",
    predicate: options.factPredicate ?? (base.fact.payload.data as CanonicalFactPayload).predicate,
    value: options.factValue ?? (base.fact.payload.data as CanonicalFactPayload).value,
    evidence_links: researchEvidence.map((item, index) => ({
      evidence_id: item.object_id,
      stance: stances[index]!
    })).sort((left, right) => (
      left.evidence_id.localeCompare(right.evidence_id) || left.stance.localeCompare(right.stance)
    )),
    confidence: {
      ...(base.fact.payload.data as CanonicalFactPayload).confidence,
      evidence_refs: researchEvidence.map((item) => item.object_id).sort()
    }
  } satisfies CanonicalFactPayload;
  const proposalFingerprint = canonicalResearchMutationFingerprint(provisionalFact);
  const fact = {
    ...base.fact,
    object_id: proposalFingerprint.proposed_object_id,
    content_hash: fixedHash("9"),
    payload: {
      ...base.fact.payload,
      data: {
        ...provisionalFact,
        assertion_id: proposalFingerprint.proposed_object_id
      }
    }
  };
  const results = connectors.map((connector, index) => {
    const evidencePayload = researchEvidence[index]!.payload.data as Record<string, unknown>;
    const runId = canonicalResearchRunId({
      candidate_id: base.candidateId,
      source_unit_id: sourceUnitId,
      connector_kind: connector,
      normalized_query_hash: normalizedQueryHash,
      algorithm_version: algorithmVersion
    });
    const resultId = canonicalResearchResultId({
      run_id: runId,
      evidence_id: researchEvidence[index]!.object_id,
      proposed_mutation_hash: proposalFingerprint.proposed_mutation_hash
    });
    return {
      ...base.review,
      object_id: resultId,
      version: 1,
      content_hash: fixedHash(String((index + 6) % 10)),
      payload: {
        ...base.review.payload,
        data: {
          schema: "atlas.research-result:v1",
          research_result_id: resultId,
          run_id: runId,
          candidate_id: base.candidateId,
          source_unit_id: sourceUnitId,
          algorithm_version: algorithmVersion,
          normalized_query_hash: normalizedQueryHash,
          connector_kind: connector,
          upstream_identity: `synthetic-upstream-${namespace}-${index + 1}`,
          independence_key: independenceKeys[index]!,
          evidence_id: researchEvidence[index]!.object_id,
          evidence_content_hash: evidencePayload.content_hash,
          retrieved_at: evidencePayload.retrieved_at,
          stance: stances[index]!,
          identity_state: identityStates[index]!,
          identity_confidence: {
            band: "high",
            assessment_kind: "identity",
            method: "synthetic-task4-identity",
            assessed_at: now,
            evidence_refs: [researchEvidence[index]!.object_id]
          },
          proposed_object_id: proposalFingerprint.proposed_object_id,
          proposed_mutation_hash: proposalFingerprint.proposed_mutation_hash,
          recorded_at: now
        }
      }
    };
  });
  const review = withResolutionPayload(base.review, {
    recommendation: "auto-apply",
    resolution_state: "auto-applied",
    proposed_object_ids: [
      base.entity.object_id,
      ...researchEvidence.map((item) => item.object_id),
      fact.object_id,
      ...results.map((item) => item.object_id)
    ],
    research_requested_at: now,
    research_requested_unit_hashes: [sourceUnitId]
  });
  const currentReview = {
    ...review,
    version: 1,
    payload: {
      ...review.payload,
      data: {
        ...review.payload.data,
        recommendation: "research",
        resolution_state: "research",
        proposed_object_ids: []
      }
    }
  };
  const parity = withResolutionPayload(base.parity, {
    canonical_object_ids: [fact.object_id]
  });
  return {
    ...base,
    ownerEvidence: base.evidence,
    sourceUnitId,
    evidence: researchEvidence,
    fact,
    results,
    review,
    currentReview,
    parity,
    objects: [base.entity, ...researchEvidence, fact, ...results, review, parity]
  };
}

function researchRelationshipResolutionDrafts(options: {
  relationshipBases?: Array<"explicit" | "inferred-sensitive" | undefined>;
  identityStates?: Array<"resolved" | "ambiguous">;
} = {}) {
  const base = researchResolutionDrafts({
    connectors: ["public-web", "organization"],
    identityStates: options.identityStates,
    namespace: "relationship"
  });
  const sourceEntityId = "la_object_researchrelationshipperson0001";
  const sourceEntity = {
    ...base.entity,
    object_id: sourceEntityId,
    content_hash: fixedHash("7"),
    payload: {
      ...base.entity.payload,
      data: {
        schema: "atlas.entity:v1",
        entity_id: sourceEntityId,
        type: "person",
        subtype: "individual",
        name: "Synthetic Research Person",
        aliases: [],
        created_at: now,
        updated_at: now
      }
    }
  };
  const factPayload = base.fact.payload.data as CanonicalFactPayload;
  const provisional = {
    schema: "atlas.relationship:v2",
    assertion_id: "la_object_researchproposalplaceholder0001",
    edge_id: "la_edge_researchproposalplaceholder0001",
    source_entity_id: sourceEntityId,
    source_type: "person",
    target_entity_id: base.entity.object_id,
    target_type: "organization",
    predicate: "advises",
    valid_from: "2026",
    status: "active",
    attrs: {},
    recorded_at: now,
    lineage_action: "assert",
    supersedes: [],
    evidence_links: factPayload.evidence_links,
    confidence: factPayload.confidence
  } satisfies CanonicalRelationshipPayload;
  const fingerprint = canonicalResearchMutationFingerprint(provisional);
  const relationship = {
    ...base.fact,
    object_id: fingerprint.proposed_object_id,
    object_type: "edge" as const,
    content_hash: fixedHash("8"),
    payload: {
      ...base.fact.payload,
      data: {
        ...provisional,
        assertion_id: fingerprint.proposed_object_id,
        edge_id: `la_edge_${fingerprint.proposed_mutation_hash.slice("sha256:".length, "sha256:".length + 24)}`
      }
    }
  };
  const relationshipBases = options.relationshipBases ?? ["explicit", "explicit"];
  const results = base.results.map((result, index) => {
    const payload = result.payload.data as Record<string, unknown>;
    const resultId = canonicalResearchResultId({
      run_id: String(payload.run_id),
      evidence_id: String(payload.evidence_id),
      proposed_mutation_hash: fingerprint.proposed_mutation_hash
    });
    return {
      ...result,
      object_id: resultId,
      content_hash: fixedHash(String((index + 2) % 10)),
      payload: {
        ...result.payload,
        data: {
          ...payload,
          research_result_id: resultId,
          proposed_object_id: fingerprint.proposed_object_id,
          proposed_mutation_hash: fingerprint.proposed_mutation_hash,
          ...(relationshipBases[index] === undefined
            ? {}
            : { relationship_basis: relationshipBases[index] })
        }
      }
    };
  });
  const review = withResolutionPayload(base.review, {
    proposed_object_ids: [
      sourceEntity.object_id,
      base.entity.object_id,
      ...base.evidence.map((item) => item.object_id),
      relationship.object_id,
      ...results.map((item) => item.object_id)
    ]
  });
  const parity = withResolutionPayload(base.parity, {
    representation_kind: "relationship",
    canonical_object_ids: [relationship.object_id]
  });
  return {
    ...base,
    sourceEntity,
    relationship,
    results,
    review,
    parity,
    objects: [sourceEntity, base.entity, ...base.evidence, relationship, ...results, review, parity]
  };
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
  it("rejects third-party auto-apply with one public evidence group", async () => {
    const token = "local-token-research-one-source-0001";
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-research-one-source-"));
    try {
      const controlState = await createFixtureLocalControlState(token);
      const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
      const graphStore = await FileLocalGraphStore.open({
        directory,
        authorityId: controlState.authority_id,
        plaintextPersistence: "encrypt",
        keyring
      });
      const drafts = researchResolutionDrafts();
      await expect(graphStore.initializeFromObjects([
        drafts.currentReview,
        drafts.ownerEvidence
      ] as never)).resolves.toMatchObject({ ok: true });
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
        operation_id: "la_operation_researchonesource0001",
        idempotency_key: "la_idem_researchonesource0001",
        candidate_id: drafts.candidateId,
        expected_generation: 0,
        expected_review_version: 1,
        objects: drafts.objects
      };
      await expect(localResolutionApply(context, request))
        .resolves.toEqual({ ok: false, reason: "research-evidence-insufficient" });
      await expect(localResolutionApply(context, request))
        .resolves.toEqual({ ok: false, reason: "research-evidence-insufficient" });

      expect(graphStore.status()).toMatchObject({ generation: 0, object_count: 2 });
      expect(graphStore.readObject(drafts.fact.object_id)).toBeUndefined();
      expect(graphStore.readObject(drafts.results[0]!.object_id)).toBeUndefined();
      expect(outboxSink.records).toHaveLength(0);
      expect(auditSink.events.filter((event) => event.reason_code === "research-evidence-insufficient"))
        .toEqual([expect.objectContaining({
          event_type: "tool.denied",
          research: expect.objectContaining({
            connector_kinds: ["public-web"],
            outcome: "research",
            independence_group_count: 1,
            result_set_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)
          })
        })]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("checks generation before evaluating or auditing a new research request", async () => {
    const token = "local-token-research-stale-generation-0001";
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-research-stale-generation-"));
    try {
      const controlState = await createFixtureLocalControlState(token);
      const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
      const graphStore = await FileLocalGraphStore.open({
        directory,
        authorityId: controlState.authority_id,
        plaintextPersistence: "encrypt",
        keyring
      });
      const drafts = researchResolutionDrafts();
      await expect(graphStore.initializeFromObjects([
        drafts.currentReview,
        drafts.ownerEvidence
      ] as never)).resolves.toMatchObject({ ok: true });
      await expect(graphStore.createObject({
        object: temporalEdgeObject("la_object_researchstalegeneration0001"),
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

      await expect(localResolutionApply(context, {
        authorization: `Bearer ${token}`,
        operation_id: "la_operation_researchstalegeneration0001",
        idempotency_key: "la_idem_researchstalegeneration0001",
        candidate_id: drafts.candidateId,
        expected_generation: 0,
        expected_review_version: 1,
        objects: drafts.objects
      })).resolves.toEqual({ ok: false, reason: "generation-conflict" });
      expect(graphStore.status()).toMatchObject({ generation: 1, journal_sequence: 1 });
      expect(auditSink.events.filter((event) => event.tool_name === "resolution_apply")).toHaveLength(0);
      expect(outboxSink.records).toHaveLength(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("accepts two independent public research groups with a redacted audit summary", async () => {
    const token = "local-token-research-two-source-0001";
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-research-two-source-"));
    try {
      const controlState = await createFixtureLocalControlState(token);
      const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
      const graphStore = await FileLocalGraphStore.open({
        directory,
        authorityId: controlState.authority_id,
        plaintextPersistence: "encrypt",
        keyring
      });
      const drafts = researchResolutionDrafts({ connectors: ["public-web", "organization"] });
      await expect(graphStore.initializeFromObjects([
        drafts.currentReview,
        drafts.ownerEvidence
      ] as never)).resolves.toMatchObject({ ok: true });
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

      await expect(localResolutionApply(context, {
        authorization: `Bearer ${token}`,
        operation_id: "la_operation_researchtwosource0001",
        idempotency_key: "la_idem_researchtwosource0001",
        candidate_id: drafts.candidateId,
        expected_generation: 0,
        expected_review_version: 1,
        objects: drafts.objects
      })).resolves.toMatchObject({
        ok: true,
        result: { local_commit: "committed", audit: "recorded", generation: 1, journal_sequence: 1 }
      });

      expect(graphStore.status()).toMatchObject({ generation: 1, object_count: 9 });
      expect(outboxSink.records).toHaveLength(drafts.objects.length);
      const resolutionAudit = auditSink.events.find((event) => (
        event.tool_name === "resolution_apply" && event.reason_code === "resolution-committed"
      ));
      expect(resolutionAudit).toMatchObject({
        research: {
          connector_kinds: ["organization", "public-web"],
          outcome: "auto-apply",
          independence_group_count: 2,
          result_set_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)
        }
      });
      const serialized = JSON.stringify(resolutionAudit);
      for (const privateBait of [
        "synthetic.invalid",
        "Synthetic research excerpt bait",
        "synthetic-upstream",
        drafts.evidence[0]!.object_id,
        drafts.results[0]!.object_id
      ]) expect(serialized).not.toContain(privateBait);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not treat omitted research results as owner-source evidence", async () => {
    const token = "local-token-research-omitted-result-0001";
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-research-omitted-result-"));
    try {
      const controlState = await createFixtureLocalControlState(token);
      const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
      const graphStore = await FileLocalGraphStore.open({
        directory,
        authorityId: controlState.authority_id,
        plaintextPersistence: "encrypt",
        keyring
      });
      const drafts = researchResolutionDrafts();
      await expect(graphStore.initializeFromObjects([
        drafts.currentReview,
        drafts.ownerEvidence
      ] as never)).resolves.toMatchObject({ ok: true });
      const reviewWithoutResult = withResolutionPayload(drafts.review, {
        proposed_object_ids: (drafts.review.payload.data.proposed_object_ids as string[])
          .filter((objectId) => !drafts.results.some((result) => result.object_id === objectId))
      });
      const objects = drafts.objects
        .filter((object) => !drafts.results.some((result) => result.object_id === object.object_id))
        .map((object) => object.object_id === drafts.review.object_id ? reviewWithoutResult : object);
      const context = createLocalMcpContextFromControlState({
        controlState,
        graphStore,
        decryptPayload: decryptWithKeyring(keyring),
        auditSink: new InMemoryLocalMcpAuditSink(),
        outboxSink: new InMemoryLocalMcpMutationOutboxSink(),
        now
      });

      await expect(localResolutionApply(context, {
        authorization: `Bearer ${token}`,
        operation_id: "la_operation_researchomittedresult0001",
        idempotency_key: "la_idem_researchomittedresult0001",
        candidate_id: drafts.candidateId,
        expected_generation: 0,
        expected_review_version: 1,
        objects
      })).resolves.toEqual({ ok: false, reason: "research-evidence-insufficient" });
      expect(graphStore.status()).toMatchObject({ generation: 0, object_count: 2 });
      expect(graphStore.readObject(drafts.fact.object_id)).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    {
      lane: "owner review",
      connector: "public-web" as const,
      recommendation: "owner-review" as const,
      resolutionState: "owner-review" as const,
      expectedReason: "research-evidence-conflict"
    },
    {
      lane: "research",
      connector: "local-corpus" as const,
      recommendation: "research" as const,
      resolutionState: "research" as const,
      expectedReason: "research-evidence-insufficient"
    }
  ])("keeps a result-less $lane proposal out of the canonical graph", async ({
    connector,
    recommendation,
    resolutionState,
    expectedReason
  }) => {
    const token = `local-token-result-less-${resolutionState}-0001`;
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-result-less-non-auto-"));
    try {
      const controlState = await createFixtureLocalControlState(token);
      const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
      const graphStore = await FileLocalGraphStore.open({
        directory,
        authorityId: controlState.authority_id,
        plaintextPersistence: "encrypt",
        keyring
      });
      const drafts = researchResolutionDrafts({ connectors: [connector], namespace: resolutionState });
      await expect(graphStore.initializeFromObjects([
        drafts.currentReview,
        drafts.ownerEvidence
      ] as never)).resolves.toMatchObject({ ok: true });
      const review = withResolutionPayload(drafts.review, {
        recommendation,
        resolution_state: resolutionState,
        proposed_object_ids: (drafts.review.payload.data.proposed_object_ids as string[])
          .filter((objectId) => !drafts.results.some((result) => result.object_id === objectId))
      });
      const objects = drafts.objects
        .filter((object) => !drafts.results.some((result) => result.object_id === object.object_id))
        .map((object) => object.object_id === review.object_id ? review : object);
      const context = createLocalMcpContextFromControlState({
        controlState,
        graphStore,
        decryptPayload: decryptWithKeyring(keyring),
        auditSink: new InMemoryLocalMcpAuditSink(),
        outboxSink: new InMemoryLocalMcpMutationOutboxSink(),
        now
      });

      await expect(localResolutionApply(context, {
        authorization: `Bearer ${token}`,
        operation_id: `la_operation_resultless${resolutionState.replace("-", "")}0001`,
        idempotency_key: `la_idem_resultless${resolutionState.replace("-", "")}0001`,
        candidate_id: drafts.candidateId,
        expected_generation: 0,
        expected_review_version: 1,
        objects
      })).resolves.toEqual({ ok: false, reason: expectedReason });
      expect(graphStore.status()).toMatchObject({ generation: 0, journal_sequence: 0 });
      expect(graphStore.readObject(drafts.fact.object_id)).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("deduplicates exact omitted-result denials without collapsing changed evidence sets", async () => {
    const token = "local-token-research-omitted-audit-0001";
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-research-omitted-audit-"));
    try {
      const controlState = await createFixtureLocalControlState(token);
      const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
      const graphStore = await FileLocalGraphStore.open({
        directory,
        authorityId: controlState.authority_id,
        plaintextPersistence: "encrypt",
        keyring
      });
      const first = researchResolutionDrafts({ namespace: "omitted-audit-first" });
      const second = researchResolutionDrafts({ namespace: "omitted-audit-second" });
      await expect(graphStore.initializeFromObjects([
        first.currentReview,
        first.ownerEvidence
      ] as never)).resolves.toMatchObject({ ok: true });
      const withoutResults = (drafts: ReturnType<typeof researchResolutionDrafts>) => {
        const review = withResolutionPayload(drafts.review, {
          proposed_object_ids: (drafts.review.payload.data.proposed_object_ids as string[])
            .filter((objectId) => !drafts.results.some((result) => result.object_id === objectId))
        });
        return drafts.objects
          .filter((object) => !drafts.results.some((result) => result.object_id === object.object_id))
          .map((object) => {
            if (object.object_id === review.object_id) return review;
            if (object.object_id === drafts.evidence[0]!.object_id) {
              return withResolutionPayload(object, { source_kind: "other" });
            }
            return object;
          });
      };
      const auditSink = new InMemoryLocalMcpAuditSink();
      const context = createLocalMcpContextFromControlState({
        controlState,
        graphStore,
        decryptPayload: decryptWithKeyring(keyring),
        auditSink,
        outboxSink: new InMemoryLocalMcpMutationOutboxSink(),
        now
      });
      const baseRequest = {
        authorization: `Bearer ${token}`,
        operation_id: "la_operation_researchomittedaudit0001",
        idempotency_key: "la_idem_researchomittedaudit0001",
        candidate_id: first.candidateId,
        expected_generation: 0,
        expected_review_version: 1
      };

      await expect(localResolutionApply(context, { ...baseRequest, objects: withoutResults(first) }))
        .resolves.toEqual({ ok: false, reason: "research-evidence-insufficient" });
      await expect(localResolutionApply(context, { ...baseRequest, objects: withoutResults(first) }))
        .resolves.toEqual({ ok: false, reason: "research-evidence-insufficient" });
      await expect(localResolutionApply(context, { ...baseRequest, objects: withoutResults(second) }))
        .resolves.toEqual({ ok: false, reason: "research-evidence-insufficient" });

      const denied = auditSink.events.filter((event) => event.reason_code === "research-evidence-insufficient");
      expect(denied).toHaveLength(2);
      expect(denied).toEqual(expect.arrayContaining([
        expect.objectContaining({
          research: expect.objectContaining({
            connector_kinds: ["local-corpus"],
            outcome: "research",
            independence_group_count: 1,
            result_set_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)
          })
        })
      ]));
      expect(new Set(denied.map((event) => event.research?.result_set_hash)).size).toBe(2);
      expect(graphStore.status()).toMatchObject({ generation: 0, journal_sequence: 0 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    { label: "public source kind", evidencePatch: {} },
    {
      label: "research extraction marker",
      evidencePatch: {
        source_kind: "migration",
        extraction_method: "canonical-research-public-web-v1"
      }
    }
  ])("does not let review-only auto-apply disguise $label as owner source", async ({ evidencePatch }) => {
    const token = "local-token-research-review-only-bypass-0001";
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-research-review-only-bypass-"));
    try {
      const controlState = await createFixtureLocalControlState(token);
      const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
      const graphStore = await FileLocalGraphStore.open({
        directory,
        authorityId: controlState.authority_id,
        plaintextPersistence: "encrypt",
        keyring
      });
      const drafts = researchResolutionDrafts();
      const proposedObjectIds = [
        drafts.entity.object_id,
        drafts.evidence[0]!.object_id,
        drafts.fact.object_id
      ];
      const stagedEvidence = withResolutionPayload(drafts.evidence[0]!, evidencePatch);
      const currentReview = withResolutionPayload(drafts.currentReview, { proposed_object_ids: proposedObjectIds });
      const finalReview = withResolutionPayload(drafts.review, { proposed_object_ids: proposedObjectIds });
      await expect(graphStore.initializeFromObjects([
        drafts.entity,
        drafts.ownerEvidence,
        stagedEvidence,
        drafts.fact,
        currentReview,
        drafts.parity
      ] as never)).resolves.toMatchObject({ ok: true });
      const outboxSink = new InMemoryLocalMcpMutationOutboxSink();
      const context = createLocalMcpContextFromControlState({
        controlState,
        graphStore,
        decryptPayload: decryptWithKeyring(keyring),
        auditSink: new InMemoryLocalMcpAuditSink(),
        outboxSink,
        now
      });

      await expect(localResolutionApply(context, {
        authorization: `Bearer ${token}`,
        operation_id: "la_operation_researchreviewonlybypass0001",
        idempotency_key: "la_idem_researchreviewonlybypass0001",
        candidate_id: drafts.candidateId,
        expected_generation: 0,
        expected_review_version: 1,
        objects: [finalReview]
      })).resolves.toEqual({ ok: false, reason: "research-evidence-insufficient" });
      expect(graphStore.status()).toMatchObject({ generation: 0, journal_sequence: 0 });
      expect(graphStore.readObject(finalReview.object_id)).toMatchObject({ version: 1 });
      expect(outboxSink.records).toHaveLength(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects an extraneous research-result draft not named by the final review", async () => {
    const token = "local-token-research-extraneous-result-0001";
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-research-extraneous-result-"));
    try {
      const controlState = await createFixtureLocalControlState(token);
      const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
      const graphStore = await FileLocalGraphStore.open({
        directory,
        authorityId: controlState.authority_id,
        plaintextPersistence: "encrypt",
        keyring
      });
      const drafts = researchResolutionDrafts({ connectors: ["public-web", "organization"] });
      await expect(graphStore.initializeFromObjects([
        drafts.currentReview,
        drafts.ownerEvidence
      ] as never)).resolves.toMatchObject({ ok: true });
      const extraneous = drafts.results[0]!;
      const review = withResolutionPayload(drafts.review, {
        proposed_object_ids: (drafts.review.payload.data.proposed_object_ids as string[])
          .filter((objectId) => objectId !== extraneous.object_id)
      });
      const objects = drafts.objects.map((object) => object.object_id === review.object_id ? review : object);
      const outboxSink = new InMemoryLocalMcpMutationOutboxSink();
      const context = createLocalMcpContextFromControlState({
        controlState,
        graphStore,
        decryptPayload: decryptWithKeyring(keyring),
        auditSink: new InMemoryLocalMcpAuditSink(),
        outboxSink,
        now
      });

      await expect(localResolutionApply(context, {
        authorization: `Bearer ${token}`,
        operation_id: "la_operation_researchextraneousresult0001",
        idempotency_key: "la_idem_researchextraneousresult0001",
        candidate_id: drafts.candidateId,
        expected_generation: 0,
        expected_review_version: 1,
        objects
      })).resolves.toEqual({ ok: false, reason: "research-evidence-conflict" });
      expect(graphStore.status()).toMatchObject({ generation: 0, journal_sequence: 0 });
      expect(graphStore.readObject(extraneous.object_id)).toBeUndefined();
      expect(outboxSink.records).toHaveLength(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not cherry-pick supporting results while omitting linked refuting research", async () => {
    const token = "local-token-research-omitted-refute-0001";
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-research-omitted-refute-"));
    try {
      const controlState = await createFixtureLocalControlState(token);
      const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
      const graphStore = await FileLocalGraphStore.open({
        directory,
        authorityId: controlState.authority_id,
        plaintextPersistence: "encrypt",
        keyring
      });
      const drafts = researchResolutionDrafts({
        connectors: ["public-web", "organization", "public-web"],
        stances: ["supports", "supports", "refutes"],
        namespace: "omitted-refute"
      });
      await expect(graphStore.initializeFromObjects([
        drafts.currentReview,
        drafts.ownerEvidence
      ] as never)).resolves.toMatchObject({ ok: true });
      const omittedResult = drafts.results[2]!;
      const review = withResolutionPayload(drafts.review, {
        proposed_object_ids: (drafts.review.payload.data.proposed_object_ids as string[])
          .filter((objectId) => objectId !== omittedResult.object_id)
      });
      const objects = drafts.objects
        .filter((object) => object.object_id !== omittedResult.object_id)
        .map((object) => object.object_id === review.object_id ? review : object);
      const context = createLocalMcpContextFromControlState({
        controlState,
        graphStore,
        decryptPayload: decryptWithKeyring(keyring),
        auditSink: new InMemoryLocalMcpAuditSink(),
        outboxSink: new InMemoryLocalMcpMutationOutboxSink(),
        now
      });

      await expect(localResolutionApply(context, {
        authorization: `Bearer ${token}`,
        operation_id: "la_operation_researchomittedrefute0001",
        idempotency_key: "la_idem_researchomittedrefute0001",
        candidate_id: drafts.candidateId,
        expected_generation: 0,
        expected_review_version: 1,
        objects
      })).resolves.toEqual({ ok: false, reason: "research-evidence-conflict" });
      expect(graphStore.status()).toMatchObject({ generation: 0, object_count: 2 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("qualifies explicitly referenced durable research results", async () => {
    const token = "local-token-research-durable-results-0001";
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-research-durable-results-"));
    try {
      const controlState = await createFixtureLocalControlState(token);
      const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
      const graphStore = await FileLocalGraphStore.open({
        directory,
        authorityId: controlState.authority_id,
        plaintextPersistence: "encrypt",
        keyring
      });
      const drafts = researchResolutionDrafts({ connectors: ["public-web", "organization"] });
      await expect(graphStore.initializeFromObjects([
        drafts.currentReview,
        drafts.ownerEvidence,
        ...drafts.evidence,
        ...drafts.results
      ] as never)).resolves.toMatchObject({ ok: true });
      const objects = drafts.objects.filter((object) => (
        !drafts.evidence.some((evidence) => evidence.object_id === object.object_id)
        && !drafts.results.some((result) => result.object_id === object.object_id)
      ));
      const recordedAudit = new InMemoryLocalMcpAuditSink();
      let failResolutionAudit = true;
      const auditSink = {
        record(event: Parameters<InMemoryLocalMcpAuditSink["record"]>[0]) {
          if (failResolutionAudit && event.tool_name === "resolution_apply") {
            failResolutionAudit = false;
            throw new Error("synthetic durable-result audit outage");
          }
          recordedAudit.record(event);
        }
      };
      const context = createLocalMcpContextFromControlState({
        controlState,
        graphStore,
        decryptPayload: decryptWithKeyring(keyring),
        auditSink,
        outboxSink: new InMemoryLocalMcpMutationOutboxSink(),
        now
      });

      const request = {
        authorization: `Bearer ${token}`,
        operation_id: "la_operation_researchdurableresults0001",
        idempotency_key: "la_idem_researchdurableresults0001",
        candidate_id: drafts.candidateId,
        expected_generation: 0,
        expected_review_version: 1,
        objects
      };
      await expect(localResolutionApply(context, request)).resolves.toMatchObject({
        ok: true,
        result: {
          local_commit: "committed",
          audit: "reconciliation-required",
          generation: 1,
          journal_sequence: 1
        }
      });
      await expect(graphStore.tombstoneObject({
        object_id: drafts.results[0]!.object_id,
        expected_generation: 1,
        expected_version: 1,
        actor_id: fixtureLocalClientId,
        recorded_at: "2026-06-21T12:01:00.000Z"
      })).resolves.toMatchObject({ ok: true, generation: 2, journal_sequence: 2 });
      await expect(localResolutionApply(context, request)).resolves.toMatchObject({
        ok: true,
        result: {
          local_commit: "committed",
          audit: "recorded",
          generation: 1,
          journal_sequence: 1
        }
      });
      expect(graphStore.status()).toMatchObject({ generation: 2, journal_sequence: 2, object_count: 9 });
      expect(graphStore.readObject(drafts.results[0]!.object_id)).toMatchObject({
        version: 2,
        visible_metadata: { tombstone: true }
      });
      expect(recordedAudit.events.filter((event) => (
        event.tool_name === "resolution_apply" && event.reason_code === "resolution-committed"
      ))).toEqual([expect.objectContaining({
        research: {
          connector_kinds: ["organization", "public-web"],
          outcome: "auto-apply",
          independence_group_count: 2,
          result_set_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)
        }
      })]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not let a draft of another schema shadow a durable refuting result", async () => {
    const token = "local-token-research-result-shadow-0001";
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-research-result-shadow-"));
    try {
      const controlState = await createFixtureLocalControlState(token);
      const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
      const graphStore = await FileLocalGraphStore.open({
        directory,
        authorityId: controlState.authority_id,
        plaintextPersistence: "encrypt",
        keyring
      });
      const drafts = researchResolutionDrafts({
        connectors: ["public-web", "organization", "public-web"],
        stances: ["supports", "supports", "refutes"],
        namespace: "durable-shadow"
      });
      const refutingEvidence = drafts.evidence[2]!;
      const refutingResult = drafts.results[2]!;
      await expect(graphStore.initializeFromObjects([
        drafts.currentReview,
        drafts.ownerEvidence,
        refutingEvidence,
        refutingResult
      ] as never)).resolves.toMatchObject({ ok: true });
      const factPayload = drafts.fact.payload.data as CanonicalFactPayload;
      const supportsOnlyFact = withResolutionPayload(drafts.fact, {
        evidence_links: factPayload.evidence_links.slice(0, 2),
        confidence: { ...factPayload.confidence, evidence_refs: factPayload.confidence.evidence_refs.slice(0, 2) }
      });
      const shadow = {
        ...drafts.entity,
        object_id: refutingResult.object_id,
        version: 2,
        payload: {
          ...drafts.entity.payload,
          data: {
            ...(drafts.entity.payload.data as Record<string, unknown>),
            entity_id: refutingResult.object_id,
            name: "Synthetic result shadow"
          }
        }
      };
      const objects = [
        ...drafts.objects.filter((object) => (
          object.object_id !== refutingEvidence.object_id
          && object.object_id !== refutingResult.object_id
          && object.object_id !== supportsOnlyFact.object_id
        )),
        supportsOnlyFact,
        shadow
      ];
      const outboxSink = new InMemoryLocalMcpMutationOutboxSink();
      const context = createLocalMcpContextFromControlState({
        controlState,
        graphStore,
        decryptPayload: decryptWithKeyring(keyring),
        auditSink: new InMemoryLocalMcpAuditSink(),
        outboxSink,
        now
      });

      await expect(localResolutionApply(context, {
        authorization: `Bearer ${token}`,
        operation_id: "la_operation_researchresultshadow0001",
        idempotency_key: "la_idem_researchresultshadow0001",
        candidate_id: drafts.candidateId,
        expected_generation: 0,
        expected_review_version: 1,
        objects
      })).resolves.toEqual({ ok: false, reason: "research-evidence-conflict" });
      expect(graphStore.status()).toMatchObject({ generation: 0, journal_sequence: 0 });
      expect(graphStore.readObject(refutingResult.object_id)).toMatchObject({
        object_type: "review",
        version: 1
      });
      expect(outboxSink.records).toHaveLength(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses the current durable review rather than proposed authorization", async () => {
    const token = "local-token-research-durable-authorization-0001";
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-research-durable-authorization-"));
    try {
      const controlState = await createFixtureLocalControlState(token);
      const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
      const graphStore = await FileLocalGraphStore.open({
        directory,
        authorityId: controlState.authority_id,
        plaintextPersistence: "encrypt",
        keyring
      });
      const drafts = researchResolutionDrafts({ connectors: ["public-web", "organization"] });
      const unauthorizedCurrent = withResolutionPayload(drafts.currentReview, {
        research_requested_unit_hashes: [fixedHash("2")]
      });
      await expect(graphStore.initializeFromObjects([
        unauthorizedCurrent,
        drafts.ownerEvidence
      ] as never)).resolves.toMatchObject({ ok: true });
      const proposedAuthorization = withResolutionPayload(drafts.review, {
        research_requested_all: true,
        research_requested_unit_hashes: undefined
      });
      const objects = drafts.objects.map((object) => (
        object.object_id === proposedAuthorization.object_id ? proposedAuthorization : object
      ));
      const context = createLocalMcpContextFromControlState({
        controlState,
        graphStore,
        decryptPayload: decryptWithKeyring(keyring),
        auditSink: new InMemoryLocalMcpAuditSink(),
        outboxSink: new InMemoryLocalMcpMutationOutboxSink(),
        now
      });

      await expect(localResolutionApply(context, {
        authorization: `Bearer ${token}`,
        operation_id: "la_operation_researchdurableauthorization0001",
        idempotency_key: "la_idem_researchdurableauthorization0001",
        candidate_id: drafts.candidateId,
        expected_generation: 0,
        expected_review_version: 1,
        objects
      })).resolves.toEqual({ ok: false, reason: "research-evidence-conflict" });
      expect(graphStore.status()).toMatchObject({ generation: 0, object_count: 2 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects qualifying research while the durable review has an auto-apply blocker", async () => {
    const token = "local-token-research-durable-blocker-0001";
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-research-durable-blocker-"));
    try {
      const controlState = await createFixtureLocalControlState(token);
      const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
      const graphStore = await FileLocalGraphStore.open({
        directory,
        authorityId: controlState.authority_id,
        plaintextPersistence: "encrypt",
        keyring
      });
      const drafts = researchResolutionDrafts({ connectors: ["public-web", "organization"] });
      const blocker = ["typed-projection-ambiguous-entity"];
      const currentReview = withResolutionPayload(drafts.currentReview, { auto_apply_blockers: blocker });
      const finalReview = withResolutionPayload(drafts.review, { auto_apply_blockers: blocker });
      await expect(graphStore.initializeFromObjects([
        currentReview,
        drafts.ownerEvidence
      ] as never)).resolves.toMatchObject({ ok: true });
      const objects = drafts.objects.map((object) => (
        object.object_id === finalReview.object_id ? finalReview : object
      ));
      const outboxSink = new InMemoryLocalMcpMutationOutboxSink();
      const context = createLocalMcpContextFromControlState({
        controlState,
        graphStore,
        decryptPayload: decryptWithKeyring(keyring),
        auditSink: new InMemoryLocalMcpAuditSink(),
        outboxSink,
        now
      });

      await expect(localResolutionApply(context, {
        authorization: `Bearer ${token}`,
        operation_id: "la_operation_researchdurableblocker0001",
        idempotency_key: "la_idem_researchdurableblocker0001",
        candidate_id: drafts.candidateId,
        expected_generation: 0,
        expected_review_version: 1,
        objects
      })).resolves.toEqual({ ok: false, reason: "resolution-review-mismatch" });
      expect(graphStore.status()).toMatchObject({ generation: 0, journal_sequence: 0 });
      expect(graphStore.readObject(drafts.fact.object_id)).toBeUndefined();
      expect(outboxSink.records).toHaveLength(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("validates research-result references in the canonical mutation switch", async () => {
    const token = "local-token-research-result-reference-0001";
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-research-result-reference-"));
    try {
      const controlState = await createFixtureLocalControlState(token);
      const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
      const graphStore = await FileLocalGraphStore.open({
        directory,
        authorityId: controlState.authority_id,
        plaintextPersistence: "encrypt",
        keyring
      });
      const drafts = researchResolutionDrafts({ connectors: ["public-web", "organization"] });
      await expect(graphStore.initializeFromObjects([
        drafts.currentReview,
        drafts.ownerEvidence
      ] as never)).resolves.toMatchObject({ ok: true });
      const result = withResolutionPayload(drafts.results[0]!, {
        identity_confidence: {
          ...(drafts.results[0]!.payload.data.identity_confidence as Record<string, unknown>),
          evidence_refs: [drafts.evidence[0]!.object_id, drafts.entity.object_id]
        }
      });
      const review = withResolutionPayload(drafts.review, {
        recommendation: "owner-review",
        resolution_state: "owner-review"
      });
      const objects = drafts.objects.map((object) => {
        if (object.object_id === result.object_id) return result;
        if (object.object_id === review.object_id) return review;
        return object;
      });
      const outboxSink = new InMemoryLocalMcpMutationOutboxSink();
      const context = createLocalMcpContextFromControlState({
        controlState,
        graphStore,
        decryptPayload: decryptWithKeyring(keyring),
        auditSink: new InMemoryLocalMcpAuditSink(),
        outboxSink,
        now
      });

      await expect(localResolutionApply(context, {
        authorization: `Bearer ${token}`,
        operation_id: "la_operation_researchresultreference0001",
        idempotency_key: "la_idem_researchresultreference0001",
        candidate_id: drafts.candidateId,
        expected_generation: 0,
        expected_review_version: 1,
        objects
      })).resolves.toEqual({ ok: false, reason: "resolution-missing-reference" });
      expect(graphStore.status()).toMatchObject({ generation: 0, journal_sequence: 0 });
      expect(graphStore.readObject(result.object_id)).toBeUndefined();
      expect(outboxSink.records).toHaveLength(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    { recommendation: "research" as const, resolutionState: "research" as const, reason: "research-evidence-insufficient" },
    { recommendation: "owner-review" as const, resolutionState: "owner-review" as const, reason: "research-evidence-conflict" }
  ])("does not persist a research proposal while its outcome is $resolutionState", async ({
    recommendation,
    resolutionState,
    reason
  }) => {
    const token = `local-token-research-noncanonical-${resolutionState}-0001`;
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-research-noncanonical-"));
    try {
      const controlState = await createFixtureLocalControlState(token);
      const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
      const graphStore = await FileLocalGraphStore.open({
        directory,
        authorityId: controlState.authority_id,
        plaintextPersistence: "encrypt",
        keyring
      });
      const drafts = researchResolutionDrafts({ connectors: ["public-web", "organization"] });
      await expect(graphStore.initializeFromObjects([
        drafts.currentReview,
        drafts.ownerEvidence
      ] as never)).resolves.toMatchObject({ ok: true });
      const review = withResolutionPayload(drafts.review, {
        recommendation,
        resolution_state: resolutionState
      });
      const objects = drafts.objects.map((object) => object.object_id === review.object_id ? review : object);
      const outboxSink = new InMemoryLocalMcpMutationOutboxSink();
      const context = createLocalMcpContextFromControlState({
        controlState,
        graphStore,
        decryptPayload: decryptWithKeyring(keyring),
        auditSink: new InMemoryLocalMcpAuditSink(),
        outboxSink,
        now
      });

      await expect(localResolutionApply(context, {
        authorization: `Bearer ${token}`,
        operation_id: `la_operation_researchnoncanonical${resolutionState.replaceAll("-", "")}0001`,
        idempotency_key: `la_idem_researchnoncanonical${resolutionState.replaceAll("-", "")}0001`,
        candidate_id: drafts.candidateId,
        expected_generation: 0,
        expected_review_version: 1,
        objects
      })).resolves.toEqual({ ok: false, reason });
      expect(graphStore.status()).toMatchObject({ generation: 0, journal_sequence: 0 });
      expect(graphStore.readObject(drafts.fact.object_id)).toBeUndefined();
      expect(outboxSink.records).toHaveLength(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    {
      label: "evidence content hash drift",
      expected: "research-evidence-conflict",
      mutate: (drafts: ReturnType<typeof researchResolutionDrafts>) => {
        const changed = withResolutionPayload(drafts.results[0]!, { evidence_content_hash: fixedHash("f") });
        return drafts.objects.map((object) => object.object_id === changed.object_id ? changed : object);
      }
    },
    {
      label: "retrieval time drift",
      expected: "research-evidence-conflict",
      mutate: (drafts: ReturnType<typeof researchResolutionDrafts>) => {
        const changed = withResolutionPayload(drafts.results[0]!, { retrieved_at: "2026-06-22T12:00:00.000Z" });
        return drafts.objects.map((object) => object.object_id === changed.object_id ? changed : object);
      }
    },
    {
      label: "independence key drift",
      expected: "research-evidence-conflict",
      mutate: (drafts: ReturnType<typeof researchResolutionDrafts>) => {
        const changed = withResolutionPayload(drafts.results[0]!, { independence_key: "synthetic-forged-group" });
        return drafts.objects.map((object) => object.object_id === changed.object_id ? changed : object);
      }
    },
    {
      label: "connector evidence kind drift",
      expected: "research-evidence-conflict",
      mutate: (drafts: ReturnType<typeof researchResolutionDrafts>) => {
        const changed = withResolutionPayload(drafts.evidence[0]!, { source_kind: "linkedin" });
        return drafts.objects.map((object) => object.object_id === changed.object_id ? changed : object);
      }
    },
    {
      label: "excerpt content hash drift",
      expected: "research-evidence-conflict",
      mutate: (drafts: ReturnType<typeof researchResolutionDrafts>) => {
        const changed = withResolutionPayload(drafts.evidence[0]!, { excerpt: "Synthetic changed excerpt bait." });
        return drafts.objects.map((object) => object.object_id === changed.object_id ? changed : object);
      }
    },
    {
      label: "missing encrypted snapshot reference",
      expected: "resolution-missing-reference",
      mutate: (drafts: ReturnType<typeof researchResolutionDrafts>) => {
        const changed = withResolutionPayload(drafts.evidence[0]!, {
          excerpt: undefined,
          snapshot_ref: "la_object_missingresearchsnapshot0001"
        });
        return drafts.objects.map((object) => object.object_id === changed.object_id ? changed : object);
      }
    },
    {
      label: "proposal evidence stance drift",
      expected: "research-evidence-conflict",
      mutate: (drafts: ReturnType<typeof researchResolutionDrafts>) => {
        const payload = drafts.fact.payload.data as CanonicalFactPayload;
        const changed = withResolutionPayload(drafts.fact, {
          evidence_links: payload.evidence_links.map((link, index) => (
            index === 0 ? { ...link, stance: "context" } : link
          ))
        });
        return drafts.objects.map((object) => object.object_id === changed.object_id ? changed : object);
      }
    },
    {
      label: "proposal confidence evidence omission",
      expected: "research-evidence-conflict",
      mutate: (drafts: ReturnType<typeof researchResolutionDrafts>) => {
        const payload = drafts.fact.payload.data as CanonicalFactPayload;
        const changed = withResolutionPayload(drafts.fact, {
          confidence: { ...payload.confidence, evidence_refs: [drafts.evidence[1]!.object_id] }
        });
        return drafts.objects.map((object) => object.object_id === changed.object_id ? changed : object);
      }
    },
    {
      label: "reversed proposal evidence order",
      expected: "research-evidence-conflict",
      mutate: (drafts: ReturnType<typeof researchResolutionDrafts>) => {
        const payload = drafts.fact.payload.data as CanonicalFactPayload;
        const changed = withResolutionPayload(drafts.fact, {
          evidence_links: [...payload.evidence_links].reverse(),
          confidence: { ...payload.confidence, evidence_refs: [...payload.confidence.evidence_refs].reverse() }
        });
        return drafts.objects.map((object) => object.object_id === changed.object_id ? changed : object);
      }
    },
    {
      label: "low proposal assertion confidence",
      expected: "research-evidence-conflict",
      mutate: (drafts: ReturnType<typeof researchResolutionDrafts>) => {
        const payload = drafts.fact.payload.data as CanonicalFactPayload;
        const changed = withResolutionPayload(drafts.fact, {
          confidence: { ...payload.confidence, band: "low" }
        });
        return drafts.objects.map((object) => object.object_id === changed.object_id ? changed : object);
      }
    },
    {
      label: "non-assertion proposal confidence kind",
      expected: "research-evidence-conflict",
      mutate: (drafts: ReturnType<typeof researchResolutionDrafts>) => {
        const payload = drafts.fact.payload.data as CanonicalFactPayload;
        const changed = withResolutionPayload(drafts.fact, {
          confidence: { ...payload.confidence, assessment_kind: "extraction" }
        });
        return drafts.objects.map((object) => object.object_id === changed.object_id ? changed : object);
      }
    },
    {
      label: "unmatched owner-source refutation",
      expected: "research-evidence-conflict",
      mutate: (drafts: ReturnType<typeof researchResolutionDrafts>) => {
        const payload = drafts.fact.payload.data as CanonicalFactPayload;
        const changed = withResolutionPayload(drafts.fact, {
          evidence_links: [
            ...payload.evidence_links,
            { evidence_id: drafts.ownerEvidence.object_id, stance: "refutes" }
          ],
          confidence: {
            ...payload.confidence,
            evidence_refs: [...payload.confidence.evidence_refs, drafts.ownerEvidence.object_id]
          }
        });
        return drafts.objects.map((object) => object.object_id === changed.object_id ? changed : object);
      }
    },
    {
      label: "missing identity confidence evidence reference",
      expected: "resolution-missing-reference",
      mutate: (drafts: ReturnType<typeof researchResolutionDrafts>) => {
        const payload = drafts.results[0]!.payload.data as Record<string, unknown>;
        const identity = payload.identity_confidence as Record<string, unknown>;
        const changed = withResolutionPayload(drafts.results[0]!, {
          identity_confidence: {
            ...identity,
            evidence_refs: [drafts.evidence[0]!.object_id, "la_object_missingresearchidentityevidence0001"]
          }
        });
        return drafts.objects.map((object) => object.object_id === changed.object_id ? changed : object);
      }
    }
  ])("rejects research tuple mismatch: $label", async ({ label, expected, mutate }) => {
    const suffix = researchHash(label).slice("sha256:".length, "sha256:".length + 12);
    const token = `local-token-research-tuple-${suffix}`;
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-research-tuple-"));
    try {
      const controlState = await createFixtureLocalControlState(token);
      const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
      const graphStore = await FileLocalGraphStore.open({
        directory,
        authorityId: controlState.authority_id,
        plaintextPersistence: "encrypt",
        keyring
      });
      const drafts = researchResolutionDrafts({
        connectors: ["public-web", "organization"],
        namespace: `tuple-${suffix}`
      });
      await expect(graphStore.initializeFromObjects([
        drafts.currentReview,
        drafts.ownerEvidence
      ] as never)).resolves.toMatchObject({ ok: true });
      const context = createLocalMcpContextFromControlState({
        controlState,
        graphStore,
        decryptPayload: decryptWithKeyring(keyring),
        auditSink: new InMemoryLocalMcpAuditSink(),
        outboxSink: new InMemoryLocalMcpMutationOutboxSink(),
        now
      });

      await expect(localResolutionApply(context, {
        authorization: `Bearer ${token}`,
        operation_id: `la_operation_researchtuple${suffix}`,
        idempotency_key: `la_idem_researchtuple${suffix}`,
        candidate_id: drafts.candidateId,
        expected_generation: 0,
        expected_review_version: 1,
        objects: mutate(drafts)
      })).resolves.toEqual({ ok: false, reason: expected });
      expect(graphStore.status()).toMatchObject({ generation: 0, object_count: 2 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("recomputes the deterministic research run ID at the mutation boundary", async () => {
    const token = "local-token-research-forged-run-0001";
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-research-forged-run-"));
    try {
      const controlState = await createFixtureLocalControlState(token);
      const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
      const graphStore = await FileLocalGraphStore.open({
        directory,
        authorityId: controlState.authority_id,
        plaintextPersistence: "encrypt",
        keyring
      });
      const drafts = researchResolutionDrafts({ connectors: ["public-web", "organization"] });
      await expect(graphStore.initializeFromObjects([
        drafts.currentReview,
        drafts.ownerEvidence
      ] as never)).resolves.toMatchObject({ ok: true });
      const forgedResult = withResolutionPayload(drafts.results[0]!, {
        run_id: "la_research_run_bbbbbbbbbbbbbbbbbbbbbbbb"
      });
      const objects = drafts.objects.map((object) => (
        object.object_id === forgedResult.object_id ? forgedResult : object
      ));
      const context = createLocalMcpContextFromControlState({
        controlState,
        graphStore,
        decryptPayload: decryptWithKeyring(keyring),
        auditSink: new InMemoryLocalMcpAuditSink(),
        outboxSink: new InMemoryLocalMcpMutationOutboxSink(),
        now
      });

      await expect(localResolutionApply(context, {
        authorization: `Bearer ${token}`,
        operation_id: "la_operation_researchforgedrun0001",
        idempotency_key: "la_idem_researchforgedrun0001",
        candidate_id: drafts.candidateId,
        expected_generation: 0,
        expected_review_version: 1,
        objects
      })).resolves.toEqual({ ok: false, reason: "research-evidence-conflict" });
      expect(graphStore.status()).toMatchObject({ generation: 0, object_count: 2 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects independently corroborated mixed proposals for one source unit", async () => {
    const token = "local-token-research-mixed-proposal-0001";
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-research-mixed-proposal-"));
    try {
      const controlState = await createFixtureLocalControlState(token);
      const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
      const graphStore = await FileLocalGraphStore.open({
        directory,
        authorityId: controlState.authority_id,
        plaintextPersistence: "encrypt",
        keyring
      });
      const left = researchResolutionDrafts({
        connectors: ["public-web", "organization"],
        namespace: "left",
        factPredicate: "status",
        factValue: { kind: "text", value: "Synthetic active" }
      });
      const right = researchResolutionDrafts({
        connectors: ["public-web", "organization"],
        namespace: "right",
        factPredicate: "status",
        factValue: { kind: "text", value: "Synthetic inactive" }
      });
      await expect(graphStore.initializeFromObjects([
        left.currentReview,
        left.ownerEvidence
      ] as never)).resolves.toMatchObject({ ok: true });
      const review = withResolutionPayload(left.review, {
        proposed_object_ids: [
          left.entity.object_id,
          ...left.evidence.map((item) => item.object_id),
          ...right.evidence.map((item) => item.object_id),
          left.fact.object_id,
          right.fact.object_id,
          ...left.results.map((item) => item.object_id),
          ...right.results.map((item) => item.object_id)
        ]
      });
      const parity = withResolutionPayload(left.parity, {
        canonical_object_ids: [left.fact.object_id, right.fact.object_id]
      });
      const objects = [
        left.entity,
        ...left.evidence,
        ...right.evidence,
        left.fact,
        right.fact,
        ...left.results,
        ...right.results,
        review,
        parity
      ];
      const context = createLocalMcpContextFromControlState({
        controlState,
        graphStore,
        decryptPayload: decryptWithKeyring(keyring),
        auditSink: new InMemoryLocalMcpAuditSink(),
        outboxSink: new InMemoryLocalMcpMutationOutboxSink(),
        now
      });

      await expect(localResolutionApply(context, {
        authorization: `Bearer ${token}`,
        operation_id: "la_operation_researchmixedproposal0001",
        idempotency_key: "la_idem_researchmixedproposal0001",
        candidate_id: left.candidateId,
        expected_generation: 0,
        expected_review_version: 1,
        objects
      })).resolves.toEqual({ ok: false, reason: "research-evidence-conflict" });
      expect(graphStore.status()).toMatchObject({ generation: 0, object_count: 2 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("lets any owner-review research group dominate an earlier insufficient group", async () => {
    const token = "local-token-research-outcome-precedence-0001";
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-research-outcome-precedence-"));
    try {
      const controlState = await createFixtureLocalControlState(token);
      const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
      const graphStore = await FileLocalGraphStore.open({
        directory,
        authorityId: controlState.authority_id,
        plaintextPersistence: "encrypt",
        keyring
      });
      const left = researchResolutionDrafts({
        connectors: ["public-web", "organization", "public-web"],
        namespace: "precedence-left",
        factPredicate: "status",
        factValue: { kind: "text", value: "Synthetic precedence left" }
      });
      const right = researchResolutionDrafts({
        connectors: ["public-web", "organization", "public-web"],
        namespace: "precedence-right",
        factPredicate: "status",
        factValue: { kind: "text", value: "Synthetic precedence right" }
      });
      const rightUnitId = fixedHash("2");
      const rightResults = right.results.map((result) => {
        const payload = result.payload.data as Record<string, unknown>;
        const runId = canonicalResearchRunId({
          candidate_id: right.candidateId,
          source_unit_id: rightUnitId,
          connector_kind: payload.connector_kind as CanonicalResearchConnectorKind,
          normalized_query_hash: String(payload.normalized_query_hash),
          algorithm_version: String(payload.algorithm_version)
        });
        const resultId = canonicalResearchResultId({
          run_id: runId,
          evidence_id: String(payload.evidence_id),
          proposed_mutation_hash: String(payload.proposed_mutation_hash)
        });
        return {
          ...result,
          object_id: resultId,
          payload: {
            ...result.payload,
            data: {
              ...payload,
              research_result_id: resultId,
              run_id: runId,
              source_unit_id: rightUnitId
            }
          }
        };
      });
      const leftMin = [...left.results].sort((a, b) => a.object_id.localeCompare(b.object_id))[0]!.object_id;
      const rightMin = [...rightResults].sort((a, b) => a.object_id.localeCompare(b.object_id))[0]!.object_id;
      const firstIsLeft = leftMin < rightMin;
      const first = firstIsLeft
        ? { base: left, results: left.results, unitId: left.sourceUnitId }
        : { base: right, results: rightResults, unitId: rightUnitId };
      const second = firstIsLeft
        ? { base: right, results: rightResults, unitId: rightUnitId }
        : { base: left, results: left.results, unitId: left.sourceUnitId };
      const firstResult = [...first.results].sort((a, b) => a.object_id.localeCompare(b.object_id))[0]!;
      const firstEvidenceId = String((firstResult.payload.data as Record<string, unknown>).evidence_id);
      const firstEvidence = first.base.evidence.find((item) => item.object_id === firstEvidenceId)!;
      const firstFactPayload = first.base.fact.payload.data as CanonicalFactPayload;
      const insufficientFact = withResolutionPayload(first.base.fact, {
        evidence_links: [{ evidence_id: firstEvidence.object_id, stance: "supports" }],
        confidence: { ...firstFactPayload.confidence, evidence_refs: [firstEvidence.object_id] }
      });
      const refutingResult = second.results[second.results.length - 1]!;
      const conflictResults = second.results.map((result) => (
        result.object_id === refutingResult.object_id ? withResolutionPayload(result, { stance: "refutes" }) : result
      ));
      const secondFactPayload = second.base.fact.payload.data as CanonicalFactPayload;
      const refutingEvidenceId = String((refutingResult.payload.data as Record<string, unknown>).evidence_id);
      const conflictFact = withResolutionPayload(second.base.fact, {
        evidence_links: secondFactPayload.evidence_links.map((link) => (
          link.evidence_id === refutingEvidenceId ? { ...link, stance: "refutes" } : link
        ))
      });
      const currentReview = withResolutionPayload(left.currentReview, {
        research_requested_unit_hashes: [first.unitId, second.unitId]
      });
      const review = withResolutionPayload(left.review, {
        proposed_object_ids: [
          left.entity.object_id,
          firstEvidence.object_id,
          ...second.base.evidence.map((item) => item.object_id),
          insufficientFact.object_id,
          conflictFact.object_id,
          firstResult.object_id,
          ...conflictResults.map((item) => item.object_id)
        ],
        research_requested_unit_hashes: [first.unitId, second.unitId]
      });
      const parity = withResolutionPayload(left.parity, {
        canonical_object_ids: [insufficientFact.object_id, conflictFact.object_id]
      });
      const objects = [
        left.entity,
        firstEvidence,
        ...second.base.evidence,
        insufficientFact,
        conflictFact,
        firstResult,
        ...conflictResults,
        review,
        parity
      ];
      await expect(graphStore.initializeFromObjects([
        currentReview,
        left.ownerEvidence
      ] as never)).resolves.toMatchObject({ ok: true });
      const auditSink = new InMemoryLocalMcpAuditSink();
      const context = createLocalMcpContextFromControlState({
        controlState,
        graphStore,
        decryptPayload: decryptWithKeyring(keyring),
        auditSink,
        outboxSink: new InMemoryLocalMcpMutationOutboxSink(),
        now
      });

      await expect(localResolutionApply(context, {
        authorization: `Bearer ${token}`,
        operation_id: "la_operation_researchoutcomeprecedence0001",
        idempotency_key: "la_idem_researchoutcomeprecedence0001",
        candidate_id: left.candidateId,
        expected_generation: 0,
        expected_review_version: 1,
        objects
      })).resolves.toEqual({ ok: false, reason: "research-evidence-conflict" });
      expect(auditSink.events.find((event) => event.reason_code === "research-evidence-conflict"))
        .toMatchObject({ research: { outcome: "owner-review" } });
      expect(graphStore.status()).toMatchObject({ generation: 0, journal_sequence: 0 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects an unevaluated sibling fact smuggled beside a qualifying research proposal", async () => {
    const token = "local-token-research-sibling-smuggle-0001";
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-research-sibling-smuggle-"));
    try {
      const controlState = await createFixtureLocalControlState(token);
      const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
      const graphStore = await FileLocalGraphStore.open({
        directory,
        authorityId: controlState.authority_id,
        plaintextPersistence: "encrypt",
        keyring
      });
      const drafts = researchResolutionDrafts({ connectors: ["public-web", "organization"] });
      const siblingId = "la_object_researchsiblingsmuggle0001";
      const sibling = canonicalResolutionDraft(drafts.fact, siblingId, "assertion", {
        schema: "atlas.fact:v1",
        assertion_id: siblingId,
        subject_entity_id: drafts.entity.object_id,
        predicate: "description",
        value: { kind: "text", value: "Synthetic unevaluated sibling fact." },
        recorded_at: now,
        lineage_action: "assert",
        supersedes: [],
        evidence_links: [{ evidence_id: drafts.ownerEvidence.object_id, stance: "supports" }],
        confidence: {
          band: "high",
          assessment_kind: "extraction",
          method: "canonical-source-unit-v1",
          assessed_at: now,
          evidence_refs: [drafts.ownerEvidence.object_id]
        }
      });
      const review = withResolutionPayload(drafts.review, {
        proposed_object_ids: [
          ...(drafts.review.payload.data.proposed_object_ids as string[]),
          drafts.ownerEvidence.object_id,
          siblingId
        ]
      });
      const parity = withResolutionPayload(drafts.parity, {
        canonical_object_ids: [drafts.fact.object_id, siblingId]
      });
      const objects = [
        ...drafts.objects.filter((object) => object.object_id !== review.object_id && object.object_id !== parity.object_id),
        sibling,
        review,
        parity
      ];
      await expect(graphStore.initializeFromObjects([
        drafts.currentReview,
        drafts.ownerEvidence
      ] as never)).resolves.toMatchObject({ ok: true });
      const outboxSink = new InMemoryLocalMcpMutationOutboxSink();
      const context = createLocalMcpContextFromControlState({
        controlState,
        graphStore,
        decryptPayload: decryptWithKeyring(keyring),
        auditSink: new InMemoryLocalMcpAuditSink(),
        outboxSink,
        now
      });

      await expect(localResolutionApply(context, {
        authorization: `Bearer ${token}`,
        operation_id: "la_operation_researchsiblingsmuggle0001",
        idempotency_key: "la_idem_researchsiblingsmuggle0001",
        candidate_id: drafts.candidateId,
        expected_generation: 0,
        expected_review_version: 1,
        objects
      })).resolves.toEqual({ ok: false, reason: "research-evidence-conflict" });
      expect(graphStore.status()).toMatchObject({ generation: 0, journal_sequence: 0 });
      expect(graphStore.readObject(siblingId)).toBeUndefined();
      expect(outboxSink.records).toHaveLength(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects different bytes at an existing deterministic research result ID", async () => {
    const token = "local-token-research-result-collision-0001";
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-research-result-collision-"));
    try {
      const controlState = await createFixtureLocalControlState(token);
      const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
      const graphStore = await FileLocalGraphStore.open({
        directory,
        authorityId: controlState.authority_id,
        plaintextPersistence: "encrypt",
        keyring
      });
      const drafts = researchResolutionDrafts({ connectors: ["public-web", "organization"] });
      await expect(graphStore.initializeFromObjects([
        drafts.currentReview,
        drafts.ownerEvidence,
        drafts.evidence[0]!,
        drafts.results[0]!
      ] as never)).resolves.toMatchObject({ ok: true });
      const changedResult = withResolutionPayload(drafts.results[0]!, {
        recorded_at: "2026-06-22T12:00:00.000Z"
      });
      const objects = drafts.objects.map((object) => (
        object.object_id === changedResult.object_id ? changedResult : object
      ));
      const context = createLocalMcpContextFromControlState({
        controlState,
        graphStore,
        decryptPayload: decryptWithKeyring(keyring),
        auditSink: new InMemoryLocalMcpAuditSink(),
        outboxSink: new InMemoryLocalMcpMutationOutboxSink(),
        now
      });

      await expect(localResolutionApply(context, {
        authorization: `Bearer ${token}`,
        operation_id: "la_operation_researchresultcollision0001",
        idempotency_key: "la_idem_researchresultcollision0001",
        candidate_id: drafts.candidateId,
        expected_generation: 0,
        expected_review_version: 1,
        objects
      })).resolves.toEqual({ ok: false, reason: "research-evidence-conflict" });
      expect(graphStore.status()).toMatchObject({ generation: 0, object_count: 4 });
      expect(graphStore.readObject(drafts.results[0]!.object_id)).toMatchObject({ version: 1 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects different bytes at an existing deterministic research evidence ID", async () => {
    const token = "local-token-research-evidence-collision-0001";
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-research-evidence-collision-"));
    try {
      const controlState = await createFixtureLocalControlState(token);
      const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
      const graphStore = await FileLocalGraphStore.open({
        directory,
        authorityId: controlState.authority_id,
        plaintextPersistence: "encrypt",
        keyring
      });
      const drafts = researchResolutionDrafts({ connectors: ["public-web", "organization"] });
      await expect(graphStore.initializeFromObjects([
        drafts.currentReview,
        drafts.ownerEvidence,
        drafts.evidence[0]!
      ] as never)).resolves.toMatchObject({ ok: true });
      const changedAt = "2026-06-22T12:00:00.000Z";
      const changedEvidence = withResolutionPayload(drafts.evidence[0]!, { retrieved_at: changedAt });
      const changedResult = withResolutionPayload(drafts.results[0]!, { retrieved_at: changedAt });
      const objects = drafts.objects.map((object) => {
        if (object.object_id === changedEvidence.object_id) return changedEvidence;
        if (object.object_id === changedResult.object_id) return changedResult;
        return object;
      });
      const context = createLocalMcpContextFromControlState({
        controlState,
        graphStore,
        decryptPayload: decryptWithKeyring(keyring),
        auditSink: new InMemoryLocalMcpAuditSink(),
        outboxSink: new InMemoryLocalMcpMutationOutboxSink(),
        now
      });

      await expect(localResolutionApply(context, {
        authorization: `Bearer ${token}`,
        operation_id: "la_operation_researchevidencecollision0001",
        idempotency_key: "la_idem_researchevidencecollision0001",
        candidate_id: drafts.candidateId,
        expected_generation: 0,
        expected_review_version: 1,
        objects
      })).resolves.toEqual({ ok: false, reason: "research-evidence-conflict" });
      expect(graphStore.status()).toMatchObject({ generation: 0, object_count: 3 });
      expect(graphStore.readObject(drafts.evidence[0]!.object_id)).toMatchObject({ version: 1 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["result", "evidence"] as const)(
    "keeps durable research $recordKind append-only through an owner-review resolution", async (recordKind) => {
    const token = `local-token-research-owner-review-${recordKind}-rewrite-0001`;
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-research-owner-review-rewrite-"));
    try {
      const controlState = await createFixtureLocalControlState(token);
      const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
      const graphStore = await FileLocalGraphStore.open({
        directory,
        authorityId: controlState.authority_id,
        plaintextPersistence: "encrypt",
        keyring
      });
      const drafts = researchResolutionDrafts({ connectors: ["public-web", "organization"] });
      await expect(graphStore.initializeFromObjects([
        drafts.currentReview,
        drafts.ownerEvidence,
        drafts.entity,
        ...drafts.evidence,
        drafts.fact,
        ...drafts.results
      ] as never)).resolves.toMatchObject({ ok: true });
      const changedRecord = recordKind === "result"
        ? withResolutionPayload(drafts.results[0]!, { identity_state: "ambiguous" })
        : withResolutionPayload(drafts.evidence[0]!, { retrieved_at: "2026-06-22T12:00:00.000Z" });
      changedRecord.version = 2;
      const ownerReview = withResolutionPayload(drafts.review, {
        recommendation: "owner-review",
        resolution_state: "owner-review"
      });
      const context = createLocalMcpContextFromControlState({
        controlState,
        graphStore,
        decryptPayload: decryptWithKeyring(keyring),
        auditSink: new InMemoryLocalMcpAuditSink(),
        outboxSink: new InMemoryLocalMcpMutationOutboxSink(),
        now
      });

      await expect(localResolutionApply(context, {
        authorization: `Bearer ${token}`,
        operation_id: "la_operation_researchownerreviewrewrite0001",
        idempotency_key: "la_idem_researchownerreviewrewrite0001",
        candidate_id: drafts.candidateId,
        expected_generation: 0,
        expected_review_version: 1,
        objects: [changedRecord, ownerReview, drafts.parity]
      })).resolves.toEqual({ ok: false, reason: "research-evidence-conflict" });
      expect(graphStore.status()).toMatchObject({ generation: 0, journal_sequence: 0 });
      expect(graphStore.readObject(changedRecord.object_id)).toMatchObject({ version: 1 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps distinct immutable-research collision attempts distinct in the redacted audit", async () => {
    const token = "local-token-research-collision-audit-0001";
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-research-collision-audit-"));
    try {
      const controlState = await createFixtureLocalControlState(token);
      const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
      const graphStore = await FileLocalGraphStore.open({
        directory,
        authorityId: controlState.authority_id,
        plaintextPersistence: "encrypt",
        keyring
      });
      const drafts = researchResolutionDrafts({ connectors: ["public-web", "organization"] });
      await expect(graphStore.initializeFromObjects([
        drafts.currentReview,
        drafts.ownerEvidence,
        drafts.entity,
        ...drafts.evidence,
        drafts.fact,
        ...drafts.results
      ] as never)).resolves.toMatchObject({ ok: true });
      const ownerReview = withResolutionPayload(drafts.review, {
        recommendation: "owner-review",
        resolution_state: "owner-review"
      });
      const auditSink = new InMemoryLocalMcpAuditSink();
      const context = createLocalMcpContextFromControlState({
        controlState,
        graphStore,
        decryptPayload: decryptWithKeyring(keyring),
        auditSink,
        outboxSink: new InMemoryLocalMcpMutationOutboxSink(),
        now
      });
      const baseRequest = {
        authorization: `Bearer ${token}`,
        operation_id: "la_operation_researchcollisionaudit0001",
        idempotency_key: "la_idem_researchcollisionaudit0001",
        candidate_id: drafts.candidateId,
        expected_generation: 0,
        expected_review_version: 1
      };

      for (const result of drafts.results) {
        const changed = withResolutionPayload(result, { identity_state: "ambiguous" });
        changed.version = 2;
        await expect(localResolutionApply(context, {
          ...baseRequest,
          objects: [changed, ownerReview, drafts.parity]
        })).resolves.toEqual({ ok: false, reason: "research-evidence-conflict" });
      }

      const denied = auditSink.events.filter((event) => event.reason_code === "research-evidence-conflict");
      expect(denied).toHaveLength(2);
      expect(denied.every((event) => event.research?.outcome === "owner-review")).toBe(true);
      expect(new Set(denied.map((event) => event.research?.result_set_hash)).size).toBe(2);
      expect(graphStore.status()).toMatchObject({ generation: 0, journal_sequence: 0 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("derives a collision audit from existing provenance when an attempt strips research links", async () => {
    const token = "local-token-research-provenance-strip-audit-0001";
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-research-provenance-strip-audit-"));
    try {
      const controlState = await createFixtureLocalControlState(token);
      const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
      const graphStore = await FileLocalGraphStore.open({
        directory,
        authorityId: controlState.authority_id,
        plaintextPersistence: "encrypt",
        keyring
      });
      const drafts = researchResolutionDrafts();
      await expect(graphStore.initializeFromObjects([
        drafts.currentReview,
        drafts.ownerEvidence,
        drafts.entity,
        ...drafts.evidence,
        drafts.fact,
        ...drafts.results
      ] as never)).resolves.toMatchObject({ ok: true });
      const factPayload = drafts.fact.payload.data as CanonicalFactPayload;
      const strippedFact = withResolutionPayload(drafts.fact, {
        evidence_links: [{ evidence_id: drafts.ownerEvidence.object_id, stance: "supports" }],
        confidence: { ...factPayload.confidence, evidence_refs: [drafts.ownerEvidence.object_id] }
      });
      strippedFact.version = 2;
      const ownerReview = withResolutionPayload(drafts.review, {
        recommendation: "owner-review",
        resolution_state: "owner-review",
        proposed_object_ids: [
          ...(drafts.review.payload.data.proposed_object_ids as string[]),
          drafts.ownerEvidence.object_id
        ]
      });
      const auditSink = new InMemoryLocalMcpAuditSink();
      const context = createLocalMcpContextFromControlState({
        controlState,
        graphStore,
        decryptPayload: decryptWithKeyring(keyring),
        auditSink,
        outboxSink: new InMemoryLocalMcpMutationOutboxSink(),
        now
      });

      await expect(localResolutionApply(context, {
        authorization: `Bearer ${token}`,
        operation_id: "la_operation_researchprovenancestripaudit0001",
        idempotency_key: "la_idem_researchprovenancestripaudit0001",
        candidate_id: drafts.candidateId,
        expected_generation: 0,
        expected_review_version: 1,
        objects: [strippedFact, ownerReview, drafts.parity]
      })).resolves.toEqual({ ok: false, reason: "research-evidence-conflict" });
      expect(auditSink.events).toContainEqual(expect.objectContaining({
        reason_code: "research-evidence-conflict",
        research: expect.objectContaining({
          connector_kinds: ["public-web"],
          outcome: "owner-review",
          result_set_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)
        })
      }));
      expect(graphStore.status()).toMatchObject({ generation: 0, journal_sequence: 0 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps a new non-auto research result in the review workspace", async () => {
    const token = "local-token-non-auto-result-workspace-0001";
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-non-auto-result-workspace-"));
    try {
      const controlState = await createFixtureLocalControlState(token);
      const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
      const graphStore = await FileLocalGraphStore.open({
        directory,
        authorityId: controlState.authority_id,
        plaintextPersistence: "encrypt",
        keyring
      });
      const drafts = researchResolutionDrafts();
      await expect(graphStore.initializeFromObjects([
        drafts.currentReview,
        drafts.ownerEvidence,
        drafts.entity,
        drafts.evidence[0]!,
        drafts.fact
      ] as never)).resolves.toMatchObject({ ok: true });
      const ownerReview = withResolutionPayload(drafts.review, {
        recommendation: "owner-review",
        resolution_state: "owner-review"
      });
      const context = createLocalMcpContextFromControlState({
        controlState,
        graphStore,
        decryptPayload: decryptWithKeyring(keyring),
        auditSink: new InMemoryLocalMcpAuditSink(),
        outboxSink: new InMemoryLocalMcpMutationOutboxSink(),
        now
      });

      await expect(localResolutionApply(context, {
        authorization: `Bearer ${token}`,
        operation_id: "la_operation_nonautoresultworkspace0001",
        idempotency_key: "la_idem_nonautoresultworkspace0001",
        candidate_id: drafts.candidateId,
        expected_generation: 0,
        expected_review_version: 1,
        objects: [drafts.results[0]!, ownerReview, drafts.parity]
      })).resolves.toEqual({ ok: false, reason: "research-evidence-conflict" });
      expect(graphStore.status()).toMatchObject({ generation: 0, journal_sequence: 0 });
      expect(graphStore.readObject(drafts.results[0]!.object_id)).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps standalone non-auto research evidence in the review workspace", async () => {
    const token = "local-token-non-auto-evidence-workspace-0001";
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-non-auto-evidence-workspace-"));
    try {
      const controlState = await createFixtureLocalControlState(token);
      const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
      const graphStore = await FileLocalGraphStore.open({
        directory,
        authorityId: controlState.authority_id,
        plaintextPersistence: "encrypt",
        keyring
      });
      const current = canonicalResolutionDrafts(1);
      const final = canonicalResolutionDrafts(2);
      const researchEvidence = researchResolutionDrafts().evidence[0]!;
      await expect(graphStore.initializeFromObjects([
        current.entity,
        current.evidence,
        current.fact,
        current.review
      ] as never)).resolves.toMatchObject({ ok: true });
      const ownerReview = withResolutionPayload(final.review, {
        recommendation: "owner-review",
        resolution_state: "owner-review",
        proposed_object_ids: [
          ...(final.review.payload.data.proposed_object_ids as string[]),
          researchEvidence.object_id
        ]
      });
      const context = createLocalMcpContextFromControlState({
        controlState,
        graphStore,
        decryptPayload: decryptWithKeyring(keyring),
        auditSink: new InMemoryLocalMcpAuditSink(),
        outboxSink: new InMemoryLocalMcpMutationOutboxSink(),
        now
      });

      await expect(localResolutionApply(context, {
        authorization: `Bearer ${token}`,
        operation_id: "la_operation_nonautoevidenceworkspace0001",
        idempotency_key: "la_idem_nonautoevidenceworkspace0001",
        candidate_id: final.candidateId,
        expected_generation: 0,
        expected_review_version: 1,
        objects: [researchEvidence, ownerReview, final.parity]
      })).resolves.toEqual({ ok: false, reason: "research-evidence-conflict" });
      expect(graphStore.status()).toMatchObject({ generation: 0, journal_sequence: 0 });
      expect(graphStore.readObject(researchEvidence.object_id)).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects provenance drift at an existing deterministic research proposal ID", async () => {
    const token = "local-token-research-proposal-collision-0001";
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-research-proposal-collision-"));
    try {
      const controlState = await createFixtureLocalControlState(token);
      const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
      const graphStore = await FileLocalGraphStore.open({
        directory,
        authorityId: controlState.authority_id,
        plaintextPersistence: "encrypt",
        keyring
      });
      const drafts = researchResolutionDrafts({ connectors: ["public-web", "organization"] });
      const proposal = drafts.fact.payload.data as CanonicalFactPayload;
      const existingProposal = withResolutionPayload(drafts.fact, {
        evidence_links: [proposal.evidence_links[0]],
        confidence: { ...proposal.confidence, evidence_refs: [drafts.evidence[0]!.object_id] }
      });
      await expect(graphStore.initializeFromObjects([
        drafts.currentReview,
        drafts.ownerEvidence,
        existingProposal
      ] as never)).resolves.toMatchObject({ ok: true });
      const changedProposal = { ...drafts.fact, version: 2 };
      const objects = drafts.objects.map((object) => (
        object.object_id === changedProposal.object_id ? changedProposal : object
      ));
      const outboxSink = new InMemoryLocalMcpMutationOutboxSink();
      const context = createLocalMcpContextFromControlState({
        controlState,
        graphStore,
        decryptPayload: decryptWithKeyring(keyring),
        auditSink: new InMemoryLocalMcpAuditSink(),
        outboxSink,
        now
      });

      await expect(localResolutionApply(context, {
        authorization: `Bearer ${token}`,
        operation_id: "la_operation_researchproposalcollision0001",
        idempotency_key: "la_idem_researchproposalcollision0001",
        candidate_id: drafts.candidateId,
        expected_generation: 0,
        expected_review_version: 1,
        objects
      })).resolves.toEqual({ ok: false, reason: "research-evidence-conflict" });
      expect(graphStore.status()).toMatchObject({ generation: 0, journal_sequence: 0 });
      expect(graphStore.readObject(existingProposal.object_id)).toMatchObject({ version: 1 });
      expect(outboxSink.records).toHaveLength(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    { operation: "update" as const, decryptMode: "available" as const },
    { operation: "tombstone" as const, decryptMode: "available" as const },
    { operation: "update" as const, decryptMode: "missing" as const },
    { operation: "tombstone" as const, decryptMode: "missing" as const },
    { operation: "update" as const, decryptMode: "throwing" as const },
    { operation: "tombstone" as const, decryptMode: "throwing" as const }
  ])(
    "keeps canonical research records append-only through generic $operation with $decryptMode decryption",
    async ({ operation, decryptMode }) => {
      const token = `local-token-research-immutable-${operation}-${decryptMode}-0001`;
      const directory = await mkdtemp(join(tmpdir(), "living-atlas-research-immutable-"));
      try {
        const controlState = await createFixtureLocalControlState(token);
        const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
        const graphStore = await FileLocalGraphStore.open({
          directory,
          authorityId: controlState.authority_id,
          plaintextPersistence: "encrypt",
          keyring
        });
        const drafts = researchResolutionDrafts();
        const result = drafts.results[0]!;
        await expect(graphStore.initializeFromObjects([result] as never)).resolves.toMatchObject({ ok: true });
        const context = createLocalMcpContextFromControlState({
          controlState,
          graphStore,
          ...(decryptMode === "available"
            ? { decryptPayload: decryptWithKeyring(keyring) }
            : decryptMode === "throwing"
              ? { decryptPayload: async () => { throw new Error("synthetic decrypt failure"); } }
              : {}),
          auditSink: new InMemoryLocalMcpAuditSink(),
          now
        });

        const mutation = operation === "update"
          ? localUpdateObject(context, {
              authorization: `Bearer ${token}`,
              object_id: result.object_id,
              expected_version: 1,
              patch: { visible_metadata: { size_class: "small" } }
            })
          : localTombstoneObject(context, {
              authorization: `Bearer ${token}`,
              object_id: result.object_id,
              expected_version: 1
            });
        await expect(mutation).resolves.toEqual({ ok: false, reason: "research-record-immutable" });
        expect(graphStore.status()).toMatchObject({ generation: 0, journal_sequence: 0 });
        expect(graphStore.readObject(result.object_id)).toMatchObject({ version: 1 });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

  it.each(["update", "tombstone"] as const)(
    "keeps source-classified public evidence immutable through generic $operation", async (operation) => {
      const token = `local-token-public-evidence-${operation}-immutable-0001`;
      const directory = await mkdtemp(join(tmpdir(), "living-atlas-public-evidence-immutable-"));
      try {
        const controlState = await createFixtureLocalControlState(token);
        const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
        const graphStore = await FileLocalGraphStore.open({
          directory,
          authorityId: controlState.authority_id,
          plaintextPersistence: "encrypt",
          keyring
        });
        const evidence = withResolutionPayload(researchResolutionDrafts().evidence[0]!, {
          extraction_method: undefined
        });
        await expect(graphStore.initializeFromObjects([evidence] as never)).resolves.toMatchObject({ ok: true });
        const context = createLocalMcpContextFromControlState({
          controlState,
          graphStore,
          decryptPayload: decryptWithKeyring(keyring),
          auditSink: new InMemoryLocalMcpAuditSink(),
          now
        });

        const mutation = operation === "update"
          ? localUpdateObject(context, {
              authorization: `Bearer ${token}`,
              object_id: evidence.object_id,
              expected_version: 1,
              patch: { content_hash: fixedHash("f") }
            })
          : localTombstoneObject(context, {
              authorization: `Bearer ${token}`,
              object_id: evidence.object_id,
              expected_version: 1
            });
        await expect(mutation).resolves.toEqual({ ok: false, reason: "research-record-immutable" });
        expect(graphStore.status()).toMatchObject({ generation: 0, journal_sequence: 0 });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

  it("allows correcting an immutable research record while a migration window is open (ADR-0010)", async () => {
    const token = "local-token-migration-window-mutable-0001";
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-migration-window-mutable-"));
    try {
      const controlState = await createFixtureLocalControlState(token);
      const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
      const graphStore = await FileLocalGraphStore.open({
        directory,
        authorityId: controlState.authority_id,
        plaintextPersistence: "encrypt",
        keyring
      });
      const evidence = withResolutionPayload(researchResolutionDrafts().evidence[0]!, {
        extraction_method: undefined
      });
      await expect(graphStore.initializeFromObjects([evidence] as never)).resolves.toMatchObject({ ok: true });
      const context = createLocalMcpContextFromControlState({
        controlState,
        graphStore,
        decryptPayload: decryptWithKeyring(keyring),
        auditSink: new InMemoryLocalMcpAuditSink(),
        now
      });

      // While live, the research record is append-only immutable.
      await expect(localUpdateObject(context, {
        authorization: `Bearer ${token}`,
        object_id: evidence.object_id,
        expected_version: 1,
        patch: { content_hash: fixedHash("f") }
      })).resolves.toEqual({ ok: false, reason: "research-record-immutable" });

      // Opening a bounded migration window suspends per-record immutability.
      await expect(graphStore.openMigrationWindow({ reason: "bulk correction", actor_id: "owner-1" }))
        .resolves.toMatchObject({ ok: true });

      const corrected = await localUpdateObject(context, {
        authorization: `Bearer ${token}`,
        object_id: evidence.object_id,
        expected_version: 1,
        patch: { content_hash: fixedHash("f") }
      });
      expect(corrected).toMatchObject({ ok: true });
      expect(graphStore.readObject(evidence.object_id)).toMatchObject({ version: 2 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("migration_open and migration_seal drive the authority lifecycle through the MCP (ADR-0010)", async () => {
    const token = "local-token-migration-tools-0001";
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-migration-tools-"));
    try {
      const controlState = await createFixtureLocalControlState(token);
      const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
      const graphStore = await FileLocalGraphStore.open({
        directory,
        authorityId: controlState.authority_id,
        plaintextPersistence: "encrypt",
        keyring
      });
      const context = createLocalMcpContextFromControlState({
        controlState,
        graphStore,
        decryptPayload: decryptWithKeyring(keyring),
        auditSink: new InMemoryLocalMcpAuditSink(),
        now
      });

      const opened = await localMigrationOpen(context, {
        authorization: `Bearer ${token}`,
        reason: "logseq sunset corrections"
      });
      expect(opened).toMatchObject({ ok: true });
      expect(graphStore.status().lifecycle.state).toBe("migrating");

      const sealed = await localMigrationSeal(context, { authorization: `Bearer ${token}` });
      expect(sealed).toMatchObject({ ok: true });
      expect(graphStore.status().lifecycle.state).toBe("live");
      expect(graphStore.migrationHistory()).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    { recordKind: "fact" as const, operation: "update" as const },
    { recordKind: "fact" as const, operation: "tombstone" as const },
    { recordKind: "relationship" as const, operation: "update" as const },
    { recordKind: "relationship" as const, operation: "tombstone" as const }
  ])("keeps an applied research $recordKind append-only through generic $operation", async ({
    recordKind,
    operation
  }) => {
    const token = `local-token-research-${recordKind}-${operation}-immutable-0001`;
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-research-assertion-immutable-"));
    try {
      const controlState = await createFixtureLocalControlState(token);
      const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
      const graphStore = await FileLocalGraphStore.open({
        directory,
        authorityId: controlState.authority_id,
        plaintextPersistence: "encrypt",
        keyring
      });
      const fixture = (() => {
        if (recordKind === "fact") {
          const drafts = researchResolutionDrafts({ connectors: ["public-web", "organization"] });
          return { assertion: drafts.fact, evidence: drafts.evidence };
        }
        const drafts = researchRelationshipResolutionDrafts();
        return { assertion: drafts.relationship, evidence: drafts.evidence };
      })();
      const { assertion } = fixture;
      await expect(graphStore.initializeFromObjects([
        ...fixture.evidence,
        assertion
      ] as never)).resolves.toMatchObject({ ok: true });
      const context = createLocalMcpContextFromControlState({
        controlState,
        graphStore,
        decryptPayload: decryptWithKeyring(keyring),
        auditSink: new InMemoryLocalMcpAuditSink(),
        now
      });

      const mutation = operation === "update"
        ? localUpdateObject(context, {
            authorization: `Bearer ${token}`,
            object_id: assertion.object_id,
            expected_version: 1,
            patch: { content_hash: fixedHash("f") }
          })
        : localTombstoneObject(context, {
            authorization: `Bearer ${token}`,
            object_id: assertion.object_id,
            expected_version: 1
          });
      await expect(mutation).resolves.toEqual({ ok: false, reason: "research-record-immutable" });
      expect(graphStore.status()).toMatchObject({ generation: 0, journal_sequence: 0 });
      expect(graphStore.readObject(assertion.object_id)).toMatchObject({ version: 1 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["result", "evidence", "fact", "relationship"] as const)(
    "requires the atomic resolution path to create a research $recordKind", async (recordKind) => {
      const token = `local-token-research-${recordKind}-create-guard-0001`;
      const directory = await mkdtemp(join(tmpdir(), "living-atlas-research-create-guard-"));
      try {
        const controlState = await createFixtureLocalControlState(token);
        const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
        const graphStore = await FileLocalGraphStore.open({
          directory,
          authorityId: controlState.authority_id,
          plaintextPersistence: "encrypt",
          keyring
        });
        const fixture = (() => {
          if (recordKind === "relationship") {
            const drafts = researchRelationshipResolutionDrafts();
            return { object: drafts.relationship, evidence: drafts.evidence };
          }
          const drafts = researchResolutionDrafts({ connectors: ["public-web", "organization"] });
          const object = recordKind === "result"
            ? drafts.results[0]!
            : recordKind === "evidence"
              ? drafts.evidence[0]!
              : drafts.fact;
          return { object, evidence: drafts.evidence };
        })();
        const { object } = fixture;
        if (recordKind === "fact" || recordKind === "relationship") {
          await expect(graphStore.initializeFromObjects(fixture.evidence as never))
            .resolves.toMatchObject({ ok: true });
        }
        const context = createLocalMcpContextFromControlState({
          controlState,
          graphStore,
          decryptPayload: decryptWithKeyring(keyring),
          auditSink: new InMemoryLocalMcpAuditSink(),
          now
        });

        await expect(localCreateObject(context, {
          authorization: `Bearer ${token}`,
          object
        })).resolves.toEqual({ ok: false, reason: "research-record-requires-resolution" });
        expect(graphStore.readObject(object.object_id)).toBeUndefined();
        expect(graphStore.status()).toMatchObject({ generation: 0, journal_sequence: 0 });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

  it.each(["fact", "relationship"] as const)(
    "does not create a research $recordKind before its evidence", async (recordKind) => {
      const token = `local-token-research-${recordKind}-before-evidence-0001`;
      const directory = await mkdtemp(join(tmpdir(), "living-atlas-research-before-evidence-"));
      try {
        const controlState = await createFixtureLocalControlState(token);
        const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
        const graphStore = await FileLocalGraphStore.open({
          directory,
          authorityId: controlState.authority_id,
          plaintextPersistence: "encrypt",
          keyring
        });
        const object = recordKind === "fact"
          ? researchResolutionDrafts().fact
          : researchRelationshipResolutionDrafts().relationship;
        const context = createLocalMcpContextFromControlState({
          controlState,
          graphStore,
          decryptPayload: decryptWithKeyring(keyring),
          auditSink: new InMemoryLocalMcpAuditSink(),
          now
        });

        await expect(localCreateObject(context, {
          authorization: `Bearer ${token}`,
          object
        })).resolves.toEqual({ ok: false, reason: "research-record-requires-resolution" });
        expect(graphStore.status()).toMatchObject({ generation: 0, journal_sequence: 0, object_count: 0 });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

  it("does not generically create public evidence when its research marker is omitted", async () => {
    const token = "local-token-public-evidence-create-guard-0001";
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-public-evidence-create-guard-"));
    try {
      const controlState = await createFixtureLocalControlState(token);
      const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
      const graphStore = await FileLocalGraphStore.open({
        directory,
        authorityId: controlState.authority_id,
        plaintextPersistence: "encrypt",
        keyring
      });
      const evidence = withResolutionPayload(researchResolutionDrafts().evidence[0]!, {
        extraction_method: undefined
      });
      const context = createLocalMcpContextFromControlState({
        controlState,
        graphStore,
        decryptPayload: decryptWithKeyring(keyring),
        auditSink: new InMemoryLocalMcpAuditSink(),
        now
      });

      await expect(localCreateObject(context, {
        authorization: `Bearer ${token}`,
        object: evidence
      })).resolves.toEqual({ ok: false, reason: "research-record-requires-resolution" });
      expect(graphStore.status()).toMatchObject({ generation: 0, journal_sequence: 0, object_count: 0 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a malformed canonical research draft before generic persistence", async () => {
    const token = "local-token-malformed-research-create-0001";
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-malformed-research-create-"));
    try {
      const controlState = await createFixtureLocalControlState(token);
      const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
      const graphStore = await FileLocalGraphStore.open({
        directory,
        authorityId: controlState.authority_id,
        plaintextPersistence: "encrypt",
        keyring
      });
      const result = researchResolutionDrafts().results[0]!;
      const { schema: _schema, ...resultWithoutSchema } = result.payload.data;
      const malformed = {
        ...result,
        payload: {
          ...result.payload,
          data: { ...resultWithoutSchema, unbounded_profile: { synthetic: true } }
        }
      };
      const context = createLocalMcpContextFromControlState({
        controlState,
        graphStore,
        decryptPayload: decryptWithKeyring(keyring),
        auditSink: new InMemoryLocalMcpAuditSink(),
        now
      });

      await expect(localCreateObject(context, {
        authorization: `Bearer ${token}`,
        object: malformed as never
      })).resolves.toEqual({ ok: false, reason: "invalid-canonical-write" });
      expect(graphStore.status()).toMatchObject({ generation: 0, journal_sequence: 0, object_count: 0 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    { mode: "valid research ciphertext" as const, reason: "research-record-requires-resolution" },
    { mode: "unreadable Atlas ciphertext" as const, reason: "invalid-canonical-write" }
  ])("rejects $mode through generic create", async ({ mode, reason }) => {
    const token = `local-token-${mode.replaceAll(" ", "-")}-0001`;
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-ciphertext-create-guard-"));
    try {
      const controlState = await createFixtureLocalControlState(token);
      const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
      const sourceStore = await FileLocalGraphStore.open({
        directory: join(directory, "source"),
        authorityId: controlState.authority_id,
        plaintextPersistence: "encrypt",
        keyring
      });
      const targetStore = await FileLocalGraphStore.open({
        directory: join(directory, "target"),
        authorityId: controlState.authority_id,
        plaintextPersistence: "encrypt",
        keyring
      });
      const result = researchResolutionDrafts().results[0]!;
      await expect(sourceStore.initializeFromObjects([result] as never)).resolves.toMatchObject({ ok: true });
      const encrypted = sourceStore.readObject(result.object_id)!;
      const object = mode === "valid research ciphertext"
        ? encrypted
        : {
            ...encrypted,
            payload: encrypted.payload.kind === "ciphertext-inline"
              ? { ...encrypted.payload, ciphertext: `${encrypted.payload.ciphertext.slice(0, -4)}AAAA` }
              : encrypted.payload
          };
      const context = createLocalMcpContextFromControlState({
        controlState,
        graphStore: targetStore,
        decryptPayload: decryptWithKeyring(keyring),
        auditSink: new InMemoryLocalMcpAuditSink(),
        now
      });

      await expect(localCreateObject(context, {
        authorization: `Bearer ${token}`,
        object
      })).resolves.toEqual({ ok: false, reason });
      expect(targetStore.status()).toMatchObject({ generation: 0, journal_sequence: 0, object_count: 0 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["create", "update", "tombstone"] as const)(
    "reserves canonical review $operation for the resolution boundary", async (operation) => {
      const token = `local-token-review-${operation}-boundary-0001`;
      const directory = await mkdtemp(join(tmpdir(), "living-atlas-review-boundary-"));
      try {
        const controlState = await createFixtureLocalControlState(token);
        const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
        const graphStore = await FileLocalGraphStore.open({
          directory,
          authorityId: controlState.authority_id,
          plaintextPersistence: "encrypt",
          keyring
        });
        const review = canonicalResolutionDrafts(1).review;
        if (operation !== "create") {
          await expect(graphStore.initializeFromObjects([review] as never)).resolves.toMatchObject({ ok: true });
        }
        const context = createLocalMcpContextFromControlState({
          controlState,
          graphStore,
          decryptPayload: decryptWithKeyring(keyring),
          auditSink: new InMemoryLocalMcpAuditSink(),
          now
        });

        const mutation = operation === "create"
          ? localCreateObject(context, { authorization: `Bearer ${token}`, object: review })
          : operation === "update"
            ? localUpdateObject(context, {
                authorization: `Bearer ${token}`,
                object_id: review.object_id,
                expected_version: 1,
                patch: { content_hash: fixedHash("f") }
              })
            : localTombstoneObject(context, {
                authorization: `Bearer ${token}`,
                object_id: review.object_id,
                expected_version: 1
              });
        await expect(mutation).resolves.toEqual({ ok: false, reason: "review-record-requires-resolution" });
        expect(graphStore.status()).toMatchObject({ generation: 0, journal_sequence: 0 });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

  it.each([
    {
      label: "LinkedIn plus an independent organization",
      connectors: ["linkedin", "organization"] as CanonicalResearchConnectorKind[],
      expected: "committed"
    },
    {
      label: "LinkedIn only",
      connectors: ["linkedin"] as CanonicalResearchConnectorKind[],
      expected: "research-evidence-insufficient"
    },
    {
      label: "syndicated public copies",
      connectors: ["public-web", "organization"] as CanonicalResearchConnectorKind[],
      independenceKeys: ["synthetic-syndicated", "synthetic-syndicated"],
      expected: "research-evidence-insufficient"
    },
    {
      label: "public plus local corpus",
      connectors: ["public-web", "local-corpus"] as CanonicalResearchConnectorKind[],
      expected: "research-evidence-insufficient"
    },
    {
      label: "a refuting result beside two supports",
      connectors: ["public-web", "organization", "public-web"] as CanonicalResearchConnectorKind[],
      stances: ["supports", "supports", "refutes"] as Array<"supports" | "refutes" | "context">,
      expected: "research-evidence-conflict"
    },
    {
      label: "an ambiguous persisted identity state",
      connectors: ["public-web", "organization"] as CanonicalResearchConnectorKind[],
      identityStates: ["resolved", "ambiguous"] as Array<"resolved" | "ambiguous">,
      expected: "research-evidence-conflict"
    }
  ])("evaluates $label at the mutation boundary", async ({
    label,
    connectors,
    independenceKeys,
    stances,
    identityStates,
    expected
  }) => {
    const suffix = researchHash(label).slice("sha256:".length, "sha256:".length + 12);
    const token = `local-token-research-matrix-${suffix}`;
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-research-matrix-"));
    try {
      const controlState = await createFixtureLocalControlState(token);
      const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
      const graphStore = await FileLocalGraphStore.open({
        directory,
        authorityId: controlState.authority_id,
        plaintextPersistence: "encrypt",
        keyring
      });
      const drafts = researchResolutionDrafts({ connectors, independenceKeys, stances, identityStates, namespace: suffix });
      await expect(graphStore.initializeFromObjects([
        drafts.currentReview,
        drafts.ownerEvidence
      ] as never)).resolves.toMatchObject({ ok: true });
      const context = createLocalMcpContextFromControlState({
        controlState,
        graphStore,
        decryptPayload: decryptWithKeyring(keyring),
        auditSink: new InMemoryLocalMcpAuditSink(),
        outboxSink: new InMemoryLocalMcpMutationOutboxSink(),
        now
      });
      const result = await localResolutionApply(context, {
        authorization: `Bearer ${token}`,
        operation_id: `la_operation_researchmatrix${suffix}`,
        idempotency_key: `la_idem_researchmatrix${suffix}`,
        candidate_id: drafts.candidateId,
        expected_generation: 0,
        expected_review_version: 1,
        objects: drafts.objects
      });

      if (expected === "committed") {
        expect(result).toMatchObject({ ok: true, result: { local_commit: "committed", generation: 1 } });
      } else {
        expect(result).toEqual({ ok: false, reason: expected });
        expect(graphStore.status()).toMatchObject({ generation: 0, object_count: 2 });
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["phone", "email", "address"] as const)(
    "keeps researched %s facts in owner review",
    async (predicate) => {
      const token = `local-token-research-contact-${predicate}-0001`;
      const directory = await mkdtemp(join(tmpdir(), "living-atlas-research-contact-"));
      try {
        const controlState = await createFixtureLocalControlState(token);
        const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
        const graphStore = await FileLocalGraphStore.open({
          directory,
          authorityId: controlState.authority_id,
          plaintextPersistence: "encrypt",
          keyring
        });
        const drafts = researchResolutionDrafts({
          connectors: ["public-web", "organization"],
          namespace: `contact-${predicate}`,
          factPredicate: predicate,
          factValue: { kind: "text", value: `Synthetic ${predicate} bait` }
        });
        await expect(graphStore.initializeFromObjects([
          drafts.currentReview,
          drafts.ownerEvidence
        ] as never)).resolves.toMatchObject({ ok: true });
        const context = createLocalMcpContextFromControlState({
          controlState,
          graphStore,
          decryptPayload: decryptWithKeyring(keyring),
          auditSink: new InMemoryLocalMcpAuditSink(),
          outboxSink: new InMemoryLocalMcpMutationOutboxSink(),
          now
        });

        await expect(localResolutionApply(context, {
          authorization: `Bearer ${token}`,
          operation_id: `la_operation_researchcontact${predicate}0001`,
          idempotency_key: `la_idem_researchcontact${predicate}0001`,
          candidate_id: drafts.candidateId,
          expected_generation: 0,
          expected_review_version: 1,
          objects: drafts.objects
        })).resolves.toEqual({ ok: false, reason: "research-evidence-conflict" });
        expect(graphStore.status()).toMatchObject({ generation: 0, object_count: 2 });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

  it.each([
    { label: "explicit", bases: ["explicit", "explicit"] as const, expected: "committed" },
    { label: "missing", bases: [undefined, undefined] as const, expected: "research-evidence-conflict" },
    {
      label: "inferred sensitive",
      bases: ["inferred-sensitive", "inferred-sensitive"] as const,
      expected: "research-evidence-conflict"
    },
    {
      label: "forged edge ID",
      bases: ["explicit", "explicit"] as const,
      edgeId: "la_edge_researchforgedidentity0001",
      expected: "research-evidence-conflict"
    },
    {
      label: "nonempty relationship attrs",
      bases: ["explicit", "explicit"] as const,
      attrs: { synthetic_nested_profile: { contact: "redacted-bait" } },
      expected: "research-evidence-conflict"
    }
  ])("evaluates $label research relationship basis from persisted results", async ({
    label,
    bases,
    edgeId,
    attrs,
    expected
  }) => {
    const suffix = researchHash(label).slice("sha256:".length, "sha256:".length + 12);
    const token = `local-token-research-relationship-${suffix}`;
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-research-relationship-"));
    try {
      const controlState = await createFixtureLocalControlState(token);
      const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
      const graphStore = await FileLocalGraphStore.open({
        directory,
        authorityId: controlState.authority_id,
        plaintextPersistence: "encrypt",
        keyring
      });
      const drafts = researchRelationshipResolutionDrafts({ relationshipBases: [...bases] });
      const relationship = edgeId || attrs
        ? withResolutionPayload(drafts.relationship, {
            ...(edgeId ? { edge_id: edgeId } : {}),
            ...(attrs ? { attrs } : {})
          })
        : drafts.relationship;
      const objects = drafts.objects.map((object) => (
        object.object_id === relationship.object_id ? relationship : object
      ));
      await expect(graphStore.initializeFromObjects([
        drafts.currentReview,
        drafts.ownerEvidence
      ] as never)).resolves.toMatchObject({ ok: true });
      const context = createLocalMcpContextFromControlState({
        controlState,
        graphStore,
        decryptPayload: decryptWithKeyring(keyring),
        auditSink: new InMemoryLocalMcpAuditSink(),
        outboxSink: new InMemoryLocalMcpMutationOutboxSink(),
        now
      });
      const result = await localResolutionApply(context, {
        authorization: `Bearer ${token}`,
        operation_id: `la_operation_researchrelationship${suffix}`,
        idempotency_key: `la_idem_researchrelationship${suffix}`,
        candidate_id: drafts.candidateId,
        expected_generation: 0,
        expected_review_version: 1,
        objects
      });

      if (expected === "committed") {
        expect(result).toMatchObject({ ok: true, result: { local_commit: "committed", generation: 1 } });
      } else {
        expect(result).toEqual({ ok: false, reason: expected });
        expect(graphStore.status()).toMatchObject({ generation: 0, object_count: 2 });
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("replays an exact research resolution without duplicate graph, audit, or outbox effects", async () => {
    const token = "local-token-research-retry-0001";
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-research-retry-"));
    try {
      const controlState = await createFixtureLocalControlState(token);
      const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
      const graphStore = await FileLocalGraphStore.open({
        directory,
        authorityId: controlState.authority_id,
        plaintextPersistence: "encrypt",
        keyring
      });
      const drafts = researchResolutionDrafts({ connectors: ["public-web", "organization"] });
      await expect(graphStore.initializeFromObjects([
        drafts.currentReview,
        drafts.ownerEvidence
      ] as never)).resolves.toMatchObject({ ok: true });
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
        operation_id: "la_operation_researchretry0001",
        idempotency_key: "la_idem_researchretry0001",
        candidate_id: drafts.candidateId,
        expected_generation: 0,
        expected_review_version: 1,
        objects: drafts.objects
      };

      await expect(localResolutionApply(context, request)).resolves.toMatchObject({
        ok: true,
        result: { generation: 1, journal_sequence: 1, audit: "recorded", sync_queue: "queued" }
      });
      await expect(localResolutionApply(context, { ...request, objects: [...request.objects].reverse() }))
        .resolves.toMatchObject({
          ok: true,
          result: { generation: 1, journal_sequence: 1, audit: "recorded", sync_queue: "queued" }
        });
      const changedResult = withResolutionPayload(drafts.results[0]!, { stance: "context" });
      await expect(localResolutionApply(context, {
        ...request,
        objects: request.objects.map((object) => object.object_id === changedResult.object_id ? changedResult : object)
      })).resolves.toEqual({ ok: false, reason: "idempotency-conflict" });

      expect(graphStore.status()).toMatchObject({ generation: 1, object_count: 9 });
      expect(outboxSink.records).toHaveLength(drafts.objects.length);
      expect(auditSink.events.filter((event) => (
        event.tool_name === "resolution_apply" && event.reason_code === "resolution-committed"
      ))).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reconciles a failed research audit without replaying the graph or outbox", async () => {
    const token = "local-token-research-audit-reconcile-0001";
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-research-audit-reconcile-"));
    try {
      const controlState = await createFixtureLocalControlState(token);
      const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
      const graphStore = await FileLocalGraphStore.open({
        directory,
        authorityId: controlState.authority_id,
        plaintextPersistence: "encrypt",
        keyring
      });
      const drafts = researchResolutionDrafts({ connectors: ["public-web", "organization"] });
      await expect(graphStore.initializeFromObjects([
        drafts.currentReview,
        drafts.ownerEvidence
      ] as never)).resolves.toMatchObject({ ok: true });
      const recordedAudit = new InMemoryLocalMcpAuditSink();
      let failOnce = true;
      const auditSink = {
        record(event: Parameters<InMemoryLocalMcpAuditSink["record"]>[0]) {
          if (failOnce && event.tool_name === "resolution_apply") {
            failOnce = false;
            throw new Error("synthetic research audit outage bait");
          }
          recordedAudit.record(event);
        }
      };
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
        operation_id: "la_operation_researchauditreconcile0001",
        idempotency_key: "la_idem_researchauditreconcile0001",
        candidate_id: drafts.candidateId,
        expected_generation: 0,
        expected_review_version: 1,
        objects: drafts.objects
      };

      await expect(localResolutionApply(context, request)).resolves.toMatchObject({
        ok: true,
        result: { generation: 1, audit: "reconciliation-required", sync_queue: "queued" }
      });
      await expect(localResolutionApply(context, request)).resolves.toMatchObject({
        ok: true,
        result: { generation: 1, journal_sequence: 1, audit: "recorded", sync_queue: "queued" }
      });

      expect(graphStore.status()).toMatchObject({ generation: 1, object_count: 9 });
      expect(outboxSink.records).toHaveLength(drafts.objects.length);
      expect(recordedAudit.events.filter((event) => event.tool_name === "resolution_apply"))
        .toEqual([expect.objectContaining({
        reason_code: "resolution-committed",
        research: expect.objectContaining({ outcome: "auto-apply", independence_group_count: 2 })
      })]);
      expect(JSON.stringify(recordedAudit.events)).not.toContain("synthetic research audit outage bait");
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

  it("auto-applies a pre-existing immutable non-meaningful parity marker without inventing graph objects", async () => {
    const token = "local-token-resolution-nonmeaningful-0001";
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-local-resolution-nonmeaningful-"));
    try {
      const controlState = await createFixtureLocalControlState(token);
      const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
      const graphStore = await FileLocalGraphStore.open({
        directory,
        authorityId: controlState.authority_id,
        plaintextPersistence: "encrypt",
        keyring
      });
      const pending = nonMeaningfulResolutionDrafts(1, 1);
      const resolved = nonMeaningfulResolutionDrafts(2, 2);
      await expect(graphStore.initializeFromObjects([
        pending.evidence,
        {
          ...pending.review,
          payload: {
            ...pending.review.payload,
            data: { ...pending.review.payload.data, recommendation: "research", resolution_state: "research" }
          }
        },
        pending.parity
      ] as never)).resolves.toMatchObject({ ok: true });
      const context = createLocalMcpContextFromControlState({
        controlState,
        graphStore,
        decryptPayload: decryptWithKeyring(keyring),
        now
      });

      await expect(localResolutionApply(context, {
        authorization: `Bearer ${token}`,
        operation_id: "la_operation_resolutionnonmeaningful0001",
        idempotency_key: "la_idem_resolutionnonmeaningful0001",
        candidate_id: resolved.candidateId,
        expected_generation: 0,
        expected_review_version: 1,
        objects: [resolved.review]
      })).resolves.toMatchObject({
        ok: true,
        result: {
          local_commit: "committed",
          committed_object_ids: [resolved.review.object_id]
        }
      });
      expect(graphStore.status()).toMatchObject({ generation: 1, object_count: 3 });
      expect(graphStore.readObject(resolved.evidence.object_id)).toMatchObject({ version: 1 });
      expect(graphStore.readObject(resolved.parity.object_id)).toMatchObject({ version: 1 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a stored non-meaningful marker when lossless source evidence contains meaning", async () => {
    const token = "local-token-resolution-false-nonmeaningful-0001";
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-local-resolution-false-nonmeaningful-"));
    try {
      const controlState = await createFixtureLocalControlState(token);
      const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
      const graphStore = await FileLocalGraphStore.open({
        directory,
        authorityId: controlState.authority_id,
        plaintextPersistence: "encrypt",
        keyring
      });
      const pending = nonMeaningfulResolutionDrafts(1, 1);
      const resolved = nonMeaningfulResolutionDrafts(2, 2);
      const meaningfulEvidence = withResolutionPayload(pending.evidence, {
        content_hash: fixedHash("2"),
        excerpt: "Synthetic meaningful source statement."
      });
      await expect(graphStore.initializeFromObjects([
        meaningfulEvidence,
        {
          ...pending.review,
          payload: {
            ...pending.review.payload,
            data: { ...pending.review.payload.data, recommendation: "research", resolution_state: "research" }
          }
        },
        pending.parity
      ] as never)).resolves.toMatchObject({ ok: true });
      const context = createLocalMcpContextFromControlState({
        controlState,
        graphStore,
        decryptPayload: decryptWithKeyring(keyring),
        now
      });

      await expect(localResolutionApply(context, {
        authorization: `Bearer ${token}`,
        operation_id: "la_operation_resolutionfalsenonmeaningful0001",
        idempotency_key: "la_idem_resolutionfalsenonmeaningful0001",
        candidate_id: resolved.candidateId,
        expected_generation: 0,
        expected_review_version: 1,
        objects: [resolved.review]
      })).resolves.toEqual({ ok: false, reason: "resolution-review-mismatch" });
      expect(graphStore.status()).toMatchObject({ generation: 0 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps an imported non-meaningful parity marker immutable during full resolution", async () => {
    const token = "local-token-resolution-immutable-nonmeaningful-0001";
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-local-resolution-immutable-nonmeaningful-"));
    try {
      const controlState = await createFixtureLocalControlState(token);
      const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
      const graphStore = await FileLocalGraphStore.open({
        directory,
        authorityId: controlState.authority_id,
        plaintextPersistence: "encrypt",
        keyring
      });
      const pending = nonMeaningfulResolutionDrafts(1, 1);
      const represented = canonicalResolutionDrafts(2);
      await expect(graphStore.initializeFromObjects([
        pending.evidence,
        {
          ...pending.review,
          payload: {
            ...pending.review.payload,
            data: { ...pending.review.payload.data, recommendation: "research", resolution_state: "research" }
          }
        },
        pending.parity
      ] as never)).resolves.toMatchObject({ ok: true });
      const context = createLocalMcpContextFromControlState({
        controlState,
        graphStore,
        decryptPayload: decryptWithKeyring(keyring),
        now
      });

      await expect(localResolutionApply(context, {
        authorization: `Bearer ${token}`,
        operation_id: "la_operation_resolutionimmutablenonmeaningful0001",
        idempotency_key: "la_idem_resolutionimmutablenonmeaningful0001",
        candidate_id: represented.candidateId,
        expected_generation: 0,
        expected_review_version: 1,
        objects: [
          represented.entity,
          represented.fact,
          represented.review,
          { ...represented.parity, version: 2 }
        ]
      })).resolves.toEqual({ ok: false, reason: "resolution-parity-mismatch" });
      expect(graphStore.status()).toMatchObject({ generation: 0 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects review-only auto-apply when the stored review has an auto-apply blocker deleted from the draft", async () => {
    const token = "local-token-resolution-stored-blocker-0001";
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-local-resolution-stored-blocker-"));
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
      const storedReview = withResolutionPayload({ ...drafts.review, version: 1 }, {
        recommendation: "owner-review",
        resolution_state: "owner-review",
        auto_apply_blockers: ["typed-projection-missing-edge-endpoint"]
      });
      const submittedReview = withResolutionPayload(drafts.review, {
        recommendation: "auto-apply",
        resolution_state: "auto-applied"
      });
      await expect(graphStore.initializeFromObjects([
        drafts.entity,
        drafts.evidence,
        drafts.fact,
        storedReview,
        drafts.parity
      ] as never)).resolves.toMatchObject({ ok: true });
      const context = createLocalMcpContextFromControlState({
        controlState,
        graphStore,
        decryptPayload: decryptWithKeyring(keyring),
        now
      });

      await expect(localResolutionApply(context, {
        authorization: `Bearer ${token}`,
        operation_id: "la_operation_resolutionstoredblocker0001",
        idempotency_key: "la_idem_resolutionstoredblocker0001",
        candidate_id: drafts.candidateId,
        expected_generation: 0,
        expected_review_version: 1,
        objects: [submittedReview]
      })).resolves.toEqual({ ok: false, reason: "resolution-review-mismatch" });
      expect(graphStore.status()).toMatchObject({ generation: 0 });
      expect(graphStore.readObject(drafts.review.object_id)).toMatchObject({ version: 1 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["source-evidence", "auto-apply-blockers"] as const)(
    "keeps importer-origin %s immutable through full resolution updates",
    async (field) => {
      const token = `local-token-resolution-immutable-${field}-0001`;
      const directory = await mkdtemp(join(tmpdir(), "living-atlas-local-resolution-immutable-origin-"));
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
        const storedReview = withResolutionPayload({ ...drafts.review, version: 1 }, {
          recommendation: "owner-review",
          resolution_state: "owner-review",
          auto_apply_blockers: ["typed-projection-missing-edge-endpoint"]
        });
        const submittedReview = withResolutionPayload(drafts.review, {
          recommendation: "research",
          resolution_state: "research",
          ...(field === "source-evidence" ? { source_evidence_ids: undefined } : {}),
          ...(field === "auto-apply-blockers" ? { auto_apply_blockers: undefined } : {
            auto_apply_blockers: ["typed-projection-missing-edge-endpoint"]
          })
        });
        await expect(graphStore.initializeFromObjects([
          drafts.entity,
          drafts.evidence,
          drafts.fact,
          storedReview,
          drafts.parity
        ] as never)).resolves.toMatchObject({ ok: true });
        const context = createLocalMcpContextFromControlState({
          controlState,
          graphStore,
          decryptPayload: decryptWithKeyring(keyring),
          now
        });

        await expect(localResolutionApply(context, {
          authorization: `Bearer ${token}`,
          operation_id: `la_operation_resolutionimmutable${field.replaceAll("-", "")}0001`,
          idempotency_key: `la_idem_resolutionimmutable${field.replaceAll("-", "")}0001`,
          candidate_id: drafts.candidateId,
          expected_generation: 0,
          expected_review_version: 1,
          objects: [submittedReview, { ...drafts.parity, version: 2 }]
        })).resolves.toEqual({ ok: false, reason: "resolution-review-mismatch" });
        expect(graphStore.status()).toMatchObject({ generation: 0 });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

  it.each(["refuting-evidence", "correction", "identity-resolution"] as const)(
    "rejects review-only auto-apply with stored %s intent",
    async (mode) => {
      const token = `local-token-resolution-unsafe-intent-${mode}-0001`;
      const directory = await mkdtemp(join(tmpdir(), "living-atlas-local-resolution-unsafe-intent-"));
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
        const identityResolutionId = "la_object_resolutionunsafeidentity0001";
        const unsafeFact = mode === "refuting-evidence"
          ? withResolutionPayload(drafts.fact, {
              evidence_links: [{ evidence_id: drafts.evidence.object_id, stance: "refutes" }]
            })
          : mode === "correction"
            ? withResolutionPayload(drafts.fact, {
                lineage_action: "correct",
                supersedes: ["la_object_resolutionunsafepriorfact0001"]
              })
            : drafts.fact;
        const identityResolution = {
          ...drafts.review,
          object_id: identityResolutionId,
          object_type: "review",
          version: 1,
          content_hash: fixedHash("1"),
          payload: {
            kind: "plaintext-json" as const,
            data: {
              schema: "atlas.entity-resolution:v1",
              resolution_id: identityResolutionId,
              actor_id: "synthetic-resolution-boundary-test",
              observed_identifiers: ["synthetic-unsafe-identity"],
              candidate_entity_ids: [drafts.entity.object_id],
              decision: "defer",
              evidence_refs: [drafts.evidence.object_id],
              evidence_links: [{ evidence_id: drafts.evidence.object_id, stance: "context" }],
              confidence: {
                band: "high",
                assessment_kind: "identity",
                method: "synthetic-fixture",
                assessed_at: now,
                evidence_refs: [drafts.evidence.object_id]
              },
              recorded_at: now,
              supersedes: []
            }
          }
        };
        const proposedObjectIds = mode === "identity-resolution"
          ? [...(drafts.review.payload.data.proposed_object_ids as string[]), identityResolutionId]
          : drafts.review.payload.data.proposed_object_ids;
        const storedReview = withResolutionPayload({ ...drafts.review, version: 1 }, {
          recommendation: "owner-review",
          resolution_state: "owner-review",
          proposed_object_ids: proposedObjectIds
        });
        const submittedReview = withResolutionPayload(drafts.review, {
          recommendation: "auto-apply",
          resolution_state: "auto-applied",
          proposed_object_ids: proposedObjectIds
        });
        await expect(graphStore.initializeFromObjects([
          drafts.entity,
          drafts.evidence,
          unsafeFact,
          ...(mode === "identity-resolution" ? [identityResolution] : []),
          storedReview,
          drafts.parity
        ] as never)).resolves.toMatchObject({ ok: true });
        const context = createLocalMcpContextFromControlState({
          controlState,
          graphStore,
          decryptPayload: decryptWithKeyring(keyring),
          now
        });

        await expect(localResolutionApply(context, {
          authorization: `Bearer ${token}`,
          operation_id: `la_operation_resolutionunsafe${mode.replaceAll("-", "")}0001`,
          idempotency_key: `la_idem_resolutionunsafe${mode.replaceAll("-", "")}0001`,
          candidate_id: drafts.candidateId,
          expected_generation: 0,
          expected_review_version: 1,
          objects: [submittedReview]
        })).resolves.toEqual({ ok: false, reason: "resolution-review-mismatch" });
        expect(graphStore.status()).toMatchObject({ generation: 0 });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

  it("auto-applies a rich exact-source review without rewriting its existing evidence, assertions, entities, or parity", async () => {
    const token = "local-token-resolution-rich-review-only-0001";
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-local-resolution-rich-review-only-"));
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
      const storedReview = withResolutionPayload({ ...drafts.review, version: 1 }, {
        recommendation: "owner-review",
        resolution_state: "owner-review"
      });
      const submittedReview = withResolutionPayload(drafts.review, {
        recommendation: "auto-apply",
        resolution_state: "auto-applied"
      });
      await expect(graphStore.initializeFromObjects([
        drafts.entity,
        drafts.evidence,
        drafts.fact,
        storedReview,
        drafts.parity
      ] as never)).resolves.toMatchObject({ ok: true });
      const context = createLocalMcpContextFromControlState({
        controlState,
        graphStore,
        decryptPayload: decryptWithKeyring(keyring),
        now
      });

      await expect(localResolutionApply(context, {
        authorization: `Bearer ${token}`,
        operation_id: "la_operation_resolutionrichreviewonly0001",
        idempotency_key: "la_idem_resolutionrichreviewonly0001",
        candidate_id: drafts.candidateId,
        expected_generation: 0,
        expected_review_version: 1,
        objects: [submittedReview]
      })).resolves.toMatchObject({
        ok: true,
        result: { committed_object_ids: [drafts.review.object_id] }
      });
      expect(graphStore.readObject(drafts.review.object_id)).toMatchObject({ version: 2 });
      for (const objectId of [drafts.entity.object_id, drafts.evidence.object_id, drafts.fact.object_id, drafts.parity.object_id]) {
        expect(graphStore.readObject(objectId)).toMatchObject({ version: 1 });
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["phone", "email", "address"] as const)(
    "preserves an owner-source %s fact by changing only its review state",
    async (predicate) => {
      const token = `local-token-resolution-owner-contact-${predicate}-0001`;
      const directory = await mkdtemp(join(tmpdir(), "living-atlas-owner-contact-review-only-"));
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
        const fact = withResolutionPayload(drafts.fact, {
          predicate,
          value: { kind: "text", value: `Synthetic owner-source ${predicate}` }
        });
        const storedReview = withResolutionPayload({ ...drafts.review, version: 1 }, {
          recommendation: "owner-review",
          resolution_state: "owner-review"
        });
        const submittedReview = withResolutionPayload(drafts.review, {
          recommendation: "auto-apply",
          resolution_state: "auto-applied"
        });
        await expect(graphStore.initializeFromObjects([
          drafts.entity,
          drafts.evidence,
          fact,
          storedReview,
          drafts.parity
        ] as never)).resolves.toMatchObject({ ok: true });
        const immutableBefore = [drafts.entity, drafts.evidence, fact, drafts.parity].map((draft) => ({
          object_id: draft.object_id,
          version: graphStore.readObject(draft.object_id)!.version,
          content_hash: graphStore.readObject(draft.object_id)!.content_hash
        }));
        const auditSink = new InMemoryLocalMcpAuditSink();
        const context = createLocalMcpContextFromControlState({
          controlState,
          graphStore,
          decryptPayload: decryptWithKeyring(keyring),
          auditSink,
          now
        });

        await expect(localResolutionApply(context, {
          authorization: `Bearer ${token}`,
          operation_id: `la_operation_resolutionownercontact${predicate}0001`,
          idempotency_key: `la_idem_resolutionownercontact${predicate}0001`,
          candidate_id: drafts.candidateId,
          expected_generation: 0,
          expected_review_version: 1,
          objects: [submittedReview]
        })).resolves.toMatchObject({
          ok: true,
          result: { local_commit: "committed", committed_object_ids: [drafts.review.object_id] }
        });
        for (const before of immutableBefore) {
          expect(graphStore.readObject(before.object_id)).toMatchObject(before);
        }
        expect(auditSink.events.find((event) => event.reason_code === "resolution-committed"))
          .toMatchObject({ research: undefined });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

  it("rejects full owner-source auto-apply instead of rewriting the staged exact projection", async () => {
    const token = "local-token-resolution-owner-full-auto-apply-0001";
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-owner-full-auto-apply-"));
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
      const storedReview = withResolutionPayload({ ...drafts.review, version: 1 }, {
        recommendation: "owner-review",
        resolution_state: "owner-review"
      });
      const submittedReview = withResolutionPayload(drafts.review, {
        recommendation: "auto-apply",
        resolution_state: "auto-applied"
      });
      await expect(graphStore.initializeFromObjects([
        drafts.evidence,
        storedReview
      ] as never)).resolves.toMatchObject({ ok: true });
      const outboxSink = new InMemoryLocalMcpMutationOutboxSink();
      const context = createLocalMcpContextFromControlState({
        controlState,
        graphStore,
        decryptPayload: decryptWithKeyring(keyring),
        auditSink: new InMemoryLocalMcpAuditSink(),
        outboxSink,
        now
      });

      await expect(localResolutionApply(context, {
        authorization: `Bearer ${token}`,
        operation_id: "la_operation_resolutionownerfullautoapply0001",
        idempotency_key: "la_idem_resolutionownerfullautoapply0001",
        candidate_id: drafts.candidateId,
        expected_generation: 0,
        expected_review_version: 1,
        objects: [drafts.entity, drafts.evidence, drafts.fact, submittedReview, drafts.parity]
      })).resolves.toEqual({ ok: false, reason: "resolution-review-mismatch" });
      expect(graphStore.status()).toMatchObject({ generation: 0, journal_sequence: 0, object_count: 2 });
      expect(graphStore.readObject(drafts.fact.object_id)).toBeUndefined();
      expect(graphStore.readObject(drafts.evidence.object_id)).toMatchObject({ version: 1 });
      expect(outboxSink.records).toHaveLength(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["missing-source-ids", "wrong-extraction", "plaintext-source"] as const)(
    "rejects review-only auto-apply with %s",
    async (mode) => {
      const token = `local-token-resolution-source-origin-${mode}-0001`;
      const directory = await mkdtemp(join(tmpdir(), "living-atlas-local-resolution-source-origin-"));
      try {
        const controlState = await createFixtureLocalControlState(token);
        const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
        const graphStore = await FileLocalGraphStore.open({
          directory,
          authorityId: controlState.authority_id,
          plaintextPersistence: mode === "plaintext-source" ? "allow" : "encrypt",
          keyring
        });
        const drafts = canonicalResolutionDrafts(2);
        const evidence = mode === "wrong-extraction"
          ? withResolutionPayload(drafts.evidence, { extraction_method: "synthetic-other-extraction" })
          : drafts.evidence;
        const storedReview = withResolutionPayload({ ...drafts.review, version: 1 }, {
          recommendation: "owner-review",
          resolution_state: "owner-review",
          ...(mode === "missing-source-ids" ? { source_evidence_ids: undefined } : {})
        });
        const submittedReview = withResolutionPayload(drafts.review, {
          recommendation: "auto-apply",
          resolution_state: "auto-applied",
          ...(mode === "missing-source-ids" ? { source_evidence_ids: undefined } : {})
        });
        const seedObjects = [
          drafts.entity,
          evidence,
          drafts.fact,
          storedReview,
          drafts.parity
        ].map((object) => mode === "plaintext-source" ? {
          ...object,
          access_class: "remote-safe",
          encryption_class: "plaintext"
        } : object);
        await expect(graphStore.initializeFromObjects(seedObjects as never)).resolves.toMatchObject({ ok: true });
        const context = createLocalMcpContextFromControlState({
          controlState,
          graphStore,
          decryptPayload: decryptWithKeyring(keyring),
          now
        });

        await expect(localResolutionApply(context, {
          authorization: `Bearer ${token}`,
          operation_id: `la_operation_resolutionsourceorigin${mode.replaceAll("-", "")}0001`,
          idempotency_key: `la_idem_resolutionsourceorigin${mode.replaceAll("-", "")}0001`,
          candidate_id: drafts.candidateId,
          expected_generation: 0,
          expected_review_version: 1,
          objects: [submittedReview]
        })).resolves.toEqual({ ok: false, reason: "resolution-review-mismatch" });
        expect(graphStore.status()).toMatchObject({ generation: 0 });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

  it.each([
    {
      label: "originating a non-meaningful marker during resolution",
      seed: (drafts: ReturnType<typeof nonMeaningfulResolutionDrafts>) => [
        {
          ...drafts.review,
          version: 1,
          payload: {
            ...drafts.review.payload,
            data: { ...drafts.review.payload.data, recommendation: "research", resolution_state: "research" }
          }
        }
      ],
      proposedObjectIds: []
    },
    {
      label: "relabeling represented meaningful coverage as non-meaningful",
      seed: (drafts: ReturnType<typeof nonMeaningfulResolutionDrafts>) => {
        const represented = canonicalResolutionDrafts(1);
        return [
          represented.entity,
          represented.evidence,
          represented.fact,
          {
            ...drafts.review,
            version: 1,
            payload: {
              ...drafts.review.payload,
              data: { ...drafts.review.payload.data, recommendation: "research", resolution_state: "research" }
            }
          },
          represented.parity
        ];
      },
      proposedObjectIds: []
    },
    {
      label: "attaching canonical objects to non-meaningful coverage",
      seed: (drafts: ReturnType<typeof nonMeaningfulResolutionDrafts>) => {
        const represented = canonicalResolutionDrafts(1);
        return [
          represented.entity,
          represented.evidence,
          represented.fact,
          {
            ...drafts.review,
            version: 1,
            payload: {
              ...drafts.review.payload,
              data: { ...drafts.review.payload.data, recommendation: "research", resolution_state: "research" }
            }
          },
          { ...drafts.parity, version: 1 }
        ];
      },
      proposedObjectIds: ["la_object_resolutionfact0001"]
    }
  ])("rejects $label", async ({ seed, proposedObjectIds }) => {
    const token = "local-token-resolution-nonmeaningful-reject-0001";
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-local-resolution-nonmeaningful-reject-"));
    try {
      const controlState = await createFixtureLocalControlState(token);
      const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
      const graphStore = await FileLocalGraphStore.open({
        directory,
        authorityId: controlState.authority_id,
        plaintextPersistence: "encrypt",
        keyring
      });
      const drafts = nonMeaningfulResolutionDrafts(2, 2);
      await expect(graphStore.initializeFromObjects(seed(drafts) as never)).resolves.toMatchObject({ ok: true });
      const context = createLocalMcpContextFromControlState({
        controlState,
        graphStore,
        decryptPayload: decryptWithKeyring(keyring),
        now
      });
      const review = withResolutionPayload(drafts.review, { proposed_object_ids: proposedObjectIds });

      await expect(localResolutionApply(context, {
        authorization: `Bearer ${token}`,
        operation_id: "la_operation_resolutionnonmeaningfulreject0001",
        idempotency_key: "la_idem_resolutionnonmeaningfulreject0001",
        candidate_id: drafts.candidateId,
        expected_generation: 0,
        expected_review_version: 1,
        objects: [review]
      })).resolves.toEqual({ ok: false, reason: "resolution-parity-mismatch" });
      expect(graphStore.status()).toMatchObject({ generation: 0 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["relationship", "observation", "occurrence"] as const)(
    "rejects %s parity when its target is a canonical fact",
    async (representationKind) => {
      const token = `local-token-resolution-parity-kind-${representationKind}-0001`;
      const directory = await mkdtemp(join(tmpdir(), "living-atlas-local-resolution-parity-kind-"));
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
          operation_id: `la_operation_resolutionparitykind${representationKind}0001`,
          idempotency_key: `la_idem_resolutionparitykind${representationKind}0001`,
          candidate_id: drafts.candidateId,
          expected_generation: 0,
          expected_review_version: 1,
          objects: [
            drafts.entity,
            drafts.evidence,
            drafts.fact,
            drafts.review,
            withResolutionPayload(drafts.parity, { representation_kind: representationKind })
          ]
        })).resolves.toEqual({ ok: false, reason: "resolution-parity-mismatch" });
        expect(graphStore.status()).toMatchObject({ generation: 0, object_count: 0 });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

  it.each([
    {
      label: "accepts",
      entityPatch: { type: "occurrence", subtype: "meeting" },
      accepted: true
    },
    {
      label: "rejects",
      entityPatch: {},
      accepted: false
    }
  ])("$label occurrence parity for the corresponding canonical entity type", async ({ entityPatch, accepted }) => {
    const token = `local-token-resolution-occurrence-parity-${accepted ? "valid" : "invalid"}-0001`;
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-local-resolution-occurrence-parity-"));
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
      const entity = withResolutionPayload(drafts.entity, entityPatch);
      const parity = withResolutionPayload(drafts.parity, {
        representation_kind: "occurrence",
        canonical_object_ids: [drafts.entity.object_id]
      });
      const context = createLocalMcpContextFromControlState({ controlState, graphStore, now });
      const result = await localResolutionApply(context, {
        authorization: `Bearer ${token}`,
        operation_id: `la_operation_resolutionoccurrenceparity${accepted ? "valid" : "invalid"}0001`,
        idempotency_key: `la_idem_resolutionoccurrenceparity${accepted ? "valid" : "invalid"}0001`,
        candidate_id: drafts.candidateId,
        expected_generation: 0,
        expected_review_version: 1,
        objects: [entity, drafts.evidence, drafts.fact, drafts.review, parity]
      });

      if (accepted) {
        expect(result).toMatchObject({
          ok: true,
          result: { local_commit: "committed", generation: 1, journal_sequence: 1 }
        });
        expect(graphStore.status()).toMatchObject({ generation: 1, object_count: 5 });
      } else {
        expect(result).toEqual({ ok: false, reason: "resolution-parity-mismatch" });
        expect(graphStore.status()).toMatchObject({ generation: 0, object_count: 0 });
      }
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
      label: "a missing review source evidence reference",
      build: (drafts: ResolutionDrafts) => ({
        objects: [
          drafts.entity,
          drafts.evidence,
          drafts.fact,
          withResolutionPayload(drafts.review, {
            source_evidence_ids: ["la_object_missingreviewevidence0001"]
          }),
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

      await expect(localResolutionApply(context, {
        ...request,
        objects: [...request.objects].reverse()
      })).resolves.toMatchObject({
        ok: true,
        result: { generation: 1, journal_sequence: 1 }
      });
      const changedEntity = {
        ...drafts.entity,
        visible_metadata: { ...drafts.entity.visible_metadata, size_class: "small" as const }
      };
      const changedReview = withResolutionPayload(drafts.review, { resolution_state: "owner-review" });
      await expect(localResolutionApply(context, {
        ...request,
        objects: [changedEntity, drafts.evidence, drafts.fact, drafts.review, drafts.parity]
      })).resolves.toEqual({ ok: false, reason: "idempotency-conflict" });
      await expect(localResolutionApply(context, {
        ...request,
        objects: [drafts.entity, drafts.evidence, drafts.fact, changedReview, drafts.parity]
      })).resolves.toEqual({ ok: false, reason: "idempotency-conflict" });

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

  it("performs no resolution audit or outbox side effect for a malformed operation record", async () => {
    const token = "local-token-resolution-malformed-record-0001";
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-local-resolution-malformed-record-"));
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
      const request = {
        authorization: `Bearer ${token}`,
        operation_id: "la_operation_resolutionmalformed0001",
        idempotency_key: "la_idem_resolutionmalformed0001",
        candidate_id: drafts.candidateId,
        expected_generation: 0,
        expected_review_version: 1,
        objects: [drafts.entity, drafts.evidence, drafts.fact, drafts.review, drafts.parity]
      };
      const initialContext = createLocalMcpContextFromControlState({
        controlState,
        graphStore,
        decryptPayload: decryptWithKeyring(keyring),
        now
      });
      await expect(localResolutionApply(initialContext, request)).resolves.toMatchObject({
        ok: true,
        result: { local_commit: "committed", generation: 1, journal_sequence: 1 }
      });

      const prior = graphStore.operationRecordForIdempotency(request.idempotency_key)!;
      graphStore.operationRecordForIdempotency = () => ({
        ...prior,
        changes: prior.changes.slice(0, 1)
      });
      const auditSink = new InMemoryLocalMcpAuditSink();
      const outboxSink = new InMemoryLocalMcpMutationOutboxSink();
      const retryContext = createLocalMcpContextFromControlState({
        controlState,
        graphStore,
        decryptPayload: decryptWithKeyring(keyring),
        auditSink,
        outboxSink,
        now
      });

      await expect(localResolutionApply(retryContext, request)).resolves.toMatchObject({
        ok: true,
        result: {
          local_commit: "committed",
          audit: "reconciliation-required",
          sync_queue: "reconciliation-required",
          generation: 1,
          journal_sequence: 1
        }
      });
      expect(auditSink.events.filter((event) => event.tool_name === "resolution_apply")).toHaveLength(0);
      expect(outboxSink.records).toHaveLength(0);
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
        idempotency_key: idempotencyKey,
        research: {
          connector_kinds: ["public-web"],
          outcome: "auto-apply",
          independence_group_count: 2,
          result_set_hash: fixedHash("a")
        }
      });
      const auditSink = new FileLocalMcpAuditSink(auditPath);
      auditSink.record(audit);
      auditSink.record(audit);
      expect(auditSink.read(10)).toEqual([expect.objectContaining({
        operation_id: operationId,
        idempotency_key: idempotencyKey,
          research: expect.objectContaining({ result_set_hash: fixedHash("a") })
      })]);
      auditSink.record(createLocalMcpAuditEvent({
        ...audit,
        research: { ...audit.research!, independence_group_count: 3 }
      }));
      expect(auditSink.read(10)).toHaveLength(2);
      auditSink.record(createLocalMcpAuditEvent({
        ...audit,
        research: { ...audit.research!, result_set_hash: fixedHash("b") }
      }));
      expect(auditSink.read(10)).toHaveLength(3);

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

  it("repairs audit permissions after an uncertain post-append failure without appending twice", async () => {
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-local-resolution-audit-repair-"));
    const auditPath = join(directory, "audit", "events.jsonl");
    try {
      let fileChmodAttempts = 0;
      const auditSink = new FileLocalMcpAuditSink(auditPath, {
        chmod(target, mode) {
          if (String(target) === auditPath) {
            fileChmodAttempts += 1;
            if (fileChmodAttempts === 1) throw new Error("synthetic post-append chmod failure");
          }
          chmodSync(target, mode);
        }
      });
      const audit = createLocalMcpAuditEvent({
        event_type: "tool.allowed",
        client_id: fixtureLocalClientId,
        profile: "local-full",
        operation: "create",
        tool_name: "resolution_apply",
        reason_code: "resolution-committed",
        summary: "Local MCP tool call allowed",
        operation_id: "la_operation_resolutionauditrepair0001",
        idempotency_key: "la_idem_resolutionauditrepair0001",
        research: {
          connector_kinds: ["organization", "public-web"],
          outcome: "auto-apply",
          independence_group_count: 2,
          result_set_hash: fixedHash("c")
        }
      });

      expect(() => auditSink.record(audit)).toThrow("synthetic post-append chmod failure");
      expect(auditSink.read(10)).toHaveLength(1);
      auditSink.record(audit);

      expect(auditSink.read(10)).toHaveLength(1);
      expect(fileChmodAttempts).toBe(2);
      expect((await stat(auditPath)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
