import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import {
  AccessClassSchema,
  AuthorityIdSchema,
  GraphObjectEnvelopeSchema,
  GraphPayloadSchema,
  IsoTimestampSchema,
  KeyIdSchema,
  ObjectIdSchema,
  ObjectTypeSchema,
  PlaintextJsonPayloadSchema,
  Sha256HashSchema,
  VisibleMetadataSchema,
  type AccessClass,
  type AuthorityId,
  type GraphObjectEnvelope
} from "@living-atlas/contracts";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const defaultIterations = 210_000;
const localObjectAlgorithm = "AES-GCM-256+local-keyring-v1";

export const LocalKeyRecordSchema = z
  .object({
    key_id: KeyIdSchema,
    authority_id: AuthorityIdSchema,
    purpose: z.enum(["authority", "access-class", "data-encryption", "device-wrapping", "local-index"]),
    access_class: AccessClassSchema.optional(),
    algorithm: z.literal("AES-GCM-256"),
    material_base64: z.string().min(32),
    created_at: IsoTimestampSchema,
    revoked_at: IsoTimestampSchema.optional(),
    cloud_unwrapped: z.literal(false)
  })
  .strict();

export const LocalKeyringStateSchema = z
  .object({
    schema_version: z.literal(1),
    authority_id: AuthorityIdSchema,
    created_at: IsoTimestampSchema,
    updated_at: IsoTimestampSchema,
    keys: z.array(LocalKeyRecordSchema).min(1)
  })
  .strict()
  .superRefine((state, ctx) => {
    const seen = new Set<string>();
    state.keys.forEach((key, index) => {
      if (key.authority_id !== state.authority_id) {
        ctx.addIssue({
          code: "custom",
          path: ["keys", index, "authority_id"],
          message: "local key authority_id must match keyring authority"
        });
      }

      if (seen.has(key.key_id)) {
        ctx.addIssue({
          code: "custom",
          path: ["keys", index, "key_id"],
          message: "local key ids must be unique"
        });
      }
      seen.add(key.key_id);
    });
  });

export const SealedLocalKeyringEnvelopeSchema = z
  .object({
    schema_version: z.literal(1),
    authority_id: AuthorityIdSchema,
    created_at: IsoTimestampSchema,
    updated_at: IsoTimestampSchema,
    kdf: z
      .object({
        algorithm: z.literal("PBKDF2-SHA256"),
        salt_base64: z.string().min(16),
        iterations: z.number().int().min(100_000)
      })
      .strict(),
    encryption: z
      .object({
        algorithm: z.literal("AES-GCM-256"),
        iv_base64: z.string().min(16)
      })
      .strict(),
    ciphertext_base64: z.string().min(16)
  })
  .strict();

export const PlaintextGraphObjectDraftSchema = z
  .object({
    schema_version: z.literal(1),
    authority_id: AuthorityIdSchema,
    object_id: ObjectIdSchema,
    object_type: ObjectTypeSchema,
    version: z.number().int().nonnegative(),
    access_class: AccessClassSchema.default("local-private"),
    encryption_class: z.enum(["plaintext", "remote-readable", "client-encrypted", "local-only-index"]).default("plaintext"),
    created_at: IsoTimestampSchema,
    updated_at: IsoTimestampSchema,
    content_hash: Sha256HashSchema,
    key_ref: KeyIdSchema.optional(),
    visible_metadata: VisibleMetadataSchema.default({ tombstone: false, remote_indexable: false }),
    payload: GraphPayloadSchema
  })
  .strict();

export type LocalKeyRecord = z.infer<typeof LocalKeyRecordSchema>;
export type LocalKeyringState = z.infer<typeof LocalKeyringStateSchema>;
export type SealedLocalKeyringEnvelope = z.infer<typeof SealedLocalKeyringEnvelopeSchema>;
export type PlaintextGraphObjectDraft = z.infer<typeof PlaintextGraphObjectDraftSchema>;

