const pageSize = 24;
const state = {
  tab: "owner_review",
  queue: null,
  query: "",
  page: 1,
  selected: new Set(),
  bulkPreview: null,
  activeCandidate: null,
  editing: null,
  busy: false
};

const root = document.querySelector("#queue");
const status = document.querySelector("#status");
const summary = document.querySelector("#queue-summary");
const search = document.querySelector("#search");
const bulk = document.querySelector("#bulk-actions");
const selectPage = document.querySelector("#select-page");
const selectionCount = document.querySelector("#selection-count");
const bulkDecisionActions = document.querySelector("#bulk-decision-actions");
const bulkPreview = document.querySelector("#bulk-preview");
const bulkPreviewTitle = document.querySelector("#bulk-preview-title");
const bulkPreviewSummary = document.querySelector("#bulk-preview-summary");
const bulkPreviewDetails = document.querySelector("#bulk-preview-details");
const bulkPreviewMutations = document.querySelector("#bulk-preview-mutations");
const bulkPreviewEvidence = document.querySelector("#bulk-preview-evidence");
const bulkPreviewApply = document.querySelector("#bulk-preview-apply");
const bulkPreviewCancel = document.querySelector("#bulk-preview-cancel");
const pagination = document.querySelector("#pagination");
const pageStatus = document.querySelector("#page-status");
const previousPage = document.querySelector("#previous-page");
const nextPage = document.querySelector("#next-page");

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function humanState(value) {
  return {
    "owner-review": "Your review",
    research: "Research suggested",
    "deferred-unknown": "Decide later",
    resolved: "Meaning preserved",
    "auto-applied": "Applied automatically"
  }[value] || value;
}

function kindLabel(kind) {
  return {
    entity: "Entity candidate",
    attribute: "Attribute candidate",
    fact: "Fact candidate",
    relationship: "Relationship candidate",
    observation: "Unresolved observation",
    provenance: "Provenance"
  }[kind] || kind;
}

function recommendationText(item) {
  return item.recommendation_rationale?.summary || "Review how this source maps into the graph before deciding.";
}

function recordText(record, fallback) {
  if (record.schema === "atlas.observation:v1") {
    return record.statement.startsWith("Imported source coverage ") ? fallback : record.statement;
  }
  if (record.schema === "atlas.entity:v1") return `${record.name} · ${record.type}`;
  if (record.schema === "atlas.fact:v1") {
    const value = typeof record.value?.value === "string" ? record.value.value : record.value?.kind;
    return `${record.predicate}: ${value || "structured value"}`;
  }
  if (record.schema === "atlas.relationship:v2") return `${record.predicate} relationship`;
  return record.schema.replace("atlas.", "").replace(/:v\d+$/, "").replaceAll("-", " ");
}

function recordTypeLabel(recordType) {
  return {
    entity: "Entity",
    observation: "Unresolved observation",
    fact: "Fact",
    relationship: "Relationship"
  }[recordType] || recordType;
}

function relatedAttributes(element, mappingIds, destinationIds) {
  const mappings = [...new Set((Array.isArray(mappingIds) ? mappingIds : [mappingIds]).filter(Boolean))];
  const destinations = [...new Set((Array.isArray(destinationIds) ? destinationIds : [destinationIds]).filter(Boolean))];
  if (mappings.length) element.setAttribute("data-mapping-id", mappings.join(" "));
  if (destinations.length) element.setAttribute("data-destination-id", destinations.join(" "));
  return element;
}

function evidenceDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric"
  });
}

function evidenceDetails(summary) {
  if (!summary?.evidence?.length) return node("small", "evidence-empty", "No linked evidence details");
  const list = node("div", "evidence-list");
  summary.evidence.forEach((evidence) => {
    const details = node("details", "evidence-detail");
    details.append(node("summary", "", `${evidence.source_label} · ${evidence.stance} · ${evidenceDate(evidence.retrieved_at)} · ${evidence.confidence}`));
    const privateDetail = node("div", "evidence-private");
    privateDetail.append(node("strong", "", "Source location"), node("p", "evidence-locator", evidence.private_detail.locator));
    if (evidence.private_detail.excerpt) {
      privateDetail.append(node("strong", "", "Source excerpt"), node("blockquote", "", evidence.private_detail.excerpt));
    }
    if (evidence.private_detail.snapshot_ref) {
      privateDetail.append(node("strong", "", "Saved source"), node("p", "", "An encrypted source snapshot is attached."));
    }
    details.append(privateDetail);
    list.append(details);
  });
  return list;
}

