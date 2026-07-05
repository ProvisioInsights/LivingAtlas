export const nodeTypes = ["person", "organization", "project", "location", "occurrence", "topic", "offering", "item", "object"] as const;
export type NodeType = (typeof nodeTypes)[number];

export const accessModes = ["remote", "cloud-unlock", "local"] as const;
export type AccessMode = (typeof accessModes)[number];

export type AccessClass = "remote-safe" | "shareable" | "release" | "local-private" | "quarantine";
export type EncryptionClass = "plaintext" | "remote-readable" | "client-encrypted" | "local-only-index";
export type Confidence = "high" | "medium" | "low";
export type EdgeStatus = "active" | "pending" | "ended" | "dormant";

export type AtlasNode = {
  object_id: string;
  type: NodeType;
  subtype: string;
  name: string;
  description?: string;
  access_class: AccessClass;
  encryption_class: EncryptionClass;
  confidence: Confidence;
  updated_at: string;
  tombstone?: boolean;
};

export type AtlasEdge = {
  edge_id: string;
  source_object_id: string;
  source_type: NodeType;
  target_object_id: string;
  target_type: NodeType;
  predicate: Predicate;
  valid_from: string;
  valid_to?: string;
  status: EdgeStatus;
  confidence: Confidence;
  source: string;
  access_class: AccessClass;
  encryption_class: EncryptionClass;
  attrs: Record<string, string | number | boolean>;
  tombstone?: boolean;
};

export type AuditAction =
  | "node.created"
  | "node.updated"
  | "node.tombstoned"
  | "edge.created"
  | "edge.updated"
  | "edge.deleted"
  | "graph.imported";

export type AuditEntry = {
  event_id: string;
  at: string;
  action: AuditAction;
  subject_id: string;
  summary: string;
  operation: Record<string, unknown>;
};

export type WorkbenchGraph = {
  nodes: AtlasNode[];
  edges: AtlasEdge[];
  audit: AuditEntry[];
  selectedNodeId?: string;
  selectedEdgeId?: string;
};

export type KnownPredicate =
  | "advises"
  | "about"
  | "participant-in"
  | "occurred-at"
  | "offered-by"
  | "instance-of"
  | "purchased"
  | "created"
  | "created-for"
  | "related-topic";
export type Predicate = KnownPredicate | string;
export type NodeIssueSeverity = "ok" | "warning" | "error";

export type PredicateDefinition = {
  category: string;
  direction: "directed" | "symmetric";
  domain: readonly NodeType[];
  range: readonly NodeType[];
};

export const predicateRegistry: Record<KnownPredicate, PredicateDefinition> = {
  advises: { category: "advisory", direction: "directed", domain: ["person"], range: ["organization", "project", "offering"] },
  about: { category: "taxonomy", direction: "directed", domain: ["person", "organization", "project", "offering", "item", "occurrence"], range: ["topic"] },
  "participant-in": { category: "occurrence", direction: "directed", domain: ["person", "organization"], range: ["occurrence"] },
  "occurred-at": { category: "occurrence", direction: "directed", domain: ["occurrence"], range: ["location"] },
  "offered-by": { category: "commerce", direction: "directed", domain: ["offering"], range: ["organization"] },
  "instance-of": { category: "commerce", direction: "directed", domain: ["item"], range: ["offering"] },
  purchased: { category: "commerce", direction: "directed", domain: ["person", "organization"], range: ["offering", "item"] },
  created: { category: "creation", direction: "directed", domain: ["person", "organization"], range: ["item", "offering"] },
  "created-for": { category: "creation", direction: "directed", domain: ["item", "offering"], range: ["person", "organization", "project", "offering"] },
  "related-topic": { category: "taxonomy", direction: "symmetric", domain: ["topic"], range: ["topic"] }
};

export type VisibleNode = AtlasNode & {
  x: number;
  y: number;
  issue_severity: NodeIssueSeverity;
  issue_count: number;
  importance_score: number;
  bucket_count?: number;
  member_ids?: string[];
  bucket_key?: string;
};

