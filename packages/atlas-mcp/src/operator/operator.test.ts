import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CONTRACT_TOOL_NAMES } from "@living-atlas/atlas-contract";
import { ERROR_CODE_SET } from "../vocabulary.js";
import { OPERATOR_ERROR_CODES, OPERATOR_ERROR_CODE_SET } from "./vocabulary.js";
import { MemoryAuditJournal } from "../audit.js";
import { InMemoryCredentialDirectory, credentialResolver, hashCredential } from "../credentials.js";
import { TOOL_HANDLERS } from "../tools.js";
import type { Principal } from "../principal.js";
import {
  CONSUMER_PRINCIPAL,
  callTool,
  credentialEnvelope,
  listTools,
  startHarness,
  type Harness
} from "../testing.js";
import { OPERATOR_TOOL_NAMES } from "./tools.js";
import {
  OPERATOR_GRANT,
  OPERATOR_PRINCIPAL,
  startOperatorHarness,
  syntheticOperatorSource,
  type OperatorHarness
} from "./testing.js";

const operators: OperatorHarness[] = [];
const consumers: Harness[] = [];

function operatorHarness(...args: Parameters<typeof startOperatorHarness>): OperatorHarness {
  const instance = startOperatorHarness(...args);
  operators.push(instance);
  return instance;
}

function consumerHarness(...args: Parameters<typeof startHarness>): Harness {
  const instance = startHarness(...args);
  consumers.push(instance);
  return instance;
}

afterEach(async () => {
  while (operators.length > 0) await operators.pop()?.handle.close();
  while (consumers.length > 0) await consumers.pop()?.handle.close();
});

const OPERATOR_SECRET = "synthetic-operator-secret";
const CONSUMER_SECRET = "synthetic-consumer-secret";

/** One directory holding both classes, so the plane check is what separates them. */
function bothPlanes(extra: Principal[] = []) {
  return new InMemoryCredentialDirectory([
    { token_hash: hashCredential(OPERATOR_SECRET), principal: OPERATOR_PRINCIPAL },
    { token_hash: hashCredential(CONSUMER_SECRET), principal: CONSUMER_PRINCIPAL },
    ...extra.map((principal, index) => ({ token_hash: hashCredential(`extra-${index}`), principal }))
  ]);
}

function structured(response: { result?: Record<string, unknown> }): Record<string, unknown> {
  return (response.result?.["structuredContent"] ?? {}) as Record<string, unknown>;
}

function errorPayload(response: { result?: Record<string, unknown> }): Record<string, unknown> {
  const content = response.result?.["content"] as { text: string }[] | undefined;
  return JSON.parse(String(content?.[0]?.text ?? "{}")) as Record<string, unknown>;
}

function callOperator(input: { id: number; name: string; secret?: string; args?: Record<string, unknown> }) {
  return callTool({
    id: input.id,
    name: input.name,
    ...(input.args === undefined ? {} : { args: input.args }),
    ...(input.secret === undefined ? {} : { meta: credentialEnvelope(input.secret) })
  });
}

