import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type Socket } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { createFixtureLocalControlState } from "@living-atlas/local-control-store";
import { FileLocalGraphStore } from "@living-atlas/local-graph-store";
import type { GraphObjectEnvelope } from "@living-atlas/contracts";
import { InMemoryLocalMcpAuditSink } from "./audit";
import { createLocalMcpContextFromControlState } from "./local-graph";
import { startLocalMcpDaemon } from "./daemon";

const now = "2026-06-21T12:00:00.000Z";

function fixedHash(seed: string): `sha256:${string}` {
  return `sha256:${seed.repeat(64).slice(0, 64)}`;
}

function testObject(authorityId: string, objectId: string, seed: string): GraphObjectEnvelope {
  return {
    schema_version: 1,
    authority_id: authorityId,
    object_id: objectId,
    object_type: "page",
    version: 1,
    access_class: "remote-safe",
    encryption_class: "plaintext",
    created_at: now,
    updated_at: now,
    content_hash: fixedHash(seed),
    visible_metadata: {
      schema_namespace: "test/daemon-concurrency",
      tombstone: false,
      size_class: "tiny",
      remote_indexable: true
    },
    payload: {
      kind: "plaintext-json",
      data: { title: `Concurrent object ${seed}`, body: "daemon concurrency proof" }
    }
  };
}

/** Minimal MCP Transport over a raw net.Socket: newline-delimited JSON-RPC, the
 * exact framing StdioServerTransport speaks on the daemon side of the same socket. */
class SocketTransport implements Transport {
  private buffer = "";
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(private readonly socket: Socket) {}

  async start(): Promise<void> {
    this.socket.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      let newlineIndex: number;
      while ((newlineIndex = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, newlineIndex);
        this.buffer = this.buffer.slice(newlineIndex + 1);
        if (line.trim().length > 0) {
          this.onmessage?.(JSON.parse(line));
        }
      }
    });
    this.socket.on("close", () => this.onclose?.());
    this.socket.on("error", (error) => this.onerror?.(error));
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.write(`${JSON.stringify(message)}\n`, (error) => (error ? reject(error) : resolve()));
    });
  }

  async close(): Promise<void> {
    this.socket.end();
  }
}

async function connectClient(socketPath: string, name: string): Promise<Client> {
  const socket = connect(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });
  const client = new Client({ name, version: "0.0.0" });
  await client.connect(new SocketTransport(socket));
  return client;
}

