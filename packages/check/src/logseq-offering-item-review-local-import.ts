import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  AuthorityIdSchema,
  EndpointRecordSchema,
  ObjectIdSchema,
  TemporalEdgeSchema,
  type ObjectType
} from "@living-atlas/contracts";
import { FileLocalGraphStore } from "@living-atlas/local-graph-store";
import { FileLocalKeyringStore } from "@living-atlas/local-keyring";
import {
  OfferingItemReviewGroupedPacketSchema,
  type OfferingItemReviewGroupedPacket
} from "./logseq-offering-item-review-grouped-packet";
import {
  OfferingItemReviewResolutionMapSchema,
  type OfferingItemNormalizedFact,
  type OfferingItemReviewResolution,
  type OfferingItemReviewResolutionMap
} from "./logseq-offering-item-review-report";

const importAckValue = "write-encrypted-local-offering-item-review-objects";
const ownerOnlyMode = 0o600;

type OfferingItemImportStatus = "promoted" | "quarantined" | "updated-existing" | "already-exists" | "failed";

type OfferingItemObjectDraft = {
  draft: unknown;
  object_id: string;
  object_type: ObjectType;
  access_class: "local-private" | "quarantine";
  status: "promoted" | "quarantined";
};

export type OfferingItemReviewLocalImportLedger = {
  record_schema: "living-atlas-logseq-offering-item-review-local-import:v1";
  recorded_at: string;
  authority_id: string;
  packet_hash: `sha256:${string}`;
  resolution_hash: `sha256:${string}`;
  plaintext_policy: "hash-counts-refs-only";
  sync: { attempted: false };
  packet_totals: {
    covered_file_count: number;
    candidate_count: number;
    group_count: number;
  };
  resolution_totals: {
    resolution_count: number;
    promote_count: number;
    defer_count: number;
    reject_count: number;
    normalized_fact_count: number;
    unknown_group_count: number;
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
  by_decision: Record<string, number>;
  by_kind: Record<string, number>;
  by_review_hint: Record<string, number>;
  by_fact_kind: Record<string, number>;
  graph_status: {
    generation: number;
    object_count: number;
    active_object_count: number;
    tombstone_count: number;
    plaintext_persistence: "redacted" | "encrypted" | "allowed";
  };
  object_refs: Array<{
    group_id: string;
    group_hash: string;
    object_id: string;
    object_type: ObjectType;
    access_class: "local-private" | "quarantine";
    import_status: OfferingItemImportStatus;
    fact_kind?: "endpoint" | "edge";
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

function sortedRecord(record: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
}

function increment(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

function groupKey(groupId: string, groupHash: string): string {
  return `${groupId}:${groupHash}`;
}

function terminalObjectId(authorityId: string, resolution: OfferingItemReviewResolution): string {
  return `la_object_${digest(`logseq-offering-item-review:v1:${authorityId}:${resolution.group_id}:${resolution.group_hash}:${resolution.decision}`, 32)}`;
}

function objectIdForFact(authorityId: string, resolution: OfferingItemReviewResolution, fact: OfferingItemNormalizedFact, index: number): string {
  if (fact.fact_kind === "endpoint") {
    return ObjectIdSchema.parse(fact.object_id ?? fact.endpoint.object_id);
  }
  return ObjectIdSchema.parse(fact.object_id ?? `la_object_${digest(`logseq-offering-item-review:v1:${authorityId}:${resolution.group_id}:${fact.edge.edge_id}:${index}`, 32)}`);
}

function objectTypeForFact(fact: OfferingItemNormalizedFact): ObjectType {
  return fact.fact_kind === "endpoint" ? "page" : "edge";
}

function payloadForFact(input: {
  resolution: OfferingItemReviewResolution;
  fact: OfferingItemNormalizedFact;
}): unknown {
  if (input.fact.fact_kind === "endpoint") {
    return {
      kind: "logseq-offering-item-endpoint",
      group_id: input.resolution.group_id,
      group_hash: input.resolution.group_hash,
      endpoint: EndpointRecordSchema.parse(input.fact.endpoint)
    };
  }
  return {
    kind: "logseq-offering-item-edge",
    group_id: input.resolution.group_id,
    group_hash: input.resolution.group_hash,
    edge: TemporalEdgeSchema.parse(input.fact.edge)
  };
}

function objectForFact(input: {
  authorityId: string;
  resolution: OfferingItemReviewResolution;
  fact: OfferingItemNormalizedFact;
  index: number;
  recordedAt: string;
  version?: number;
}): OfferingItemObjectDraft {
  const objectId = objectIdForFact(input.authorityId, input.resolution, input.fact, input.index);
  const objectType = objectTypeForFact(input.fact);
  const payload = payloadForFact({ resolution: input.resolution, fact: input.fact });
  const payloadJson = stableJson(payload);
  return {
    object_id: objectId,
    object_type: objectType,
    access_class: "local-private",
    status: "promoted",
    draft: {
      schema_version: 1,
      authority_id: input.authorityId,
      object_id: objectId,
      object_type: objectType,
      version: input.version ?? 1,
      access_class: "local-private",
      encryption_class: "plaintext",
      created_at: input.recordedAt,
      updated_at: input.recordedAt,
      content_hash: sha256(payloadJson),
      visible_metadata: {
        schema_namespace: `import/logseq-offering-item-review/${input.fact.fact_kind}`,
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

function objectForTerminalResolution(input: {
  authorityId: string;
  resolution: OfferingItemReviewResolution;
  group: OfferingItemReviewGroupedPacket["groups"][number];
  recordedAt: string;
  version?: number;
}): OfferingItemObjectDraft {
  const objectId = terminalObjectId(input.authorityId, input.resolution);
  const payload = {
    kind: "logseq-offering-item-review-terminal-decision",
    group_id: input.resolution.group_id,
    group_hash: input.resolution.group_hash,
    decision: input.resolution.decision,
    confidence: input.resolution.confidence,
    reviewed_at: input.resolution.reviewed_at,
    rationale_hash: input.resolution.rationale_hash,
    group_summary: {
      candidate_count: input.group.candidate_count,
      source_ref_count: input.group.source_ref_count,
      kind: input.group.kind,
      review_hint: input.group.review_hint,
      proposed_nodes: input.group.proposed_nodes,
      proposed_edges: input.group.proposed_edges
    }
  };
  const payloadJson = stableJson(payload);
  return {
    object_id: objectId,
    object_type: "attachment",
    access_class: "quarantine",
    status: "quarantined",
    draft: {
      schema_version: 1,
      authority_id: input.authorityId,
      object_id: objectId,
      object_type: "attachment",
      version: input.version ?? 1,
      access_class: "quarantine",
      encryption_class: "plaintext",
      created_at: input.recordedAt,
      updated_at: input.recordedAt,
      content_hash: sha256(payloadJson),
      visible_metadata: {
        schema_namespace: "import/logseq-offering-item-review/quarantine",
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

function collectPlaintextNeedles(input: {
  groupedPacket: OfferingItemReviewGroupedPacket;
  resolutionMap: OfferingItemReviewResolutionMap;
}): Set<string> {
  const needles = new Set<string>();
  for (const group of input.groupedPacket.groups) {
    for (const snippet of group.representative_snippets) {
      const trimmed = snippet.trim();
      if (trimmed.length >= 6) {
        needles.add(trimmed);
      }
    }
  }
  for (const resolution of input.resolutionMap.resolutions) {
    for (const fact of resolution.normalized_facts) {
      if (fact.fact_kind === "endpoint") {
        const endpoint = fact.endpoint;
        for (const value of [endpoint.name, endpoint.description, ...endpoint.aliases]) {
          const trimmed = value?.trim();
          if (trimmed && trimmed.length >= 6) {
            needles.add(trimmed);
          }
        }
      } else {
        for (const value of Object.values(fact.edge.attrs)) {
          if (typeof value === "string" && value.trim().length >= 6) {
            needles.add(value.trim());
          }
          if (Array.isArray(value)) {
            for (const entry of value) {
              if (typeof entry === "string" && entry.trim().length >= 6) {
                needles.add(entry.trim());
              }
            }
          }
        }
      }
    }
  }
  return needles;
}

function assertNoNeedles(label: string, value: unknown, needles: Iterable<string>): void {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  for (const needle of needles) {
    if (serialized.includes(needle)) {
      throw new Error(`${label} leaked offering/item review plaintext needle`);
    }
  }
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

export async function importOfferingItemReviewResolutions(input: {
  groupedPacketPath: string;
  resolutionPath: string;
  localGraphDir: string;
  keyringPath: string;
  keyringPassphrase: string;
  authorityId: string;
  ledgerPath?: string;
  recordedAt?: string;
  updateExisting?: boolean;
}): Promise<OfferingItemReviewLocalImportLedger> {
  const packetText = await readFile(input.groupedPacketPath, "utf8");
  const resolutionText = await readFile(input.resolutionPath, "utf8");
  const groupedPacket = OfferingItemReviewGroupedPacketSchema.parse(JSON.parse(packetText));
  const resolutionMap = OfferingItemReviewResolutionMapSchema.parse(JSON.parse(resolutionText));
  const authorityId = AuthorityIdSchema.parse(input.authorityId);
  const recordedAt = input.recordedAt ?? new Date().toISOString();
  const keyring = await new FileLocalKeyringStore(input.keyringPath).read(input.keyringPassphrase);
  if (keyring.authority_id !== authorityId) {
    throw new Error("offering/item review import keyring authority mismatch");
  }

  const store = await FileLocalGraphStore.open({
    directory: input.localGraphDir,
    authorityId,
    plaintextPersistence: "encrypt",
    keyring
  });

  const groupsByKey = new Map(groupedPacket.groups.map((group) => [groupKey(group.group_id, group.group_hash), group]));
  const seen = new Set<string>();
  const needles = collectPlaintextNeedles({ groupedPacket, resolutionMap });
  const objectRefs: OfferingItemReviewLocalImportLedger["object_refs"] = [];
  const byDecision: Record<string, number> = {};
  const byKind: Record<string, number> = {};
  const byReviewHint: Record<string, number> = {};
  const byFactKind: Record<string, number> = {};
  let createdObjects = 0;
  let updatedExistingObjects = 0;
  let alreadyExistingObjects = 0;
  let promotedObjects = 0;
  let quarantineObjects = 0;
  let failedObjects = 0;
  let promoteCount = 0;
  let deferCount = 0;
  let rejectCount = 0;
  let normalizedFactCount = 0;
  let unknownGroupCount = 0;
  let duplicateResolutionCount = 0;

  async function writeObject(inputObject: {
    resolution: OfferingItemReviewResolution;
    object: OfferingItemObjectDraft;
    factKind?: "endpoint" | "edge";
    factIndex?: number;
  }): Promise<OfferingItemImportStatus> {
    const existing = store.readObject(inputObject.object.object_id);
    let importStatus: OfferingItemImportStatus = inputObject.object.status === "promoted" ? "promoted" : "quarantined";
    const object = existing && input.updateExisting
      ? {
          ...inputObject.object,
          draft: {
            ...(inputObject.object.draft as Record<string, unknown>),
            version: existing.version + 1
          }
        }
      : inputObject.object;

    if (existing && !input.updateExisting) {
      alreadyExistingObjects += 1;
      importStatus = "already-exists";
    } else if (existing && input.updateExisting) {
      const result = await store.updateObject({
        expected_generation: store.status().generation,
        expected_version: existing.version,
        actor_id: "logseq-offering-item-review-local-import",
        operation_id: `la_operation_${digest(`offering-item-review:${object.object_id}:update:${existing.version}`, 24)}`,
        trace_id: `la_trace_${digest(`offering-item-review:${sha256(resolutionText)}:${object.object_id}:update`, 24)}`,
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
        actor_id: "logseq-offering-item-review-local-import",
        operation_id: `la_operation_${digest(`offering-item-review:${object.object_id}:create:${inputObject.factIndex ?? 0}`, 24)}`,
        trace_id: `la_trace_${digest(`offering-item-review:${sha256(resolutionText)}:${object.object_id}`, 24)}`,
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
      group_id: inputObject.resolution.group_id,
      group_hash: inputObject.resolution.group_hash,
      object_id: object.object_id,
      object_type: object.object_type,
      access_class: object.access_class,
      import_status: importStatus,
      fact_kind: inputObject.factKind
    });
    return importStatus;
  }

  for (const resolution of resolutionMap.resolutions) {
    const key = groupKey(resolution.group_id, resolution.group_hash);
    if (seen.has(key)) {
      duplicateResolutionCount += 1;
      continue;
    }
    seen.add(key);
    const group = groupsByKey.get(key);
    if (!group) {
      unknownGroupCount += 1;
      continue;
    }

    increment(byDecision, resolution.decision);
    increment(byKind, group.kind);
    increment(byReviewHint, group.review_hint);
    if (resolution.decision === "promote") {
      promoteCount += 1;
      for (const [index, fact] of resolution.normalized_facts.entries()) {
        increment(byFactKind, fact.fact_kind);
        normalizedFactCount += 1;
        await writeObject({
          resolution,
          object: objectForFact({ authorityId, resolution, fact, index, recordedAt }),
          factKind: fact.fact_kind,
          factIndex: index
        });
      }
    } else {
      if (resolution.decision === "defer") {
        deferCount += 1;
      } else {
        rejectCount += 1;
      }
      await writeObject({
        resolution,
        object: objectForTerminalResolution({ authorityId, resolution, group, recordedAt })
      });
    }
  }

  const graphStatus = store.status();
  const ledger: OfferingItemReviewLocalImportLedger = {
    record_schema: "living-atlas-logseq-offering-item-review-local-import:v1",
    recorded_at: recordedAt,
    authority_id: authorityId,
    packet_hash: sha256(packetText),
    resolution_hash: sha256(resolutionText),
    plaintext_policy: "hash-counts-refs-only",
    sync: { attempted: false },
    packet_totals: {
      covered_file_count: groupedPacket.source_packet.covered_file_count,
      candidate_count: groupedPacket.source_packet.candidate_count,
      group_count: groupedPacket.group_count
    },
    resolution_totals: {
      resolution_count: resolutionMap.resolutions.length,
      promote_count: promoteCount,
      defer_count: deferCount,
      reject_count: rejectCount,
      normalized_fact_count: normalizedFactCount,
      unknown_group_count: unknownGroupCount,
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
    by_decision: sortedRecord(byDecision),
    by_kind: sortedRecord(byKind),
    by_review_hint: sortedRecord(byReviewHint),
    by_fact_kind: sortedRecord(byFactKind),
    graph_status: {
      generation: graphStatus.generation,
      object_count: graphStatus.object_count,
      active_object_count: graphStatus.active_object_count,
      tombstone_count: graphStatus.tombstone_count,
      plaintext_persistence: graphStatus.plaintext_persistence
    },
    object_refs: objectRefs
  };

  assertNoNeedles("offering/item review local import ledger", ledger, needles);
  if (input.ledgerPath) {
    await writeJsonPrivate(input.ledgerPath, ledger);
  }

  const snapshot = await readTextIfExists(join(input.localGraphDir, "snapshot.json"));
  if (snapshot) {
    assertNoNeedles("offering/item review local graph snapshot", snapshot, needles);
  }
  const journal = await readTextIfExists(join(input.localGraphDir, "journal.jsonl"));
  if (!journal && createdObjects > 0) {
    throw new Error("offering/item review local graph journal was not written");
  }
  if (journal) {
    assertNoNeedles("offering/item review local graph journal", journal, needles);
  }

  return ledger;
}

async function main(): Promise<void> {
  if (envValue("LIVING_ATLAS_LOGSEQ_OFFERING_ITEM_REVIEW_IMPORT_ACK") !== importAckValue) {
    throw new Error(`set LIVING_ATLAS_LOGSEQ_OFFERING_ITEM_REVIEW_IMPORT_ACK=${importAckValue} to write encrypted local offering/item review objects`);
  }

  const ledger = await importOfferingItemReviewResolutions({
    groupedPacketPath: requireEnv("LIVING_ATLAS_LOGSEQ_OFFERING_ITEM_REVIEW_GROUPED_PACKET_PATH"),
    resolutionPath: requireEnv("LIVING_ATLAS_LOGSEQ_OFFERING_ITEM_REVIEW_RESOLUTION_PATH"),
    localGraphDir: requireEnv("LIVING_ATLAS_LOCAL_GRAPH_DIR"),
    keyringPath: requireEnv("LIVING_ATLAS_LOCAL_KEYRING"),
    keyringPassphrase: requireEnv("LIVING_ATLAS_LOCAL_KEYRING_PASSPHRASE"),
    authorityId: requireEnv("LIVING_ATLAS_LIVE_AUTHORITY_ID"),
    ledgerPath: envValue("LIVING_ATLAS_LOGSEQ_OFFERING_ITEM_REVIEW_LEDGER_PATH"),
    updateExisting: envValue("LIVING_ATLAS_LOGSEQ_OFFERING_ITEM_REVIEW_UPDATE_EXISTING_ACK") === "update-existing-encrypted-offering-item-review-objects"
  });
  console.log(JSON.stringify(ledger, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
