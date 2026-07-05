import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_TIERING_RULESET,
  PRIVATE_TIERING_RULESET_ENV,
  classifyTier,
  loadPrivateTieringRuleset,
  mergePrivateOverlayIntoRuleset,
  type ClassifiableObject,
  type PrivateTieringOverlay
} from "./tiering";

function obj(overrides: Partial<ClassifiableObject> = {}): ClassifiableObject {
  return {
    object_id: "la_object_test0001",
    object_type: "block",
    access_class: "local-private",
    tags: [],
    entity_names: [],
    text: "",
    ...overrides
  };
}

describe("mergePrivateOverlayIntoRuleset", () => {
  it("returns the base ruleset unchanged when the overlay is empty/undefined", () => {
    const merged = mergePrivateOverlayIntoRuleset(DEFAULT_TIERING_RULESET, undefined);
    expect(merged).toEqual(DEFAULT_TIERING_RULESET);
  });

  it("merges overlay entity_names/keywords/tags into the matching rule by id", () => {
    const overlay: PrivateTieringOverlay = {
      rules: [
        {
          id: "immigration-legal",
          entity_names: ["Globex Legal", "Jane Roe"],
          keywords: ["special-visa-program"],
          tags: ["globex"]
        }
      ]
    };
    const merged = mergePrivateOverlayIntoRuleset(DEFAULT_TIERING_RULESET, overlay);
    const rule = merged.rules.find((r) => r.id === "immigration-legal")!;
    expect(rule.entity_names).toContain("Globex Legal");
    expect(rule.entity_names).toContain("Jane Roe");
    expect(rule.keywords).toContain("special-visa-program");
    expect(rule.tags).toContain("globex");
    // Base generic keywords are preserved (not replaced).
    expect(rule.keywords).toContain("immigration");
  });

  it("does not mutate the base ruleset (pure merge)", () => {
    const before = JSON.stringify(DEFAULT_TIERING_RULESET);
    mergePrivateOverlayIntoRuleset(DEFAULT_TIERING_RULESET, {
      rules: [{ id: "immigration-legal", entity_names: ["Globex Legal"] }]
    });
    expect(JSON.stringify(DEFAULT_TIERING_RULESET)).toBe(before);
  });

  it("de-duplicates merged terms", () => {
    const merged = mergePrivateOverlayIntoRuleset(DEFAULT_TIERING_RULESET, {
      rules: [{ id: "immigration-legal", keywords: ["immigration", "immigration"] }]
    });
    const rule = merged.rules.find((r) => r.id === "immigration-legal")!;
    expect(rule.keywords.filter((k) => k === "immigration")).toHaveLength(1);
  });

  it("ignores overlay entries whose id does not match any base rule (structural, no invented rules)", () => {
    const merged = mergePrivateOverlayIntoRuleset(DEFAULT_TIERING_RULESET, {
      rules: [{ id: "does-not-exist", entity_names: ["Nobody"] }]
    });
    expect(merged.rules.find((r) => r.id === "does-not-exist")).toBeUndefined();
  });

  it("makes a merged private entity classify as super-sensitive where the generic default would not", () => {
    // Generic default: a private legal firm name is NOT in the ruleset, so a bare
    // mention with no generic keyword stays cloud-unlockable.
    const bare = classifyTier(obj({ entity_names: ["Globex Legal"] }), DEFAULT_TIERING_RULESET);
    expect(bare.tier).toBe("cloud-unlockable");

    const merged = mergePrivateOverlayIntoRuleset(DEFAULT_TIERING_RULESET, {
      rules: [{ id: "immigration-legal", entity_names: ["Globex Legal"] }]
    });
    const withOverlay = classifyTier(obj({ entity_names: ["Globex Legal"] }), merged);
    expect(withOverlay.tier).toBe("super-sensitive");
    expect(withOverlay.matched_rules).toContain("immigration-legal");
  });
});

describe("loadPrivateTieringRuleset", () => {
  let dir: string;
  const originalEnv = process.env[PRIVATE_TIERING_RULESET_ENV];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "la-tiering-overlay-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (originalEnv === undefined) delete process.env[PRIVATE_TIERING_RULESET_ENV];
    else process.env[PRIVATE_TIERING_RULESET_ENV] = originalEnv;
  });

  it("returns the generic default when the overlay path (via env) is absent", () => {
    process.env[PRIVATE_TIERING_RULESET_ENV] = join(dir, "does-not-exist.json");
    const ruleset = loadPrivateTieringRuleset(DEFAULT_TIERING_RULESET);
    expect(ruleset).toEqual(DEFAULT_TIERING_RULESET);
  });

  it("loads and merges an overlay file pointed to by the env var", () => {
    const overlayPath = join(dir, "tiering-private-ruleset.json");
    const overlay: PrivateTieringOverlay = {
      rules: [{ id: "inherited-land", keywords: ["Riverton"], tags: ["riverton"] }]
    };
    writeFileSync(overlayPath, JSON.stringify(overlay), "utf8");
    process.env[PRIVATE_TIERING_RULESET_ENV] = overlayPath;

    const ruleset = loadPrivateTieringRuleset(DEFAULT_TIERING_RULESET);
    const rule = ruleset.rules.find((r) => r.id === "inherited-land")!;
    expect(rule.keywords).toContain("Riverton");
    expect(rule.tags).toContain("riverton");

    const decision = classifyTier(obj({ text: "the parcel near Riverton" }), ruleset);
    expect(decision.tier).toBe("super-sensitive");
    expect(decision.matched_rules).toContain("inherited-land");
  });

  it("returns the generic default (does not throw) on a malformed overlay file", () => {
    const overlayPath = join(dir, "tiering-private-ruleset.json");
    writeFileSync(overlayPath, "{ not valid json", "utf8");
    process.env[PRIVATE_TIERING_RULESET_ENV] = overlayPath;
    const ruleset = loadPrivateTieringRuleset(DEFAULT_TIERING_RULESET);
    expect(ruleset).toEqual(DEFAULT_TIERING_RULESET);
  });
});
