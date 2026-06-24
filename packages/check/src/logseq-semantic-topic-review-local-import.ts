import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  AuthorityIdSchema,
  EndpointRecordSchema,
  type ObjectType
} from "@living-atlas/contracts";
import { FileLocalGraphStore } from "@living-atlas/local-graph-store";
import { FileLocalKeyringStore } from "@living-atlas/local-keyring";
import {
  SemanticTopicReviewPacketSchema
} from "./logseq-semantic-topic-review-packet";
import {
  TopicReviewResolutionMapSchema,
  type TopicReviewResolutionMap
} from "./logseq-semantic-topic-review-report";

const importAckValue = "write-encrypted-local-topic-review-objects";
const ownerOnlyMode = 0o600;

type TopicResolutionObjectStatus = "promoted" | "quarantined";
type TopicResolutionImportStatus = "promoted" | "quarantined" | "updated-existing" | "already-exists" | "failed";

type TopicObjectDraft = {
  draft: unknown;
  object_id: string;
  object_type: ObjectType;
  access_class: "local-private" | "quarantine";
  status: TopicResolutionObjectStatus;
};

export type TopicReviewLocalImportLedger = {
  record_schema: "living-atlas-logseq-topic-review-local-import:v1";
  recorded_at: string;
  authority_id: string;
  packet_hash: `sha256:${string}`;
  resolution_hash: `sha256:${string}`;
  plaintext_policy: "hash-counts-refs-only";
  sync: { attempted: false };
  packet_totals: {
    covered_file_count: number;
    candidate_count: number;
    grouped_candidate_count: number;
    excluded_suffix_tag_count: number;
  };
  resolution_totals: {
    resolution_count: number;
    promote_topic_count: number;
    defer_count: number;
    reject_count: number;
    unknown_target_count: number;
    duplicate_resolution_count: number;
  };
  import_totals: {
    created_objects: number;
    updated_existing_objects: number;
    already_existing_objects: number;
    promoted_objects: number;
    quarantine_objects: number;
    failed_objects: number;
  };
  by_reason_code: Record<string, number>;
  by_decision: Record<string, number>;
  by_subtype: Record<string, number>;
  graph_status: {
    generation: number;
    object_count: number;
    active_object_count: number;
    tombstone_count: number;
    plaintext_persistence: "redacted" | "encrypted" | "allowed";
  };
  object_refs: Array<{
    target_hash: string;
    reason_code: string;
    object_id: string;
    object_type: ObjectType;
    access_class: "local-private" | "quarantine";
    import_status: TopicResolutionImportStatus;
  }>;
};

function envValue(key: string): string | undefined {
  const value = process.env[key]?.trim();
  return value ? value : undefined;
}

function requireEnv(key: string): string {
  const value = envValue(key);
  if (!value) {
    throw new Error(`missing ${key}`);
  }
  return value;
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function digest(value: string, length = 24): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sortedRecord(record: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
}

function increment(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

function sizeClass(byteLength: number): "tiny" | "small" | "medium" | "large" | "huge" {
  if (byteLength <= 512) {
    return "tiny";
  }
  if (byteLength <= 8_192) {
    return "small";
  }
  if (byteLength <= 128_000) {
    return "medium";
  }
  if (byteLength <= 1_000_000) {
    return "large";
  }
  return "huge";
}

function topicObjectId(authorityId: string, reasonCode: string, targetHash: string, decision: string): string {
  return `la_object_${digest(`logseq-topic-review:v1:${authorityId}:${reasonCode}:${targetHash}:${decision}`, 32)}`;
}

function collectNeedles(value: unknown, output = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length >= 3 && !/^sha256:[a-f0-9]{64}$/.test(trimmed) && !/^la_[A-Za-z0-9_-]+$/.test(trimmed)) {
      output.add(trimmed);
    }
    return output;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectNeedles(entry, output);
    }
    return output;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (["packet_schema", "plaintext_policy", "source_path_policy", "reason_code", "decision", "confidence", "subtype"].includes(key)) {
        continue;
      }
      collectNeedles(entry, output);
    }
  }
  return output;
}