export type VisibleGraph = {
  nodes: VisibleNode[];
  edges: AtlasEdge[];
  withheld: {
    nodes: number;
    edges: number;
  };
};

export type ValidationIssue = {
  severity: "error" | "warning";
  subject_id: string;
  message: string;
};

export type CrudDraft =
  | { tool: "object_create"; input: { object: AtlasNode } }
  | { tool: "object_update"; input: { object_id: string; patch: Partial<AtlasNode> } }
  | { tool: "object_delete"; input: { object_id: string } }
  | { tool: "edge_create"; input: { edge: AtlasEdge } }
  | { tool: "edge_update"; input: { edge_id: string; patch: Partial<AtlasEdge> } }
  | { tool: "edge_delete"; input: { edge_id: string } };

const typeOrder = new Map<NodeType, number>(nodeTypes.map((type, index) => [type, index]));

const seedTime = "2026-06-24T12:00:00.000Z";

export function createSeedGraph(): WorkbenchGraph {
  const nodes: AtlasNode[] = [
    {
      object_id: "la_object_person_demo0001",
      type: "person",
      subtype: "individual",
      name: "Mira Vale",
      description: "Synthetic private collaborator.",
      access_class: "local-private",
      encryption_class: "client-encrypted",
      confidence: "high",
      updated_at: seedTime
    },
    {
      object_id: "la_object_org_demo0001",
      type: "organization",
      subtype: "company",
      name: "Helio Works",
      description: "Synthetic organization.",
      access_class: "remote-safe",
      encryption_class: "plaintext",
      confidence: "high",
      updated_at: seedTime
    },
    {
      object_id: "la_object_project_demo0001",
      type: "project",
      subtype: "initiative",
      name: "Atlas Bridge",
      description: "Synthetic project used for graph operations.",
      access_class: "shareable",
      encryption_class: "remote-readable",
      confidence: "medium",
      updated_at: seedTime
    },
    {
      object_id: "la_object_location_demo0001",
      type: "location",
      subtype: "venue",
      name: "North Terminal",
      description: "Synthetic venue.",
      access_class: "shareable",
      encryption_class: "remote-readable",
      confidence: "medium",
      updated_at: seedTime
    },
    {
      object_id: "la_object_occurrence_demo0001",
      type: "occurrence",
      subtype: "meeting",
      name: "Design review",
      description: "Synthetic dated occurrence.",
      access_class: "local-private",
      encryption_class: "client-encrypted",
      confidence: "medium",
      updated_at: seedTime
    },
    {
      object_id: "la_object_topic_demo0001",
      type: "topic",
      subtype: "domain",
      name: "Host-blind sync",
      description: "Synthetic topic.",
      access_class: "remote-safe",
      encryption_class: "plaintext",
      confidence: "high",
      updated_at: seedTime
    },
    {
      object_id: "la_object_offering_demo0001",
      type: "offering",
      subtype: "software-product",
      name: "Signal vault plan",
      description: "Synthetic offering.",
      access_class: "remote-safe",
      encryption_class: "plaintext",
      confidence: "medium",
      updated_at: seedTime
    },
    {
      object_id: "la_object_item_demo0001",
      type: "item",
      subtype: "created-work",
      name: "Demo notebook",
      description: "Synthetic item in review.",
      access_class: "quarantine",
      encryption_class: "client-encrypted",
      confidence: "low",
      updated_at: seedTime
    }
  ];

  const edges: AtlasEdge[] = [
    {
      edge_id: "la_edge_demo_advises0001",
      source_object_id: "la_object_person_demo0001",
      source_type: "person",
      target_object_id: "la_object_project_demo0001",
      target_type: "project",
      predicate: "advises",
      valid_from: "2026-06",
      status: "active",
      confidence: "high",
      source: "synthetic-workbench",
      access_class: "local-private",
      encryption_class: "client-encrypted",
      attrs: { scope: "prototype" }
    },
    {
      edge_id: "la_edge_demo_about0001",
      source_object_id: "la_object_project_demo0001",
      source_type: "project",
      target_object_id: "la_object_topic_demo0001",
      target_type: "topic",
      predicate: "about",
      valid_from: "2026",
      status: "active",
      confidence: "medium",
      source: "synthetic-workbench",
      access_class: "shareable",
      encryption_class: "remote-readable",
      attrs: {}
    },
    {
      edge_id: "la_edge_demo_participant0001",
      source_object_id: "la_object_person_demo0001",
      source_type: "person",
      target_object_id: "la_object_occurrence_demo0001",
      target_type: "occurrence",
      predicate: "participant-in",
      valid_from: "2026-06-24",
      status: "active",
      confidence: "medium",
      source: "synthetic-workbench",
      access_class: "local-private",
      encryption_class: "client-encrypted",
      attrs: { role: "reviewer" }
    },
    {
      edge_id: "la_edge_demo_place0001",
      source_object_id: "la_object_occurrence_demo0001",
      source_type: "occurrence",
      target_object_id: "la_object_location_demo0001",
      target_type: "location",
      predicate: "occurred-at",
      valid_from: "2026-06-24",
      status: "active",
      confidence: "medium",
      source: "synthetic-workbench",
      access_class: "shareable",
      encryption_class: "remote-readable",
      attrs: {}
    },
    {
      edge_id: "la_edge_demo_offered0001",
      source_object_id: "la_object_offering_demo0001",
      source_type: "offering",
      target_object_id: "la_object_org_demo0001",
      target_type: "organization",
      predicate: "offered-by",
      valid_from: "2025",
      status: "active",
      confidence: "medium",
      source: "synthetic-workbench",
      access_class: "remote-safe",
      encryption_class: "plaintext",
      attrs: {}
    },
    {
      edge_id: "la_edge_demo_instance0001",
      source_object_id: "la_object_item_demo0001",
      source_type: "item",
      target_object_id: "la_object_offering_demo0001",
      target_type: "offering",
      predicate: "instance-of",
      valid_from: "2026-06",
      status: "pending",
      confidence: "low",
      source: "synthetic-workbench",
      access_class: "quarantine",
      encryption_class: "client-encrypted",
      attrs: { review: true }
    }
  ];

  return {
    nodes,
    edges,
    audit: [
      createAuditEntry("graph.imported", "synthetic-seed", "Seed graph loaded", {
        source: "synthetic-workbench",
        nodes: nodes.length,
        edges: edges.length
      })
    ],
    selectedNodeId: nodes[0]?.object_id
  };
}

