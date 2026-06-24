import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  AuthorityIdSchema,
  EndpointRecordSchema,
  TemporalEdgeSchema,
  type ObjectType
} from "@living-atlas/contracts";
import { FileLocalGraphStore } from "@living-atlas/local-graph-store";
import { FileLocalKeyringStore } from "@living-atlas/local-keyring";
import {
  buildConnectorEnrichmentReport,
  ConnectorEnrichmentPacketSchema,
  type EnrichmentCandidate
} from "./connector-enrichment-report";

const importAckValue = "write-encrypted-local-connector-objects";
const ownerOnlyMode = 0o600;

export type ConnectorEnrichmentImportLedger = {
  record_schema: "living-atlas-connector-enrichment-local-import:v1";
  recorded_at: string;
  authority_id: string;
  packet_hash: `sha256:${string}`;
  packet_generated_at: string;
  plaintext_policy: "hash-counts-refs-only";
  sync: { attempted: false };
  packet_totals: {
    candidate_count: number;
    promote_ready_count: number;
    held_count: number;
    duplicate_candidate_id_count: number;
  };
  import_totals: {
    created_objects: number;
    updated_existing_objects: number;
    already_existing_objects: number;
    promoted_objects: number;
    quarantine_objects: number;
    failed_objects: number;
  };
  by_connector: Record<string, number>;
  by_fact_kind: Record<string, number>;
  by_decision: Record<string, number>;
  by_confidence: Record<string, number>;
  by_endpoint_type: Record<string, number>;
  by_predicate: Record<string, number>;
  graph_status: {
    generation: number;
    object_count: number;
    active_object_count: number;
    tombstone_count: number;
    plaintext_persistence: "redacted" | "encrypted" | "allowed";
  };
  object_refs: Array<{
    candidate_id: string;
    object_id: string;
    object_type: ObjectType;
    access_class: "local-private" | "quarantine";
    import_status: "promoted" | "quarantined" | "updated-existing" | "already-exists" | "failed";
    source_id_hash: string;
    evidence_hash: string;
  }>;
};

