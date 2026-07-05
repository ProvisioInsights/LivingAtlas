import { afterEach, describe, expect, it } from "vitest";
import { createWorkbenchServer } from "./server";

type TestServer = {
  url: string;
  close: () => Promise<void>;
};

const openServers: TestServer[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
});

describe("graph workbench server", () => {
  it("serves graph state and mutates nodes through the local API", async () => {
    const server = await startServer();
    const before = await fetchJson(`${server.url}/api/graph`);
    expect(nodeCount(before)).toBe(8);

    const created = await fetchJson(`${server.url}/api/nodes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        node: {
          type: "topic",
          subtype: "question",
          name: "API test topic",
          access_class: "remote-safe",
          encryption_class: "plaintext",
          confidence: "high"
        }
      })
    });
    expect(nodeCount(created)).toBe(9);
    const objectId = latestSubject(created);
    expect(objectId).toMatch(/^la_object_workbench_/);

    const updated = await fetchJson(`${server.url}/api/nodes/${objectId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        patch: {
          name: "API test topic updated"
        }
      })
    });
    expect(findNodeName(updated, objectId)).toBe("API test topic updated");

    const deleted = await fetchJson(`${server.url}/api/nodes/${objectId}`, {
      method: "DELETE"
    });
    expect(findNode(deleted, objectId)?.tombstone).toBe(true);
    expect(latestAction(deleted)).toBe("node.tombstoned");
  });

  it("mutates edges and exposes a local event stream handshake", async () => {
    const server = await startServer();
    const graph = await fetchJson(`${server.url}/api/graph`);
    const source = findNodeByName(graph, "Atlas Bridge");
    const target = findNodeByName(graph, "Host-blind sync");
    expect(source?.object_id).toBeTruthy();
    expect(target?.object_id).toBeTruthy();

    const created = await fetchJson(`${server.url}/api/edges`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        edge: {
          source_object_id: source?.object_id,
          source_type: source?.type,
          target_object_id: target?.object_id,
          target_type: target?.type,
          predicate: "about",
          valid_from: "2026",
          status: "active",
          confidence: "high",
          source: "server-test",
          access_class: "shareable",
          encryption_class: "remote-readable",
          attrs: {}
        }
      })
    });
    expect(edgeCount(created)).toBe(7);
    const edgeId = latestSubject(created);
    expect(edgeId).toMatch(/^la_edge_workbench_/);

    const updated = await fetchJson(`${server.url}/api/edges/${edgeId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ patch: { status: "ended", valid_to: "2026-06-24" } })
    });
    expect(findEdge(updated, edgeId)?.status).toBe("ended");

    const stream = await fetch(`${server.url}/api/events/stream`);
    expect(stream.ok).toBe(true);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    await stream.body?.cancel();
  });
});

async function startServer(): Promise<TestServer> {
  const server = createWorkbenchServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Server did not bind to TCP.");
  }
  const handle = {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })
  };
  openServers.push(handle);
  return handle;
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  expect(response.ok).toBe(true);
  return response.json();
}

function payloadGraph(payload: unknown) {
  const graph = (payload as { graph?: { nodes: unknown[]; edges: unknown[]; audit: { action: string; subject_id: string }[] } }).graph;
  if (!graph) {
    throw new Error("Missing graph payload.");
  }
  return graph;
}

function nodeCount(payload: unknown): number {
  return payloadGraph(payload).nodes.length;
}

function edgeCount(payload: unknown): number {
  return payloadGraph(payload).edges.length;
}

function latestAction(payload: unknown): string | undefined {
  return payloadGraph(payload).audit[0]?.action;
}

function latestSubject(payload: unknown): string {
  const subject = payloadGraph(payload).audit[0]?.subject_id;
  if (!subject) {
    throw new Error("Missing latest subject.");
  }
  return subject;
}

function findNode(payload: unknown, objectId: string) {
  return payloadGraph(payload).nodes.find((node) => (node as { object_id?: string }).object_id === objectId) as { name?: string; tombstone?: boolean } | undefined;
}

function findNodeByName(payload: unknown, name: string) {
  return payloadGraph(payload).nodes.find((node) => (node as { name?: string }).name === name) as { object_id: string; type: string } | undefined;
}

function findNodeName(payload: unknown, objectId: string): string | undefined {
  return findNode(payload, objectId)?.name;
}

function findEdge(payload: unknown, edgeId: string) {
  return payloadGraph(payload).edges.find((edge) => (edge as { edge_id?: string }).edge_id === edgeId) as { status?: string } | undefined;
}