export function cloneGraph(graph: WorkbenchGraph): WorkbenchGraph {
  return JSON.parse(JSON.stringify(graph)) as WorkbenchGraph;
}

export function getVisibleGraph(graph: WorkbenchGraph, mode: AccessMode, enabledTypes: ReadonlySet<NodeType>, query: string): VisibleGraph {
  const normalizedQuery = query.trim().toLowerCase();
  const activeNodes = graph.nodes.filter((node) => !node.tombstone);
  const modeNodes = activeNodes.filter((node) => isVisibleByMode(node.access_class, node.encryption_class, mode));
  const searchedNodes = modeNodes.filter((node) => enabledTypes.has(node.type) && matchesQuery(node, normalizedQuery));
  const visibleNodeIds = new Set(searchedNodes.map((node) => node.object_id));
  const visibleEdges = graph.edges.filter((edge) => {
    return !edge.tombstone
      && isVisibleByMode(edge.access_class, edge.encryption_class, mode)
      && visibleNodeIds.has(edge.source_object_id)
      && visibleNodeIds.has(edge.target_object_id)
      && matchesEdgeQuery(edge, normalizedQuery);
  });

  return {
    nodes: positionNodes(searchedNodes, visibleEdges),
    edges: visibleEdges,
    withheld: {
      nodes: activeNodes.length - searchedNodes.length,
      edges: graph.edges.filter((edge) => !edge.tombstone).length - visibleEdges.length
    }
  };
}

