import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AssertionSchema } from "./assertion.js";
import {
  aliasLedgerDigest,
  unsealAliasRow,
  verifyAliasLedger,
  type AliasRow,
  type UnsealedAliasRow
} from "./alias-ledger.js";
import type { Entity, EntityDraft, SourceObservation } from "./entity.js";
import {
  EntityRegistry,
  assertionLogResolutions,
  type IdentityMatch,
  type MergeResult,
  type Resolution,
  type SplitResult
} from "./entity-registry.js";
import { mintEntityId, type EntityId } from "./ids.js";
import { AssertionLog } from "./store.js";
import { canonicalRecordedAt } from "./time.js";

/** Deterministic clock — tests must not depend on wall time. */
function fixedClock(start = "2026-08-04T12:00:00.000Z") {
  let millis = new Date(start).getTime();
  return {
    now: () => new Date(millis),
    advance(ms: number) {
      millis += ms;
    }
  };
}

function draft(overrides: Partial<EntityDraft> = {}): EntityDraft {
  return {
    type: "person",
    display_name: "Fixture Person",
    also_known_as: [],
    ...overrides
  } as EntityDraft;
}

const OWNER = { client_id: "atlas-owner" } as const;

/** Synthetic source text; nothing here comes from a real graph. */
function textDigest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function observation(overrides: Partial<SourceObservation> = {}): SourceObservation {
  return {
    source_path_ref: "pages/fixture-page.md",
    block_ordinal: 7,
    text_digest: textDigest("a synthetic bullet"),
    ...overrides
  };
}

function resolved(result: Resolution) {
  if (!result.ok) throw new Error(`expected the id to resolve: ${result.code}`);
  return result;
}

function refused(result: Resolution) {
  if (result.ok) throw new Error("expected the id to be refused");
  return result;
}

function matched(result: IdentityMatch) {
  if (!result.ok) throw new Error(`expected a match or a mint: ${result.code}`);
  return result;
}

function merged(result: MergeResult) {
  if (!result.ok) throw new Error(`expected the merge to succeed: ${result.code}`);
  return result;
}

function splitOk(result: SplitResult) {
  if (!result.ok) throw new Error(`expected the split to succeed: ${result.code}`);
  return result;
}

/** A registered entity, built directly so a restored fixture can be assembled. */
function entityFixture(entityId: EntityId, name: string): Entity {
  return {
    record_schema: "atlas.entity:v1",
    entity_id: entityId,
    type: "person",
    display_name: name,
    also_known_as: [],
    registered_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    provenance: {
      client_id: "fixture",
      origin: "owner-authored",
      recorded_at_fidelity: "authoritative"
    },
    sensitivity: { tier: "local-private", rank: 10, withheld: false }
  };
}

/**
 * Build a sealed ledger by hand. Used only to simulate a ledger that a correct
 * writer would never produce — a cycle, an over-long chain, a dangling target —
 * because the registry refuses to write those, and the read path still has to
 * survive a hand-edited or tampered file.
 */
function sealedLedger(
  entries: { old_id: string; new_id: EntityId; reason?: string }[]
): AliasRow[] {
  const rows: AliasRow[] = [];
  let previous: string | null = null;
  entries.forEach((entry, index) => {
    const unsealed = {
      record_schema: "atlas.alias-row:v1",
      row_seq: index + 1,
      old_id: entry.old_id,
      reason: entry.reason ?? "fixture redirect",
      recorded_at: canonicalRecordedAt(new Date(Date.UTC(2026, 0, 1, 0, 0, index))),
      basis: "mechanical-migration",
      provenance: {
        client_id: "fixture",
        origin: "pre-contract-import",
        recorded_at_fidelity: "import-artifact"
      },
      resolution_assertion_id: null,
      prev_ledger_digest: previous,
      disposition: "mapped",
      new_id: entry.new_id
    } as UnsealedAliasRow;
    const row = { ...unsealed, ledger_digest: aliasLedgerDigest(unsealed) } as AliasRow;
    rows.push(row);
    previous = row.ledger_digest;
  });
  return rows;
}

function restoredFrom(entities: Entity[], rows: AliasRow[]) {
  return {
    entities,
    rows,
    observations: new Map<EntityId, SourceObservation>(),
    next_row_seq: rows.length + 1,
    last_recorded_millis: 0,
    conflicting_alias_rows: []
  };
}

