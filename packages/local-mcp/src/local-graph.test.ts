import { describe, expect, it } from "vitest";
import type { ControlPlaneSnapshot, GraphObjectEnvelope } from "@living-atlas/contracts";
import {
  controlPlaneFixture,
  fixtureAuthorityId,
  fixtureLocalClientId,
  fixtureRemoteClientId,
  sensitiveBaitRegistry
} from "@living-atlas/fixtures";
import { InMemoryLocalMcpActivitySink } from "./activity";
import { InMemoryLocalMcpAuditSink } from "./audit";
import { hashLocalMcpToken, InMemoryLocalMcpCredentialStore } from "./auth";
import {
  createFixtureLocalMcpContext,
  localCreateObject,
  localGraphStatus,
  localListObjects,
  localReadObject,
  localTombstoneObject,
  localUpdateObject,
  type LocalGraphSyntheticStoreLimits
} from "./local-graph";

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
      tool_name: "local_create_object",
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
      tool_name: "local_update_object",
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
      tool_name: "local_tombstone_object",
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
      tool_name: "local_create_object",
      reason_code: "capability-operation-denied"
    }));
    expect(auditSink.events).toContainEqual(expect.objectContaining({
      event_type: "tool.denied",
      operation: "update",
      tool_name: "local_update_object",
      reason_code: "capability-operation-denied"
    }));
    expect(auditSink.events).toContainEqual(expect.objectContaining({
      event_type: "tool.denied",
      operation: "delete",
      tool_name: "local_tombstone_object",
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
      tool_name: "local_create_object",
      reason_code: "synthetic-store-full"
    }));
  });
});