function assertNoNeedles(label: string, value: unknown, needles: Iterable<string>): void {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  for (const needle of needles) {
    if (serialized.includes(needle)) {
      throw new Error(`${label} leaked topic review plaintext needle`);
    }
  }
}

function objectForResolution(input: {
  authorityId: string;
  resolution: TopicReviewResolutionMap["resolutions"][number];
  recordedAt: string;
  version?: number;
}): TopicObjectDraft {
  const promoted = input.resolution.decision === "promote-topic";
  const objectId = topicObjectId(input.authorityId, input.resolution.reason_code, input.resolution.target_hash, input.resolution.decision);
  const objectType: ObjectType = promoted ? "page" : "attachment";
  const accessClass = promoted ? "local-private" : "quarantine";
  const status = promoted ? "promoted" : "quarantined";
  const payload = promoted
    ? {
        kind: "logseq-topic-endpoint",
        resolution_ref: {
          target_hash: input.resolution.target_hash,
          reason_code: input.resolution.reason_code,
          decision: input.resolution.decision,
          rationale_hash: input.resolution.rationale_hash
        },
        endpoint: EndpointRecordSchema.parse({
          object_id: objectId,
          type: "topic",
          subtype: input.resolution.subtype,
          name: input.resolution.topic_title,
          aliases: input.resolution.aliases,
          access_class: "local-private",
          source_ref: input.resolution.target_hash,
          confidence: input.resolution.confidence,
          created_at: input.recordedAt,
          updated_at: input.recordedAt,
          controlled: true,
          tags: []
        })
      }
    : {
        kind: "logseq-topic-review-terminal-decision",
        target_hash: input.resolution.target_hash,
        reason_code: input.resolution.reason_code,
        decision: input.resolution.decision,
        confidence: input.resolution.confidence,
        reviewed_at: input.resolution.reviewed_at,
        rationale_hash: input.resolution.rationale_hash
      };
  const payloadJson = stableJson(payload);

  return {
    object_id: objectId,
    object_type: objectType,
    access_class: accessClass,
    status,
    draft: {
      schema_version: 1,
      authority_id: input.authorityId,
      object_id: objectId,
      object_type: objectType,
      version: input.version ?? 1,
      access_class: accessClass,
      encryption_class: "plaintext",
      created_at: input.recordedAt,
      updated_at: input.recordedAt,
      content_hash: sha256(payloadJson),
      visible_metadata: {
        schema_namespace: `import/logseq-topic-review/${status}`,
        tombstone: false,
        remote_indexable: false,
        size_class: sizeClass(Buffer.byteLength(payloadJson, "utf8"))
      },
      payload: {
        kind: "plaintext-json",
        data: payload
      }
    }
  };
}

async function writeJsonPrivate(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: ownerOnlyMode });
  await chmod(path, ownerOnlyMode);
}

async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function packetGroupKeys(packet: ReturnType<typeof SemanticTopicReviewPacketSchema.parse>): Set<string> {
  return new Set(packet.groups.map((group) => `${group.reason_code}:${group.target_hash}`));
}

