import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AtlasCapabilityRequired,
  AtlasToolRefusal,
  isRedaction,
  type AtlasConsumerClient,
  type AtlasRedaction,
  type ElicitationRequest
} from "@living-atlas/atlas-client";
import { SEALED_PREDICATE } from "./fixture.js";
import { startSharedSession, type SharedSession } from "./harness.js";

/**
 * Disclosure: refused, approved, and tampered with.
 *
 * Three properties are being proven, and they fail in three different places:
 *
 *  - a client that declared no elicitation gets a JSON-RPC `-32021`, not a
 *    result with the number in a field, because only the error form is something
 *    a conformant client can branch on;
 *  - a client that declared one gets a real round trip through a real owner
 *    decision, and the record only after the answer came back "accept";
 *  - a state whose bytes were edited is refused BEFORE the handler runs, on the
 *    argument channel as well as the protocol channel — a verification enforced
 *    on one channel and not the other is not enforced.
 *
 * One server serves all of them. Nothing here writes to the graph — a reveal
 * discloses, it does not commit — so the fixture every scenario reads is the
 * same fixture throughout, and the audit assertions are DELTAS: "this call wrote
 * exactly one event" is the invariant, and it is a stronger claim than "the log
 * holds exactly one event".
 */

let shared: SharedSession;

beforeAll(async () => {
  shared = await startSharedSession();
});

afterAll(async () => {
  await shared.dispose();
});

/** The stub id the fixture's sealed record shows this credential, found by reading. */
async function sealedStub(client: AtlasConsumerClient): Promise<AtlasRedaction> {
  const page = await client.queryAssertions({});
  const stub = page.results.find((row) => isRedaction(row));
  if (!stub || !isRedaction(stub)) throw new Error("the fixture graph exposed no withheld row");
  return stub;
}

describe("step 7 — a disclosure this client cannot ask for", () => {
  it("is refused with -32021 naming the capability, not with a result nobody can branch on", async () => {
    // No decider, therefore no declared elicitation. The two are the same fact
    // in this client, which is why this scenario needs no special wiring.
    const silent = shared.as({});
    expect(silent.canElicit).toBe(false);

    const stub = await sealedStub(silent);
    const marker = shared.workspace.auditMark();
    const failure = await silent
      .revealSensitive({ redaction_id: stub.redaction_id, reason: "checking a citation" })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AtlasCapabilityRequired);
    // The spec's own `data` shape: a ClientCapabilities object, not a list of names.
    expect((failure as AtlasCapabilityRequired).requiredCapabilities).toEqual({ elicitation: {} });
    expect((failure as AtlasCapabilityRequired).record?.code).toBe("capability-required");
    // Retrying the identical bytes cannot work — declaring the capability is the
    // caller changing the request.
    expect((failure as AtlasCapabilityRequired).record?.retryable).toBe(false);

    // The refusal was RECORDED, and the receipt reached the caller. An audit
    // trail a consumer does not know exists is one it cannot reason about.
    const receipt = (failure as AtlasCapabilityRequired).result?.["audit"] as { event_id?: string } | undefined;
    expect(receipt?.event_id).toMatch(/^la_audit_/);

    const written = shared.workspace.auditSince(marker).filter((event) => event.tool === "atlas.sensitive.reveal.v1");
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ outcome: "refused", reason_code: "capability-required" });
    expect(written[0]?.event_id).toBe(receipt?.event_id);
  });
});