export function bucketVisibleGraph(visible: VisibleGraph): VisibleGraph {
  if (visible.nodes.length <= 1) {
    return visible;
  }

  const groups = new Map<string, { nodes: VisibleNode[]; latest: string }>();
  for (const node of visible.nodes) {
    const key = bucketKey(node);
    const group = groups.get(key);
    if (group) {
      group.nodes.push(node);
      if (node.updated_at > group.latest) {
        group.latest = node.updated_at;
      }
    } else {
      groups.set(key, { nodes: [node], latest: node.updated_at });
    }
  }

  const buckets: VisibleNode[] = [...groups.entries()].map(([key, group]) => {
    const first = group.nodes[0]!;
    const namespace = bucketNamespace(first);
    const issueCount = group.nodes.reduce((count, node) => count + (node.issue_severity === "ok" ? 0 : Math.max(node.issue_count, 1)), 0);
    const issueSeverity = maxSeverity(group.nodes.map((node) => node.issue_severity));
    const importanceScore = group.nodes.reduce((score, node) => score + node.importance_score, 0) + Math.log10(group.nodes.length + 1) * 8;
    return {
      object_id: `bucket_${stableHash(key)}`,
      type: first.type,
      subtype: "bucket",
      name: `${bucketLabel(namespace, first)} (${group.nodes.length})`,
      description: `${group.nodes.length} ${first.type} records grouped by ${namespace}`,
      access_class: first.access_class,
      encryption_class: first.encryption_class,
      confidence: group.nodes.some((node) => node.confidence === "low") ? "low" : group.nodes.some((node) => node.confidence === "medium") ? "medium" : "high",
      updated_at: group.latest,
      x: 0,
      y: 0,
      issue_severity: issueSeverity,
      issue_count: issueCount,
      importance_score: importanceScore,
      bucket_key: key,
      bucket_count: group.nodes.length,
      member_ids: group.nodes.map((node) => node.object_id)
    };
  });

  const bucketNodes = positionBucketNodes(buckets);

  return {
    nodes: bucketNodes,
    edges: [],
    withheld: visible.withheld
  };
}

export function focusVisibleGraph(visible: VisibleGraph, focus: { nodeId?: string; edgeId?: string; depth: number }): VisibleGraph {
  const nodesById = new Map(visible.nodes.map((node) => [node.object_id, node]));
  const edgesById = new Map(visible.edges.map((edge) => [edge.edge_id, edge]));
  const rootIds = new Set<string>();
  const selectedEdge = focus.edgeId ? edgesById.get(focus.edgeId) : undefined;

  if (selectedEdge) {
    rootIds.add(selectedEdge.source_object_id);
    rootIds.add(selectedEdge.target_object_id);
  }
  if (focus.nodeId && nodesById.has(focus.nodeId)) {
    rootIds.add(focus.nodeId);
  }
  if (rootIds.size === 0) {
    return visible;
  }

  const distanceByNode = new Map<string, number>();
  const queue: string[] = [];
  for (const rootId of rootIds) {
    distanceByNode.set(rootId, 0);
    queue.push(rootId);
  }

  while (queue.length > 0) {
    const currentId = queue.shift()!;
    const distance = distanceByNode.get(currentId) ?? 0;
    if (distance >= focus.depth) {
      continue;
    }
    for (const edge of visible.edges) {
      const neighborId = edge.source_object_id === currentId
        ? edge.target_object_id
        : edge.target_object_id === currentId
          ? edge.source_object_id
          : undefined;
      if (!neighborId || distanceByNode.has(neighborId) || !nodesById.has(neighborId)) {
        continue;
      }
      distanceByNode.set(neighborId, distance + 1);
      queue.push(neighborId);
    }
  }

  const focusedNodeIds = new Set(distanceByNode.keys());
  const focusedEdges = visible.edges.filter((edge) => {
    const betweenFocusedNodes = focusedNodeIds.has(edge.source_object_id) && focusedNodeIds.has(edge.target_object_id);
    return betweenFocusedNodes || edge.edge_id === focus.edgeId;
  });
  const focusedNodes = positionFocusedNodes(
    [...focusedNodeIds].map((nodeId) => nodesById.get(nodeId)!).filter(Boolean),
    distanceByNode,
    rootIds
  );

  return {
    nodes: focusedNodes,
    edges: focusedEdges,
    withheld: {
      nodes: visible.withheld.nodes + Math.max(visible.nodes.length - focusedNodes.length, 0),
      edges: visible.withheld.edges + Math.max(visible.edges.length - focusedEdges.length, 0)
    }
  };
}