describe("local-mcp daemon: multi-client concurrency", () => {
  it(
    "serves two simultaneous MCP client sessions writing to the same replica without generation corruption",
    async () => {
      const graphDir = await mkdtemp(join(tmpdir(), "living-atlas-daemon-graph-"));
      const socketDir = await mkdtemp(join(tmpdir(), "living-atlas-daemon-socket-"));
      const socketPath = join(socketDir, "local-mcp.sock");

      try {
        const token = "local-token-daemon-concurrency-0001";
        const controlState = await createFixtureLocalControlState(token);
        const graphStore = await FileLocalGraphStore.open({
          directory: graphDir,
          authorityId: controlState.authority_id,
          plaintextPersistence: "allow"
        });
        const context = createLocalMcpContextFromControlState({
          controlState,
          graphStore,
          auditSink: new InMemoryLocalMcpAuditSink(),
          now
        });

        const baseline = graphStore.status();
        expect(baseline.generation).toBe(0);

        const started = await startLocalMcpDaemon(context, {
          socketPath,
          authorizationHeader: `Bearer ${token}`
        });
        expect(started.ok).toBe(true);
        if (!started.ok) return;

        try {
          // Two independent MCP protocol sessions on two independent sockets —
          // this is exactly what happens when Claude and Codex both run
          // proxy.ts against the same daemon at once.
          const [claudeClient, codexClient] = await Promise.all([
            connectClient(socketPath, "claude-simulated"),
            connectClient(socketPath, "codex-simulated")
          ]);

          const objectA = testObject(controlState.authority_id, "la_object_daemonconcurrenta01", "a");
          const objectB = testObject(controlState.authority_id, "la_object_daemonconcurrentb01", "b");

          // Fire both writes at genuinely the same time (no await between them)
          // to exercise the race that corrupted two independent processes before.
          const [resultA, resultB] = await Promise.all([
            claudeClient.callTool({ name: "object_create", arguments: { object: objectA } }),
            codexClient.callTool({ name: "object_create", arguments: { object: objectB } })
          ]);

          const parse = (result: Awaited<ReturnType<Client["callTool"]>>) => {
            const content = result.content as Array<{ type: string; text: string }>;
            return JSON.parse(content[0]!.text);
          };
          // object_create computes expected_generation from the store's
          // current generation at call time (optimistic concurrency), so two
          // truly simultaneous creates can have one lose a clean, retryable
          // conflict — that is the CORRECT, safe outcome the single shared
          // store now produces. Contrast with the old per-process design,
          // where both would have silently "succeeded" in their own separate
          // process's memory and corrupted the journal on next reload.
          const parsedA = parse(resultA);
          const parsedB = parse(resultB);
          const outcomes = [parsedA, parsedB];
          expect(outcomes.filter((r) => r.ok === true)).toHaveLength(1);
          const [winner, loser] = parsedA.ok ? [parsedA, parsedB] : [parsedB, parsedA];
          expect(winner).toMatchObject({ ok: true, result: { mutation: "created" } });
          expect(loser).toEqual({ ok: false, reason: "generation-conflict" });

          // The loser retries — exactly what a well-behaved client does on a
          // generation-conflict — and now succeeds cleanly.
          const loserClient = parsedA.ok ? codexClient : claudeClient;
          const loserObject = parsedA.ok ? objectB : objectA;
          const retryResult = parse(
            await loserClient.callTool({ name: "object_create", arguments: { object: loserObject } })
          );
          expect(retryResult).toMatchObject({ ok: true, result: { mutation: "created" } });

          // The one shared FileLocalGraphStore instance in the daemon process
          // serialized both mutations through its internal queue: no lost
          // write, no duplicate generation claim, no journal gap.
          expect(graphStore.readObject("la_object_daemonconcurrenta01")).toBeDefined();
          expect(graphStore.readObject("la_object_daemonconcurrentb01")).toBeDefined();
          expect(graphStore.status().generation).toBe(baseline.generation + 2);

          // Reload from disk exactly as a freshly spawned client would: the
          // journal must replay cleanly with no generation-gap error.
          const reopened = await FileLocalGraphStore.open({
            directory: graphDir,
            authorityId: controlState.authority_id,
            plaintextPersistence: "allow"
          });
          expect(reopened.status().generation).toBe(baseline.generation + 2);
          expect(reopened.readObject("la_object_daemonconcurrenta01")).toBeDefined();
          expect(reopened.readObject("la_object_daemonconcurrentb01")).toBeDefined();

          await claudeClient.close();
          await codexClient.close();
        } finally {
          await started.daemon.close();
        }
      } finally {
        await rm(graphDir, { recursive: true, force: true });
        await rm(socketDir, { recursive: true, force: true });
      }
    },
    15_000
  );

  it("refuses to double-bind so a second daemon attempt against the same socket exits instead of opening a second store", async () => {
    const graphDir = await mkdtemp(join(tmpdir(), "living-atlas-daemon-graph-dup-"));
    const socketDir = await mkdtemp(join(tmpdir(), "living-atlas-daemon-socket-dup-"));
    const socketPath = join(socketDir, "local-mcp.sock");

    try {
      const token = "local-token-daemon-dup-0001";
      const controlState = await createFixtureLocalControlState(token);
      const graphStore = await FileLocalGraphStore.open({
        directory: graphDir,
        authorityId: controlState.authority_id,
        plaintextPersistence: "allow"
      });
      const context = createLocalMcpContextFromControlState({
        controlState,
        graphStore,
        auditSink: new InMemoryLocalMcpAuditSink(),
        now
      });

      const first = await startLocalMcpDaemon(context, { socketPath, authorizationHeader: `Bearer ${token}` });
      expect(first.ok).toBe(true);

      const second = await startLocalMcpDaemon(context, { socketPath, authorizationHeader: `Bearer ${token}` });
      expect(second).toEqual({ ok: false, reason: "already-running" });

      if (first.ok) {
        await first.daemon.close();
      }
    } finally {
      await rm(graphDir, { recursive: true, force: true });
      await rm(socketDir, { recursive: true, force: true });
    }
  });
});
