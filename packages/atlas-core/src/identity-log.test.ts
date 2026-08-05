import { appendFileSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DurableAssertionLog } from "./durable-log.js";
import type { EntityDraft, SourceObservation } from "./entity.js";
import { assertionLogResolutions, type IdentityMatch, type MergeResult, type Resolution } from "./entity-registry.js";
import { DurableEntityRegistry } from "./identity-log.js";
import { LOG_FORMAT } from "./log-record.js";
import { SegmentLogError } from "./segment-reader.js";
import { segmentFileName } from "./segment-writer.js";

/**
 * Synthetic fixtures in a throwaway directory, always. Nothing in this file may
 * touch a real graph, and nothing it writes outlives the test.
 */
const directories: string[] = [];

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "atlas-core-identity-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

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

function observation(overrides: Partial<SourceObservation> = {}): SourceObservation {
  return {
    source_path_ref: "pages/fixture-page.md",
    block_ordinal: 4,
    text_digest: "digest-v1",
    ...overrides
  };
}

function resolved(result: Resolution) {
  if (!result.ok) throw new Error(`expected the id to resolve: ${result.code}`);
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

/** Path of the first segment, for the damage the tests have to simulate. */
function firstSegment(directory: string): string {
  return join(directory, segmentFileName(1));
}

describe("the identity log round trips", () => {
  it("reloads entities, ledger rows, and the chain that seals them", () => {
    const directory = tempDirectory();
    const clock = fixedClock();

    const first = DurableEntityRegistry.open({ directory, clock: clock.now });
    const canonical = first.registry.register(draft({ display_name: "Canonical" }), OWNER);
    const duplicate = first.registry.register(draft({ display_name: "Duplicate" }), OWNER);
    merged(
      first.registry.merge({
        basis: "mechanical-migration",
        from: duplicate.entity_id,
        into: canonical.entity_id,
        reason: "same source record",
        ...OWNER
      })
    );
    first.close();

    const reopened = DurableEntityRegistry.open({ directory, clock: clock.now });
    expect(reopened.report.entities).toBe(2);
    expect(reopened.report.alias_rows).toBe(1);
    expect(reopened.registry.read(canonical.entity_id)).toEqual(canonical);
    expect(reopened.registry.verifyLedger().ok).toBe(true);

    const after = resolved(reopened.registry.resolve(duplicate.entity_id));
    expect(after.entity.entity_id).toBe(canonical.entity_id);
    expect(after.redirected_from).toBe(duplicate.entity_id);
    reopened.close();
  });

  it("continues the ledger rather than restarting it", () => {
    const directory = tempDirectory();
    const clock = fixedClock();

    const first = DurableEntityRegistry.open({ directory, clock: clock.now });
    const canonical = first.registry.register(draft(), OWNER);
    const early = first.registry.register(draft(), OWNER);
    merged(
      first.registry.merge({
        basis: "mechanical-migration",
        from: early.entity_id,
        into: canonical.entity_id,
        reason: "before the restart",
        ...OWNER
      })
    );
    first.close();

    const reopened = DurableEntityRegistry.open({ directory, clock: clock.now });
    const late = reopened.registry.register(draft(), OWNER);
    const second = merged(
      reopened.registry.merge({
        basis: "mechanical-migration",
        from: late.entity_id,
        into: canonical.entity_id,
        reason: "after the restart",
        ...OWNER
      })
    );

    // A restart must not reuse row 1, or the hash chain would fork.
    expect(second.row.row_seq).toBe(2);
    expect(reopened.registry.verifyLedger().ok).toBe(true);
    reopened.close();
  });

  it("keeps carrying ids forward after a restart", () => {
    // The identity index is what makes a re-import find an id it already
    // minted. If it did not survive a restart, the next import would mint a
    // second entity for the same source record — the duplicate explosion again.
    const directory = tempDirectory();
    const clock = fixedClock();

    const first = DurableEntityRegistry.open({ directory, clock: clock.now });
    const original = matched(
      first.registry.resolveOrMint({ observation: observation(), draft: draft(), ...OWNER })
    );
    first.close();

    const reopened = DurableEntityRegistry.open({ directory, clock: clock.now });
    const reimported = matched(
      reopened.registry.resolveOrMint({
        observation: observation({ text_digest: "digest-v2" }),
        draft: draft(),
        ...OWNER
      })
    );

    expect(reimported.entity.entity_id).toBe(original.entity.entity_id);
    expect(reimported.carried_forward).toBe(true);
    expect(reopened.registry.size).toBe(1);
    reopened.close();
  });

  it("keeps an owner merge's evidence and its redirect together across a restart", () => {
    const assertionDirectory = tempDirectory();
    const identityDirectory = tempDirectory();
    const clock = fixedClock();

    const assertions = DurableAssertionLog.open({
      directory: assertionDirectory,
      clock: clock.now,
      bitemporalSince: "2026-01-01T00:00:00.000Z"
    });
    const identity = DurableEntityRegistry.open({
      directory: identityDirectory,
      clock: clock.now,
      resolutions: assertionLogResolutions(assertions)
    });

    const duplicate = identity.registry.register(draft(), OWNER);
    const canonical = identity.registry.register(draft(), OWNER);
    const result = merged(
      identity.registry.merge({
        basis: "owner-resolution",
        from: duplicate.entity_id,
        into: canonical.entity_id,
        reason: "owner confirmed one person",
        evidence_links: [{ evidence_id: "ev-1", stance: "supports" }],
        confidence: { band: "high" },
        idempotency_key: "merge-1",
        ...OWNER
      })
    );
    assertions.close();
    identity.close();

    const reopenedAssertions = DurableAssertionLog.open({
      directory: assertionDirectory,
      clock: clock.now
    });
    const reopenedIdentity = DurableEntityRegistry.open({
      directory: identityDirectory,
      clock: clock.now
    });

    const assertionId = result.resolution_assertion_id;
    if (!assertionId) throw new Error("expected an owner merge to produce an assertion");
    expect(reopenedAssertions.read(assertionId)?.subject_entity_id).toBe(duplicate.entity_id);

    const row = reopenedIdentity.registry.ledger[0];
    if (!row) throw new Error("expected the ledger row to survive");
    expect(row.resolution_assertion_id).toBe(assertionId);
    reopenedAssertions.close();
    reopenedIdentity.close();
  });
});

describe("damage is detected, and only repaired where it is possible", () => {
  it("discards a group that died before its commit marker", () => {
    const directory = tempDirectory();
    const clock = fixedClock();

    const first = DurableEntityRegistry.open({ directory, clock: clock.now });
    const kept = first.registry.register(draft({ display_name: "Committed" }), OWNER);
    first.registry.register(draft({ display_name: "Never acknowledged" }), OWNER);
    first.close();

    // Simulate a crash between the entity record and its commit marker.
    const bytes = readFileSync(firstSegment(directory));
    const lastNewline = bytes.lastIndexOf(0x0a);
    const previousNewline = bytes.subarray(0, lastNewline).lastIndexOf(0x0a);
    truncateSync(firstSegment(directory), previousNewline + 1);

    const reopened = DurableEntityRegistry.open({ directory, clock: clock.now });
    expect(reopened.report.entities).toBe(1);
    expect(reopened.registry.read(kept.entity_id)).toBeDefined();
    expect(reopened.report.repairs.map((repair) => repair.reason)).toEqual(["incomplete-commit"]);
    reopened.close();
  });

  it("drops a partial final line and records what was discarded", () => {
    const directory = tempDirectory();
    const clock = fixedClock();

    const first = DurableEntityRegistry.open({ directory, clock: clock.now });
    const kept = first.registry.register(draft(), OWNER);
    first.close();
    appendFileSync(firstSegment(directory), '{"record":"entity","group_seq":2,"enti');

    const reopened = DurableEntityRegistry.open({ directory, clock: clock.now });
    expect(reopened.report.entities).toBe(1);
    expect(reopened.registry.read(kept.entity_id)).toBeDefined();
    const repair = reopened.report.repairs[0];
    if (!repair) throw new Error("expected the torn tail to be reported");
    expect(repair.reason).toBe("torn-tail");
    expect(repair.discarded_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    reopened.close();

    // Truncation is real, not skip-on-read: a third open finds nothing to repair.
    const third = DurableEntityRegistry.open({ directory, clock: clock.now });
    expect(third.report.repairs).toEqual([]);
    third.close();
  });

  it("refuses a group whose commit marker names a record that is no longer there", () => {
    // A group that closes cleanly with a member missing would silently retire
    // an id a caller was already handed. The marker names its members so that
    // is detectable rather than invisible.
    const directory = tempDirectory();
    const clock = fixedClock();
    const first = DurableEntityRegistry.open({ directory, clock: clock.now });
    first.registry.register(draft({ display_name: "First" }), OWNER);
    first.registry.register(draft({ display_name: "Second" }), OWNER);
    first.close();

    const lines = readFileSync(firstSegment(directory), "utf8").split("\n").filter(Boolean);
    const withoutEntity = lines.filter(
      (line, index) => !(index > 0 && line.includes('"record":"entity"') && index === 1)
    );
    writeFileSync(firstSegment(directory), `${withoutEntity.join("\n")}\n`);

    expect(() => DurableEntityRegistry.open({ directory, clock: clock.now })).toThrow(
      SegmentLogError
    );
  });

  it("refuses a record that a later group's marker tries to close over", () => {
    // Groups are written one call at a time and cannot interleave, so a member
    // carrying a different group number was not produced by a writer.
    const directory = tempDirectory();
    const clock = fixedClock();
    const first = DurableEntityRegistry.open({ directory, clock: clock.now });
    first.registry.register(draft(), OWNER);
    first.close();

    const lines = readFileSync(firstSegment(directory), "utf8").split("\n").filter(Boolean);
    const rewritten = lines.map((line) => {
      const record = JSON.parse(line) as { record: string; group_seq?: number };
      if (record.record !== "entity") return line;
      return JSON.stringify({ ...record, group_seq: 99 });
    });
    writeFileSync(firstSegment(directory), `${rewritten.join("\n")}\n`);

    expect(() => DurableEntityRegistry.open({ directory, clock: clock.now })).toThrow(
      SegmentLogError
    );
  });

  it("refuses a zero-byte segment rather than reading it as an empty ledger", () => {
    const directory = tempDirectory();
    const clock = fixedClock();
    const first = DurableEntityRegistry.open({ directory, clock: clock.now });
    first.registry.register(draft(), OWNER);
    first.close();
    writeFileSync(join(directory, segmentFileName(2)), "");

    expect(() => DurableEntityRegistry.open({ directory, clock: clock.now })).toThrow(
      SegmentLogError
    );
  });
});

describe("the two logs refuse each other's bytes", () => {
  /** Codes that all mean "this file is not mine and I will not guess". */
  const REFUSALS = ["corrupt-record", "format-mismatch", "unknown-record-kind"];

  function codeOf(run: () => void): string {
    try {
      run();
    } catch (error) {
      if (error instanceof SegmentLogError) return error.code;
      throw error;
    }
    throw new Error("expected the load to be refused");
  }

  it("refuses assertion-log segments in the identity directory", () => {
    const directory = tempDirectory();
    const clock = fixedClock();
    const assertions = DurableAssertionLog.open({
      directory,
      clock: clock.now,
      bitemporalSince: "2026-01-01T00:00:00.000Z"
    });
    assertions.close();

    expect(REFUSALS).toContain(codeOf(() => DurableEntityRegistry.open({ directory, clock: clock.now })));
  });

  it("refuses a header that declares the other log's format, by name", () => {
    // The two headers happen to differ in shape today, so a misfiled segment
    // fails as a malformed record. This asserts the guarantee that does not
    // depend on that luck: a well-formed identity header carrying the assertion
    // log's format identifier is refused because of the identifier.
    const directory = tempDirectory();
    const clock = fixedClock();
    writeFileSync(
      join(directory, segmentFileName(1)),
      `${JSON.stringify({
        record: "header",
        log_format: LOG_FORMAT,
        segment_ordinal: 1,
        created_at: "2026-08-04T12:00:00.000Z"
      })}\n`
    );

    expect(codeOf(() => DurableEntityRegistry.open({ directory, clock: clock.now }))).toBe(
      "format-mismatch"
    );
  });

  it("refuses identity-log segments in the assertion directory", () => {
    const directory = tempDirectory();
    const clock = fixedClock();
    const identity = DurableEntityRegistry.open({ directory, clock: clock.now });
    identity.registry.register(draft(), OWNER);
    identity.close();

    expect(REFUSALS).toContain(codeOf(() => DurableAssertionLog.open({ directory, clock: clock.now })));
  });
});
