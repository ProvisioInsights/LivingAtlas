import { createHash } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GraphObjectEnvelopeSchema } from "@living-atlas/contracts";
import type {
  LocalMcpMutationOutboxRecord,
  LocalMcpMutationOutboxSink
} from "./local-graph";

const ownerOnlyMode = 0o600;

function digest(value: string, length = 16): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

export class InMemoryLocalMcpMutationOutboxSink implements LocalMcpMutationOutboxSink {
  readonly records: LocalMcpMutationOutboxRecord[] = [];

  async enqueue(record: LocalMcpMutationOutboxRecord): Promise<void> {
    this.records.push({
      ...record,
      object: GraphObjectEnvelopeSchema.parse(structuredClone(record.object))
    });
  }
}

export class FileLocalMcpMutationOutboxSink implements LocalMcpMutationOutboxSink {
  constructor(private readonly directory: string) {}

  async enqueue(record: LocalMcpMutationOutboxRecord): Promise<void> {
    const object = GraphObjectEnvelopeSchema.parse(record.object);
    const seed = [
      record.generation,
      record.journal_sequence,
      record.mutation,
      object.object_id,
      object.version,
      object.content_hash
    ].join(":");
    const filePath = join(
      this.directory,
      `queued-g${record.generation}-j${record.journal_sequence}-${digest(seed)}.json`
    );
    await mkdir(this.directory, { recursive: true });
    await writeFile(filePath, `${JSON.stringify({
      record_schema: "living-atlas-local-mcp-outbox:v1",
      enqueued_at: new Date().toISOString(),
      mutation: record.mutation,
      actor_id: record.actor_id,
      recorded_at: record.recorded_at,
      local_generation: record.generation,
      local_journal_sequence: record.journal_sequence,
      objects: [object]
    }, null, 2)}\n`, { mode: ownerOnlyMode });
    await chmod(filePath, ownerOnlyMode);
  }
}
