import { z } from "zod";

export const AccessClassValues = [
  "local-private",
  "remote-safe",
  "shareable",
  "quarantine",
  "release"
] as const;

export const AccessClassSchema = z.enum(AccessClassValues);
export type AccessClass = z.infer<typeof AccessClassSchema>;

export const RemoteReadableAccessClasses = [
  "remote-safe",
  "shareable",
  "release"
] as const satisfies readonly AccessClass[];

export const EncryptionClassValues = [
  "client-encrypted",
  "remote-readable",
  "plaintext",
  "local-only-index"
] as const;

export const EncryptionClassSchema = z.enum(EncryptionClassValues);
export type EncryptionClass = z.infer<typeof EncryptionClassSchema>;

export const ObjectTypeValues = [
  "page",
  "block",
  "edge",
  "event",
  "attachment",
  "manifest",
  "index",
  "audit",
  "change",
  "config"
] as const;

export const ObjectTypeSchema = z.enum(ObjectTypeValues);
export type ObjectType = z.infer<typeof ObjectTypeSchema>;

export const McpProfileValues = [
  "local-full",
  "local-readonly",
  "local-crud",
  "local-admin",
  "local-release",
  "remote-safe",
  "sensitive-keyholding-client",
  "sync-device"
] as const;

export const McpProfileSchema = z.enum(McpProfileValues);
export type McpProfile = z.infer<typeof McpProfileSchema>;

export const OperationValues = [
  "read",
  "search",
  "traverse",
  "create",
  "update",
  "delete",
  "restore",
  "decrypt",
  "sync-read",
  "sync-write",
  "admin-config",
  "grant-capability",
  "enroll-device",
  "audit-read"
] as const;

export const OperationSchema = z.enum(OperationValues);
export type Operation = z.infer<typeof OperationSchema>;

export const GraphReadOperations = ["read", "search", "traverse"] as const satisfies readonly Operation[];
export const GraphMutationOperations = ["create", "update", "delete", "restore"] as const satisfies readonly Operation[];
export const AdminOperations = ["admin-config", "grant-capability", "enroll-device"] as const satisfies readonly Operation[];

export function isRemoteReadableAccessClass(accessClass: AccessClass): boolean {
  return (RemoteReadableAccessClasses as readonly string[]).includes(accessClass);
}

export function isGraphMutationOperation(operation: Operation): boolean {
  return (GraphMutationOperations as readonly string[]).includes(operation);
}
