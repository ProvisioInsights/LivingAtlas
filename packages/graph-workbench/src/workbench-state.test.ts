import { describe, expect, it } from "vitest";
import {
  bucketVisibleGraph,
  createEdge,
  createNode,
  createSeedGraph,
  deleteEdge,
  focusVisibleGraph,
  getVisibleGraph,
  nodeImportanceScore,
  nodeIssueSeverity,
  nodeTypes,
  tombstoneNode,
  updateNode,
  validateGraph,
  type AtlasEdge
} from "./workbench-state";

describe("graph workbench state", () => {
  it("filters access modes without exposing local-private nodes to standard remote", () => {
    const graph = createSeedGraph();
    const allTypes = new Set(nodeTypes);

    const remote = getVisibleGraph(graph, "remote", allTypes, "");
    expect(remote.nodes.every((node) => node.access_class !== "local-private" && node.access_class !== "quarantine")).toBe(true);

    const cloudUnlock = getVisibleGraph(graph, "cloud-unlock", allTypes, "");
    expect(cloudUnlock.nodes.some((node) => node.access_class === "local-private")).toBe(true);
    expect(cloudUnlock.nodes.some((node) => node.access_class === "quarantine")).toBe(false);

    const local = getVisibleGraph(graph, "local", allTypes, "");
    expect(local.nodes.length).toBe(graph.nodes.length);
  });

  it("creates, updates, and tombstones nodes with audit entries", () => {
    const graph = createSeedGraph();
    const created = createNode(graph, {
      type: "topic",
      subtype: "question",
      name: "Review queue",
      access_class: "remote-safe",
      encryption_class: "plaintext",
      confidence: "medium"
    }, "2026-06-24T13:00:00.000Z");
    const objectId = created.selectedNodeId;
    expect(objectId).toMatch(/^la_object_workbench_/);

    const updated = updateNode(created, objectId ?? "", { name: "Review queue refined" }, "2026-06-24T13:01:00.000Z");
    expect(updated.nodes.find((node) => node.object_id === objectId)?.name).toBe("Review queue refined");

    const tombstoned = tombstoneNode(updated, objectId ?? "", "2026-06-24T13:02:00.000Z");
    expect(tombstoned.nodes.find((node) => node.object_id === objectId)?.tombstone).toBe(true);
    expect(tombstoned.audit.map((entry) => entry.action).slice(0, 3)).toEqual(["node.tombstoned", "node.updated", "node.created"]);
  });

  it("validates predicate domain and range", () => {
    const graph = createSeedGraph();
    const badEdge: AtlasEdge = {
      edge_id: "la_edge_badpredicate0001",
      source_object_id: "la_object_topic_demo0001",
      source_type: "topic",
      target_object_id: "la_object_location_demo0001",
      target_type: "location",
      predicate: "advises",
      valid_from: "2026",
      status: "active",
      confidence: "low",
      source: "test",
      access_class: "remote-safe",
      encryption_class: "plaintext",
      attrs: {}
    };

    const issues = validateGraph({ ...graph, edges: [...graph.edges, badEdge] });
    expect(issues.some((issue) => issue.subject_id === badEdge.edge_id && issue.severity === "error")).toBe(true);
  });

  it("creates and deletes edges as tombstones", () => {
    const graph = createSeedGraph();
    const created = createEdge(graph, {
      source_object_id: "la_object_project_demo0001",
      source_type: "project",
      target_object_id: "la_object_topic_demo0001",
      target_type: "topic",
      predicate: "about",
      valid_from: "2026",
      status: "active",
      confidence: "high",
      source: "test",
      access_class: "shareable",
      encryption_class: "remote-readable",
      attrs: {}
    });
    const edgeId = created.selectedEdgeId;
    expect(edgeId).toMatch(/^la_edge_workbench_/);

    const deleted = deleteEdge(created, edgeId ?? "");
    expect(deleted.edges.find((edge) => edge.edge_id === edgeId)?.tombstone).toBe(true);
    expect(deleted.audit[0]?.action).toBe("edge.deleted");
  });

  it("collapses dense visible object nodes into readable buckets", () => {
    const graph = createSeedGraph();
    const dense = {
      ...graph,
      edges: [],
      nodes: Array.from({ length: 120 }, (_, index) => ({
        object_id: `la_object_dense${String(index).padStart(8, "0")}`,
        type: "object" as const,
        subtype: "page",
        name: `page:${index}`,
        description: "import/logseq-offering-item-review/quarantine / ciphertext-inline",
        access_class: "quarantine" as const,
        encryption_class: "client-encrypted" as const,
        confidence: "medium" as const,
        updated_at: "2026-06-24T12:00:00.000Z"
      }))
    };

    const visible = getVisibleGraph(dense, "local", new Set(nodeTypes), "");
    const bucketed = bucketVisibleGraph(visible);
    expect(bucketed.nodes).toHaveLength(1);
    expect(bucketed.nodes[0]).toMatchObject({
      type: "object",
      subtype: "bucket",
      access_class: "quarantine",
      bucket_count: 120,
      issue_severity: "warning",
      issue_count: 120
    });
    expect(bucketed.edges).toHaveLength(0);
  });

  it("marks review nodes and increases importance for cleanup targets", () => {
    const graph = createSeedGraph();
    const cleanNode = graph.nodes.find((node) => node.access_class === "remote-safe" && node.confidence === "high");
    const reviewNode = graph.nodes.find((node) => node.access_class === "quarantine");
    expect(cleanNode).toBeDefined();
    expect(reviewNode).toBeDefined();

    expect(nodeIssueSeverity(cleanNode!)).toBe("ok");
    expect(nodeIssueSeverity(reviewNode!)).toBe("warning");
    expect(nodeImportanceScore(reviewNode!, 2)).toBeGreaterThan(nodeImportanceScore(cleanNode!, 2));
  });

  it("focuses a selected node to the requested hop depth", () => {
    const graph = createSeedGraph();
    const visible = getVisibleGraph(graph, "local", new Set(nodeTypes), "");
    const oneHop = focusVisibleGraph(visible, {
      nodeId: "la_object_person_demo0001",
      depth: 1
    });
    expect(oneHop.nodes.map((node) => node.object_id).sort()).toEqual([
      "la_object_occurrence_demo0001",
      "la_object_person_demo0001",
      "la_object_project_demo0001"
    ]);
    expect(oneHop.edges.map((edge) => edge.edge_id).sort()).toEqual([
      "la_edge_demo_advises0001",
      "la_edge_demo_participant0001"
    ]);

    const twoHop = focusVisibleGraph(visible, {
      nodeId: "la_object_person_demo0001",
      depth: 2
    });
    expect(twoHop.nodes.map((node) => node.object_id)).toEqual(expect.arrayContaining([
      "la_object_location_demo0001",
      "la_object_topic_demo0001"
    ]));
  });

  it("focuses a selected edge to its endpoints at depth zero", () => {
    const graph = createSeedGraph();
    const visible = getVisibleGraph(graph, "local", new Set(nodeTypes), "");
    const focused = focusVisibleGraph(visible, {
      edgeId: "la_edge_demo_instance0001",
      depth: 0
    });
    expect(focused.nodes.map((node) => node.object_id).sort()).toEqual([
      "la_object_item_demo0001",
      "la_object_offering_demo0001"
    ]);
    expect(focused.edges.map((edge) => edge.edge_id)).toEqual(["la_edge_demo_instance0001"]);
  });
});
