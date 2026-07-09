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
import { InMemoryLocalMcpAuditSink } from "./audit";
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
});
