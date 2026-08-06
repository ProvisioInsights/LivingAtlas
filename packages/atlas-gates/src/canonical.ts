/**
 * What a recorded response may and may not remember.
 *
 * A golden fixture is only worth having if re-recording it on an unchanged
 * implementation produces the identical file. Two things in an Atlas response
 * are not reproducible, and neither of them is part of an answer:
 *
 *  - **Minted identifiers.** `mintEntityId` draws `randomBytes(16)`, and it must:
 *    ids are minted and never derived, which is the invariant that replaced the
 *    old store's content-derived ids — the ones that re-identified 51,811 of
 *    65,091 objects when a bullet was inserted. Random by design means different
 *    every run by design.
 *  - **Digests over those identifiers.** `claim_digest` covers the claim core,
 *    and the claim core names a subject by its minted id, so the digest inherits
 *    the randomness.
 *
 * Both are replaced by labels assigned in first-encounter order. That keeps
 * every structural fact a golden is for — which fields hold the SAME value,
 * which hold different ones, how many distinct records appeared, in what order —
 * and drops only the bytes a fresh run could never match.
 *
 * The signed `requestState` is replaced for a third reason: it is a MAC whose
 * payload carries an expiry stamped from the SDK's own wall clock, not from the
 * clock this fixture supplies. Two recordings a second apart differ. A MAC is
 * not an answer, and pinning one would pin the minute it was recorded.
 *
 * Timestamps are deliberately NOT canonicalised. The fixtures drive a constant
 * clock, so belief-time stamps advance only where the store advances them: once
 * per commit and once per audit event, by the `Math.max(now, last + 1)` monotone
 * guard. Those advances are semantic, they are reproducible, and pinning them is
 * how a golden notices that `idempotency_expires_at` stopped being 30 days out.
 */

const VOLATILE = /la_[a-z]+_[0-9a-z]{16,}|sha256:[0-9a-f]{64}|v1\.[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{24,}/g;

export type LabelMap = Map<string, string>;

function labelFor(found: string, labels: LabelMap): string {
  const existing = labels.get(found);
  if (existing) return existing;
  const kind = /^(la_[a-z]+)_/.exec(found)?.[1] ?? (found.startsWith("sha256:") ? "sha256" : "request_state");
  const label = `<${kind}:${labels.size}>`;
  labels.set(found, label);
  return label;
}

/**
 * Replace volatile identifiers everywhere they appear, INCLUDING inside strings.
 *
 * Inside strings matters more than it sounds: every result carries its payload
 * twice, once as `structuredContent` and once as the JSON text block a client
 * without structured-output support reads. Canonicalising only the structured
 * half would leave the text half full of fresh random ids, and the golden would
 * fail on its own second recording.
 */
export function canonicalizeResponse(value: unknown, labels: LabelMap): unknown {
  if (typeof value === "string") {
    VOLATILE.lastIndex = 0;
    return value.replace(VOLATILE, (found) => labelFor(found, labels));
  }
  if (Array.isArray(value)) return value.map((item) => canonicalizeResponse(item, labels));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = canonicalizeResponse(item, labels);
    }
    return out;
  }
  return value;
}

/** Deterministic JSON with sorted keys, so a golden diff is a semantic diff. */
export function stableJson(value: unknown): string {
  return `${JSON.stringify(sortDeep(value), null, 2)}\n`;
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * The first difference between two structures, as a JSON pointer and both
 * values. A golden that fails should say WHICH field moved, not print two
 * kilobytes of JSON and leave the reader to diff it.
 */
export function firstDifference(expected: unknown, actual: unknown, pointer = "#"): string | undefined {
  if (JSON.stringify(sortDeep(expected)) === JSON.stringify(sortDeep(actual))) return undefined;

  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) {
      return `${pointer}: expected ${expected.length} items, got ${actual.length}`;
    }
    for (const [index, item] of expected.entries()) {
      const found = firstDifference(item, actual[index], `${pointer}/${index}`);
      if (found) return found;
    }
  }

  if (
    expected !== null &&
    actual !== null &&
    typeof expected === "object" &&
    typeof actual === "object" &&
    !Array.isArray(expected) &&
    !Array.isArray(actual)
  ) {
    const left = expected as Record<string, unknown>;
    const right = actual as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    for (const key of keys) {
      if (!(key in left)) return `${pointer}/${key}: added, not present in the recording`;
      if (!(key in right)) return `${pointer}/${key}: removed, it is present in the recording`;
      const found = firstDifference(left[key], right[key], `${pointer}/${key}`);
      if (found) return found;
    }
  }

  return `${pointer}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
}
