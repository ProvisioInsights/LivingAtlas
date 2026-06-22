import { describe, expect, it } from "vitest";
import {
  InMemorySyncAuthoritySequencerStorage,
  SyncAuthoritySequencerCore,
  type SyncBatchSequenceSummary
} from "./sync-sequencer";

const firstSummary: SyncBatchSequenceSummary = {
  batch_id: "la_sync_batch_seq00001",
  idempotency_key: "la_idem_seq00001",
  batch_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  authority_id: "la_authority_seq0001",
  batch_fingerprint: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  base_generation: 0,
  target_generation: 1,
  submitted_at: "2026-06-22T00:00:00.000Z",
  object_count: 2,
  change_count: 2,
  withheld_plaintext_count: 0
};

function makeSequencer(): SyncAuthoritySequencerCore {
  return new SyncAuthoritySequencerCore(new InMemorySyncAuthoritySequencerStorage());
}

describe("SyncAuthoritySequencerCore", () => {
  it("stages, commits, and treats duplicate retries as idempotent", async () => {
    const sequencer = makeSequencer();

    await expect(sequencer.stageBatch(firstSummary, "2026-06-22T00:00:01.000Z")).resolves.toMatchObject({
      ok: true,
      state: "staged",
      should_persist: true,
      duplicate: false,
      accepted: {
        batch_id: firstSummary.batch_id,
        target_generation: 1,
        idempotent_replay: false
      }
    });

    await expect(sequencer.stageBatch(firstSummary, "2026-06-22T00:00:02.000Z")).resolves.toMatchObject({
      ok: true,
      state: "staged",
      should_persist: true,
      duplicate: true,
      accepted: {
        idempotent_replay: true
      }
    });

    await expect(sequencer.commitBatch(firstSummary, "2026-06-22T00:00:03.000Z")).resolves.toMatchObject({
      ok: true,
      duplicate: false
    });

    await expect(sequencer.stageBatch(firstSummary, "2026-06-22T00:00:04.000Z")).resolves.toMatchObject({
      ok: true,
      state: "committed",
      should_persist: false,
      duplicate: true,
      accepted: {
        idempotent_replay: true
      }
    });
  });

  it("rejects stale, gap, in-flight, and conflicting retry keys", async () => {
    const sequencer = makeSequencer();
    await sequencer.stageBatch(firstSummary, "2026-06-22T00:00:01.000Z");

    await expect(sequencer.stageBatch({
      ...firstSummary,
      batch_id: "la_sync_batch_seq00002",
      idempotency_key: "la_idem_seq00002"
    }, "2026-06-22T00:00:02.000Z")).resolves.toEqual({
      ok: false,
      reason: "batch-in-flight"
    });

    await expect(sequencer.stageBatch({
      ...firstSummary,
      batch_id: "la_sync_batch_seq00003",
      batch_hash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      batch_fingerprint: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    }, "2026-06-22T00:00:03.000Z")).resolves.toEqual({
      ok: false,
      reason: "batch-conflict"
    });

    await sequencer.commitBatch(firstSummary, "2026-06-22T00:00:04.000Z");

    await expect(sequencer.stageBatch({
      ...firstSummary,
      batch_id: "la_sync_batch_seq00004",
      idempotency_key: "la_idem_seq00004"
    }, "2026-06-22T00:00:05.000Z")).resolves.toEqual({
      ok: false,
      reason: "stale-generation"
    });

    await expect(sequencer.stageBatch({
      ...firstSummary,
      batch_id: "la_sync_batch_seq00005",
      idempotency_key: "la_idem_seq00005",
      base_generation: 3,
      target_generation: 4
    }, "2026-06-22T00:00:06.000Z")).resolves.toEqual({
      ok: false,
      reason: "generation-gap"
    });
  });
});
