import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  canonicalObjectTypeForPayload,
  canonicalPayloadObjectId,
  type CanonicalObservationPayload,
  type CanonicalPayload,
  type CanonicalReviewItemPayload
} from "@living-atlas/contracts";
import { authenticateLocalMcp, localResolutionApply, localResolutionApplyBatch, type LocalMcpContext } from "@living-atlas/local-mcp";
import { projectLocalReviewQueue, type LocalReviewQueueItem } from "./review-projection";

const browserSessionCookie = "atlas_review_session";

export function createLocalReviewSiteServer(input: {
  context: LocalMcpContext;
  browserSessionAuthorization?: string;
}) {
  const browserSessions = new Map<string, string>();
  return createServer((request, response) => {
    void handleRequest(request, response, input.context, browserSessions, input.browserSessionAuthorization).catch((error: unknown) => {
      const status = error instanceof JsonBodyError ? error.status : 500;
      const reason = error instanceof JsonBodyError ? error.reason : "internal-error";
      if (!response.headersSent) sendJson(response, status, { ok: false, reason });
      else response.destroy(error instanceof Error ? error : undefined);
    });
  });
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: LocalMcpContext,
  browserSessions: Map<string, string>,
  browserSessionAuthorization: string | undefined
): Promise<void> {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (request.method === "GET" && pathname === "/") {
    if (!browserAuthorizationFromCookie(request, browserSessions) && browserSessionAuthorization) {
      const launchAuth = await authenticateLocalMcp({
        authorizationHeader: browserSessionAuthorization,
        credentialStore: context.credentialStore,
        controlPlane: context.controlPlane,
        auditSink: context.auditSink,
        now: context.now
      });
      if (launchAuth.ok) {
        const sessionId = randomBytes(32).toString("base64url");
        browserSessions.set(sessionId, browserSessionAuthorization);
        response.setHeader("set-cookie", `${browserSessionCookie}=${sessionId}; HttpOnly; SameSite=Strict; Path=/`);
      }
    }
    response.writeHead(200, { "cache-control": "no-store", "content-type": "text/html; charset=utf-8" });
    response.end(await readFile(new URL("./index.html", import.meta.url)));
    return;
  }
  if (request.method === "GET" && pathname === "/app.js") {
    response.writeHead(200, { "cache-control": "no-store", "content-type": "text/javascript; charset=utf-8" });
    response.end(await readFile(new URL("./app.js", import.meta.url)));
    return;
  }
  if (request.method === "GET" && pathname === "/styles.css") {
    response.writeHead(200, { "cache-control": "no-store", "content-type": "text/css; charset=utf-8" });
    response.end(await readFile(new URL("./styles.css", import.meta.url)));
    return;
  }
  const authorization = request.headers.authorization ?? browserAuthorizationFromCookie(request, browserSessions);
  const auth = await authenticateLocalMcp({
    authorizationHeader: authorization,
    credentialStore: context.credentialStore,
    controlPlane: context.controlPlane,
    auditSink: context.auditSink,
    now: context.now
  });
  if (!auth.ok) {
    sendJson(response, 401, { ok: false, reason: auth.reason });
    return;
  }
  const objects = context.graphStore ? context.graphStore.listObjects({ include_tombstones: false }) : context.graphObjects;
  const decryptPayload = context.decryptPayload
    ? async (object: Parameters<NonNullable<LocalMcpContext["decryptPayload"]>>[0]) => {
      const payload = await context.decryptPayload!(object);
      return payload?.kind === "plaintext-json" ? payload.data : undefined;
    }
    : async (object: Parameters<NonNullable<LocalMcpContext["decryptPayload"]>>[0]) => (
      object.payload.kind === "plaintext-json" ? object.payload.data : undefined
    );
  const queue = await projectLocalReviewQueue({ objects, decryptPayload });
  if (request.method === "GET" && pathname === "/api/review-queue") {
    sendJson(response, 200, queue);
    return;
  }
  const decisionMatch = /^\/api\/review\/(la_candidate_[A-Za-z0-9_-]{8,})\/decision$/.exec(pathname);
  if (request.method === "POST" && decisionMatch) {
    const body = await readJson(request);
    const action = (body as { action?: unknown }).action;
    const statement = (body as { statement?: unknown }).statement;
    const statements = (body as { statements?: unknown }).statements;
    const observationEdits = (body as { observation_edits?: unknown }).observation_edits;
    const unitIds = (body as { unit_ids?: unknown }).unit_ids;
    if (!isReviewDecisionAction(action)
      || (statement !== undefined && (typeof statement !== "string" || statement.trim().length === 0 || statement.length > 4_096))
      || (statements !== undefined && (!Array.isArray(statements) || statements.length === 0 || statements.length > 512
        || statements.some((value) => typeof value !== "string" || value.trim().length === 0 || value.length > 8_192)))
      || ((statement !== undefined || statements !== undefined) && action !== "keep")
      || (observationEdits !== undefined && (!Array.isArray(observationEdits) || observationEdits.length === 0 || observationEdits.length > 512
        || observationEdits.some((value) => !isObservationEdit(value))
        || new Set(observationEdits.map((value) => (value as ObservationEdit).observation_id)).size !== observationEdits.length
        || action !== "keep"))
      || (unitIds !== undefined && (!Array.isArray(unitIds) || unitIds.length === 0 || unitIds.length > 512
        || unitIds.some((value) => typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value))
        || new Set(unitIds).size !== unitIds.length || action !== "research"))) {
      sendJson(response, 400, { ok: false, reason: "invalid-review-decision" });
      return;
    }
    const candidateId = decisionMatch[1]!;
    const item = [...queue.owner_review, ...queue.research].find((candidate) => candidate.candidate_id === candidateId);
    const completedItem = queue.automatic.find((candidate) => candidate.candidate_id === candidateId);
    if (!item && completedItem && isIdempotentRichEditRetry(completedItem, action, observationEdits)) {
      const status = context.graphStore?.status();
      sendJson(response, 200, {
        ok: true,
        result: {
          local_commit: "committed",
          resolved_candidate_ids: [candidateId],
          ...(status ? { generation: status.generation, journal_sequence: status.journal_sequence } : {}),
          idempotent: true
        }
      });
      return;
    }
    if (!item || !context.graphStore) {
      sendJson(response, 409, { ok: false, reason: item ? "resolution-requires-durable-local-store" : "candidate-not-actionable" });
      return;
    }
    if (item.resolution_mode === "incomplete") {
      sendJson(response, 409, { ok: false, reason: "candidate-records-incomplete" });
      return;
    }
    if (Array.isArray(statements) && statements.length !== item.source_accounting.meaningful_units.length) {
      sendJson(response, 400, { ok: false, reason: "invalid-review-decision" });
      return;
    }
    const richObservationIds = mappedObservationIds(item);
    if ((observationEdits !== undefined && (item.resolution_mode !== "rich"
      || (observationEdits as ObservationEdit[]).some((edit) => !richObservationIds.has(edit.observation_id))))
      || ((statement !== undefined || statements !== undefined) && item.resolution_mode !== "legacy")) {
      sendJson(response, 400, { ok: false, reason: "invalid-review-decision" });
      return;
    }
    const sourceUnitIds = new Set(item.source_accounting.meaningful_units.map((unit) => unit.unit_id));
    if (Array.isArray(unitIds) && unitIds.some((unitId) => !sourceUnitIds.has(unitId as `sha256:${string}`))) {
      sendJson(response, 400, { ok: false, reason: "invalid-review-decision" });
      return;
    }
    const expectedReviewVersion = context.graphStore.readObject(item.review_id)?.version;
    if (expectedReviewVersion === undefined) {
      sendJson(response, 409, { ok: false, reason: "candidate-review-missing" });
      return;
    }
    const decision = buildReviewDecision(
      context,
      item,
      action,
      Array.isArray(statements) ? statements.map((value) => String(value).trim())
        : typeof statement === "string" ? [statement.trim()] : undefined,
      Array.isArray(observationEdits) ? observationEdits.map((value) => ({
        observation_id: (value as ObservationEdit).observation_id,
        statement: (value as ObservationEdit).statement
      })) : undefined,
      Array.isArray(unitIds) ? unitIds.map(String) : undefined
    );
    if (!decision) {
      sendJson(response, 409, { ok: false, reason: "candidate-records-incomplete" });
      return;
    }
    const seed = `${candidateId}:${action}:${expectedReviewVersion}:${JSON.stringify(observationEdits ?? statements ?? statement ?? "")}:${JSON.stringify(unitIds ?? [])}`;
    const result = await localResolutionApply(context, {
      authorization: authorization ?? "",
      operation_id: `la_operation_${digest(seed)}`,
      idempotency_key: `la_idem_${digest(`decision:${seed}`)}`,
      candidate_id: candidateId,
      expected_generation: context.graphStore.status().generation,
      expected_review_version: expectedReviewVersion,
      objects: decision
    });
    sendJson(response, result.ok ? 200 : 409, result);
    return;
  }
  if (request.method === "POST" && pathname === "/api/review/bulk/decision") {
    const body = await readJson(request);
    const action = (body as { action?: unknown }).action;
    const candidateIds = (body as { candidate_ids?: unknown }).candidate_ids;
    if (!isReviewDecisionAction(action)
      || !Array.isArray(candidateIds)
      || candidateIds.length === 0
      || candidateIds.length > 100
      || candidateIds.some((candidate) => typeof candidate !== "string")
      || new Set(candidateIds).size !== candidateIds.length
      || !context.graphStore) {
      sendJson(response, 400, { ok: false, reason: "invalid-bulk-review-decision" });
      return;
    }
    const actionable = new Map([...queue.owner_review, ...queue.research].map((item) => [item.candidate_id, item]));
    const orderedCandidateIds = [...(candidateIds as string[])].sort((left, right) => left.localeCompare(right));
    const results: Array<{
      candidate_id: string;
      ok: boolean;
      result?: unknown;
      reason?: string;
    }> = [];
    for (const candidateId of orderedCandidateIds) {
      try {
        const item = actionable.get(candidateId);
        const expectedReviewVersion = item ? context.graphStore.readObject(item.review_id)?.version : undefined;
        const objects = item ? buildReviewDecision(context, item, action, undefined, undefined) : undefined;
        if (!item || expectedReviewVersion === undefined || !objects) {
          results.push({
            candidate_id: candidateId,
            ok: false,
            reason: !item ? "candidate-not-actionable"
              : expectedReviewVersion === undefined ? "candidate-review-missing"
                : "candidate-records-incomplete"
          });
          continue;
        }
        const seed = `${candidateId}:${action}:${expectedReviewVersion}`;
        const result = await localResolutionApply(context, {
          authorization: authorization ?? "",
          operation_id: `la_operation_${digest(`bulk-item:${seed}`)}`,
          idempotency_key: `la_idem_${digest(`bulk-item-decision:${seed}`)}`,
          candidate_id: candidateId,
          expected_generation: context.graphStore.status().generation,
          expected_review_version: expectedReviewVersion,
          objects
        });
        results.push({ candidate_id: candidateId, ...result });
      } catch {
        results.push({ candidate_id: candidateId, ok: false, reason: "candidate-transaction-exception" });
      }
    }
    const committedCandidateIds = results.filter((result) => result.ok).map((result) => result.candidate_id);
    const failedCandidateIds = results.filter((result) => !result.ok).map((result) => result.candidate_id);
    if (failedCandidateIds.length > 0) {
      sendJson(response, 409, {
        ok: false,
        reason: committedCandidateIds.length > 0 ? "bulk-decision-partial-failure" : "bulk-decision-failed",
        committed_candidate_ids: committedCandidateIds,
        failed_candidate_ids: failedCandidateIds,
        results
      });
      return;
    }
    sendJson(response, 200, {
      ok: true,
      result: { local_commit: "committed", resolved_candidate_ids: committedCandidateIds },
      results
    });
    return;
  }
  if (request.method === "POST" && pathname === "/api/review/bulk/apply") {
    const body = await readJson(request);
    const resolutions = Array.isArray((body as { resolutions?: unknown }).resolutions) ? (body as { resolutions: Array<{ candidate_id?: unknown }> }).resolutions : [];
    const ownerCandidates = new Set(queue.owner_review.map((item) => item.candidate_id));
    if (resolutions.length === 0 || resolutions.some((resolution) => typeof resolution.candidate_id !== "string" || !ownerCandidates.has(resolution.candidate_id))) {
      sendJson(response, 409, { ok: false, reason: "candidate-not-owner-review" });
      return;
    }
    const result = await localResolutionApplyBatch(context, { ...(body as Record<string, unknown>), authorization: authorization ?? "" } as never);
    sendJson(response, result.ok ? 200 : 409, result);
    return;
  }
  const match = /^\/api\/review\/(la_candidate_[A-Za-z0-9_-]{8,})\/apply$/.exec(pathname);
  if (request.method === "POST" && match) {
    const candidateId = match[1]!;
    if (!queue.owner_review.some((item) => item.candidate_id === candidateId)) {
      sendJson(response, 409, { ok: false, reason: "candidate-not-owner-review" });
      return;
    }
    const body = await readJson(request);
    const result = await localResolutionApply(context, { ...(body as Record<string, unknown>), authorization: authorization ?? "", candidate_id: candidateId } as never);
    sendJson(response, result.ok ? 200 : 409, result);
    return;
  }
  sendJson(response, 404, { ok: false, reason: "not-found" });
}

