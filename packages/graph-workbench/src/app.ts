import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";
import noverlap from "graphology-layout-noverlap";
import Sigma from "sigma";
import {
  accessModes,
  createEdge,
  createNode,
  createSeedGraph,
  deleteEdge,
  getVisibleGraph,
  latestCrudDraft,
  nodeImportanceScore,
  nodeIssueSeverity,
  nodeTypes,
  normalizeImportedGraph,
  predicateRegistry,
  tombstoneNode,
  updateEdge,
  updateNode,
  validateGraph,
  type AccessClass,
  type AccessMode,
  type AtlasEdge,
  type AtlasNode,
  type Confidence,
  type EncryptionClass,
  type NodeIssueSeverity,
  type NodeType,
  type Predicate,
  type ValidationIssue,
  type VisibleNode,
  type WorkbenchGraph
} from "./workbench-state.js";

type FocusDepth = "0" | "1" | "2" | "3";
type QueueTab = "issues" | "supernodes" | "recent" | "predicates";
type TableTab = "nodes" | "edges";
type EdgeSeverity = "ok" | "warning" | "error";

type NodeStats = {
  degree: number;
  inDegree: number;
  outDegree: number;
  predicateCounts: Map<string, number>;
};

type QueueItem = {
  id: string;
  kind: "node" | "edge" | "predicate";
  subjectId: string;
  title: string;
  meta: string;
  severity: EdgeSeverity;
  count?: number;
  predicate?: string;
};

type BaseModel = {
  nodes: VisibleNode[];
  edges: AtlasEdge[];
  nodesById: Map<string, VisibleNode>;
  edgesById: Map<string, AtlasEdge>;
  statsByNode: Map<string, NodeStats>;
  issueSeverityBySubject: Map<string, EdgeSeverity>;
  issueCountBySubject: Map<string, number>;
  validationIssues: ValidationIssue[];
  predicateCounts: Map<string, number>;
  unfilteredPredicateCounts: Map<string, number>;
  queueItems: Map<QueueTab, QueueItem[]>;
};

type Projection = {
  nodes: VisibleNode[];
  edges: AtlasEdge[];
  distanceByNode: Map<string, number>;
  rootNodeIds: Set<string>;
  withheldNodes: number;
  withheldEdges: number;
  queryHitCount: number;
};

type NodeRenderAttrs = {
  x: number;
  y: number;
  size: number;
  label: string;
  color: string;
  borderColor: string;
  highlighted?: boolean;
  forceLabel?: boolean;
  zIndex?: number;
  atlasNode: VisibleNode;
  issueSeverity: EdgeSeverity;
};

type EdgeRenderAttrs = {
  label: string;
  color: string;
  size: number;
  type?: string;
  hidden?: boolean;
  forceLabel?: boolean;
  zIndex?: number;
  atlasEdge: AtlasEdge;
  issueSeverity: EdgeSeverity;
};

type GraphApiResponse = {
  graph: WorkbenchGraph;
  capabilities?: {
    source?: string;
    mutable?: boolean;
    edge_object_count?: number;
    readable_edge_count?: number;
    opaque_edge_object_count?: number;
  };
};

const projectionNodeLimit = 180;
const projectionEdgeLimit = 320;
const maxEdgesPerExpandedNode = 70;
const supernodeThreshold = 18;

let graph = createSeedGraph();
let mode: AccessMode = "local";
let focusDepth: FocusDepth = "1";
let queueTab: QueueTab = "issues";
let tableTab: TableTab = "nodes";
let query = "";
let issueCursor = -1;
let serverBacked = false;
let serverMutable = true;
let sourceCapabilities: GraphApiResponse["capabilities"] | undefined;
let renderer: Sigma<NodeRenderAttrs, EdgeRenderAttrs> | undefined;
let currentModel: BaseModel | undefined;
let currentProjection: Projection | undefined;
let selectedPredicate: string | undefined;
let draggedNodeId: string | undefined;

const enabledTypes = new Set<NodeType>(nodeTypes);
const disabledPredicates = new Set<string>();

const graphStage = byId<HTMLDivElement>("graphStage");
const typeFilters = byId<HTMLDivElement>("typeFilters");
const predicateFilters = byId<HTMLDivElement>("predicateFilters");
const queueList = byId<HTMLDivElement>("queueList");
const validationList = byId<HTMLDivElement>("validationList");
const selectedDetail = byId<HTMLDivElement>("selectedDetail");
const auditList = byId<HTMLDivElement>("auditList");
const operationDraft = byId<HTMLPreElement>("operationDraft");
const timelineStrip = byId<HTMLDivElement>("timelineStrip");
const focusSummary = byId<HTMLSpanElement>("focusSummary");
const graphTable = byId<HTMLDivElement>("graphTable");
const tableSummary = byId<HTMLSpanElement>("tableSummary");
const nodeForm = byId<HTMLFormElement>("nodeForm");
const edgeForm = byId<HTMLFormElement>("edgeForm");
const importBuffer = byId<HTMLTextAreaElement>("importBuffer");
const serverStatus = byId<HTMLSpanElement>("serverStatus");

void main();

async function main(): Promise<void> {
  bootstrap();
  await refreshFromServer();
  connectEventStream();
  render();
}

