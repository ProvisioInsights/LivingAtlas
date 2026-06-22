import { z } from "zod";
import { GraphObjectEnvelopeSchema } from "./object-envelope";
import {
  AuthorityIdSchema,
  CapabilityIdSchema,
  ClientIdSchema,
  DeviceIdSchema,
  IsoTimestampSchema,
  ObjectIdSchema,
  OperationIdSchema,
  Sha256HashSchema,
  TraceIdSchema
} from "./ids";
import { SyncChangeEventSchema } from "./events";

const CiphertextOnlyObjectSchema = GraphObjectEnvelopeSchema.superRefine((object, ctx) => {
  if (object.payload.kind === "plaintext-json") {
    ctx.addIssue({
      code: "custom",
      path: ["payload"],
      message: "sync batches carry ciphertext envelopes only; plaintext projections use a separate release path"
    });
  }
});

const DefaultSyncBatchLimits = {
  max_objects: 250,
  max_changes: 1000,
  max_bytes: 1_000_000
} as const;

const Sha256RoundConstants = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

function sha256Hex(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 1 + 8) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;

  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const words = new Array<number>(64).fill(0);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4);
    }

    for (let index = 16; index < 64; index += 1) {
      const s0 = (rotateRight(words[index - 15]!, 7) ^ rotateRight(words[index - 15]!, 18) ^ (words[index - 15]! >>> 3)) >>> 0;
      const s1 = (rotateRight(words[index - 2]!, 17) ^ rotateRight(words[index - 2]!, 19) ^ (words[index - 2]! >>> 10)) >>> 0;
      words[index] = (words[index - 16]! + s0 + words[index - 7]! + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let index = 0; index < 64; index += 1) {
      const s1 = (rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = (h + s1 + ch + Sha256RoundConstants[index]! + words[index]!) >>> 0;
      const s0 = (rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (s0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((part) => part.toString(16).padStart(8, "0"))
    .join("");
}

function sha256Hash(value: string): `sha256:${string}` {
  return `sha256:${sha256Hex(value)}`;
}

function derivedOpaqueId(prefix: "la_cap" | "la_idem", seed: string): string {
  return `${prefix}_${sha256Hex(seed).slice(0, 24)}`;
}

function encodedByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function deriveObjectPayloadRefs(objects: unknown): unknown[] {
  if (!Array.isArray(objects)) {
    return [];
  }

  return objects.filter(isRecord).map((object) => {
    const payload = isRecord(object.payload) ? object.payload : {};
    const ciphertextHash = payload.kind === "ciphertext-ref" && typeof payload.ciphertext_hash === "string"
      ? payload.ciphertext_hash
      : undefined;
    const r2Path = payload.kind === "ciphertext-ref" && payload.storage === "r2" && typeof payload.path === "string"
      ? payload.path
      : undefined;
    const payloadBytes = payload.kind === "ciphertext-ref" && typeof payload.byte_size === "number"
      ? payload.byte_size
      : Math.max(encodedByteLength(payload), 1);

    return {
      object_id: object.object_id,
      version: object.version,
      envelope_hash: sha256Hash(JSON.stringify(object)),
      payload_hash: ciphertextHash ?? sha256Hash(JSON.stringify(payload)),
      byte_size: payloadBytes,
      r2_path_hash: r2Path ? sha256Hash(r2Path) : undefined
    };
  });
}

function normalizeGraphObjects(objects: unknown): unknown {
  if (!Array.isArray(objects)) {
    return objects;
  }

  return objects.map((object) => {
    const parsed = GraphObjectEnvelopeSchema.safeParse(object);
    return parsed.success ? parsed.data : object;
  });
}

function withDerivedSyncBatchFields(input: unknown): unknown {
  if (!isRecord(input)) {
    return input;
  }

  const batch = { ...input };
  batch.objects = normalizeGraphObjects(batch.objects);
  const batchSeed = JSON.stringify({
    batch_id: batch.batch_id,
    authority_id: batch.authority_id,
    device_id: batch.device_id,
    client_id: batch.client_id,
    base_generation: batch.base_generation,
    target_generation: batch.target_generation
  });

  batch.capability_id ??= derivedOpaqueId("la_cap", `legacy-capability:${String(batch.client_id ?? batch.batch_id ?? batchSeed)}`);
  batch.idempotency_key ??= derivedOpaqueId("la_idem", `legacy-idempotency:${String(batch.batch_id ?? batchSeed)}`);
  batch.object_payloads ??= deriveObjectPayloadRefs(batch.objects);
  batch.estimated_batch_bytes ??= encodedByteLength(batch.objects ?? []);
  batch.limits ??= DefaultSyncBatchLimits;

  if (typeof batch.batch_hash !== "string") {
    batch.batch_hash = sha256Hash(canonicalSyncBatchHashPayload(batch as Omit<SyncBatch, "batch_hash">));
  }

  return batch;
}

export const SyncBatchIdSchema = z.string().regex(/^la_sync_batch_[A-Za-z0-9_-]{8,}$/);
export const SyncIdempotencyKeySchema = z.string().regex(/^la_idem_[A-Za-z0-9_-]{8,}$/);

export const SyncBatchLimitsSchema = z
  .object({
    max_objects: z.number().int().positive().max(1000).default(250),
    max_changes: z.number().int().positive().max(5000).default(1000),
    max_bytes: z.number().int().positive().max(10_000_000).default(1_000_000)
  })
  .strict();

export const SyncObjectPayloadRefSchema = z
  .object({
    object_id: ObjectIdSchema,
    version: z.number().int().nonnegative(),
    envelope_hash: Sha256HashSchema,
    payload_hash: Sha256HashSchema,
    byte_size: z.number().int().positive(),
    r2_path_hash: Sha256HashSchema.optional()
  })
  .strict();

export const SyncPullCursorSchema = z
  .object({
    authority_id: AuthorityIdSchema,
    generation: z.number().int().nonnegative(),
    batch_id: SyncBatchIdSchema.optional()
  })
  .strict();

export const SyncPullRecoverySchema = z
  .object({
    mode: z.enum(["none", "replay", "snapshot-catchup"]),
    from_generation: z.number().int().nonnegative().optional(),
    reason: z.enum([
      "current",
      "local-cursor-behind",
      "local-cursor-ahead",
      "cursor-missing",
      "retention-gap"
    ]).optional()
  })
  .strict()
  .superRefine((recovery, ctx) => {
    if (recovery.mode === "none" && recovery.from_generation !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["from_generation"],
        message: "from_generation is only valid when pull recovery is required"
      });
    }

    if (recovery.mode !== "none" && recovery.from_generation === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["from_generation"],
        message: "pull recovery modes must include from_generation"
      });
    }
  });

