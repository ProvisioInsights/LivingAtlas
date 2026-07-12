import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { canonicalPayloadObjectId, type CanonicalReviewItemPayload } from "@living-atlas/contracts";
import {
  canonicalResearchNormalizedQueryHash,
  runCanonicalResearchCandidate,
  type CanonicalResearchTransport,
  type CanonicalResearchTransportResult
} from "./canonical-research-runner";

const now = "2026-07-11T12:00:00.000Z";
const unitId = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const query = "  Synthetic   Organization STATUS  ";

function hashText(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function review(overrides: Partial<CanonicalReviewItemPayload> = {}): CanonicalReviewItemPayload {
  return {
    schema: "atlas.review-item:v1",
    review_id: "la_object_researchreview0001",
    candidate_id: "la_candidate_research0001",
    source_coverage_keys: ["la_coverage_research0001"],
    recommendation: "research",
    resolution_state: "research",
    proposed_object_ids: [],
    research_requested_at: now,
    research_requested_unit_hashes: [unitId],
    recorded_at: now,
    ...overrides
  };
}

function transportResult(index: number, overrides: Partial<CanonicalResearchTransportResult> = {}): CanonicalResearchTransportResult {
  const suffix = String(index).padStart(4, "0");
  const result = {
    upstream_identity: `synthetic-upstream-${suffix}`,
    locator: `synthetic://public-record/${suffix}`,
    independence_key: `synthetic-public-group-${suffix}`,
    content_hash: hashText(`Synthetic bounded public evidence ${suffix}.`),
    retrieved_at: now,
    excerpt: `Synthetic bounded public evidence ${suffix}.`,
    stance: "supports",
    identity_state: "resolved",
    identity_confidence: { band: "high", method: "synthetic-identity" },
    proposal: {
      kind: "fact",
      subject_entity_id: "la_object_researchentity0001",
      predicate: "status",
      value: { kind: "text", value: "Synthetic active status" }
    },
    ...overrides
  };
  return {
    ...result,
    content_hash: overrides.content_hash ?? (result.excerpt ? hashText(result.excerpt) : result.content_hash)
  } as CanonicalResearchTransportResult;
}

function runnerInput(transport: CanonicalResearchTransport, overrides: Record<string, unknown> = {}) {
  return {
    review_item: review(),
    source_unit_id: unitId,
    connector_kind: "public-web" as const,
    algorithm_version: "canonical-research-v1",
    query,
    normalized_query_hash: canonicalResearchNormalizedQueryHash(query),
    transport,
    now: () => now,
    prior_records: [],
    ...overrides
  };
}

describe("canonical research runner", () => {
  it("rejects authorization, query-hash, prior-snapshot, and transport failures before any implicit work", async () => {
    const run = vi.fn(async () => []);
    const transport = { run };

    await expect(runCanonicalResearchCandidate(runnerInput(transport, {
      source_unit_id: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    }) as never)).rejects.toThrow("source unit is not authorized");
    await expect(runCanonicalResearchCandidate(runnerInput(transport, {
      normalized_query_hash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    }) as never)).rejects.toThrow("normalized query hash mismatch");
    const { prior_records: _prior, ...withoutPrior } = runnerInput(transport);
    await expect(runCanonicalResearchCandidate(withoutPrior as never)).rejects.toThrow("prior record snapshot is required");
    await expect(runCanonicalResearchCandidate(runnerInput(undefined as never))).rejects.toThrow("research transport is required");
    await expect(runCanonicalResearchCandidate(runnerInput(transport, {
      review_item: { ...review(), candidate_id: "malformed-candidate" }
    }) as never)).rejects.toThrow();
    await expect(runCanonicalResearchCandidate(runnerInput(transport, {
      algorithm_version: ""
    }) as never)).rejects.toThrow("algorithm version");
    expect(run).not.toHaveBeenCalled();
  });

  it("accepts research_requested_all and normalizes queries with NFKC, whitespace collapse, and lowercase", async () => {
    expect(canonicalResearchNormalizedQueryHash("ＦＯＯ　 Bar"))
      .toBe(canonicalResearchNormalizedQueryHash("foo bar"));
    const run = vi.fn(async () => [transportResult(1)]);
    await expect(runCanonicalResearchCandidate(runnerInput({ run }, {
      review_item: review({ research_requested_all: true, research_requested_unit_hashes: undefined }),
      source_unit_id: "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
    }) as never)).resolves.toMatchObject({ records: [expect.any(Object)] });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("builds deterministic local-private canonical drafts and a content-free receipt", async () => {
    const left = transportResult(1);
    const right = transportResult(2, { independence_key: "synthetic-independent-organization" });
    const first = await runCanonicalResearchCandidate(runnerInput({ run: async () => [right, left] }));
    const second = await runCanonicalResearchCandidate(runnerInput({ run: async () => [left, right] }));

    expect(second).toEqual(first);
    expect(first.recommendation).toBe("auto-apply");
    expect(first.records).toHaveLength(2);
    expect(first.draft_intents).toHaveLength(5);
    expect(first.draft_intents.every((intent) => intent.access_class === "local-private")).toBe(true);
    expect(new Set(first.draft_intents.map((intent) => intent.payload.schema))).toEqual(new Set([
      "atlas.evidence:v1",
      "atlas.research-result:v1",
      "atlas.fact:v1"
    ]));
    const serializedReceipt = JSON.stringify(first.receipt);
    for (const privateValue of [query, left.locator, left.excerpt!, "Synthetic active status", left.upstream_identity]) {
      expect(serializedReceipt).not.toContain(privateValue);
    }
    expect(serializedReceipt).not.toMatch(/query\"|locator|excerpt|snapshot|proposal/i);
  });

  it("persists identity state and explicit relationship basis for boundary evaluation", async () => {
    const proposal = {
      kind: "relationship" as const,
      source_entity_id: "la_object_researchperson0001",
      source_type: "person" as const,
      target_entity_id: "la_object_researchorganization0001",
      target_type: "organization" as const,
      predicate: "advises" as const,
      valid_from: "2026"
    };
    const output = await runCanonicalResearchCandidate(runnerInput({
      run: async () => [
        transportResult(1, { proposal, relationship_basis: "explicit" }),
        transportResult(2, { proposal, relationship_basis: "explicit" })
      ]
    }));

    expect(output.recommendation).toBe("auto-apply");
    expect(output.records).toHaveLength(2);
    expect(output.records.every((record) => record.result.identity_state === "resolved")).toBe(true);
    expect(output.records.every((record) => record.result.relationship_basis === "explicit")).toBe(true);
  });

  it("persists ambiguous identity state and keeps the candidate in owner review", async () => {
    const output = await runCanonicalResearchCandidate(runnerInput({
      run: async () => [
        transportResult(1, { identity_state: "ambiguous" }),
        transportResult(2, { identity_state: "ambiguous" })
      ]
    }));

    expect(output.records).toHaveLength(2);
    expect(output.records.every((record) => record.result.identity_state === "ambiguous")).toBe(true);
    expect(output.recommendation).toBe("owner-review");
    expect(output.receipt.reason_codes).toContain("identity-ambiguous");
  });

  it("returns exact prior bytes without replacement drafts on replay", async () => {
    const transport = { run: async () => [transportResult(1), transportResult(2)] };
    const first = await runCanonicalResearchCandidate(runnerInput(transport));
    const priorBytes = structuredClone(first.records);
    const replay = await runCanonicalResearchCandidate(runnerInput(transport, { prior_records: first.records }));

    expect(replay.run_id).toBe(first.run_id);
    expect(replay.records).toEqual(first.records);
    expect(replay.draft_intents).toEqual([]);
    expect(replay.receipt.counts).toMatchObject({ appended: 0, replayed: 2, rejected: 0 });
    expect(replay.receipt.reason_codes).toContain("exact-replay");
  });

  it("rejects an inconsistent prior snapshot before calling the transport", async () => {
    const first = await runCanonicalResearchCandidate(runnerInput({ run: async () => [transportResult(1)] }));
    const corrupted = structuredClone(first.records);
    corrupted[0]!.evidence.excerpt = "Synthetic tampered prior evidence.";
    const run = vi.fn(async () => [transportResult(1)]);

    await expect(runCanonicalResearchCandidate(runnerInput({ run }, { prior_records: corrupted })))
      .rejects.toThrow("prior research record is invalid");
    expect(run).not.toHaveBeenCalled();
  });

  it("recomputes prior run provenance instead of trusting a self-consistent forged run ID", async () => {
    const first = await runCanonicalResearchCandidate(runnerInput({ run: async () => [transportResult(1)] }));
    const forged = structuredClone(first.records);
    const result = forged[0]!.result;
    result.run_id = "la_research_run_bbbbbbbbbbbbbbbbbbbbbbbb";
    const resultIdentity = JSON.stringify({
      evidence_id: result.evidence_id,
      proposed_mutation_hash: result.proposed_mutation_hash,
      run_id: result.run_id
    });
    result.research_result_id = `la_object_${hashText(resultIdentity).slice("sha256:".length, "sha256:".length + 24)}`;
    const run = vi.fn(async () => [transportResult(1)]);

    await expect(runCanonicalResearchCandidate(runnerInput({ run }, { prior_records: forged })))
      .rejects.toThrow("prior research record is invalid");
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects a prior relationship record with a forged deterministic edge ID", async () => {
    const proposal = {
      kind: "relationship" as const,
      source_entity_id: "la_object_researchperson0001",
      source_type: "person" as const,
      target_entity_id: "la_object_researchorganization0001",
      target_type: "organization" as const,
      predicate: "advises" as const,
      valid_from: "2026"
    };
    const source = transportResult(1, { proposal, relationship_basis: "explicit" });
    const first = await runCanonicalResearchCandidate(runnerInput({ run: async () => [source] }));
    const forged = structuredClone(first.records);
    const storedProposal = forged[0]!.proposal;
    if (storedProposal.schema !== "atlas.relationship:v2") throw new Error("expected relationship proposal");
    storedProposal.edge_id = "la_edge_researchforgedprior0001";
    const run = vi.fn(async () => [source]);

    await expect(runCanonicalResearchCandidate(runnerInput({ run }, { prior_records: forged })))
      .rejects.toThrow("prior research record is invalid");
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps the run stable but appends new evidence/result IDs when upstream content changes", async () => {
    const original = transportResult(1);
    const first = await runCanonicalResearchCandidate(runnerInput({ run: async () => [original] }));
    const priorBytes = structuredClone(first.records);
    const changed = transportResult(1, {
      excerpt: "Synthetic changed bounded evidence."
    });
    const next = await runCanonicalResearchCandidate(runnerInput(
      { run: async () => [changed] },
      { prior_records: first.records }
    ));

    expect(next.run_id).toBe(first.run_id);
    const appended = next.records.find((record) => (
      record.result.research_result_id !== first.records[0]!.result.research_result_id
    ));
    expect(appended?.evidence.evidence_id).not.toBe(first.records[0]!.evidence.evidence_id);
    expect(appended?.result.research_result_id).not.toBe(first.records[0]!.result.research_result_id);
    expect(first.records).toEqual(priorBytes);
    expect(next.receipt.counts).toMatchObject({ appended: 1, replayed: 0 });
  });

  it("changes the run ID when the normalized query or algorithm changes", async () => {
    const transport = { run: async () => [transportResult(1)] };
    const first = await runCanonicalResearchCandidate(runnerInput(transport));
    const changedQuery = "Synthetic organization current status";
    const queryRun = await runCanonicalResearchCandidate(runnerInput(transport, {
      query: changedQuery,
      normalized_query_hash: canonicalResearchNormalizedQueryHash(changedQuery)
    }));
    const algorithmRun = await runCanonicalResearchCandidate(runnerInput(transport, {
      algorithm_version: "canonical-research-v2"
    }));

    expect(queryRun.run_id).not.toBe(first.run_id);
    expect(algorithmRun.run_id).not.toBe(first.run_id);
  });

  it("returns redacted research failure receipts without fabricating records", async () => {
    const output = await runCanonicalResearchCandidate(runnerInput({
      run: async () => { throw new Error("private upstream profile failed at synthetic://secret"); }
    }));

    expect(output).toMatchObject({ recommendation: "research", records: [], draft_intents: [] });
    expect(output.receipt.reason_codes).toEqual(["transport-failed"]);
    expect(JSON.stringify(output.receipt)).not.toContain("private upstream profile");
    expect(JSON.stringify(output.receipt)).not.toContain("synthetic://secret");
  });

  it.each([
    {
      label: "a mismatched evidence content hash",
      result: transportResult(1, {
        content_hash: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
      })
    },
    {
      label: "a missing identity-state marker",
      result: { ...transportResult(1), identity_state: undefined }
    },
    {
      label: "a relationship without a basis marker",
      result: transportResult(1, {
        proposal: {
          kind: "relationship",
          source_entity_id: "la_object_researchperson0001",
          source_type: "person",
          target_entity_id: "la_object_researchorganization0001",
          target_type: "organization",
          predicate: "advises",
          valid_from: "2026"
        }
      } as never)
    },
    {
      label: "an extra whole-profile field",
      result: { ...transportResult(1), whole_profile: { name: "Synthetic Private Profile" } }
    },
    {
      label: "an oversized excerpt",
      result: transportResult(1, { excerpt: "x".repeat(4_097) })
    },
    {
      label: "a cross-field-invalid fact value",
      result: transportResult(1, {
        proposal: {
          kind: "fact",
          subject_entity_id: "la_object_researchentity0001",
          predicate: "status",
          value: { kind: "date", value: "2026" }
        } as never
      })
    },
    {
      label: "a contact-detail proposal",
      result: transportResult(1, {
        proposal: {
          kind: "fact",
          subject_entity_id: "la_object_researchentity0001",
          predicate: "phone",
          value: { kind: "text", value: "+1 555 0100" }
        }
      })
    },
    {
      label: "an inferred sensitive relationship",
      result: transportResult(1, {
        relationship_basis: "inferred-sensitive",
        proposal: {
          kind: "relationship",
          source_entity_id: "la_object_researchperson0001",
          source_type: "person",
          target_entity_id: "la_object_researchorganization0001",
          target_type: "organization",
          predicate: "advises",
          valid_from: "2026"
        }
      })
    },
    {
      label: "nested profile data in relationship attrs",
      result: transportResult(1, {
        relationship_basis: "explicit",
        proposal: {
          kind: "relationship",
          source_entity_id: "la_object_researchperson0001",
          source_type: "person",
          target_entity_id: "la_object_researchorganization0001",
          target_type: "organization",
          predicate: "advises",
          valid_from: "2026",
          attrs: { whole_profile: { phone: "+1 555 0100" } }
        } as never
      })
    }
  ])("rejects $label without unsafe draft intents", async ({ label, result }) => {
    const output = await runCanonicalResearchCandidate(runnerInput({ run: async () => [result as never] }));

    expect(output.records).toEqual([]);
    expect(output.draft_intents).toEqual([]);
    expect(output.receipt.counts.rejected).toBe(1);
    expect(output.receipt.reason_codes).toEqual(expect.arrayContaining([
      expect.stringMatching(/invalid-transport-result|contact-detail-prohibited|sensitive-relationship/)
    ]));
    if (label === "a contact-detail proposal" || label === "an inferred sensitive relationship") {
      expect(output.recommendation).toBe("owner-review");
    }
    expect(JSON.stringify(output.receipt)).not.toContain("Synthetic Private Profile");
    expect(JSON.stringify(output.receipt)).not.toContain("+1 555 0100");
  });

  it("mixes replay and append-only evidence into one stable proposal with sorted prior and new evidence links", async () => {
    const originalOne = transportResult(1);
    const originalTwo = transportResult(2);
    const first = await runCanonicalResearchCandidate(runnerInput({ run: async () => [originalOne, originalTwo] }));
    const priorBytes = structuredClone(first.records);
    const changedTwo = transportResult(2, { excerpt: "Synthetic changed second evidence." });
    const addedThree = transportResult(3);
    const next = await runCanonicalResearchCandidate(runnerInput({
      run: async () => [addedThree, originalOne, changedTwo]
    }, { prior_records: first.records }));

    expect(first.records).toEqual(priorBytes);
    expect(next.receipt.counts).toMatchObject({ appended: 2, replayed: 1, rejected: 0 });
    const proposalIntents = next.draft_intents.filter((intent) => intent.payload.schema === "atlas.fact:v1");
    expect(proposalIntents).toHaveLength(1);
    const proposal = proposalIntents[0]!.payload;
    expect(proposal.schema).toBe("atlas.fact:v1");
    if (proposal.schema !== "atlas.fact:v1") return;
    expect(proposal.assertion_id).toBe(first.records[0]!.proposal.assertion_id);
    const expectedEvidenceIds = new Set([
      ...first.records.map((record) => record.evidence.evidence_id),
      ...next.records.map((record) => record.evidence.evidence_id)
    ]);
    expect(proposal.evidence_links.map((link) => link.evidence_id))
      .toEqual([...expectedEvidenceIds].sort());
  });

  it("deduplicates exact transport repeats and fails deterministic-ID conflicts closed", async () => {
    const source = transportResult(1);
    const duplicate = await runCanonicalResearchCandidate(runnerInput({ run: async () => [source, { ...source }] }));
    expect(duplicate.receipt.counts).toMatchObject({ appended: 1, replayed: 1, rejected: 0 });
    expect(new Set(duplicate.draft_intents.map((intent) => canonicalPayloadObjectId(intent.payload))).size)
      .toBe(duplicate.draft_intents.length);

    const conflict = await runCanonicalResearchCandidate(runnerInput({
      run: async () => [source, { ...source, stance: "refutes" }]
    }));
    const reversed = await runCanonicalResearchCandidate(runnerInput({
      run: async () => [{ ...source, stance: "refutes" }, source]
    }));
    expect(conflict).toEqual(reversed);
    expect(conflict.receipt.counts).toMatchObject({ appended: 0, rejected: 2 });
    expect(conflict.recommendation).toBe("owner-review");
    expect(conflict.records).toEqual([]);
    expect(conflict.draft_intents).toEqual([]);
  });

  it("rejects same-ID retrieval-time collisions without order-dependent bytes", async () => {
    const first = transportResult(1);
    const later = { ...first, retrieved_at: "2026-07-12T12:00:00.000Z" };
    const forward = await runCanonicalResearchCandidate(runnerInput({ run: async () => [first, later] }));
    const reverse = await runCanonicalResearchCandidate(runnerInput({ run: async () => [later, first] }));

    expect(forward).toEqual(reverse);
    expect(forward).toMatchObject({ recommendation: "owner-review", records: [], draft_intents: [] });
    expect(forward.receipt.counts).toMatchObject({ appended: 0, rejected: 2 });
  });

  it("does not count one canonical evidence object under a changed independence group", async () => {
    const source = transportResult(1);
    const first = await runCanonicalResearchCandidate(runnerInput({ run: async () => [source] }));
    const changedQuery = "Synthetic organization status recheck";
    const next = await runCanonicalResearchCandidate(runnerInput({
      run: async () => [{ ...source, independence_key: "synthetic-forged-independent-group" }]
    }, {
      query: changedQuery,
      normalized_query_hash: canonicalResearchNormalizedQueryHash(changedQuery),
      prior_records: first.records
    }));

    expect(next.records).toEqual(first.records);
    expect(next.draft_intents).toEqual([]);
    expect(next.receipt.counts).toMatchObject({ appended: 0, rejected: 1 });
    expect(next.recommendation).toBe("owner-review");
  });

  it("does not auto-apply a valid corroboration set beside a rejected transport result", async () => {
    const invalid = { ...transportResult(3), whole_profile: { private: "synthetic" } };
    const output = await runCanonicalResearchCandidate(runnerInput({
      run: async () => [transportResult(1), transportResult(2), invalid as never]
    }));

    expect(output.receipt.counts).toMatchObject({ appended: 2, rejected: 1 });
    expect(output.recommendation).toBe("owner-review");
  });

  it("keeps independently corroborated competing proposals in owner review", async () => {
    const competingProposal = {
      kind: "fact" as const,
      subject_entity_id: "la_object_researchentity0001",
      predicate: "status" as const,
      value: { kind: "text" as const, value: "Synthetic inactive status" }
    };
    const output = await runCanonicalResearchCandidate(runnerInput({
      run: async () => [
        transportResult(1),
        transportResult(2),
        transportResult(3, { proposal: competingProposal }),
        transportResult(4, { proposal: competingProposal })
      ]
    }));

    expect(output.records).toHaveLength(4);
    expect(output.recommendation).toBe("owner-review");
    expect(output.receipt.reason_codes).toContain("proposal-conflict");
  });

  it("counts syndicated evidence as one independence group", async () => {
    const output = await runCanonicalResearchCandidate(runnerInput({
      run: async () => [
        transportResult(1, { independence_key: "synthetic-syndicated-group" }),
        transportResult(2, { independence_key: "synthetic-syndicated-group" })
      ]
    }));

    expect(output.recommendation).toBe("research");
    expect(output.receipt.independence_group_count).toBe(1);
  });

  it("has no default graph, MCP, HTTP, browser, or provider integration", async () => {
    const source = await readFile(new URL("./canonical-research-runner.ts", import.meta.url), "utf8");

    for (const forbidden of [
      "FileLocalGraphStore",
      "localResolutionApply",
      "@living-atlas/local-mcp",
      "fetch(",
      "playwright",
      "@linkedin",
      "provider-sdk"
    ]) expect(source).not.toContain(forbidden);
    expect(source).not.toMatch(/console\.(log|error|warn)/);
  });
});
