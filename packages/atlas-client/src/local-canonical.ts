import { createHash } from "node:crypto";
import {
  CanonicalWriteSchema,
  canonicalPayloadObjectId,
  parseCanonicalExport,
  type CanonicalExport,
  type GraphObjectEnvelope
} from "@living-atlas/contracts";
import {
  loadCanonicalEntityResolutionsFromObjects,
  projectCanonicalEntityResolutions,
  resolveCanonicalEntityId,
  type CanonicalEntityRedirect
} from "@living-atlas/graph-service";
import type { FileLocalGraphStore, LocalGraphTransactionResult } from "@living-atlas/local-graph-store";
import type { PlaintextGraphObjectDraft } from "@living-atlas/local-keyring";

export type LocalCanonicalPayloadDecryptor = (object: GraphObjectEnvelope) => Promise<Record<string, unknown> | undefined>;

export type LocalCanonicalAtlasClient = {
  exportCanonical(input?: { exported_at?: string }): Promise<CanonicalExport>;
  entityGet(entity_id: string): Promise<Record<string, unknown> | undefined>;
  resolveEntityId(entity_id: string): Promise<CanonicalEntityRedirect>;
  assertionsForEntity(entity_id: string): Promise<Record<string, unknown>[]>;
  observationsForEntity(entity_id: string): Promise<Record<string, unknown>[]>;
  relationshipsForEntity(entity_id: string): Promise<Record<string, unknown>[]>;
  provenanceForAssertion(assertion_id: string): Promise<{ assertion: Record<string, unknown>; evidence: Record<string, unknown>[] } | undefined>;
  importCanonical(input: {
    exported: unknown;
    expected_generation: number;
    actor_id: string;
    operation_id: string;
    idempotency_key: string;
    recorded_at?: string;
  }): Promise<LocalGraphTransactionResult>;
};

const CanonicalObjectTypes = new Set<GraphObjectEnvelope["object_type"]>([
  "entity", "assertion", "edge", "evidence", "review", "manifest"
]);

function canonicalPayloadHash(payload: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
}