export function createNode(graph: WorkbenchGraph, draft: Omit<AtlasNode, "object_id" | "updated_at">, now = new Date().toISOString()): WorkbenchGraph {
  const objectId = nextId("la_object_workbench_", graph.nodes.map((node) => node.object_id));
  const node: AtlasNode = {
    ...draft,
    object_id: objectId,
    updated_at: now
  };
  return withAudit({
    ...cloneGraph(graph),
    nodes: [...graph.nodes, node],
    selectedNodeId: objectId,
    selectedEdgeId: undefined
  }, "node.created", objectId, `Created ${node.type} node`, { tool: "object_create", input: { object: node } });
}

export function updateNode(graph: WorkbenchGraph, objectId: string, patch: Partial<Omit<AtlasNode, "object_id">>, now = new Date().toISOString()): WorkbenchGraph {
  let updatedNode: AtlasNode | undefined;
  const next = cloneGraph(graph);
  next.nodes = next.nodes.map((node) => {
    if (node.object_id !== objectId) {
      return node;
    }
    updatedNode = {
      ...node,
      ...patch,
      object_id: node.object_id,
      updated_at: now
    };
    return updatedNode;
  });
  if (!updatedNode) {
    return next;
  }
  return withAudit(next, "node.updated", objectId, `Updated ${updatedNode.name}`, {
    tool: "object_update",
    input: { object_id: objectId, patch: { ...patch, updated_at: now } }
  });
}

export function tombstoneNode(graph: WorkbenchGraph, objectId: string, now = new Date().toISOString()): WorkbenchGraph {
  const next = cloneGraph(graph);
  next.nodes = next.nodes.map((node) => node.object_id === objectId ? { ...node, tombstone: true, updated_at: now } : node);
  next.edges = next.edges.map((edge) => edge.source_object_id === objectId || edge.target_object_id === objectId ? { ...edge, tombstone: true } : edge);
  next.selectedNodeId = undefined;
  next.selectedEdgeId = undefined;
  return withAudit(next, "node.tombstoned", objectId, "Tombstoned node and attached edges", {
    tool: "object_delete",
    input: { object_id: objectId }
  });
}

export function createEdge(graph: WorkbenchGraph, draft: Omit<AtlasEdge, "edge_id">): WorkbenchGraph {
  const edgeId = nextId("la_edge_workbench_", graph.edges.map((edge) => edge.edge_id));
  const edge: AtlasEdge = { ...draft, edge_id: edgeId };
  return withAudit({
    ...cloneGraph(graph),
    edges: [...graph.edges, edge],
    selectedEdgeId: edgeId,
    selectedNodeId: undefined
  }, "edge.created", edgeId, `Created ${edge.predicate} edge`, { tool: "edge_create", input: { edge } });
}

export function updateEdge(graph: WorkbenchGraph, edgeId: string, patch: Partial<Omit<AtlasEdge, "edge_id">>): WorkbenchGraph {
  let updatedEdge: AtlasEdge | undefined;
  const next = cloneGraph(graph);
  next.edges = next.edges.map((edge) => {
    if (edge.edge_id !== edgeId) {
      return edge;
    }
    updatedEdge = { ...edge, ...patch, edge_id: edge.edge_id };
    return updatedEdge;
  });
  if (!updatedEdge) {
    return next;
  }
  return withAudit(next, "edge.updated", edgeId, `Updated ${updatedEdge.predicate} edge`, {
    tool: "edge_update",
    input: { edge_id: edgeId, patch }
  });
}

export function deleteEdge(graph: WorkbenchGraph, edgeId: string): WorkbenchGraph {
  const next = cloneGraph(graph);
  next.edges = next.edges.map((edge) => edge.edge_id === edgeId ? { ...edge, tombstone: true } : edge);
  next.selectedEdgeId = undefined;
  return withAudit(next, "edge.deleted", edgeId, "Deleted edge", {
    tool: "edge_delete",
    input: { edge_id: edgeId }
  });
}

