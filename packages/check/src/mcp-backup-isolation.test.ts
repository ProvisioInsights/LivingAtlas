import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe("MCP is structurally isolated from backup write/delete", () => {
  it("no local-mcp or cloudflare-worker source imports @living-atlas/backup", () => {
    for (const pkg of ["packages/local-mcp/src", "packages/cloudflare-worker/src"]) {
      for (const f of walk(pkg).filter((p) => p.endsWith(".ts") && !p.endsWith(".test.ts"))) {
        const src = readFileSync(f, "utf8");
        expect(src, `${f} must not import the backup package`).not.toMatch(/@living-atlas\/backup/);
      }
    }
  });
});
