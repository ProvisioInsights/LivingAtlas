import { CONTRACT_REVISION } from "@living-atlas/atlas-contract";
import { captureConsumerCases } from "./consumer-fixture.js";
import type { Finding } from "./finding.js";
import { loadPublishedContract } from "./baseline.js";
import { repoRoot } from "./sources.js";

/**
 * The two questions no amount of text scanning can settle: does the running
 * server advertise exactly what the contract publishes, and does every tool it
 * advertises actually answer?
 *
 * Both are asked over the wire, against the server a client would get. The
 * alternative — reading the registration table and believing it — is how a
 * surface ends up advertising thirty tools of which four route to
 * `localUnsupportedTool`. The table was right; the routing was not, and nothing
 * compared them.
 */

const UNIMPLEMENTED_CODES = /unsupported|not-implemented|unimplemented|not-supported/i;

/** JSON with sorted keys: two documents that differ only in property order are the same document. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export async function probeConsumerPlane(root = repoRoot()): Promise<Finding[]> {
  // The published bytes are read from `root` while the server is driven from the
  // package's own copy, and the two are compared. That is what makes this
  // seedable: a test points `root` at a tree whose published schema was edited
  // and the divergence is exactly what a hand-edited schema would produce.
  const contract = loadPublishedContract(CONTRACT_REVISION, root);
  const capture = await captureConsumerCases();
  const findings: Finding[] = [];

  const published: string[] = contract.manifest.tools.map((tool) => tool.name);
  const advertised = capture.advertised.map((tool) => tool.name);

  for (const name of published) {
    if (!advertised.includes(name)) {
      findings.push({
        kind: "advertised-tool-unimplemented",
        where: name,
        detail: ["published-not-served"],
        message:
          `${name} is published in manifest.json and the running server does not serve it. ` +
          "A consumer that reads the contract and calls what it names gets a method-not-found."
      });
    }
  }
  for (const name of advertised) {
    if (!published.includes(name)) {
      findings.push({
        kind: "advertised-tool-unimplemented",
        where: name,
        detail: ["served-not-published"],
        message:
          `${name} is served by this server and published by no contract document. ` +
          "A tool nobody published is a tool nobody reviewed and no consumer can validate against."
      });
    }
  }

  /**
   * The bytes, not the shape. `tools/list` must hand a client the SAME document
   * the contract package publishes on disk — not a re-serialisation, not an
   * equivalent, not a rebuild. That is the whole of "authored once": what a
   * consumer fetched and what the server validates against are one file.
   */
  for (const tool of capture.advertised) {
    const loaded = contract.tools.find((candidate) => String(candidate.name) === tool.name);
    if (!loaded) continue;
    for (const position of ["inputSchema", "outputSchema"] as const) {
      const served = canonicalJson(tool[position]);
      const onDisk = canonicalJson(loaded[position]);
      if (served !== onDisk) {
        findings.push({
          kind: "input-schema-divergence",
          where: tool.name,
          detail: [position],
          message:
            `${tool.name} advertises a ${position} that is not the published document. ` +
            "The server is rebuilding a schema the contract already publishes, so the two can " +
            "disagree and only the one nobody reads will be wrong."
        });
      }
    }
  }

  for (const recorded of capture.cases) {
    const error = recorded.raw.error;
    if (error && error.code === -32601) {
      findings.push({
        kind: "advertised-tool-unimplemented",
        where: recorded.tool,
        detail: ["method-not-found"],
        message: `${recorded.tool} is advertised and answers -32601 method-not-found.`
      });
      continue;
    }
    const structured = recorded.raw.result?.["structuredContent"] as Record<string, unknown> | undefined;
    const code = readErrorCode(structured) ?? readErrorCode(parseTextBlock(recorded.raw.result));
    if (typeof code === "string" && UNIMPLEMENTED_CODES.test(code)) {
      findings.push({
        kind: "advertised-tool-unimplemented",
        where: recorded.tool,
        detail: [code],
        message:
          `${recorded.tool} is advertised and answers with "${code}". A tool the contract advertises ` +
          "and the server cannot perform is worse than an absent tool: a consumer plans around it."
      });
    }
  }

  return findings;
}

function readErrorCode(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  if (typeof record["code"] === "string" && record["record_schema"] === "atlas.error:v1") {
    return record["code"];
  }
  const nested = record["error"];
  if (nested !== undefined) return readErrorCode(nested);
  return undefined;
}

function parseTextBlock(result: Record<string, unknown> | undefined): unknown {
  const content = result?.["content"];
  if (!Array.isArray(content)) return undefined;
  const first = content[0] as { type?: string; text?: string } | undefined;
  if (first?.type !== "text" || typeof first.text !== "string") return undefined;
  try {
    return JSON.parse(first.text) as unknown;
  } catch {
    return undefined;
  }
}
