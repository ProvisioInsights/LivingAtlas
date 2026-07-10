import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  canonicalPayloadObjectId,
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
    if (!isReviewDecisionAction(action) || (statement !== undefined && (typeof statement !== "string" || statement.trim().length === 0 || statement.length > 4_096))) {
      sendJson(response, 400, { ok: false, reason: "invalid-review-decision" });
      return;
    }
    const candidateId = decisionMatch[1]!;
    const item = [...queue.owner_review, ...queue.research].find((candidate) => candidate.candidate_id === candidateId);
    if (!item || !context.graphStore) {
      sendJson(response, 409, { ok: false, reason: item ? "resolution-requires-durable-local-store" : "candidate-not-actionable" });
      return;
    }
    const expectedReviewVersion = context.graphStore.readObject(item.review_id)?.version;
    if (expectedReviewVersion === undefined) {
      sendJson(response, 409, { ok: false, reason: "candidate-review-missing" });
      return;
    }
    const decision = buildReviewDecision(context, item, action, typeof statement === "string" ? statement.trim() : undefined);
    if (!decision) {
      sendJson(response, 409, { ok: false, reason: "candidate-records-incomplete" });
      return;
    }
    const seed = `${candidateId}:${action}:${expectedReviewVersion}:${statement ?? ""}`;
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
    const actionable = [...queue.owner_review, ...queue.research];
    const resolutions = (candidateIds as string[]).map((candidateId) => {
      const item = actionable.find((candidate) => candidate.candidate_id === candidateId);
      const expectedReviewVersion = item ? context.graphStore!.readObject(item.review_id)?.version : undefined;
      const objects = item ? buildReviewDecision(context, item, action, undefined) : undefined;
      return item && expectedReviewVersion !== undefined && objects
        ? { candidate_id: candidateId, expected_review_version: expectedReviewVersion, objects }
        : undefined;
    });
    if (resolutions.some((resolution) => resolution === undefined)) {
      sendJson(response, 409, { ok: false, reason: "bulk-candidate-not-actionable" });
      return;
    }
    const seed = `${action}:${resolutions.map((resolution) => `${resolution!.candidate_id}:${resolution!.expected_review_version}`).sort().join("|")}`;
    const result = await localResolutionApplyBatch(context, {
      authorization: authorization ?? "",
      operation_id: `la_operation_${digest(`bulk:${seed}`)}`,
      idempotency_key: `la_idem_${digest(`bulk-decision:${seed}`)}`,
      expected_generation: context.graphStore.status().generation,
      resolutions: resolutions as NonNullable<(typeof resolutions)[number]>[]
    });
    sendJson(response, result.ok ? 200 : 409, result);
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

function isReviewDecisionAction(value: unknown): value is ReviewDecisionAction {
  return value === "keep" || value === "research" || value === "defer";
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function buildReviewDecision(
  context: LocalMcpContext,
  item: LocalReviewQueueItem,
  action: ReviewDecisionAction,
  statement: string | undefined
): unknown[] | undefined {
  if (!context.graphStore) return undefined;
  const recordedAt = context.now ?? new Date().toISOString();
  const review: CanonicalReviewItemPayload = {
    ...item.review_record,
    recommendation: action === "research" ? "research" : "owner-review",
    resolution_state: action === "keep" ? "resolved" : action === "research" ? "research" : "deferred-unknown",
    recorded_at: recordedAt
  };
  const proposed = item.proposed_records.map((payload): CanonicalPayload => {
    if (payload.schema !== "atlas.observation:v1") return payload;
    return {
      ...payload,
      ...(statement ? { statement } : {}),
      resolution_state: action === "research" ? "research" : action === "defer" ? "deferred-unknown" : payload.resolution_state,
      recorded_at: recordedAt
    };
  });
  const payloads: CanonicalPayload[] = [...proposed, review, ...item.parity_records];
  const drafts = payloads.map((payload) => {
    const object = context.graphStore!.readObject(canonicalPayloadObjectId(payload));
    if (!object) return undefined;
    return {
      ...object,
      version: object.version + 1,
      encryption_class: "plaintext",
      updated_at: recordedAt,
      content_hash: `sha256:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`,
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
