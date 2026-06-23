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