describe("step 8 — a disclosure the owner decided on", () => {
  it("discloses the record only after an accept comes back on the same signed state", async () => {
    const asked: ElicitationRequest[] = [];
    const approving = shared.as({
      elicitation: (request) => {
        asked.push(request);
        return { action: "accept", content: { approve: true } };
      }
    });
    expect(approving.canElicit).toBe(true);

    const stub = await sealedStub(approving);
    const marker = shared.workspace.auditMark();
    const result = await approving.revealSensitive({ redaction_id: stub.redaction_id, reason: "checking a citation" });

    expect(result.outcome).toBe("revealed");
    expect(result.record?.record_schema).toBe("atlas.assertion:v1");
    expect(result.record).toMatchObject({ predicate: SEALED_PREDICATE });

    // The owner was asked ONCE, with the stated reason in the prompt — an
    // unattributed disclosure request is one nobody can judge.
    expect(asked).toHaveLength(1);
    expect(asked[0]?.message).toContain("checking a citation");
    expect(asked[0]?.method).toBe("elicitation/create");
    // The state is SIGNED, not encrypted, so the client can read it — and what
    // is readable must be only a redaction id and a request id.
    const [, body] = (asked[0]?.requestState ?? "").split(".");
    const payload = JSON.parse(Buffer.from(body ?? "", "base64url").toString("utf8")) as { p: Record<string, unknown> };
    expect(Object.keys(payload.p).sort()).toEqual(["redaction_id", "request_id"]);
    expect(JSON.stringify(payload)).not.toContain("synthetic sealed value");

    // One event for the escalation and one for the disclosure. Two calls, two
    // events — never one per record touched.
    const written = shared.workspace.auditSince(marker).filter((event) => event.tool === "atlas.sensitive.reveal.v1");
    expect(written.map((event) => event.outcome)).toEqual(["input-required", "ok"]);
    expect(written[1]?.event_id).toBe(result.audit.event_id);
  });

  it("discloses nothing when the owner declined, and still records the attempt", async () => {
    const declining = shared.as({ elicitation: () => ({ action: "decline" }) });
    const stub = await sealedStub(declining);

    const result = await declining.revealSensitive({ redaction_id: stub.redaction_id, reason: "checking a citation" });

    expect(result.outcome).toBe("refused");
    expect(result.record).toBeUndefined();
    expect(result.error?.code).toBe("reveal-declined");
    // The refusal carries its own receipt, exactly as the disclosure would.
    expect(result.audit.event_id).toMatch(/^la_audit_/);
  });

  it("refuses a stub id that was never issued to this credential", async () => {
    const approving = shared.as({ elicitation: () => ({ action: "accept" }) });

    const result = await approving.revealSensitive({
      redaction_id: "la_redaction_notissuedtothiscredential",
      reason: "probing"
    });

    // Not an exception: an unknown stub is an in-contract refusal carrying its
    // receipt, because the attempt still has to be recorded.
    expect(result.outcome).toBe("refused");
    expect(result.error?.code).toBe("unknown-redaction");
  });
});

describe("step 9 — a request_state that was edited", () => {
  it("is refused on the ARGUMENT channel too, before the handler ever runs", async () => {
    let captured: string | undefined;
    const approving = shared.as({
      elicitation: (request) => {
        captured = request.requestState;
        return { action: "accept", content: { approve: true } };
      }
    });

    const stub = await sealedStub(approving);
    // A genuine escalation first, so the state being tampered with is a real one
    // rather than something hand-written that could fail for a duller reason.
    const honest = await approving.revealSensitive({ redaction_id: stub.redaction_id, reason: "checking a citation" });
    expect(honest.outcome).toBe("revealed");
    expect(captured).toBeDefined();

    // Flip the last three characters of the MAC. Everything else is byte-identical.
    const tampered = `${(captured ?? "").slice(0, -3)}AAA`;
    const marker = shared.workspace.auditMark();
    const failure = await approving
      .revealSensitive({ redaction_id: stub.redaction_id, reason: "checking a citation", request_state: tampered })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AtlasToolRefusal);
    expect((failure as AtlasToolRefusal).code).toBe("invalid-request-state");
    // Opaque on purpose. Distinguishing 'bad mac' from 'expired' from 'wrong
    // principal' would tell a prober which of its guesses was wrong.
    expect((failure as AtlasToolRefusal).record.jsonrpc_code).toBe(-32602);

    // Nothing was disclosed and nothing was escalated, so the tampered attempt
    // wrote NO event at all: the refusal happens before any handler runs.
    expect(shared.workspace.auditSince(marker)).toEqual([]);
  });
});

describe("one call, one audit event", () => {
  it("writes a single event with aggregate counts for a read that touched several rows", async () => {
    const marker = shared.workspace.auditMark();
    const page = await shared.client.queryAssertions({});
    expect(page.results.length).toBeGreaterThan(2);

    const queries = shared.workspace.auditSince(marker).filter((event) => event.tool === "atlas.assertion.query.v1");
    // ONE. The defect this replaces put the recorder inside a per-record loop,
    // so a whole-graph read wrote an event per row and the log became unusable
    // exactly when someone needed to read it.
    expect(queries).toHaveLength(1);
    expect(queries[0]?.counts).toMatchObject({ returned: page.results.length, withheld: 1 });
  });
});
