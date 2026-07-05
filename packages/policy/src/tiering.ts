import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AccessClass, ObjectType } from "@living-atlas/contracts";

/**
 * Data-tiering classification for Living Atlas.
 *
 * TIER MODEL
 * ----------
 * Every live object is classified into exactly one tier:
 *
 *   - "cloud-unlockable"  (DEFAULT, the vast majority): re-encryptable to
 *     "AES-GCM-256+cloud-unlock-v1" so it can be decrypted inside a Cloudflare
 *     cloud-unlock session with the primary per-request session key.
 *
 *   - "super-sensitive"   (small tail): stays "AES-GCM-256+local-keyring-v1",
 *     local-keyholding-only, NEVER cloud-decryptable. The local keys ARE the
 *     "secondary unlock" in practice.
 *
 * The classifier is a conservative, EXPLICIT, data-driven ruleset. Anything an
 * enabled rule matches is kept super-sensitive; everything else is
 * cloud-unlockable. Rules match against tags, entity names, and free text
 * extracted from the DECRYPTED payload. The ruleset is operator-adjustable:
 * append or edit rules and re-run the dry-run.
 *
 * PRIVATE OVERLAY
 * ---------------
 * The shipped DEFAULT_TIERING_RULESET is GENERIC — it carries only universal
 * keyword categories (immigration, medical, security-clearance, ...) and NO
 * personal specifics (no proper-noun names, places, or personal tags). An
 * individual operator layers their own private specifics (the exact firm names,
 * places, family members they want kept super-sensitive) via an optional overlay
 * file resolved at runtime from OUTSIDE this repository — see
 * `loadPrivateTieringRuleset`. If the overlay is absent, the generic default is
 * used unchanged.
 */

export type Tier = "cloud-unlockable" | "super-sensitive";

export type TieringRule = {
  /** Stable identifier, surfaced in the match list so John can eyeball it. */
  id: string;
  /**
   * Case-insensitive terms matched with word boundaries against the object's
   * free text (title/markdown/block text/endpoint names). Multi-word terms are
   * matched as phrases with boundary anchoring at each end.
   */
  keywords: string[];
  /** Case-insensitive substrings matched against extracted entity names/aliases. */
  entity_names: string[];
  /** Case-insensitive exact matches against extracted tags. */
  tags: string[];
  /** Optional short note explaining why this rule keeps data local-only. */
  note?: string;
  /** Rules default to enabled; set false to disable without deleting. */
  enabled?: boolean;
};

export type TieringRuleset = {
  ruleset_version: string;
  /** The tier assigned when no rule matches. Always cloud-unlockable per policy. */
  default_tier: Tier;
  rules: TieringRule[];
};

export type ClassifiableObject = {
  object_id: string;
  object_type: ObjectType;
  access_class: AccessClass;
  tags: string[];
  entity_names: string[];
  text: string;
};

export type TierMatch = {
  rule_id: string;
  /** Which extracted field triggered the match: "tag" | "entity" | "text". */
  field: "tag" | "entity" | "text";
  /** The rule term that matched. */
  term: string;
};

export type TierDecision = {
  object_id: string;
  tier: Tier;
  matched_rules: string[];
  matches: TierMatch[];
};

/**
 * DEFAULT super-sensitive ruleset — GENERIC, conservative policy: keep
 * LOCAL-ONLY anything related to immigration/legal/citizenship/visa,
 * inherited land, health/medical, security-clearance work, and immediate-family
 * private personal details. Everything else is cloud-unlockable.
 *
 * This shipped ruleset carries ONLY universal keyword categories and generic
 * tags — it contains NO personal specifics (no proper-noun names, no place
 * names, no identifying tags). An individual operator adds their own specifics
 * (exact firm names, places, family members) through the runtime private overlay
 * (`loadPrivateTieringRuleset`), which merges into these rules by `id`.
 *
 * Kept intentionally narrow (high-signal keywords) so the default posture —
 * cloud-unlockable — holds for the bulk of the graph.
 */