describe("the operator plane is separate from the consumer plane", () => {
  it("shares no tool name with the published consumer contract", () => {
    const consumer = new Set<string>(CONTRACT_TOOL_NAMES);
    const overlap = OPERATOR_TOOL_NAMES.filter((name) => consumer.has(name));
    expect(overlap).toEqual([]);
    // And the consumer dispatch table is total over the published twelve, so an
    // operator tool is not expressible there even by mistake.
    expect(Object.keys(TOOL_HANDLERS).sort()).toEqual([...CONTRACT_TOOL_NAMES].sort());
  });

  it("never advertises an operator tool in a consumer's tools/list", async () => {
    const { client } = consumerHarness();
    client.send(listTools({ id: 1 }));
    const listed = ((await client.await(1)).result?.["tools"] ?? []) as { name: string }[];
    const names = listed.map((tool) => tool.name);
    for (const operatorTool of OPERATOR_TOOL_NAMES) {
      expect(names).not.toContain(operatorTool);
    }
  });

  it("leaves an operator tool unreachable on the consumer server", async () => {
    const { client } = consumerHarness();
    client.send(callTool({ id: 1, name: "atlas.ops.audit.read.v1" }));
    const response = await client.await(1);
    // Not registered at all, so the SDK refuses it before any handler: an
    // unknown tool rather than a permission answer, which is the shape that
    // does not confirm the tool exists somewhere else.
    expect(response.error?.code).toBe(-32602);
  });

  it("shows a consumer credential an EMPTY operator tools/list and refuses its calls", async () => {
    const directory = bothPlanes();
    const { client, auditJournal } = operatorHarness({
      resolvePrincipal: credentialResolver({ directory, plane: "operator" })
    });

    client.send(listTools({ id: 1, meta: credentialEnvelope(CONSUMER_SECRET) }));
    expect((await client.await(1)).result?.["tools"]).toEqual([]);

    // The empty listing is itself an event. A consumer credential probing this
    // plane is exactly what an operator wants to see, and an empty answer that
    // recorded nothing would report that probe as silence.
    expect(auditJournal.events).toHaveLength(1);
    expect(auditJournal.events[0]).toMatchObject({
      tool: "tools/list",
      plane: "operator",
      outcome: "refused",
      reason_code: "credential-plane-mismatch",
      client_id: null,
      counts: { returned: 0 }
    });

    client.send(callOperator({ id: 2, name: "atlas.ops.audit.read.v1", secret: CONSUMER_SECRET }));
    const refused = await client.await(2);
    expect(refused.result?.["isError"]).toBe(true);
    // One answer for every cause: a consumer credential must not learn from
    // this refusal that the secret it holds is real.
    expect(errorPayload(refused)["code"]).toBe("credential-unrecognised");
    expect(auditJournal.events.at(-1)).toMatchObject({
      plane: "operator",
      outcome: "refused",
      reason_code: "credential-plane-mismatch",
      client_id: null
    });
  });

  it("serves the operator tool set to an operator credential", async () => {
    const directory = bothPlanes();
    const { client } = operatorHarness({ resolvePrincipal: credentialResolver({ directory, plane: "operator" }) });

    client.send(listTools({ id: 1, meta: credentialEnvelope(OPERATOR_SECRET) }));
    const listed = ((await client.await(1)).result?.["tools"] ?? []) as { name: string }[];
    expect(listed.map((tool) => tool.name).sort()).toEqual([...OPERATOR_TOOL_NAMES].sort());
    // The same request answered for two different credentials returns two
    // different sets, which is what the revision permits and what the prior
    // model could not express.
    client.send(listTools({ id: 2, meta: credentialEnvelope(CONSUMER_SECRET) }));
    expect((await client.await(2)).result?.["tools"]).toEqual([]);
  });

  it("does not claim tools/list_changed either, and sends none across a grant-varying listing", async () => {
    // This plane is where a push would be most tempting — an operator's tool
    // set moves when a grant is revised — and where it would be a disclosure,
    // because the event carried would be "somebody's grant was just edited".
    // The two listings below return DIFFERENT sets over one connection, which
    // is exactly the situation a list-changed notification claims to describe;
    // nothing is sent, because the variance is by credential, not by time.
    const directory = bothPlanes();
    const { client } = operatorHarness({ resolvePrincipal: credentialResolver({ directory, plane: "operator" }) });

    client.send({ jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: credentialEnvelope(OPERATOR_SECRET) } });
    const capabilities = (await client.await(1)).result?.["capabilities"] as { tools?: { listChanged?: boolean } };
    expect(capabilities.tools?.listChanged).toBe(false);

    client.send(listTools({ id: 2, meta: credentialEnvelope(OPERATOR_SECRET) }));
    await client.await(2);
    client.send(listTools({ id: 3, meta: credentialEnvelope(CONSUMER_SECRET) }));
    await client.await(3);

    expect(client.responses).toHaveLength(3);
    expect(JSON.stringify(client.responses)).not.toContain("list_changed");
  });
});

