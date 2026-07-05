import { describe, expect, it } from "vitest";
import {
  DEFAULT_TIERING_RULESET,
  classifyTier,
  extractClassifiableText,
  mergePrivateOverlayIntoRuleset,
  type ClassifiableObject,
  type TieringRuleset
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

// A FICTIONAL sample overlay used to exercise the entity-name matching paths
// that, in a real deployment, an operator supplies privately. No real specifics
// live in this public test file.
const SAMPLE_OVERLAY = {
  rules: [
    {
      id: "immigration-legal",
      entity_names: ["Globex Legal", "Jane Roe"],
      keywords: ["Riverton Reacquisition"]
    },
    {
      id: "inherited-land",
      keywords: ["Riverton", "Northshire"],
      tags: ["riverton"]
    },
    {
      id: "immediate-family-private",
      entity_names: ["Sample Person A", "Sample Person B"],
      tags: ["person-a-private", "person-b-private"]
    }
  ]
};

const RULESET_WITH_OVERLAY: TieringRuleset = mergePrivateOverlayIntoRuleset(DEFAULT_TIERING_RULESET, SAMPLE_OVERLAY);

describe("classifyTier (DEFAULT_TIERING_RULESET)", () => {
  it("defaults to cloud-unlockable when nothing sensitive matches", () => {
    const decision = classifyTier(obj({ text: "notes about a public conference talk" }), DEFAULT_TIERING_RULESET);
    expect(decision.tier).toBe("cloud-unlockable");
    expect(decision.matched_rules).toEqual([]);
  });

  it("keeps immigration/legal content local-only via a merged private entity (Globex Legal)", () => {
    const decision = classifyTier(
      obj({ entity_names: ["Globex Legal"], text: "immigration case update" }),
      RULESET_WITH_OVERLAY
    );
    expect(decision.tier).toBe("super-sensitive");
    expect(decision.matched_rules).toContain("immigration-legal");
  });

  it("keeps citizenship/visa keywords local-only (generic, no overlay needed)", () => {
    const decision = classifyTier(obj({ text: "German citizenship reacquisition + visa timeline" }), DEFAULT_TIERING_RULESET);
    expect(decision.tier).toBe("super-sensitive");
    expect(decision.matched_rules).toContain("immigration-legal");
  });

  it("keeps a merged private immigration contact (Jane Roe) local-only", () => {
    const decision = classifyTier(obj({ entity_names: ["Jane Roe"] }), RULESET_WITH_OVERLAY);
    expect(decision.tier).toBe("super-sensitive");
    expect(decision.matched_rules).toContain("immigration-legal");
  });

  it("keeps a merged private inherited-land place term (Riverton) local-only", () => {
    const decision = classifyTier(obj({ text: "the inherited Naturschutzgebiet near Riverton, Northshire" }), RULESET_WITH_OVERLAY);
    expect(decision.tier).toBe("super-sensitive");
    expect(decision.matched_rules).toContain("inherited-land");
  });

  it("keeps generic inherited-land signal local-only without any overlay", () => {
    const decision = classifyTier(obj({ text: "the inherited property, a protected nature reserve" }), DEFAULT_TIERING_RULESET);
    expect(decision.tier).toBe("super-sensitive");
    expect(decision.matched_rules).toContain("inherited-land");
  });

  it("keeps health/medical content local-only", () => {
    const decision = classifyTier(obj({ tags: ["medical"], text: "diagnosis and prescription" }), DEFAULT_TIERING_RULESET);
    expect(decision.tier).toBe("super-sensitive");
    expect(decision.matched_rules).toContain("health-medical");
  });

  it("keeps security-clearance work local-only", () => {
    const decision = classifyTier(obj({ text: "security clearance paperwork for gov work" }), DEFAULT_TIERING_RULESET);
    expect(decision.tier).toBe("super-sensitive");
    expect(decision.matched_rules).toContain("security-clearance");
  });

  it("keeps immediate-family private personal details local-only via merged private entities", () => {
    const personA = classifyTier(obj({ tags: ["family-private"], entity_names: ["Sample Person A"] }), RULESET_WITH_OVERLAY);
    expect(personA.tier).toBe("super-sensitive");
    expect(personA.matched_rules).toContain("immediate-family-private");
  });

  it("keeps immediate-family private details local-only via the generic family-private tag", () => {
    const decision = classifyTier(obj({ tags: ["family-private"] }), DEFAULT_TIERING_RULESET);
    expect(decision.tier).toBe("super-sensitive");
    expect(decision.matched_rules).toContain("immediate-family-private");
  });

  it("does NOT flag most family content — only private personal details", () => {
    // Policy: most family is cloud-unlockable. A plain mention with no private-detail
    // signal and no family-private tag stays default.
    const decision = classifyTier(obj({ text: "had lunch with the family on Saturday" }), DEFAULT_TIERING_RULESET);
    expect(decision.tier).toBe("cloud-unlockable");
  });

  it("is word-boundary aware: 'visach' must not match 'visa'", () => {
    const decision = classifyTier(obj({ text: "the visach product roadmap" }), DEFAULT_TIERING_RULESET);
    expect(decision.matched_rules).not.toContain("immigration-legal");
    expect(decision.tier).toBe("cloud-unlockable");
  });

  // DEF-1 hunt residue: real bodies use inflected forms — "hospitalized",
  // "clearances", "green cards", "medications". A plain word-boundary match
  // missed all of these, leaving 16 genuinely-sensitive objects cloud-unlockable.
  it("matches common trailing inflections (plural/-ed/-ing) of keywords", () => {
    for (const [text, rule] of [
      ["mother was hospitalized last week", "health-medical"],
      ["national security clearances practice", "security-clearance"],
      ["so the family could get green cards", "immigration-legal"],
      ["refilled her medications", "health-medical"]
    ] as const) {
      const decision = classifyTier(obj({ text }), DEFAULT_TIERING_RULESET);
      expect(decision.tier, `"${text}" should be super-sensitive`).toBe("super-sensitive");
      expect(decision.matched_rules).toContain(rule);
    }
  });

  it("does NOT let inflection tolerance leak past a real word boundary ('visasq' must not match 'visa')", () => {
    const decision = classifyTier(obj({ text: "coleman/visasq expert network" }), DEFAULT_TIERING_RULESET);
    expect(decision.matched_rules).not.toContain("immigration-legal");
    expect(decision.tier).toBe("cloud-unlockable");
  });

  it("does NOT match 'hospitality' as 'hospital' (inflection allowlist is bounded)", () => {
    const decision = classifyTier(obj({ text: "cybersecurity hospitality track" }), DEFAULT_TIERING_RULESET);
    expect(decision.matched_rules).not.toContain("health-medical");
    expect(decision.tier).toBe("cloud-unlockable");
  });

  // DEF-1b: an entity-name rule term (supplied privately via the overlay) that
  // appears in a block's/edge's FREE TEXT — not the endpoint entity_names field —
  // must still match.
  it("matches entity-name rule terms found in free text, not just the entity_names field", () => {
    const decision = classifyTier(
      obj({ text: "follow up: Jane Roe (Globex Legal) re: German paperwork" }),
      RULESET_WITH_OVERLAY
    );
    expect(decision.tier).toBe("super-sensitive");
    expect(decision.matched_rules).toContain("immigration-legal");
  });

  it("is case-insensitive", () => {
    const decision = classifyTier(obj({ entity_names: ["GLOBEX LEGAL"] }), RULESET_WITH_OVERLAY);
    expect(decision.tier).toBe("super-sensitive");
  });

  it("records every matched rule + the field/term that triggered it (for eyeballing)", () => {
    const decision = classifyTier(
      obj({ text: "medical records", entity_names: ["Globex Legal"] }),
      RULESET_WITH_OVERLAY
    );
    expect(decision.tier).toBe("super-sensitive");
    expect(decision.matched_rules.sort()).toEqual(["health-medical", "immigration-legal"]);
    expect(decision.matches.length).toBeGreaterThanOrEqual(2);
    expect(decision.matches.every((m) => m.field && m.term && m.rule_id)).toBe(true);
  });

  it("supports operator-adjustable custom rules appended to the ruleset", () => {
    const custom = {
      ...DEFAULT_TIERING_RULESET,
      rules: [
        ...DEFAULT_TIERING_RULESET.rules,
        { id: "sample-org", keywords: ["Ministry Briefing", "Sample Org"], entity_names: [], tags: [] }
      ]
    };
    const decision = classifyTier(obj({ text: "briefing for the Ministry Briefing" }), custom);
    expect(decision.tier).toBe("super-sensitive");
    expect(decision.matched_rules).toContain("sample-org");
  });
});

describe("extractClassifiableText", () => {
  it("pulls tags, entity names, and text out of a decrypted logseq/connector payload", () => {
    const extracted = extractClassifiableText({
      kind: "connector-endpoint",
      endpoint: JSON.stringify({ name: "Globex Legal", aliases: ["Globex LLP"] }),
      text: "notes"
    });
    expect(extracted.entity_names).toContain("Globex Legal");
    expect(extracted.entity_names).toContain("Globex LLP");
  });

  it("parses logseq wikilink tags and property tags from markdown/text", () => {
    const extracted = extractClassifiableText({
      text: "meeting notes #medical [[Health Records]]",
      properties: { tags: ["clearance"] }
    });
    expect(extracted.tags).toContain("medical");
    expect(extracted.tags).toContain("clearance");
  });

  // DEF-1(a): real personal-prod `page` objects carry properties as an ARRAY of
  // { key, value } pairs (role/org/notes/tags/...). The old extractor only read
  // data.title + a properties.tags object, so every other property value was
  // invisible and sensitive objects were mis-tiered as cloud-unlockable.
  it("extracts ALL page properties[].value (array-of-{key,value}) as classifiable text", () => {
    const extracted = extractClassifiableText({
      kind: "page",
      title: "Jane Roe",
      properties: [
        { key: "type", value: "person" },
        { key: "org", value: "Globex Legal" },
        { key: "role", value: "Honorary Consul; immigration lawyer" },
        { key: "tags", value: "immigration, legal" }
      ]
    });
    expect(extracted.text).toContain("Globex Legal");
    expect(extracted.text.toLowerCase()).toContain("immigration");
    // properties[].key === "tags" should still populate tags.
    expect(extracted.tags).toContain("immigration");
    expect(extracted.tags).toContain("legal");
    // And the page title (name) must be classifiable text too.
    expect(extracted.text).toContain("Jane Roe");
  });

  it("classifies a page with sensitive properties[] as super-sensitive (generic keyword path)", () => {
    const extracted = extractClassifiableText({
      kind: "page",
      title: "Jane Roe",
      properties: [
        { key: "org", value: "Globex Legal" },
        { key: "role", value: "immigration lawyer, honorary consul" }
      ]
    });
    const decision = classifyTier(
      {
        object_id: "la_object_sample000000000000000001",
        object_type: "page",
        access_class: "local-private",
        tags: extracted.tags,
        entity_names: extracted.entity_names,
        text: extracted.text
      },
      DEFAULT_TIERING_RULESET
    );
    // "immigration lawyer" / "honorary consul" are generic keywords, so this is
    // caught by the default ruleset even without the private overlay.
    expect(decision.tier).toBe("super-sensitive");
    expect(decision.matched_rules).toContain("immigration-legal");
  });

  // DEF-1(b): edge objects nest their names/notes under data.edge.attrs.* —
  // especially source_note.
  it("extracts edge.attrs.source_note as classifiable text (edge shape)", () => {
    const extracted = extractClassifiableText({
      kind: "edge",
      edge: {
        edge_id: "e1",
        predicate: "advised-by",
        attrs: { source_note: "immigration lawyer, Globex LLP" }
      }
    });
    expect(extracted.text.toLowerCase()).toContain("immigration");
    const decision = classifyTier(
      {
        object_id: "la_object_sample000000000000000002",
        object_type: "edge",
        access_class: "local-private",
        tags: extracted.tags,
        entity_names: extracted.entity_names,
        text: extracted.text
      },
      DEFAULT_TIERING_RULESET
    );
    expect(decision.tier).toBe("super-sensitive");
    expect(decision.matched_rules).toContain("immigration-legal");
  });

  // DEF-1(b): block/page titles must feed the classifiable text so title-only
  // signal (via a merged private place term) is caught.
  it("catches a title-only sensitive page (inherited-land via merged private place term)", () => {
    const extracted = extractClassifiableText({
      kind: "page",
      title: "Riverton family",
      properties: []
    });
    const decision = classifyTier(
      {
        object_id: "la_object_sample000000000000000003",
        object_type: "page",
        access_class: "local-private",
        tags: extracted.tags,
        entity_names: extracted.entity_names,
        text: extracted.text
      },
      RULESET_WITH_OVERLAY
    );
    expect(decision.tier).toBe("super-sensitive");
    expect(decision.matched_rules).toContain("inherited-land");
  });

  it("catches a block whose text names an immigration contact (merged private entity)", () => {
    const extracted = extractClassifiableText({
      kind: "block",
      text: "follow up with Jane re: Globex Legal immigration filing",
      properties: []
    });
    const decision = classifyTier(
      {
        object_id: "la_object_sample000000000000000004",
        object_type: "block",
        access_class: "local-private",
        tags: extracted.tags,
        entity_names: extracted.entity_names,
        text: extracted.text
      },
      RULESET_WITH_OVERLAY
    );
    expect(decision.tier).toBe("super-sensitive");
    expect(decision.matched_rules).toContain("immigration-legal");
  });

  it("catches a medical page carried entirely in properties[].value", () => {
    const extracted = extractClassifiableText({
      kind: "page",
      title: "Appointment",
      properties: [
        { key: "type", value: "note" },
        { key: "body", value: "physician follow-up; medication + treatment plan review" }
      ]
    });
    const decision = classifyTier(
      {
        object_id: "la_object_sample000000000000000005",
        object_type: "page",
        access_class: "local-private",
        tags: extracted.tags,
        entity_names: extracted.entity_names,
        text: extracted.text
      },
      DEFAULT_TIERING_RULESET
    );
    expect(decision.tier).toBe("super-sensitive");
    expect(decision.matched_rules).toContain("health-medical");
  });
});
