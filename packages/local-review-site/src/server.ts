import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { authenticateLocalMcp, localResolutionApply, type LocalMcpContext } from "@living-atlas/local-mcp";
import { projectLocalReviewQueue } from "./review-projection";

export function createLocalReviewSiteServer(input: { context: LocalMcpContext }) {
  return createServer((request, response) => {
    void handleRequest(request, response, input.context);
  });
}

async function handleRequest(request: IncomingMessage, response: ServerResponse, context: LocalMcpContext): Promise<void> {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (request.method !== "GET" || pathname !== "/api/review-queue") {
    sendJson(response, 404, { ok: false, reason: "not-found" });
    return;
  }
  const auth = await authenticateLocalMcp({ authorizationHeader: request.headers.authorization, credentialStore: context.credentialStore, controlPlane: context.controlPlane, auditSink: context.auditSink, now: context.now });
  if (!auth.ok) {
    sendJson(response, 401, { ok: false, reason: auth.reason });
    return;
  }
  const objects = context.graphStore ? context.graphStore.listObjects({ include_tombstones: false }) : context.graphObjects;
  const decryptPayload = context.decryptPayload ?? (async (object) => object.payload.kind === "plaintext-json" ? object.payload.data : undefined);
  sendJson(response, 200, await projectLocalReviewQueue({ objects, decryptPayload }));
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

export { localResolutionApply };
