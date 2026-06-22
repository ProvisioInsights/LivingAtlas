import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { GraphObjectEnvelope } from "@living-atlas/contracts";
import { fixtureAuthorityId, sensitiveBaitRegistry } from "@living-atlas/fixtures";
import {
  createDefaultLocalKeyring,
  decryptGraphObjectPayload,
  encryptPlaintextGraphObjectDraft,
  FileLocalKeyringStore,
  openLocalKeyring,
  sealLocalKeyring
} from "./local-keyring";

const now = "2026-06-22T12:00:00.000Z";

function fixedHash(seed: string): `sha256:${string}` {
  return `sha256:${seed.repeat(64).slice(0, 64)}`;
}

function plaintextDraft(accessClass: GraphObjectEnvelope["access_class"] = "local-private") {
  return {
    schema_version: 1,
    authority_id: fixtureAuthorityId,
    object_id: "la_object_keyringencrypt0001",
    object_type: "page",
    version: 1,
    access_class: accessClass,
    encryption_class: "plaintext",
    created_at: now,
    updated_at: now,
    content_hash: fixedHash("a"),
    visible_metadata: {
      schema_namespace: "fixture/keyring",
      tombstone: false,
      size_class: "tiny",
      remote_indexable: false
    },
    payload: {
      kind: "plaintext-json",
      data: {
        title: "Blue Orchid Salary Negotiation",
        body: "Avery North must stay local."
      }
    }
  } as const;
}

describe("local keyring", () => {
  it("seals and opens local key material without leaking keys", async () => {
    const keyring = createDefaultLocalKeyring({ authorityId: fixtureAuthorityId, createdAt: now });
    const sealed = await sealLocalKeyring(keyring, "fixture-keyring-passphrase", {
      salt: new Uint8Array(16).fill(1),
      iv: new Uint8Array(12).fill(2),
      iterations: 210_000
    });
    const serialized = JSON.stringify(sealed);

    for (const key of keyring.keys) {
      expect(serialized).not.toContain(key.material_base64);
    }
    await expect(openLocalKeyring(sealed, "fixture-keyring-passphrase")).resolves.toEqual(keyring);
    await expect(openLocalKeyring(sealed, "wrong-passphrase")).rejects.toThrow();
  });

  it("encrypts and decrypts local-private plaintext drafts with AES-GCM", async () => {
    const keyring = createDefaultLocalKeyring({ authorityId: fixtureAuthorityId, createdAt: now });
    const encrypted = await encryptPlaintextGraphObjectDraft(plaintextDraft(), keyring);

    expect(encrypted).toMatchObject({
      access_class: "local-private",
      encryption_class: "client-encrypted",
      key_ref: expect.stringMatching(/^la_key_/),
      payload: {
        kind: "ciphertext-inline",
        algorithm: "AES-GCM-256+local-keyring-v1"
      }
    });
    expect(JSON.stringify(encrypted)).not.toContain("Blue Orchid Salary Negotiation");
    expect(JSON.stringify(encrypted)).not.toContain("Avery North");

    await expect(decryptGraphObjectPayload(encrypted, keyring)).resolves.toEqual({
      kind: "plaintext-json",
      data: {
        title: "Blue Orchid Salary Negotiation",
        body: "Avery North must stay local."
      }
    });
  });

  it("rejects caller-selected keys from the wrong access class", async () => {
    const keyring = createDefaultLocalKeyring({ authorityId: fixtureAuthorityId, createdAt: now });
    const releaseKey = keyring.keys.find((key) => key.access_class === "release")!;

    await expect(encryptPlaintextGraphObjectDraft({
      ...plaintextDraft("local-private"),
      key_ref: releaseKey.key_id
    }, keyring)).rejects.toThrow("no active local key for local-private");
  });

  it("binds operational envelope metadata into AES-GCM authentication", async () => {
    const keyring = createDefaultLocalKeyring({ authorityId: fixtureAuthorityId, createdAt: now });
    const encrypted = await encryptPlaintextGraphObjectDraft(plaintextDraft(), keyring);

    await expect(decryptGraphObjectPayload({
      ...encrypted,
      visible_metadata: {
        ...encrypted.visible_metadata,
        tombstone: true
      }
    }, keyring)).rejects.toThrow();
  });

  it("generates fresh key ids for recreated local keyrings", async () => {
    const first = createDefaultLocalKeyring({ authorityId: fixtureAuthorityId, createdAt: now });
    const second = createDefaultLocalKeyring({ authorityId: fixtureAuthorityId, createdAt: now });

    expect(first.keys.map((key) => key.key_id)).not.toEqual(second.keys.map((key) => key.key_id));
  });

  it("writes sealed keyring files for local install mode", async () => {
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-keyring-"));
    try {
      const keyring = createDefaultLocalKeyring({ authorityId: fixtureAuthorityId, createdAt: now });
      const path = join(directory, "keyring.json");
      await new FileLocalKeyringStore(path).write(keyring, "fixture-keyring-passphrase");
      const content = await readFile(path, "utf8");
      expect(content).toContain("ciphertext_base64");
      for (const key of keyring.keys) {
        expect(content).not.toContain(key.material_base64);
      }
      for (const bait of sensitiveBaitRegistry) {
        expect(content).not.toContain(bait.value);
      }
      await expect(new FileLocalKeyringStore(path).read("fixture-keyring-passphrase")).resolves.toEqual(keyring);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
