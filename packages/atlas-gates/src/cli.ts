#!/usr/bin/env tsx
import { mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { dirname } from "node:path";
import { CONTRACT_REVISION } from "@living-atlas/atlas-contract";
import { baselinePath, generateBaseline, loadPublishedContract, serializeBaseline } from "./baseline.js";
import { stableJson } from "./canonical.js";
import { captureConsumerCases } from "./consumer-fixture.js";
import { corpusFileFor, corpusPath, replayCorpus, serializeCorpus } from "./gate-corpus.js";
import { goldenPath, goldenRecordFor } from "./gate-golden.js";
import { freezeUnseenRevisions, lockPath, serializeLock } from "./gate-immutable-revisions.js";
import { formatReport, runAllGates } from "./run.js";
import { repoRoot } from "./sources.js";

/**
 * `npm run gates` checks; the `--write-*` flags record.
 *
 * Checking and recording are separate commands and always will be. A gate that
 * silently re-records what it was supposed to be checking is a gate that reports
 * whatever it was given — which is how a golden suite becomes a very expensive
 * way of asserting `true`.
 *
 * `--freeze-revision` only ever ADDS a revision the lock has never seen. There
 * is no flag that unfreezes one, because the tool that could unfreeze a released
 * revision would be the tool somebody reaches for at 6pm on a Friday.
 */

function write(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf8");
  process.stdout.write(`wrote ${path}\n`);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const root = repoRoot();
  const flags = new Set(argv);
  let wrote = false;

  if (flags.has("--write-baseline")) {
    const contract = loadPublishedContract(CONTRACT_REVISION, root);
    write(
      baselinePath(CONTRACT_REVISION, root),
      serializeBaseline(generateBaseline(contract, `schema/${CONTRACT_REVISION}`))
    );
    wrote = true;
  }

  if (flags.has("--write-goldens")) {
    const capture = await captureConsumerCases();
    for (const recorded of capture.cases) {
      write(goldenPath(recorded.caseName, root), stableJson(goldenRecordFor(recorded)));
    }
    wrote = true;
  }

  if (flags.has("--write-corpus")) {
    write(corpusPath(root), serializeCorpus(corpusFileFor(await replayCorpus())));
    wrote = true;
  }

  if (flags.has("--freeze-revision")) {
    const { lock, added } = freezeUnseenRevisions(root);
    if (added.length === 0) {
      process.stdout.write("no unfrozen revision directories; nothing to freeze\n");
    } else {
      write(lockPath(root), serializeLock(lock));
      process.stdout.write(`froze ${added.join(", ")}\n`);
    }
    wrote = true;
  }

  if (wrote && !flags.has("--check")) {
    process.stdout.write("recording done; run `npm run gates` to check\n");
    return;
  }

  const results = await runAllGates(root);
  process.stdout.write(`${formatReport(results)}\n`);
  if (results.some((result) => !result.ok)) process.exitCode = 1;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  void main();
}