export const DEFAULT_TIERING_RULESET: TieringRuleset = {
  ruleset_version: "tiering-ruleset-v1",
  default_tier: "cloud-unlockable",
  rules: [
    {
      id: "immigration-legal",
      note: "Immigration / legal / citizenship / visa. Specific firm/attorney names are supplied via the private overlay.",
      keywords: [
        "immigration",
        "citizenship",
        "naturalization",
        "naturalisation",
        "visa",
        "green card",
        "USCIS",
        "consulate",
        "consular",
        "honorary consul",
        "reacquisition",
        "Staatsangehörigkeit",
        "Einbürgerung"
      ],
      entity_names: [],
      tags: ["immigration", "legal", "citizenship", "visa"]
    },
    {
      id: "inherited-land",
      note: "Inherited land / protected nature reserve. Specific place names are supplied via the private overlay.",
      keywords: [
        "Naturschutzgebiet",
        "nature reserve",
        "inherited land",
        "inherited property"
      ],
      entity_names: [],
      tags: ["inherited-land"]
    },
    {
      id: "health-medical",
      note: "Health / medical.",
      keywords: [
        "medical",
        "diagnosis",
        "prescription",
        "doctor",
        "physician",
        "hospital",
        "clinic",
        "health record",
        "health records",
        "medication",
        "treatment plan",
        "mental health"
      ],
      entity_names: [],
      tags: ["medical", "health", "health-private"]
    },
    {
      id: "security-clearance",
      note: "Security-clearance work.",
      keywords: [
        "security clearance",
        "clearance",
        // "classified" alone is noisy (categorized vs. secret); require a
        // security context phrase instead.
        "classified information",
        "classified document",
        "top secret",
        "TS/SCI",
        "TS-SCI",
        "SCI",
        "background investigation",
        "polygraph"
      ],
      entity_names: [],
      tags: ["clearance", "security-clearance", "classified"]
    },
    {
      id: "immediate-family-private",
      note: "Immediate-family PRIVATE personal details only. Most family stays cloud-unlockable — this is the private tail. Specific family-member names and any personal tags are supplied via the private overlay.",
      keywords: [],
      entity_names: [],
      tags: ["family-private"]
    }
  ]
};

/**
 * A PRIVATE overlay: per-rule additions of personal specifics (exact entity
 * names, extra keywords, extra tags) that MUST NOT live in the public source
 * tree. Loaded at runtime from a path OUTSIDE the repository and merged into the
 * generic default by rule `id`. Structural only — it can only extend rules that
 * already exist in the base ruleset; it cannot introduce new rule ids.
 */
export type PrivateTieringOverlayRule = {
  id: string;
  entity_names?: string[];
  keywords?: string[];
  tags?: string[];
};

export type PrivateTieringOverlay = {
  rules: PrivateTieringOverlayRule[];
};

/** Env var naming the private overlay file path (see loadPrivateTieringRuleset). */
export const PRIVATE_TIERING_RULESET_ENV = "LIVING_ATLAS_TIERING_PRIVATE_RULESET";