export async function importTopicReviewResolutions(input: {
  packetPath: string;
  resolutionPath: string;
  localGraphDir: string;
  keyringPath: string;
  keyringPassphrase: string;
  authorityId: string;
  ledgerPath?: string;
  recordedAt?: string;
  updateExisting?: boolean;
}): Promise<TopicReviewLocalImportLedger> {
  const packetText = await readFile(input.packetPath, "utf8");
  const resolutionText = await readFile(input.resolutionPath, "utf8");
  const packet = SemanticTopicReviewPacketSchema.parse(JSON.parse(packetText));
  const resolutionMap = TopicReviewResolutionMapSchema.parse(JSON.parse(resolutionText));
  const authorityId = AuthorityIdSchema.parse(input.authorityId);
  const recordedAt = input.recordedAt ?? new Date().toISOString();
  const keyring = await new FileLocalKeyringStore(input.keyringPath).read(input.keyringPassphrase);
  if (keyring.authority_id !== authorityId) {
    throw new Error("topic review import keyring authority mismatch");
  }

  const store = await FileLocalGraphStore.open({
    directory: input.localGraphDir,
    authorityId,
    plaintextPersistence: "encrypt",
    keyring
  });

  const validGroupKeys = packetGroupKeys(packet);
  const seen = new Set<string>();
  const needles = collectNeedles(packet);
  collectNeedles(resolutionMap, needles);
  const objectRefs: TopicReviewLocalImportLedger["object_refs"] = [];
  const byReasonCode: Record<string, number> = {};
  const byDecision: Record<string, number> = {};
  const bySubtype: Record<string, number> = {};
  let createdObjects = 0;
  let updatedExistingObjects = 0;
  let alreadyExistingObjects = 0;
  let promotedObjects = 0;
  let quarantineObjects = 0;
  let failedObjects = 0;
  let unknownTargetCount = 0;
  let duplicateResolutionCount = 0;

  for (const resolution of resolutionMap.resolutions) {
    const resolutionKey = `${resolution.reason_code}:${resolution.target_hash}`;
    if (seen.has(resolutionKey)) {
      duplicateResolutionCount += 1;
      continue;
    }
    seen.add(resolutionKey);
    if (!validGroupKeys.has(resolutionKey)) {
      unknownTargetCount += 1;
      continue;
    }

    increment(byReasonCode, resolution.reason_code);
    increment(byDecision, resolution.decision);
    if (resolution.decision === "promote-topic") {
      increment(bySubtype, resolution.subtype);
    }

    const existingId = topicObjectId(authorityId, resolution.reason_code, resolution.target_hash, resolution.decision);
    const existing = store.readObject(existingId);
    const object = objectForResolution({
      authorityId,
      resolution,
      recordedAt,
      version: existing && input.updateExisting ? existing.version + 1 : 1
    });
    let importStatus: TopicResolutionImportStatus = object.status === "promoted" ? "promoted" : "quarantined";

    if (existing && !input.updateExisting) {
      alreadyExistingObjects += 1;
      importStatus = "already-exists";
    } else if (existing && input.updateExisting) {
      const result = await store.updateObject({
        expected_generation: store.status().generation,
        expected_version: existing.version,
        actor_id: "logseq-topic-review-local-import",
        operation_id: `la_operation_${digest(`topic-review:${object.object_id}:update:${existing.version}`, 24)}`,
        trace_id: `la_trace_${digest(`topic-review:${sha256(resolutionText)}:${object.object_id}:update`, 24)}`,
        recorded_at: recordedAt,
        object: object.draft
      });
      if (!result.ok) {
        failedObjects += 1;
        importStatus = "failed";
      } else {
        updatedExistingObjects += 1;
        importStatus = "updated-existing";
      }
    } else {
      const result = await store.createObject({
        expected_generation: store.status().generation,
        actor_id: "logseq-topic-review-local-import",
        operation_id: `la_operation_${digest(`topic-review:${object.object_id}:create`, 24)}`,
        trace_id: `la_trace_${digest(`topic-review:${sha256(resolutionText)}:${object.object_id}`, 24)}`,
        recorded_at: recordedAt,
        object: object.draft
      });
      if (!result.ok) {
        failedObjects += 1;
        importStatus = "failed";
      } else {
        createdObjects += 1;
        if (object.status === "promoted") {
          promotedObjects += 1;
        } else {
          quarantineObjects += 1;
        }
      }
    }

    objectRefs.push({
      target_hash: resolution.target_hash,
      reason_code: resolution.reason_code,
      object_id: object.object_id,
      object_type: object.object_type,
      access_class: object.access_class,
      import_status: importStatus
    });
  }

  const graphStatus = store.status();
  const ledger: TopicReviewLocalImportLedger = {
    record_schema: "living-atlas-logseq-topic-review-local-import:v1",
    recorded_at: recordedAt,
    authority_id: authorityId,
    packet_hash: sha256(packetText),
    resolution_hash: sha256(resolutionText),
    plaintext_policy: "hash-counts-refs-only",
    sync: { attempted: false },
    packet_totals: {
      covered_file_count: packet.covered_file_count,
      candidate_count: packet.candidate_count,
      grouped_candidate_count: packet.grouped_candidate_count,
      excluded_suffix_tag_count: packet.excluded_suffix_tag_count
    },
    resolution_totals: {
      resolution_count: resolutionMap.resolutions.length,
      promote_topic_count: byDecision["promote-topic"] ?? 0,
      defer_count: byDecision.defer ?? 0,
      reject_count: byDecision.reject ?? 0,
      unknown_target_count: unknownTargetCount,
      duplicate_resolution_count: duplicateResolutionCount
    },
    import_totals: {
      created_objects: createdObjects,
      updated_existing_objects: updatedExistingObjects,
      already_existing_objects: alreadyExistingObjects,
      promoted_objects: promotedObjects,
      quarantine_objects: quarantineObjects,
      failed_objects: failedObjects
    },
    by_reason_code: sortedRecord(byReasonCode),
    by_decision: sortedRecord(byDecision),
    by_subtype: sortedRecord(bySubtype),
    graph_status: {
      generation: graphStatus.generation,
      object_count: graphStatus.object_count,
      active_object_count: graphStatus.active_object_count,
      tombstone_count: graphStatus.tombstone_count,
      plaintext_persistence: graphStatus.plaintext_persistence
    },
    object_refs: objectRefs
  };

  assertNoNeedles("topic review local import ledger", ledger, needles);
  if (input.ledgerPath) {
    await writeJsonPrivate(input.ledgerPath, ledger);
  }

  const snapshot = await readTextIfExists(join(input.localGraphDir, "snapshot.json"));
  if (snapshot) {
    assertNoNeedles("topic review local graph snapshot", snapshot, needles);
  }
  const journal = await readTextIfExists(join(input.localGraphDir, "journal.jsonl"));
  if (!journal && createdObjects > 0) {
    throw new Error("topic review local graph journal was not written");
  }
  if (journal) {
    assertNoNeedles("topic review local graph journal", journal, needles);
  }

  return ledger;
}

