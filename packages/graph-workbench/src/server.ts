import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, transform } from "esbuild";
import {
  loadLocalGraphWorkbenchFromEnv,
  localGraphWorkbenchEnabled,
  type WorkbenchSourceCapabilities
} from "./local-graph-adapter";
import {
  createEdge,
  createNode,
  createSeedGraph,
  deleteEdge,
  latestCrudDraft,
  normalizeImportedGraph,
  tombstoneNode,
  updateEdge,
  updateNode,
  validateGraph,
  type AtlasEdge,
  type AtlasNode,
  type WorkbenchGraph
} from "./workbench-state";

const packageRoot = new URL("../", import.meta.url);
const maxJsonBodyBytes = 1024 * 1024;

export type WorkbenchServerOptions = {
  initialGraph?: WorkbenchGraph;
};

export function createWorkbenchServer(options: WorkbenchServerOptions = {}) {
  let graph = options.initialGraph ? structuredClone(options.initialGraph) : createSeedGraph();
  const subscribers = new Set<ServerResponse>();

  async function graphResponse() {
    const localGraph = await loadLocalGraphWorkbenchFromEnv();
    if (localGraph) {
      return {
        mode: localGraph.capabilities.source,
        graph: localGraph.graph,
        issues: validateGraph(localGraph.graph),
        latest_operation: latestCrudDraft(localGraph.graph),
        capabilities: localGraph.capabilities
      };
    }
    return {
      mode: "synthetic-server",
      graph,
      issues: validateGraph(graph),
      latest_operation: latestCrudDraft(graph),
      capabilities: syntheticCapabilities()
    };
  }

  function publishGraphEvent() {
    const event = {
      type: "graph.updated",
      at: new Date().toISOString(),
      latest_audit: graph.audit[0],
      node_count: graph.nodes.filter((node) => !node.tombstone).length,
      edge_count: graph.edges.filter((edge) => !edge.tombstone).length
    };
    for (const subscriber of subscribers) {
      subscriber.write(`event: graph\n`);
      subscriber.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  }

  return createServer((request, response) => {
    void handleRequest(request, response, {
      getGraph: () => graph,
      setGraph(nextGraph) {
        graph = nextGraph;
        publishGraphEvent();
      },
      graphResponse,
      subscribers
    });
  });
}

type ServerState = {
  getGraph: () => WorkbenchGraph;
  setGraph: (graph: WorkbenchGraph) => void;
  graphResponse: () => Promise<unknown>;
  subscribers: Set<ServerResponse>;
};

async function handleRequest(request: IncomingMessage, response: ServerResponse, state: ServerState): Promise<void> {
  const requestUrl = new URL(request.url ?? "/", "http://localhost");
  const pathname = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;

  try {
    if (pathname.startsWith("/api/")) {
      await handleApiRequest(request, response, pathname, state);
      return;
    }
    if (pathname === "/app.js") {
      await serveBundled(new URL("src/app.ts", packageRoot), response);
      return;
    }
    if (pathname === "/workbench-state.js") {
      await serveTranspiled(new URL("src/workbench-state.ts", packageRoot), response);
      return;
    }
    if (pathname === "/styles.css") {
      await serveFile(new URL("src/styles.css", packageRoot), response, "text/css; charset=utf-8");
      return;
    }
    if (pathname === "/index.html") {
      await serveFile(new URL("src/index.html", packageRoot), response, "text/html; charset=utf-8");
      return;
    }
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  } catch (error) {
    response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    response.end(error instanceof Error ? error.message : "Server error");
  }
}

async function handleApiRequest(request: IncomingMessage, response: ServerResponse, pathname: string, state: ServerState): Promise<void> {
  if (request.method === "GET" && pathname === "/api/graph") {
    sendJson(response, 200, await state.graphResponse());
    return;
  }

  if (request.method === "GET" && pathname === "/api/events") {
    sendJson(response, 200, { audit: state.getGraph().audit });
    return;
  }

  if (request.method === "GET" && pathname === "/api/events/stream") {
    response.writeHead(200, {
      "cache-control": "no-store",
      "connection": "keep-alive",
      "content-type": "text/event-stream; charset=utf-8"
    });
    response.write(`event: ready\n`);
    response.write(`data: ${JSON.stringify({ ok: true, at: new Date().toISOString() })}\n\n`);
    state.subscribers.add(response);
    request.on("close", () => {
      state.subscribers.delete(response);
    });
    return;
  }

  if (request.method === "POST" && pathname === "/api/graph/reset") {
    if (rejectReadonlyLocalGraph(response)) {
      return;
    }
    state.setGraph(createSeedGraph());
    sendJson(response, 200, await state.graphResponse());
    return;
  }

  if (request.method === "POST" && pathname === "/api/graph/import") {
    if (rejectReadonlyLocalGraph(response)) {
      return;
    }
    const body = await readJsonBody(request);
    const candidate = body && typeof body === "object" && "graph" in body ? (body as { graph: unknown }).graph : body;
    state.setGraph(normalizeImportedGraph(candidate));
    sendJson(response, 200, await state.graphResponse());
    return;
  }

  if (request.method === "POST" && pathname === "/api/nodes") {
    if (rejectReadonlyLocalGraph(response)) {
      return;
    }
    const body = await readJsonBody(request) as { node?: Omit<AtlasNode, "object_id" | "updated_at"> };
    if (!body.node) {
      sendJson(response, 400, { ok: false, reason: "missing-node" });
      return;
    }
    state.setGraph(createNode(state.getGraph(), body.node));
    sendJson(response, 200, await state.graphResponse());
    return;
  }

  const nodeMatch = /^\/api\/nodes\/([^/]+)$/.exec(pathname);
  if (nodeMatch && request.method === "PATCH") {
    if (rejectReadonlyLocalGraph(response)) {
      return;
    }
    const body = await readJsonBody(request) as { patch?: Partial<Omit<AtlasNode, "object_id">> };
    if (!body.patch) {
      sendJson(response, 400, { ok: false, reason: "missing-patch" });
      return;
    }
    state.setGraph(updateNode(state.getGraph(), decodeURIComponent(nodeMatch[1] ?? ""), body.patch));
    sendJson(response, 200, await state.graphResponse());
    return;
  }
  if (nodeMatch && request.method === "DELETE") {
    if (rejectReadonlyLocalGraph(response)) {
      return;
    }
    state.setGraph(tombstoneNode(state.getGraph(), decodeURIComponent(nodeMatch[1] ?? "")));
    sendJson(response, 200, await state.graphResponse());
    return;
  }

  if (request.method === "POST" && pathname === "/api/edges") {
    if (rejectReadonlyLocalGraph(response)) {
      return;
    }
    const body = await readJsonBody(request) as { edge?: Omit<AtlasEdge, "edge_id"> };
    if (!body.edge) {
      sendJson(response, 400, { ok: false, reason: "missing-edge" });
      return;
    }
    state.setGraph(createEdge(state.getGraph(), body.edge));
    sendJson(response, 200, await state.graphResponse());
    return;
  }

  const edgeMatch = /^\/api\/edges\/([^/]+)$/.exec(pathname);
  if (edgeMatch && request.method === "PATCH") {
    if (rejectReadonlyLocalGraph(response)) {
      return;
    }
    const body = await readJsonBody(request) as { patch?: Partial<Omit<AtlasEdge, "edge_id">> };
    if (!body.patch) {
      sendJson(response, 400, { ok: false, reason: "missing-patch" });
      return;
    }
    state.setGraph(updateEdge(state.getGraph(), decodeURIComponent(edgeMatch[1] ?? ""), body.patch));
    sendJson(response, 200, await state.graphResponse());
    return;
  }
  if (edgeMatch && request.method === "DELETE") {
    if (rejectReadonlyLocalGraph(response)) {
      return;
    }
    state.setGraph(deleteEdge(state.getGraph(), decodeURIComponent(edgeMatch[1] ?? "")));
    sendJson(response, 200, await state.graphResponse());
    return;
  }

  sendJson(response, 404, { ok: false, reason: "not-found" });
}

function rejectReadonlyLocalGraph(response: ServerResponse): boolean {
  if (!localGraphWorkbenchEnabled()) {
    return false;
  }
  sendJson(response, 409, {
    ok: false,
    reason: "local-graph-workbench-is-readonly",
    capabilities: {
      source: "local-graph-readonly",
      mutable: false,
      event_stream: true
    } satisfies WorkbenchSourceCapabilities
  });
  return true;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > maxJsonBodyBytes) {
      throw new Error("JSON body exceeds 1 MiB limit.");
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(body, null, 2));
}