function bootstrap(): void {
  renderTypeFilters();

  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-mode]")) {
    button.addEventListener("click", () => {
      const nextMode = button.dataset.mode;
      if (accessModes.includes(nextMode as AccessMode)) {
        mode = nextMode as AccessMode;
        graph.selectedNodeId = undefined;
        graph.selectedEdgeId = undefined;
        issueCursor = -1;
        render();
      }
    });
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-focus-depth]")) {
    button.addEventListener("click", () => {
      const nextDepth = button.dataset.focusDepth;
      if (nextDepth === "0" || nextDepth === "1" || nextDepth === "2" || nextDepth === "3") {
        focusDepth = nextDepth;
        render();
      }
    });
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-queue-tab]")) {
    button.addEventListener("click", () => {
      const nextTab = button.dataset.queueTab;
      if (nextTab === "issues" || nextTab === "supernodes" || nextTab === "recent" || nextTab === "predicates") {
        queueTab = nextTab;
        render();
      }
    });
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-table-tab]")) {
    button.addEventListener("click", () => {
      const nextTab = button.dataset.tableTab;
      if (nextTab === "nodes" || nextTab === "edges") {
        tableTab = nextTab;
        render();
      }
    });
  }

  byId<HTMLInputElement>("searchGraph").addEventListener("input", (event) => {
    query = (event.currentTarget as HTMLInputElement).value;
    issueCursor = -1;
    render();
  });

  byId<HTMLButtonElement>("clearFocus").addEventListener("click", () => {
    graph.selectedNodeId = undefined;
    graph.selectedEdgeId = undefined;
    selectedPredicate = undefined;
    query = "";
    byId<HTMLInputElement>("searchGraph").value = "";
    issueCursor = -1;
    render();
  });

  byId<HTMLButtonElement>("fitGraph").addEventListener("click", () => {
    void renderer?.getCamera().animatedReset({ duration: 260 });
  });

  byId<HTMLButtonElement>("previousIssue").addEventListener("click", () => cycleIssue(-1));
  byId<HTMLButtonElement>("nextIssue").addEventListener("click", () => cycleIssue(1));

  predicateFilters.addEventListener("change", (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) {
      return;
    }
    if (input.checked) {
      disabledPredicates.delete(input.value);
    } else {
      disabledPredicates.add(input.value);
      if (selectedPredicate === input.value) {
        selectedPredicate = undefined;
      }
    }
    render();
  });

  queueList.addEventListener("click", (event) => {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>("[data-queue-id]");
    if (!button || !currentModel) {
      return;
    }
    const item = [...currentModel.queueItems.values()].flat().find((candidate) => candidate.id === button.dataset.queueId);
    if (item) {
      selectQueueItem(item);
    }
  });

  graphTable.addEventListener("click", (event) => {
    const row = (event.target as Element | null)?.closest<HTMLButtonElement>("[data-node-id], [data-edge-id]");
    if (!row) {
      return;
    }
    if (row.dataset.nodeId) {
      graph.selectedNodeId = row.dataset.nodeId;
      graph.selectedEdgeId = undefined;
    }
    if (row.dataset.edgeId) {
      graph.selectedEdgeId = row.dataset.edgeId;
      graph.selectedNodeId = undefined;
    }
    render();
  });

  byId<HTMLButtonElement>("resetGraph").addEventListener("click", () => {
    void mutateGraph("/api/graph/reset", { method: "POST" }, () => createSeedGraph());
  });

  byId<HTMLButtonElement>("exportGraph").addEventListener("click", () => {
    const text = JSON.stringify(graph, null, 2);
    importBuffer.value = text;
    void navigator.clipboard?.writeText(text).catch(() => undefined);
  });

  byId<HTMLButtonElement>("importGraph").addEventListener("click", () => {
    try {
      const imported = JSON.parse(importBuffer.value);
      void mutateGraph("/api/graph/import", {
        method: "POST",
        body: { graph: imported }
      }, () => normalizeImportedGraph(imported));
    } catch (error) {
      showValidationNotice(error instanceof Error ? error.message : "Import failed");
    }
  });

  nodeForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(nodeForm);
    const draft = {
      name: formString(data, "name"),
      type: formString(data, "type") as NodeType,
      subtype: formString(data, "subtype"),
      description: "",
      access_class: formString(data, "access_class") as AccessClass,
      encryption_class: formString(data, "encryption_class") as EncryptionClass,
      confidence: formString(data, "confidence") as Confidence
    };
    void mutateGraph("/api/nodes", {
      method: "POST",
      body: { node: draft }
    }, () => createNode(graph, draft));
    nodeForm.reset();
    setSelectValue(nodeForm, "type", "person");
    setInputValue(nodeForm, "subtype", "other");
    setSelectValue(nodeForm, "access_class", "remote-safe");
    setSelectValue(nodeForm, "encryption_class", "plaintext");
    setSelectValue(nodeForm, "confidence", "medium");
  });

  byId<HTMLButtonElement>("updateNode").addEventListener("click", () => {
    const selectedRealNode = graph.nodes.find((node) => node.object_id === graph.selectedNodeId && !node.tombstone);
    if (!selectedRealNode) {
      return;
    }
    const data = new FormData(nodeForm);
    const patch = {
      name: formString(data, "name"),
      type: formString(data, "type") as NodeType,
      subtype: formString(data, "subtype"),
      access_class: formString(data, "access_class") as AccessClass,
      encryption_class: formString(data, "encryption_class") as EncryptionClass,
      confidence: formString(data, "confidence") as Confidence
    };
    const objectId = selectedRealNode.object_id;
    void mutateGraph(`/api/nodes/${encodeURIComponent(objectId)}`, {
      method: "PATCH",
      body: { patch }
    }, () => updateNode(graph, objectId, patch));
  });

  byId<HTMLButtonElement>("deleteNode").addEventListener("click", () => {
    const selectedRealNode = graph.nodes.find((node) => node.object_id === graph.selectedNodeId && !node.tombstone);
    if (selectedRealNode) {
      const objectId = selectedRealNode.object_id;
      void mutateGraph(`/api/nodes/${encodeURIComponent(objectId)}`, {
        method: "DELETE"
      }, () => tombstoneNode(graph, objectId));
    }
  });

  edgeForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(edgeForm);
    const source = graph.nodes.find((node) => node.object_id === formString(data, "source"));
    const target = graph.nodes.find((node) => node.object_id === formString(data, "target"));
    if (!source || !target) {
      return;
    }
    const predicate = formString(data, "predicate") as Predicate;
    const draft: Omit<AtlasEdge, "edge_id"> = {
      source_object_id: source.object_id,
      source_type: source.type,
      target_object_id: target.object_id,
      target_type: target.type,
      predicate,
      valid_from: formString(data, "valid_from") || "unknown",
      status: "active",
      confidence: "medium",
      source: "workbench",
      access_class: source.access_class === "quarantine" || target.access_class === "quarantine" ? "quarantine" : "shareable",
      encryption_class: source.encryption_class === "client-encrypted" || target.encryption_class === "client-encrypted" ? "client-encrypted" : "remote-readable",
      attrs: {}
    };
    void mutateGraph("/api/edges", {
      method: "POST",
      body: { edge: draft }
    }, () => createEdge(graph, draft));
  });

  byId<HTMLButtonElement>("endEdge").addEventListener("click", () => {
    if (graph.selectedEdgeId) {
      const edgeId = graph.selectedEdgeId;
      const patch = {
        status: "ended",
        valid_to: new Date().toISOString().slice(0, 10)
      } as const;
      void mutateGraph(`/api/edges/${encodeURIComponent(edgeId)}`, {
        method: "PATCH",
        body: { patch }
      }, () => updateEdge(graph, edgeId, patch));
    }
  });

  byId<HTMLButtonElement>("deleteEdge").addEventListener("click", () => {
    if (graph.selectedEdgeId) {
      const edgeId = graph.selectedEdgeId;
      void mutateGraph(`/api/edges/${encodeURIComponent(edgeId)}`, {
        method: "DELETE"
      }, () => deleteEdge(graph, edgeId));
    }
  });
}

async function refreshFromServer(): Promise<void> {
  try {
    const response = await fetch("/api/graph", { headers: { accept: "application/json" } });
    if (!response.ok) {
      throw new Error(`Graph API returned ${response.status}`);
    }
    const payload = await response.json() as GraphApiResponse;
    graph = payload.graph;
    serverMutable = payload.capabilities?.mutable ?? true;
    serverBacked = true;
    sourceCapabilities = payload.capabilities;
    serverStatus.textContent = payload.capabilities?.source === "local-graph-readonly" ? "local graph read-only" : "server-backed synthetic";
  } catch {
    serverBacked = false;
    serverMutable = true;
    sourceCapabilities = undefined;
    serverStatus.textContent = "browser-only synthetic";
  }
}

async function mutateGraph(path: string, request: { method: string; body?: unknown }, fallback: () => WorkbenchGraph): Promise<void> {
  if (serverBacked && !serverMutable) {
    showValidationNotice("Local graph mode is read-only in this workbench pass.");
    return;
  }
  try {
    const response = await fetch(path, {
      method: request.method,
      headers: request.body ? { "content-type": "application/json", accept: "application/json" } : { accept: "application/json" },
      body: request.body ? JSON.stringify(request.body) : undefined
    });
    if (!response.ok) {
      if (response.status === 409) {
        showValidationNotice("Local graph mode is read-only in this workbench pass.");
        return;
      }
      throw new Error(`${path} returned ${response.status}`);
    }
    const payload = await response.json() as GraphApiResponse;
    graph = payload.graph;
    serverMutable = payload.capabilities?.mutable ?? true;
    serverBacked = true;
    sourceCapabilities = payload.capabilities;
    serverStatus.textContent = payload.capabilities?.source === "local-graph-readonly" ? "local graph read-only" : "server-backed synthetic";
  } catch {
    graph = fallback();
    serverBacked = false;
    serverMutable = true;
    sourceCapabilities = undefined;
    serverStatus.textContent = "browser-only synthetic";
  }
  render();
}