export function createLocalCanonicalAtlasClient(input: {
  graphStore: FileLocalGraphStore;
  decryptPayload: LocalCanonicalPayloadDecryptor;
  now?: string;
}): LocalCanonicalAtlasClient {
  const timestamp = () => input.now ?? new Date().toISOString();
  return {
    async entityGet(entity_id) {
      const object = input.graphStore.readObject(entity_id);
      if (!object || object.visible_metadata.tombstone || object.object_type !== "entity") return undefined;
      const payload = await input.decryptPayload(object);
      const parsed = CanonicalWriteSchema.safeParse({ object_type: object.object_type, payload });
      return parsed.success && parsed.data.payload.schema === "atlas.entity:v1" ? parsed.data.payload : undefined;
    },
    async resolveEntityId(entity_id) {
      const resolutions = await loadCanonicalEntityResolutionsFromObjects(
        input.graphStore.listObjects(),
        input.decryptPayload
      );
      return resolveCanonicalEntityId(entity_id, projectCanonicalEntityResolutions(resolutions));
    },
    async assertionsForEntity(entity_id) {
      const resolved = await this.resolveEntityId(entity_id);
      const assertions: Record<string, unknown>[] = [];
      for (const object of input.graphStore.listObjects().filter((item) => item.object_type === "assertion" && !item.visible_metadata.tombstone)) {
        const payload = await input.decryptPayload(object);
        const parsed = CanonicalWriteSchema.safeParse({ object_type: object.object_type, payload });
        if (parsed.success && parsed.data.payload.schema === "atlas.fact:v1"
          && parsed.data.payload.subject_entity_id === resolved.canonical_entity_id) {
          assertions.push(parsed.data.payload);
        }
      }
      return assertions.sort((left, right) => String(left.assertion_id).localeCompare(String(right.assertion_id)));
    },
    async observationsForEntity(entity_id) {
      const resolved = await this.resolveEntityId(entity_id);
      const observations: Record<string, unknown>[] = [];
      for (const object of input.graphStore.listObjects().filter((item) => item.object_type === "assertion" && !item.visible_metadata.tombstone)) {
        const payload = await input.decryptPayload(object);
        const parsed = CanonicalWriteSchema.safeParse({ object_type: object.object_type, payload });
        if (parsed.success && parsed.data.payload.schema === "atlas.observation:v1"
          && parsed.data.payload.candidate_entity_ids.includes(resolved.canonical_entity_id)) {
          observations.push(parsed.data.payload);
        }
      }
      return observations.sort((left, right) => String(left.assertion_id).localeCompare(String(right.assertion_id)));
    },
    async relationshipsForEntity(entity_id) {
      const resolved = await this.resolveEntityId(entity_id);
      const relationships: Record<string, unknown>[] = [];
      for (const object of input.graphStore.listObjects().filter((item) => item.object_type === "edge" && !item.visible_metadata.tombstone)) {
        const payload = await input.decryptPayload(object);
        const parsed = CanonicalWriteSchema.safeParse({ object_type: object.object_type, payload });
        if (parsed.success && parsed.data.payload.schema === "atlas.relationship:v2"
          && (parsed.data.payload.source_entity_id === resolved.canonical_entity_id
            || parsed.data.payload.target_entity_id === resolved.canonical_entity_id)) {
          relationships.push(parsed.data.payload);
        }
      }
      return relationships.sort((left, right) => String(left.assertion_id).localeCompare(String(right.assertion_id)));
    },
    async provenanceForAssertion(assertion_id) {
      const object = input.graphStore.readObject(assertion_id);
      if (!object || object.visible_metadata.tombstone || (object.object_type !== "assertion" && object.object_type !== "edge")) return undefined;
      const payload = await input.decryptPayload(object);
      const parsed = CanonicalWriteSchema.safeParse({ object_type: object.object_type, payload });
      if (!parsed.success) return undefined;
      const assertion = parsed.data.payload;
      const evidenceIds = assertion.schema === "atlas.observation:v1"
        ? new Set(assertion.evidence_refs)
        : assertion.schema === "atlas.fact:v1" || assertion.schema === "atlas.relationship:v2"
          ? new Set([...assertion.evidence_links.map((link) => link.evidence_id), ...assertion.confidence.evidence_refs])
          : undefined;
      if (!evidenceIds) return undefined;
      const evidence: Record<string, unknown>[] = [];
      for (const evidenceObject of input.graphStore.listObjects().filter((item) => item.object_type === "evidence" && !item.visible_metadata.tombstone && evidenceIds.has(item.object_id))) {
        const evidencePayload = await input.decryptPayload(evidenceObject);
        const parsedEvidence = CanonicalWriteSchema.safeParse({ object_type: evidenceObject.object_type, payload: evidencePayload });
        if (parsedEvidence.success && parsedEvidence.data.payload.schema === "atlas.evidence:v1") evidence.push(parsedEvidence.data.payload);
      }
      return { assertion, evidence: evidence.sort((left, right) => String(left.evidence_id).localeCompare(String(right.evidence_id))) };
    },
    async exportCanonical(options = {}) {
      const records = [];
      for (const object of input.graphStore.listObjects().filter((item) => CanonicalObjectTypes.has(item.object_type))) {
        const payload = await input.decryptPayload(object);
        const write = CanonicalWriteSchema.safeParse({ object_type: object.object_type, payload });
        if (!write.success || object.object_id !== canonicalPayloadObjectId(write.data.payload)) {
          throw new Error("canonical-export-invalid-object");
        }
        records.push({
          authority_id: object.authority_id,
          object_id: object.object_id,
          object_type: object.object_type,
          version: object.version,
          access_class: object.access_class,
          content_hash: canonicalPayloadHash(write.data.payload),
          payload: write.data.payload
        });
      }
      return parseCanonicalExport({
        export_schema: "living-atlas-canonical-export:v1",
        plaintext_policy: "local-keyholding-canonical-export",
        authority_id: input.graphStore.status().authority_id,
        exported_at: options.exported_at ?? timestamp(),
        records: records.sort((left, right) => left.object_id.localeCompare(right.object_id))
      });
    },
    async importCanonical(request) {
      const exported = parseCanonicalExport(request.exported);
      if (exported.authority_id !== input.graphStore.status().authority_id) {
        throw new Error("canonical-import-authority-mismatch");
      }
      for (const record of exported.records) {
        if (canonicalPayloadHash(record.payload) !== record.content_hash) {
          throw new Error("canonical-import-content-hash-mismatch");
        }
      }
      const recordedAt = request.recorded_at ?? timestamp();
      const drafts: PlaintextGraphObjectDraft[] = exported.records.map((record) => ({
        schema_version: 1,
        authority_id: record.authority_id,
        object_id: record.object_id,
        object_type: record.object_type,
        version: record.version,
        access_class: record.access_class,
        encryption_class: "plaintext",
        created_at: recordedAt,
        updated_at: recordedAt,
        content_hash: record.content_hash,
        visible_metadata: { tombstone: false, remote_indexable: false },
        payload: { kind: "plaintext-json", data: record.payload }
      }));
      return input.graphStore.commitTransaction({
        expected_generation: request.expected_generation,
        actor_id: request.actor_id,
        operation_id: request.operation_id,
        idempotency_key: request.idempotency_key,
        recorded_at: recordedAt,
        writes: drafts.map((object) => ({ kind: "create" as const, object }))
      });
    }
  };
}