const SyncBatchShapeSchema = z
  .object({
    batch_id: SyncBatchIdSchema,
    authority_id: AuthorityIdSchema,
    device_id: DeviceIdSchema,
    client_id: ClientIdSchema,
    capability_id: CapabilityIdSchema,
    operation_id: OperationIdSchema,
    trace_id: TraceIdSchema,
    token_id: z.string().min(1).max(128).optional(),
    idempotency_key: SyncIdempotencyKeySchema,
    batch_hash: Sha256HashSchema,
    submitted_at: IsoTimestampSchema,
    base_generation: z.number().int().nonnegative(),
    target_generation: z.number().int().positive(),
    base_cursor: SyncPullCursorSchema.optional(),
    pull_recovery: SyncPullRecoverySchema.optional(),
    object_payloads: z.array(SyncObjectPayloadRefSchema),
    objects: z.array(CiphertextOnlyObjectSchema),
    changes: z.array(SyncChangeEventSchema),
    estimated_batch_bytes: z.number().int().nonnegative(),
    limits: SyncBatchLimitsSchema.default(DefaultSyncBatchLimits),
    withheld_plaintext_count: z.number().int().nonnegative()
  })
  .strict()
  .superRefine((batch, ctx) => {
    if (batch.target_generation !== batch.base_generation + 1) {
      ctx.addIssue({
        code: "custom",
        path: ["target_generation"],
        message: "target_generation must advance exactly one generation beyond base_generation"
      });
    }

    if (batch.base_cursor && batch.base_cursor.generation !== batch.base_generation) {
      ctx.addIssue({
        code: "custom",
        path: ["base_cursor", "generation"],
        message: "base_cursor generation must match batch base_generation"
      });
    }

    if (batch.objects.length > batch.limits.max_objects) {
      ctx.addIssue({
        code: "custom",
        path: ["objects"],
        message: "sync batch exceeds max_objects"
      });
    }

    if (batch.changes.length > batch.limits.max_changes) {
      ctx.addIssue({
        code: "custom",
        path: ["changes"],
        message: "sync batch exceeds max_changes"
      });
    }

    if (batch.estimated_batch_bytes > batch.limits.max_bytes) {
      ctx.addIssue({
        code: "custom",
        path: ["estimated_batch_bytes"],
        message: "sync batch exceeds max_bytes"
      });
    }

    if (batch.object_payloads.length !== batch.objects.length) {
      ctx.addIssue({
        code: "custom",
        path: ["object_payloads"],
        message: "object_payloads must contain one entry for each synced object"
      });
    }

    const payloadRefs = new Set(
      batch.object_payloads.map((payload) => `${payload.object_id}:${payload.version}`)
    );

    batch.objects.forEach((object) => {
      if (!payloadRefs.has(`${object.object_id}:${object.version}`)) {
        ctx.addIssue({
          code: "custom",
          path: ["object_payloads"],
          message: "object_payloads must include every synced object/version"
        });
      }
    });

    batch.objects.forEach((object, index) => {
      if (object.authority_id !== batch.authority_id) {
        ctx.addIssue({
          code: "custom",
          path: ["objects", index, "authority_id"],
          message: "sync object authority_id must match batch authority_id"
        });
      }
    });

    batch.changes.forEach((change, index) => {
      if (change.authority_id !== batch.authority_id) {
        ctx.addIssue({
          code: "custom",
          path: ["changes", index, "authority_id"],
          message: "sync change authority_id must match batch authority_id"
        });
      }

      if (change.generation > batch.target_generation) {
        ctx.addIssue({
          code: "custom",
          path: ["changes", index, "generation"],
          message: "sync change generation must not exceed batch target_generation"
        });
      }
    });
  });