function connectEventStream(): void {
  if (!("EventSource" in window)) {
    return;
  }
  const source = new EventSource("/api/events/stream");
  source.addEventListener("graph", () => {
    if (serverBacked) {
      void refreshFromServer().then(render);
    }
  });
  source.addEventListener("error", () => {
    if (serverBacked) {
      serverStatus.textContent = "server event stream offline";
    }
  });
}

function render(): void {
  const model = buildBaseModel();
  const projection = buildProjection(model);
  currentModel = model;
  currentProjection = projection;

  renderTopState(model, projection);
  renderQueues(model);
  renderPredicateFilters(model);
  renderSigmaGraph(model, projection);
  renderTable(model, projection);
  renderSelected(model, projection);
  renderValidation(model.validationIssues);
  renderAudit();
  renderTimeline(projection, model);
  renderSelectOptions(model);
  setMutationControls();
  operationDraft.textContent = JSON.stringify(latestCrudDraft(graph) ?? { tool: "none", input: {} }, null, 2);
}

function buildBaseModel(): BaseModel {
  const unfilteredVisible = getVisibleGraph(graph, mode, enabledTypes, "");
  const activeNodeIds = new Set(unfilteredVisible.nodes.map((node) => node.object_id));
  const unfilteredPredicateCounts = new Map<string, number>();
  const filteredEdges: AtlasEdge[] = [];
  for (const edge of unfilteredVisible.edges) {
    if (!activeNodeIds.has(edge.source_object_id) || !activeNodeIds.has(edge.target_object_id)) {
      continue;
    }
    unfilteredPredicateCounts.set(edge.predicate, (unfilteredPredicateCounts.get(edge.predicate) ?? 0) + 1);
    if (!disabledPredicates.has(edge.predicate) && (!selectedPredicate || edge.predicate === selectedPredicate)) {
      filteredEdges.push(edge);
    }
  }

  const statsByNode = new Map<string, NodeStats>();
  for (const node of unfilteredVisible.nodes) {
    statsByNode.set(node.object_id, { degree: 0, inDegree: 0, outDegree: 0, predicateCounts: new Map() });
  }
  const predicateCounts = new Map<string, number>();
  for (const edge of filteredEdges) {
    predicateCounts.set(edge.predicate, (predicateCounts.get(edge.predicate) ?? 0) + 1);
    const sourceStats = statsByNode.get(edge.source_object_id);
    const targetStats = statsByNode.get(edge.target_object_id);
    if (sourceStats) {
      sourceStats.degree += 1;
      sourceStats.outDegree += 1;
      sourceStats.predicateCounts.set(edge.predicate, (sourceStats.predicateCounts.get(edge.predicate) ?? 0) + 1);
    }
    if (targetStats) {
      targetStats.degree += 1;
      targetStats.inDegree += 1;
      targetStats.predicateCounts.set(edge.predicate, (targetStats.predicateCounts.get(edge.predicate) ?? 0) + 1);
    }
  }

  const validationIssues = validateGraph({
    ...graph,
    nodes: graph.nodes.filter((node) => activeNodeIds.has(node.object_id) || node.tombstone),
    edges: graph.edges.filter((edge) => activeNodeIds.has(edge.source_object_id) || activeNodeIds.has(edge.target_object_id) || edge.tombstone)
  });
  const issueSeverityBySubject = new Map<string, EdgeSeverity>();
  const issueCountBySubject = new Map<string, number>();
  for (const issue of validationIssues) {
    issueCountBySubject.set(issue.subject_id, (issueCountBySubject.get(issue.subject_id) ?? 0) + 1);
    issueSeverityBySubject.set(issue.subject_id, maxSeverity(issueSeverityBySubject.get(issue.subject_id) ?? "ok", issue.severity));
  }

  const nodes = unfilteredVisible.nodes.map((node) => {
    const stats = statsByNode.get(node.object_id);
    const directSeverity = nodeIssueSeverity(node);
    const issueSeverity = maxSeverity(directSeverity, issueSeverityBySubject.get(node.object_id) ?? "ok");
    const directIssueCount = directSeverity === "ok" ? 0 : 1;
    return {
      ...node,
      issue_count: directIssueCount + (issueCountBySubject.get(node.object_id) ?? 0),
      issue_severity: issueSeverity as NodeIssueSeverity,
      importance_score: nodeImportanceScore(node, stats?.degree ?? 0)
    };
  });

  const nodesById = new Map(nodes.map((node) => [node.object_id, node]));
  const edgesById = new Map(filteredEdges.map((edge) => [edge.edge_id, edge]));
  const model: BaseModel = {
    nodes,
    edges: filteredEdges,
    nodesById,
    edgesById,
    statsByNode,
    issueSeverityBySubject,
    issueCountBySubject,
    validationIssues,
    predicateCounts,
    unfilteredPredicateCounts,
    queueItems: new Map()
  };
  model.queueItems = buildQueueItems(model);
  return model;
}

function buildQueueItems(model: BaseModel): Map<QueueTab, QueueItem[]> {
  const issues: QueueItem[] = [];
  const seenIssueSubjects = new Set<string>();
  for (const issue of model.validationIssues) {
    if (seenIssueSubjects.has(issue.subject_id)) {
      continue;
    }
    seenIssueSubjects.add(issue.subject_id);
    const edge = model.edgesById.get(issue.subject_id);
    const node = model.nodesById.get(issue.subject_id);
    if (edge) {
      issues.push(queueItemForEdge(edge, model, issue.severity));
    } else if (node) {
      issues.push(queueItemForNode(node, model, issue.severity));
    }
  }
  for (const node of model.nodes) {
    if (!seenIssueSubjects.has(node.object_id) && node.issue_severity !== "ok") {
      issues.push(queueItemForNode(node, model, node.issue_severity));
    }
  }

  const supernodes = model.nodes
    .filter((node) => (model.statsByNode.get(node.object_id)?.degree ?? 0) >= supernodeThreshold)
    .sort((left, right) => (model.statsByNode.get(right.object_id)?.degree ?? 0) - (model.statsByNode.get(left.object_id)?.degree ?? 0))
    .slice(0, 80)
    .map((node) => queueItemForNode(node, model, model.issueSeverityBySubject.get(node.object_id) ?? node.issue_severity));

  const recent = [...model.nodes]
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
    .slice(0, 80)
    .map((node) => queueItemForNode(node, model, model.issueSeverityBySubject.get(node.object_id) ?? node.issue_severity));

  const predicates = [...model.unfilteredPredicateCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 80)
    .map(([predicate, count]) => ({
      id: `predicate:${predicate}`,
      kind: "predicate" as const,
      subjectId: predicate,
      title: predicate,
      meta: `${count} edge${count === 1 ? "" : "s"}`,
      severity: predicateRegistry[predicate as keyof typeof predicateRegistry] ? "ok" as const : "warning" as const,
      count,
      predicate
    }));

  return new Map<QueueTab, QueueItem[]>([
    ["issues", issues.sort(queueSort)],
    ["supernodes", supernodes],
    ["recent", recent],
    ["predicates", predicates]
  ]);
}

