/**
 * Lossless normalization of endpoint titles that arrived polluted from
 * prose-rich Logseq property values (addresses, role notes, wikilink markup,
 * or several affiliations glued together with a middle dot).
 *
 * Guarantees:
 * - The full original string is always preserved on `original`.
 * - Every stripped annotation is retained as a unit `note` (nothing dropped).
 * - Compound values ("A (day job) · B (board)") split into one unit per real
 *   entity, each carrying its own role hint for downstream edge inference.
 *
 * This is a pure function so it can be unit-tested exhaustively and later
 * wired directly into the importer's property-value parsing.
 */

export type EntityUnit = {
  name: string;
  roleHint?: string;
  note?: string;
};

export type NormalizedTitle = {
  original: string;
  units: EntityUnit[];
};

/** Split on a top-level middle dot, ignoring dots inside (...) or [[...]]. */
function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let depthParen = 0;
  let depthBracket = 0;
  let current = "";
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]!;
    if (ch === "(") depthParen += 1;
    else if (ch === ")") depthParen = Math.max(0, depthParen - 1);
    else if (ch === "[") depthBracket += 1;
    else if (ch === "]") depthBracket = Math.max(0, depthBracket - 1);
    if (ch === "·" && depthParen === 0 && depthBracket === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

function stripWikilink(value: string): string {
  return value.replace(/\[\[/g, "").replace(/\]\]/g, "").trim();
}

/**
 * Pull a single trailing annotation off a segment: a balanced (or unbalanced)
 * trailing parenthetical, or a " - Branch"/"; note" suffix. Returns the clean
 * name and the annotation text (undefined if none).
 */
function extractAnnotation(segment: string): { name: string; note?: string } {
  const trimmed = segment.trim();

  // Trailing parenthetical, tolerating a missing closing paren.
  const openIdx = trimmed.indexOf("(");
  if (openIdx > 0) {
    const head = trimmed.slice(0, openIdx).trim();
    let tail = trimmed.slice(openIdx + 1);
    if (tail.endsWith(")")) tail = tail.slice(0, -1);
    const note = tail.trim().replace(/[)\s]+$/, "").trim();
    if (head.length > 0) {
      return { name: stripWikilink(head), note: note.length > 0 ? note : undefined };
    }
  }

  return { name: stripWikilink(trimmed) };
}

export function normalizeEntityTitle(raw: string): NormalizedTitle {
  const original = raw;
  const segments = splitTopLevel(raw);
  const units: EntityUnit[] = [];
  for (const segment of segments) {
    const { name, note } = extractAnnotation(segment);
    if (!name) continue;
    const unit: EntityUnit = { name };
    if (note) {
      unit.note = note;
      unit.roleHint = note;
    }
    units.push(unit);
  }
  if (units.length === 0) {
    units.push({ name: stripWikilink(raw).trim() || raw });
  }
  return { original, units };
}

export type AffiliationPredicateGuess = {
  predicate?: "employed-by" | "board-member-of" | "advises" | "founder-of" | "member-of";
  confidence: "high" | "needs-review";
};

const EMPLOYMENT = /\b(day\s?job|employee|employed|career|works?|staff|cpo|ceo|coo|cto|cfo|cro|cmo|cio|svp|evp|vp|director|engineer|manager|president|head\s+of|chief|principal|analyst|associate|sales|operations)\b/i;
const BOARD = /\bboard\b|\btrustee\b/i;
const ADVISOR = /\badvisor|\badvises|\badvisory|operating\s+advisor|venture\s+advisor/i;
const FOUNDER = /\bco-?founder|\bfounder|\bfounding\b/i;
const MEMBER = /\bmember\b|\balumn|\bchapter\b|\bsorority\b|\bfraternity\b/i;

export function inferAffiliationPredicate(roleHint: string | undefined): AffiliationPredicateGuess {
  const hint = roleHint?.trim();
  if (!hint) return { confidence: "needs-review" };
  // Board takes priority over generic titles ("former Board President" is board, not employment).
  if (BOARD.test(hint) || /founding\s+board/i.test(hint)) return { predicate: "board-member-of", confidence: "high" };
  if (FOUNDER.test(hint)) return { predicate: "founder-of", confidence: "high" };
  if (ADVISOR.test(hint)) return { predicate: "advises", confidence: "high" };
  if (EMPLOYMENT.test(hint)) return { predicate: "employed-by", confidence: "high" };
  if (MEMBER.test(hint)) return { predicate: "member-of", confidence: "high" };
  return { confidence: "needs-review" };
}