function destinationRecordNode(destination, summary, fallback, mappingId) {
  const entry = node("article", `destination-record record-${destination.record_type}`);
  relatedAttributes(entry, mappingId, destination.object_id);
  entry.tabIndex = 0;
  const header = node("header", "destination-record-header");
  const type = node("span", "destination-record-type", recordTypeLabel(destination.record_type));
  const coverage = node("span", `coverage coverage-${summary?.parity || "uncovered"}`, summary?.parity === "covered" ? "Source covered" : "Needs mapping");
  header.append(type, coverage);
  entry.append(
    header,
    node("p", "destination-record-copy", summary?.label || recordText(destination.record, fallback)),
    node("p", "destination-rationale", summary?.rationale || "This destination needs more source context."),
    evidenceDetails(summary)
  );
  return entry;
}

function searchableText(item) {
  return [
    item.headline,
    ...item.source_context.flatMap((evidence) => [evidence.excerpt, evidence.publisher]),
    ...item.source_accounting.meaningful_units.flatMap((unit) => [unit.atlas_text, unit.kind]),
    ...item.source_accounting.excluded_units.map((unit) => unit.source_text),
    ...item.proposed_records.map((record) => recordText(record, item.headline))
  ].filter(Boolean).join(" ").toLowerCase();
}

function filteredItems() {
  const items = state.queue?.[state.tab] || [];
  const query = state.query.trim().toLowerCase();
  return query ? items.filter((item) => searchableText(item).includes(query)) : items;
}

function visibleItems() {
  const items = filteredItems();
  const start = (state.page - 1) * pageSize;
  return items.slice(start, start + pageSize);
}

function isActionableReviewItem(item) {
  return item.resolution_mode !== "incomplete";
}

function selectedBulkItems() {
  return [...state.queue.owner_review, ...state.queue.research]
    .filter(isActionableReviewItem)
    .filter((item) => state.selected.has(item.candidate_id));
}

function clearBulkPreview() {
  state.bulkPreview = null;
  bulkPreview.hidden = true;
}

function selectedItem(items) {
  const selected = items.find((item) => item.candidate_id === state.activeCandidate) || items[0];
  state.activeCandidate = selected?.candidate_id ?? null;
  return selected;
}

function relatedTokens(element, attribute) {
  return new Set((element?.getAttribute?.(attribute) || "").split(/\s+/).filter(Boolean));
}

function intersects(left, right) {
  return [...left].some((value) => right.has(value));
}

function clearRelated() {
  root.querySelectorAll(".is-related, .is-related-origin").forEach((element) => {
    element.classList.remove("is-related", "is-related-origin");
  });
}

function activateRelated(target) {
  const origin = target?.closest?.("[data-mapping-id], [data-destination-id]");
  clearRelated();
  if (!origin || !root.contains(origin)) return;
  const mappingIds = relatedTokens(origin, "data-mapping-id");
  const destinationIds = relatedTokens(origin, "data-destination-id");
  root.querySelectorAll("[data-mapping-id], [data-destination-id]").forEach((element) => {
    if (intersects(mappingIds, relatedTokens(element, "data-mapping-id"))
      || intersects(destinationIds, relatedTokens(element, "data-destination-id"))) {
      element.classList.add("is-related");
    }
  });
  origin.classList.add("is-related-origin");
}

root.addEventListener("pointerenter", (event) => activateRelated(event.target), true);
root.addEventListener("pointerleave", (event) => activateRelated(event.relatedTarget), true);
root.addEventListener("focusin", (event) => activateRelated(event.target));
root.addEventListener("focusout", () => queueMicrotask(() => activateRelated(document.activeElement)));

function sourceRow(item, active) {
  const row = node("div", `source-row${active ? " active" : ""}`);
  if ((state.tab === "owner_review" || state.tab === "research") && isActionableReviewItem(item)) {
    const select = node("input", "source-select");
    select.type = "checkbox";
    select.checked = state.selected.has(item.candidate_id);
    select.ariaLabel = `Select ${item.headline}`;
    select.onchange = () => {
      if (select.checked && state.selected.size < 100) state.selected.add(item.candidate_id);
      else state.selected.delete(item.candidate_id);
      clearBulkPreview();
      renderBulk();
    };
    row.append(select);
  }
  const open = node("button", "source-open");
  open.type = "button";
  open.ariaCurrent = active ? "true" : "false";
  open.append(
    node("span", "source-row-title", item.headline),
    node("span", "source-row-meta", `${item.source_accounting.meaningful_units.length} extracted · ${item.source_accounting.excluded_units.length} omitted`)
  );
  open.onclick = () => {
    state.activeCandidate = item.candidate_id;
    state.editing = null;
    render();
  };
  row.append(open);
  return row;
}

function sourceBrowser(items, selected) {
  const aside = node("aside", "source-browser");
  const header = node("header", "source-browser-header");
  header.append(node("p", "lane-label", "Sources on this page"), node("span", "", String(items.length)));
  aside.append(header);
  const list = node("div", "source-browser-list");
  items.forEach((item) => list.append(sourceRow(item, item.candidate_id === selected?.candidate_id)));
  aside.append(list);
  return aside;
}

