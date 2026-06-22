import { z } from "zod";
import {
  AccessClassSchema,
  AdminOperations,
  GraphMutationOperations,
  McpProfileSchema,
  OperationSchema,
  type AccessClass,
  type Operation
} from "./classification";
import {
  AuthorityIdSchema,
  CapabilityIdSchema,
  ClientIdSchema,
  DeviceIdSchema,
  IsoTimestampSchema,
  KeyIdSchema,
  UserIdSchema
} from "./ids";

export const ClientTypeSchema = z.enum([
  "local-ai",
  "local-cli",
  "local-ui",
  "browser",
  "remote-provider",
  "sync-agent",
  "admin-cli"
]);

export const DeviceTrustLevelSchema = z.enum(["keyholding", "sync-only", "remote-runtime", "revoked"]);

export const AuthorityRecordSchema = z.object({
  authority_id: AuthorityIdSchema,
  display_name: z.string().min(1),
  created_at: IsoTimestampSchema,
  policy_generation: z.number().int().nonnegative()
});

export const UserRecordSchema = z.object({
  user_id: UserIdSchema,
  authority_id: AuthorityIdSchema,
  display_name: z.string().min(1),
  created_at: IsoTimestampSchema,
  disabled_at: IsoTimestampSchema.optional()
});

export const DeviceRecordSchema = z.object({
  device_id: DeviceIdSchema,
  authority_id: AuthorityIdSchema,
  user_id: UserIdSchema.optional(),
  trust_level: DeviceTrustLevelSchema,
  public_key_hash: z.string().min(16),
  created_at: IsoTimestampSchema,
  revoked_at: IsoTimestampSchema.optional()
});

export const ClientRecordSchema = z.object({
  client_id: ClientIdSchema,
  authority_id: AuthorityIdSchema,
  client_type: ClientTypeSchema,
  device_id: DeviceIdSchema.optional(),
  allowed_profile: McpProfileSchema,
  credential_ref: z.string().min(1),
  created_at: IsoTimestampSchema,
  expires_at: IsoTimestampSchema.optional(),
  revoked_at: IsoTimestampSchema.optional()
}).superRefine((client, ctx) => {
  const allowedByType: Record<z.infer<typeof ClientTypeSchema>, readonly string[]> = {
    "local-ai": ["local-full", "local-readonly", "local-crud", "local-release"],
    "local-cli": ["local-full", "local-readonly", "local-crud", "local-release"],
    "local-ui": ["local-full", "local-readonly", "local-crud", "local-release"],
    browser: ["sensitive-keyholding-client", "local-release", "remote-safe"],
    "remote-provider": ["remote-safe"],
    "sync-agent": ["sync-device"],
    "admin-cli": ["local-admin"]
  };

  if (!allowedByType[client.client_type].includes(client.allowed_profile)) {
    ctx.addIssue({
      code: "custom",
      path: ["allowed_profile"],
      message: `${client.client_type} clients cannot use ${client.allowed_profile} profile`
    });
  }
});

const RemoteForbiddenAccessClasses = new Set<AccessClass>(["local-private", "quarantine"]);
const RemoteForbiddenOperations = new Set<Operation>([
  "decrypt",
  "admin-config",
  "grant-capability",
  "enroll-device"
]);
const SyncAllowedOperations = new Set<Operation>(["sync-read", "sync-write", "audit-read"]);
const LocalReadonlyAllowedOperations = new Set<Operation>(["read", "search", "traverse", "decrypt", "audit-read"]);

export const CapabilityGrantSchema = z
  .object({
    capability_id: CapabilityIdSchema,
    authority_id: AuthorityIdSchema,
    client_id: ClientIdSchema,
    profile: McpProfileSchema,
    operations: z.array(OperationSchema).min(1),
    access_classes: z.array(AccessClassSchema).min(1),
    created_at: IsoTimestampSchema,
    expires_at: IsoTimestampSchema.optional(),
    revoked_at: IsoTimestampSchema.optional()
  })
  .superRefine((grant, ctx) => {
    if (grant.profile === "remote-safe") {
      for (const accessClass of grant.access_classes) {
        if (RemoteForbiddenAccessClasses.has(accessClass)) {
          ctx.addIssue({
            code: "custom",
            path: ["access_classes"],
            message: "remote-safe capabilities cannot include local-private or quarantine access"
          });
        }
      }

      for (const operation of grant.operations) {
        if (RemoteForbiddenOperations.has(operation)) {
          ctx.addIssue({
            code: "custom",
            path: ["operations"],
            message: "remote-safe capabilities cannot decrypt, administer config, grant access, or enroll devices"
          });
        }
      }
    }

    if (grant.profile === "sync-device") {
      for (const operation of grant.operations) {
        if (!SyncAllowedOperations.has(operation)) {
          ctx.addIssue({
            code: "custom",
            path: ["operations"],
            message: "sync-device capabilities are limited to sync and audit envelope operations"
          });
        }
      }
    }

    if (grant.profile === "local-readonly") {
      for (const operation of grant.operations) {
        if (!LocalReadonlyAllowedOperations.has(operation)) {
          ctx.addIssue({
            code: "custom",
            path: ["operations"],
            message: "local-readonly capabilities cannot mutate graph or configuration"
          });
        }
      }
    }

    if (grant.profile !== "local-admin") {
      for (const operation of grant.operations) {
        if ((AdminOperations as readonly string[]).includes(operation)) {
          ctx.addIssue({
            code: "custom",
            path: ["operations"],
            message: "Only local-admin capabilities may mutate configuration or enroll devices"
          });
        }
      }
    }

    if (grant.profile === "local-readonly") {
      for (const operation of grant.operations) {
        if ((GraphMutationOperations as readonly string[]).includes(operation)) {
          ctx.addIssue({
            code: "custom",
            path: ["operations"],
            message: "local-readonly capabilities cannot mutate graph objects"
          });
        }
      }
    }
  });

