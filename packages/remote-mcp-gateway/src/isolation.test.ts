import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const localMcpSrc = join(import.meta.dirname, "../../local-mcp/src");

function allTsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? allTsFiles(full) : full.endsWith(".ts") ? [full] : [];
  });
}

describe("stdio MCP isolation", () => {
  it("no local-mcp source imports the remote gateway or oracle packages", () => {
    for (const file of allTsFiles(localMcpSrc)) {
      const text = readFileSync(file, "utf8");
      expect(text).not.toMatch(/@living-atlas\/remote-mcp-gateway/);
      expect(text).not.toMatch(/@living-atlas\/local-decryption-oracle/);
    }
  });
});