function buildProjection(model: BaseModel): Projection {
  const normalizedQuery = normalizeQuery(query);
  const rootNodeIds = new Set<string>();
  const forcedEdgeIds = new Set<string>();
  let queryHitCount = 0;

  const selectedEdge = graph.selectedEdgeId ? model.edgesById.get(graph.selectedEdgeId) : undefined;
  const selectedNode = graph.selectedNodeId ? model.nodesById.get(graph.selectedNodeId) : undefined;

  if (selectedEdge) {
    rootNodeIds.add(selectedEdge.source_object_id);
    rootNodeIds.add(selectedEdge.target_object_id);
    forcedEdgeIds.add(selectedEdge.edge_id);
  }
  if (selectedNode) {
    rootNodeIds.add(selectedNode.object_id);
  }

  if (normalizedQuery) {
    const nodeMatches = model.nodes.filter((node) => matchesNode(node, normalizedQuery));
    const edgeMatches = model.edges.filter((edge) => matchesEdge(edge, normalizedQuery, model));
    queryHitCount = nodeMatches.length + edgeMatches.length;
    for (const node of nodeMatches.slice(0, 45)) {
      rootNodeIds.add(node.object_id);
    }
    for (const edge of edgeMatches.slice(0, 60)) {
      forcedEdgeIds.add(edge.edge_id);
      rootNodeIds.add(edge.source_object_id);
      rootNodeIds.add(edge.target_object_id);
    }
  }

  if (rootNodeIds.size === 0) {
    const defaultItem = model.queueItems.get("issues")?.[0]
      ?? model.queueItems.get("supernodes")?.[0]
      ?? model.queueItems.get("recent")?.[0];
    if (defaultItem?.kind === "edge") {
      const edge = model.edgesById.get(defaultItem.subjectId);
      if (edge) {
        rootNodeIds.add(edge.source_object_id);
        rootNodeIds.add(edge.target_object_id);
        forcedEdgeIds.add(edge.edge_id);
      }
    } else if (defaultItem?.kind === "node") {
      rootNodeIds.add(defaultItem.subjectId);
    } else if (model.nodes[0]) {
      rootNodeIds.add(model.nodes[0].object_id);
    }
  }

  const incidentEdges = buildIncidentEdgeMap(model.edges);
  const selectedEdgeList = [...forcedEdgeIds]
    .map((edgeId) => model.edgesById.get(edgeId))
    .filter((edge): edge is AtlasEdge => Boolean(edge));
  const distanceByNode = new Map<string, number>();
  const visibleNodeIds = new Set<string>();
  const visibleEdgeIds = new Set<string>();
  const queue = [...rootNodeIds].filter((nodeId) => model.nodesById.has(nodeId));

  for (const nodeId of queue) {
    visibleNodeIds.add(nodeId);
    distanceByNode.set(nodeId, 0);
  }
  for (const edge of selectedEdgeList) {
    visibleEdgeIds.add(edge.edge_id);
    for (const nodeId of [edge.source_object_id, edge.target_object_id]) {
      if (model.nodesById.has(nodeId)) {
        visibleNodeIds.add(nodeId);
        distanceByNode.set(nodeId, Math.min(distanceByNode.get(nodeId) ?? 0, 0));
      }
    }
  }

  const maxDepth = Number(focusDepth);
  let cursor = 0;
  while (cursor < queue.length) {
    const nodeId = queue[cursor]!;
    cursor += 1;
    const distance = distanceByNode.get(nodeId) ?? 0;
    if (distance >= maxDepth) {
      continue;
    }
    const edges = [...(incidentEdges.get(nodeId) ?? [])].sort((left, right) => edgeRank(right, model) - edgeRank(left, model));
    for (const edge of edges.slice(0, maxEdgesPerExpandedNode)) {
      if (visibleEdgeIds.size >= projectionEdgeLimit) {
        break;
      }
      const neighborId = edge.source_object_id === nodeId ? edge.target_object_id : edge.source_object_id;
      if (!model.nodesById.has(neighborId)) {
        continue;
      }
      if (!visibleNodeIds.has(neighborId) && visibleNodeIds.size >= projectionNodeLimit) {
        continue;
      }
      visibleEdgeIds.add(edge.edge_id);
      if (!visibleNodeIds.has(neighborId)) {
        visibleNodeIds.add(neighborId);
        distanceByNode.set(neighborId, distance + 1);
        queue.push(neighborId);
      }
    }
  }

  for (const edgeId of forcedEdgeIds) {
    const edge = model.edgesById.get(edgeId);
    if (!edge) {
      continue;
    }
    if (visibleNodeIds.has(edge.source_object_id) && visibleNodeIds.has(edge.target_object_id)) {
      visibleEdgeIds.add(edge.edge_id);
    }
  }

  const nodes = [...visibleNodeIds]
    .map((nodeId) => model.nodesById.get(nodeId))
    .filter((node): node is VisibleNode => Boolean(node))
    .sort((left, right) => {
      const distanceDelta = (distanceByNode.get(left.object_id) ?? 9) - (distanceByNode.get(right.object_id) ?? 9);
      return distanceDelta || nodeRank(right, model) - nodeRank(left, model) || left.name.localeCompare(right.name);
    });
  const nodeIdSet = new Set(nodes.map((node) => node.object_id));
  const edges = [...visibleEdgeIds]
    .map((edgeId) => model.edgesById.get(edgeId))
    .filter((edge): edge is AtlasEdge => {
      if (!edge) {
        return false;
      }
      return nodeIdSet.has(edge.source_object_id) && nodeIdSet.has(edge.target_object_id);
    })
    .sort((left, right) => edgeRank(right, model) - edgeRank(left, model) || left.predicate.localeCompare(right.predicate));

  return {
    nodes,
    edges,
    distanceByNode,
    rootNodeIds,
    withheldNodes: Math.max(0, model.nodes.length - nodes.length),
    withheldEdges: Math.max(0, model.edges.length - edges.length),
    queryHitCount
  };
}

function renderTopState(model: BaseModel, projection: Projection): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-mode]")) {
    button.setAttribute("aria-pressed", String(button.dataset.mode === mode));
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-focus-depth]")) {
    button.setAttribute("aria-pressed", String(button.dataset.focusDepth === focusDepth));
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-queue-tab]")) {
    button.setAttribute("aria-pressed", String(button.dataset.queueTab === queueTab));
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-table-tab]")) {
    button.setAttribute("aria-pressed", String(button.dataset.tableTab === tableTab));
  }

  const selectedNode = graph.selectedNodeId ? model.nodesById.get(graph.selectedNodeId) : undefined;
  const selectedEdge = graph.selectedEdgeId ? model.edgesById.get(graph.selectedEdgeId) : undefined;
  const titleSuffix = selectedNode ? displayNodeName(selectedNode) : selectedEdge ? selectedEdge.predicate : selectedPredicate ? selectedPredicate : modeTitle(mode);
  byId("mapTitle").textContent = `Focused graph / ${titleSuffix}`;
  byId("nodeCount").textContent = String(projection.nodes.length);
  byId("edgeCount").textContent = String(projection.edges.length);
  byId("withheldCount").textContent = String(projection.withheldNodes + projection.withheldEdges);
  byId("issueCount").textContent = String(model.queueItems.get("issues")?.length ?? 0);

  const focusName = selectedNode
    ? displayNodeName(selectedNode)
    : selectedEdge
      ? edgeTitle(selectedEdge, model)
      : selectedPredicate
        ? `${selectedPredicate} edges`
        : projection.nodes[0]
          ? displayNodeName(projection.nodes[0])
          : "No focus";
  const searchText = query ? `, ${projection.queryHitCount} search hit${projection.queryHitCount === 1 ? "" : "s"}` : "";
  focusSummary.textContent = `${focusName}: ${projection.nodes.length} nodes, ${projection.edges.length} edges, ${focusDepthLabel(focusDepth)}${searchText}`;
}

