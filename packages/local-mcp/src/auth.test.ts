import { describe, expect, it } from "vitest";
import {
  controlPlaneFixture,
  fixtureLocalClientId,
  fixtureRemoteClientId
} from "@living-atlas/fixtures";
import { InMemoryLocalMcpAuditSink } from "./audit";
import {
  authenticateLocalMcp,
  hashLocalMcpToken,
  InMemoryLocalMcpCredentialStore,
  verifyLocalMcpToken,
  type LocalMcpCredential
} from "./auth";

const now = "2026-06-21T12:00:00.000Z";

async function credentialFor(token: string, overrides: Partial<LocalMcpCredential> = {}): Promise<LocalMcpCredential> {
  return {
    credential_id: "la_local_credential_test0001",
    client_id: fixtureLocalClientId,
    capability_id: "la_cap_localfull0001",
    token_hash: await hashLocalMcpToken(token),
    created_at: now,
    ...overrides
  };
}

describe("local MCP authentication", () => {
  it("accepts a live local client capability token", async () => {
    const token = "local-token-auth-valid-0001";
    const auditSink = new InMemoryLocalMcpAuditSink();
    const result = await authenticateLocalMcp({
      authorizationHeader: `Bearer ${token}`,
      credentialStore: new InMemoryLocalMcpCredentialStore([await credentialFor(token)]),
      auditSink,
      now
    });

    expect(result.ok).toBe(true);
    expect(auditSink.events).toContainEqual(expect.objectContaining({ event_type: "auth.succeeded" }));
  });

  it("rejects missing, malformed, and unknown bearer tokens", async () => {
    const token = "local-token-auth-known-0001";
    const credentialStore = new InMemoryLocalMcpCredentialStore([await credentialFor(token)]);

    await expect(authenticateLocalMcp({ credentialStore, now })).resolves.toEqual({
      ok: false,
      reason: "missing-authorization"
    });

    await expect(authenticateLocalMcp({ authorizationHeader: token, credentialStore, now })).resolves.toEqual({
      ok: false,
      reason: "invalid-authorization-scheme"
    });

    await expect(authenticateLocalMcp({
      authorizationHeader: "Bearer local-token-auth-unknown-0001",
      credentialStore,
      now
    })).resolves.toEqual({
      ok: false,
      reason: "unknown-token"
    });
  });

	  it("rejects revoked and expired credentials", async () => {
	    const revokedToken = "local-token-auth-revoked-0001";
	    const expiredToken = "local-token-auth-expired-0001";
    const credentialStore = new InMemoryLocalMcpCredentialStore([
      await credentialFor(revokedToken, { revoked_at: now }),
      await credentialFor(expiredToken, { expires_at: "2026-06-21T11:59:59.000Z" })
    ]);

    await expect(authenticateLocalMcp({
      authorizationHeader: `Bearer ${revokedToken}`,
      credentialStore,
      now
	    })).resolves.toEqual({
	      ok: false,
	      reason: "credential-revoked"
	    });

    await expect(authenticateLocalMcp({
      authorizationHeader: `Bearer ${expiredToken}`,
      credentialStore,
      now
	    })).resolves.toEqual({
	      ok: false,
	      reason: "credential-expired"
	    });
  });

  it("rejects revoked and expired capabilities", async () => {
    const revokedToken = "local-token-auth-cap-revoked-0001";
    const expiredToken = "local-token-auth-cap-expired-0001";
	    const revokedControlPlane = {
	      ...controlPlaneFixture,
	      capabilities: controlPlaneFixture.capabilities.map((capability) =>
	        capability.capability_id === "la_cap_localfull0001"
	          ? {
	              ...capability,
	              revoked_at: "2026-06-21T11:59:00.000Z"
	            }
	          : capability
	      )
	    };
	    const expiredControlPlane = {
	      ...controlPlaneFixture,
	      capabilities: controlPlaneFixture.capabilities.map((capability) =>
	        capability.capability_id === "la_cap_localfull0001"
	          ? {
	              ...capability,
	              expires_at: "2026-06-21T11:59:59.000Z"
	            }
	          : capability
	      )
    };

    await expect(authenticateLocalMcp({
	      authorizationHeader: `Bearer ${revokedToken}`,
	      credentialStore: new InMemoryLocalMcpCredentialStore([await credentialFor(revokedToken)]),
	      controlPlane: revokedControlPlane,
	      now
	    })).resolves.toEqual({
	      ok: false,
	      reason: "capability-revoked"
    });

    await expect(authenticateLocalMcp({
	      authorizationHeader: `Bearer ${expiredToken}`,
	      credentialStore: new InMemoryLocalMcpCredentialStore([await credentialFor(expiredToken)]),
	      controlPlane: expiredControlPlane,
	      now
	    })).resolves.toEqual({
	      ok: false,
	      reason: "capability-expired"
	    });
	  });

  it("rejects remote-safe credentials on the local MCP ingress", async () => {
    const token = "local-token-auth-remote-0001";
    const result = await authenticateLocalMcp({
      authorizationHeader: `Bearer ${token}`,
      credentialStore: new InMemoryLocalMcpCredentialStore([
        await credentialFor(token, {
          client_id: fixtureRemoteClientId,
          capability_id: "la_cap_remotesafe0001"
        })
      ]),
      controlPlane: controlPlaneFixture,
      now
    });

    expect(result).toEqual({
      ok: false,
      reason: "non-local-profile"
    });
  });

  it("compares token hashes without accepting malformed expected hashes", async () => {
    expect(await verifyLocalMcpToken("local-token-auth-valid-0001", "sha256:not-a-real-hash")).toBe(false);
  });
});
