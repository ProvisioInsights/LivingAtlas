import { describe, expect, it } from "vitest";
import { LivingAtlasMcpToolNames } from "@living-atlas/mcp-contract";
import { fixtureLocalClientId } from "@living-atlas/fixtures";
import { InMemoryLocalMcpAuditSink } from "./audit";
import { hashLocalMcpToken, InMemoryLocalMcpCredentialStore } from "./auth";
import { createFixtureLocalMcpContext, localReadObject } from "./local-graph";
import { localReviewList } from "./review";
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
    expect(LocalMcpToolInputSchemas.review_list).not.toHaveProperty("authorization");
    expect(LocalMcpToolInputSchemas.review_read).not.toHaveProperty("authorization");
    expect(LocalMcpToolInputSchemas.review_decide).not.toHaveProperty("authorization");
    const resolutionInputSchema = (LocalMcpToolInputSchemas as Record<string, unknown>).resolution_apply;
    expect(LivingAtlasMcpToolNames).toContain("resolution_apply");
    expect(resolutionInputSchema).toEqual(expect.objectContaining({
      operation_id: expect.anything(),
      idempotency_key: expect.anything(),
      candidate_id: expect.anything(),
      expected_generation: expect.anything(),
      expected_review_version: expect.anything(),
      objects: expect.anything()
    }));
    expect(resolutionInputSchema).not.toHaveProperty("authorization");
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
    await expect(localReviewList(context, {
      authorization: `Bearer ${token}`,
      queue: "actionable"
    })).resolves.toEqual({
      ok: true,
      result: expect.objectContaining({
        schema: "living-atlas.review-list:v1",
        items: expect.any(Array),
        compatible_groups: expect.any(Array)
      })
    });
  });
});