function mappingRow(item, mapping, index) {
  const unit = mapping.unit;
  const destinationIds = mapping.destination_records.map((destination) => destination.object_id);
  const row = node("article", `mapping-row kind-${unit.kind}`);
  row.dataset.unitIndex = String(index);
  relatedAttributes(row, mapping.mapping_id, destinationIds);
  const source = node("div", "mapping-source");
  relatedAttributes(source, mapping.mapping_id, destinationIds);
  source.tabIndex = 0;
  source.title = unit.source_text;
  source.append(node("span", "mapping-cell-label", "Source says"), node("p", "mapping-copy", unit.source_text));

  const connector = node("div", "mapping-connector");
  relatedAttributes(connector, mapping.mapping_id, destinationIds);
  connector.ariaHidden = "true";
  connector.append(node("span", "", "maps to"));

  const destination = node("div", "mapping-destination");
  relatedAttributes(destination, mapping.mapping_id, destinationIds);
  destination.tabIndex = 0;
  destination.title = mapping.destination_summaries.map((summary) => summary.label).join(", ") || unit.atlas_text;
  const destinationHeader = node("header", "mapping-destination-header");
  const destinationCount = mapping.destination_records.length;
  destinationHeader.append(node("span", `meaning-kind kind-${unit.kind}`, destinationCount
    ? `${destinationCount} kept item${destinationCount === 1 ? "" : "s"}`
    : kindLabel(unit.kind)));
  if ((state.tab === "owner_review" || state.tab === "research") && isActionableReviewItem(item)) {
    const queued = item.research_requested_all || item.research_requested_units.some((requested) => requested.unit_id === unit.unit_id);
    const research = node("button", "unit-research", queued ? "Queued" : "Research");
    research.type = "button";
    research.dataset.researchUnit = unit.unit_id;
    research.disabled = queued;
    research.title = queued ? "Research is queued." : "Queue research for only this extracted item.";
    destinationHeader.append(research);
  }
  destination.append(destinationHeader);
  if (mapping.destination_records.length) {
    const records = node("div", "destination-records");
    mapping.destination_records.forEach((record) => {
      const summary = mapping.destination_summaries.find((candidate) => candidate.destination_object_id === record.object_id);
      records.append(destinationRecordNode(record, summary, unit.atlas_text, mapping.mapping_id));
    });
    destination.append(records);
  } else {
    destination.append(
      node("p", "mapping-copy", unit.atlas_text),
      node("small", "storage-kind", "This source fragment will be kept as a sourced observation")
    );
  }
  row.append(source, connector, destination);
  return row;
}

function sourceContextRow(item) {
  const mappingId = `source-context:${item.candidate_id}`;
  const records = item.source_context_mapping.destination_records;
  const destinationIds = records.map((destination) => destination.object_id);
  const row = node("article", "source-context-row mapping-row");
  relatedAttributes(row, mappingId, destinationIds);
  const source = node("div", "mapping-source");
  relatedAttributes(source, mappingId, destinationIds);
  source.tabIndex = 0;
  source.append(
    node("span", "mapping-cell-label", "Complete source"),
    node("p", "mapping-copy", "Complete-source context that cannot be assigned to only one fragment")
  );
  const connector = node("div", "mapping-connector");
  relatedAttributes(connector, mappingId, destinationIds);
  connector.ariaHidden = "true";
  connector.append(node("span", "", "supports"));
  const destination = node("div", "mapping-destination");
  relatedAttributes(destination, mappingId, destinationIds);
  destination.tabIndex = 0;
  const recordsNode = node("div", "destination-records");
  records.forEach((record) => {
    const summary = item.source_context_mapping.destination_summaries
      .find((candidate) => candidate.destination_object_id === record.object_id);
    recordsNode.append(destinationRecordNode(record, summary, item.headline, mappingId));
  });
  destination.append(recordsNode);
  row.append(source, connector, destination);
  return row;
}

function excludedDetails(item) {
  const excluded = item.source_accounting.excluded_units;
  if (!excluded.length) return undefined;
  const details = node("details", "excluded-details");
  details.append(node("summary", "", `Not kept as graph knowledge (${excluded.length})`));
  const list = node("ul", "excluded-list");
  excluded.forEach((unit) => {
    const entry = node("li", "");
    entry.append(node("span", "", unit.source_text), node("small", "", unit.reason));
    list.append(entry);
  });
  details.append(list, node("p", "excluded-note", "Removed from the knowledge output, but retained in encrypted source evidence."));
  return details;
}

