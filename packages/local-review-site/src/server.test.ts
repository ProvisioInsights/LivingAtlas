import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalObjectTypeForPayload, canonicalPayloadObjectId } from "@living-atlas/contracts";
import { fixtureLocalClientId } from "@living-atlas/fixtures";
import { createCanonicalMarkdownMigration } from "@living-atlas/importer";
import { createFixtureLocalMcpContext, createLocalMcpContextFromControlState } from "@living-atlas/local-mcp";
import { hashLocalMcpToken, InMemoryLocalMcpCredentialStore } from "@living-atlas/local-mcp";
import { createFixtureLocalControlState } from "../../local-control-store/src";
import { FileLocalGraphStore } from "../../local-graph-store/src/local-graph-store";
import { createDefaultLocalKeyring, decryptGraphObjectPayload } from "../../local-keyring/src";
import { createLocalReviewSiteServer } from "./server";
import type { LocalReviewQueue } from "./review-projection";

const servers: Array<ReturnType<typeof createLocalReviewSiteServer>> = [];
afterEach(() => servers.splice(0).forEach((server) => server.close()));

describe("local review site server", () => {
  it("serves a human decision workspace instead of raw JSON controls", async () => {
    const token = "local-review-site-ui-token-0001";
    const context = createFixtureLocalMcpContext({ credentialStore: new InMemoryLocalMcpCredentialStore([{
      credential_id: "la_local_credential_reviewsiteui0001", client_id: fixtureLocalClientId, capability_id: "la_cap_localfull0001", token_hash: await hashLocalMcpToken(token), created_at: "2026-07-10T12:00:00.000Z"
    }]), now: "2026-07-10T12:00:00.000Z" });
    const server = createLocalReviewSiteServer({ context, browserSessionAuthorization: `Bearer ${token}` });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected loopback address");
    const origin = `http://127.0.0.1:${address.port}`;

    const [html, app, styles] = await Promise.all([
      fetch(origin).then((response) => response.text()),
      fetch(`${origin}/app.js`).then((response) => response.text()),
      fetch(`${origin}/styles.css`).then((response) => response.text())
    ]);
    expect(html).toContain('id="search"');
    expect(html).toContain('id="queue-summary"');
    expect(app).toContain("Preserve all now");
    expect(app).toContain("Extracted meaning");
    expect(app).toContain("Not Atlas knowledge");
    expect(app).toContain("Full source retained as encrypted evidence");
    expect(app).toContain("Proposed mini graph");
    expect(app).toContain("Request research");
    expect(app).toContain("source-browser");
    expect(app).toContain("mapping-scroll");
    expect(app).toContain("mapping-connector");
    expect(app).toContain("function sourceRow");
    expect(app).toContain("function selectedItem");
    expect(app).toContain("Unresolved observation");
    expect(app).toContain("mapping.destination_records");
    expect(app).toContain("destination.object_id");
    expect(app).toContain("item.destination_graph.entities");
    expect(app).toContain("item.destination_graph.facts");
    expect(app).toContain("item.destination_graph.relationships");
    expect(app).toContain("item.destination_graph.observations");
    expect(app).toContain("observation_edits");
    expect(app).toContain("observation_id");
    expect(app).toContain("Research is not running");
    expect(app).toContain("committed_candidate_ids");
    expect(styles).toContain(".destination-record");
    expect(styles).toContain(".record-entity");
    expect(styles).toContain(".record-fact");
    expect(styles).toContain(".record-relationship");
    expect(styles).toContain(".record-observation");
    expect(app).not.toContain("mapping-lines");
    expect(app).toContain("Review / edit extraction");
    expect(app).toContain("Request research");
    expect(app).toContain("Decide later");
    expect(app).toContain("/api/review/bulk/decision");
    expect(app).toContain("const pageSize = 24");
    expect(app).not.toContain("Source coverage is represented.");
    expect(app).not.toContain("promptJson");
    expect(app).not.toContain("Paste the complete precomputed");
    expect(app).not.toContain("Stored as an observation until typing is accepted");
    expect(app).not.toContain("Saving ${candidates.length} decisions atomically");
  });

  it("turns a keep decision into an atomic local update without raw object JSON", async () => {
    const token = "local-review-site-decision-token-0001";
    const now = "2026-07-10T12:00:00.000Z";
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-review-decision-"));
    try {
      const controlState = await createFixtureLocalControlState(token);
      const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
      const graphStore = await FileLocalGraphStore.open({
        directory,
        authorityId: controlState.authority_id,
        plaintextPersistence: "encrypt",
        keyring,
        now: () => now
      });
      const observationId = "la_object_reviewdecisionobs0001";
      const evidenceId = "la_object_reviewdecisionevidence0001";
      const reviewId = "la_object_reviewdecisionreview0001";
      const parityId = "la_object_reviewdecisionparity0001";
      const candidateId = "la_candidate_reviewdecision0001";
      const coverageKey = "la_coverage_reviewdecision0001";
      const observationId2 = "la_object_reviewdecisionobs0002";
      const evidenceId2 = "la_object_reviewdecisionevidence0002";
      const reviewId2 = "la_object_reviewdecisionreview0002";
      const parityId2 = "la_object_reviewdecisionparity0002";
      const candidateId2 = "la_candidate_reviewdecision0002";
      const coverageKey2 = "la_coverage_reviewdecision0002";
      const draft = (object_id: string, object_type: string, data: Record<string, unknown>) => ({
        schema_version: 1,
        authority_id: controlState.authority_id,
        object_id,
        object_type,
        version: 1,
        access_class: "local-private",
        encryption_class: "plaintext",
        created_at: now,
        updated_at: now,
        content_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        visible_metadata: { schema_namespace: "atlas/review-decision-test", tombstone: false, size_class: "tiny", remote_indexable: false },
        payload: { kind: "plaintext-json", data }
      });
      await graphStore.initializeFromObjects([
        draft(observationId, "assertion", {
          schema: "atlas.observation:v1",
          assertion_id: observationId,
          statement: "Synthetic source statement requiring review.",
          candidate_entity_ids: [],
          resolution_state: "research",
          recorded_at: now,
          evidence_refs: [evidenceId]
        }),
        draft(evidenceId, "evidence", {
          schema: "atlas.evidence:v1",
          evidence_id: evidenceId,
          source_kind: "migration",
          locator: "synthetic://review-decision",
          content_hash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          retrieved_at: now,
          independence_key: "synthetic-review-decision",
          extraction_method: "canonical-markdown-lossless-v1",
          excerpt: [
            "type:: person",
            "- **Phone:** +1 (555) 010-2040",
            "- **Relationship to [[Synthetic Person]]:** longtime collaborator (much richer than initial stub captured)"
          ].join("\n")
        }),
        draft(reviewId, "review", {
          schema: "atlas.review-item:v1",
          review_id: reviewId,
          candidate_id: candidateId,
          source_coverage_keys: [coverageKey],
          recommendation: "research",
          resolution_state: "research",
          proposed_object_ids: [observationId],
          recorded_at: now
        }),
        draft(parityId, "manifest", {
          schema: "atlas.parity-record:v1",
          parity_id: parityId,
          source_coverage_key: coverageKey,
          coverage_state: "represented",
          representation_kind: "observation",
          canonical_object_ids: [observationId],
          idempotency_key: "la_idem_reviewdecision0001",
          recorded_at: now
        }),
        draft(observationId2, "assertion", {
          schema: "atlas.observation:v1",
          assertion_id: observationId2,
          statement: "Second synthetic statement requiring review.",
          candidate_entity_ids: [],
          resolution_state: "research",
          recorded_at: now,
          evidence_refs: [evidenceId2]
        }),
        draft(evidenceId2, "evidence", {
          schema: "atlas.evidence:v1",
          evidence_id: evidenceId2,
          source_kind: "migration",
          locator: "synthetic://review-decision/second",
          content_hash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          retrieved_at: now,
          independence_key: "synthetic-review-decision-second",
          extraction_method: "canonical-markdown-lossless-v1",
          excerpt: "Second synthetic statement requiring review."
        }),
        draft(reviewId2, "review", {
          schema: "atlas.review-item:v1",
          review_id: reviewId2,
          candidate_id: candidateId2,
          source_coverage_keys: [coverageKey2],
          recommendation: "research",
          resolution_state: "research",
          proposed_object_ids: [observationId2],
          recorded_at: now
        }),
        draft(parityId2, "manifest", {
          schema: "atlas.parity-record:v1",
          parity_id: parityId2,
          source_coverage_key: coverageKey2,
          coverage_state: "represented",
          representation_kind: "observation",
          canonical_object_ids: [observationId2],
          idempotency_key: "la_idem_reviewdecision0002",
          recorded_at: now
        })
      ] as never);
      const context = createLocalMcpContextFromControlState({
        controlState,
        graphStore,
        decryptPayload: async (object) => decryptGraphObjectPayload(object, keyring),
        now
      });
      const server = createLocalReviewSiteServer({ context, browserSessionAuthorization: `Bearer ${token}` });
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("expected loopback address");
      const origin = `http://127.0.0.1:${address.port}`;
      const session = await fetch(origin);
      const cookie = session.headers.get("set-cookie")!.split(";")[0]!;

      const decision = await fetch(`${origin}/api/review/${candidateId}/decision`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          action: "keep",
          statements: [
            "Type: individual",
            "Phone: +1 (555) 010-2040",
            "Relationship to Synthetic Person: longtime collaborator"
          ]
        })
      });
      expect(decision.status).toBe(200);
      await expect(decision.json()).resolves.toMatchObject({
        ok: true,
        result: { local_commit: "committed", resolved_candidate_ids: [candidateId] }
      });
      await expect(fetch(`${origin}/api/review-queue`, { headers: { cookie } }).then((response) => response.json())).resolves.toMatchObject({
        research: [{ candidate_id: candidateId2 }],
        automatic: [{
          candidate_id: candidateId,
          resolution_state: "resolved",
          source_accounting: {
            exact_source_preserved: true,
            meaningful_units: [
              { kind: "attribute", atlas_text: "Type: person" },
              { kind: "fact", atlas_text: "Phone: +1 (555) 010-2040" },
              { kind: "relationship", atlas_text: "Relationship to Synthetic Person: longtime collaborator" }
            ],
            excluded_units: [{ source_text: "much richer than initial stub captured" }]
          },
          proposed_records: [
            { schema: "atlas.observation:v1", statement: "Type: individual" },
            { schema: "atlas.observation:v1", statement: "Phone: +1 (555) 010-2040" },
            { schema: "atlas.observation:v1", statement: "Relationship to Synthetic Person: longtime collaborator" }
          ]
        }]
      });

      const researchQueueBefore = await fetch(`${origin}/api/review-queue`, { headers: { cookie } }).then((response) => response.json()) as {
        research: Array<{ candidate_id: string; source_accounting: { meaningful_units: Array<{ unit_id: string }> } }>;
      };
      const researchUnitId = researchQueueBefore.research.find((item) => item.candidate_id === candidateId2)!.source_accounting.meaningful_units[0]!.unit_id;
      const researchRequest = await fetch(`${origin}/api/review/${candidateId2}/decision`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ action: "research", unit_ids: [researchUnitId] })
      });
      expect(researchRequest.status).toBe(200);
      await expect(fetch(`${origin}/api/review-queue`, { headers: { cookie } }).then((response) => response.json())).resolves.toMatchObject({
        research: [{
          candidate_id: candidateId2,
          research_requested: true,
          research_requested_units: [{ unit_id: researchUnitId }]
        }]
      });

      const bulkDecision = await fetch(`${origin}/api/review/bulk/decision`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ candidate_ids: [candidateId2], action: "defer" })
      });
      expect(bulkDecision.status).toBe(200);
      await expect(bulkDecision.json()).resolves.toMatchObject({
        ok: true,
        result: { local_commit: "committed", resolved_candidate_ids: [candidateId2] }
      });
      await expect(fetch(`${origin}/api/review-queue`, { headers: { cookie } }).then((response) => response.json())).resolves.toMatchObject({
        research: [],
        deferred: [{ candidate_id: candidateId2, resolution_state: "deferred-unknown" }]
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves a rich typed destination graph and edits only the addressed observation chunk", async () => {
    const token = "local-review-site-rich-token-0001";
    const now = "2026-07-10T12:00:00.000Z";
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-review-rich-"));
    try {
      const controlState = await createFixtureLocalControlState(token);
      const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
      const graphStore = await FileLocalGraphStore.open({
        directory,
        authorityId: controlState.authority_id,
        plaintextPersistence: "encrypt",
        keyring,
        now: () => now
      });
      const longMeaning = "x".repeat(9_000);
      const migration = createCanonicalMarkdownMigration([
        {
          source_path: "pages/Synthetic Rich Person.md",
          markdown: [
            "type:: person",
            "phone:: +1 555 0160",
            "org:: [[Synthetic Rich Org]]",
            `- ${longMeaning}`
          ].join("\n"),
          source_kind: "logseq"
        },
        {
          source_path: "pages/Synthetic Rich Org.md",
          markdown: "type:: organization",
          source_kind: "logseq"
        }
      ], {
        authority_id: controlState.authority_id,
        created_at: now,
        path_redaction_secret: "synthetic-rich-review-path-secret"
      });
      await graphStore.initializeFromObjects(migration.payloads.map((payload) => ({
        schema_version: 1,
        authority_id: controlState.authority_id,
        object_id: canonicalPayloadObjectId(payload),
        object_type: canonicalObjectTypeForPayload(payload),
        version: 1,
        access_class: "local-private",
        encryption_class: "plaintext",
        created_at: now,
        updated_at: now,
        content_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        visible_metadata: { schema_namespace: "atlas/review-rich-test", tombstone: false, size_class: "small", remote_indexable: false },
        payload: { kind: "plaintext-json", data: payload }
      })));
      const context = createLocalMcpContextFromControlState({
        controlState,
        graphStore,
        decryptPayload: async (object) => decryptGraphObjectPayload(object, keyring),
        now
      });
      const server = createLocalReviewSiteServer({ context, browserSessionAuthorization: `Bearer ${token}` });
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("expected loopback address");
      const origin = `http://127.0.0.1:${address.port}`;
      const session = await fetch(origin);
      const cookie = session.headers.get("set-cookie")!.split(";")[0]!;
      const before = await fetch(`${origin}/api/review-queue`, { headers: { cookie } }).then((response) => response.json()) as LocalReviewQueue;
      const rich = before.owner_review.find((item) => item.destination_graph.facts.some((destination) => destination.record.predicate === "phone"));
      expect(rich).toBeDefined();
      const longMapping = rich!.unit_mappings.find((mapping) => mapping.unit.atlas_text === longMeaning);
      expect(longMapping?.unit_evidence).toHaveLength(3);
      expect(longMapping?.observation_ids).toHaveLength(2);
      const originalObservations = new Map(rich!.destination_graph.observations.map((destination) => [
        destination.object_id,
        destination.record
      ]));
      const typedBefore = rich!.proposed_records.filter((record) => record.schema !== "atlas.observation:v1");
      const typedVersionsBefore = new Map(typedBefore.map((record) => {
        const objectId = canonicalPayloadObjectId(record);
        return [objectId, graphStore.readObject(objectId)?.version];
      }));
      const editedObservationId = longMapping!.observation_ids[0]!;
      const untouchedObservationId = longMapping!.observation_ids[1]!;

      const rejectedTypedEdit = await fetch(`${origin}/api/review/${rich!.candidate_id}/decision`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          action: "keep",
          observation_edits: [{
            observation_id: rich!.destination_graph.facts[0]!.object_id,
            statement: "This must never overwrite a typed fact."
          }]
        })
      });
      expect(rejectedTypedEdit.status).toBe(400);

      const decision = await fetch(`${origin}/api/review/${rich!.candidate_id}/decision`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          action: "keep",
          observation_edits: [{ observation_id: editedObservationId, statement: "Edited synthetic first chunk." }]
        })
      });
      expect(decision.status).toBe(200);
      const after = await fetch(`${origin}/api/review-queue`, { headers: { cookie } }).then((response) => response.json()) as LocalReviewQueue;
      const kept = after.automatic.find((item) => item.candidate_id === rich!.candidate_id);
      expect(kept).toBeDefined();
      expect(kept!.proposed_records.filter((record) => record.schema !== "atlas.observation:v1")).toEqual(typedBefore);
      expect(new Map([...typedVersionsBefore.keys()].map((objectId) => [
        objectId,
        graphStore.readObject(objectId)?.version
      ]))).toEqual(typedVersionsBefore);
      expect(kept!.proposed_object_ids).toEqual(rich!.proposed_object_ids);
      const keptObservations = new Map(kept!.destination_graph.observations.map((destination) => [
        destination.object_id,
        destination.record
      ]));
      expect(keptObservations.get(editedObservationId)?.statement).toBe("Edited synthetic first chunk.");
      expect(keptObservations.get(untouchedObservationId)?.statement).toBe(originalObservations.get(untouchedObservationId)?.statement);
      expect(kept!.parity_records.every((parity) => parity.representation_kind === "observation"
        && parity.canonical_object_ids.every((id) => keptObservations.has(id)))).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("orchestrates bulk decisions as deterministic per-candidate transactions and reports partial failures", async () => {
    const token = "local-review-site-bulk-token-0001";
    const now = "2026-07-10T12:00:00.000Z";
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-review-bulk-"));
    try {
      const controlState = await createFixtureLocalControlState(token);
      const keyring = createDefaultLocalKeyring({ authorityId: controlState.authority_id, createdAt: now });
      const graphStore = await FileLocalGraphStore.open({
        directory,
        authorityId: controlState.authority_id,
        plaintextPersistence: "encrypt",
        keyring,
        now: () => now
      });
      const candidateIds = [
        "la_candidate_bulkdecisiona0001",
        "la_candidate_bulkdecisionb0001",
        "la_candidate_bulkdecisionc0001",
        "la_candidate_bulkdecisiond0001"
      ];
      const drafts: Array<Record<string, unknown>> = [];
      const draft = (objectId: string, objectType: string, data: Record<string, unknown>) => ({
        schema_version: 1,
        authority_id: controlState.authority_id,
        object_id: objectId,
        object_type: objectType,
        version: 1,
        access_class: "local-private",
        encryption_class: "plaintext",
        created_at: now,
        updated_at: now,
        content_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        visible_metadata: { schema_namespace: "atlas/review-bulk-test", tombstone: false, size_class: "small", remote_indexable: false },
        payload: { kind: "plaintext-json", data }
      });
      for (const [index, candidateId] of candidateIds.entries()) {
        const suffix = String(index + 1).padStart(4, "0");
        const evidenceId = `la_object_bulkdecisionevidence${suffix}`;
        const reviewId = `la_object_bulkdecisionreview${suffix}`;
        const parityId = `la_object_bulkdecisionparity${suffix}`;
        const coverageKey = `la_coverage_bulkdecision${suffix}`;
        const observationIds = index === 2
          ? ["la_object_bulkdecisionobsc0001", "la_object_bulkdecisionobsc0002"]
          : [`la_object_bulkdecisionobs${suffix}`];
        drafts.push(draft(evidenceId, "evidence", {
          schema: "atlas.evidence:v1",
          evidence_id: evidenceId,
          source_kind: "migration",
          locator: `synthetic://bulk/${suffix}`,
          content_hash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          retrieved_at: now,
          independence_key: `synthetic-bulk-${suffix}`,
          extraction_method: "canonical-markdown-lossless-v1",
          excerpt: index === 2 ? "Invalid synthetic one.\nInvalid synthetic two." : `Valid synthetic ${suffix}.`
        }));
        observationIds.forEach((observationId, observationIndex) => drafts.push(draft(observationId, "assertion", {
          schema: "atlas.observation:v1",
          assertion_id: observationId,
          statement: index === 2 ? `Invalid synthetic ${observationIndex + 1}.` : `Valid synthetic ${suffix}.`,
          candidate_entity_ids: [],
          resolution_state: "owner-review",
          recorded_at: now,
          evidence_refs: [evidenceId]
        })));
        drafts.push(draft(reviewId, "review", {
          schema: "atlas.review-item:v1",
          review_id: reviewId,
          candidate_id: candidateId,
          source_coverage_keys: [coverageKey],
          recommendation: "owner-review",
          resolution_state: "owner-review",
          proposed_object_ids: observationIds,
          recorded_at: now
        }));
        drafts.push(draft(parityId, "manifest", {
          schema: "atlas.parity-record:v1",
          parity_id: parityId,
          source_coverage_key: coverageKey,
          coverage_state: "represented",
          representation_kind: "observation",
          canonical_object_ids: observationIds,
          idempotency_key: `la_idem_bulkdecision${suffix}`,
          recorded_at: now
        }));
      }
      await graphStore.initializeFromObjects(drafts as never);
      const context = createLocalMcpContextFromControlState({
        controlState,
        graphStore,
        decryptPayload: async (object) => decryptGraphObjectPayload(object, keyring),
        now
      });
      const server = createLocalReviewSiteServer({ context, browserSessionAuthorization: `Bearer ${token}` });
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("expected loopback address");
      const origin = `http://127.0.0.1:${address.port}`;
      const session = await fetch(origin);
      const cookie = session.headers.get("set-cookie")!.split(";")[0]!;

      const successful = await fetch(`${origin}/api/review/bulk/decision`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ candidate_ids: [candidateIds[1], candidateIds[0]], action: "defer" })
      });
      expect(successful.status).toBe(200);
      const successfulBody = await successful.json() as {
        ok: boolean;
        result: { resolved_candidate_ids: string[] };
        results: Array<{ candidate_id: string; ok: boolean; result?: { generation: number } }>;
      };
      expect(successfulBody).toMatchObject({
        ok: true,
        result: { resolved_candidate_ids: [candidateIds[0], candidateIds[1]] },
        results: [
          { candidate_id: candidateIds[0], ok: true },
          { candidate_id: candidateIds[1], ok: true }
        ]
      });
      expect(successfulBody.results.map((result) => result.result?.generation)).toEqual([
        expect.any(Number),
        expect.any(Number)
      ]);
      expect(successfulBody.results[1]!.result!.generation).toBe(successfulBody.results[0]!.result!.generation + 1);

      const partial = await fetch(`${origin}/api/review/bulk/decision`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ candidate_ids: [candidateIds[3], candidateIds[2]], action: "keep" })
      });
      expect(partial.status).toBe(409);
      await expect(partial.json()).resolves.toMatchObject({
        ok: false,
        reason: "bulk-decision-partial-failure",
        committed_candidate_ids: [candidateIds[3]],
        failed_candidate_ids: [candidateIds[2]],
        results: [
          { candidate_id: candidateIds[2], ok: false, reason: "candidate-records-incomplete" },
          { candidate_id: candidateIds[3], ok: true }
        ]
      });
      const queue = await fetch(`${origin}/api/review-queue`, { headers: { cookie } }).then((response) => response.json()) as LocalReviewQueue;
      expect(queue.owner_review.map((item) => item.candidate_id)).toContain(candidateIds[2]);
      expect(queue.automatic.map((item) => item.candidate_id)).toContain(candidateIds[3]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("creates an HttpOnly loopback browser session when launched with local authorization", async () => {
    const token = "local-review-site-token-0002";
    const context = createFixtureLocalMcpContext({ credentialStore: new InMemoryLocalMcpCredentialStore([{
      credential_id: "la_local_credential_reviewsite0002", client_id: fixtureLocalClientId, capability_id: "la_cap_localfull0001", token_hash: await hashLocalMcpToken(token), created_at: "2026-07-10T12:00:00.000Z"
    }]), now: "2026-07-10T12:00:00.000Z" });
    const server = createLocalReviewSiteServer({
      context,
      browserSessionAuthorization: `Bearer ${token}`
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected loopback address");
    const origin = `http://127.0.0.1:${address.port}`;

    const page = await fetch(origin);
    const cookie = page.headers.get("set-cookie");
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).not.toContain("Local authorization");
    expect(html).toContain("Secure local session");
    expect(cookie).toMatch(/^atlas_review_session=/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
    await expect(fetch(`${origin}/api/review-queue`, {
      headers: { cookie: cookie!.split(";")[0]! }
    }).then(async (response) => ({ status: response.status, body: await response.json() }))).resolves.toMatchObject({
      status: 200,
      body: { owner_review: [], research: [], automatic: [] }
    });
  });

  it("requires local bearer authorization before returning any review queue", async () => {
    const token = "local-review-site-token-0001";
    const context = createFixtureLocalMcpContext({ credentialStore: new InMemoryLocalMcpCredentialStore([{
      credential_id: "la_local_credential_reviewsite0001", client_id: fixtureLocalClientId, capability_id: "la_cap_localfull0001", token_hash: await hashLocalMcpToken(token), created_at: "2026-07-10T12:00:00.000Z"
    }]), now: "2026-07-10T12:00:00.000Z" });
    const server = createLocalReviewSiteServer({ context });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected loopback address");
    const url = `http://127.0.0.1:${address.port}/api/review-queue`;

    await expect(fetch(url)).resolves.toMatchObject({ status: 401 });
    await expect(fetch(url, { headers: { authorization: `Bearer ${token}` } }).then(async (response) => ({ status: response.status, body: await response.json() }))).resolves.toMatchObject({ status: 200, body: { owner_review: [], research: [], automatic: [] } });
    await expect(fetch(`${url.replace("/api/review-queue", "")}/api/review/la_candidate_notowner0001/apply`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "not-json"
    }).then(async (response) => ({ status: response.status, body: await response.json() }))).resolves.toEqual({ status: 409, body: { ok: false, reason: "candidate-not-owner-review" } });
    await expect(fetch(`${url.replace("/api/review-queue", "")}/api/review/bulk/apply`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ resolutions: [{ candidate_id: "la_candidate_notowner0001" }] })
    }).then(async (response) => ({ status: response.status, body: await response.json() }))).resolves.toEqual({ status: 409, body: { ok: false, reason: "candidate-not-owner-review" } });
  });
});