function getCrypto(): Crypto {
  if (!globalThis.crypto?.subtle) {
    throw new Error("WebCrypto is required for the local keyring");
  }
  return globalThis.crypto;
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  getCrypto().getRandomValues(bytes);
  return bytes;
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function fromBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

function bufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function digest(value: string, length = 24): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function randomKeyId(): string {
  return KeyIdSchema.parse(`la_key_${randomUUID().replaceAll("-", "")}`);
}

function keyringAdditionalData(authorityId: string): Uint8Array {
  return textEncoder.encode(`living-atlas-local-keyring:v1:${authorityId}`);
}

function objectAdditionalData(input: {
  authorityId: string;
  objectId: string;
  objectType: string;
  version: number;
  accessClass: string;
  encryptionClass: string;
  keyId: string;
  createdAt: string;
  updatedAt: string;
  visibleMetadata: unknown;
}): Uint8Array {
  return textEncoder.encode([
    "living-atlas-object-payload:v1",
    input.authorityId,
    input.objectId,
    input.objectType,
    String(input.version),
    input.accessClass,
    input.encryptionClass,
    input.keyId,
    input.createdAt,
    input.updatedAt,
    stableJson(input.visibleMetadata)
  ].join(":"));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

async function importAesKey(material: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  return getCrypto().subtle.importKey(
    "raw",
    bufferSource(material),
    { name: "AES-GCM", length: 256 },
    false,
    usages
  );
}

async function deriveWrappingKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const keyMaterial = await getCrypto().subtle.importKey(
    "raw",
    textEncoder.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return getCrypto().subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: bufferSource(salt),
      iterations
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export function createDefaultLocalKeyring(options: {
  authorityId: AuthorityId;
  createdAt?: string;
  accessClasses?: AccessClass[];
}): LocalKeyringState {
  const createdAt = IsoTimestampSchema.parse(options.createdAt ?? new Date().toISOString());
  const accessClasses = options.accessClasses ?? ["local-private", "quarantine", "remote-safe", "shareable", "release"];
  return LocalKeyringStateSchema.parse({
    schema_version: 1,
    authority_id: options.authorityId,
    created_at: createdAt,
    updated_at: createdAt,
    keys: accessClasses.map((accessClass) => ({
      key_id: randomKeyId(),
      authority_id: options.authorityId,
      purpose: "access-class",
      access_class: accessClass,
      algorithm: "AES-GCM-256",
      material_base64: toBase64(randomBytes(32)),
      created_at: createdAt,
      cloud_unwrapped: false
    }))
  });
}

export async function sealLocalKeyring(
  stateInput: LocalKeyringState,
  passphrase: string,
  options: { iterations?: number; salt?: Uint8Array; iv?: Uint8Array } = {}
): Promise<SealedLocalKeyringEnvelope> {
  const state = LocalKeyringStateSchema.parse(stateInput);
  const salt = options.salt ?? randomBytes(16);
  const iv = options.iv ?? randomBytes(12);
  const iterations = options.iterations ?? defaultIterations;
  const key = await deriveWrappingKey(passphrase, salt, iterations);
  const ciphertext = await getCrypto().subtle.encrypt(
    {
      name: "AES-GCM",
      iv: bufferSource(iv),
      additionalData: bufferSource(keyringAdditionalData(state.authority_id))
    },
    key,
    bufferSource(textEncoder.encode(JSON.stringify(state)))
  );

  return SealedLocalKeyringEnvelopeSchema.parse({
    schema_version: 1,
    authority_id: state.authority_id,
    created_at: state.created_at,
    updated_at: state.updated_at,
    kdf: {
      algorithm: "PBKDF2-SHA256",
      salt_base64: toBase64(salt),
      iterations
    },
    encryption: {
      algorithm: "AES-GCM-256",
      iv_base64: toBase64(iv)
    },
    ciphertext_base64: toBase64(new Uint8Array(ciphertext))
  });
}

export async function openLocalKeyring(envelopeInput: unknown, passphrase: string): Promise<LocalKeyringState> {
  const envelope = SealedLocalKeyringEnvelopeSchema.parse(envelopeInput);
  const key = await deriveWrappingKey(passphrase, fromBase64(envelope.kdf.salt_base64), envelope.kdf.iterations);
  const plaintext = await getCrypto().subtle.decrypt(
    {
      name: "AES-GCM",
      iv: bufferSource(fromBase64(envelope.encryption.iv_base64)),
      additionalData: bufferSource(keyringAdditionalData(envelope.authority_id))
    },
    key,
    bufferSource(fromBase64(envelope.ciphertext_base64))
  );

  return LocalKeyringStateSchema.parse(JSON.parse(textDecoder.decode(plaintext)));
}

function keyMatchesObject(key: LocalKeyRecord, object: Pick<PlaintextGraphObjectDraft, "access_class">): boolean {
  return key.purpose === "access-class" && key.access_class === object.access_class && !key.revoked_at;
}

function keyForObject(keyring: LocalKeyringState, object: Pick<PlaintextGraphObjectDraft, "authority_id" | "access_class" | "key_ref">): LocalKeyRecord {
  if (keyring.authority_id !== object.authority_id) {
    throw new Error("local keyring authority does not match object authority");
  }

  const key = object.key_ref
    ? keyring.keys.find((candidate) => candidate.key_id === object.key_ref && keyMatchesObject(candidate, object))
    : keyring.keys.find((candidate) => keyMatchesObject(candidate, object));

  if (!key) {
    throw new Error(`no active local key for ${object.access_class}`);
  }
  return key;
}

export async function encryptGraphObjectPayload(input: GraphObjectEnvelope, keyring: LocalKeyringState): Promise<GraphObjectEnvelope> {
  const parsed = GraphObjectEnvelopeSchema.parse(input);
  if (parsed.payload.kind !== "plaintext-json") {
    return GraphObjectEnvelopeSchema.parse(structuredClone(parsed));
  }

  return encryptPlaintextGraphObjectDraft(parsed, keyring);
}

export async function encryptPlaintextGraphObjectDraft(input: unknown, keyring: LocalKeyringState): Promise<GraphObjectEnvelope> {
  const draft = PlaintextGraphObjectDraftSchema.parse(input);
  if (draft.payload.kind !== "plaintext-json") {
    return GraphObjectEnvelopeSchema.parse(draft);
  }

  const key = keyForObject(keyring, draft);
  const iv = randomBytes(12);
  const cryptoKey = await importAesKey(fromBase64(key.material_base64), ["encrypt"]);
  const plaintext = JSON.stringify(draft.payload);
  const encryptedDraft = {
    ...draft,
    encryption_class: "client-encrypted",
    key_ref: key.key_id
  } satisfies PlaintextGraphObjectDraft;
  const ciphertext = await getCrypto().subtle.encrypt(
    {
      name: "AES-GCM",
      iv: bufferSource(iv),
      additionalData: bufferSource(objectAdditionalData({
        authorityId: encryptedDraft.authority_id,
        objectId: encryptedDraft.object_id,
        objectType: encryptedDraft.object_type,
        version: encryptedDraft.version,
        accessClass: encryptedDraft.access_class,
        encryptionClass: encryptedDraft.encryption_class,
        keyId: encryptedDraft.key_ref,
        createdAt: encryptedDraft.created_at,
        updatedAt: encryptedDraft.updated_at,
        visibleMetadata: encryptedDraft.visible_metadata
      }))
    },
    cryptoKey,
    bufferSource(textEncoder.encode(plaintext))
  );
  const ciphertextBase64 = toBase64(new Uint8Array(ciphertext));

  return GraphObjectEnvelopeSchema.parse({
    ...encryptedDraft,
    content_hash: sha256(ciphertextBase64),
    payload: {
      kind: "ciphertext-inline",
      ciphertext: ciphertextBase64,
      nonce: toBase64(iv),
      algorithm: localObjectAlgorithm
    }
  });
}

export async function decryptGraphObjectPayload(input: GraphObjectEnvelope, keyring: LocalKeyringState): Promise<PlaintextGraphObjectDraft["payload"] | undefined> {
  const object = GraphObjectEnvelopeSchema.parse(input);
  if (object.payload.kind === "plaintext-json") {
    return object.payload;
  }

  if (object.payload.kind !== "ciphertext-inline" || object.payload.algorithm !== localObjectAlgorithm) {
    return undefined;
  }

  if (!object.key_ref) {
    throw new Error(`encrypted object ${object.object_id} is missing key_ref`);
  }

  const key = keyForObject(keyring, object);
  const cryptoKey = await importAesKey(fromBase64(key.material_base64), ["decrypt"]);
  const plaintext = await getCrypto().subtle.decrypt(
    {
      name: "AES-GCM",
      iv: bufferSource(fromBase64(object.payload.nonce)),
      additionalData: bufferSource(objectAdditionalData({
        authorityId: object.authority_id,
        objectId: object.object_id,
        objectType: object.object_type,
        version: object.version,
        accessClass: object.access_class,
        encryptionClass: object.encryption_class,
        keyId: object.key_ref,
        createdAt: object.created_at,
        updatedAt: object.updated_at,
        visibleMetadata: object.visible_metadata
      }))
    },
    cryptoKey,
    bufferSource(fromBase64(object.payload.ciphertext))
  );

  return PlaintextJsonPayloadSchema.parse(JSON.parse(textDecoder.decode(plaintext)));
}

export class FileLocalKeyringStore {
  constructor(private readonly filePath: string) {}

  async read(passphrase: string): Promise<LocalKeyringState> {
    return openLocalKeyring(JSON.parse(await readFile(this.filePath, "utf8")), passphrase);
  }

  async write(state: LocalKeyringState, passphrase: string): Promise<SealedLocalKeyringEnvelope> {
    const envelope = await sealLocalKeyring(state, passphrase);
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tmpPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmpPath, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });
    await rename(tmpPath, this.filePath);
    return envelope;
  }
}