describe("ids are minted, never derived from content", () => {
  it("keeps the id when the text is edited", () => {
    // The whole defect in one test. The old importer derived a block id from
    // sha256(sourcePathRef : lineIndex : text), so fixing a typo minted a new
    // id and orphaned every reference to the old one.
    const registry = new EntityRegistry({ clock: fixedClock().now });
    const first = matched(
      registry.resolveOrMint({
        observation: observation({ text_digest: textDigest("teh quick brown fox") }),
        draft: draft(),
        ...OWNER
      })
    );

    const afterTypoFix = matched(
      registry.resolveOrMint({
        observation: observation({ text_digest: textDigest("the quick brown fox") }),
        draft: draft(),
        ...OWNER
      })
    );

    expect(afterTypoFix.entity.entity_id).toBe(first.entity.entity_id);
    expect(afterTypoFix.carried_forward).toBe(true);
    expect(registry.size).toBe(1);
  });

  it("keeps the id when a bullet is inserted above it", () => {
    // Inserting one bullet shifted every line below it, which re-identified
    // the great majority of objects in the old store.
    const registry = new EntityRegistry({ clock: fixedClock().now });
    const first = matched(
      registry.resolveOrMint({ observation: observation({ block_ordinal: 7 }), draft: draft(), ...OWNER })
    );
    const afterInsert = matched(
      registry.resolveOrMint({ observation: observation({ block_ordinal: 8 }), draft: draft(), ...OWNER })
    );

    expect(afterInsert.entity.entity_id).toBe(first.entity.entity_id);
    expect(registry.size).toBe(1);
  });

  it("keeps the id when the file is renamed", () => {
    const registry = new EntityRegistry({ clock: fixedClock().now });
    const first = matched(
      registry.resolveOrMint({
        observation: observation({ source_path_ref: "pages/old-name.md" }),
        draft: draft(),
        ...OWNER
      })
    );
    const afterRename = matched(
      registry.resolveOrMint({
        observation: observation({ source_path_ref: "pages/new-name.md" }),
        draft: draft(),
        ...OWNER
      })
    );

    expect(afterRename.entity.entity_id).toBe(first.entity.entity_id);
    expect(registry.size).toBe(1);
  });

  it("survives drift that accumulates one trait at a time across re-imports", () => {
    // Each re-import re-anchors the observation. Without that, the third import
    // would be comparing against traits from the first and would match nothing.
    const registry = new EntityRegistry({ clock: fixedClock().now });
    const original = matched(
      registry.resolveOrMint({
        observation: {
          source_path_ref: "pages/a.md",
          block_ordinal: 3,
          text_digest: textDigest("v1")
        },
        draft: draft(),
        ...OWNER
      })
    );

    const editedText = matched(
      registry.resolveOrMint({
        observation: {
          source_path_ref: "pages/a.md",
          block_ordinal: 3,
          text_digest: textDigest("v2")
        },
        draft: draft(),
        ...OWNER
      })
    );
    const renamedFile = matched(
      registry.resolveOrMint({
        observation: {
          source_path_ref: "pages/b.md",
          block_ordinal: 3,
          text_digest: textDigest("v2")
        },
        draft: draft(),
        ...OWNER
      })
    );
    const reordered = matched(
      registry.resolveOrMint({
        observation: {
          source_path_ref: "pages/b.md",
          block_ordinal: 11,
          text_digest: textDigest("v2")
        },
        draft: draft(),
        ...OWNER
      })
    );

    expect(editedText.entity.entity_id).toBe(original.entity.entity_id);
    expect(renamedFile.entity.entity_id).toBe(original.entity.entity_id);
    expect(reordered.entity.entity_id).toBe(original.entity.entity_id);
    expect(registry.size).toBe(1);
  });

  it("mints a new entity when nothing matches, rather than guessing", () => {
    const registry = new EntityRegistry({ clock: fixedClock().now });
    const first = matched(
      registry.resolveOrMint({ observation: observation(), draft: draft(), ...OWNER })
    );
    const unrelated = matched(
      registry.resolveOrMint({
        observation: {
          source_path_ref: "pages/elsewhere.md",
          block_ordinal: 99,
          text_digest: textDigest("something else entirely")
        },
        draft: draft({ display_name: "Other Person" }),
        ...OWNER
      })
    );

    expect(unrelated.entity.entity_id).not.toBe(first.entity.entity_id);
    expect(unrelated.carried_forward).toBe(false);
    expect(registry.size).toBe(2);
  });

  it("refuses an observation too thin to ever be found again", () => {
    // One trait can never reach the threshold, so every future import would
    // mint another copy. Refusing is how the duplicate explosion is prevented
    // at the point it would be seeded.
    const registry = new EntityRegistry({ clock: fixedClock().now });
    const result = registry.resolveOrMint({
      observation: { source_path_ref: "pages/only-a-path.md" },
      draft: draft(),
      ...OWNER
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("identity-observation-underspecified");
    expect(registry.size).toBe(0);
  });

  it("refuses rather than picking when two entities match equally well", () => {
    // Two partial imports from different sources: one knew where the bullet
    // was, the other knew what it said. A later, fuller observation matches the
    // threshold against BOTH, and picking one would conflate two records.
    const registry = new EntityRegistry({ clock: fixedClock().now });
    const byPosition = matched(
      registry.resolveOrMint({
        observation: { source_path_ref: "pages/a.md", block_ordinal: 1 },
        draft: draft(),
        ...OWNER
      })
    );
    const byContent = matched(
      registry.resolveOrMint({
        observation: { text_digest: textDigest("a bullet"), id_property: "uuid-b" },
        draft: draft({ display_name: "Second" }),
        ...OWNER
      })
    );
    expect(byContent.entity.entity_id).not.toBe(byPosition.entity.entity_id);

    const ambiguous = registry.resolveOrMint({
      observation: {
        source_path_ref: "pages/a.md",
        block_ordinal: 1,
        text_digest: textDigest("a bullet"),
        id_property: "uuid-b"
      },
      draft: draft(),
      ...OWNER
    });

    expect(ambiguous.ok).toBe(false);
    if (ambiguous.ok) throw new Error("unreachable");
    expect(ambiguous.code).toBe("identity-ambiguous");
    if (ambiguous.code !== "identity-ambiguous") throw new Error("unreachable");
    expect([...ambiguous.candidate_ids].sort()).toEqual(
      [byPosition.entity.entity_id, byContent.entity.entity_id].sort()
    );
    expect(registry.size).toBe(2);
  });

  it("mints a distinct id every time, so no id is ever reused", () => {
    const registry = new EntityRegistry({ clock: fixedClock().now });
    const ids = new Set<string>();
    for (let index = 0; index < 500; index += 1) {
      ids.add(registry.register(draft({ display_name: `Person ${index}` }), OWNER).entity_id);
    }
    expect(ids.size).toBe(500);
  });
});

describe("renaming is not an identity event", () => {
  it("changes the name, keeps the id, and writes no ledger row", () => {
    const registry = new EntityRegistry({ clock: fixedClock().now });
    const entity = registry.register(draft({ display_name: "Typo Nmae" }), OWNER);

    const renamed = registry.rename(entity.entity_id, { display_name: "Correct Name" }, OWNER);

    expect(renamed.ok).toBe(true);
    if (!renamed.ok) throw new Error("unreachable");
    expect(renamed.entity.entity_id).toBe(entity.entity_id);
    expect(renamed.entity.display_name).toBe("Correct Name");
    expect(registry.ledger).toHaveLength(0);
    expect(resolved(registry.resolve(entity.entity_id)).entity.display_name).toBe("Correct Name");
  });

  it("does not let an import overwrite a curated name", () => {
    // An importer re-reading a source must not clobber a name a human chose.
    // Carrying the id forward is the importer's job; naming is not.
    const registry = new EntityRegistry({ clock: fixedClock().now });
    const first = matched(
      registry.resolveOrMint({ observation: observation(), draft: draft({ display_name: "Raw Source Text" }), ...OWNER })
    );
    registry.rename(first.entity.entity_id, { display_name: "Curated Name" }, OWNER);

    const reimported = matched(
      registry.resolveOrMint({
        observation: observation({ text_digest: textDigest("edited") }),
        draft: draft({ display_name: "Raw Source Text v2" }),
        ...OWNER
      })
    );

    expect(reimported.entity.entity_id).toBe(first.entity.entity_id);
    expect(reimported.entity.display_name).toBe("Curated Name");
  });
});

describe("an id Atlas has returned resolves forever", () => {
  it("keeps answering after a merge, and says it was redirected", () => {
    const registry = new EntityRegistry({ clock: fixedClock().now });
    const duplicate = registry.register(draft({ display_name: "A. Person" }), OWNER);
    const canonical = registry.register(draft({ display_name: "Alexandra Person" }), OWNER);

    merged(
      registry.merge({
        basis: "mechanical-migration",
        from: duplicate.entity_id,
        into: canonical.entity_id,
        reason: "same normalized handle in the import",
        ...OWNER
      })
    );

    const result = resolved(registry.resolve(duplicate.entity_id));
    expect(result.entity.entity_id).toBe(canonical.entity_id);
    expect(result.redirected_from).toBe(duplicate.entity_id);
    expect(result.redirect_chain).toEqual([duplicate.entity_id, canonical.entity_id]);
    expect(result.redirect_reason).toBe("same normalized handle in the import");
    // The merged-away entity is not deleted; its record is still readable.
    expect(registry.read(duplicate.entity_id)?.display_name).toBe("A. Person");
  });

  it("follows a chain and reports every hop", () => {
    const registry = new EntityRegistry({ clock: fixedClock().now });
    const first = registry.register(draft(), OWNER);
    const second = registry.register(draft(), OWNER);
    const third = registry.register(draft(), OWNER);

    merged(
      registry.merge({
        basis: "mechanical-migration",
        from: first.entity_id,
        into: second.entity_id,
        reason: "first pass",
        ...OWNER
      })
    );
    merged(
      registry.merge({
        basis: "mechanical-migration",
        from: second.entity_id,
        into: third.entity_id,
        reason: "second pass",
        ...OWNER
      })
    );

    const result = resolved(registry.resolve(first.entity_id));
    expect(result.entity.entity_id).toBe(third.entity_id);
    expect(result.redirect_chain).toEqual([first.entity_id, second.entity_id, third.entity_id]);
    expect(result.redirect_rows.map((row) => row.reason)).toEqual(["first pass", "second pass"]);
    // The reason reported is the hop that moved the id the CALLER holds.
    expect(result.redirect_reason).toBe("first pass");
  });

  it("resolves a legacy id Atlas never minted", () => {
    const registry = new EntityRegistry({ clock: fixedClock().now });
    const entity = registry.register(draft(), OWNER);
    merged(
      registry.merge({
        basis: "mechanical-migration",
        from: "legacy-object-0001",
        into: entity.entity_id,
        reason: "carried across the format change",
        ...OWNER
      })
    );

    expect(resolved(registry.resolve("legacy-object-0001")).entity.entity_id).toBe(entity.entity_id);
  });

  it("states why a legacy id was not carried forward, instead of a bare not-found", () => {
    const registry = new EntityRegistry({ clock: fixedClock().now });
    registry.recordMigrationDisposition({
      old_id: "legacy-object-0002",
      disposition: "content-unrecoverable",
      reason: "ciphertext could not be decrypted with any retained key",
      client_id: "migrator"
    });

    const result = refused(registry.resolve("legacy-object-0002"));
    expect(result.code).toBe("not-carried-forward");
    if (result.code !== "not-carried-forward") throw new Error("unreachable");
    expect(result.disposition).toBe("content-unrecoverable");
    // A dropped record and a typo are different answers, and stay different.
    expect(refused(registry.resolve("legacy-object-9999")).code).toBe("unknown-id");
  });
});

describe("redirect resolution always terminates", () => {
  it("rejects a cycle instead of looping", () => {
    // A correct writer refuses to create this; a hand-edited or tampered ledger
    // can still contain one, and the read path has to survive it.
    const left = mintEntityId(new Date("2026-01-01T00:00:00Z"));
    const right = mintEntityId(new Date("2026-01-01T00:00:01Z"));
    const registry = new EntityRegistry({
      restored: restoredFrom(
        [entityFixture(left, "Left"), entityFixture(right, "Right")],
        sealedLedger([
          { old_id: left, new_id: right },
          { old_id: right, new_id: left }
        ])
      )
    });

    const result = refused(registry.resolve(left));
    expect(result.code).toBe("redirect-cycle");
    if (result.code !== "redirect-cycle") throw new Error("unreachable");
    expect(result.redirect_chain).toEqual([left, right, left]);
  });

  it("caps chain depth with a typed error rather than walking forever", () => {
    const ids = [0, 1, 2, 3].map((offset) =>
      mintEntityId(new Date(Date.UTC(2026, 0, 1, 0, 0, offset)))
    );
    const [a, b, c, d] = ids as [EntityId, EntityId, EntityId, EntityId];
    const registry = new EntityRegistry({
      maxRedirectDepth: 2,
      restored: restoredFrom(
        [entityFixture(d, "Final")],
        sealedLedger([
          { old_id: a, new_id: b },
          { old_id: b, new_id: c },
          { old_id: c, new_id: d }
        ])
      )
    });

    const result = refused(registry.resolve(a));
    expect(result.code).toBe("redirect-chain-too-long");
    if (result.code !== "redirect-chain-too-long") throw new Error("unreachable");
    expect(result.max_depth).toBe(2);
    // The cap bounds the walk without shortening a legal chain: two hops still resolve.
    expect(resolved(registry.resolve(b)).entity.entity_id).toBe(d);
  });

  it("refuses at write time to close a loop", () => {
    const registry = new EntityRegistry({ clock: fixedClock().now });
    const first = registry.register(draft(), OWNER);
    const second = registry.register(draft(), OWNER);
    merged(
      registry.merge({
        basis: "mechanical-migration",
        from: first.entity_id,
        into: second.entity_id,
        reason: "forward",
        ...OWNER
      })
    );

    const back = registry.merge({
      basis: "mechanical-migration",
      from: second.entity_id,
      into: first.entity_id,
      reason: "backward",
      ...OWNER
    });

    expect(back.ok).toBe(false);
    if (back.ok) throw new Error("unreachable");
    expect(back.code).toBe("merge-would-create-cycle");
    expect(registry.ledger).toHaveLength(1);
  });

  it("refuses a second successor for one id", () => {
    const registry = new EntityRegistry({ clock: fixedClock().now });
    const source = registry.register(draft(), OWNER);
    const first = registry.register(draft(), OWNER);
    const second = registry.register(draft(), OWNER);
    merged(
      registry.merge({
        basis: "mechanical-migration",
        from: source.entity_id,
        into: first.entity_id,
        reason: "first decision",
        ...OWNER
      })
    );

    const conflicting = registry.merge({
      basis: "mechanical-migration",
      from: source.entity_id,
      into: second.entity_id,
      reason: "second decision",
      ...OWNER
    });

    expect(conflicting.ok).toBe(false);
    if (conflicting.ok) throw new Error("unreachable");
    expect(conflicting.code).toBe("alias-already-redirected");
    expect(resolved(registry.resolve(source.entity_id)).entity.entity_id).toBe(first.entity_id);
  });

  it("reports a redirect that points at nothing as an integrity failure", () => {
    const missing = mintEntityId(new Date("2026-01-01T00:00:02Z"));
    const start = mintEntityId(new Date("2026-01-01T00:00:00Z"));
    const registry = new EntityRegistry({
      restored: restoredFrom([entityFixture(start, "Start")], sealedLedger([{ old_id: start, new_id: missing }]))
    });

    const result = refused(registry.resolve(start));
    expect(result.code).toBe("redirect-dangling");
    if (result.code !== "redirect-dangling") throw new Error("unreachable");
    expect(result.missing_id).toBe(missing);
  });

  it("refuses to merge into an id that does not resolve", () => {
    const registry = new EntityRegistry({ clock: fixedClock().now });
    const source = registry.register(draft(), OWNER);
    const nowhere = mintEntityId(new Date("2026-01-01T00:00:00Z"));

    const result = registry.merge({
      basis: "mechanical-migration",
      from: source.entity_id,
      into: nowhere,
      reason: "target was never registered",
      ...OWNER
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("merge-target-unresolvable");
    expect(registry.ledger).toHaveLength(0);
  });
});

describe("redirects are not assertions", () => {
  it("writes no assertion for a mechanical migration redirect", () => {
    // Every object goes through this path. Routing them through the assertion
    // layer would mean inventing an evidence record for each, which is exactly
    // the provenance pollution the split exists to prevent.
    const clock = fixedClock();
    const assertions = new AssertionLog({ clock: clock.now });
    const registry = new EntityRegistry({
      clock: clock.now,
      resolutions: assertionLogResolutions(assertions)
    });
    const canonical = registry.register(draft(), OWNER);

    for (let index = 0; index < 3; index += 1) {
      const duplicate = registry.register(draft(), OWNER);
      const result = merged(
        registry.merge({
          basis: "mechanical-migration",
          from: duplicate.entity_id,
          into: canonical.entity_id,
          reason: "mechanical carry-forward",
          ...OWNER
        })
      );
      expect(result.resolution_assertion_id).toBeNull();
      expect(result.row.resolution_assertion_id).toBeNull();
    }

    expect(registry.ledger).toHaveLength(3);
    expect(assertions.size).toBe(0);
  });

  it("writes a resolution assertion carrying the evidence for an owner merge", () => {
    const clock = fixedClock();
    const assertions = new AssertionLog({ clock: clock.now });
    const registry = new EntityRegistry({
      clock: clock.now,
      resolutions: assertionLogResolutions(assertions)
    });
    const duplicate = registry.register(draft(), OWNER);
    const canonical = registry.register(draft(), OWNER);

    const result = merged(
      registry.merge({
        basis: "owner-resolution",
        from: duplicate.entity_id,
        into: canonical.entity_id,
        reason: "owner confirmed these are one person",
        evidence_links: [{ evidence_id: "ev-interview-note", stance: "supports" }],
        confidence: { band: "high", rationale: "confirmed in conversation" },
        idempotency_key: "merge-1",
        ...OWNER
      })
    );

    expect(assertions.size).toBe(1);
    const assertionId = result.resolution_assertion_id;
    if (!assertionId) throw new Error("expected an owner merge to produce an assertion");
    expect(result.row.resolution_assertion_id).toBe(assertionId);

    const assertion = assertions.read(assertionId);
    if (!assertion) throw new Error("expected the resolution assertion to be readable");
    expect(assertion.subject_entity_id).toBe(duplicate.entity_id);
    expect(assertion.target_entity_id).toBe(canonical.entity_id);
    expect(assertion.evidence_links).toEqual([
      { evidence_id: "ev-interview-note", stance: "supports" }
    ]);
  });

  it("refuses an owner merge when there is nowhere to record the evidence", () => {
    const registry = new EntityRegistry({ clock: fixedClock().now });
    const duplicate = registry.register(draft(), OWNER);
    const canonical = registry.register(draft(), OWNER);

    const result = registry.merge({
      basis: "owner-resolution",
      from: duplicate.entity_id,
      into: canonical.entity_id,
      reason: "owner decision",
      evidence_links: [{ evidence_id: "ev-1", stance: "supports" }],
      confidence: { band: "high" },
      idempotency_key: "merge-1",
      ...OWNER
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("resolution-recorder-required");
    // No redirect either: the row and its evidence stand or fall together.
    expect(registry.ledger).toHaveLength(0);
    expect(resolved(registry.resolve(duplicate.entity_id)).entity.entity_id).toBe(duplicate.entity_id);
  });

  it("produces a record shape that is not an assertion", () => {
    // Structural, not conventional: an alias row must never be mistakable for
    // an assertion by anything that parses the graph.
    const registry = new EntityRegistry({ clock: fixedClock().now });
    const duplicate = registry.register(draft(), OWNER);
    const canonical = registry.register(draft(), OWNER);
    const result = merged(
      registry.merge({
        basis: "mechanical-migration",
        from: duplicate.entity_id,
        into: canonical.entity_id,
        reason: "mechanical",
        ...OWNER
      })
    );

    expect(AssertionSchema.safeParse(result.row).success).toBe(false);
  });
});

describe("splitting refuses to guess", () => {
  it("creates the new entities and redirects the old id ambiguously", () => {
    const registry = new EntityRegistry({ clock: fixedClock().now });
    const conflated = registry.register(draft({ display_name: "J. Smith" }), OWNER);

    const result = splitOk(
      registry.split({
        basis: "mechanical-migration",
        from: conflated.entity_id,
        into: [draft({ display_name: "Jane Smith" }), draft({ display_name: "John Smith" })],
        reason: "two people were filed under one name",
        ...OWNER
      })
    );

    expect(result.created).toHaveLength(2);
    const refusal = refused(registry.resolve(conflated.entity_id));
    expect(refusal.code).toBe("ambiguous-split");
    if (refusal.code !== "ambiguous-split") throw new Error("unreachable");
    expect(refusal.candidate_ids).toEqual(result.created.map((entity) => entity.entity_id));
    // Each new entity resolves to itself; only the conflated id is ambiguous.
    for (const created of result.created) {
      expect(resolved(registry.resolve(created.entity_id)).entity.entity_id).toBe(created.entity_id);
    }
  });

  it("writes a resolution assertion only when a person decided it", () => {
    const clock = fixedClock();
    const assertions = new AssertionLog({ clock: clock.now });
    const registry = new EntityRegistry({
      clock: clock.now,
      resolutions: assertionLogResolutions(assertions)
    });

    const mechanical = registry.register(draft(), OWNER);
    splitOk(
      registry.split({
        basis: "mechanical-migration",
        from: mechanical.entity_id,
        into: [draft(), draft()],
        reason: "importer found two source records",
        ...OWNER
      })
    );
    expect(assertions.size).toBe(0);

    const ownerDecided = registry.register(draft(), OWNER);
    const result = splitOk(
      registry.split({
        basis: "owner-resolution",
        from: ownerDecided.entity_id,
        into: [draft(), draft()],
        reason: "owner identified two distinct people",
        evidence_links: [{ evidence_id: "ev-2", stance: "supports" }],
        confidence: { band: "medium" },
        idempotency_key: "split-1",
        ...OWNER
      })
    );

    expect(assertions.size).toBe(1);
    expect(result.resolution_assertion_id).not.toBeNull();
  });

  it("refuses a split into fewer than two entities", () => {
    const registry = new EntityRegistry({ clock: fixedClock().now });
    const entity = registry.register(draft(), OWNER);
    const result = registry.split({
      basis: "mechanical-migration",
      from: entity.entity_id,
      into: [draft()],
      reason: "not actually a split",
      ...OWNER
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("split-needs-two-candidates");
  });
});

describe("the ledger is append-only, and says so checkably", () => {
  it("verifies a chain the registry wrote", () => {
    const registry = new EntityRegistry({ clock: fixedClock().now });
    const canonical = registry.register(draft(), OWNER);
    for (let index = 0; index < 4; index += 1) {
      const duplicate = registry.register(draft(), OWNER);
      merged(
        registry.merge({
          basis: "mechanical-migration",
          from: duplicate.entity_id,
          into: canonical.entity_id,
          reason: `pass ${index}`,
          ...OWNER
        })
      );
    }

    const integrity = registry.verifyLedger();
    expect(integrity.ok).toBe(true);
    if (!integrity.ok) throw new Error("unreachable");
    expect(integrity.rows).toBe(4);
  });

  it("detects a row edited in place", () => {
    const registry = new EntityRegistry({ clock: fixedClock().now });
    const duplicate = registry.register(draft(), OWNER);
    const canonical = registry.register(draft(), OWNER);
    merged(
      registry.merge({
        basis: "mechanical-migration",
        from: duplicate.entity_id,
        into: canonical.entity_id,
        reason: "original reason",
        ...OWNER
      })
    );

    const rows = [...registry.ledger];
    const first = rows[0];
    if (!first) throw new Error("expected a row");
    const tampered = { ...first, reason: "a reason nobody wrote" } as AliasRow;

    const integrity = verifyAliasLedger([tampered]);
    expect(integrity.ok).toBe(false);
    if (integrity.ok) throw new Error("unreachable");
    expect(integrity.code).toBe("ledger-chain-broken");
    // The row itself still parses; only the chain reveals the edit.
    expect(aliasLedgerDigest(unsealAliasRow(tampered))).not.toBe(first.ledger_digest);
  });

  it("detects a row removed from the middle", () => {
    const rows = sealedLedger([
      { old_id: "legacy-1", new_id: mintEntityId(new Date("2026-01-01T00:00:00Z")) },
      { old_id: "legacy-2", new_id: mintEntityId(new Date("2026-01-01T00:00:01Z")) },
      { old_id: "legacy-3", new_id: mintEntityId(new Date("2026-01-01T00:00:02Z")) }
    ]);
    const withHole = [rows[0], rows[2]].flatMap((row) => (row ? [row] : []));

    const integrity = verifyAliasLedger(withHole);
    expect(integrity.ok).toBe(false);
    if (integrity.ok) throw new Error("unreachable");
    expect(integrity.code).toBe("ledger-seq-broken");
  });
});