export const SyncBatchSchema = z.preprocess(withDerivedSyncBatchFields, SyncBatchShapeSchema);

export const SyncBatchAcceptedSchema = z
  .object({
    ok: z.literal(true),
    batch_id: SyncBatchIdSchema,
    accepted_objects: z.number().int().nonnegative(),
    accepted_changes: z.number().int().nonnegative(),
    target_generation: z.number().int().positive(),
    withheld_plaintext_count: z.number().int().nonnegative(),
    idempotent_replay: z.boolean().optional()
  })
  .strict();

export const SyncStatusSchema = z
  .object({
    ok: z.literal(true),
    latest_generation: z.number().int().nonnegative(),
    latest_batch_id: SyncBatchIdSchema.optional(),
    authority_id: AuthorityIdSchema.optional(),
    latest_submitted_at: IsoTimestampSchema.optional(),
    object_count: z.number().int().nonnegative(),
    change_count: z.number().int().nonnegative(),
    latest_withheld_plaintext_count: z.number().int().nonnegative(),
    sync_cursor: SyncPullCursorSchema.optional(),
    pull_recovery: SyncPullRecoverySchema.optional()
  })
  .strict();

export const SyncPullBatchSummarySchema = z
  .object({
    batch_id: SyncBatchIdSchema,
    batch_hash: Sha256HashSchema,
    base_generation: z.number().int().nonnegative(),
    target_generation: z.number().int().positive(),
    submitted_at: IsoTimestampSchema,
    object_count: z.number().int().nonnegative(),
    change_count: z.number().int().nonnegative(),
    withheld_plaintext_count: z.number().int().nonnegative()
  })
  .strict();

export const SyncPullResponseSchema = z
  .object({
    ok: z.literal(true),
    authority_id: AuthorityIdSchema,
    from_generation: z.number().int().nonnegative(),
    latest_generation: z.number().int().nonnegative(),
    batches: z.array(SyncPullBatchSummarySchema),
    next_cursor: SyncPullCursorSchema,
    recovery: SyncPullRecoverySchema.optional(),
    has_more: z.boolean()
  })
  .strict();

export const SyncEnvelopePullObjectSchema = z
  .object({
    batch_id: SyncBatchIdSchema,
    generation: z.number().int().positive(),
    submitted_at: IsoTimestampSchema,
    object: CiphertextOnlyObjectSchema
  })
  .strict();

export const SyncEnvelopePullResponseSchema = z
  .object({
    ok: z.literal(true),
    authority_id: AuthorityIdSchema,
    from_generation: z.number().int().nonnegative(),
    latest_generation: z.number().int().nonnegative(),
    objects: z.array(SyncEnvelopePullObjectSchema),
    next_cursor: SyncPullCursorSchema,
    recovery: SyncPullRecoverySchema.optional(),
    has_more: z.boolean()
  })
  .strict();

export function canonicalSyncBatchHashPayload(batch: Omit<SyncBatch, "batch_hash">): string {
  return JSON.stringify({
    schema: "living-atlas-sync-batch-hash:v1",
    batch_id: batch.batch_id,
    authority_id: batch.authority_id,
    device_id: batch.device_id,
    client_id: batch.client_id,
    capability_id: batch.capability_id,
    operation_id: batch.operation_id,
    trace_id: batch.trace_id,
    token_id: batch.token_id,
    idempotency_key: batch.idempotency_key,
    submitted_at: batch.submitted_at,
    base_generation: batch.base_generation,
    target_generation: batch.target_generation,
    base_cursor: batch.base_cursor,
    pull_recovery: batch.pull_recovery,
    object_payloads: batch.object_payloads,
    objects: batch.objects,
    changes: batch.changes,
    estimated_batch_bytes: batch.estimated_batch_bytes,
    limits: batch.limits,
    withheld_plaintext_count: batch.withheld_plaintext_count
  });
}

export type SyncBatch = z.infer<typeof SyncBatchSchema>;
export type SyncBatchAccepted = z.infer<typeof SyncBatchAcceptedSchema>;
export type SyncStatus = z.infer<typeof SyncStatusSchema>;
export type SyncPullCursor = z.infer<typeof SyncPullCursorSchema>;
export type SyncPullRecovery = z.infer<typeof SyncPullRecoverySchema>;
export type SyncPullResponse = z.infer<typeof SyncPullResponseSchema>;
export type SyncEnvelopePullObject = z.infer<typeof SyncEnvelopePullObjectSchema>;
export type SyncEnvelopePullResponse = z.infer<typeof SyncEnvelopePullResponseSchema>;
