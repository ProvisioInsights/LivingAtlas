const pageSize = 24;
const state = {
  tab: "research",
  queue: null,
  query: "",
  page: 1,
  selected: new Set(),
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
  const count = item.source_accounting.meaningful_units.length;
  if (item.recommendation === "research") {
    return `Research may improve identity or typing. Preserving now keeps all ${count} extracted item${count === 1 ? "" : "s"} as source-backed observations without inventing nodes or edges.`;
  }
  if (item.recommendation === "owner-review") {
    return `Review the ${count} extracted item${count === 1 ? "" : "s"}. Anything not safely typed remains an unresolved observation.`;
  }
  return `All ${count} extracted item${count === 1 ? "" : "s"} are accounted for.`;
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

function destinationRecordNode(destination, fallback) {
  const entry = node("article", `destination-record record-${destination.record_type}`);
  const header = node("header", "destination-record-header");
  const type = node("span", "destination-record-type", recordTypeLabel(destination.record_type));
  const id = node("code", "destination-record-id", destination.object_id);
  id.title = destination.object_id;
  header.append(type, id);
  entry.append(header, node("p", "destination-record-copy", recordText(destination.record, fallback)));
  return entry;
}

function searchableText(item) {
  return [
    item.headline,
    ...item.source_context.flatMap((evidence) => [evidence.excerpt, evidence.locator, evidence.publisher]),
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

function selectedItem(items) {
  const selected = items.find((item) => item.candidate_id === state.activeCandidate) || items[0];
  state.activeCandidate = selected?.candidate_id ?? null;
  return selected;
}

function sourceRow(item, active) {
  const row = node("div", `source-row${active ? " active" : ""}`);
  if (state.tab === "owner_review" || state.tab === "research") {
    const select = node("input", "source-select");
    select.type = "checkbox";
    select.checked = state.selected.has(item.candidate_id);
    select.ariaLabel = `Select ${item.headline}`;
    select.onchange = () => {
      if (select.checked && state.selected.size < 100) state.selected.add(item.candidate_id);
      else state.selected.delete(item.candidate_id);
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

function mappingRow(item, unit, index) {
  const mapping = item.unit_mappings[index];
  const row = node("article", `mapping-row kind-${unit.kind}`);
  row.dataset.unitIndex = String(index);
  const source = node("div", "mapping-source");
  source.tabIndex = 0;
  source.title = unit.source_text;
  source.append(node("span", "mapping-cell-label", "Original"), node("p", "mapping-copy", unit.source_text));

  const connector = node("div", "mapping-connector");
  connector.ariaHidden = "true";
  connector.append(node("span", "", "maps to"));

  const destination = node("div", "mapping-destination");
  destination.tabIndex = 0;
  destination.title = mapping?.destination_records.map((record) => record.object_id).join(", ") || unit.atlas_text;
  const destinationHeader = node("header", "mapping-destination-header");
  const destinationCount = mapping?.destination_records.length || 0;
  destinationHeader.append(node("span", `meaning-kind kind-${unit.kind}`, destinationCount
    ? `${destinationCount} canonical record${destinationCount === 1 ? "" : "s"}`
    : kindLabel(unit.kind)));
  if (state.tab === "owner_review" || state.tab === "research") {
    const queued = item.research_requested_all || item.research_requested_units.some((requested) => requested.unit_id === unit.unit_id);
    const research = node("button", "unit-research", queued ? "Queued" : "Research");
    research.type = "button";
    research.dataset.researchUnit = unit.unit_id;
    research.disabled = queued;
    research.title = queued ? "Queued for Codex research." : "Queue only this extracted item for Codex research.";
    destinationHeader.append(research);
  }
  destination.append(destinationHeader);
  if (mapping?.destination_records.length) {
    const records = node("div", "destination-records");
    mapping.destination_records.forEach((destination) => records.append(destinationRecordNode(destination, unit.atlas_text)));
    destination.append(records);
  } else {
    destination.append(
      node("p", "mapping-copy", unit.atlas_text),
      node("small", "storage-kind", "Legacy source fragment; preserving expands it to a provenance-linked observation")
    );
  }
  row.append(source, connector, destination);
  return row;
}

function excludedDetails(item) {
  const excluded = item.source_accounting.excluded_units;
  if (!excluded.length) return undefined;
  const details = node("details", "excluded-details");
  details.append(node("summary", "", `Not Atlas knowledge (${excluded.length})`));
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
  labels.append(node("span", "", "Original source fragment"), node("span", "", "Atlas output"));
  panel.append(labels);

  const scroll = node("div", "mapping-scroll");
  item.source_accounting.meaningful_units.forEach((unit, index) => scroll.append(mappingRow(item, unit, index)));
  if (!item.source_accounting.meaningful_units.length) {
    scroll.append(node("p", "empty-copy", "No meaningful source units were extracted."));
  }
  panel.append(scroll);
  const excluded = excludedDetails(item);
  if (excluded) panel.append(excluded);
  return panel;
}

function miniGraph(item) {
  const recordCount = item.destination_graph.entities.length
    + item.destination_graph.facts.length
    + item.destination_graph.relationships.length
    + item.destination_graph.observations.length;
  const graph = node("details", "mini-graph");
  graph.append(node("summary", "", `Proposed mini graph (${recordCount})`));
  graph.append(node("p", "graph-note", "Actual canonical records are shown below. Dashed observations remain unresolved; endpoint entities may be owned by another source review."));
  const canvas = node("div", "graph-scroll");
  const origin = node("div", "graph-origin", "Encrypted source evidence");
  canvas.append(origin);
  const appendRecord = (destination, edgeLabel) => {
    const branch = node("div", `graph-branch record-${destination.record_type}`);
    const graphNode = node("div", `graph-node record-${destination.record_type}`);
    graphNode.append(
      node("strong", "", `${recordTypeLabel(destination.record_type)} · ${recordText(destination.record, item.headline)}`),
      node("code", "", destination.object_id)
    );
    branch.append(node("span", "graph-edge", edgeLabel), graphNode);
    canvas.append(branch);
  };
  item.destination_graph.entities.forEach((destination) => appendRecord(destination, "contains"));
  item.destination_graph.facts.forEach((destination) => appendRecord(destination, "asserts"));
  item.destination_graph.relationships.forEach((destination) => appendRecord(destination, "links"));
  item.destination_graph.observations.forEach((destination) => appendRecord(destination, "supports"));
  if (recordCount === 0) canvas.append(node("p", "empty-copy", "No canonical destination records are available."));
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
  const typedCount = item.proposed_records.filter((record) => (
    record.schema === "atlas.entity:v1" || record.schema === "atlas.fact:v1" || record.schema === "atlas.relationship:v2"
  )).length;
  const observationCount = item.destination_graph.observations.length;
  truth.append(
    node("strong", "", "What Preserve does"),
    node("p", "", typedCount
      ? `Keeps ${typedCount} typed canonical record${typedCount === 1 ? "" : "s"} and ${observationCount} parity observation${observationCount === 1 ? "" : "s"}. Editing changes only the addressed observations.`
      : "Keeps the mapped observations. Legacy one-placeholder sources expand into one provenance-linked observation per extracted item.")
  );
  panel.append(truth);

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
    panel.append(node("p", "research-state", `${queued} Research is not running; Codex processes the queue only during an active task.`));
  }

  const actions = node("div", "decision-actions");
  const preserve = actionButton("Preserve all now", "keep", "primary");
  preserve.disabled = !item.source_accounting.exact_source_preserved || item.source_accounting.meaningful_units.length === 0;
  actions.append(preserve, actionButton("Review / edit extraction", "edit"));
  if (state.tab === "owner_review" || !item.research_requested_all) actions.append(actionButton("Request research for all", "research"));
  actions.append(actionButton("Decide later", "defer", "quiet"));
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
    ["Parity", item.parity_ids.join(", ") || "None"],
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

function editForm(item) {
  const form = node("form", "editor");
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
  const richEditor = mappedObservations.length > 0;
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
      observation_id: richEditor ? editable.destination.object_id : undefined
    };
  });
  const actions = node("div", "editor-actions");
  const save = node("button", "primary", "Save all and preserve");
  save.type = "submit";
  const cancel = node("button", "", "Cancel");
  cancel.type = "button";
  cancel.dataset.cancelEdit = item.candidate_id;
  actions.append(save, cancel);
  form.append(actions);
  form.onsubmit = (event) => {
    event.preventDefault();
    if (richEditor) {
      decide(item.candidate_id, "keep", undefined, undefined, fields.map((field) => ({
        observation_id: field.observation_id,
        statement: field.textarea.value
      })));
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
  bulk.hidden = !actionable;
  selectionCount.textContent = `${state.selected.size} selected`;
  const visible = visibleItems();
  selectPage.checked = visible.length > 0 && visible.every((item) => state.selected.has(item.candidate_id));
  selectPage.indeterminate = visible.some((item) => state.selected.has(item.candidate_id)) && !selectPage.checked;
  bulk.querySelectorAll("button").forEach((button) => button.disabled = state.busy || state.selected.size === 0);
  const selectedItems = [...state.queue.owner_review, ...state.queue.research].filter((item) => state.selected.has(item.candidate_id));
  const unsafePreserve = selectedItems.some((item) => !item.source_accounting.exact_source_preserved || item.source_accounting.meaningful_units.length === 0);
  const preserveButton = bulk.querySelector('[data-bulk-action="keep"]');
  preserveButton.disabled = preserveButton.disabled || unsafePreserve;
  preserveButton.title = unsafePreserve ? "One or more selected sources do not have complete extraction coverage." : "";
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
  const actionable = new Set([...state.queue.owner_review, ...state.queue.research].map((item) => item.candidate_id));
  state.selected = new Set([...state.selected].filter((candidate) => actionable.has(candidate)));
  status.textContent = message || "Ready. Decisions write atomically to your local Atlas; research requests wait for an active Codex task.";
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
    await load(action === "keep" ? "All extracted meaning was preserved in Atlas." : action === "research" ? "Research request queued for a future Codex task." : "Set aside for later.");
  } catch (error) {
    status.textContent = `Nothing changed: ${String(error.message || error).replaceAll("-", " ")}.`;
  } finally {
    state.busy = false;
    renderBulk();
  }
}

async function decideBulk(action) {
  if (state.busy || state.selected.size === 0) return;
  const candidates = [...state.selected];
  const selectedItems = [...state.queue.owner_review, ...state.queue.research].filter((item) => state.selected.has(item.candidate_id));
  const meaningfulCount = selectedItems.reduce((total, item) => total + item.source_accounting.meaningful_units.length, 0);
  const excludedCount = selectedItems.reduce((total, item) => total + item.source_accounting.excluded_units.length, 0);
  const verb = action === "keep" ? `Preserve ${meaningfulCount} extracted items from ${candidates.length} sources` : action === "research" ? `Queue ${candidates.length} sources for research` : `Set aside ${candidates.length} sources`;
  const consequence = action === "keep" && excludedCount ? ` ${excludedCount} source-only item${excludedCount === 1 ? "" : "s"} will remain only in encrypted evidence.` : "";
  if (!confirm(`${verb}?${consequence}`)) return;
  state.busy = true;
  status.textContent = `Saving ${candidates.length} independent decisions…`;
  renderBulk();
  try {
    const response = await fetch("/api/review/bulk/decision", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ candidate_ids: candidates, action })
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
    status.textContent = `Nothing changed: ${String(error.message || error).replaceAll("-", " ")}.`;
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
  visibleItems().forEach((item) => {
    if (selectPage.checked && state.selected.size < 100) state.selected.add(item.candidate_id);
    else state.selected.delete(item.candidate_id);
  });
  render();
};

document.querySelectorAll("[data-bulk-action]").forEach((button) => {
  button.onclick = () => decideBulk(button.dataset.bulkAction);
});

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
