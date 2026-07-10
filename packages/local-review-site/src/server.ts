import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { authenticateLocalMcp, localResolutionApply, localResolutionApplyBatch, type LocalMcpContext } from "@living-atlas/local-mcp";
import { projectLocalReviewQueue } from "./review-projection";

export function createLocalReviewSiteServer(input: { context: LocalMcpContext }) {
  return createServer((request, response) => {
    void handleRequest(request, response, input.context).catch((error: unknown) => {
      const status = error instanceof JsonBodyError ? error.status : 500;
      const reason = error instanceof JsonBodyError ? error.reason : "internal-error";
      if (!response.headersSent) sendJson(response, status, { ok: false, reason });
      else response.destroy(error instanceof Error ? error : undefined);
    });
  });
}

async function handleRequest(request: IncomingMessage, response: ServerResponse, context: LocalMcpContext): Promise<void> {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (request.method === "GET" && pathname === "/") {
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
  const auth = await authenticateLocalMcp({ authorizationHeader: request.headers.authorization, credentialStore: context.credentialStore, controlPlane: context.controlPlane, auditSink: context.auditSink, now: context.now });
  if (!auth.ok) {
    sendJson(response, 401, { ok: false, reason: auth.reason });
    return;
  }
  const objects = context.graphStore ? context.graphStore.listObjects({ include_tombstones: false }) : context.graphObjects;
  const decryptPayload = context.decryptPayload ?? (async (object) => object.payload.kind === "plaintext-json" ? object.payload.data : undefined);
  const queue = await projectLocalReviewQueue({ objects, decryptPayload });
  if (request.method === "GET" && pathname === "/api/review-queue") {
    sendJson(response, 200, queue);
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
    const result = await localResolutionApplyBatch(context, { ...(body as Record<string, unknown>), authorization: request.headers.authorization ?? "" } as never);
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
    const result = await localResolutionApply(context, { ...(body as Record<string, unknown>), authorization: request.headers.authorization ?? "", candidate_id: candidateId } as never);
    sendJson(response, result.ok ? 200 : 409, result);
    return;
  }
  sendJson(response, 404, { ok: false, reason: "not-found" });
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