function renderQueues(model: BaseModel): void {
  const items = model.queueItems.get(queueTab) ?? [];
  const previousButton = byId<HTMLButtonElement>("previousIssue");
  const nextButton = byId<HTMLButtonElement>("nextIssue");
  const issueCount = model.queueItems.get("issues")?.length ?? 0;
  previousButton.disabled = issueCount === 0;
  nextButton.disabled = issueCount === 0;

  if (items.length === 0) {
    queueList.innerHTML = `<div class="empty-list">No ${queueTab} records</div>`;
    return;
  }
  queueList.innerHTML = items.slice(0, 48).map((item) => {
    const selected = isQueueItemSelected(item) ? " selected" : "";
    return `
      <button class="queue-item ${item.severity}${selected}" type="button" data-queue-id="${escapeHtml(item.id)}">
        <span class="queue-title">${escapeHtml(item.title)}</span>
        <span class="queue-meta">${escapeHtml(item.meta)}</span>
      </button>
    `;
  }).join("");
}

function renderPredicateFilters(model: BaseModel): void {
  const predicates = [...model.unfilteredPredicateCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 36);
  if (predicates.length === 0) {
    predicateFilters.innerHTML = '<div class="empty-list">No predicates</div>';
    return;
  }
  predicateFilters.innerHTML = predicates.map(([predicate, count]) => `
    <label class="predicate-toggle ${selectedPredicate === predicate ? "selected" : ""}">
      <input type="checkbox" value="${escapeHtml(predicate)}" ${disabledPredicates.has(predicate) ? "" : "checked"}>
      <button type="button" data-predicate="${escapeHtml(predicate)}">${escapeHtml(predicate)}</button>
      <span>${count}</span>
    </label>
  `).join("");

  for (const button of predicateFilters.querySelectorAll<HTMLButtonElement>("[data-predicate]")) {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      const predicate = button.dataset.predicate;
      selectedPredicate = selectedPredicate === predicate ? undefined : predicate;
      if (selectedPredicate) {
        disabledPredicates.delete(selectedPredicate);
        queueTab = "predicates";
      }
      render();
    });
  }
}

function renderSigmaGraph(model: BaseModel, projection: Projection): void {
  renderer?.kill();
  renderer = undefined;
  graphStage.innerHTML = "";

  const sigmaGraph = new Graph<NodeRenderAttrs, EdgeRenderAttrs>({ type: "directed", multi: true, allowSelfLoops: true });
  const nodeCount = Math.max(projection.nodes.length, 1);
  for (const [index, node] of projection.nodes.entries()) {
    const distance = projection.distanceByNode.get(node.object_id) ?? 2;
    const angle = seededAngle(`${node.object_id}:${index}`);
    const radius = distance === 0 ? 0.4 + (index % 5) * 0.25 : 4.8 + distance * 5.8 + (hashNumber(node.object_id) % 100) / 100;
    const root = projection.rootNodeIds.has(node.object_id);
    const degree = model.statsByNode.get(node.object_id)?.degree ?? 0;
    sigmaGraph.addNode(node.object_id, {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      size: nodeSize(node, degree, root, nodeCount),
      label: displayNodeName(node),
      color: nodeColor(node.type),
      borderColor: issueColor(node.issue_severity),
      highlighted: root || graph.selectedNodeId === node.object_id,
      forceLabel: root || projection.nodes.length < 60,
      zIndex: root ? 3 : node.issue_severity !== "ok" ? 2 : 1,
      atlasNode: node,
      issueSeverity: node.issue_severity
    });
  }

  for (const edge of projection.edges) {
    if (!sigmaGraph.hasNode(edge.source_object_id) || !sigmaGraph.hasNode(edge.target_object_id)) {
      continue;
    }
    const severity = edgeIssueSeverity(edge, model);
    try {
      sigmaGraph.addDirectedEdgeWithKey(edge.edge_id, edge.source_object_id, edge.target_object_id, {
        label: edge.predicate,
        color: edgeColor(edge, severity),
        size: graph.selectedEdgeId === edge.edge_id ? 4 : severity === "error" ? 3 : 1.6,
        forceLabel: graph.selectedEdgeId === edge.edge_id || projection.edges.length < 70,
        zIndex: graph.selectedEdgeId === edge.edge_id ? 4 : severity !== "ok" ? 3 : 1,
        atlasEdge: edge,
        issueSeverity: severity
      });
    } catch {
      // Duplicate keys are validation issues. Keep the first edge renderable.
    }
  }

  if (sigmaGraph.order > 1) {
    forceAtlas2.assign(sigmaGraph, {
      iterations: sigmaGraph.order > 140 ? 75 : 130,
      settings: {
        barnesHutOptimize: sigmaGraph.order > 80,
        edgeWeightInfluence: 0.3,
        gravity: 1.5,
        linLogMode: true,
        scalingRatio: sigmaGraph.order > 100 ? 16 : 10,
        slowDown: 1.2
      }
    });
    noverlap.assign(sigmaGraph, {
      maxIterations: 90,
      settings: { expansion: 1.15, margin: 5, ratio: 1.25 }
    });
  }

  renderer = new Sigma(sigmaGraph, graphStage, {
    allowInvalidContainer: true,
    defaultEdgeColor: "#67716b",
    defaultNodeColor: "#2d6e5b",
    enableEdgeEvents: true,
    hideEdgesOnMove: false,
    labelDensity: 0.08,
    labelGridCellSize: 110,
    labelRenderedSizeThreshold: projection.nodes.length > 80 ? 10 : 7,
    renderEdgeLabels: projection.edges.length <= 160,
    zIndex: true,
    nodeReducer(nodeId, data) {
      if (graph.selectedNodeId === nodeId) {
        return {
          ...data,
          color: "#111816",
          highlighted: true,
          forceLabel: true,
          size: data.size * 1.28,
          zIndex: 8
        };
      }
      return data;
    },
    edgeReducer(edgeId, data) {
      if (graph.selectedEdgeId === edgeId) {
        return {
          ...data,
          color: "#ba4f35",
          forceLabel: true,
          size: Math.max(data.size, 4.5),
          zIndex: 8
        };
      }
      return data;
    }
  });

  renderer.on("clickNode", ({ node }) => {
    if (draggedNodeId) {
      return;
    }
    graph.selectedNodeId = String(node);
    graph.selectedEdgeId = undefined;
    issueCursor = issueIndexForNode(String(node));
    render();
  });
  renderer.on("clickEdge", ({ edge }) => {
    graph.selectedEdgeId = String(edge);
    graph.selectedNodeId = undefined;
    render();
  });
  renderer.on("enterNode", () => {
    graphStage.classList.add("is-hovering");
  });
  renderer.on("leaveNode", () => {
    graphStage.classList.remove("is-hovering");
  });
  renderer.on("enterEdge", () => {
    graphStage.classList.add("is-hovering");
  });
  renderer.on("leaveEdge", () => {
    graphStage.classList.remove("is-hovering");
  });
  renderer.on("downNode", ({ node, event }) => {
    draggedNodeId = String(node);
    event.preventSigmaDefault();
  });
  renderer.on("moveBody", ({ event }) => {
    if (!draggedNodeId || !renderer) {
      return;
    }
    const position = renderer.viewportToGraph(event);
    sigmaGraph.setNodeAttribute(draggedNodeId, "x", position.x);
    sigmaGraph.setNodeAttribute(draggedNodeId, "y", position.y);
    event.preventSigmaDefault();
  });
  renderer.on("upStage", () => {
    draggedNodeId = undefined;
  });
  renderer.on("upNode", () => {
    draggedNodeId = undefined;
  });
  void renderer.getCamera().animatedReset({ duration: 150 });
}