async function main(): Promise<void> {
  if (envValue("LIVING_ATLAS_LOGSEQ_TOPIC_REVIEW_IMPORT_ACK") !== importAckValue) {
    throw new Error(`set LIVING_ATLAS_LOGSEQ_TOPIC_REVIEW_IMPORT_ACK=${importAckValue} to write encrypted local topic review objects`);
  }

  const ledger = await importTopicReviewResolutions({
    packetPath: requireEnv("LIVING_ATLAS_LOGSEQ_TOPIC_REVIEW_PACKET_PATH"),
    resolutionPath: requireEnv("LIVING_ATLAS_LOGSEQ_TOPIC_REVIEW_RESOLUTION_PATH"),
    localGraphDir: requireEnv("LIVING_ATLAS_LOCAL_GRAPH_DIR"),
    keyringPath: requireEnv("LIVING_ATLAS_LOCAL_KEYRING"),
    keyringPassphrase: requireEnv("LIVING_ATLAS_LOCAL_KEYRING_PASSPHRASE"),
    authorityId: requireEnv("LIVING_ATLAS_LIVE_AUTHORITY_ID"),
    ledgerPath: envValue("LIVING_ATLAS_LOGSEQ_TOPIC_REVIEW_LEDGER_PATH"),
    updateExisting: envValue("LIVING_ATLAS_LOGSEQ_TOPIC_REVIEW_UPDATE_EXISTING_ACK") === "update-existing-encrypted-topic-review-objects"
  });
  console.log(JSON.stringify(ledger, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
