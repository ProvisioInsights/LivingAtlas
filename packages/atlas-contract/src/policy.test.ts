import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadContract, schemaDirectory } from "./manifest.js";
import { CONTRACT_LIMITS, CONTRACT_POLICY_DOCUMENT, CONTRACT_REVISION } from "./revision.js";
import { packageRoot } from "./write-schemas.js";
import type { JsonSchema } from "./shape.js";

/**
 * The policy document is normative for semantics, which makes it exactly as
 * capable of drifting as the schemas are — and harder to notice, because prose
 * does not fail to compile.
 *
 * These tests hold it to the same standard as the schemas: every normative
 * requirement carries a tag, every tag has an owner, every owner that claims to
 * be a test IS one, and the numbers the document quotes are the numbers the
 * contract publishes.
 */

const REPO_ROOT = join(packageRoot(), "..", "..");
const DOCUMENT = join(REPO_ROOT, CONTRACT_POLICY_DOCUMENT);
const text = readFileSync(DOCUMENT, "utf8");
const [body = "", register = ""] = splitAtRegister(text);
const contract = loadContract(schemaDirectory(packageRoot(), CONTRACT_REVISION));

function splitAtRegister(document: string): [string, string] {
  const marker = "## 13. Requirement register";
  const index = document.indexOf(marker);
  if (index < 0) throw new Error("the policy document has no requirement register");
  return [document.slice(0, index), document.slice(index)];
}

type RegisterRow = { id: string; requirement: string; verifiedBy: string };

function registerRows(): RegisterRow[] {
  const rows: RegisterRow[] = [];
  for (const line of register.split("\n")) {
    const match = /^\|\s*(C-\d+)\s*\|([^|]*)\|(.*)\|\s*$/.exec(line);
    if (!match) continue;
    const [, id = "", requirement = "", verifiedBy = ""] = match;
    rows.push({ id, requirement: requirement.trim(), verifiedBy: verifiedBy.trim() });
  }
  return rows;
}

const rows = registerRows();