type ReviewDecisionAction = "keep" | "research" | "defer";
type ObservationEdit = { observation_id: string; statement: string };

function isReviewDecisionAction(value: unknown): value is ReviewDecisionAction {
  return value === "keep" || value === "research" || value === "defer";
}

function isObservationEdit(value: unknown): value is ObservationEdit {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const edit = value as Record<string, unknown>;
  return typeof edit.observation_id === "string"
    && /^la_object_[A-Za-z0-9_-]{8,}$/.test(edit.observation_id)
    && typeof edit.statement === "string"
    && edit.statement.trim().length > 0
    && edit.statement.length <= 8_192;
}

function mappedObservationIds(item: LocalReviewQueueItem): Set<string> {
  return new Set(item.unit_mappings.flatMap((mapping) => mapping.observation_ids));
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function successorObservationId(observationId: string, statement: string): string {
  return `la_object_${digest(`observation-successor:${observationId}:${statement}`)}`;
}

function isIdempotentRichEditRetry(
  item: LocalReviewQueueItem,
  action: unknown,
  observationEdits: unknown
): boolean {
  if (action !== "keep" || !Array.isArray(observationEdits) || observationEdits.length === 0) return false;
  const observations = new Map(item.proposed_records.flatMap((payload) => (
    payload.schema === "atlas.observation:v1" ? [[payload.assertion_id, payload] as const] : []
  )));
  return observationEdits.every((value) => {
    if (!isObservationEdit(value)) return false;
    const successor = observations.get(successorObservationId(value.observation_id, value.statement));
    return successor?.statement === value.statement;
  });
}

function buildReviewDecision(
  context: LocalMcpContext,
  item: LocalReviewQueueItem,
  action: ReviewDecisionAction,
  statements: string[] | undefined,
  observationEdits: ObservationEdit[] | undefined,
  researchUnitIds: string[] | undefined = undefined
): unknown[] | undefined {
  if (!context.graphStore) return undefined;
  const recordedAt = context.now ?? new Date().toISOString();
  if (item.resolution_mode === "incomplete") return undefined;
  if (action === "keep" && !item.source_accounting.exact_source_preserved) return undefined;
  const richCandidate = item.resolution_mode === "rich";
  const legacyPlaceholder = item.resolution_mode === "legacy";
  const extractedObservations: CanonicalPayload[] = action === "keep" && legacyPlaceholder
    ? item.source_accounting.meaningful_units.map((unit, index) => ({
      schema: "atlas.observation:v1" as const,
      assertion_id: `la_object_${digest(`source-unit:${item.candidate_id}:${index}:${unit.atlas_text}`)}`,
      statement: statements?.[index] ?? unit.atlas_text,
      candidate_entity_ids: [],
      resolution_state: "owner-review" as const,
      recorded_at: recordedAt,
      evidence_refs: item.evidence_ids
    }))
    : [];
  const observationEditById = new Map((observationEdits ?? []).map((edit) => [edit.observation_id, edit.statement]));
  const observationSuccessorPairs = richCandidate && action === "keep"
    ? item.proposed_records.flatMap((payload): Array<{ originalId: string; successor: CanonicalObservationPayload }> => {
      if (payload.schema !== "atlas.observation:v1") return [];
      const editedStatement = observationEditById.get(payload.assertion_id);
      if (editedStatement === undefined) return [];
      return [{
        originalId: payload.assertion_id,
        successor: {
          ...payload,
          assertion_id: successorObservationId(payload.assertion_id, editedStatement),
          statement: editedStatement,
          recorded_at: recordedAt,
          supersedes: [payload.assertion_id]
        }
      }];
    })
    : [];
  const observationSuccessors = observationSuccessorPairs.map(({ successor }) => successor);
  if (observationSuccessors.some((payload) => context.graphStore!.readObject(canonicalPayloadObjectId(payload)))) {
    return undefined;
  }
  const successorByOriginalId = new Map(observationSuccessorPairs.map(({ originalId, successor }) => [originalId, successor]));
  const keptPayloads = extractedObservations.length > 0
    ? extractedObservations
    : richCandidate && action === "keep"
      ? item.proposed_records.map((payload) => (
        payload.schema === "atlas.observation:v1"
          ? successorByOriginalId.get(payload.assertion_id) ?? payload
          : payload
      ))
      : item.proposed_records;
  const keptIds = keptPayloads.map(canonicalPayloadObjectId);
  const requestedUnitHashes = [...new Set([
    ...(item.review_record.research_requested_unit_hashes ?? []),
    ...(researchUnitIds ?? [])
  ])];
  const review: CanonicalReviewItemPayload = {
    ...item.review_record,
    recommendation: action === "research" ? "research" : "owner-review",
    resolution_state: action === "keep" ? "resolved" : action === "research" ? "research" : "deferred-unknown",
    proposed_object_ids: action === "keep" ? keptIds : item.review_record.proposed_object_ids,
    ...(action === "research" ? {
      research_requested_at: recordedAt,
      research_requested_all: researchUnitIds === undefined ? true : Boolean(item.review_record.research_requested_all),
      research_requested_unit_hashes: requestedUnitHashes as Array<`sha256:${string}`>
    } : {}),
    recorded_at: recordedAt
  };
  const observationPayloads: CanonicalPayload[] = legacyPlaceholder && action === "keep"
    ? extractedObservations
    : richCandidate && action === "keep"
      ? observationSuccessors
      : [];
  const keptObservationIds = new Set(keptPayloads.flatMap((payload) => (
    payload.schema === "atlas.observation:v1" ? [payload.assertion_id] : []
  )));
  const parityRecords: CanonicalPayload[] = item.parity_records.map((parity) => (
    legacyPlaceholder && action === "keep"
      ? {
        ...parity,
        coverage_state: "represented",
        representation_kind: "observation",
        canonical_object_ids: [...keptObservationIds],
        recorded_at: recordedAt
      }
      : richCandidate && action === "keep"
        ? {
          ...parity,
          canonical_object_ids: parity.canonical_object_ids.map((objectId) => (
            successorByOriginalId.get(objectId)?.assertion_id ?? objectId
          )),
          recorded_at: recordedAt
        }
        : { ...parity, recorded_at: recordedAt }
  ));
  const payloads: CanonicalPayload[] = [
    ...observationPayloads,
    review,
    ...parityRecords
  ];
  const drafts = payloads.map((payload) => {
    const object = context.graphStore!.readObject(canonicalPayloadObjectId(payload));
    const contentHash = `sha256:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}` as const;
    if (!object) {
      return {
        schema_version: 1,
        authority_id: context.controlPlane.authority.authority_id,
        object_id: canonicalPayloadObjectId(payload),
        object_type: canonicalObjectTypeForPayload(payload),
        version: 1,
        access_class: "local-private",
        encryption_class: "plaintext",
        created_at: recordedAt,
        updated_at: recordedAt,
        content_hash: contentHash,
        visible_metadata: {
          schema_namespace: "atlas/review-resolution",
          tombstone: false,
          size_class: "small",
          remote_indexable: false
        },
        payload: { kind: "plaintext-json", data: payload }
      };
    }
    return {
      ...object,
      version: object.version + 1,
      encryption_class: "plaintext",
      updated_at: recordedAt,
      content_hash: contentHash,
      payload: { kind: "plaintext-json", data: payload }
    };
  });
  return drafts.every((draft) => draft !== undefined) ? drafts : undefined;
}

function browserAuthorizationFromCookie(request: IncomingMessage, browserSessions: Map<string, string>): string | undefined {
  const sessionId = request.headers.cookie
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${browserSessionCookie}=`))
    ?.slice(browserSessionCookie.length + 1);
  return sessionId ? browserSessions.get(sessionId) : undefined;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maxJsonBodyBytes) throw new JsonBodyError(413, "request-body-too-large");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new JsonBodyError(400, "invalid-json");
  }
}

const maxJsonBodyBytes = 1024 * 1024;

class JsonBodyError extends Error {
  constructor(readonly status: 400 | 413, readonly reason: "invalid-json" | "request-body-too-large") {
    super(reason);
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

export { localResolutionApply };
