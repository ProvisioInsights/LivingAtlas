import { z } from "zod";

const opaqueIdPart = "[A-Za-z0-9_-]{8,}";

export const AuthorityIdSchema = z.string().regex(new RegExp(`^la_authority_${opaqueIdPart}$`));
export const UserIdSchema = z.string().regex(new RegExp(`^la_user_${opaqueIdPart}$`));
export const DeviceIdSchema = z.string().regex(new RegExp(`^la_device_${opaqueIdPart}$`));
export const ClientIdSchema = z.string().regex(new RegExp(`^la_client_${opaqueIdPart}$`));
export const CapabilityIdSchema = z.string().regex(new RegExp(`^la_cap_${opaqueIdPart}$`));
export const KeyIdSchema = z.string().regex(new RegExp(`^la_key_${opaqueIdPart}$`));
export const ObjectIdSchema = z.string().regex(new RegExp(`^la_object_${opaqueIdPart}$`));
export const EventIdSchema = z.string().regex(new RegExp(`^la_event_${opaqueIdPart}$`));
export const ChangeIdSchema = z.string().regex(new RegExp(`^la_change_${opaqueIdPart}$`));
export const OperationIdSchema = z.string().regex(new RegExp(`^la_operation_${opaqueIdPart}$`));
export const TraceIdSchema = z.string().regex(new RegExp(`^la_trace_${opaqueIdPart}$`));

export const Sha256HashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export type AuthorityId = z.infer<typeof AuthorityIdSchema>;
export type ObjectId = z.infer<typeof ObjectIdSchema>;

export const IsoTimestampSchema = z.string().refine(
  (value) => value.includes("T") && !Number.isNaN(Date.parse(value)),
  "Expected an ISO-like timestamp with a time component"
);
