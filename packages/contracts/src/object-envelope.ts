import { z } from "zod";
import {
  AccessClassSchema,
  EncryptionClassSchema,
  ObjectTypeSchema,
  type AccessClass
} from "./classification";
import {
  AuthorityIdSchema,
  IsoTimestampSchema,
  KeyIdSchema,
  ObjectIdSchema,
  Sha256HashSchema
} from "./ids";

export const PlaintextJsonPayloadSchema = z.object({
  kind: z.literal("plaintext-json"),
  data: z.record(z.string(), z.unknown())
});

export const CiphertextRefPayloadSchema = z.object({
  kind: z.literal("ciphertext-ref"),
  storage: z.enum(["r2", "local"]),
  path: z.string().min(1),
  ciphertext_hash: Sha256HashSchema,
  byte_size: z.number().int().positive(),
  algorithm: z.string().min(1).default("xchacha20-poly1305")
}).superRefine((payload, ctx) => {
  if (payload.storage === "r2" && !/^objects\/a=[a-f0-9]{16}\/p=[a-f0-9]{2}\/s=[a-f0-9]{40}\.bin$/.test(payload.path)) {
    ctx.addIssue({
      code: "custom",
      path: ["path"],
      message: "R2 ciphertext paths must be opaque Cloudflare object paths"
    });
  }
});

export const CiphertextInlinePayloadSchema = z.object({
  kind: z.literal("ciphertext-inline"),
  ciphertext: z.string().min(1),
  nonce: z.string().min(1),
  algorithm: z.string().min(1).default("xchacha20-poly1305")
});

export const GraphPayloadSchema = z.discriminatedUnion("kind", [
  PlaintextJsonPayloadSchema,
  CiphertextRefPayloadSchema,
  CiphertextInlinePayloadSchema
]);

export const VisibleMetadataSchema = z
  .object({
    schema_namespace: z.string().min(1).optional(),
    tombstone: z.boolean().default(false),
    size_class: z.enum(["tiny", "small", "medium", "large", "huge"]).optional(),
    remote_indexable: z.boolean().default(false),
    release_expires_at: IsoTimestampSchema.optional()
  })
  .strict();

const SensitiveAccessClasses = new Set<AccessClass>(["local-private", "quarantine"]);

export const GraphObjectEnvelopeSchema = z
  .object({
    schema_version: z.literal(1),
    authority_id: AuthorityIdSchema,
    object_id: ObjectIdSchema,
    object_type: ObjectTypeSchema,
    version: z.number().int().nonnegative(),
    access_class: AccessClassSchema.default("local-private"),
    encryption_class: EncryptionClassSchema.default("client-encrypted"),
    created_at: IsoTimestampSchema,
    updated_at: IsoTimestampSchema,
    content_hash: Sha256HashSchema,
    key_ref: KeyIdSchema.optional(),
    visible_metadata: VisibleMetadataSchema.default({ tombstone: false, remote_indexable: false }),
    payload: GraphPayloadSchema
  })
  .superRefine((envelope, ctx) => {
    if (SensitiveAccessClasses.has(envelope.access_class) && envelope.payload.kind === "plaintext-json") {
      ctx.addIssue({
        code: "custom",
        path: ["payload"],
        message: "Sensitive or quarantined objects must not carry plaintext payloads in the envelope"
      });
    }

    if (SensitiveAccessClasses.has(envelope.access_class) && envelope.encryption_class === "plaintext") {
      ctx.addIssue({
        code: "custom",
        path: ["encryption_class"],
        message: "Sensitive or quarantined objects must not use plaintext encryption_class"
      });
    }

    if (envelope.encryption_class === "client-encrypted" && envelope.payload.kind === "plaintext-json") {
      ctx.addIssue({
        code: "custom",
        path: ["payload"],
        message: "client-encrypted envelopes require ciphertext payloads"
      });
    }

    if (SensitiveAccessClasses.has(envelope.access_class) && envelope.visible_metadata.remote_indexable) {
      ctx.addIssue({
        code: "custom",
        path: ["visible_metadata", "remote_indexable"],
        message: "Sensitive or quarantined objects must not be remote indexable"
      });
    }

    if (
      SensitiveAccessClasses.has(envelope.access_class) &&
      envelope.payload.kind === "ciphertext-ref" &&
      envelope.content_hash !== envelope.payload.ciphertext_hash
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["content_hash"],
        message: "Sensitive ciphertext-ref envelopes must hash ciphertext, not plaintext"
      });
    }

    if (envelope.access_class === "release" && !envelope.visible_metadata.release_expires_at) {
      ctx.addIssue({
        code: "custom",
        path: ["visible_metadata", "release_expires_at"],
        message: "Release objects require an expiry"
      });
    }
  });

export type GraphObjectEnvelope = z.infer<typeof GraphObjectEnvelopeSchema>;
export type GraphPayload = z.infer<typeof GraphPayloadSchema>;

export function parseGraphObjectEnvelope(input: unknown): GraphObjectEnvelope {
  return GraphObjectEnvelopeSchema.parse(input);
}

export function isPlaintextPayloadAllowedForRemote(envelope: GraphObjectEnvelope): boolean {
  return envelope.payload.kind === "plaintext-json" && envelope.encryption_class !== "client-encrypted";
}
