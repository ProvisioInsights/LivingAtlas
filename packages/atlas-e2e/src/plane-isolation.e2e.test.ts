import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CONTRACT_PROTOCOL_VERSION, CONTRACT_TOOL_NAMES } from "@living-atlas/atlas-contract";
import { ATLAS_CREDENTIAL_META_KEY, AtlasContractViolation, AtlasToolRefusal } from "@living-atlas/atlas-client";
import { CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY } from "@modelcontextprotocol/server";
import { E2E_SCENARIO_TIMEOUT_MS, startSharedSession, type SharedSession } from "./harness.js";
// These scenarios spawn real child processes; see E2E_SCENARIO_TIMEOUT_MS.
vi.setConfig({ testTimeout: E2E_SCENARIO_TIMEOUT_MS });


/**
 * The operator plane, as seen from a consumer credential: not there.
 *
 * Two separate claims, and only both together mean anything.
 *
 *  - The operator TOOL is absent. It is not registered on this server at all, so
 *    it cannot appear in a listing and cannot be called. That is a property of
 *    the code — `TOOL_HANDLERS` is keyed by the published twelve — rather than of
 *    a filter somebody has to remember to apply.
 *  - The operator CREDENTIAL is refused. A credential bound to the operator plane
 *    never reaches a handler on this server, whatever it asks for. Without this
 *    the first claim would only prove that nobody had registered the tool yet.
 *
 * The prior surface got this wrong in exactly the way the second claim guards
 * against: six tools were documented local-only and the enforcing list named
 * four, so two tools whose own descriptions read "Local-only" were reachable
 * remotely, and both copies type-checked.
 *
 * All three credentials — consumer, operator, anonymous — speak to ONE server
 * process. That is not a shortcut: credentials are per-request input on this
 * revision, so a single process serving all three and answering each differently
 * is a stronger demonstration than three processes each seeing one.
 */

let shared: SharedSession;

beforeAll(async () => {
  shared = await startSharedSession();
});

afterAll(async () => {
  await shared.dispose();
});

const OPERATOR_TOOL = "atlas.ops.scope.describe.v1";

describe("step 11 — the operator plane is invisible to a consumer credential", () => {
  it("publishes exactly the twelve consumer tools and nothing from the other plane", async () => {
    const marker = shared.workspace.auditMark();
    const listed = await shared.client.listTools();

    expect(listed.map((tool) => tool.name)).toEqual([...CONTRACT_TOOL_NAMES]);
    expect(listed.some((tool) => tool.name.startsWith("atlas.ops."))).toBe(false);

    // The listing is itself an authorization decision — the set varies by the
    // credential presented — so it writes its own audit event. Without one this
    // would be the only credential-varying operation leaving no trace, and a
    // caller could enumerate credentials against it invisibly.
    const listings = shared.workspace.auditSince(marker).filter((event) => event.tool === "tools/list");
    expect(listings).toHaveLength(1);
    expect(listings[0]).toMatchObject({ outcome: "ok", counts: { returned: CONTRACT_TOOL_NAMES.length } });
  });

  it("cannot even be asked for through the typed client, because no such schema is published", async () => {
    // `call()` is keyed by the published tool union, so this does not type-check
    // without the cast — and at runtime the client refuses before anything is
    // sent, because it validates arguments against a published input schema that
    // does not exist for this name. A client that fell back to "no schema, send
    // it anyway" would be a client with no contract.
    const failure = await shared.client.call(OPERATOR_TOOL as never, {} as never).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AtlasContractViolation);
    expect((failure as AtlasContractViolation).direction).toBe("input");
    expect((failure as AtlasContractViolation).errors.join(" ")).toContain("no input schema");
  });

  it("is refused by the server too, so the client-side check is a convenience and not the boundary", async () => {
    await shared.client.discover();

    // Straight down the transport, past every check this client makes. The
    // server is the boundary; the typed client is a convenience on top of it,
    // and a test that only exercised the convenience would prove nothing about
    // where the boundary is.
    const response = await shared.server.transport.request({
      jsonrpc: "2.0",
      id: 9001,
      method: "tools/call",
      params: {
        name: OPERATOR_TOOL,
        arguments: {},
        _meta: {
          [PROTOCOL_VERSION_META_KEY]: CONTRACT_PROTOCOL_VERSION,
          [CLIENT_CAPABILITIES_META_KEY]: {},
          [CLIENT_INFO_META_KEY]: { name: "atlas-e2e", version: "1" },
          [ATLAS_CREDENTIAL_META_KEY]: shared.workspace.secrets.consumer
        }
      }
    });

    const answered = response.error !== undefined || response.result?.["isError"] === true;
    expect(answered, "the consumer server answered an operator tool call successfully").toBe(true);
    // Whatever the shape of the refusal, nothing operator-shaped came back.
    expect(JSON.stringify(response.result ?? {})).not.toContain("grant_id");
  });
});

describe("step 12 — an operator credential on the consumer server", () => {
  it("never reaches a handler, and is told nothing that distinguishes it from an unknown secret", async () => {
    const operator = shared.as({ principal: "operator" });
    const marker = shared.workspace.auditMark();

    const failure = await operator.describeScope().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AtlasToolRefusal);
    expect((failure as AtlasToolRefusal).code).toBe("credential-unrecognised");
    // One answer for every cause. Telling a prober that its secret is real but
    // on the wrong plane hands over the more useful half of the answer.
    expect((failure as AtlasToolRefusal).record.message).not.toContain("operator");
    expect((failure as AtlasToolRefusal).record.message).not.toContain("plane");

    // The event, however, carries the PRECISE cause: the wire tells the caller
    // as little as possible and the audit log tells the owner everything.
    const events = shared.workspace.auditSince(marker).filter((event) => event.tool === "atlas.scope.describe.v1");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: "refused", reason_code: "credential-plane-mismatch" });
  });

  it("gets an empty tool listing rather than an error, and the probe is still recorded", async () => {
    const operator = shared.as({ principal: "operator" });
    const marker = shared.workspace.auditMark();

    // The honest answer to "what may I call" from a credential this server does
    // not recognise is "nothing" — and the spec allows an empty set. `tools/call`
    // refuses explicitly instead, because there the caller needs to learn why.
    expect(await operator.listTools()).toEqual([]);

    const listings = shared.workspace.auditSince(marker).filter((event) => event.tool === "tools/list");
    expect(listings).toHaveLength(1);
    expect(listings[0]).toMatchObject({ outcome: "refused", counts: { returned: 0 } });
  });
});

describe("a request presenting no credential at all", () => {
  it("is refused with a code that names the member the credential belongs on", async () => {
    const anonymous = shared.as({ anonymous: true });

    const failure = await anonymous.describeScope().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AtlasToolRefusal);
    expect((failure as AtlasToolRefusal).code).toBe("credential-required");
    // Naming the member is safe and useful: it is a protocol fact, not a secret,
    // and without it a caller cannot tell "wrong secret" from "wrong place".
    expect((failure as AtlasToolRefusal).record.message).toContain(ATLAS_CREDENTIAL_META_KEY);
  });
});
