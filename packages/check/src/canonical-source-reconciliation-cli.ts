import { pathToFileURL } from "node:url";
import { compareCanonicalSourceContent } from "./canonical-source-refresh";

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

export function readCanonicalSourceReconciliationConfig(env: Record<string, string | undefined> = process.env) {
  return {
    live_source_dir: required(env, "LIVING_ATLAS_LIVE_SOURCE_DIR"),
    prior_working_dir: required(env, "LIVING_ATLAS_PRIOR_WORKING_DIR")
  };
}

async function main(): Promise<void> {
  console.log(JSON.stringify(await compareCanonicalSourceContent(readCanonicalSourceReconciliationConfig()), null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
