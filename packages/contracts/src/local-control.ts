import { z } from "zod";
import { AuthorityIdSchema, CapabilityIdSchema, ClientIdSchema, IsoTimestampSchema, Sha256HashSchema } from "./ids";
import { ControlPlaneSnapshotSchema } from "./identity-config";

export const LocalCredentialRecordSchema = z
  .object({
    credential_id: z.string().regex(/^la_local_credential_[A-Za-z0-9_-]{8,}$/),
    client_id: ClientIdSchema,
    capability_id: CapabilityIdSchema,
    token_hash: Sha256HashSchema,
    created_at: IsoTimestampSchema,
    expires_at: IsoTimestampSchema.optional(),
    revoked_at: IsoTimestampSchema.optional()
  })
  .strict();

export const LocalControlStateSchema = z
  .object({
    schema_version: z.literal(1),
    authority_id: AuthorityIdSchema,
    control_plane: ControlPlaneSnapshotSchema,
    local_credentials: z.array(LocalCredentialRecordSchema),
    created_at: IsoTimestampSchema,
    updated_at: IsoTimestampSchema
  })
  .superRefine((state, ctx) => {
    if (state.authority_id !== state.control_plane.authority.authority_id) {
      ctx.addIssue({
        code: "custom",
        path: ["authority_id"],
        message: "local control state authority_id must match control_plane authority"
      });
    }

    const localClientIds = new Set(state.control_plane.clients.map((client) => client.client_id));
    const capabilityIds = new Set(state.control_plane.capabilities.map((capability) => capability.capability_id));

    state.local_credentials.forEach((credential, index) => {
      if (!localClientIds.has(credential.client_id)) {
        ctx.addIssue({
          code: "custom",
          path: ["local_credentials", index, "client_id"],
          message: "local credential client_id must reference the local control plane"
        });
      }

      if (!capabilityIds.has(credential.capability_id)) {
        ctx.addIssue({
          code: "custom",
          path: ["local_credentials", index, "capability_id"],
          message: "local credential capability_id must reference the local control plane"
        });
      }
    });
  });

export type LocalCredentialRecord = z.infer<typeof LocalCredentialRecordSchema>;
export type LocalControlState = z.infer<typeof LocalControlStateSchema>;
