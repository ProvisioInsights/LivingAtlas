import { pathToFileURL } from "node:url";
import { canonicalIsolatedCopyAcknowledgement, runCanonicalIsolatedCopy } from "./canonical-isolated-copy-runner";

function required(env: Record<string, string | undefined>, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`missing ${key}`);
  return value;
}

export function readCanonicalIsolatedCopyConfig(env: Record<string, string | undefined> = process.env) {
  const acknowledgement = required(env, "LIVING_ATLAS_CANONICAL_ISOLATED_COPY_ACK");
  if (acknowledgement !== canonicalIsolatedCopyAcknowledgement) {
    throw new Error("canonical isolated-copy acknowledgement is required");
  }
  return {
    acknowledgement,
    copy_dir: required(env, "LIVING_ATLAS_CANONICAL_COPY_DIR"),
    source_dir: required(env, "LIVING_ATLAS_CANONICAL_SOURCE_DIR"),
    authority_id: required(env, "LIVING_ATLAS_CANONICAL_AUTHORITY_ID"),
    keyring_passphrase: required(env, "LIVING_ATLAS_CANONICAL_KEYRING_PASSPHRASE"),
    path_redaction_secret: required(env, "LIVING_ATLAS_CANONICAL_PATH_REDACTION_SECRET"),
    live_paths: (env.LIVING_ATLAS_CANONICAL_LIVE_PATHS ?? "").split(",").map((value) => value.trim()).filter(Boolean),
    source_kind: "logseq" as const,
    source_mode: "logseq-notes" as const
  };
}

async function main(): Promise<void> {
  const result = await runCanonicalIsolatedCopy(readCanonicalIsolatedCopyConfig());
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
