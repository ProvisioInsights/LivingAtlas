import { pathToFileURL } from "node:url";
import { readCanonicalCandidateCutoverReport } from "./canonical-production-promotion";

export function readCanonicalCutoverReportConfig(env: Record<string, string | undefined> = process.env) {
  const candidateDir = env.LIVING_ATLAS_CANONICAL_CANDIDATE_DIR?.trim();
  if (!candidateDir) throw new Error("missing LIVING_ATLAS_CANONICAL_CANDIDATE_DIR");
  return { candidate_dir: candidateDir };
}

async function main(): Promise<void> {
  const report = await readCanonicalCandidateCutoverReport(readCanonicalCutoverReportConfig());
  console.log(JSON.stringify(report, null, 2));
  if (!report.ready) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