function mappingPanel(item) {
  const panel = node("section", "mapping-panel");
  const toolbar = node("header", "mapping-toolbar");
  const tally = node("div", "meaning-summary");
  tally.append(node("strong", "", String(item.source_accounting.meaningful_units.length)), node("span", "", "Extracted meaning"));
  toolbar.append(tally, node("p", item.source_accounting.exact_source_preserved ? "source-preserved" : "warning", item.source_accounting.exact_source_preserved ? "Full source retained as encrypted evidence" : "Full source is not verified; preserving is blocked."));
  panel.append(toolbar);

  const untouched = node("details", "original-source");
  const sourceText = item.source_context.map((evidence) => evidence.excerpt || "").join("");
  untouched.append(node("summary", "", "View untouched source"), node("pre", "source-quote", sourceText || "No source excerpt is linked."));
  panel.append(untouched);

  const labels = node("div", "mapping-labels");
  labels.append(node("span", "", "What the source says"), node("span", "", "What will be kept"));
  panel.append(labels);

  const scroll = node("div", "mapping-scroll");
  if (item.source_context_mapping.destination_records.length) scroll.append(sourceContextRow(item));
  item.unit_mappings.forEach((mapping, index) => scroll.append(mappingRow(item, mapping, index)));
  if (!item.source_accounting.meaningful_units.length) {
    scroll.append(node("p", "empty-copy", "No meaningful source units were extracted."));
  }
  panel.append(scroll);
  const excluded = excludedDetails(item);
  if (excluded) panel.append(excluded);
  return panel;
}

function miniGraph(item) {
  const recordCount = item.graph.nodes.length + item.graph.edges.filter((edge) => edge.kind === "relationship").length;
  const graph = node("details", "mini-graph");
  graph.append(node("summary", "", `Source mini graph (${recordCount})`));
  graph.append(node("p", "graph-note", "Context explains why. Nodes are people, organizations, projects, places, or events. Lines show relationships."));
  const canvas = node("div", "graph-scroll");
  const nodesById = new Map(item.graph.nodes.map((graphNode) => [graphNode.node_id, graphNode]));
  const entityNode = (entityId) => nodesById.get(entityId);
  const mappingIdsForDestination = (destinationId) => {
    const mappingIds = item.unit_mappings
      .filter((mapping) => mapping.destination_records.some((destination) => destination.object_id === destinationId))
      .map((mapping) => mapping.mapping_id);
    if (item.source_context_mapping.destination_records.some((destination) => destination.object_id === destinationId)) {
      mappingIds.push(`source-context:${item.candidate_id}`);
    }
    return mappingIds.length ? mappingIds : [`unmapped:${destinationId}`];
  };
  const chip = (graphNode, mappingIds, destinationId, extraClass = "") => {
    const element = node("span", `graph-chip ${extraClass}`.trim(), graphNode?.label || "Unavailable endpoint");
    element.tabIndex = 0;
    element.title = graphNode?.label || "Unavailable endpoint";
    relatedAttributes(element, mappingIds, destinationId);
    return element;
  };
  item.graph.edges.forEach((edge) => {
    const mappingIds = mappingIdsForDestination(edge.assertion_id);
    const row = node("div", `graph-adjacency graph-${edge.kind}`);
    relatedAttributes(row, mappingIds, edge.assertion_id);
    row.tabIndex = 0;
    if (edge.kind === "relationship") {
      row.append(
        chip(entityNode(edge.source_entity_id), mappingIds, edge.source_entity_id, "graph-entity"),
        node("span", "graph-predicate", `— ${edge.predicate.replaceAll("-", " ")} →`),
        chip(entityNode(edge.target_entity_id), mappingIds, edge.target_entity_id, "graph-entity")
      );
    } else if (edge.kind === "fact") {
      row.append(
        chip(entityNode(edge.source_entity_id), mappingIds, edge.source_entity_id, "graph-entity"),
        node("span", "graph-predicate", `— ${edge.predicate.replaceAll("-", " ")} →`),
        chip(nodesById.get(edge.target_node_id), mappingIds, edge.assertion_id, "graph-fact-value")
      );
    } else {
      if (edge.source_entity_id) {
        row.append(chip(entityNode(edge.source_entity_id), mappingIds, edge.source_entity_id, "graph-entity"));
      } else {
        const source = node("span", "graph-chip graph-source", "Source context");
        relatedAttributes(source, mappingIds, edge.assertion_id);
        row.append(source);
      }
      row.append(
        node("span", "graph-predicate graph-unresolved", "┄ unresolved ⇢"),
        chip(nodesById.get(edge.target_node_id), mappingIds, edge.assertion_id, "graph-observation")
      );
    }
    canvas.append(row);
  });
  const connectedNodeIds = new Set(item.graph.edges.flatMap((edge) => {
    if (edge.kind === "relationship") return [edge.source_entity_id, edge.target_entity_id];
    if (edge.kind === "fact") return [edge.source_entity_id, edge.target_node_id];
    return [edge.target_node_id, ...(edge.source_entity_id ? [edge.source_entity_id] : [])];
  }));
  item.graph.nodes.filter((graphNode) => !connectedNodeIds.has(graphNode.node_id)).forEach((graphNode) => {
    const mappingIds = mappingIdsForDestination(graphNode.object_id);
    const row = node("div", `graph-adjacency graph-isolated graph-${graphNode.kind}`);
    relatedAttributes(row, mappingIds, graphNode.object_id);
    row.tabIndex = 0;
    row.append(chip(graphNode, mappingIds, graphNode.object_id, `graph-${graphNode.kind}`));
    canvas.append(row);
  });
  if (recordCount === 0) canvas.append(node("p", "empty-copy", "No destination records are available."));
  graph.append(canvas);
  return graph;
}

