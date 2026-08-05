import { describe, expect, it } from "vitest";
import { CREDENTIAL_META_KEY } from "@living-atlas/atlas-mcp";
import { ATLAS_CREDENTIAL_META_KEY } from "./client.js";

/**
 * The one string this client restates, and the check that keeps it honest.
 *
 * `ATLAS_CREDENTIAL_META_KEY` is declared in `client.ts` rather than imported at
 * runtime, because a consumer client that depended on the server package would
 * invert the dependency and drag an entire MCP server in to read one string. The
 * cost of restating it is exactly the defect the repo keeps measuring: two
 * copies that agree only until somebody edits one.
 *
 * So the server package is a DEV dependency, present for this file and nothing
 * else, and the two are compared. If they ever disagree, every request this
 * client sends presents its credential on a member the server does not read, and
 * every call is refused with `credential-required` — a failure whose cause is
 * invisible from either side. This test is where that becomes a build failure
 * instead.
 *
 * The right long-term home for the key is `@living-atlas/atlas-contract`: how a
 * consumer authenticates on this plane is a property of the plane, not of one
 * server. That is a contract change, so it belongs to the next revision.
 */
describe("the credential _meta key", () => {
  it("is the same member the consumer server reads a credential from", () => {
    expect(ATLAS_CREDENTIAL_META_KEY).toBe(CREDENTIAL_META_KEY);
  });

  it("is namespaced to this project, because io.modelcontextprotocol/ is reserved for the spec", () => {
    expect(ATLAS_CREDENTIAL_META_KEY.startsWith("io.modelcontextprotocol/")).toBe(false);
  });
});
