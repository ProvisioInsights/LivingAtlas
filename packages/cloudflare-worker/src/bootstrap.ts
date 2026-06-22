import { z } from "zod";
import {
  AuthorityIdSchema,
  DeviceIdSchema,
  IsoTimestampSchema,
  KeyIdSchema,
  UserIdSchema
} from "@living-atlas/contracts";

export const BootstrapStateSchema = z.enum(["sealed", "unclaimed", "claimed", "reset-pending"]);
export type BootstrapState = z.infer<typeof BootstrapStateSchema>;

export const ClaimTokenHashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export type ClaimTokenHash = z.infer<typeof ClaimTokenHashSchema>;

export const WrappedKeyMaterialSchema = z
  .object({
    key_id: KeyIdSchema,
    wrapping_device_id: DeviceIdSchema,
    algorithm: z.enum(["hpke-v1", "x25519-xsalsa20-poly1305", "synthetic-fixture"]),
    ciphertext: z.string().min(16)
  })
  .strict();

export const BootstrapClaimPayloadSchema = z
  .object({
    authority_id: AuthorityIdSchema,
    user_id: UserIdSchema,
    device_id: DeviceIdSchema,
    device_public_key_hash: z.string().min(16),
    policy_generation: z.number().int().nonnegative(),
    wrapped_keys: z.array(WrappedKeyMaterialSchema).min(1),
    recovery_public_material: z.record(z.string(), z.unknown()).optional(),
    initial_remote_config: z.record(z.string(), z.unknown()).optional()
  })
  .strict();

export const BootstrapClaimBodySchema = BootstrapClaimPayloadSchema.extend({
  claim_token: z.string().min(16).optional()
}).strict();

export type BootstrapClaimPayload = z.infer<typeof BootstrapClaimPayloadSchema>;

export const BootstrapClaimRecordSchema = z
  .object({
    bootstrap_state: z.literal("claimed"),
    authority_id: AuthorityIdSchema,
    claimed_at: IsoTimestampSchema,
    claimed_by_device_public_key_hash: z.string().min(16),
    policy_generation: z.number().int().nonnegative(),
    claim_token_burned_at: IsoTimestampSchema,
    reset_generation: z.number().int().nonnegative()
  })
  .strict();

export type BootstrapClaimRecord = z.infer<typeof BootstrapClaimRecordSchema>;

export type BootstrapRuntimeConfig = {
  claim_token_hash?: string;
  claim_token_expires_at?: string;
};

export type BootstrapStatus = {
  bootstrap_state: BootstrapState;
  authority_id?: string;
  claimed_at?: string;
  policy_generation?: number;
  claim_token_burned_at?: string;
  reset_generation: number;
};

export type BootstrapClaimFailureReason =
  | "sealed"
  | "already-claimed"
  | "missing-token"
  | "invalid-token"
  | "expired-token"
  | "malformed-claim";

export type BootstrapClaimResult =
  | {
      ok: true;
      status: BootstrapStatus;
      record: BootstrapClaimRecord;
    }
  | {
      ok: false;
      status: BootstrapStatus;
      reason: BootstrapClaimFailureReason;
    };

export function configToInitialState(config: BootstrapRuntimeConfig): BootstrapState {
  return ClaimTokenHashSchema.safeParse(config.claim_token_hash).success ? "unclaimed" : "sealed";
}

export function isClaimTokenExpired(config: BootstrapRuntimeConfig, nowIso: string): boolean {
  return config.claim_token_expires_at !== undefined && Date.parse(config.claim_token_expires_at) <= Date.parse(nowIso);
}

export async function sha256TokenHash(token: string): Promise<ClaimTokenHash> {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return ClaimTokenHashSchema.parse(`sha256:${hex}`);
}

function decodeHash(hash: string | undefined): Uint8Array {
  const parsed = ClaimTokenHashSchema.safeParse(hash);
  const hex = parsed.success ? parsed.data.slice("sha256:".length) : "0".repeat(64);
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export async function verifyClaimToken(token: string, expectedHash: string | undefined): Promise<boolean> {
  const actual = decodeHash(await sha256TokenHash(token));
  const expected = decodeHash(expectedHash);
  let diff = actual.length ^ expected.length;
  for (let index = 0; index < Math.max(actual.length, expected.length); index += 1) {
    diff |= (actual[index] ?? 0) ^ (expected[index] ?? 0);
  }
  return ClaimTokenHashSchema.safeParse(expectedHash).success && diff === 0;
}