describe("an operator grant bounds the operator plane", () => {
  it("omits an operator tool the grant does not permit, and refuses it by name", async () => {
    const narrow: Principal = {
      ...OPERATOR_PRINCIPAL,
      client_id: "operator-narrow",
      grant: { ...OPERATOR_GRANT, tools_permitted: ["atlas.ops.audit.read.v1"] }
    };
    const directory = new InMemoryCredentialDirectory([
      { token_hash: hashCredential("narrow-secret"), principal: narrow }
    ]);
    const { client } = operatorHarness({ resolvePrincipal: credentialResolver({ directory, plane: "operator" }) });

    client.send(listTools({ id: 1, meta: credentialEnvelope("narrow-secret") }));
    const listed = ((await client.await(1)).result?.["tools"] ?? []) as { name: string }[];
    expect(listed.map((tool) => tool.name).sort()).toEqual(
      ["atlas.ops.audit.read.v1", "atlas.ops.scope.describe.v1"].sort()
    );

    client.send(callOperator({ id: 2, name: "atlas.ops.reconcile.run.v1", secret: "narrow-secret", args: { subject: "replication", target_id: "replica-one" } }));
    expect(errorPayload(await client.await(2))["code"]).toBe("tool-not-permitted");
  });

  it("withholds a queue item whose tier the grant does not reach, and still counts it", async () => {
    const directory = bothPlanes();
    const { client } = operatorHarness({ resolvePrincipal: credentialResolver({ directory, plane: "operator" }) });

    client.send(callOperator({ id: 1, name: "atlas.ops.review.queue.read.v1", secret: OPERATOR_SECRET }));
    const payload = structured(await client.await(1));
    const items = payload["items"] as { item_id: string; withheld: boolean }[];

    // Two rows for two items: the sealed one is a stub, not an absence.
    expect(items.length).toBe(2);
    expect(items.map((item) => item.withheld)).toEqual([false, true]);
    expect(payload["withheld"]).toBe(1);
  });

  it("honours a requested page size and caps it at what the grant allows", async () => {
    const capped: Principal = {
      ...OPERATOR_PRINCIPAL,
      client_id: "operator-capped",
      grant: { ...OPERATOR_GRANT, limits: { max_page_size: 1 } }
    };
    const directory = new InMemoryCredentialDirectory([
      { token_hash: hashCredential(OPERATOR_SECRET), principal: OPERATOR_PRINCIPAL },
      { token_hash: hashCredential("capped-secret"), principal: capped }
    ]);
    const { client } = operatorHarness({ resolvePrincipal: credentialResolver({ directory, plane: "operator" }) });

    // Asked for 1 of 2, and told there is more. A page size the tool declares
    // and then ignores is worse than one it does not offer.
    client.send(callOperator({ id: 1, name: "atlas.ops.review.queue.read.v1", secret: OPERATOR_SECRET, args: { page_size: 1 } }));
    const asked = structured(await client.await(1));
    expect((asked["items"] as unknown[]).length).toBe(1);
    expect((asked["page"] as Record<string, unknown>)["has_more"]).toBe(true);

    // And a grant capping pages at 1 gets 1 even when it asks for more.
    client.send(callOperator({ id: 2, name: "atlas.ops.review.queue.read.v1", secret: "capped-secret", args: { page_size: 50 } }));
    const cappedPage = structured(await client.await(2));
    expect((cappedPage["page"] as Record<string, unknown>)["page_size"]).toBe(1);
  });

  it("publishes the grant and this plane's refusal vocabulary through its own scope tool", async () => {
    const directory = bothPlanes();
    const { client } = operatorHarness({ resolvePrincipal: credentialResolver({ directory, plane: "operator" }) });

    client.send(callOperator({ id: 1, name: "atlas.ops.scope.describe.v1", secret: OPERATOR_SECRET }));
    const scope = structured(await client.await(1));

    expect(scope).toMatchObject({
      client_id: "synthetic-operator",
      credential_class: "operator",
      plane: "operator",
      grant_id: OPERATOR_GRANT.grant_id
    });
    expect((scope["error_codes"] as { code: string }[]).length).toBeGreaterThan(0);
  });
});