describe("the policy document's normative requirements", () => {
  it("registers a meaningful number of them", () => {
    expect(rows.length).toBeGreaterThanOrEqual(30);
  });

  it("tags every bolded MUST and MUST NOT with a requirement id", () => {
    // An untagged MUST is a promise with no owner and no test — which is how a
    // contract accumulates obligations nobody implements and nobody notices.
    const offenders: string[] = [];
    body.split("\n").forEach((line, index) => {
      if (!/\*\*MUST(?: NOT)?\*\*/.test(line)) return;
      if (/\[C-\d+\]/.test(line)) return;
      offenders.push(`line ${index + 1}: ${line.trim()}`);
    });
    expect(offenders).toEqual([]);
  });

  it("registers every tag the body uses, exactly once", () => {
    const used = new Set([...body.matchAll(/\[(C-\d+)\]/g)].map((match) => match[1] ?? ""));
    const registered = rows.map((row) => row.id);
    expect(new Set(registered).size).toBe(registered.length);
    for (const tag of [...used].sort()) {
      expect(`${tag} registered: ${registered.includes(tag)}`).toBe(`${tag} registered: true`);
    }
  });

  it("uses every tag it registers, so no requirement lives only in the table", () => {
    const used = new Set([...body.matchAll(/\[(C-\d+)\]/g)].map((match) => match[1] ?? ""));
    for (const row of rows) {
      expect(`${row.id} used in the body: ${used.has(row.id)}`).toBe(`${row.id} used in the body: true`);
    }
  });

  it("names a real, existing test for every requirement that claims one", () => {
    // The link-check that matters. A register citing a test title that does not
    // exist is worse than no register: it reads as coverage.
    for (const row of rows) {
      if (row.verifiedBy.includes("**pending**")) continue;
      const file = /`([^`]+\.test\.ts)`/.exec(row.verifiedBy)?.[1];
      const title = /›\s*"([^"]+)"/.exec(row.verifiedBy)?.[1];
      expect(`${row.id} cites a file: ${file !== undefined}`).toBe(`${row.id} cites a file: true`);
      expect(`${row.id} cites a title: ${title !== undefined}`).toBe(`${row.id} cites a title: true`);
      if (!file || !title) continue;

      const path = join(REPO_ROOT, file);
      expect(`${row.id} file exists (${file}): ${existsSync(path)}`).toBe(`${row.id} file exists (${file}): true`);
      const source = readFileSync(path, "utf8");
      expect(`${row.id} ${file} defines "${title}": ${source.includes(`"${title}"`)}`).toBe(
        `${row.id} ${file} defines "${title}": true`
      );
    }
  });

  it("names an owning work unit for every requirement that is not yet testable", () => {
    // "Pending" is an acceptable answer. "Pending, owned by nobody" is not: it
    // is how a specified guarantee quietly fails to get built.
    const pending = rows.filter((row) => row.verifiedBy.includes("**pending**"));
    expect(pending.length).toBeGreaterThan(0);
    for (const row of pending) {
      expect(`${row.id} names a work unit: ${/W\d\d/.test(row.verifiedBy)}`).toBe(
        `${row.id} names a work unit: true`
      );
    }
  });
});

describe("the policy document agrees with the published contract", () => {
  it("is the document the contract says it is", () => {
    expect(contract.manifest.policy_document).toBe(CONTRACT_POLICY_DOCUMENT);
    expect(existsSync(DOCUMENT)).toBe(true);
    expect(text).toContain(`revision ${CONTRACT_REVISION}`);
    expect(text).toContain(contract.manifest.protocol_version);
  });

  it("quotes the published limits, number for number", () => {
    // A document quoting a cap the schema does not enforce is how a caller ends
    // up designing to a limit that was never real.
    const quoted = new Map<string, number>();
    for (const line of text.split("\n")) {
      const match = /^\|\s*`([a-z_]+)`\s*\|\s*(\d+)\s*\|\s*$/.exec(line);
      if (match?.[1] && match[2]) quoted.set(match[1], Number(match[2]));
    }
    for (const [name, value] of Object.entries(CONTRACT_LIMITS)) {
      expect(`${name}: ${quoted.get(name)}`).toBe(`${name}: ${value}`);
    }
    expect(quoted.size).toBe(Object.keys(CONTRACT_LIMITS).length);
  });

  it("publishes a deprecation window at least as long as the change-feed floor", () => {
    // Atlas promises a consumer offline for change_feed_floor_days can resume
    // from its cursor. A shorter deprecation window makes that promise hollow:
    // the consumer resumes successfully into a surface where its tool is gone.
    expect(CONTRACT_LIMITS.deprecation_window_days).toBeGreaterThanOrEqual(CONTRACT_LIMITS.change_feed_floor_days);
    expect(contract.manifest.limits.deprecation_window_days).toBe(CONTRACT_LIMITS.deprecation_window_days);
    expect(text).toContain("`removal_not_before` **MUST** [C-27] be at least `deprecation_window_days`");
  });

  it("carries a machine-readable deprecation surface even when nothing is deprecated", () => {
    // An empty list is a real answer. A changelog is not an announcement: a
    // consumer cannot poll a changelog.
    expect(contract.manifest.deprecations).toEqual([]);
    for (const tool of contract.tools) expect(tool.deprecation).toBeNull();

    const describeOutput = contract.tools.find((tool) => tool.name === "atlas.contract.describe.v1")?.outputSchema;
    const properties = (describeOutput?.["properties"] ?? {}) as Record<string, JsonSchema>;
    expect(describeOutput?.["required"]).toContain("deprecations");
    const notice = (properties["deprecations"]?.["items"] ?? {}) as JsonSchema;
    expect(notice["required"]).toEqual(
      expect.arrayContaining(["target_kind", "target", "announced_at", "removal_not_before", "reason"])
    );
  });

  it("tells consumers in the schema itself never to parse an error message", () => {
    const error = contract.records["urn:living-atlas:contract:2026.08.0:record:atlas.error:v1"];
    const properties = (error?.["properties"] ?? {}) as Record<string, JsonSchema>;
    expect(String(properties["message"]?.["description"])).toMatch(/never parse it.*branch on `code`/i);
    expect(error?.["required"]).toContain("code");
  });

  it("names every tool it publishes, and publishes every tool it names", () => {
    for (const tool of contract.tools) {
      expect(`${tool.name} documented: ${text.includes(tool.name)}`).toBe(`${tool.name} documented: true`);
    }
    const mentioned = new Set([...text.matchAll(/atlas\.[a-z.]+\.v1/g)].map((match) => match[0]));
    const published = new Set<string>(contract.tools.map((tool) => tool.name));
    for (const name of mentioned) {
      expect(`${name} published: ${published.has(name)}`).toBe(`${name} published: true`);
    }
  });

  it("marks open questions as open rather than deciding them in passing", () => {
    const open = [...register.matchAll(/\*\*OPEN-\d+\*\*/g)];
    const openInBody = [...body.matchAll(/\*\*OPEN-(\d+)\*\*/g)].map((match) => match[1]);
    expect(open).toHaveLength(0);
    expect(openInBody.length).toBeGreaterThanOrEqual(5);
    // Each one is referenced from the section it affects, so a reader meeting
    // the ambiguity is told it is unresolved at the point of use.
    expect(body).toContain("is **OPEN** —");
  });
});