function actionButton(label, action, className = "") {
  const button = node("button", className, label);
  button.type = "button";
  button.dataset.action = action;
  return button;
}

function decisionPanel(item) {
  const panel = node("aside", "decision-panel");
  panel.append(node("p", "lane-label", "Your decision"), node("p", "recommendation", recommendationText(item)));
  const truth = node("section", "storage-truth");
  const typedCount = item.decision_summaries.filter((summary) => summary.destination_kind !== "observation").length;
  const observationCount = item.graph.nodes.filter((graphNode) => graphNode.kind === "observation").length;
  const incomplete = item.resolution_mode === "incomplete";
  truth.append(
    node("strong", "", "What Keep does"),
    node("p", incomplete ? "warning" : "", incomplete
      ? item.resolution_mode_explanation
      : item.resolution_mode === "rich"
        ? `Keeps ${typedCount} typed item${typedCount === 1 ? "" : "s"} and ${observationCount} sourced observation${observationCount === 1 ? "" : "s"}. Editing changes only the addressed observations.`
        : "Keeps the mapped observations and expands the general source destination into one sourced observation per extracted item.")
  );
  panel.append(truth);

  if (item.resolution_mode === "incomplete") {
    panel.append(
      node("p", "warning", `Mapping incomplete: ${item.resolution_mode_explanation} No decision is available until the mapping is repaired.`),
      miniGraph(item)
    );
    return panel;
  }

  if (state.tab === "automatic" || state.tab === "deferred") {
    panel.append(node("p", "resolved-copy", state.tab === "automatic" ? "The meaning is preserved; typing may still remain open." : "This source is set aside and remains fully preserved."), miniGraph(item));
    return panel;
  }

  if (state.tab === "research") {
    const queued = item.research_requested_all
      ? "Whole source queued."
      : item.research_requested_units.length
        ? `${item.research_requested_units.length} extracted item${item.research_requested_units.length === 1 ? "" : "s"} queued.`
        : "Research suggested, but nothing is queued.";
    panel.append(node("p", "research-state", `${queued} Research waits for the next active Atlas research task.`));
  }

  const actions = node("div", "decision-actions");
  const preserve = actionButton("Keep", "keep", "primary");
  const edit = actionButton("Edit", "edit");
  const merge = actionButton("Merge", "merge");
  merge.disabled = true;
  merge.title = "Merge will be available after identity comparison is added.";
  preserve.disabled = incomplete || !item.source_accounting.exact_source_preserved || item.source_accounting.meaningful_units.length === 0;
  edit.disabled = incomplete;
  preserve.title = incomplete ? item.resolution_mode_explanation : "";
  edit.title = incomplete ? item.resolution_mode_explanation : "";
  actions.append(preserve, edit, merge);
  if (state.tab === "owner_review" || !item.research_requested_all) actions.append(actionButton("Research", "research"));
  actions.append(actionButton("Later", "defer", "quiet"));
  panel.append(actions, miniGraph(item));
  return panel;
}

function technicalDetails(item) {
  const details = node("details", "technical");
  details.append(node("summary", "", "Technical details"));
  const list = node("dl", "");
  const entries = [
    ["Candidate", item.candidate_id],
    ["Review record", item.review_id],
    ["Evidence", item.evidence_ids.join(", ") || "None"],
    ["Coverage records", item.parity_ids.join(", ") || "None"],
    ["Destinations", item.decision_summaries.map((entry) => entry.destination_object_id).join(", ") || "None"],
    ["Reason codes", item.recommendation_rationale.reason_codes.join(", ") || "None"],
    ["Dependencies", item.missing_references.join(", ") || "Complete"]
  ];
  entries.forEach(([term, value]) => {
    const group = node("div", "");
    group.append(node("dt", "", term), node("dd", "", value));
    list.append(group);
  });
  details.append(list);
  return details;
}

function changedObservationEdits(fields) {
  return fields.flatMap((field) => {
    const statement = field.textarea.value;
    return statement === field.original_statement
      ? []
      : [{ observation_id: field.observation_id, statement }];
  });
}

