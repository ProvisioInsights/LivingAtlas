import { z } from "zod";
import {
  type CapabilityGrant,
  type ClientRecord,
  type ControlPlaneSnapshot,
  LocalCredentialRecordSchema,
  type LocalCredentialRecord
} from "@living-atlas/contracts";
import { controlPlaneFixture } from "@living-atlas/fixtures";
import { sha256LocalControlToken } from "@living-atlas/local-control-store";
import { createLocalMcpAuditEvent, type LocalMcpAuditSink } from "./audit";

export const LocalMcpTokenHashSchema = LocalCredentialRecordSchema.shape.token_hash;
export type LocalMcpCredential = LocalCredentialRecord;

export type LocalMcpCredentialStore = {
  findByTokenHash(tokenHash: string): LocalMcpCredential | undefined;
};

export class InMemoryLocalMcpCredentialStore implements LocalMcpCredentialStore {
  private readonly credentialsByHash: Map<string, LocalMcpCredential>;

  constructor(credentials: LocalMcpCredential[]) {
    this.credentialsByHash = new Map(
      credentials.map((credential) => {
        const parsed = LocalCredentialRecordSchema.parse(credential);
        return [parsed.token_hash, parsed];
      })
    );
  }

  findByTokenHash(tokenHash: string): LocalMcpCredential | undefined {
    return this.credentialsByHash.get(tokenHash);
  }
}

export type LocalMcpAuthenticatedClient = {
  credential: LocalMcpCredential;
  client: ClientRecord;
  capability: CapabilityGrant;
};

export type LocalMcpAuthenticationResult =
  | {
      ok: true;
      authenticated: LocalMcpAuthenticatedClient;
    }
  | {
      ok: false;
      reason:
        | "missing-authorization"
        | "invalid-authorization-scheme"
        | "unknown-token"
        | "credential-expired"
        | "credential-revoked"
        | "client-missing"
        | "client-expired"
        | "client-revoked"
        | "capability-missing"
        | "capability-client-mismatch"
        | "non-local-profile";
    };

export type AuthenticateLocalMcpInput = {
  authorizationHeader?: string;
  credentialStore: LocalMcpCredentialStore;
  controlPlane?: ControlPlaneSnapshot;
  auditSink?: LocalMcpAuditSink;
  now?: string;
};

const LocalMcpAllowedProfiles = new Set(["local-full", "local-readonly", "local-crud", "local-admin", "local-release"]);

function decodeHash(hash: string | undefined): Uint8Array {
  const parsed = LocalMcpTokenHashSchema.safeParse(hash);
  const hex = parsed.success ? parsed.data.slice("sha256:".length) : "0".repeat(64);
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function constantTimeEqualHash(actualHash: string, expectedHash: string | undefined): boolean {
  const actual = decodeHash(actualHash);
  const expected = decodeHash(expectedHash);
  let diff = actual.length ^ expected.length;
  for (let index = 0; index < Math.max(actual.length, expected.length); index += 1) {
    diff |= (actual[index] ?? 0) ^ (expected[index] ?? 0);
  }
  return LocalMcpTokenHashSchema.safeParse(expectedHash).success && diff === 0;
}

function isExpired(timestamp: string | undefined, now: string): boolean {
  return timestamp !== undefined && Date.parse(timestamp) <= Date.parse(now);
}

function extractBearerToken(authorizationHeader: string | undefined): string | undefined {
  if (!authorizationHeader) {
    return undefined;
  }

  const match = /^Bearer ([A-Za-z0-9._~+/=-]{16,})$/.exec(authorizationHeader);
  return match?.[1];
}

function recordAuthFailure(auditSink: LocalMcpAuditSink | undefined, reason: string): void {
  auditSink?.record(
    createLocalMcpAuditEvent({
      event_type: "auth.failed",
      reason_code: reason,
      summary: "Local MCP authentication failed"
    })
  );
}

export async function hashLocalMcpToken(token: string): Promise<z.infer<typeof LocalMcpTokenHashSchema>> {
  return sha256LocalControlToken(token);
}

export async function verifyLocalMcpToken(token: string, expectedHash: string | undefined): Promise<boolean> {
  return constantTimeEqualHash(await hashLocalMcpToken(token), expectedHash);
}

export async function authenticateLocalMcp(
  input: AuthenticateLocalMcpInput
): Promise<LocalMcpAuthenticationResult> {
  const token = extractBearerToken(input.authorizationHeader);
  if (!input.authorizationHeader) {
    recordAuthFailure(input.auditSink, "missing-authorization");
    return { ok: false, reason: "missing-authorization" };
  }

  if (!token) {
    recordAuthFailure(input.auditSink, "invalid-authorization-scheme");
    return { ok: false, reason: "invalid-authorization-scheme" };
  }

  const tokenHash = await hashLocalMcpToken(token);
  const credential = input.credentialStore.findByTokenHash(tokenHash);
  if (!credential || !(await verifyLocalMcpToken(token, credential.token_hash))) {
    recordAuthFailure(input.auditSink, "unknown-token");
    return { ok: false, reason: "unknown-token" };
  }

  const now = input.now ?? new Date().toISOString();
  if (credential.revoked_at) {
    recordAuthFailure(input.auditSink, "credential-revoked");
    return { ok: false, reason: "credential-revoked" };
  }

  if (isExpired(credential.expires_at, now)) {
    recordAuthFailure(input.auditSink, "credential-expired");
    return { ok: false, reason: "credential-expired" };
  }

  const controlPlane = input.controlPlane ?? controlPlaneFixture;
  const client = controlPlane.clients.find((candidate) => candidate.client_id === credential.client_id);
  if (!client) {
    recordAuthFailure(input.auditSink, "client-missing");
    return { ok: false, reason: "client-missing" };
  }

  if (client.revoked_at) {
    recordAuthFailure(input.auditSink, "client-revoked");
    return { ok: false, reason: "client-revoked" };
  }

  if (isExpired(client.expires_at, now)) {
    recordAuthFailure(input.auditSink, "client-expired");
    return { ok: false, reason: "client-expired" };
  }

  const capability = controlPlane.capabilities.find(
    (candidate) => candidate.capability_id === credential.capability_id
  );
  if (!capability) {
    recordAuthFailure(input.auditSink, "capability-missing");
    return { ok: false, reason: "capability-missing" };
  }

  if (capability.client_id !== client.client_id) {
    recordAuthFailure(input.auditSink, "capability-client-mismatch");
    return { ok: false, reason: "capability-client-mismatch" };
  }

  if (!LocalMcpAllowedProfiles.has(capability.profile)) {
    recordAuthFailure(input.auditSink, "non-local-profile");
    return { ok: false, reason: "non-local-profile" };
  }

  input.auditSink?.record(
    createLocalMcpAuditEvent({
      event_type: "auth.succeeded",
      client_id: client.client_id,
      profile: capability.profile,
      reason_code: "allowed",
      summary: "Local MCP authentication succeeded"
    })
  );

  return {
    ok: true,
    authenticated: {
      credential,
      client,
      capability
    }
  };
}
