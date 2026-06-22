import { z } from "zod";
import { AccessClassSchema, McpProfileSchema, OperationSchema } from "./classification";
import {
  AuthorityIdSchema,
  CapabilityIdSchema,
  ChangeIdSchema,
  EventIdSchema,
  IsoTimestampSchema,
  KeyIdSchema,
  ObjectIdSchema,
  OperationIdSchema,
  Sha256HashSchema,
  TraceIdSchema
} from "./ids";

export const AuditEventTypeSchema = z.enum([
  "object.read",
  "object.denied",
  "object.decrypt",
  "object.create",
  "object.update",
  "object.delete",
  "object.restore",
  "sync.read",
  "sync.denied",
  "release.published",
  "release.revoked",
  "release.expired",
  "policy.changed",
  "key.changed",
  "key.rotated",
  "key.revoked",
  "device.changed",
  "client.changed",
  "sync.conflict",
  "bootstrap.claimed"
]);

export const AuditRedactionSchema = z.enum(["none", "remote-redacted", "generic-unavailable"]);
export const AuditOutcomeSchema = z.enum(["allowed", "denied", "withheld", "released", "changed"]);
export const AuditReasonCodeSchema = z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,95}$/);

const SyncBatchIdSchema = z.string().regex(/^la_sync_batch_[A-Za-z0-9_-]{8,}$/);
const ForbiddenAuditSummaryPattern = /\b(ciphertext|plaintext|secret|token|password|payload|wrapped[-_ ]?key)\b/i;
const SafeAuditSummarySchema = z
  .string()
  .min(1)
  .max(180)
  .refine(
    (summary) => !ForbiddenAuditSummaryPattern.test(summary),
    "Audit summaries must not carry plaintext, ciphertext, secret, token, or payload material"
  );

export const DurableAuditEventSchema = z
  .object({
    audit_id: z.string().regex(/^la_audit_[A-Za-z0-9_-]{8,}$/),
    authority_id: AuthorityIdSchema,
    operation_id: OperationIdSchema,
    trace_id: TraceIdSchema,
    recorded_at: IsoTimestampSchema,
    actor_id: z.string().min(1),
    mcp_profile: McpProfileSchema,
    operation: OperationSchema,
    event_type: AuditEventTypeSchema,
    outcome: AuditOutcomeSchema.optional(),
    reason_code: AuditReasonCodeSchema.optional(),
    object_id: ObjectIdSchema.optional(),
    release_id: ObjectIdSchema.optional(),
    key_id: KeyIdSchema.optional(),
    capability_id: CapabilityIdSchema.optional(),
    sync_batch_id: SyncBatchIdSchema.optional(),
    access_class: AccessClassSchema.optional(),
    redaction: AuditRedactionSchema,
    summary: SafeAuditSummarySchema
  })
  .strict()
  .superRefine((event, ctx) => {
    if (event.event_type === "object.read" && !event.object_id) {
      ctx.addIssue({ code: "custom", path: ["object_id"], message: "object.read audit events must name an object id" });
    }

    if (event.event_type.startsWith("release.")) {
      if (event.access_class !== "release") {
        ctx.addIssue({ code: "custom", path: ["access_class"], message: "release audit events must use release access_class" });
      }

      if (!event.release_id && !event.object_id) {
        ctx.addIssue({ code: "custom", path: ["release_id"], message: "release audit events must name a release id or object id" });
      }
    }

    if (event.event_type.startsWith("key.") && !event.key_id) {
      ctx.addIssue({ code: "custom", path: ["key_id"], message: "key audit events must name a key id" });
    }
  });

export const SyncChangeEventSchema = z.object({
  change_id: ChangeIdSchema,
  authority_id: AuthorityIdSchema,
  operation_id: OperationIdSchema,
  trace_id: TraceIdSchema,
  recorded_at: IsoTimestampSchema,
  object_id: ObjectIdSchema,
  operation: z.enum(["create", "update", "delete", "tombstone", "restore"]),
  base_version: z.number().int().nonnegative().optional(),
  new_version: z.number().int().nonnegative(),
  content_hash: Sha256HashSchema,
  access_class: AccessClassSchema,
  generation: z.number().int().nonnegative(),
  actor_id: z.string().min(1)
});

export type DurableAuditEvent = z.infer<typeof DurableAuditEventSchema>;
export type SyncChangeEvent = z.infer<typeof SyncChangeEventSchema>;

export const LiveActivityPlaneSchema = z.enum(["local", "remote", "sync", "future-federation"]);
export const LiveActivityCrudSchema = z.enum([
  "create",
  "read",
  "search",
  "traverse",
  "update",
  "delete",
  "restore",
  "sync-push",
  "sync-pull",
  "decrypt",
  "policy-allow",
  "policy-deny",
  "release",
  "federate"
]);
export const LiveActivityPolicyDecisionSchema = z.enum(["allow", "deny", "partial", "ciphertext-only"]);
export const LiveActivityVisibilityModeSchema = z.enum([
  "metadata",
  "local_unlocked",
  "remote_safe",
  "presentation"
]);

export const LiveActivityEventSchema = z
  .object({
    event_id: EventIdSchema,
    operation_id: OperationIdSchema,
    trace_id: TraceIdSchema,
    cursor: z.string().regex(/^[0-9]{12,}$/),
    recorded_at: IsoTimestampSchema,
    plane: LiveActivityPlaneSchema,
    crud: LiveActivityCrudSchema,
    policy_decision: LiveActivityPolicyDecisionSchema,
    graph_touch: z.object({
      nodes: z.array(ObjectIdSchema).default([]),
      edges: z.array(ObjectIdSchema).default([]),
      objects: z.array(ObjectIdSchema).default([]),
      path: z.array(ObjectIdSchema).default([])
    }),
    visibility: z.object({
      mode: LiveActivityVisibilityModeSchema,
      contains_sensitive: z.boolean(),
      redacted: z.boolean()
    }),
    summary: z.string().min(1).optional(),
    visual: z
      .object({
        motion: z.string().min(1),
        intensity: z.number().min(0).max(1),
        color_role: z.string().min(1)
      })
      .optional()
  })
  .strict();

export type LiveActivityEvent = z.infer<typeof LiveActivityEventSchema>;