function editForm(item) {
  const form = node("form", "editor");
  if (item.resolution_mode === "incomplete") {
    form.append(node("p", "editor-intro warning", item.resolution_mode_explanation));
    return form;
  }
  const mappedObservations = [];
  const seenObservationIds = new Set();
  item.unit_mappings.forEach((mapping, unitIndex) => {
    mapping.destination_records
      .filter((destination) => destination.record_type === "observation")
      .forEach((destination, chunkIndex) => {
        if (seenObservationIds.has(destination.object_id)) return;
        seenObservationIds.add(destination.object_id);
        mappedObservations.push({ destination, unitIndex, chunkIndex, chunkCount: mapping.observation_ids.length });
      });
  });
  const richEditor = item.resolution_mode === "rich";
  form.append(node("p", "editor-intro", richEditor
    ? "Edit individual observation records. Typed entities, facts, relationships, other chunks, and encrypted source evidence remain unchanged."
    : "Edit the normalized meaning. The encrypted source remains unchanged."));
  const editableItems = richEditor
    ? mappedObservations
    : item.source_accounting.meaningful_units.map((unit, unitIndex) => ({ unit, unitIndex }));
  const fields = editableItems.map((editable, index) => {
    const isChunked = richEditor && editable.chunkCount > 1;
    const labelText = richEditor
      ? `${editable.unitIndex + 1}. Observation${isChunked ? ` chunk ${editable.chunkIndex + 1} of ${editable.chunkCount}` : ""}`
      : `${index + 1}. ${kindLabel(editable.unit.kind)}`;
    const label = node("label", "", labelText);
    const textarea = node("textarea", "");
    textarea.name = `statement-${index}`;
    textarea.maxLength = 8192;
    textarea.required = true;
    textarea.value = richEditor ? editable.destination.record.statement : editable.unit.atlas_text;
    label.append(textarea);
    form.append(label);
    return {
      textarea,
      observation_id: richEditor ? editable.destination.object_id : undefined,
      original_statement: richEditor ? editable.destination.record.statement : undefined
    };
  });
  const actions = node("div", "editor-actions");
  const save = node("button", "primary", "Save and Keep");
  save.type = "submit";
  const cancel = node("button", "", "Cancel");
  cancel.type = "button";
  cancel.dataset.cancelEdit = item.candidate_id;
  actions.append(save, cancel);
  form.append(actions);
  form.onsubmit = (event) => {
    event.preventDefault();
    if (richEditor) {
      const observationEdits = changedObservationEdits(fields);
      decide(item.candidate_id, "keep", undefined, undefined,
        observationEdits.length ? observationEdits : undefined);
    } else {
      decide(item.candidate_id, "keep", fields.map((field) => field.textarea.value));
    }
  };
  return form;
}

function card(item) {
  const article = node("article", "review-card compact-card");
  article.dataset.candidate = item.candidate_id;
  const header = node("header", "card-header");
  const title = node("div", "card-title");
  title.append(node("p", "state-label", humanState(item.resolution_state)), node("h2", "", item.headline));
  header.append(title);
  article.append(header);
  const body = node("div", "compact-body");
  body.append(mappingPanel(item), decisionPanel(item));
  article.append(body);
  if (state.editing === item.candidate_id) article.append(editForm(item));
  article.append(technicalDetails(item));
  article.querySelectorAll("[data-action]").forEach((button) => {
    button.onclick = () => {
      if (button.dataset.action === "edit") {
        state.editing = item.candidate_id;
        render();
      } else {
        decide(item.candidate_id, button.dataset.action);
      }
    };
  });
  article.querySelectorAll("[data-research-unit]").forEach((button) => {
    button.onclick = () => decide(item.candidate_id, "research", undefined, [button.dataset.researchUnit], undefined);
  });
  article.querySelector("[data-cancel-edit]")?.addEventListener("click", () => {
    state.editing = null;
    render();
  });
  return article;
}

function workspace(items, selected) {
  const workspace = node("div", "review-workspace");
  workspace.append(sourceBrowser(items, selected));
  const detail = node("section", "selected-source");
  detail.append(selected ? card(selected) : node("div", "empty-state", "No source is selected."));
  workspace.append(detail);
  return workspace;
}

function renderTabs() {
  document.querySelectorAll("[data-tab]").forEach((button) => {
    const tab = button.dataset.tab;
    button.classList.toggle("active", tab === state.tab);
    button.querySelector("[data-count]").textContent = String(state.queue?.[tab]?.length || 0);
  });
}

function renderSummary(items) {
  const total = state.queue?.[state.tab]?.length || 0;
  const label = { owner_review: "sources need your judgment", research: "sources may benefit from research", deferred: "sources are set aside", automatic: "sources are preserved" }[state.tab];
  summary.replaceChildren(
    node("strong", "", total.toLocaleString()),
    node("span", "", label),
    ...(state.query ? [node("small", "", `${items.length.toLocaleString()} match your search`)] : [])
  );
}

