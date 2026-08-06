import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateContract, serialize } from "./generate.js";
import { CONTRACT_REVISION } from "./revision.js";
import { schemaDirectory } from "./manifest.js";

/**
 * Write the published documents for the current revision.
 *
 * The emitted bytes are committed to the repository, and that is the point: the
 * published contract has to be reviewable in a diff. A schema that only ever
 * exists at runtime cannot be inspected before it ships, and nobody can tell
 * whether a change was additive by reading the code that produced it.
 *
 * A test regenerates in memory and compares against the committed files, so
 * running this is never required to keep the tree honest — it only ever writes
 * what the test would otherwise reject.
 */
export function writeContract(packageRoot: string): string[] {
  const { manifest, documents } = generateContract();
  const directory = schemaDirectory(packageRoot, CONTRACT_REVISION);
  const written: string[] = [];

  for (const document of documents) {
    const target = join(directory, document.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, serialize(document.schema), "utf8");
    written.push(document.path);
  }

  const manifestPath = join(directory, "manifest.json");
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, serialize(manifest), "utf8");
  written.push("manifest.json");

  return written;
}

export function packageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const written = writeContract(packageRoot());
  process.stdout.write(`wrote ${written.length} documents to schema/${CONTRACT_REVISION}\n`);
}
