import { basename, relative, resolve } from "node:path";

export const canonicalIsolatedCopyAcknowledgement = "run-canonical-isolated-copy";

export type CanonicalIsolatedCopyRun = {
  copy_dir: string;
  source_dir: string;
  acknowledgement: string;
  live_paths: string[];
};

export function validateCanonicalIsolatedCopyRun(input: CanonicalIsolatedCopyRun): Pick<CanonicalIsolatedCopyRun, "copy_dir" | "source_dir"> {
  if (input.acknowledgement !== canonicalIsolatedCopyAcknowledgement) {
    throw new Error("canonical isolated-copy acknowledgement is required");
  }
  const copyDir = resolve(input.copy_dir);
  const sourceDir = resolve(input.source_dir);
  if (basename(copyDir) !== ".atlas-isolated-copy") {
    throw new Error("canonical isolated-copy output requires the .atlas-isolated-copy marker");
  }
  if (pathsOverlap(copyDir, sourceDir)) {
    throw new Error("canonical isolated-copy source and output paths must not overlap");
  }
  for (const livePath of input.live_paths.map((path) => resolve(path))) {
    if (isWithin(copyDir, livePath) || isWithin(sourceDir, livePath)) {
      throw new Error("canonical isolated-copy path is a configured live path");
    }
  }
  return { copy_dir: copyDir, source_dir: sourceDir };
}

function pathsOverlap(left: string, right: string): boolean {
  return isWithin(left, right) || isWithin(right, left);
}

function isWithin(path: string, parent: string): boolean {
  const pathRelativeToParent = relative(parent, path);
  return pathRelativeToParent === "" || (!pathRelativeToParent.startsWith("..") && !pathRelativeToParent.startsWith("../"));
}