function renderTable(model: BaseModel, projection: Projection): void {
  if (tableTab === "edges") {
    tableSummary.textContent = `${projection.edges.length} edge${projection.edges.length === 1 ? "" : "s"}`;
    graphTable.innerHTML = projection.edges.length === 0
      ? '<div class="empty-list">No visible edges</div>'
      : projection.edges.slice(0, 180).map((edge) => {
        const severity = edgeIssueSeverity(edge, model);
        const selected = graph.selectedEdgeId === edge.edge_id ? " selected" : "";
        return `
          <button class="table-row edge-row ${severity}${selected}" type="button" data-edge-id="${escapeHtml(edge.edge_id)}">
            <span>${escapeHtml(edgeTitle(edge, model))}</span>
            <code>${escapeHtml(edge.status)} / ${escapeHtml(edge.access_class)}</code>
          </button>
        `;
      }).join("");
    return;
  }

  tableSummary.textContent = `${projection.nodes.length} node${projection.nodes.length === 1 ? "" : "s"}`;
  graphTable.innerHTML = projection.nodes.length === 0
    ? '<div class="empty-list">No visible nodes</div>'
    : projection.nodes.slice(0, 180).map((node) => {
      const selected = graph.selectedNodeId === node.object_id ? " selected" : "";
      const stats = model.statsByNode.get(node.object_id);
      return `
        <button class="table-row node-row ${node.issue_severity}${selected}" type="button" data-node-id="${escapeHtml(node.object_id)}">
          <span>${escapeHtml(displayNodeName(node))}</span>
          <code>${escapeHtml(node.type)} / degree ${stats?.degree ?? 0}</code>
        </button>
      `;
    }).join("");
}

function renderSelected(model: BaseModel, projection: Projection): void {
  const selectedNode = graph.selectedNodeId ? model.nodesById.get(graph.selectedNodeId) : undefined;
  const selectedEdge = graph.selectedEdgeId ? model.edgesById.get(graph.selectedEdgeId) : undefined;
  const focusedRootNode = !selectedNode && !selectedEdge && projection.nodes[0]
    ? projection.nodes[0]
    : undefined;
  const nodeForInspector = selectedNode ?? focusedRootNode;
  if (nodeForInspector) {
    const stats = model.statsByNode.get(nodeForInspector.object_id);
    selectedDetail.innerHTML = `
      <h3 class="selected-title">${escapeHtml(displayNodeName(nodeForInspector))}</h3>
      <div class="selected-meta">
        <span class="chip">${escapeHtml(nodeForInspector.type)}</span>
        <span class="chip">${escapeHtml(nodeForInspector.subtype)}</span>
        <span class="chip">${escapeHtml(nodeForInspector.access_class)}</span>
        <span class="chip">${escapeHtml(nodeForInspector.encryption_class)}</span>
        <span class="chip ${nodeForInspector.issue_severity}">${escapeHtml(nodeForInspector.issue_severity)}</span>
        <span class="chip">degree ${stats?.degree ?? 0}</span>
      </div>
      ${renderNeighborSummary(nodeForInspector, model, projection)}
    `;
    fillNodeForm(nodeForInspector);
    return;
  }

  if (selectedEdge) {
    const source = model.nodesById.get(selectedEdge.source_object_id);
    const target = model.nodesById.get(selectedEdge.target_object_id);
    const severity = edgeIssueSeverity(selectedEdge, model);
    selectedDetail.innerHTML = `
      <h3 class="selected-title">${escapeHtml(selectedEdge.predicate)}</h3>
      <div class="edge-path">
        <strong>${escapeHtml(source ? displayNodeName(source) : selectedEdge.source_object_id)}</strong>
        <span>${escapeHtml(selectedEdge.predicate)}</span>
        <strong>${escapeHtml(target ? displayNodeName(target) : selectedEdge.target_object_id)}</strong>
      </div>
      <div class="selected-meta">
        <span class="chip ${severity}">${severity}</span>
        <span class="chip">${escapeHtml(selectedEdge.status)}</span>
        <span class="chip">${escapeHtml(selectedEdge.access_class)}</span>
        <span class="chip">${escapeHtml(selectedEdge.encryption_class)}</span>
        <span class="chip">${escapeHtml(selectedEdge.confidence)}</span>
        <span class="chip">${escapeHtml(selectedEdge.valid_from)}</span>
      </div>
      <pre class="small-code">${escapeHtml(JSON.stringify(selectedEdge.attrs ?? {}, null, 2))}</pre>
    `;
    return;
  }

  selectedDetail.innerHTML = `
    <h3 class="selected-title">${escapeHtml(projection.nodes[0] ? displayNodeName(projection.nodes[0]) : "Nothing selected")}</h3>
    <div class="selected-meta">
      <span class="chip">${modeTitle(mode)}</span>
      <span class="chip">${projection.nodes.length} nodes</span>
      <span class="chip">${projection.edges.length} edges</span>
    </div>
  `;
}

function renderValidation(issues: ValidationIssue[]): void {
  const edgeDiagnostic = edgeDiagnosticMarkup();
  if (issues.length === 0 && !edgeDiagnostic) {
    validationList.innerHTML = '<div class="validation-item">No validation issues</div>';
    return;
  }
  validationList.innerHTML = [
    edgeDiagnostic,
    ...issues.slice(0, 14).map((issue) => `
      <button class="validation-item ${issue.severity}" type="button" data-subject-id="${escapeHtml(issue.subject_id)}">
        <strong>${issue.severity}</strong>
        <span>${escapeHtml(issue.message)}</span>
        <code>${escapeHtml(issue.subject_id)}</code>
      </button>
    `)
  ].join("");

  for (const button of validationList.querySelectorAll<HTMLButtonElement>("[data-subject-id]")) {
    button.addEventListener("click", () => {
      const subjectId = button.dataset.subjectId;
      if (!subjectId || !currentModel) {
        return;
      }
      if (currentModel.nodesById.has(subjectId)) {
        graph.selectedNodeId = subjectId;
        graph.selectedEdgeId = undefined;
      } else if (currentModel.edgesById.has(subjectId)) {
        graph.selectedEdgeId = subjectId;
        graph.selectedNodeId = undefined;
      }
      render();
    });
  }
}

function renderAudit(): void {
  auditList.innerHTML = graph.audit.slice(0, 12).map((entry) => `
    <div class="audit-item">
      <strong>${escapeHtml(entry.action)}</strong>
      <span>${escapeHtml(entry.summary)}</span>
      <code>${escapeHtml(entry.at)}</code>
    </div>
  `).join("");
}

function renderTimeline(projection: Projection, model: BaseModel): void {
  const activeEdges = projection.edges
    .filter((edge) => !edge.tombstone)
    .sort((left, right) => left.valid_from.localeCompare(right.valid_from));
  timelineStrip.innerHTML = activeEdges.slice(0, 64).map((edge) => {
    const source = model.nodesById.get(edge.source_object_id);
    const target = model.nodesById.get(edge.target_object_id);
    return `
      <button class="timeline-pill" type="button" data-edge-id="${escapeHtml(edge.edge_id)}">
        <strong>${escapeHtml(edge.valid_from)}</strong>
        ${escapeHtml(source ? displayNodeName(source) : "source")} ${escapeHtml(edge.predicate)} ${escapeHtml(target ? displayNodeName(target) : "target")}
      </button>
    `;
  }).join("");

  for (const button of timelineStrip.querySelectorAll<HTMLButtonElement>("[data-edge-id]")) {
    button.addEventListener("click", () => {
      graph.selectedEdgeId = button.dataset.edgeId;
      graph.selectedNodeId = undefined;
      tableTab = "edges";
      render();
    });
  }
}