describe("operational tools", () => {
  function running() {
    const directory = bothPlanes();
    return operatorHarness({ resolvePrincipal: credentialResolver({ directory, plane: "operator" }) });
  }

  it("reports a blocked migration window with the reason it cannot advance", async () => {
    const { client } = running();
    client.send(callOperator({ id: 1, name: "atlas.ops.migration.window.read.v1", secret: OPERATOR_SECRET }));
    const windows = structured(await client.await(1))["windows"] as Record<string, unknown>[];
    expect(windows.map((window) => window["window_id"])).toEqual(["window-alpha", "window-beta"]);
    expect(windows[1]).toMatchObject({ phase: "blocked", blocked_reason: "offline backup media not attached" });
  });

  it("derives replication lag from both watermarks rather than storing it", async () => {
    const { client } = running();
    client.send(callOperator({ id: 1, name: "atlas.ops.replication.status.read.v1", secret: OPERATOR_SECRET }));
    const targets = structured(await client.await(1))["targets"] as Record<string, unknown>[];
    expect(targets[0]).toMatchObject({ local_watermark_seq: 42, acknowledged_seq: 40, lag_seq: 2 });
  });

  it("defaults reconcile to a dry run and still writes one durable event", async () => {
    const instance = running();
    instance.client.send(
      callOperator({ id: 1, name: "atlas.ops.reconcile.run.v1", secret: OPERATOR_SECRET, args: { subject: "replication", target_id: "replica-one" } })
    );
    const payload = structured(await instance.client.await(1));

    // The default of a mutating operational tool is the one that changes nothing.
    expect(payload).toMatchObject({ dry_run: true, applied: false });
    expect(instance.source.applied).toEqual([{ subject: "replication", targetId: "replica-one", dryRun: true }]);
    expect(instance.auditJournal.events.filter((event) => event.tool === "atlas.ops.reconcile.run.v1").length).toBe(1);
  });

  it("refuses a reconcile against a target the source does not know", async () => {
    const { client } = running();
    client.send(
      callOperator({ id: 1, name: "atlas.ops.reconcile.run.v1", secret: OPERATOR_SECRET, args: { subject: "replication", target_id: "no-such-replica" } })
    );
    expect(errorPayload(await client.await(1))["code"]).toBe("replication-target-unknown");
  });

  it("writes exactly ONE audit event per operator call, whatever the call touched", async () => {
    const instance = running();
    instance.client.send(callOperator({ id: 1, name: "atlas.ops.review.queue.read.v1", secret: OPERATOR_SECRET }));
    await instance.client.await(1);
    instance.client.send(callOperator({ id: 2, name: "atlas.ops.migration.window.read.v1", secret: OPERATOR_SECRET }));
    await instance.client.await(2);

    expect(instance.auditJournal.events.length).toBe(2);
    for (const event of instance.auditJournal.events) {
      expect(event.plane).toBe("operator");
      expect(event.grant_id).toBe(OPERATOR_GRANT.grant_id);
      // Never ids the source produced. The queue read touched two items and
      // named none of them.
      expect(event.subjects).toEqual([]);
    }
  });
});

