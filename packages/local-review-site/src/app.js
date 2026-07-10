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
  if (item.recommendation === "research") {
    return "Atlas recommends more research. You can still keep this as a sourced observation without asserting it as a settled fact.";
  }
  if (item.recommendation === "owner-review") {
    return "The source is preserved, but intent cannot be determined safely without your judgment.";
  }
  return "Atlas found enough structure to preserve this without additional interpretation.";
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
  panel.append(node("p", "lane-label", "Source"));
  if (item.source_context.length === 0) {
    panel.append(node("p", "empty-copy", "No surrounding source excerpt is linked."));
    return panel;
  }
  item.source_context.slice(0, 3).forEach((evidence) => {
    const quote = node("blockquote", "source-quote", evidence.excerpt || "Encrypted source snapshot available locally.");
    panel.append(quote);
    const source = node("p", "source-meta");
    source.append(node("span", "", evidence.source_kind.replaceAll("-", " ")));
    if (evidence.publisher) source.append(node("span", "", evidence.publisher));
    panel.append(source);
  });
  if (item.source_context.length > 3) panel.append(node("p", "more-context", `+${item.source_context.length - 3} more source excerpts`));
  return panel;
}

function proposalPanel(item) {
  const panel = node("section", "lane proposal-lane");
  panel.append(node("p", "lane-label", "Atlas proposal"));
  panel.append(node("p", "proposal-kind", item.proposal_label));
  const records = item.proposed_records.length ? item.proposed_records : [];
  if (!records.length) panel.append(node("p", "empty-copy", "No complete Atlas proposal is linked."));
  records.slice(0, 4).forEach((record) => panel.append(node("p", "proposal-copy", recordText(record, item.headline))));
  if (item.missing_references.length) panel.append(node("p", "warning", `${item.missing_references.length} linked record(s) are unavailable.`));
  else panel.append(node("p", "complete", "Source coverage is represented."));
  return panel;
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
    panel.append(node("p", "resolved-copy", state.tab === "automatic" ? "This item has been kept in Atlas." : "This item is set aside and remains fully preserved."));
    return panel;
  }
  const actions = node("div", "decision-actions");
  actions.append(actionButton("Keep in Atlas", "keep", "primary"));
  if (item.proposed_records.some((record) => record.schema === "atlas.observation:v1")) actions.append(actionButton("Edit & keep", "edit"));
  if (state.tab === "owner_review") actions.append(actionButton("Needs research", "research"));
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
  const observation = item.proposed_records.find((record) => record.schema === "atlas.observation:v1");
  const form = node("form", "editor");
  const label = node("label", "", "Edit the Atlas observation");
  const textarea = node("textarea", "");
  textarea.name = "statement";
  textarea.maxLength = 4096;
  textarea.required = true;
  textarea.value = observation ? recordText(observation, item.headline) : item.headline;
  label.append(textarea);
  const actions = node("div", "editor-actions");
  const save = node("button", "primary", "Save and keep");
  save.type = "submit";
  const cancel = node("button", "", "Cancel");
  cancel.type = "button";
  cancel.dataset.cancelEdit = item.candidate_id;
  actions.append(save, cancel);
  form.append(label, actions);
  form.onsubmit = (event) => {
    event.preventDefault();
    decide(item.candidate_id, "keep", textarea.value);
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
  lanes.append(sourcePanel(item), proposalPanel(item), decisionPanel(item));
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
  article.querySelector("[data-cancel-edit]")?.addEventListener("click", () => {
    state.editing = null;
    render();
  });
  return article;
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
  bulk.querySelector('[data-bulk-action="research"]').hidden = state.tab !== "owner_review";
  bulk.querySelectorAll("button").forEach((button) => button.disabled = state.busy || state.selected.size === 0);
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

async function decide(candidate, action, statement) {
  if (state.busy) return;
  state.busy = true;
  status.textContent = "Saving your decision…";
  renderBulk();
  try {
    const response = await fetch(`/api/review/${candidate}/decision`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, ...(statement ? { statement } : {}) })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.reason || "decision-not-saved");
    state.editing = null;
    state.selected.delete(candidate);
    await load(action === "keep" ? "Kept in Atlas." : action === "research" ? "Moved to research." : "Set aside for later.");
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
  const verb = action === "keep" ? "keep in Atlas" : action === "research" ? "move to research" : "set aside";
  if (!confirm(`${verb[0].toUpperCase() + verb.slice(1)} ${candidates.length} selected item(s)?`)) return;
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

load();