function renderSelectOptions(model: BaseModel): void {
  setOptions(selectByName(nodeForm, "type"), nodeTypes.map((type) => ({ value: type, label: type })));
  const predicates = [...new Set([...Object.keys(predicateRegistry), ...model.unfilteredPredicateCounts.keys()])]
    .sort((left, right) => left.localeCompare(right));
  const dataList = byId<HTMLDataListElement>("predicateOptions");
  dataList.innerHTML = predicates.map((predicate) => `<option value="${escapeHtml(predicate)}"></option>`).join("");
  const nodeOptions = graph.nodes
    .filter((node) => !node.tombstone)
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((node) => ({ value: node.object_id, label: `${displayNodeName(node)} (${node.type})` }));
  setOptions(selectByName(edgeForm, "source"), nodeOptions);
  setOptions(selectByName(edgeForm, "target"), nodeOptions);
}

function renderTypeFilters(): void {
  typeFilters.innerHTML = nodeTypes.map((type) => `
    <label class="type-toggle">
      <input type="checkbox" value="${type}" checked>
      <span>${type}</span>
    </label>
  `).join("");

  for (const input of typeFilters.querySelectorAll<HTMLInputElement>("input")) {
    input.addEventListener("change", () => {
      if (input.checked) {
        enabledTypes.add(input.value as NodeType);
      } else {
        enabledTypes.delete(input.value as NodeType);
      }
      graph.selectedNodeId = undefined;
      graph.selectedEdgeId = undefined;
      render();
    });
  }
}

function selectQueueItem(item: QueueItem): void {
  if (item.kind === "node") {
    graph.selectedNodeId = item.subjectId;
    graph.selectedEdgeId = undefined;
    tableTab = "nodes";
    issueCursor = issueIndexForNode(item.subjectId);
  } else if (item.kind === "edge") {
    graph.selectedEdgeId = item.subjectId;
    graph.selectedNodeId = undefined;
    tableTab = "edges";
  } else if (item.predicate) {
    selectedPredicate = selectedPredicate === item.predicate ? undefined : item.predicate;
    disabledPredicates.delete(item.predicate);
    graph.selectedNodeId = undefined;
    graph.selectedEdgeId = undefined;
    tableTab = "edges";
  }
  render();
}

function cycleIssue(direction: -1 | 1): void {
  const issueItems = currentModel?.queueItems.get("issues") ?? [];
  if (issueItems.length === 0) {
    return;
  }
  const selectedIndex = issueItems.findIndex((item) => isQueueItemSelected(item));
  const baseIndex = selectedIndex >= 0 ? selectedIndex : issueCursor;
  issueCursor = (baseIndex + direction + issueItems.length) % issueItems.length;
  selectQueueItem(issueItems[issueCursor]!);
}

function buildIncidentEdgeMap(edges: AtlasEdge[]): Map<string, AtlasEdge[]> {
  const map = new Map<string, AtlasEdge[]>();
  for (const edge of edges) {
    addIncident(map, edge.source_object_id, edge);
    addIncident(map, edge.target_object_id, edge);
  }
  return map;
}

function addIncident(map: Map<string, AtlasEdge[]>, nodeId: string, edge: AtlasEdge): void {
  const edges = map.get(nodeId);
  if (edges) {
    edges.push(edge);
  } else {
    map.set(nodeId, [edge]);
  }
}

function queueItemForNode(node: VisibleNode, model: BaseModel, severity: EdgeSeverity): QueueItem {
  const stats = model.statsByNode.get(node.object_id);
  return {
    id: `node:${node.object_id}`,
    kind: "node",
    subjectId: node.object_id,
    title: displayNodeName(node),
    meta: `${node.type} / degree ${stats?.degree ?? 0} / ${node.access_class}`,
    severity,
    count: stats?.degree ?? 0
  };
}

function queueItemForEdge(edge: AtlasEdge, model: BaseModel, severity: EdgeSeverity): QueueItem {
  return {
    id: `edge:${edge.edge_id}`,
    kind: "edge",
    subjectId: edge.edge_id,
    title: edge.predicate,
    meta: edgeTitle(edge, model),
    severity,
    predicate: edge.predicate
  };
}

function renderNeighborSummary(node: VisibleNode, model: BaseModel, projection: Projection): string {
  const incident = projection.edges.filter((edge) => edge.source_object_id === node.object_id || edge.target_object_id === node.object_id);
  if (incident.length === 0) {
    return '<div class="neighbor-summary">No visible edges for this focus.</div>';
  }
  const counts = new Map<string, number>();
  for (const edge of incident) {
    counts.set(edge.predicate, (counts.get(edge.predicate) ?? 0) + 1);
  }
  const predicates = [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 8)
    .map(([predicate, count]) => `<button type="button" data-inline-predicate="${escapeHtml(predicate)}">${escapeHtml(predicate)} <span>${count}</span></button>`)
    .join("");

  setTimeout(() => {
    for (const button of selectedDetail.querySelectorAll<HTMLButtonElement>("[data-inline-predicate]")) {
      button.addEventListener("click", () => {
        selectedPredicate = button.dataset.inlinePredicate;
        render();
      });
    }
  }, 0);

  const visibleDegree = incident.length;
  const totalDegree = model.statsByNode.get(node.object_id)?.degree ?? visibleDegree;
  return `
    <div class="neighbor-summary">
      <strong>${visibleDegree} visible edges</strong>
      <span>${totalDegree} total in current lens</span>
      <div class="predicate-pills">${predicates}</div>
    </div>
  `;
}

function fillNodeForm(node: AtlasNode): void {
  setInputValue(nodeForm, "name", node.name);
  setSelectValue(nodeForm, "type", node.type);
  setInputValue(nodeForm, "subtype", node.subtype);
  setSelectValue(nodeForm, "access_class", node.access_class);
  setSelectValue(nodeForm, "encryption_class", node.encryption_class);
  setSelectValue(nodeForm, "confidence", node.confidence);
}

function setMutationControls(): void {
  const disabled = serverBacked && !serverMutable;
  for (const button of document.querySelectorAll<HTMLButtonElement>("#nodeForm button, #edgeForm button, #resetGraph, #importGraph")) {
    button.disabled = disabled;
  }
}

function showValidationNotice(message: string): void {
  validationList.innerHTML = `<div class="validation-item warning"><strong>warning</strong><span>${escapeHtml(message)}</span></div>`;
}

function edgeDiagnosticMarkup(): string {
  const edgeObjectCount = sourceCapabilities?.edge_object_count ?? 0;
  const readableEdgeCount = sourceCapabilities?.readable_edge_count ?? 0;
  const opaqueEdgeObjectCount = sourceCapabilities?.opaque_edge_object_count ?? 0;
  if (edgeObjectCount > 0 && readableEdgeCount === 0 && opaqueEdgeObjectCount > 0) {
    return `<div class="validation-item warning"><strong>warning</strong><span>${opaqueEdgeObjectCount} edge envelope${opaqueEdgeObjectCount === 1 ? "" : "s"} present, but payloads are opaque/redacted.</span></div>`;
  }
  if (edgeObjectCount === 0 && graph.edges.length === 0) {
    return '<div class="validation-item warning"><strong>warning</strong><span>No edge objects are present in the current projection.</span></div>';
  }
  return "";
}

