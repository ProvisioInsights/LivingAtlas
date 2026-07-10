const pageSize = 24;
const state = {
  tab: "research",
  queue: null,
  query: "",
  page: 1,
  selected: new Set(),
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
    resolved: "Kept in Atlas",
    "auto-applied": "Applied automatically"
  }[value] || value;
}

function recommendationText(item) {
  const count = item.source_accounting.meaningful_units.length;
  if (item.recommendation === "research") {
    return `Research may improve identity or structure. Keeping this now preserves all ${count} meaningful item${count === 1 ? "" : "s"} as sourced observations without inventing certainty.`;
  }
  if (item.recommendation === "owner-review") {
    return `The source is preserved. Review the ${count} extracted item${count === 1 ? "" : "s"} below before keeping them.`;
  }
  return `Atlas has accounted for all ${count} meaningful item${count === 1 ? "" : "s"}.`;
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

function searchableText(item) {
  return [
    item.headline,
    item.proposal_label,
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

function sourcePanel(item) {
  const panel = node("section", "lane source-lane");
  panel.append(node("p", "lane-label", "Original source item"));
  if (item.source_context.length === 0) {
    panel.append(node("p", "empty-copy", "No surrounding source excerpt is linked."));
    return panel;
  }
  const sourceText = item.source_context.map((evidence) => evidence.excerpt || "").join("");
  const sourceUnits = node("ol", "source-unit-list");
  item.source_accounting.meaningful_units.forEach((unit, index) => {
    const entry = node("li", "source-unit", unit.source_text);
    entry.dataset.sourceIndex = String(index);
    entry.tabIndex = 0;
    sourceUnits.append(entry);
  });
  panel.append(sourceUnits);
  const original = node("details", "original-source");
  original.append(node("summary", "", "View untouched source"), node("pre", "source-quote", sourceText || "Encrypted source snapshot available locally."));
  panel.append(original);
  const source = node("p", "source-meta");
  source.append(node("span", "", "migration source"));
  panel.append(source);
  panel.append(node(
    "p",
    item.source_accounting.exact_source_preserved ? "source-preserved" : "warning",
    item.source_accounting.exact_source_preserved
      ? "Full source retained as encrypted evidence"
      : "Only bounded context is linked; keeping is blocked until the full source is verified."
  ));
  return panel;
}

function proposalPanel(item) {
  const panel = node("section", "lane proposal-lane");
  panel.append(node("p", "lane-label", "Atlas proposal"));
  const units = item.source_accounting.meaningful_units;
  const summary = node("div", "meaning-summary");
  summary.append(node("strong", "", String(units.length)), node("span", "", "Meaningful data"));
  panel.append(summary);
  panel.append(node("p", "accounting-copy", "Each item below will be kept as a provenance-linked Atlas observation. The kind describes its meaning; unresolved identities are not asserted as fact."));
  const list = node("ol", "meaning-list");
  units.forEach((unit, index) => {
    const entry = node("li", "meaning-item");
    entry.dataset.destinationIndex = String(index);
    entry.tabIndex = 0;
    entry.append(node("span", `meaning-kind kind-${unit.kind}`, unit.kind), node("span", "meaning-text", unit.atlas_text));
    if (state.tab === "owner_review" || state.tab === "research") {
      const queued = item.research_requested_all || item.research_requested_units.some((requested) => requested.unit_id === unit.unit_id);
      const research = node("button", "unit-research", queued ? "Queued" : "Research");
      research.type = "button";
      research.dataset.researchUnit = unit.unit_id;
      research.disabled = queued;
      research.title = queued ? "This extracted item is queued for Codex research." : "Queue only this extracted item for Codex research.";
      entry.append(research);
    }
    list.append(entry);
  });
  panel.append(list);
  if (!units.length) panel.append(node("p", "warning", "No meaningful source units were extracted; keeping is blocked."));

  const excluded = item.source_accounting.excluded_units;
  if (excluded.length) {
    const details = node("details", "excluded-details");
    details.append(node("summary", "", `Not Atlas knowledge (${excluded.length})`));
    const excludedList = node("ul", "excluded-list");
    excluded.forEach((unit) => {
      const entry = node("li", "");
      entry.append(node("span", "", unit.source_text), node("small", "", unit.reason));
      excludedList.append(entry);
    });
    details.append(excludedList, node("p", "excluded-note", "These words stay in the encrypted source evidence but are not promoted as knowledge."));
    panel.append(details);
  }
  if (item.missing_references.length) panel.append(node("p", "warning", `${item.missing_references.length} linked record(s) are unavailable.`));
  else if (item.source_accounting.exact_source_preserved && units.length) panel.append(node("p", "complete", `${units.length} of ${units.length} meaningful items accounted for.`));
  panel.append(miniGraph(item));
  return panel;
}

function miniGraph(item) {
  const graph = node("section", "mini-graph");
  graph.append(node("p", "proposal-kind", "Source mini graph"));
  graph.append(node("p", "graph-note", "This is the graph created now: encrypted evidence supports one observation per extracted item. Relationship candidates become semantic edges only after identity is resolved."));
  const canvas = node("div", "graph-canvas");
  const origin = node("div", "graph-origin", "Source evidence");
  origin.style.gridRow = `1 / span ${Math.max(1, item.source_accounting.meaningful_units.length)}`;
  canvas.append(origin);
  item.source_accounting.meaningful_units.forEach((unit, index) => {
    const edge = node("span", "graph-edge", "supports");
    edge.style.gridRow = String(index + 1);
    const destination = node("div", `graph-node kind-${unit.kind}`);
    destination.style.gridRow = String(index + 1);
    destination.dataset.graphIndex = String(index);
    destination.tabIndex = 0;
    destination.append(node("small", "", `${unit.kind} observation`), node("span", "", unit.atlas_text));
    canvas.append(edge, destination);
  });
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
  const panel = node("section", "lane decision-lane");
  panel.append(node("p", "lane-label", "Your decision"));
  panel.append(node("p", "recommendation", recommendationText(item)));
  if (state.tab === "automatic" || state.tab === "deferred") {
    panel.append(node("p", "resolved-copy", state.tab === "automatic" ? "All meaningful data shown here has been kept in Atlas." : "This item is set aside and remains fully preserved."));
    return panel;
  }
  const actions = node("div", "decision-actions");
  const keep = actionButton("Keep all meaningful data", "keep", "primary");
  keep.disabled = !item.source_accounting.exact_source_preserved || item.source_accounting.meaningful_units.length === 0;
  actions.append(keep);
  if (item.source_accounting.meaningful_units.length) actions.append(actionButton("Review / edit extraction", "edit"));
  if (state.tab === "owner_review" || (state.tab === "research" && !item.research_requested_all)) actions.append(actionButton("Request research for all", "research"));
  if (state.tab === "research") panel.append(node(
    "p",
    "research-state",
    item.research_requested_all
      ? "Whole source queued for Codex research · not running until a Codex task processes it"
      : item.research_requested_units.length
        ? `${item.research_requested_units.length} extracted item${item.research_requested_units.length === 1 ? "" : "s"} queued for Codex research · not running yet`
      : "Research suggested · not yet queued or running"
  ));
  actions.append(actionButton("Decide later", "defer", "quiet"));
  panel.append(actions);
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
  form.append(node("p", "editor-intro", "Edit the extracted meaning—not the original evidence. Every row will be kept."));
  const fields = item.source_accounting.meaningful_units.map((unit, index) => {
    const label = node("label", "", `${index + 1}. ${unit.kind}`);
    const textarea = node("textarea", "");
    textarea.name = `statement-${index}`;
    textarea.maxLength = 8192;
    textarea.required = true;
    textarea.value = unit.atlas_text;
    label.append(textarea);
    form.append(label);
    return textarea;
  });
  const actions = node("div", "editor-actions");
  const save = node("button", "primary", "Save all and keep");
  save.type = "submit";
  const cancel = node("button", "", "Cancel");
  cancel.type = "button";
  cancel.dataset.cancelEdit = item.candidate_id;
  actions.append(save, cancel);
  form.append(actions);
  form.onsubmit = (event) => {
    event.preventDefault();
    decide(item.candidate_id, "keep", fields.map((field) => field.value));
  };
  return form;
}

function card(item) {
  const article = node("article", "review-card");
  article.dataset.candidate = item.candidate_id;
  const header = node("header", "card-header");
  if (state.tab === "owner_review" || state.tab === "research") {
    const select = node("input", "card-select");
    select.type = "checkbox";
    select.checked = state.selected.has(item.candidate_id);
    select.ariaLabel = `Select ${item.headline}`;
    select.onchange = () => {
      if (select.checked && state.selected.size < 100) state.selected.add(item.candidate_id);
      else state.selected.delete(item.candidate_id);
      renderBulk();
    };
    header.append(select);
  }
  const title = node("div", "card-title");
  title.append(node("p", "state-label", humanState(item.resolution_state)), node("h2", "", item.headline));
  header.append(title);
  article.append(header);
  const lanes = node("div", "lanes");
  const mappingLines = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  mappingLines.classList.add("mapping-lines");
  mappingLines.setAttribute("aria-hidden", "true");
  lanes.append(sourcePanel(item), proposalPanel(item), decisionPanel(item));
  lanes.append(mappingLines);
  article.append(lanes);
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
    button.onclick = () => decide(item.candidate_id, "research", undefined, [button.dataset.researchUnit]);
  });
  article.querySelector("[data-cancel-edit]")?.addEventListener("click", () => {
    state.editing = null;
    render();
  });
  bindMappingHighlights(article);
  requestAnimationFrame(() => drawMappingLines(article));
  return article;
}

function bindMappingHighlights(article) {
  article.querySelectorAll("[data-source-index], [data-destination-index], [data-graph-index]").forEach((element) => {
    const index = element.dataset.sourceIndex ?? element.dataset.destinationIndex ?? element.dataset.graphIndex;
    const activate = () => setMappingActive(article, index, true);
    const deactivate = () => setMappingActive(article, index, false);
    element.addEventListener("mouseenter", activate);
    element.addEventListener("mouseleave", deactivate);
    element.addEventListener("focus", activate);
    element.addEventListener("blur", deactivate);
  });
}

function setMappingActive(article, index, active) {
  article.querySelectorAll(`[data-source-index="${index}"], [data-destination-index="${index}"], [data-graph-index="${index}"], [data-mapping-index="${index}"]`)
    .forEach((element) => element.classList.toggle("mapping-active", active));
}

function drawMappingLines(article) {
  if (!article.isConnected) return;
  const lanes = article.querySelector(".lanes");
  const svg = article.querySelector(".mapping-lines");
  if (!lanes || !svg) return;
  const frame = lanes.getBoundingClientRect();
  svg.setAttribute("viewBox", `0 0 ${frame.width} ${frame.height}`);
  svg.replaceChildren();
  article.querySelectorAll("[data-source-index]").forEach((source) => {
    const index = source.dataset.sourceIndex;
    const destination = article.querySelector(`[data-destination-index="${index}"]`);
    if (!destination) return;
    const from = source.getBoundingClientRect();
    const to = destination.getBoundingClientRect();
    const x1 = from.right - frame.left;
    const y1 = from.top + from.height / 2 - frame.top;
    const x2 = to.left - frame.left;
    const y2 = to.top + to.height / 2 - frame.top;
    const bend = Math.max(24, (x2 - x1) / 2);
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`);
    path.dataset.mappingIndex = index;
    svg.append(path);
  });
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
  const shown = items.length;
  const label = { owner_review: "items need your judgment", research: "items may benefit from research", deferred: "items are set aside", automatic: "items are complete" }[state.tab];
  summary.replaceChildren(
    node("strong", "", total.toLocaleString()),
    node("span", "", label),
    ...(state.query ? [node("small", "", `${shown.toLocaleString()} match your search`)] : [])
  );
}

function renderBulk() {
  const actionable = state.tab === "owner_review" || state.tab === "research";
  bulk.hidden = !actionable;
  selectionCount.textContent = `${state.selected.size} selected`;
  const visible = visibleItems();
  selectPage.checked = visible.length > 0 && visible.every((item) => state.selected.has(item.candidate_id));
  selectPage.indeterminate = visible.some((item) => state.selected.has(item.candidate_id)) && !selectPage.checked;
  bulk.querySelector('[data-bulk-action="research"]').hidden = false;
  bulk.querySelectorAll("button").forEach((button) => button.disabled = state.busy || state.selected.size === 0);
  const selectedItems = [...state.queue.owner_review, ...state.queue.research].filter((item) => state.selected.has(item.candidate_id));
  const unsafeKeep = selectedItems.some((item) => !item.source_accounting.exact_source_preserved || item.source_accounting.meaningful_units.length === 0);
  const keepButton = bulk.querySelector('[data-bulk-action="keep"]');
  keepButton.disabled = keepButton.disabled || unsafeKeep;
  keepButton.title = unsafeKeep ? "One or more selected sources do not yet have complete extraction coverage." : "";
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
  root.replaceChildren(...(visible.length
    ? visible.map(card)
    : [node("div", "empty-state", state.query ? "No items match this search." : "Nothing needs attention in this queue.")]));
  renderBulk();
  requestAnimationFrame(() => root.querySelectorAll(".review-card").forEach(drawMappingLines));
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
  status.textContent = message || "Ready. Every decision is written atomically to your local Atlas.";
  render();
}

async function decide(candidate, action, statements, unitIds) {
  if (state.busy) return;
  state.busy = true;
  status.textContent = "Saving your decision…";
  renderBulk();
  try {
    const response = await fetch(`/api/review/${candidate}/decision`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, ...(statements ? { statements } : {}), ...(unitIds ? { unit_ids: unitIds } : {}) })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.reason || "decision-not-saved");
    state.editing = null;
    state.selected.delete(candidate);
    await load(action === "keep" ? "All meaningful data was kept in Atlas." : action === "research" ? "Research request queued for Codex." : "Set aside for later.");
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
  const verb = action === "keep" ? `Keep ${meaningfulCount} meaningful data items from ${candidates.length} selected sources` : action === "research" ? `Move ${candidates.length} selected items to research` : `Set aside ${candidates.length} selected items`;
  const consequence = action === "keep" && excludedCount ? ` ${excludedCount} editorial comment${excludedCount === 1 ? "" : "s"} will remain only in encrypted source evidence.` : "";
  if (!confirm(`${verb}?${consequence}`)) return;
  state.busy = true;
  status.textContent = `Saving ${candidates.length} decisions atomically…`;
  renderBulk();
  try {
    const response = await fetch("/api/review/bulk/decision", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ candidate_ids: candidates, action })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.reason || "bulk-decision-not-saved");
    state.selected.clear();
    await load(`Saved ${candidates.length} decisions.`);
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
    state.selected.clear();
    search.value = "";
    render();
  };
});

search.oninput = () => {
  state.query = search.value;
  state.page = 1;
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
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
};

nextPage.onclick = () => {
  state.page += 1;
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
};

window.addEventListener("resize", () => root.querySelectorAll(".review-card").forEach(drawMappingLines));

load();
