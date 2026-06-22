import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Buffer } from "node:buffer";
import { z } from "zod";
import {
  AuthorityIdSchema,
  IsoTimestampSchema,
  LocalControlStateSchema,
  type LocalControlState
} from "@living-atlas/contracts";

export const LocalControlStoreEnvelopeSchema = z
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

export type LocalControlStoreEnvelope = z.infer<typeof LocalControlStoreEnvelopeSchema>;

export type SealLocalControlStateOptions = {
  iterations?: number;
  salt?: Uint8Array;
  iv?: Uint8Array;
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const defaultIterations = 210_000;

function getCrypto(): Crypto {
  if (!globalThis.crypto?.subtle) {
    throw new Error("WebCrypto is required for the local control store");
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

function additionalData(authorityId: string): Uint8Array {
  return textEncoder.encode(`living-atlas-local-control-store:v1:${authorityId}`);
}

async function deriveAesKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const crypto = getCrypto();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: bufferSource(salt),
      iterations
    },
    keyMaterial,
    {
      name: "AES-GCM",
      length: 256
    },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function sealLocalControlState(
  state: LocalControlState,
  passphrase: string,
  options: SealLocalControlStateOptions = {}
): Promise<LocalControlStoreEnvelope> {
  const parsedState = LocalControlStateSchema.parse(state);
  const iterations = options.iterations ?? defaultIterations;
  const salt = options.salt ?? randomBytes(16);
  const iv = options.iv ?? randomBytes(12);
  const key = await deriveAesKey(passphrase, salt, iterations);
  const plaintext = textEncoder.encode(JSON.stringify(parsedState));
  const ciphertext = await getCrypto().subtle.encrypt(
    {
      name: "AES-GCM",
      iv: bufferSource(iv),
      additionalData: bufferSource(additionalData(parsedState.authority_id))
    },
    key,
    bufferSource(plaintext)
  );

  return LocalControlStoreEnvelopeSchema.parse({
    schema_version: 1,
    authority_id: parsedState.authority_id,
    created_at: parsedState.created_at,
    updated_at: parsedState.updated_at,
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

export async function openLocalControlState(
  envelopeInput: unknown,
  passphrase: string
): Promise<LocalControlState> {
  const envelope = LocalControlStoreEnvelopeSchema.parse(envelopeInput);
  const key = await deriveAesKey(passphrase, fromBase64(envelope.kdf.salt_base64), envelope.kdf.iterations);
  const plaintext = await getCrypto().subtle.decrypt(
    {
      name: "AES-GCM",
      iv: bufferSource(fromBase64(envelope.encryption.iv_base64)),
      additionalData: bufferSource(additionalData(envelope.authority_id))
    },
    key,
    bufferSource(fromBase64(envelope.ciphertext_base64))
  );

  return LocalControlStateSchema.parse(JSON.parse(textDecoder.decode(plaintext)));
}

export class FileLocalControlStore {
  constructor(private readonly filePath: string) {}

  async read(passphrase: string): Promise<LocalControlState> {
    const content = await readFile(this.filePath, "utf8");
    return openLocalControlState(JSON.parse(content), passphrase);
  }

  async write(state: LocalControlState, passphrase: string): Promise<LocalControlStoreEnvelope> {
    const envelope = await sealLocalControlState(state, passphrase);
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmpPath, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });
    await rename(tmpPath, this.filePath);
    return envelope;
  }
}