function syntheticCapabilities(): WorkbenchSourceCapabilities {
  return {
    source: "synthetic-server",
    mutable: true,
    event_stream: true
  };
}

async function serveTranspiled(fileUrl: URL, response: ServerResponse): Promise<void> {
  const source = await readFile(fileUrl, "utf8");
  const output = await transform(source, {
    sourcefile: fileURLToPath(fileUrl),
    format: "esm",
    loader: "ts",
    sourcemap: false,
    target: "es2022"
  });
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-type": "text/javascript; charset=utf-8"
  });
  response.end(output.code);
}

async function serveBundled(fileUrl: URL, response: ServerResponse): Promise<void> {
  const output = await build({
    absWorkingDir: fileURLToPath(packageRoot),
    bundle: true,
    entryPoints: [fileURLToPath(fileUrl)],
    format: "esm",
    logLevel: "silent",
    minify: false,
    platform: "browser",
    sourcemap: "inline",
    target: "es2022",
    write: false
  });
  const bundled = output.outputFiles[0]?.text;
  if (!bundled) {
    throw new Error("Workbench bundle produced no output.");
  }
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-type": "text/javascript; charset=utf-8"
  });
  response.end(bundled);
}

async function serveFile(fileUrl: URL, response: ServerResponse, contentType?: string): Promise<void> {
  const body = await readFile(fileUrl);
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-type": contentType ?? contentTypeFor(fileUrl.pathname)
  });
  response.end(body);
}

function contentTypeFor(pathname: string): string {
  const extension = extname(pathname);
  if (extension === ".html") {
    return "text/html; charset=utf-8";
  }
  if (extension === ".css") {
    return "text/css; charset=utf-8";
  }
  if (extension === ".js") {
    return "text/javascript; charset=utf-8";
  }
  return "application/octet-stream";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.LIVING_ATLAS_WORKBENCH_PORT ?? "5177");
  createWorkbenchServer().listen(port, "127.0.0.1", () => {
    console.log(`Living Atlas graph workbench: http://127.0.0.1:${port}`);
  });
}
