import { describe, expect, it } from "vitest";
import {
  LivingAtlasMcpToolDefinitions,
  LivingAtlasMcpToolNames,
  livingAtlasMcpToolDefinition
} from "./index";

describe("Living Atlas MCP contract", () => {
  it("publishes bounded object and edge batch tools in the canonical catalog", () => {
    expect(LivingAtlasMcpToolNames).toContain("object_batch");
    expect(LivingAtlasMcpToolNames).toContain("edge_batch");
  });

  it("publishes the local canonical review workflow with preview-gated decisions", () => {
    expect(LivingAtlasMcpToolNames).toEqual(expect.arrayContaining([
      "review_list",
      "review_read",
      "review_decide"
    ]));
    expect(livingAtlasMcpToolDefinition("review_decide").inputSchema).toMatchObject({
      required: ["action", "candidate_ids"],
      properties: {
        action: { enum: ["keep", "research", "defer"] },
        candidate_ids: { minItems: 1, maxItems: 100, uniqueItems: true },
        preview_token: { pattern: "^sha256:[a-f0-9]{64}$" }
      }
    });
  });

  it("defines operation-specific batch item schemas", () => {
    const objectBatch = livingAtlasMcpToolDefinition("object_batch");
    const edgeBatch = livingAtlasMcpToolDefinition("edge_batch");

    expect(objectBatch.inputSchema).toMatchObject({
      properties: {
        items: {
          minItems: 1,
          maxItems: 100,
          items: {
            oneOf: [
              expect.objectContaining({ required: ["op", "object"] }),
              expect.objectContaining({ required: ["op", "object_id", "patch"] }),
              expect.objectContaining({ required: ["op", "object_id"] })
            ]
          }
        }
      }
    });
    expect(edgeBatch.inputSchema).toMatchObject({
      properties: {
        items: {
          minItems: 1,
          maxItems: 100,
          items: {
            oneOf: [
              expect.objectContaining({ required: ["op", "edge"] }),
              expect.objectContaining({ required: ["op", "edge_id", "patch"] }),
              expect.objectContaining({ required: ["op", "edge_id"] })
            ]
          }
        }
      }
    });
  });

  it("does not publish ingress-specific tool aliases", () => {
    for (const definition of LivingAtlasMcpToolDefinitions) {
      expect(definition.name).not.toMatch(/^(remote|local)_/);
    }
  });
});