export function validateGraph(graph: WorkbenchGraph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const nodes = graph.nodes.filter((node) => !node.tombstone);
  const edges = graph.edges.filter((edge) => !edge.tombstone);
  const seenNodeIds = new Set<string>();
  const seenEdgeIds = new Set<string>();
  const nodesById = new Map(nodes.map((node) => [node.object_id, node]));

  for (const node of nodes) {
    if (seenNodeIds.has(node.object_id)) {
      issues.push({ severity: "error", subject_id: node.object_id, message: "Duplicate node id" });
    }
    seenNodeIds.add(node.object_id);
    if (node.access_class === "local-private" && node.encryption_class !== "client-encrypted") {
      issues.push({ severity: "warning", subject_id: node.object_id, message: "Local-private node should be client-encrypted" });
    }
  }

  for (const edge of edges) {
    if (seenEdgeIds.has(edge.edge_id)) {
      issues.push({ severity: "error", subject_id: edge.edge_id, message: "Duplicate edge id" });
    }
    seenEdgeIds.add(edge.edge_id);

    const source = nodesById.get(edge.source_object_id);
    const target = nodesById.get(edge.target_object_id);
    if (!source) {
      issues.push({ severity: "error", subject_id: edge.edge_id, message: "Missing source node" });
      continue;
    }
    if (!target) {
      issues.push({ severity: "error", subject_id: edge.edge_id, message: "Missing target node" });
      continue;
    }

    const registry = predicateRegistry[edge.predicate as KnownPredicate];
    if (registry) {
      if (!registry.domain.includes(source.type)) {
        issues.push({ severity: "error", subject_id: edge.edge_id, message: `${edge.predicate} does not accept ${source.type} as source` });
      }
      if (!registry.range.includes(target.type)) {
        issues.push({ severity: "error", subject_id: edge.edge_id, message: `${edge.predicate} does not accept ${target.type} as target` });
      }
    } else {
      issues.push({ severity: "warning", subject_id: edge.edge_id, message: `${edge.predicate} is not in the workbench validation subset` });
    }
    if (edge.source_type !== source.type) {
      issues.push({ severity: "warning", subject_id: edge.edge_id, message: "Stored source_type differs from source node type" });
    }
    if (edge.target_type !== target.type) {
      issues.push({ severity: "warning", subject_id: edge.edge_id, message: "Stored target_type differs from target node type" });
    }
  }

  return issues;
}

export function nodeIssueSeverity(node: AtlasNode): NodeIssueSeverity {
  if (!node.name.trim() || !node.subtype.trim()) {
    return "error";
  }
  if (node.access_class === "quarantine" || node.confidence === "low" || node.tombstone) {
    return "warning";
  }
  if (node.access_class === "local-private" && node.encryption_class !== "client-encrypted") {
    return "warning";
  }
  return "ok";
}

export function nodeImportanceScore(node: AtlasNode, degree = 0): number {
  let score = 1 + degree * 4;
  if (node.access_class === "quarantine") {
    score += 14;
  } else if (node.access_class === "local-private") {
    score += 6;
  } else if (node.access_class === "shareable" || node.access_class === "release") {
    score += 2;
  }
  if (node.confidence === "low") {
    score += 10;
  } else if (node.confidence === "medium") {
    score += 2;
  }
  if (node.encryption_class === "client-encrypted") {
    score += 3;
  }
  return score;
}

export function latestCrudDraft(graph: WorkbenchGraph): CrudDraft | undefined {
  const operation = graph.audit[0]?.operation;
  if (!operation || !("tool" in operation) || !("input" in operation)) {
    return undefined;
  }
  return operation as CrudDraft;
}