describe("the audit read path", () => {
  it("counts an event's subjects and never lists them", async () => {
    const journal = new MemoryAuditJournal();
    const source = syntheticOperatorSource({ journal });
    const directory = bothPlanes();
    const instance = operatorHarness({
      source,
      auditJournal: journal,
      resolvePrincipal: credentialResolver({ directory, plane: "operator" })
    });

    // One call that names an id, so there is a subject to be careful about.
    instance.client.send(
      callOperator({ id: 1, name: "atlas.ops.migration.window.read.v1", secret: OPERATOR_SECRET, args: { window_id: "window-alpha" } })
    );
    await instance.client.await(1);

    instance.client.send(callOperator({ id: 2, name: "atlas.ops.audit.read.v1", secret: OPERATOR_SECRET }));
    const events = structured(await instance.client.await(2))["events"] as Record<string, unknown>[];
    const first = events[0];
    expect(first).toBeDefined();
    if (!first) return;

    expect(first["subjects_count"]).toBe(1);
    // Returning them would make this a second read path for identifiers a
    // caller named, with none of the sensitivity machinery applied to it.
    expect(first["subjects"]).toBeUndefined();
  });

  it("matches on a subject id without enumerating what else a credential touched", async () => {
    const journal = new MemoryAuditJournal();
    const directory = bothPlanes();
    const instance = operatorHarness({
      source: syntheticOperatorSource({ journal }),
      auditJournal: journal,
      resolvePrincipal: credentialResolver({ directory, plane: "operator" })
    });

    instance.client.send(
      callOperator({ id: 1, name: "atlas.ops.migration.window.read.v1", secret: OPERATOR_SECRET, args: { window_id: "window-alpha" } })
    );
    await instance.client.await(1);
    instance.client.send(callOperator({ id: 2, name: "atlas.ops.replication.status.read.v1", secret: OPERATOR_SECRET }));
    await instance.client.await(2);

    instance.client.send(
      callOperator({ id: 3, name: "atlas.ops.audit.read.v1", secret: OPERATOR_SECRET, args: { subject_id: "window-alpha" } })
    );
    const payload = structured(await instance.client.await(3));
    const events = payload["events"] as Record<string, unknown>[];
    expect(events.length).toBe(1);
    expect(events[0]?.["tool"]).toBe("atlas.ops.migration.window.read.v1");
    // The page still reports how much was evaluated, so a filtered answer is
    // never mistaken for an empty log.
    expect((payload["page"] as Record<string, unknown>)["evaluated"]).toBeGreaterThan(1);
  });

  it("records a throwing operational tool as one error event, detail withheld", async () => {
    // A failing operational tool is precisely the event an operator reads this
    // journal to find. `McpServer`'s own `tools/call` catch would have turned
    // the throw into a text tool error the journal never saw, so the plane that
    // exists to make activity visible would have reported its own faults as
    // silence.
    const journal = new MemoryAuditJournal();
    const source = syntheticOperatorSource({ journal });
    const directory = bothPlanes();
    const instance = operatorHarness({
      source: {
        ...source,
        replicationTargets: () => {
          throw new Error("control store unreadable at replica-one for operator-secret-holder");
        }
      } as typeof source,
      auditJournal: journal,
      resolvePrincipal: credentialResolver({ directory, plane: "operator" })
    });

    instance.client.send(callOperator({ id: 1, name: "atlas.ops.replication.status.read.v1", secret: OPERATOR_SECRET }));
    const response = await instance.client.await(1);

    expect(response.result?.["isError"]).toBe(true);
    expect(journal.events).toHaveLength(1);
    const event = journal.events[0];
    expect(event).toBeDefined();
    if (!event) return;
    expect(event.tool).toBe("atlas.ops.replication.status.read.v1");
    expect(event.outcome).toBe("error");
    expect(event.reason_code).toBe("handler-failed");
    expect(event.plane).toBe("operator");

    // The fault named an internal target and a credential holder. Neither the
    // wire nor the journal may carry it.
    for (const leak of ["control store unreadable", "operator-secret-holder"]) {
      expect(JSON.stringify(response)).not.toContain(leak);
      expect(JSON.stringify(journal.events)).not.toContain(leak);
    }
  });
});