type ImportCandidateStatus = "promoted" | "quarantined";
type ConnectorObjectDraft = {
  draft: unknown;
  object_id: string;
  object_type: ObjectType;
  access_class: "local-private" | "quarantine";
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

function objectTypeForCandidate(candidate: EnrichmentCandidate): ObjectType {
  switch (candidate.proposed_fact.kind) {
    case "edge":
      return "edge";
    case "source-note":
      return "attachment";
    case "endpoint":
    case "occurrence":
    case "topic":
      return "page";
  }
}

function importStatusForCandidate(candidate: EnrichmentCandidate): ImportCandidateStatus {
  return candidate.decision === "promote" && candidate.proposed_fact.confidence === "high"
    ? "promoted"
    : "quarantined";
}

function objectIdForCandidate(authorityId: string, candidate: EnrichmentCandidate, status: ImportCandidateStatus): string {
  return `la_object_${digest(`connector-enrichment:v1:${authorityId}:${candidate.candidate_id}:${status}`, 32)}`;
}

function stringField(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function stringArrayField(payload: Record<string, unknown>, key: string): string[] {
  const value = payload[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

function payloadRecord(candidate: EnrichmentCandidate): Record<string, unknown> {
  const payload = candidate.proposed_fact.local_private_payload;
  return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
}

function occurrenceStatus(payload: Record<string, unknown>, recordedAt: string): "planned" | "occurred" | undefined {
  const explicit = stringField(payload, "status");
  if (explicit && ["planned", "occurred", "canceled", "moved", "tentative"].includes(explicit)) {
    return explicit as "planned" | "occurred";
  }
  const scheduledEnd = stringField(payload, "scheduled_end");
  return scheduledEnd && Date.parse(scheduledEnd) < Date.parse(recordedAt) ? "occurred" : "planned";
}

function defaultSubtype(type: string | undefined): string {
  switch (type) {
    case "person":
      return "individual";
    case "organization":
    case "project":
    case "location":
    case "occurrence":
    case "topic":
      return "other";
    default:
      return "other";
  }
}

function endpointRecordForCandidate(input: {
  authorityId: string;
  objectId: string;
  candidate: EnrichmentCandidate;
  recordedAt: string;
}) {
  const payload = payloadRecord(input.candidate);
  const type = input.candidate.proposed_fact.endpoint_type;
  const name = stringField(payload, "name") ?? stringField(payload, "title") ?? input.candidate.candidate_id;
  const base = {
    object_id: input.objectId,
    name,
    aliases: stringArrayField(payload, "aliases"),
    description: stringField(payload, "description"),
    access_class: "local-private",
    source_ref: input.candidate.source.evidence_hash,
    confidence: input.candidate.proposed_fact.confidence,
    created_at: input.recordedAt,
    updated_at: input.recordedAt
  };

  if (type === "occurrence") {
    const status = occurrenceStatus(payload, input.recordedAt);
    const scheduledStart = stringField(payload, "scheduled_start");
    return EndpointRecordSchema.parse({
      ...base,
      type,
      subtype: stringField(payload, "occurrence_kind") ?? stringField(payload, "subtype") ?? "other",
      occurred_on: stringField(payload, "occurred_on") ?? (status === "occurred" ? scheduledStart : undefined),
      occurred_until: stringField(payload, "occurred_until"),
      scheduled_start: scheduledStart,
      scheduled_end: stringField(payload, "scheduled_end"),
      timezone: stringField(payload, "timezone"),
      status
    });
  }

  return EndpointRecordSchema.parse({
    ...base,
    type,
    subtype: stringField(payload, "subtype") ?? defaultSubtype(type)
  });
}

function promotedPayload(input: {
  authorityId: string;
  candidate: EnrichmentCandidate;
  objectId: string;
  recordedAt: string;
}): unknown {
  if (input.candidate.proposed_fact.kind === "edge") {
    const edge = payloadRecord(input.candidate).edge;
    return {
      kind: "connector-edge",
      candidate_id: input.candidate.candidate_id,
      source: input.candidate.source,
      edge: TemporalEdgeSchema.parse(edge)
    };
  }

  if (["endpoint", "occurrence", "topic"].includes(input.candidate.proposed_fact.kind)) {
    return {
      kind: "connector-endpoint",
      candidate_id: input.candidate.candidate_id,
      source: input.candidate.source,
      endpoint: endpointRecordForCandidate(input)
    };
  }

  return {
    kind: "connector-source-note",
    candidate_id: input.candidate.candidate_id,
    source: input.candidate.source,
    proposed_fact: input.candidate.proposed_fact,
    plaintext_evidence: input.candidate.plaintext_evidence,
    rationale: input.candidate.rationale
  };
}

function objectForCandidate(input: {
  authorityId: string;
  candidate: EnrichmentCandidate;
  recordedAt: string;
  version?: number;
}): ConnectorObjectDraft {
  const status = importStatusForCandidate(input.candidate);
  const accessClass = status === "promoted" ? "local-private" : "quarantine";
  const objectId = objectIdForCandidate(input.authorityId, input.candidate, status);
  const objectType = objectTypeForCandidate(input.candidate);
  const payload = status === "promoted"
    ? promotedPayload({ authorityId: input.authorityId, candidate: input.candidate, objectId, recordedAt: input.recordedAt })
    : {
        kind: "connector-quarantine",
        candidate_id: input.candidate.candidate_id,
        source: input.candidate.source,
        proposed_fact: input.candidate.proposed_fact,
        decision: input.candidate.decision,
        plaintext_evidence: input.candidate.plaintext_evidence,
        rationale: input.candidate.rationale
      };
  const payloadJson = stableJson(payload);

  return {
    object_id: objectId,
    object_type: objectType,
    access_class: accessClass,
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
        schema_namespace: `import/connector-enrichment/${status}`,
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

function collectNeedles(value: unknown, output = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length >= 6 && !/^sha256:[a-f0-9]{64}$/.test(trimmed) && !/^la_[A-Za-z0-9_-]+$/.test(trimmed)) {
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
      if (["connector", "evidence_kind", "kind", "decision", "confidence"].includes(key)) {
        continue;
      }
      collectNeedles(entry, output);
    }
  }
  return output;
}

function collectPacketPlaintextNeedles(packet: ReturnType<typeof ConnectorEnrichmentPacketSchema.parse>): Set<string> {
  const needles = new Set<string>();
  for (const candidate of packet.candidates) {
    collectNeedles(candidate.plaintext_evidence, needles);
    collectNeedles(candidate.rationale, needles);
    collectNeedles(candidate.proposed_fact.local_private_payload, needles);
  }
  return needles;
}

function assertNoNeedles(label: string, value: unknown, needles: Iterable<string>): void {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  for (const needle of needles) {
    if (serialized.includes(needle)) {
      throw new Error(`${label} leaked connector plaintext needle`);
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

export async function importConnectorEnrichmentPacket(input: {
  packetPath: string;
  localGraphDir: string;
  keyringPath: string;
  keyringPassphrase: string;
  authorityId: string;
  ledgerPath?: string;
  recordedAt?: string;
  updateExisting?: boolean;
}): Promise<ConnectorEnrichmentImportLedger> {
  const packetText = await readFile(input.packetPath, "utf8");
  const packet = ConnectorEnrichmentPacketSchema.parse(JSON.parse(packetText));
  const packetHash = sha256(packetText);
  const report = buildConnectorEnrichmentReport(packet);
  const authorityId = AuthorityIdSchema.parse(input.authorityId);
  const recordedAt = input.recordedAt ?? new Date().toISOString();
  const keyring = await new FileLocalKeyringStore(input.keyringPath).read(input.keyringPassphrase);
  if (keyring.authority_id !== authorityId) {
    throw new Error("connector import keyring authority mismatch");
  }

  const store = await FileLocalGraphStore.open({
    directory: input.localGraphDir,
    authorityId,
    plaintextPersistence: "encrypt",
    keyring
  });

  const needles = collectPacketPlaintextNeedles(packet);
  const objectRefs: ConnectorEnrichmentImportLedger["object_refs"] = [];
  let createdObjects = 0;
  let updatedExistingObjects = 0;
  let alreadyExistingObjects = 0;
  let failedObjects = 0;
  let promotedObjects = 0;
  let quarantineObjects = 0;

  for (const candidate of packet.candidates) {
    const status = importStatusForCandidate(candidate);
    const existing = store.readObject(objectIdForCandidate(authorityId, candidate, status));
    const object = objectForCandidate({
      authorityId,
      candidate,
      recordedAt,
      version: existing && input.updateExisting ? existing.version + 1 : 1
    });
    let importStatus: ConnectorEnrichmentImportLedger["object_refs"][number]["import_status"] = status === "promoted" ? "promoted" : "quarantined";

    if (existing && !input.updateExisting) {
      alreadyExistingObjects += 1;
      importStatus = "already-exists";
    } else if (existing && input.updateExisting) {
      const result = await store.updateObject({
        expected_generation: store.status().generation,
        expected_version: existing.version,
        actor_id: "connector-enrichment-local-import",
        operation_id: `la_operation_${digest(`connector-enrichment:${object.object_id}:update:${existing.version}`, 24)}`,
        trace_id: `la_trace_${digest(`connector-enrichment:${packetHash}:${object.object_id}:update`, 24)}`,
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
        actor_id: "connector-enrichment-local-import",
        operation_id: `la_operation_${digest(`connector-enrichment:${object.object_id}:create`, 24)}`,
        trace_id: `la_trace_${digest(`connector-enrichment:${packetHash}:${object.object_id}`, 24)}`,
        recorded_at: recordedAt,
        object: object.draft
      });
      if (!result.ok) {
        failedObjects += 1;
        importStatus = "failed";
      } else {
        createdObjects += 1;
        if (status === "promoted") {
          promotedObjects += 1;
        } else {
          quarantineObjects += 1;
        }
      }
    }

    objectRefs.push({
      candidate_id: candidate.candidate_id,
      object_id: object.object_id,
      object_type: object.object_type,
      access_class: object.access_class,
      import_status: importStatus,
      source_id_hash: candidate.source.source_id_hash,
      evidence_hash: candidate.source.evidence_hash
    });
  }

  const graphStatus = store.status();
  const ledger: ConnectorEnrichmentImportLedger = {
    record_schema: "living-atlas-connector-enrichment-local-import:v1",
    recorded_at: recordedAt,
    authority_id: authorityId,
    packet_hash: packetHash,
    packet_generated_at: packet.generated_at,
    plaintext_policy: "hash-counts-refs-only",
    sync: { attempted: false },
    packet_totals: {
      candidate_count: report.candidate_count,
      promote_ready_count: report.promote_ready_count,
      held_count: report.held_count,
      duplicate_candidate_id_count: report.duplicate_candidate_id_count
    },
    import_totals: {
      created_objects: createdObjects,
      updated_existing_objects: updatedExistingObjects,
      already_existing_objects: alreadyExistingObjects,
      promoted_objects: promotedObjects,
      quarantine_objects: quarantineObjects,
      failed_objects: failedObjects
    },
    by_connector: report.by_connector,
    by_fact_kind: report.by_fact_kind,
    by_decision: report.by_decision,
    by_confidence: report.by_confidence,
    by_endpoint_type: report.by_endpoint_type,
    by_predicate: report.by_predicate,
    graph_status: {
      generation: graphStatus.generation,
      object_count: graphStatus.object_count,
      active_object_count: graphStatus.active_object_count,
      tombstone_count: graphStatus.tombstone_count,
      plaintext_persistence: graphStatus.plaintext_persistence
    },
    object_refs: objectRefs
  };

  assertNoNeedles("connector enrichment import ledger", ledger, needles);
  if (input.ledgerPath) {
    await writeJsonPrivate(input.ledgerPath, ledger);
  }

  const snapshot = await readTextIfExists(join(input.localGraphDir, "snapshot.json"));
  if (snapshot) {
    assertNoNeedles("connector enrichment local graph snapshot", snapshot, needles);
  }
  const journal = await readTextIfExists(join(input.localGraphDir, "journal.jsonl"));
  if (!journal && createdObjects > 0) {
    throw new Error("connector enrichment local graph journal was not written");
  }
  if (journal) {
    assertNoNeedles("connector enrichment local graph journal", journal, needles);
  }

  return ledger;
}

async function main(): Promise<void> {
  if (envValue("LIVING_ATLAS_CONNECTOR_ENRICHMENT_IMPORT_ACK") !== importAckValue) {
    throw new Error(`set LIVING_ATLAS_CONNECTOR_ENRICHMENT_IMPORT_ACK=${importAckValue} to write encrypted local connector objects`);
  }

  const ledger = await importConnectorEnrichmentPacket({
    packetPath: requireEnv("LIVING_ATLAS_CONNECTOR_ENRICHMENT_PACKET_PATH"),
    localGraphDir: requireEnv("LIVING_ATLAS_LOCAL_GRAPH_DIR"),
    keyringPath: requireEnv("LIVING_ATLAS_LOCAL_KEYRING"),
    keyringPassphrase: requireEnv("LIVING_ATLAS_LOCAL_KEYRING_PASSPHRASE"),
    authorityId: requireEnv("LIVING_ATLAS_LIVE_AUTHORITY_ID"),
    ledgerPath: envValue("LIVING_ATLAS_CONNECTOR_ENRICHMENT_LEDGER_PATH"),
    updateExisting: envValue("LIVING_ATLAS_CONNECTOR_ENRICHMENT_UPDATE_EXISTING_ACK") === "update-existing-encrypted-connector-objects"
  });
  console.log(JSON.stringify(ledger, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
