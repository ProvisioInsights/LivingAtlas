import { describe, expect, it } from "vitest";
import { fixtureLocalClientId } from "@living-atlas/fixtures";
import { InMemoryLocalMcpAuditSink } from "./audit";
import { hashLocalMcpToken, InMemoryLocalMcpCredentialStore } from "./auth";
import { createFixtureLocalMcpContext, localReadObject } from "./local-graph";
import { createLivingAtlasLocalMcpServer, LocalMcpToolInputSchemas } from "./server";

describe("local MCP server wrapper", () => {
  it("registers an MCP server around the fixture context", async () => {
    const token = "local-token-server-wrapper-0001";
    const context = createFixtureLocalMcpContext({
      credentialStore: new InMemoryLocalMcpCredentialStore([
        {
          credential_id: "la_local_credential_server0001",
          client_id: fixtureLocalClientId,
          capability_id: "la_cap_localfull0001",
          token_hash: await hashLocalMcpToken(token),
          created_at: "2026-06-21T12:00:00.000Z"
        }
      ]),
      auditSink: new InMemoryLocalMcpAuditSink(),
      now: "2026-06-21T12:00:00.000Z"
    });

    const server = createLivingAtlasLocalMcpServer(context, {
      authorizationHeader: `Bearer ${token}`
    });
    expect(server.isConnected()).toBe(false);
    expect(LocalMcpToolInputSchemas.local_graph_status).not.toHaveProperty("authorization");
    expect(LocalMcpToolInputSchemas.local_list_objects).not.toHaveProperty("authorization");
    expect(LocalMcpToolInputSchemas.local_read_object).not.toHaveProperty("authorization");
    expect(LocalMcpToolInputSchemas.local_create_object).not.toHaveProperty("authorization");
    expect(LocalMcpToolInputSchemas.local_update_object).not.toHaveProperty("authorization");
    expect(LocalMcpToolInputSchemas.local_tombstone_object).not.toHaveProperty("authorization");

    await expect(localReadObject(context, {
      authorization: `Bearer ${token}`,
      object_id: "la_object_privateedge0001"
    })).resolves.toEqual({
      ok: true,
      result: expect.objectContaining({
        object: expect.objectContaining({
          object_id: "la_object_privateedge0001",
          access_class: "local-private"
        })
      })
    });
  });
});
