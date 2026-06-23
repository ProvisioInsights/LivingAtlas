import { describe, expect, it } from "vitest";
import { LivingAtlasMcpToolNames } from "@living-atlas/mcp-contract";
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
    expect(LocalMcpToolInputSchemas.status).not.toHaveProperty("authorization");
    expect(LocalMcpToolInputSchemas.object_list).not.toHaveProperty("authorization");
    expect(LocalMcpToolInputSchemas.object_read).not.toHaveProperty("authorization");
    expect(LocalMcpToolInputSchemas.object_create).not.toHaveProperty("authorization");
    expect(LocalMcpToolInputSchemas.object_update).not.toHaveProperty("authorization");
    expect(LocalMcpToolInputSchemas.object_delete).not.toHaveProperty("authorization");
    expect(Object.keys(LocalMcpToolInputSchemas).sort()).toEqual([...LivingAtlasMcpToolNames].sort());

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
