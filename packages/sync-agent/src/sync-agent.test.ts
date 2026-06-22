import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sensitiveBaitRegistry } from "@living-atlas/fixtures";
import { createFixtureLocalControlState } from "@living-atlas/local-control-store";
import { FileLocalGraphStore } from "@living-atlas/local-graph-store";
import {
  applyPulledEnvelopes,
  buildCiphertextSyncBatch,
  fetchSyncEnvelopes,
  fetchSyncPull,
  fetchSyncStatus,
  InMemorySyncOutbox,
  nextSyncGenerationFromStatus,
  planSyncFromStatus,
  submitSyncBatch,
  SyntheticLocalSyncDaemon
} from "./sync-agent";

const now = "2026-06-21T12:00:00.000Z";

describe("ciphertext sync agent", () => {
  it("builds a ciphertext-only batch from the fixture graph", async () => {
    const controlState = await createFixtureLocalControlState("sync-agent-local-mcp-token-0001");
    const result = buildCiphertextSyncBatch({
      controlState,
      baseGeneration: 0,
      targetGeneration: 1,
      now
    });

    expect(result.included_object_count).toBe(3);
    expect(result.withheld_plaintext_count).toBe(3);
    expect(result.batch.objects.every((object) => object.payload.kind !== "plaintext-json")).toBe(true);
    expect(result.batch.objects.map((object) => object.object_id)).toEqual([
      "la_object_privatepage0001",
      "la_object_privateedge0001",
      "la_object_quarantine0001"
    ]);
    expect(result.batch.capability_id).toBe("la_cap_sync0001");
    expect(result.batch.idempotency_key).toMatch(/^la_idem_[A-Za-z0-9_-]{8,}$/);
    expect(result.batch.batch_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.batch.object_payloads).toHaveLength(3);
    expect(result.batch.base_cursor).toEqual({
      authority_id: "la_authority_fixture0001",
      generation: 0
    });
    expect(result.batch.pull_recovery).toEqual({
      mode: "none",
      reason: "current"
    });
  });

  it("fetches sync envelopes and applies them to a durable local graph store", async () => {
    const controlState = await createFixtureLocalControlState("sync-agent-envelope-token-0001");
    const { batch } = buildCiphertextSyncBatch({
      controlState,
      baseGeneration: 0,
      targetGeneration: 1,
      now
    });
    const calls: Request[] = [];
    const responseBody = {
      ok: true,
      authority_id: batch.authority_id,
      from_generation: 0,
      latest_generation: 1,
      objects: batch.objects.map((object) => ({
        batch_id: batch.batch_id,
        generation: 1,
        submitted_at: batch.submitted_at,
        object
      })),
      next_cursor: {
        authority_id: batch.authority_id,
        generation: 1,
        batch_id: batch.batch_id
      },
      has_more: false
    };

    const fetched = await fetchSyncEnvelopes({
      endpoint: "https://living-atlas.example",
      authorityId: batch.authority_id,
      afterGeneration: 0,
      syncToken: "fixture-sync-token-0001",
      clientId: batch.client_id,
      capabilityId: batch.capability_id,
      tokenId: "la_sync_token_envelopes0001",
      fetchImpl: async (input, init) => {
        const request = new Request(input, init);
        calls.push(request);
        return new Response(JSON.stringify(responseBody), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    });

    expect(fetched).toMatchObject({
      ok: true,
      response: {
        latest_generation: 1,
        objects: expect.arrayContaining([
          expect.objectContaining({
            object: expect.objectContaining({
              object_id: "la_object_privatepage0001"
            })
          })
        ])
      }
    });
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/api/sync/envelopes");
    expect(url.searchParams.get("authority_id")).toBe(batch.authority_id);
    expect(url.searchParams.get("after_generation")).toBe("0");
    expect(calls[0]!.headers.get("x-living-atlas-sync-token")).toBe("fixture-sync-token-0001");
    expect(calls[0]!.url).not.toContain("fixture-sync-token-0001");

    if (!fetched.ok) {
      throw new Error("expected envelope fetch to succeed");
    }

    const directory = await mkdtemp(join(tmpdir(), "living-atlas-sync-apply-"));
    try {
      const store = await FileLocalGraphStore.open({
        directory,
        authorityId: batch.authority_id,
        plaintextPersistence: "redact"
      });
      const applied = await applyPulledEnvelopes({
        store,
        response: fetched.response,
        actorId: batch.client_id
      });

      expect(applied).toEqual({
        ok: true,
        applied_count: 3,
        skipped_count: 0,
        conflict_count: 0,
        cursor: {
          authority_id: batch.authority_id,
          generation: 1,
          batch_id: batch.batch_id
        },
        conflicts: []
      });
      expect(store.status()).toMatchObject({
        generation: 3,
        object_count: 3
      });
      expect(store.readObject("la_object_privatepage0001")).toEqual(expect.objectContaining({
        payload: expect.objectContaining({
          kind: "ciphertext-ref"
        })
      }));

      const replay = await applyPulledEnvelopes({
        store,
        response: fetched.response,
        actorId: batch.client_id
      });
      expect(replay).toMatchObject({
        ok: true,
        applied_count: 0,
        skipped_count: 3,
        conflict_count: 0
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not advance the sync cursor beyond a conflicted envelope generation", async () => {
    const controlState = await createFixtureLocalControlState("sync-agent-conflict-token-0001");
    const { batch } = buildCiphertextSyncBatch({
      controlState,
      baseGeneration: 0,
      targetGeneration: 1,
      now
    });
    const conflictedObject = {
      ...batch.objects[0]!,
      version: 2,
      updated_at: "2026-06-21T12:01:00.000Z"
    };
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-sync-conflict-"));
    try {
      const store = await FileLocalGraphStore.open({
        directory,
        authorityId: batch.authority_id,
        plaintextPersistence: "redact"
      });
      const applied = await applyPulledEnvelopes({
        store,
        actorId: batch.client_id,
        response: {
          ok: true,
          authority_id: batch.authority_id,
          from_generation: 1,
          latest_generation: 2,
          objects: [
            {
              batch_id: "la_sync_batch_conflict0001",
              generation: 2,
              submitted_at: now,
              object: conflictedObject
            }
          ],
          next_cursor: {
            authority_id: batch.authority_id,
            generation: 2,
            batch_id: "la_sync_batch_conflict0001"
          },
          has_more: false
        }
      });

      expect(applied).toEqual({
        ok: false,
        applied_count: 0,
        skipped_count: 0,
        conflict_count: 1,
        cursor: {
          authority_id: batch.authority_id,
          generation: 1
        },
        conflicts: [
          {
            object_id: conflictedObject.object_id,
            remote_generation: 2,
            remote_version: 2,
            reason: "version-gap"
          }
        ]
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not serialize synthetic sensitive bait into sync batches", async () => {
    const controlState = await createFixtureLocalControlState("sync-agent-bait-token-0001");
    const { batch } = buildCiphertextSyncBatch({
      controlState,
      baseGeneration: 0,
      targetGeneration: 1,
      now
    });

    const serialized = JSON.stringify(batch);
    for (const bait of sensitiveBaitRegistry) {
      expect(serialized).not.toContain(bait.value);
    }
  });

  it("submits batches to the Worker sync endpoint with the sync token in a header", async () => {
    const controlState = await createFixtureLocalControlState("sync-agent-submit-token-0001");
    const { batch } = buildCiphertextSyncBatch({
      controlState,
      baseGeneration: 0,
      targetGeneration: 1,
      now
    });

    const calls: Request[] = [];
    const result = await submitSyncBatch({
      endpoint: "https://living-atlas.example",
      batch,
      syncToken: "fixture-sync-token-0001",
      fetchImpl: async (input, init) => {
        const request = new Request(input, init);
        calls.push(request);
        return new Response(JSON.stringify({
          ok: true,
          batch_id: batch.batch_id,
          accepted_objects: batch.objects.length,
          accepted_changes: batch.changes.length,
          target_generation: batch.target_generation,
          withheld_plaintext_count: batch.withheld_plaintext_count
        }), {
          status: 202,
          headers: { "content-type": "application/json" }
        });
      }
    });

    expect(result).toEqual({
      ok: true,
      accepted: {
        ok: true,
        batch_id: batch.batch_id,
        accepted_objects: 3,
        accepted_changes: 3,
        target_generation: 1,
        withheld_plaintext_count: 3
      }
    });
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).pathname).toBe("/api/sync/batch");
    expect(calls[0]!.headers.get("x-living-atlas-sync-token")).toBe("fixture-sync-token-0001");
    expect(calls[0]!.headers.get("x-living-atlas-sync-client-id")).toBe("la_client_sync0001");
    expect(calls[0]!.headers.get("x-living-atlas-sync-capability-id")).toBe("la_cap_sync0001");
    expect(calls[0]!.url).not.toContain("fixture-sync-token-0001");
  });

  it("fetches remote sync status without putting the sync token in the URL", async () => {
    const calls: Request[] = [];
    const result = await fetchSyncStatus({
      endpoint: "https://living-atlas.example",
      syncToken: "fixture-sync-token-0001",
      clientId: "la_client_sync0001",
      capabilityId: "la_cap_sync0001",
      tokenId: "la_sync_token_status0001",
      fetchImpl: async (input, init) => {
        const request = new Request(input, init);
        calls.push(request);
        return new Response(JSON.stringify({
          ok: true,
          latest_generation: 7,
          latest_batch_id: "la_sync_batch_status0001",
          authority_id: "la_authority_fixture0001",
          latest_submitted_at: now,
          object_count: 9,
          change_count: 11,
          latest_withheld_plaintext_count: 3
        }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    });

    expect(result).toEqual({
      ok: true,
      status: {
        ok: true,
        latest_generation: 7,
        latest_batch_id: "la_sync_batch_status0001",
        authority_id: "la_authority_fixture0001",
        latest_submitted_at: now,
        object_count: 9,
        change_count: 11,
        latest_withheld_plaintext_count: 3
      }
    });
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).pathname).toBe("/api/sync/status");
    expect(calls[0]!.headers.get("x-living-atlas-sync-token")).toBe("fixture-sync-token-0001");
    expect(calls[0]!.headers.get("x-living-atlas-sync-client-id")).toBe("la_client_sync0001");
    expect(calls[0]!.headers.get("x-living-atlas-sync-capability-id")).toBe("la_cap_sync0001");
    expect(calls[0]!.headers.get("x-living-atlas-sync-token-id")).toBe("la_sync_token_status0001");
    expect(calls[0]!.url).not.toContain("fixture-sync-token-0001");
  });

  it("fetches pull summaries with cursor parameters and bound headers", async () => {
    const calls: Request[] = [];
    const result = await fetchSyncPull({
      endpoint: "https://living-atlas.example",
      authorityId: "la_authority_fixture0001",
      afterGeneration: 7,
      syncToken: "fixture-sync-token-0001",
      clientId: "la_client_sync0001",
      capabilityId: "la_cap_sync0001",
      tokenId: "la_sync_token_pull0001",
      fetchImpl: async (input, init) => {
        const request = new Request(input, init);
        calls.push(request);
        return new Response(JSON.stringify({
          ok: true,
          authority_id: "la_authority_fixture0001",
          from_generation: 7,
          latest_generation: 8,
          batches: [
            {
              batch_id: "la_sync_batch_pull0001",
              batch_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              base_generation: 7,
              target_generation: 8,
              submitted_at: now,
              object_count: 2,
              change_count: 2,
              withheld_plaintext_count: 0
            }
          ],
          next_cursor: {
            authority_id: "la_authority_fixture0001",
            generation: 8,
            batch_id: "la_sync_batch_pull0001"
          },
          recovery: {
            mode: "replay",
            from_generation: 7,
            reason: "local-cursor-behind"
          },
          has_more: false
        }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    });

    expect(result).toMatchObject({
      ok: true,
      response: {
        latest_generation: 8,
        next_cursor: {
          generation: 8,
          batch_id: "la_sync_batch_pull0001"
        }
      }
    });
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/api/sync/pull");
    expect(url.searchParams.get("authority_id")).toBe("la_authority_fixture0001");
    expect(url.searchParams.get("after_generation")).toBe("7");
    expect(calls[0]!.headers.get("x-living-atlas-sync-token")).toBe("fixture-sync-token-0001");
    expect(calls[0]!.headers.get("x-living-atlas-sync-client-id")).toBe("la_client_sync0001");
    expect(calls[0]!.headers.get("x-living-atlas-sync-capability-id")).toBe("la_cap_sync0001");
    expect(calls[0]!.headers.get("x-living-atlas-sync-token-id")).toBe("la_sync_token_pull0001");
    expect(calls[0]!.url).not.toContain("fixture-sync-token-0001");
  });

  it("derives the next batch generation from remote status", () => {
    expect(nextSyncGenerationFromStatus({
      ok: true,
      latest_generation: 7,
      latest_batch_id: "la_sync_batch_status0001",
      authority_id: "la_authority_fixture0001",
      latest_submitted_at: now,
      object_count: 9,
      change_count: 11,
      latest_withheld_plaintext_count: 3
    })).toEqual({
      base_generation: 7,
      target_generation: 8
    });
  });

  it("tracks a local outbox cursor and plans push, pull, and recovery", async () => {
    const controlState = await createFixtureLocalControlState("sync-agent-outbox-token-0001");
    const { batch } = buildCiphertextSyncBatch({
      controlState,
      baseGeneration: 0,
      targetGeneration: 1,
      now
    });
    const outbox = new InMemorySyncOutbox();

    const firstRecord = outbox.enqueue(batch, now);
    expect(outbox.enqueue(batch, now)).toBe(firstRecord);
    expect(outbox.pendingCount()).toBe(1);
    expect(planSyncFromStatus({
      localCursor: outbox.cursor(batch.authority_id),
      remoteStatus: {
        ok: true,
        latest_generation: 0,
        object_count: 0,
        change_count: 0,
        latest_withheld_plaintext_count: 0
      },
      pendingOutboxCount: outbox.pendingCount()
    })).toMatchObject({
      action: "push",
      next_generation: 1
    });

    outbox.markAccepted(batch.idempotency_key, now);
    expect(outbox.cursor(batch.authority_id)).toEqual({
      authority_id: batch.authority_id,
      generation: 1,
      batch_id: batch.batch_id
    });

    expect(planSyncFromStatus({
      localCursor: outbox.cursor(batch.authority_id),
      remoteStatus: {
        ok: true,
        latest_generation: 3,
        object_count: 7,
        change_count: 9,
        latest_withheld_plaintext_count: 0
      }
    })).toMatchObject({
      action: "pull",
      pull_after_generation: 1,
      recovery: {
        mode: "replay",
        from_generation: 1
      }
    });

    expect(planSyncFromStatus({
      localCursor: {
        authority_id: batch.authority_id,
        generation: 5
      },
      remoteStatus: {
        ok: true,
        latest_generation: 3,
        object_count: 7,
        change_count: 9,
        latest_withheld_plaintext_count: 0
      }
    })).toMatchObject({
      action: "recover",
      recovery: {
        mode: "snapshot-catchup",
        from_generation: 3
      }
    });
  });

  it("queues a synthetic daemon ciphertext batch from remote status without network calls", async () => {
    const controlState = await createFixtureLocalControlState("sync-agent-daemon-queue-token-0001");
    let calledNetwork = false;
    const daemon = new SyntheticLocalSyncDaemon({
      controlState,
      fetchImpl: async () => {
        calledNetwork = true;
        throw new Error("unexpected network call");
      }
    });

    const result = daemon.queueCiphertextBatch({
      remoteStatus: {
        ok: true,
        latest_generation: 4,
        latest_batch_id: "la_sync_batch_status0004",
        authority_id: "la_authority_fixture0001",
        latest_submitted_at: now,
        object_count: 12,
        change_count: 18,
        latest_withheld_plaintext_count: 3
      },
      now
    });

    expect(calledNetwork).toBe(false);
    expect(result.batch.base_generation).toBe(4);
    expect(result.batch.target_generation).toBe(5);
    expect(result.record.status).toBe("pending");
    expect(daemon.outbox.pendingCount()).toBe(1);
    expect(result.batch.objects.every((object) => object.payload.kind !== "plaintext-json")).toBe(true);
  });

  it("submits the next daemon outbox batch with injected fetch and marks it accepted", async () => {
    const controlState = await createFixtureLocalControlState("sync-agent-daemon-submit-token-0001");
    const calls: Request[] = [];
    const daemon = new SyntheticLocalSyncDaemon({
      controlState,
      endpoint: "https://living-atlas.example",
      syncToken: "fixture-sync-token-0001",
      tokenId: "la_sync_token_daemon0001",
      fetchImpl: async (input, init) => {
        const request = new Request(input, init);
        calls.push(request);
        const body = await request.json() as {
          batch_id: string;
          objects: unknown[];
          changes: unknown[];
          target_generation: number;
          withheld_plaintext_count: number;
        };
        return new Response(JSON.stringify({
          ok: true,
          batch_id: body.batch_id,
          accepted_objects: body.objects.length,
          accepted_changes: body.changes.length,
          target_generation: body.target_generation,
          withheld_plaintext_count: body.withheld_plaintext_count
        }), {
          status: 202,
          headers: { "content-type": "application/json" }
        });
      }
    });

    const queued = daemon.queueCiphertextBatch({
      baseGeneration: 0,
      targetGeneration: 1,
      now
    });
    const result = await daemon.submitNextPending({ acceptedAt: "2026-06-21T12:00:01.000Z" });

    expect(result.ok).toBe(true);
    expect(result.submitted).toBe(true);
    if (!result.ok || !result.submitted) {
      throw new Error("expected submitted daemon result");
    }

    expect(result.accepted.target_generation).toBe(1);
    expect(result.record).toBe(queued.record);
    expect(result.record.status).toBe("accepted");
    expect(result.record.accepted_at).toBe("2026-06-21T12:00:01.000Z");
    expect(daemon.outbox.pendingCount()).toBe(0);
    expect(daemon.outbox.cursor(controlState.authority_id)).toEqual({
      authority_id: controlState.authority_id,
      generation: 1,
      batch_id: queued.batch.batch_id
    });
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).pathname).toBe("/api/sync/batch");
    expect(calls[0]!.headers.get("x-living-atlas-sync-token")).toBe("fixture-sync-token-0001");
    expect(calls[0]!.headers.get("x-living-atlas-sync-client-id")).toBe("la_client_sync0001");
    expect(calls[0]!.headers.get("x-living-atlas-sync-capability-id")).toBe("la_cap_sync0001");
    expect(calls[0]!.headers.get("x-living-atlas-sync-token-id")).toBe("la_sync_token_daemon0001");
  });

  it("plans remote pull status and fetches the planned pull with injected fetch", async () => {
    const controlState = await createFixtureLocalControlState("sync-agent-daemon-pull-token-0001");
    const calls: Request[] = [];
    const daemon = new SyntheticLocalSyncDaemon({
      controlState,
      endpoint: "https://living-atlas.example",
      syncToken: "fixture-sync-token-0001",
      tokenId: "la_sync_token_daemonpull0001",
      fetchImpl: async (input, init) => {
        const request = new Request(input, init);
        calls.push(request);
        const url = new URL(request.url);

        if (url.pathname === "/api/sync/status") {
          return new Response(JSON.stringify({
            ok: true,
            latest_generation: 2,
            latest_batch_id: "la_sync_batch_status0002",
            authority_id: "la_authority_fixture0001",
            latest_submitted_at: now,
            object_count: 6,
            change_count: 6,
            latest_withheld_plaintext_count: 0
          }), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }

        if (url.pathname === "/api/sync/pull") {
          return new Response(JSON.stringify({
            ok: true,
            authority_id: "la_authority_fixture0001",
            from_generation: 0,
            latest_generation: 2,
            batches: [
              {
                batch_id: "la_sync_batch_pull0002",
                batch_hash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                base_generation: 1,
                target_generation: 2,
                submitted_at: now,
                object_count: 3,
                change_count: 3,
                withheld_plaintext_count: 0
              }
            ],
            next_cursor: {
              authority_id: "la_authority_fixture0001",
              generation: 2,
              batch_id: "la_sync_batch_pull0002"
            },
            recovery: {
              mode: "replay",
              from_generation: 0,
              reason: "local-cursor-behind"
            },
            has_more: false
          }), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }

        return new Response(JSON.stringify({ error: "unexpected path" }), { status: 500 });
      }
    });

    const planResult = await daemon.planFromRemoteStatus();
    expect(planResult.ok).toBe(true);
    if (!planResult.ok) {
      throw new Error("expected daemon plan result");
    }
    expect(planResult.plan).toMatchObject({
      action: "pull",
      reason: "local-cursor-behind",
      pull_after_generation: 0
    });

    const pullResult = await daemon.fetchPlannedPull(planResult);
    expect(pullResult).toMatchObject({
      ok: true,
      skipped: false,
      response: {
        latest_generation: 2,
        next_cursor: {
          generation: 2,
          batch_id: "la_sync_batch_pull0002"
        }
      }
    });
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/api/sync/status",
      "/api/sync/pull"
    ]);
    expect(new URL(calls[1]!.url).searchParams.get("after_generation")).toBe("0");
    expect(calls[1]!.headers.get("x-living-atlas-sync-token")).toBe("fixture-sync-token-0001");
    expect(calls[1]!.headers.get("x-living-atlas-sync-client-id")).toBe("la_client_sync0001");
    expect(calls[1]!.headers.get("x-living-atlas-sync-capability-id")).toBe("la_cap_sync0001");
    expect(calls[0]!.headers.get("x-living-atlas-sync-token-id")).toBe("la_sync_token_daemonpull0001");
    expect(calls[1]!.headers.get("x-living-atlas-sync-token-id")).toBe("la_sync_token_daemonpull0001");
  });

  it("does not use global fetch for daemon remote steps by default", async () => {
    const controlState = await createFixtureLocalControlState("sync-agent-daemon-no-default-fetch-token-0001");
    const daemon = new SyntheticLocalSyncDaemon({
      controlState,
      endpoint: "https://living-atlas.example"
    });

    await expect(daemon.planFromRemoteStatus()).rejects.toThrow("injected fetchImpl");
  });
});