function renderBulk() {
  const actionable = state.tab === "owner_review" || state.tab === "research";
  const visible = visibleItems().filter(isActionableReviewItem);
  const selectedItems = selectedBulkItems();
  const compatibilityKeys = new Set(selectedItems.map((item) => item.bulk_compatibility_key));
  const compatible = selectedItems.length > 0 && compatibilityKeys.size === 1;
  bulk.hidden = !actionable || visible.length === 0;
  selectionCount.textContent = `${selectedItems.length} selected`;
  selectPage.checked = visible.length > 0 && visible.every((item) => state.selected.has(item.candidate_id));
  selectPage.indeterminate = visible.some((item) => state.selected.has(item.candidate_id)) && !selectPage.checked;
  bulkDecisionActions.hidden = !compatible;
  bulkDecisionActions.querySelectorAll("button").forEach((button) => button.disabled = state.busy);
  const unsafePreserve = selectedItems.some((item) => !item.source_accounting.exact_source_preserved
    || item.source_accounting.meaningful_units.length === 0);
  const preserveButton = bulk.querySelector('[data-bulk-action="keep"]');
  preserveButton.disabled = state.busy || unsafePreserve;
  preserveButton.title = unsafePreserve ? "One or more selected sources do not have complete extraction coverage." : "";
  bulkPreviewApply.disabled = state.busy;
  bulkPreviewCancel.disabled = state.busy;
  if (selectedItems.length > 1 && !compatible) {
    state.bulkPreview = null;
    bulkPreview.hidden = false;
    bulkPreviewTitle.textContent = "Narrow this selection";
    bulkPreviewSummary.textContent = "These sources have different destination shapes or evidence rules. Your selection is unchanged; choose sources with the same exact effects.";
    bulkPreviewDetails.hidden = true;
    bulkPreviewApply.hidden = true;
    bulkPreviewCancel.hidden = true;
  } else if (!state.bulkPreview) {
    bulkPreview.hidden = true;
  }
}

function renderPagination(items) {
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  if (state.page > pages) state.page = pages;
  pagination.hidden = items.length <= pageSize;
  pageStatus.textContent = `Page ${state.page} of ${pages}`;
  previousPage.disabled = state.page === 1;
  nextPage.disabled = state.page === pages;
}

function render() {
  if (!state.queue) return;
  const items = filteredItems();
  renderTabs();
  renderSummary(items);
  renderPagination(items);
  const visible = visibleItems();
  const selected = selectedItem(visible);
  root.replaceChildren(visible.length
    ? workspace(visible, selected)
    : node("div", "empty-state", state.query ? "No sources match this search." : "Nothing needs attention in this queue."));
  renderBulk();
}

async function load(message) {
  const response = await fetch("/api/review-queue", { credentials: "same-origin" });
  if (!response.ok) {
    status.textContent = "The local review session is unavailable. Restart Atlas Review and try again.";
    return;
  }
  state.queue = await response.json();
  if (!state.queue[state.tab]?.length) {
    state.tab = state.queue.owner_review.length ? "owner_review"
      : state.queue.research.length ? "research"
        : state.queue.deferred.length ? "deferred"
          : "automatic";
  }
  const actionable = new Set([...state.queue.owner_review, ...state.queue.research]
    .filter(isActionableReviewItem).map((item) => item.candidate_id));
  state.selected = new Set([...state.selected].filter((candidate) => actionable.has(candidate)));
  state.bulkPreview = null;
  status.textContent = message || "Ready. Decisions save atomically to your local Atlas; research requests wait for an active research task.";
  render();
}

async function decide(candidate, action, statements, unitIds, observationEdits) {
  if (state.busy) return;
  state.busy = true;
  status.textContent = "Saving your decision…";
  renderBulk();
  try {
    const response = await fetch(`/api/review/${candidate}/decision`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action,
        ...(statements ? { statements } : {}),
        ...(unitIds ? { unit_ids: unitIds } : {}),
        ...(observationEdits ? { observation_edits: observationEdits } : {})
      })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.reason || "decision-not-saved");
    state.editing = null;
    state.selected.delete(candidate);
    await load(action === "keep" ? "All extracted meaning was kept in Atlas." : action === "research" ? "Research request queued for the next active research task." : "Set aside for later.");
  } catch (error) {
    status.textContent = `Nothing changed: ${String(error.message || error).replaceAll("-", " ")}.`;
  } finally {
    state.busy = false;
    renderBulk();
  }
}

async function decideBulk(action) {
  if (state.busy || state.selected.size === 0) return;
  const selectedItems = selectedBulkItems();
  if (new Set(selectedItems.map((item) => item.bulk_compatibility_key)).size !== 1) {
    renderBulk();
    return;
  }
  const candidates = selectedItems.map((item) => item.candidate_id);
  if (candidates.length === 0) return;
  state.busy = true;
  status.textContent = `Preparing exact effects for ${candidates.length} selected source${candidates.length === 1 ? "" : "s"}…`;
  renderBulk();
  try {
    const response = await fetch("/api/review/bulk/preview", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ candidate_ids: candidates, action })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.reason || "bulk-preview-unavailable");
    showBulkPreview(result.result);
    status.textContent = "Review the exact destination and evidence effects before applying.";
  } catch (error) {
    state.bulkPreview = null;
    status.textContent = `Preview unavailable: ${String(error.message || error).replaceAll("-", " ")}. Your selection is unchanged.`;
  } finally {
    state.busy = false;
    renderBulk();
  }
}