function setOptions(select: HTMLSelectElement, options: { value: string; label: string }[]): void {
  const current = select.value;
  select.innerHTML = options.map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`).join("");
  if (options.some((option) => option.value === current)) {
    select.value = current;
  }
}

function setInputValue(form: HTMLFormElement, name: string, value: string): void {
  const input = form.elements.namedItem(name);
  if (input instanceof HTMLInputElement) {
    input.value = value;
  }
}

function setSelectValue(form: HTMLFormElement, name: string, value: string): void {
  const input = form.elements.namedItem(name);
  if (input instanceof HTMLSelectElement) {
    input.value = value;
  }
}

function selectByName(form: HTMLFormElement, name: string): HTMLSelectElement {
  const input = form.elements.namedItem(name);
  if (!(input instanceof HTMLSelectElement)) {
    throw new Error(`Missing select ${name}`);
  }
  return input;
}

function formString(data: FormData, key: string): string {
  const value = data.get(key);
  return typeof value === "string" ? value : "";
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing #${id}`);
  }
  return element as T;
}

function edgeTitle(edge: AtlasEdge, model: BaseModel): string {
  const source = model.nodesById.get(edge.source_object_id);
  const target = model.nodesById.get(edge.target_object_id);
  return `${source ? displayNodeName(source) : edge.source_object_id} -> ${edge.predicate} -> ${target ? displayNodeName(target) : edge.target_object_id}`;
}

function displayNodeName(node: AtlasNode): string {
  const raw = (node.name || node.object_id).trim();
  if (!raw) {
    return `${node.type} ${shortOpaqueId(node.object_id)}`;
  }
  if (looksLikeOpaqueHandle(raw)) {
    return `${node.type} ${shortOpaqueId(raw)}`;
  }
  return raw;
}

function looksLikeOpaqueHandle(value: string): boolean {
  return /^(attachment|block|person|organization|project|location|occurrence|topic|offering|item|object):[0-9a-f]{6,}$/i.test(value)
    || /^la_(object|edge|event)_[a-z0-9_:-]+$/i.test(value);
}

function shortOpaqueId(value: string): string {
  const normalized = value.trim();
  const suffix = /[:_]([0-9a-f]{6,})$/i.exec(normalized)?.[1];
  if (suffix) {
    return suffix.slice(0, 8);
  }
  const compact = normalized.split(/[:_]/).filter(Boolean).at(-1);
  if (compact && compact.length <= 12) {
    return compact;
  }
  return hashNumber(normalized).toString(16).slice(0, 8);
}

function matchesNode(node: AtlasNode, normalizedQuery: string): boolean {
  return [
    node.object_id,
    node.name,
    node.type,
    node.subtype,
    node.description ?? "",
    node.access_class,
    node.encryption_class,
    node.confidence
  ].some((value) => value.toLowerCase().includes(normalizedQuery));
}

function matchesEdge(edge: AtlasEdge, normalizedQuery: string, model: BaseModel): boolean {
  const source = model.nodesById.get(edge.source_object_id);
  const target = model.nodesById.get(edge.target_object_id);
  return [
    edge.edge_id,
    edge.predicate,
    edge.source,
    edge.status,
    edge.access_class,
    edge.encryption_class,
    edge.confidence,
    edge.valid_from,
    edge.valid_to ?? "",
    source?.name ?? "",
    target?.name ?? ""
  ].some((value) => value.toLowerCase().includes(normalizedQuery));
}

function nodeRank(node: VisibleNode, model: BaseModel): number {
  const stats = model.statsByNode.get(node.object_id);
  return node.importance_score + (stats?.degree ?? 0) * 2 + severityRank(node.issue_severity) * 100;
}

function edgeRank(edge: AtlasEdge, model: BaseModel): number {
  const severity = edgeIssueSeverity(edge, model);
  const sourceDegree = model.statsByNode.get(edge.source_object_id)?.degree ?? 0;
  const targetDegree = model.statsByNode.get(edge.target_object_id)?.degree ?? 0;
  const confidence = edge.confidence === "low" ? 10 : edge.confidence === "medium" ? 3 : 0;
  const status = edge.status === "active" ? 5 : edge.status === "pending" ? 7 : 2;
  return severityRank(severity) * 100 + confidence + status + Math.min(30, sourceDegree + targetDegree);
}

function queueSort(left: QueueItem, right: QueueItem): number {
  return severityRank(right.severity) - severityRank(left.severity)
    || (right.count ?? 0) - (left.count ?? 0)
    || left.title.localeCompare(right.title);
}

function isQueueItemSelected(item: QueueItem): boolean {
  return (item.kind === "node" && graph.selectedNodeId === item.subjectId)
    || (item.kind === "edge" && graph.selectedEdgeId === item.subjectId)
    || (item.kind === "predicate" && selectedPredicate === item.predicate);
}

function issueIndexForNode(nodeId: string): number {
  return currentModel?.queueItems.get("issues")?.findIndex((item) => item.kind === "node" && item.subjectId === nodeId) ?? -1;
}

function edgeIssueSeverity(edge: AtlasEdge, model: BaseModel): EdgeSeverity {
  let severity = model.issueSeverityBySubject.get(edge.edge_id) ?? "ok";
  if (edge.confidence === "low" || edge.status === "pending" || edge.status === "dormant") {
    severity = maxSeverity(severity, "warning");
  }
  if (!model.nodesById.has(edge.source_object_id) || !model.nodesById.has(edge.target_object_id)) {
    severity = "error";
  }
  return severity;
}

function maxSeverity(left: EdgeSeverity, right: EdgeSeverity): EdgeSeverity {
  return severityRank(right) > severityRank(left) ? right : left;
}

function severityRank(severity: EdgeSeverity): number {
  if (severity === "error") {
    return 2;
  }
  if (severity === "warning") {
    return 1;
  }
  return 0;
}

function nodeSize(node: VisibleNode, degree: number, root: boolean, nodeCount: number): number {
  const base = nodeCount > 120 ? 4.5 : 5.8;
  const degreeBoost = Math.min(8, Math.log2(degree + 1) * 2.6);
  const issueBoost = node.issue_severity === "error" ? 3 : node.issue_severity === "warning" ? 1.8 : 0;
  const rootBoost = root ? 4 : 0;
  return base + degreeBoost + issueBoost + rootBoost;
}

function nodeColor(type: NodeType): string {
  const colors: Record<NodeType, string> = {
    person: "#2d6e5b",
    organization: "#2f5d7c",
    project: "#7b6651",
    location: "#4d7a86",
    occurrence: "#b8872b",
    topic: "#725aa6",
    offering: "#ba4f35",
    item: "#587247",
    object: "#606a70"
  };
  return colors[type];
}

function edgeColor(edge: AtlasEdge, severity: EdgeSeverity): string {
  if (severity === "error") {
    return "#a94743";
  }
  if (severity === "warning") {
    return "#b8872b";
  }
  if (edge.access_class === "local-private" || edge.encryption_class === "client-encrypted") {
    return "#725aa6";
  }
  if (edge.status === "ended" || edge.status === "dormant") {
    return "#8b938d";
  }
  return "#53615b";
}

function issueColor(severity: EdgeSeverity): string {
  if (severity === "error") {
    return "#a94743";
  }
  if (severity === "warning") {
    return "#b8872b";
  }
  return "#d8e1db";
}

function modeTitle(value: AccessMode): string {
  if (value === "remote") {
    return "Remote readable";
  }
  if (value === "cloud-unlock") {
    return "Cloud unlock";
  }
  return "Local full graph";
}

function focusDepthLabel(value: FocusDepth): string {
  if (value === "0") {
    return "focus only";
  }
  if (value === "1") {
    return "1 hop";
  }
  if (value === "2") {
    return "2 hops";
  }
  return "3 hops";
}

function normalizeQuery(value: string): string {
  return value.trim().toLowerCase();
}

function hashNumber(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededAngle(value: string): number {
  return (hashNumber(value) % 6283) / 1000;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
