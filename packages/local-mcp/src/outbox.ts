import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, writeFile } from "node:fs/promises";
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

function recordSeed(record: LocalMcpMutationOutboxRecord): string {
  return [
    record.generation,
    record.journal_sequence,
    record.mutation,
    record.object.object_id,
    record.object.version,
    record.object.content_hash
  ].join(":");
}

export class InMemoryLocalMcpMutationOutboxSink implements LocalMcpMutationOutboxSink {
  readonly records: LocalMcpMutationOutboxRecord[] = [];
  private readonly identities = new Set<string>();

  async enqueue(record: LocalMcpMutationOutboxRecord): Promise<void> {
    const identity = recordSeed(record);
    if (this.identities.has(identity)) return;
    this.records.push({
      ...record,
      object: GraphObjectEnvelopeSchema.parse(structuredClone(record.object))
    });
    this.identities.add(identity);
  }
}

export class FileLocalMcpMutationOutboxSink implements LocalMcpMutationOutboxSink {
  constructor(private readonly directory: string) {}

  async enqueue(record: LocalMcpMutationOutboxRecord): Promise<void> {
    const object = GraphObjectEnvelopeSchema.parse(record.object);
    const fileName = `queued-g${record.generation}-j${record.journal_sequence}-${digest(recordSeed({ ...record, object }))}.json`;
    const filePath = join(this.directory, fileName);
    await mkdir(this.directory, { recursive: true });
    const existing = await readdir(this.directory);
    if (existing.some((name) => name === fileName || name.startsWith(`${fileName}.accepted.`))) return;
    await writeFile(filePath, `${JSON.stringify({
      record_schema: "living-atlas-local-mcp-outbox:v1",
      enqueued_at: new Date().toISOString(),
      mutation: record.mutation,
      actor_id: record.actor_id,
      recorded_at: record.recorded_at,
      local_generation: record.generation,
      local_journal_sequence: record.journal_sequence,
      ...(record.operation_id ? { operation_id: record.operation_id } : {}),
      ...(record.idempotency_key ? { idempotency_key: record.idempotency_key } : {}),
      ...(record.change_id ? { change_id: record.change_id } : {}),
      objects: [object]
    }, null, 2)}\n`, { mode: ownerOnlyMode });
    await chmod(filePath, ownerOnlyMode);
  }
}
