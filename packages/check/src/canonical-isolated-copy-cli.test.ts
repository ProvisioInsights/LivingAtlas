import { describe, expect, it } from "vitest";
import { readCanonicalIsolatedCopyConfig } from "./canonical-isolated-copy-cli";

describe("canonical isolated-copy CLI", () => {
  it("requires explicit isolation acknowledgement and private conversion inputs", () => {
    expect(() => readCanonicalIsolatedCopyConfig({})).toThrow("missing LIVING_ATLAS_CANONICAL_ISOLATED_COPY_ACK");
    expect(readCanonicalIsolatedCopyConfig({
      LIVING_ATLAS_CANONICAL_ISOLATED_COPY_ACK: "run-canonical-isolated-copy",
      LIVING_ATLAS_CANONICAL_COPY_DIR: " /private/candidate/.atlas-isolated-copy ",
      LIVING_ATLAS_CANONICAL_SOURCE_DIR: " /private/source ",
      LIVING_ATLAS_CANONICAL_AUTHORITY_ID: "la_authority_fixture0001",
      LIVING_ATLAS_CANONICAL_KEYRING_PASSPHRASE: "synthetic-passphrase",
      LIVING_ATLAS_CANONICAL_PATH_REDACTION_SECRET: "synthetic-redaction-secret"
    })).toMatchObject({
      copy_dir: "/private/candidate/.atlas-isolated-copy",
      source_dir: "/private/source",
      acknowledgement: "run-canonical-isolated-copy",
      source_kind: "logseq",
      source_mode: "logseq-notes"
    });
  });
});