export const KeyReferenceSchema = z.object({
  key_id: KeyIdSchema,
  authority_id: AuthorityIdSchema,
  purpose: z.enum(["authority", "access-class", "data-encryption", "device-wrapping", "local-index"]),
  access_class: AccessClassSchema.optional(),
  created_at: IsoTimestampSchema,
  revoked_at: IsoTimestampSchema.optional(),
  cloud_unwrapped: z.literal(false)
});

export const ControlPlaneSnapshotSchema = z.object({
  authority: AuthorityRecordSchema,
  users: z.array(UserRecordSchema),
  devices: z.array(DeviceRecordSchema),
  clients: z.array(ClientRecordSchema),
  capabilities: z.array(CapabilityGrantSchema),
  keys: z.array(KeyReferenceSchema),
  policy_generation: z.number().int().nonnegative()
}).superRefine((snapshot, ctx) => {
  const authorityId = snapshot.authority.authority_id;

  if (snapshot.policy_generation !== snapshot.authority.policy_generation) {
    ctx.addIssue({
      code: "custom",
      path: ["policy_generation"],
      message: "snapshot policy_generation must match the authority policy_generation"
    });
  }

  const uniqueIds = new Map<string, string>();
  function recordUnique(id: string, path: (string | number)[], kind: string): void {
    const existing = uniqueIds.get(id);
    if (existing) {
      ctx.addIssue({
        code: "custom",
        path,
        message: `${kind} id duplicates ${existing}`
      });
      return;
    }
    uniqueIds.set(id, kind);
  }

  snapshot.users.forEach((user, index) => {
    recordUnique(user.user_id, ["users", index, "user_id"], "user");
    if (user.authority_id !== authorityId) {
      ctx.addIssue({ code: "custom", path: ["users", index, "authority_id"], message: "user authority_id must match snapshot authority" });
    }
  });

  const userIds = new Set(snapshot.users.map((user) => user.user_id));
  snapshot.devices.forEach((device, index) => {
    recordUnique(device.device_id, ["devices", index, "device_id"], "device");
    if (device.authority_id !== authorityId) {
      ctx.addIssue({ code: "custom", path: ["devices", index, "authority_id"], message: "device authority_id must match snapshot authority" });
    }
    if (device.user_id && !userIds.has(device.user_id)) {
      ctx.addIssue({ code: "custom", path: ["devices", index, "user_id"], message: "device user_id must reference a snapshot user" });
    }
  });

  const deviceIds = new Set(snapshot.devices.map((device) => device.device_id));
  snapshot.clients.forEach((client, index) => {
    recordUnique(client.client_id, ["clients", index, "client_id"], "client");
    if (client.authority_id !== authorityId) {
      ctx.addIssue({ code: "custom", path: ["clients", index, "authority_id"], message: "client authority_id must match snapshot authority" });
    }
    if (client.device_id && !deviceIds.has(client.device_id)) {
      ctx.addIssue({ code: "custom", path: ["clients", index, "device_id"], message: "client device_id must reference a snapshot device" });
    }
  });

  const clientsById = new Map(snapshot.clients.map((client) => [client.client_id, client]));
  snapshot.capabilities.forEach((capability, index) => {
    recordUnique(capability.capability_id, ["capabilities", index, "capability_id"], "capability");
    if (capability.authority_id !== authorityId) {
      ctx.addIssue({ code: "custom", path: ["capabilities", index, "authority_id"], message: "capability authority_id must match snapshot authority" });
    }

    const client = clientsById.get(capability.client_id);
    if (!client) {
      ctx.addIssue({ code: "custom", path: ["capabilities", index, "client_id"], message: "capability client_id must reference a snapshot client" });
      return;
    }

    if (client.allowed_profile !== capability.profile) {
      ctx.addIssue({ code: "custom", path: ["capabilities", index, "profile"], message: "capability profile must match the client allowed_profile" });
    }
  });

  snapshot.keys.forEach((key, index) => {
    recordUnique(key.key_id, ["keys", index, "key_id"], "key");
    if (key.authority_id !== authorityId) {
      ctx.addIssue({ code: "custom", path: ["keys", index, "authority_id"], message: "key authority_id must match snapshot authority" });
    }
  });
});

export type CapabilityGrant = z.infer<typeof CapabilityGrantSchema>;
export type ClientRecord = z.infer<typeof ClientRecordSchema>;
export type ControlPlaneSnapshot = z.infer<typeof ControlPlaneSnapshotSchema>;