/** Default overlay location — outside the repo, under the OS app-support dir. */
export function defaultPrivateTieringRulesetPath(): string {
  return join(
    homedir(),
    "Library",
    "Application Support",
    "LivingAtlas",
    "personal-prod",
    "tiering-private-ruleset.json"
  );
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * Merge a private overlay into a base ruleset by rule `id`. PURE — the base
 * ruleset is not mutated. Overlay terms are appended (and de-duplicated) to the
 * matching rule's entity_names/keywords/tags; the base generic terms are always
 * preserved. Overlay entries whose id matches no base rule are ignored (the
 * overlay can only extend existing rules, never invent new ones).
 */
export function mergePrivateOverlayIntoRuleset(
  base: TieringRuleset,
  overlay: PrivateTieringOverlay | undefined
): TieringRuleset {
  if (!overlay || !Array.isArray(overlay.rules) || overlay.rules.length === 0) {
    return base;
  }
  const overlayById = new Map<string, PrivateTieringOverlayRule>();
  for (const rule of overlay.rules) {
    if (rule && typeof rule.id === "string") overlayById.set(rule.id, rule);
  }
  return {
    ...base,
    rules: base.rules.map((rule) => {
      const extra = overlayById.get(rule.id);
      if (!extra) return rule;
      return {
        ...rule,
        entity_names: dedupe([...rule.entity_names, ...(extra.entity_names ?? [])]),
        keywords: dedupe([...rule.keywords, ...(extra.keywords ?? [])]),
        tags: dedupe([...rule.tags, ...(extra.tags ?? [])])
      };
    })
  };
}

/**
 * Load the private overlay (if present) and merge it into `base`. The overlay
 * path resolves from `LIVING_ATLAS_TIERING_PRIVATE_RULESET`, defaulting to
 * `defaultPrivateTieringRulesetPath()`. If the file is absent or malformed, the
 * generic `base` is returned unchanged (fail-safe: never throws, never leaks).
 */
export function loadPrivateTieringRuleset(base: TieringRuleset = DEFAULT_TIERING_RULESET): TieringRuleset {
  const path = process.env[PRIVATE_TIERING_RULESET_ENV]?.trim() || defaultPrivateTieringRulesetPath();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return base;
  }
  let overlay: PrivateTieringOverlay;
  try {
    overlay = JSON.parse(raw) as PrivateTieringOverlay;
  } catch {
    return base;
  }
  return mergePrivateOverlayIntoRuleset(base, overlay);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Word-boundary, case-insensitive phrase match with bounded trailing-inflection
 * tolerance. "visa" matches "visa timeline" but NOT "visach"/"visasq"; "hospital"
 * matches "hospitalized" but NOT "hospitality"; "clearance"→"clearances",
 * "medication"→"medications", "green card"→"green cards".
 *
 * The inflection suffix is a small closed allowlist (plural / verb / nominal
 * forms: s, es, ed, ing, 's, ize/ise + d/s/ation, ist) so genuinely-sensitive
 * inflected forms in real bodies are caught — "hospital"→"hospitalized",
 * "clearance"→"clearances", "medication"→"medications" — while unrelated longer
 * tokens whose continuation is NOT one of these suffixes ("hospitality",
 * "visasq") are rejected by the required trailing word boundary. Multi-word terms
 * match as contiguous phrases with the suffix applied to the final word.
 */
const INFLECTION_SUFFIX = "(?:s|es|ed|ing|'s|ize|izes|ized|izing|ization|ise|ises|ised|ising|isation|ist)?";

function textContainsTerm(text: string, term: string): boolean {
  const trimmed = term.trim();
  if (!trimmed) return false;
  const pattern = new RegExp(
    `(^|[^\\p{L}\\p{N}])${escapeRegExp(trimmed)}${INFLECTION_SUFFIX}([^\\p{L}\\p{N}]|$)`,
    "iu"
  );
  return pattern.test(text);
}

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase().replace(/^#/, "");
}

export function classifyTier(object: ClassifiableObject, ruleset: TieringRuleset): TierDecision {
  const matches: TierMatch[] = [];
  const objectTags = new Set(object.tags.map(normalizeTag));
  const entityHaystack = object.entity_names.map((name) => name.toLowerCase());

  for (const rule of ruleset.rules) {
    if (rule.enabled === false) continue;

    for (const tag of rule.tags) {
      if (objectTags.has(normalizeTag(tag))) {
        matches.push({ rule_id: rule.id, field: "tag", term: tag });
      }
    }
    for (const name of rule.entity_names) {
      const needle = name.toLowerCase();
      // Entity-name rule terms (supplied privately via the overlay) appear both
      // in the extracted entity_names field AND, for blocks/edges, inline in the
      // free text (e.g. an org name mentioned in a note). Match both so a named
      // entity in body text is not invisible. (DEF-1b)
      if (
        entityHaystack.some((candidate) => candidate.includes(needle)) ||
        object.text.toLowerCase().includes(needle)
      ) {
        matches.push({ rule_id: rule.id, field: "entity", term: name });
      }
    }
    for (const keyword of rule.keywords) {
      if (textContainsTerm(object.text, keyword) || entityHaystack.some((candidate) => textContainsTerm(candidate, keyword))) {
        matches.push({ rule_id: rule.id, field: "text", term: keyword });
      }
    }
  }

  const matchedRules = [...new Set(matches.map((match) => match.rule_id))];
  return {
    object_id: object.object_id,
    tier: matchedRules.length > 0 ? "super-sensitive" : ruleset.default_tier,
    matched_rules: matchedRules,
    matches
  };
}

/**
 * Pull tags, entity names, and free text out of a decrypted plaintext-json
 * payload. Handles the real personal-prod shapes: logseq pages/blocks
 * (title/markdown/text/properties), connector + topic endpoints
 * (endpoint.name/aliases), and generic records.
 */
export function extractClassifiableText(data: Record<string, unknown>): {
  tags: string[];
  entity_names: string[];
  text: string;
} {
  const tags = new Set<string>();
  const entityNames = new Set<string>();
  const textParts: string[] = [];

  const pushText = (value: unknown): void => {
    if (typeof value === "string" && value) textParts.push(value);
  };

  pushText(data.text);
  pushText(data.title);
  pushText(data.markdown);
  pushText(data.source_text);
  pushText(data.predicate_text);
  pushText(data.group_summary);
  pushText(data.rationale);

  // Edge objects nest their content under data.edge.*, most importantly
  // data.edge.attrs.source_note (a free-text note about the relationship, e.g.
  // "immigration lawyer, <firm>"). Feed the human-readable edge fields and
  // ALL edge.attrs.* string values into the classifiable text so relationship
  // notes are not invisible. (DEF-1b)
  const edgeRaw = data.edge;
  if (edgeRaw && typeof edgeRaw === "object" && !Array.isArray(edgeRaw)) {
    const edge = edgeRaw as Record<string, unknown>;
    pushText(edge.predicate);
    pushText(edge.source_note);
    pushText(edge.note);
    const edgeAttrs = edge.attrs;
    if (edgeAttrs && typeof edgeAttrs === "object" && !Array.isArray(edgeAttrs)) {
      for (const value of Object.values(edgeAttrs as Record<string, unknown>)) {
        pushText(value);
      }
    }
  }

  // Endpoint objects carry the canonical entity name + aliases.
  const endpointRaw = data.endpoint;
  if (endpointRaw) {
    let endpoint: unknown = endpointRaw;
    if (typeof endpointRaw === "string") {
      try {
        endpoint = JSON.parse(endpointRaw);
      } catch {
        endpoint = undefined;
      }
    }
    if (endpoint && typeof endpoint === "object") {
      const ep = endpoint as Record<string, unknown>;
      if (typeof ep.name === "string") entityNames.add(ep.name);
      if (Array.isArray(ep.aliases)) {
        for (const alias of ep.aliases) if (typeof alias === "string") entityNames.add(alias);
      }
    }
  }

  // Logseq page/block properties. Two real shapes occur in personal-prod:
  //
  //   1. An ARRAY of { key, value } pairs — the dominant page/block shape
  //      (e.g. role/org/notes/tags). EVERY value is classifiable text, not just
  //      "tags", otherwise sensitive role/org/notes signal is invisible. (DEF-1a)
  //   2. An OBJECT with a `tags` field (array or comma/space-separated string).
  //
  // In both shapes, a property whose key is "tags" also populates tags.
  const addTagsFromValue = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const tag of value) if (typeof tag === "string") tags.add(normalizeTag(tag));
    } else if (typeof value === "string") {
      for (const tag of value.split(/[,\s]+/)) if (tag) tags.add(normalizeTag(tag));
    }
  };

  const properties = data.properties;
  if (Array.isArray(properties)) {
    for (const entry of properties) {
      if (!entry || typeof entry !== "object") continue;
      const prop = entry as Record<string, unknown>;
      const key = typeof prop.key === "string" ? prop.key : undefined;
      const value = prop.value;
      // All property values are classifiable free text.
      pushText(value);
      if (key && key.trim().toLowerCase() === "tags") {
        addTagsFromValue(value);
      }
    }
  } else if (properties && typeof properties === "object") {
    addTagsFromValue((properties as Record<string, unknown>).tags);
  }

  // Combine ALL collected free text (base fields + edge + every property value)
  // and run logseq wikilink [[Foo]] / hashtag #foo tag extraction over it.
  const combined = textParts.join("\n");
  for (const match of combined.matchAll(/\[\[([^\]]+)\]\]/g)) {
    if (match[1]) tags.add(normalizeTag(match[1]));
  }
  for (const match of combined.matchAll(/(?:^|\s)#([\p{L}\p{N}_-]+)/gu)) {
    if (match[1]) tags.add(normalizeTag(match[1]));
  }

  return {
    tags: [...tags],
    entity_names: [...entityNames],
    text: combined
  };
}
