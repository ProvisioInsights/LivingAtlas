import { z } from "zod";
const RedactionRulesSchema = z.object({ mask_fields: z.array(z.string()).default([]) });
export type RedactionRules = { maskFields: Set<string> };

export function loadRedactionRules(json: string | undefined): RedactionRules {
  if (!json) return { maskFields: new Set() };
  const parsed = RedactionRulesSchema.safeParse(JSON.parse(json));
  return { maskFields: new Set(parsed.success ? parsed.data.mask_fields : []) };
}

export function applyRedaction(rules: RedactionRules, data: Record<string, unknown>): Record<string, unknown> {
  if (rules.maskFields.size === 0) return data;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    out[key] = rules.maskFields.has(key) ? "[redacted]" : value;
  }
  return out;
}
