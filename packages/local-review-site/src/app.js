const state = { tab: "owner_review", queue: null, selected: new Set() };
const status = document.querySelector("#status");
const root = document.querySelector("#queue");

async function load() {
  const response = await fetch("/api/review-queue", { credentials: "same-origin" });
  if (!response.ok) {
    status.textContent = "Your local review session is unavailable. Restart Atlas Review and try again.";
    return;
  }
  state.queue = await response.json();
  const candidates = new Set(state.queue.owner_review.map((item) => item.candidate_id));
  state.selected = new Set([...state.selected].filter((candidate) => candidates.has(candidate)));
  status.textContent = "Showing Atlas-native review data. Nothing is stored in this browser.";
  render();
}

function render() {
  const items = state.queue?.[state.tab] || [];
  const bulk = state.tab === "owner_review" ? `<section class="bulk"><strong>${state.selected.size} selected</strong><button id="apply-bulk" ${state.selected.size ? "" : "disabled"}>Submit selected atomic decisions</button></section>` : "";
  root.innerHTML = `${bulk}${items.length ? items.map((item) => card(item)).join("") : '<p class="empty">No items in this view.</p>'}`;
  root.querySelectorAll("[data-select]").forEach((element) => {
    element.checked = state.selected.has(element.dataset.select);
    element.onchange = () => {
      if (element.checked) state.selected.add(element.dataset.select);
      else state.selected.delete(element.dataset.select);
      render();
    };
  });
  root.querySelectorAll(".apply").forEach((button) => button.onclick = () => applyOne(button.dataset.candidate));
  const bulkButton = root.querySelector("#apply-bulk");
  if (bulkButton) bulkButton.onclick = applyBulk;
  root.querySelectorAll("article").forEach((article, index) => appendDetails(article, items[index]));
}

function card(item) {
  const select = state.tab === "owner_review" ? `<label><input type="checkbox" data-select="${item.candidate_id}"> Select for bulk decision</label>` : "";
  const submit = state.tab === "owner_review" ? `<button class="apply" data-candidate="${item.candidate_id}">Submit complete atomic decision</button>` : "";
  return `<article><header><small>${item.resolution_state}</small><h2>${item.candidate_id}</h2></header>${select}<dl><div><dt>Proposed Atlas records</dt><dd>${item.proposed_object_ids.join(", ") || "None"}</dd></div><div><dt>Evidence</dt><dd>${item.evidence_ids.join(", ") || "No linked evidence"}</dd></div><div><dt>Parity</dt><dd>${item.parity_ids.join(", ") || "No parity record"}</dd></div><div><dt>Dependencies</dt><dd>${item.missing_references.join(", ") || "Complete"}</dd></div><div><dt>Original and nearby context</dt><dd>${item.context_unavailable ? "No canonical migration context is linked." : `${item.source_context.length} encrypted local context excerpt(s)`}</dd></div></dl>${submit}</article>`;
}

function appendDetails(article, item) {
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  const pre = document.createElement("pre");
  summary.textContent = "Original and nearby context, proposal, and evidence";
  pre.textContent = JSON.stringify({ source_context: item.source_context, proposed: item.proposed_records, evidence: item.evidence, parity: item.parity_records }, null, 2);
  details.append(summary, pre);
  article.append(details);
}

async function applyOne(candidate) {
  const body = promptJson("Paste the complete precomputed resolution request JSON. Atlas will reject incomplete or invalid mutations.");
  if (!body) return;
  const response = await fetch(`/api/review/${candidate}/apply`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  status.textContent = JSON.stringify(await response.json());
  if (response.ok) load();
}

async function applyBulk() {
  const selected = [...state.selected].sort();
  const preview = selected.map((candidate) => {
    const item = state.queue.owner_review.find((candidateItem) => candidateItem.candidate_id === candidate);
    return { candidate_id: candidate, proposed_object_ids: item?.proposed_object_ids ?? [] };
  });
  const body = promptJson(`Review exact effects, then paste the complete precomputed batch request JSON.\n\n${JSON.stringify(preview, null, 2)}`);
  if (!body) return;
  const submitted = Array.isArray(body.resolutions) ? body.resolutions.map((resolution) => resolution?.candidate_id).filter((candidate) => typeof candidate === "string").sort() : [];
  if (JSON.stringify(submitted) !== JSON.stringify(selected)) {
    status.textContent = "The batch request candidates must exactly match the selected owner-review items.";
    return;
  }
  const response = await fetch("/api/review/bulk/apply", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  status.textContent = JSON.stringify(await response.json());
  if (response.ok) {
    state.selected.clear();
    load();
  }
}

function promptJson(message) {
  const raw = prompt(message);
  if (!raw) return undefined;
  try { return JSON.parse(raw); }
  catch { status.textContent = "That was not valid JSON."; return undefined; }
}

document.querySelectorAll("[data-tab]").forEach((button) => button.onclick = () => {
  state.tab = button.dataset.tab;
  document.querySelectorAll("[data-tab]").forEach((item) => item.classList.toggle("active", item === button));
  render();
});

load();
