import {
  createDefaultLocalKeyring,
  encryptPlaintextGraphObjectDraft
} from "@living-atlas/local-keyring";
import { describe, expect, it } from "vitest";

import { runLocalDecryptCoverage } from "./local-decrypt-coverage";

const now = "2026-07-03T12:00:00.000Z";
const authorityId = "la_authority_coverage0001";

async function coveredObject(keyring: ReturnType<typeof createDefaultLocalKeyring>, objectId: string) {
  return encryptPlaintextGraphObjectDraft({
    schema_version: 1,
    authority_id: authorityId,
    object_id: objectId,
    object_type: "page",
    version: 1,
    access_class: "local-private",
    encryption_class: "plaintext",
    created_at: now,
    updated_at: now,
    content_hash: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    payload: {
      kind: "plaintext-json",
      data: { title: "synthetic coverage page" }
    }
  }, keyring);
}

describe("runLocalDecryptCoverage", () => {
  it("passes when every ciphertext object resolves to a keyring key and decrypts", async () => {
    const keyring = createDefaultLocalKeyring({ authorityId, createdAt: now });
    const objects = [
      await coveredObject(keyring, "la_object_coverage0001"),
      await coveredObject(keyring, "la_object_coverage0002")
    ];

    const result = await runLocalDecryptCoverage({ keyring, objects });

    expect(result).toMatchObject({
      report_schema: "living-atlas-local-decrypt-coverage:v1",
      plaintext_policy: "counts-and-refs-only",
      total_objects: 2,
      ciphertext_objects: 2,
      covered_objects: 2,
      uncovered_objects: 0,
      sampled_decrypt_failures: 0,
      complete: true
    });
    expect(result.sampled_decrypts).toBeGreaterThan(0);
  });

  it("fails and aggregates orphaned key_refs when ciphertext cannot be attributed to the keyring", async () => {
    const keyring = createDefaultLocalKeyring({ authorityId, createdAt: now });
    const orphan = {
      ...(await coveredObject(keyring, "la_object_coverage0003")),
      key_ref: "la_key_logseqsem0123456789abcd"
    };
    const objects = [await coveredObject(keyring, "la_object_coverage0004"), orphan];

    const result = await runLocalDecryptCoverage({ keyring, objects });

    expect(result.complete).toBe(false);
    expect(result.covered_objects).toBe(1);
    expect(result.uncovered_objects).toBe(1);
    expect(Object.keys(result.uncovered_key_ref_prefixes)).toEqual(["la_key_logseqsem*"]);
    expect(result.uncovered_key_ref_prefixes["la_key_logseqsem*"]).toBe(1);
  });

  it("fails when a covered key_ref exists but the ciphertext does not decrypt under it", async () => {
    const keyring = createDefaultLocalKeyring({ authorityId, createdAt: now });
    const good = await coveredObject(keyring, "la_object_coverage0005");
    const corrupted = {
      ...good,
      object_id: "la_object_coverage0006",
      payload: {
        ...good.payload,
        ciphertext: Buffer.from("garbage-ciphertext-bytes").toString("base64")
      }
    };

    const result = await runLocalDecryptCoverage({ keyring, objects: [good, corrupted] });

    expect(result.complete).toBe(false);
    expect(result.sampled_decrypt_failures).toBeGreaterThan(0);
  });
});
