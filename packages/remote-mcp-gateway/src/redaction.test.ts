import { describe, expect, it } from "vitest";
import { applyRedaction, loadRedactionRules } from "./redaction";

describe("applyRedaction", () => {
  it("is a no-op when no rules are configured (off by default)", () => {
    const rules = loadRedactionRules(undefined);
    const data = { name: "Example User", address: "123 Sample St", amount: 4200 };
    expect(applyRedaction(rules, data)).toEqual(data);
  });

  it("masks configured fields when rules are present", () => {
    const rules = loadRedactionRules(JSON.stringify({ mask_fields: ["address", "amount"] }));
    const out = applyRedaction(rules, { name: "Example User", address: "123 Sample St", amount: 4200 });
    expect(out).toEqual({ name: "Example User", address: "[redacted]", amount: "[redacted]" });
  });
});