export function normalizeImportedGraph(input: unknown): WorkbenchGraph {
  if (!input || typeof input !== "object") {
    throw new Error("Graph JSON must be an object.");
  }
  const candidate = input as Partial<WorkbenchGraph>;
  if (!Array.isArray(candidate.nodes) || !Array.isArray(candidate.edges)) {
    throw new Error("Graph JSON must include nodes and edges arrays.");
  }
  const graph: WorkbenchGraph = {
    nodes: candidate.nodes as AtlasNode[],
    edges: candidate.edges as AtlasEdge[],
    audit: Array.isArray(candidate.audit) ? candidate.audit as AuditEntry[] : [],
    selectedNodeId: candidate.selectedNodeId,
    selectedEdgeId: candidate.selectedEdgeId
  };
  if (validateGraph(graph).some((issue) => issue.severity === "error")) {
    throw new Error("Graph JSON contains validation errors.");
  }
  return withAudit(graph, "graph.imported", "import", "Imported graph JSON", {
    source: "workbench-json"
  });
}

function isVisibleByMode(accessClass: AccessClass, encryptionClass: EncryptionClass, mode: AccessMode): boolean {
  if (mode === "local") {
    return true;
  }
  if (mode === "cloud-unlock") {
    return accessClass !== "quarantine";
  }
  return (accessClass === "remote-safe" || accessClass === "shareable" || accessClass === "release")
    && encryptionClass !== "client-encrypted";
}

function matchesQuery(node: AtlasNode, query: string): boolean {
  if (!query) {
    return true;
  }
  return [node.name, node.type, node.subtype, node.description ?? "", node.object_id].some((value) => value.toLowerCase().includes(query));
}

function matchesEdgeQuery(edge: AtlasEdge, query: string): boolean {
  if (!query) {
    return true;
  }
  return [edge.edge_id, edge.predicate, edge.source, edge.status, edge.access_class].some((value) => value.toLowerCase().includes(query));
}

function positionNodes(nodes: AtlasNode[], edges: AtlasEdge[]): VisibleNode[] {
  const degreeByNode = new Map<string, number>();
  for (const edge of edges) {
    degreeByNode.set(edge.source_object_id, (degreeByNode.get(edge.source_object_id) ?? 0) + 1);
    degreeByNode.set(edge.target_object_id, (degreeByNode.get(edge.target_object_id) ?? 0) + 1);
  }
  const sorted = [...nodes].sort((left, right) => {
    const typeDelta = (typeOrder.get(left.type) ?? 0) - (typeOrder.get(right.type) ?? 0);
    const importanceDelta = nodeImportanceScore(right, degreeByNode.get(right.object_id) ?? 0) - nodeImportanceScore(left, degreeByNode.get(left.object_id) ?? 0);
    return typeDelta || importanceDelta || left.name.localeCompare(right.name);
  });
  const centerX = 450;
  const centerY = 300;
  const rings: Record<AccessClass, number> = {
    "remote-safe": 120,
    shareable: 180,
    release: 220,
    "local-private": 250,
    quarantine: 285
  };
  return sorted.map((node, index) => {
    const angle = -Math.PI / 2 + (index / Math.max(sorted.length, 1)) * Math.PI * 2;
    const radius = rings[node.access_class];
    return {
      ...node,
      issue_severity: nodeIssueSeverity(node),
      issue_count: nodeIssueSeverity(node) === "ok" ? 0 : 1,
      importance_score: nodeImportanceScore(node, degreeByNode.get(node.object_id) ?? 0),
      x: Math.round(centerX + Math.cos(angle) * radius),
      y: Math.round(centerY + Math.sin(angle) * radius)
    };
  });
}

function positionBucketNodes(nodes: VisibleNode[]): VisibleNode[] {
  const sorted = [...nodes].sort((left, right) => {
    const countDelta = bucketCountFromName(right.name) - bucketCountFromName(left.name);
    return countDelta || left.name.localeCompare(right.name);
  });
  if (sorted.length === 1) {
    return [{ ...sorted[0]!, x: 450, y: 300 }];
  }

  const columns = Math.ceil(Math.sqrt(sorted.length));
  const rows = Math.ceil(sorted.length / columns);
  const cellWidth = Math.min(230, 760 / columns);
  const cellHeight = Math.min(180, 460 / rows);
  const startX = 450 - ((columns - 1) * cellWidth) / 2;
  const startY = 300 - ((rows - 1) * cellHeight) / 2;

  return sorted.map((node, index) => ({
    ...node,
    x: Math.round(startX + (index % columns) * cellWidth),
    y: Math.round(startY + Math.floor(index / columns) * cellHeight)
  }));
}

