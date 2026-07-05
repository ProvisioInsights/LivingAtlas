import { describe, expect, it } from "vitest";

import { inferAffiliationPredicate, normalizeEntityTitle } from "./endpoint-title-normalize";

describe("normalizeEntityTitle", () => {
  it("passes a clean single title through unchanged", () => {
    const r = normalizeEntityTitle("Northwind Systems");
    expect(r.original).toBe("Northwind Systems");
    expect(r.units).toEqual([{ name: "Northwind Systems" }]);
  });

  it("strips [[wikilink]] markup and keeps a trailing annotation as note", () => {
    const r = normalizeEntityTitle("[[Vantablack]] (stealth)");
    expect(r.units).toHaveLength(1);
    expect(r.units[0]).toMatchObject({ name: "Vantablack", note: "stealth" });
  });

  it("repairs an unbalanced trailing bracket/paren", () => {
    const r = normalizeEntityTitle("[[Vantablack]] (stealth");
    expect(r.units[0]).toMatchObject({ name: "Vantablack", note: "stealth" });
  });

  it("moves a location address annotation to note, keeping the canonical place name", () => {
    const r = normalizeEntityTitle("Metro City, ST (500 Main St Suite 100, 00000)");
    expect(r.units).toHaveLength(1);
    expect(r.units[0]).toMatchObject({ name: "Metro City, ST", note: "500 Main St Suite 100, 00000" });
  });

  it("does NOT split on a middle-dot that is inside parentheses", () => {
    const r = normalizeEntityTitle("Acme Home & Commercial Services (Rivertown · founded 1949 · ~900 employees)");
    expect(r.units).toHaveLength(1);
    expect(r.units[0]?.name).toBe("Acme Home & Commercial Services");
    expect(r.units[0]?.note).toContain("founded 1949");
  });

  it("splits a top-level middle-dot compound into multiple entities, each with its role hint", () => {
    const r = normalizeEntityTitle("MetroHealth / Riverside Care (day job) · [[Helping Hands]] (board)");
    expect(r.units.length).toBeGreaterThanOrEqual(2);
    const names = r.units.map((u) => u.name);
    expect(names).toContain("Helping Hands");
    // the day-job employer segment retains its role hint
    const dayJob = r.units.find((u) => u.roleHint === "day job");
    expect(dayJob).toBeTruthy();
    const board = r.units.find((u) => u.name === "Helping Hands");
    expect(board?.roleHint).toBe("board");
  });

  it("preserves the full original string verbatim on every result", () => {
    const raw = "Vertex Materials (VMX · Rivertown) · [[Helping Hands]] (board)";
    const r = normalizeEntityTitle(raw);
    expect(r.original).toBe(raw);
    expect(r.units.length).toBeGreaterThanOrEqual(2);
  });

  it("never loses content: original annotations are recoverable from notes/aliases", () => {
    const r = normalizeEntityTitle("Fairview, Eastland (per note)");
    expect(r.units[0]?.name).toBe("Fairview, Eastland");
    expect(r.units[0]?.note).toBe("per note");
  });
});

describe("inferAffiliationPredicate", () => {
  it("maps employment role hints to employed-by", () => {
    for (const hint of ["day job", "CPO", "SVP Engineering", "employee", "career", "Director of Sales"]) {
      expect(inferAffiliationPredicate(hint)).toEqual({ predicate: "employed-by", confidence: "high" });
    }
  });

  it("maps board hints to board-member-of", () => {
    for (const hint of ["board", "board chair", "board Treasurer", "former Board President 2020-2024"]) {
      expect(inferAffiliationPredicate(hint)).toEqual({ predicate: "board-member-of", confidence: "high" });
    }
  });

  it("maps advisor and founder hints correctly", () => {
    expect(inferAffiliationPredicate("Venture Advisor")).toEqual({ predicate: "advises", confidence: "high" });
    expect(inferAffiliationPredicate("Co-Founder")).toEqual({ predicate: "founder-of", confidence: "high" });
    expect(inferAffiliationPredicate("founding board director")).toEqual({ predicate: "board-member-of", confidence: "high" });
  });

  it("returns needs-review for ambiguous or missing hints (never guesses wrong)", () => {
    expect(inferAffiliationPredicate("stealth")).toMatchObject({ confidence: "needs-review" });
    expect(inferAffiliationPredicate(undefined)).toMatchObject({ confidence: "needs-review" });
    expect(inferAffiliationPredicate("")).toMatchObject({ confidence: "needs-review" });
  });
});