describe("usage reconciliation", () => {
  it("reports one row per credential, so a collapsed deployment reports one row", async () => {
    const journal = new MemoryAuditJournal();
    const second: Principal = { ...OPERATOR_PRINCIPAL, client_id: "operator-two" };
    const withSecond = new InMemoryCredentialDirectory([
      { token_hash: hashCredential(OPERATOR_SECRET), principal: OPERATOR_PRINCIPAL },
      { token_hash: hashCredential("second-operator"), principal: second },
      { token_hash: hashCredential(CONSUMER_SECRET), principal: CONSUMER_PRINCIPAL }
    ]);

    const instance = operatorHarness({
      source: syntheticOperatorSource({
        journal,
        metered: [{ client_id: "synthetic-operator", period_from: "2026-08-01", period_to: "2026-08-31", metered_calls: 99 }]
      }),
      auditJournal: journal,
      resolvePrincipal: credentialResolver({ directory: withSecond, plane: "operator" })
    });

    instance.client.send(callOperator({ id: 1, name: "atlas.ops.replication.status.read.v1", secret: OPERATOR_SECRET }));
    await instance.client.await(1);
    instance.client.send(callOperator({ id: 2, name: "atlas.ops.replication.status.read.v1", secret: "second-operator" }));
    await instance.client.await(2);

    instance.client.send(callOperator({ id: 3, name: "atlas.ops.usage.read.v1", secret: OPERATOR_SECRET }));
    const payload = structured(await instance.client.await(3));
    const rows = payload["rows"] as Record<string, unknown>[];

    expect(rows.map((row) => row["client_id"])).toEqual(["operator-two", "synthetic-operator"]);
    const mine = rows.find((row) => row["client_id"] === "synthetic-operator");
    // The meter says 99 and the durable events say otherwise. The delta is
    // reported and neither figure is declared the winner.
    expect(mine?.["metered_calls"]).toBe(99);
    expect(mine?.["reconciled"]).toBe(false);
    expect(mine?.["delta_calls"]).toBe(99 - Number(mine?.["calls"]));
    expect(payload["unreconciled_clients"]).toContain("operator-two");
  });

  it("reports an unattributable call under a null client rather than naming it", async () => {
    const journal = new MemoryAuditJournal();
    const directory = bothPlanes();
    const instance = operatorHarness({
      source: syntheticOperatorSource({ journal }),
      auditJournal: journal,
      resolvePrincipal: credentialResolver({ directory, plane: "operator" })
    });

    instance.client.send(callOperator({ id: 1, name: "atlas.ops.usage.read.v1", secret: CONSUMER_SECRET }));
    await instance.client.await(1);

    instance.client.send(callOperator({ id: 2, name: "atlas.ops.usage.read.v1", secret: OPERATOR_SECRET }));
    const rows = structured(await instance.client.await(2))["rows"] as Record<string, unknown>[];

    // A call nobody authenticated has no client to bill. It is counted rather
    // than dropped — an unattributable call is exactly what a reconciliation
    // needs to see — and it is `null` rather than a placeholder name, because a
    // placeholder is a name a real credential could also be issued.
    const unattributed = rows.find((row) => row["client_id"] === null);
    expect(unattributed).toBeDefined();
    expect(unattributed?.["grant_id"]).toBeNull();
    expect(unattributed?.["refusals"]).toBe(1);
  });
});

/**
 * The refusal vocabulary, scanned out of the source rather than listed here.
 *
 * Same rule as the consumer plane, for the same reason: an open vocabulary a
 * caller cannot look up is one it can only branch on by accident. The extra
 * assertion this plane needs is the SEPARATION — a code raised only by an
 * operational tool must not appear in the registry `atlas.contract.describe.v1`
 * publishes to every consumer, because that listing would otherwise disclose
 * which operational tools exist and how they fail.
 */
function operatorSource(file: string): string {
  return readFileSync(join(dirname(fileURLToPath(import.meta.url)), file), "utf8");
}

function emittedOperatorCodes(): string[] {
  const codes = new Set<string>();
  for (const file of ["tools.ts", "server.ts"]) {
    for (const match of operatorSource(file).matchAll(/\b(?:code|reason_code|reasonCode):\s*"([a-z0-9-]+)"/g)) {
      const code = match[1];
      if (code !== undefined) codes.add(code);
    }
  }
  return [...codes].sort();
}

describe("the operator refusal vocabulary", () => {
  it("registers every code an operator tool can emit, in one registry or the other", () => {
    const missing = emittedOperatorCodes().filter(
      (code) => !OPERATOR_ERROR_CODE_SET.has(code) && !ERROR_CODE_SET.has(code)
    );
    expect(missing, "these codes are raised in operator source but are in no registry").toEqual([]);
  });

  it("finds a real, non-trivial set of codes to check", () => {
    // Without this the regex silently matching nothing would make the test
    // above pass by vacuity.
    expect(emittedOperatorCodes().length).toBeGreaterThan(3);
  });

  it("keeps operator-only codes out of the registry consumers are served", () => {
    for (const entry of OPERATOR_ERROR_CODES) {
      expect(`${entry.code} in consumer registry: ${ERROR_CODE_SET.has(entry.code)}`).toBe(
        `${entry.code} in consumer registry: false`
      );
    }
  });

  it("gives every operator code a summary a reader can act on", () => {
    for (const entry of OPERATOR_ERROR_CODES) {
      expect(entry.summary.length, `${entry.code} has no usable summary`).toBeGreaterThan(30);
      expect(entry.summary.replace(/[^a-z]/g, "")).not.toBe(entry.code.replace(/-/g, ""));
    }
  });
});
