import { afterEach, describe, expect, it } from "vitest";
import { fixtureLocalClientId } from "@living-atlas/fixtures";
import { createFixtureLocalMcpContext } from "@living-atlas/local-mcp";
import { hashLocalMcpToken, InMemoryLocalMcpCredentialStore } from "@living-atlas/local-mcp";
import { createLocalReviewSiteServer } from "./server";

const servers: Array<ReturnType<typeof createLocalReviewSiteServer>> = [];
afterEach(() => servers.splice(0).forEach((server) => server.close()));

describe("local review site server", () => {
  it("requires local bearer authorization before returning any review queue", async () => {
    const token = "local-review-site-token-0001";
    const context = createFixtureLocalMcpContext({ credentialStore: new InMemoryLocalMcpCredentialStore([{
      credential_id: "la_local_credential_reviewsite0001", client_id: fixtureLocalClientId, capability_id: "la_cap_localfull0001", token_hash: await hashLocalMcpToken(token), created_at: "2026-07-10T12:00:00.000Z"
    }]), now: "2026-07-10T12:00:00.000Z" });
    const server = createLocalReviewSiteServer({ context });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected loopback address");
    const url = `http://127.0.0.1:${address.port}/api/review-queue`;

    await expect(fetch(url)).resolves.toMatchObject({ status: 401 });
    await expect(fetch(url, { headers: { authorization: `Bearer ${token}` } }).then(async (response) => ({ status: response.status, body: await response.json() }))).resolves.toMatchObject({ status: 200, body: { owner_review: [], research: [], automatic: [] } });
  });
});