function showBulkPreview(preview) {
  state.bulkPreview = preview;
  bulkPreview.hidden = false;
  bulkPreviewDetails.hidden = false;
  bulkPreviewApply.hidden = false;
  bulkPreviewCancel.hidden = false;
  bulkPreviewTitle.textContent = `${preview.action === "keep" ? "Keep" : preview.action === "research" ? "Research" : "Later"} ${preview.counts.candidates} selected source${preview.counts.candidates === 1 ? "" : "s"}`;
  bulkPreviewSummary.textContent = `${preview.counts.object_mutations} exact object change${preview.counts.object_mutations === 1 ? "" : "s"}: ${preview.counts.creates} create, ${preview.counts.updates} update. No source material is deleted.`;

  const mutationCounts = new Map();
  preview.object_mutations.forEach((mutation) => {
    const key = `${mutation.operation}:${mutation.destination_kind}`;
    mutationCounts.set(key, (mutationCounts.get(key) || 0) + 1);
  });
  bulkPreviewMutations.replaceChildren(...[...mutationCounts.entries()].map(([key, count]) => {
    const [operation, destinationKind] = key.split(":");
    return node("li", "", `${count} × ${operation === "create" ? "Create" : "Update"} ${destinationKind}`);
  }));

  bulkPreviewEvidence.replaceChildren(...preview.evidence_independence_groups.map((group, index) => (
    node("li", "", `Evidence group ${index + 1} · ${group.source_kinds.join(" + ")} · ${group.evidence_count} record${group.evidence_count === 1 ? "" : "s"}`)
  )));
  if (preview.evidence_independence_groups.length === 0) {
    bulkPreviewEvidence.append(node("li", "", "No evidence group is attached to these changes."));
  }
  bulkPreviewApply.textContent = `Apply ${preview.action === "keep" ? "Keep" : preview.action === "research" ? "Research" : "Later"}`;
}

async function applyBulkPreview() {
  if (state.busy || !state.bulkPreview) return;
  const preview = state.bulkPreview;
  const candidates = preview.candidate_ids;
  state.busy = true;
  status.textContent = `Saving ${candidates.length} independent decisions…`;
  renderBulk();
  try {
    const response = await fetch("/api/review/bulk/decision", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(preview)
    });
    const result = await response.json();
    const committed = result.committed_candidate_ids || result.result?.resolved_candidate_ids || [];
    committed.forEach((candidate) => state.selected.delete(candidate));
    if (!response.ok) {
      const failed = result.failed_candidate_ids || candidates.filter((candidate) => !committed.includes(candidate));
      await load(`Saved ${committed.length} of ${candidates.length} decisions. ${failed.length} failed and remain selected.`);
      return;
    }
    await load(`Saved ${committed.length} independent decision${committed.length === 1 ? "" : "s"}.`);
  } catch (error) {
    await load(`The bulk request was interrupted; the queue was refreshed because we could not confirm every result. ${String(error.message || error).replaceAll("-", " ")}.`);
  } finally {
    state.busy = false;
    renderBulk();
  }
}

document.querySelectorAll("[data-tab]").forEach((button) => {
  button.onclick = () => {
    state.tab = button.dataset.tab;
    state.page = 1;
    state.query = "";
    state.activeCandidate = null;
    state.selected.clear();
    clearBulkPreview();
    search.value = "";
    render();
  };
});

search.oninput = () => {
  state.query = search.value;
  state.page = 1;
  state.activeCandidate = null;
  render();
};

selectPage.onchange = () => {
  clearBulkPreview();
  visibleItems().filter(isActionableReviewItem).forEach((item) => {
    if (selectPage.checked && state.selected.size < 100) state.selected.add(item.candidate_id);
    else state.selected.delete(item.candidate_id);
  });
  render();
};

document.querySelectorAll("[data-bulk-action]").forEach((button) => {
  button.onclick = () => decideBulk(button.dataset.bulkAction);
});

bulkPreviewApply.onclick = () => applyBulkPreview();
bulkPreviewCancel.onclick = () => {
  clearBulkPreview();
  status.textContent = "Preview closed. Your selection is unchanged.";
};

previousPage.onclick = () => {
  state.page = Math.max(1, state.page - 1);
  state.activeCandidate = null;
  render();
};

nextPage.onclick = () => {
  state.page += 1;
  state.activeCandidate = null;
  render();
};

load();
