import { createWorkbenchServer } from "./server";

const server = createWorkbenchServer();

await new Promise<void>((resolve) => {
  server.listen(0, "127.0.0.1", resolve);
});

const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("Workbench smoke server did not bind to a TCP port.");
}

const baseUrl = `http://127.0.0.1:${address.port}`;

try {
  const [html, css, app, state] = await Promise.all([
    fetchText(`${baseUrl}/`),
    fetchText(`${baseUrl}/styles.css`),
    fetchText(`${baseUrl}/app.js`),
    fetchText(`${baseUrl}/workbench-state.js`)
  ]);
  const before = await fetchJson(`${baseUrl}/api/graph`);
  const afterCreate = await fetchJson(`${baseUrl}/api/nodes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      node: {
        type: "topic",
        subtype: "question",
        name: "Smoke test topic",
        access_class: "remote-safe",
        encryption_class: "plaintext",
        confidence: "high"
      }
    })
  });

  assertIncludes(html, "Graph Workbench", "html");
  assertIncludes(css, "--atlas-green", "css");
  assertIncludes(app, "/api/graph", "app");
  assertIncludes(state, "predicateRegistry", "state");
  assertGraphResponse(before, 8);
  assertGraphResponse(afterCreate, 9);
  console.log(JSON.stringify({
    ok: true,
    base_url: baseUrl,
    checked: ["html", "css", "app.js", "workbench-state.js", "api-graph", "api-node-create"]
  }, null, 2));
} finally {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }
  return response.text();
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }
  return response.json();
}

function assertIncludes(body: string, needle: string, label: string): void {
  if (!body.includes(needle)) {
    throw new Error(`${label} did not include ${needle}`);
  }
}

function assertGraphResponse(payload: unknown, expectedNodeCount: number): void {
  if (!payload || typeof payload !== "object") {
    throw new Error("API response was not an object");
  }
  const graph = (payload as { graph?: { nodes?: unknown[] } }).graph;
  if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length !== expectedNodeCount) {
    throw new Error(`Expected ${expectedNodeCount} graph nodes from API`);
  }
}