function positionFocusedNodes(nodes: VisibleNode[], distanceByNode: Map<string, number>, rootIds: Set<string>): VisibleNode[] {
  const centerX = 450;
  const centerY = 300;
  const byDistance = new Map<number, VisibleNode[]>();
  for (const node of nodes) {
    const distance = distanceByNode.get(node.object_id) ?? 0;
    const group = byDistance.get(distance);
    if (group) {
      group.push(node);
    } else {
      byDistance.set(distance, [node]);
    }
  }

  const positioned: VisibleNode[] = [];
  const radii = new Map<number, number>([
    [0, rootIds.size > 1 ? 62 : 0],
    [1, 178],
    [2, 282]
  ]);
  for (const [distance, group] of [...byDistance.entries()].sort(([left], [right]) => left - right)) {
    const sorted = [...group].sort((left, right) => {
      const issueDelta = severityRank(right.issue_severity) - severityRank(left.issue_severity);
      const importanceDelta = right.importance_score - left.importance_score;
      return issueDelta || importanceDelta || left.name.localeCompare(right.name);
    });
    const radius = radii.get(distance) ?? Math.min(320, 110 + distance * 90);
    positioned.push(...sorted.map((node, index) => {
      const angle = -Math.PI / 2 + (index / Math.max(sorted.length, 1)) * Math.PI * 2;
      return {
        ...node,
        x: Math.round(centerX + Math.cos(angle) * radius),
        y: Math.round(centerY + Math.sin(angle) * radius)
      };
    }));
  }
  return positioned;
}

function bucketKey(node: AtlasNode): string {
  return [
    node.type,
    node.subtype,
    node.access_class,
    node.encryption_class,
    bucketNamespace(node)
  ].join("|");
}

function bucketNamespace(node: AtlasNode): string {
  const namespace = node.description?.split(" / ")[0]?.trim();
  return namespace || node.subtype || node.type;
}

function bucketLabel(namespace: string, node: AtlasNode): string {
  const compact = namespace
    .replace(/^import\/logseq-/, "")
    .replace(/^import\//, "")
    .replace(/^fixture\//, "")
    .replace(/^test\//, "");
  if (compact.length > 26) {
    const parts = compact.split("/");
    return parts.slice(-2).join("/");
  }
  return compact || node.type;
}

function bucketCountFromName(name: string): number {
  const match = /\((\d+)\)$/.exec(name);
  return match ? Number(match[1]) : 1;
}

function maxSeverity(severities: NodeIssueSeverity[]): NodeIssueSeverity {
  if (severities.includes("error")) {
    return "error";
  }
  if (severities.includes("warning")) {
    return "warning";
  }
  return "ok";
}

function severityRank(severity: NodeIssueSeverity): number {
  if (severity === "error") {
    return 2;
  }
  if (severity === "warning") {
    return 1;
  }
  return 0;
}

function withAudit(graph: WorkbenchGraph, action: AuditAction, subjectId: string, summary: string, operation: Record<string, unknown>): WorkbenchGraph {
  return {
    ...graph,
    audit: [createAuditEntry(action, subjectId, summary, operation), ...graph.audit].slice(0, 80)
  };
}

function createAuditEntry(action: AuditAction, subjectId: string, summary: string, operation: Record<string, unknown>): AuditEntry {
  const at = new Date().toISOString();
  return {
    event_id: `la_event_workbench_${stableHash(`${at}:${action}:${subjectId}:${summary}`).slice(0, 16)}`,
    at,
    action,
    subject_id: subjectId,
    summary,
    operation
  };
}

function nextId(prefix: string, existingIds: string[]): string {
  let index = existingIds.length + 1;
  let candidate = `${prefix}${String(index).padStart(4, "0")}`;
  const existing = new Set(existingIds);
  while (existing.has(candidate)) {
    index += 1;
    candidate = `${prefix}${String(index).padStart(4, "0")}`;
  }
  return candidate;
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
