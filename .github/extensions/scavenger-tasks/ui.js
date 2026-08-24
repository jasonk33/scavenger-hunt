/**
 * Task renderer. Talks to the extension over plain HTTP on the same origin:
 * GET /api/tasks, PATCH /api/task/:slug, PATCH /api/model, and an SSE stream at
 * /events. The Roster tab is rendered by roster.js and shares that stream.
 *
 * Every edit here is LIVE. These rows are the `tasks` table the app itself
 * reads, so moving a slider, retitling a task or cutting one is in front of
 * players on their next poll. There is no draft and no publish step; there used
 * to be, and supabase/migrate-tasks-one-table.sql says why there is not.
 *
 * The table is one any session can write, so the page POLLS /api/tasks. The
 * stream only reaches panels served by the same extension process -- one per
 * session -- so it is same-process immediacy, not the mechanism. See "Staying
 * current" at the bottom.
 */

import { scoreOf as rawScore, tierAdvice } from "/tier.mjs";

const RATINGS = [
  ["difficulty", "Difficulty", "How hard the thing is to actually pull off"],
  ["guts", "Guts", "Social courage required to start it"],
  ["luck", "Luck", "Dependence on finding the right target or opportunity"],
  ["payoff", "Payoff", "How funny or good the resulting photo is"],
  ["risk", "Risk", "Chance of real trouble: thrown out, ticketed, someone upset"],
];

const ROUND_LABELS = { 1: "Round 1 · Madison Square Park", 2: "Round 2 · NoMad & Flatiron", 0: "Secret challenges" };
/** Secret challenges are round 0 but the doc lists them last, so rank rather than sort numerically. */
const ROUND_RANK = { 1: 0, 2: 1, 0: 2 };

const el = {
  list: document.getElementById("list"),
  stats: document.getElementById("stats"),
  tasksTab: document.getElementById("tasks-tab"),
  rosterTab: document.getElementById("roster-tab"),
  tasksTools: document.getElementById("tasks-tools"),
  rosterView: document.getElementById("roster-view"),
  balance: document.getElementById("balance"),
  search: document.getElementById("search"),
  sort: document.getElementById("sort"),
  onlyFlagged: document.getElementById("only-flagged"),
  newTask: document.getElementById("new-task"),
  newTaskRound: document.getElementById("new-task-round"),
  newTaskPoints: document.getElementById("new-task-points"),
  addTaskButton: document.getElementById("add-task-button"),
  taskError: document.getElementById("task-error"),
};

const filters = { round: "all", shown: "live", q: "", sort: "doc", flagged: false };

function setView(view) {
  const roster = view === "roster";
  el.tasksTools.hidden = roster;
  el.list.hidden = roster;
  el.rosterView.hidden = !roster;
  el.stats.hidden = roster;
  el.tasksTab.classList.toggle("on", !roster);
  el.rosterTab.classList.toggle("on", roster);
  el.tasksTab.setAttribute("aria-selected", String(!roster));
  el.rosterTab.setAttribute("aria-selected", String(roster));
}

el.tasksTab.addEventListener("click", () => setView("tasks"));
el.rosterTab.addEventListener("click", () => setView("roster"));
setView("tasks");

let data = { tasks: [], model: { weights: {}, thresholds: {} } };
/**
 * Whether a task list has ever actually arrived, and why the last attempt did
 * not. The empty list above is a placeholder, not a result: without these two
 * the page would say "Nothing matches those filters" about a list it never read.
 */
let loaded = false;
let loadError = null;
/** Rows currently rendered, so an update can patch in place instead of rebuilding. */
const rows = new Map();
/** slug -> { patch, timer } for edits still waiting to be sent. */
const pending = new Map();

// ── Model ────────────────────────────────────────────────────────────────────

const scoreOf = (t) => rawScore(t, data.model.weights);

/** The single rule for "does this task disagree with its ratings". */
const advice = (t) => tierAdvice(t, data.model);

// ── Persistence ──────────────────────────────────────────────────────────────

/**
 * Coalesces rapid edits (slider drags, typing) into one request per task, and
 * applies the patch locally first so the UI never waits on the round trip.
 * The timer is held alongside the patch rather than inside it, so what gets
 * sent is exactly the patch and nothing has to be stripped back out.
 *
 * The 250ms is a write-rate limit, not a staging step: the request that follows
 * writes the table players read.
 */
function save(task, patch) {
  Object.assign(task, patch);
  const queued = pending.get(task.slug) ?? { patch: {}, timer: 0 };
  Object.assign(queued.patch, patch);
  pending.set(task.slug, queued);
  clearTimeout(queued.timer);
  queued.timer = setTimeout(async () => {
    const body = pending.get(task.slug)?.patch ?? {};
    pending.delete(task.slug);
    await fetch(`/api/task/${task.slug}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => {});
  }, 250);
}

async function saveModel() {
  await fetch("/api/model", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data.model),
  }).catch(() => {});
}

// ── Filtering and sorting ────────────────────────────────────────────────────

function visibleTasks() {
  const q = filters.q.toLowerCase();
  const list = data.tasks.filter((t) => {
    if (filters.round !== "all" && t.round !== Number(filters.round)) return false;
    // "Live" is everything players can see. A cut task is a decision already
    // made, so it stops taking up room in the list you are working through --
    // the Cut tab is where it lives, and is the way back.
    if (filters.shown === "live" && !t.active) return false;
    if (filters.shown === "cut" && t.active) return false;
    if (filters.flagged && !t.rewrite) return false;
    if (q && !`${t.title} ${t.note}`.toLowerCase().includes(q)) return false;
    return true;
  });

  const by = {
    doc: (a, b) => ROUND_RANK[a.round] - ROUND_RANK[b.round] || a.points - b.points || a.docOrder - b.docOrder,
    score: (a, b) => scoreOf(b) - scoreOf(a),
    // Dismissed tiers sort as agreeing, so the sort matches the header count.
    mismatch: (a, b) =>
      (advice(b).show ? Math.abs(b.points - advice(b).suggested) : 0) -
      (advice(a).show ? Math.abs(a.points - advice(a).suggested) : 0) || scoreOf(b) - scoreOf(a),
    payoff: (a, b) => a.payoff - b.payoff || b.risk - a.risk,
    risk: (a, b) => b.risk - a.risk || a.payoff - b.payoff,
    luck: (a, b) => b.luck - a.luck,
  };
  return list.sort(by[filters.sort] ?? by.doc);
}

// ── Row rendering ────────────────────────────────────────────────────────────

function chipsFor(task) {
  const chips = [];
  if (task.scoringMode === "quantity") chips.push(["per measure", ""]);
  if (task.scoringMode === "competition") chips.push(["competition", "warn"]);
  if (task.requiresVideo) chips.push(["clip", ""]);
  if (task.prop) chips.push(["prop", ""]);
  if (task.luck >= 4) chips.push(["luck", "warn"]);
  if (task.risk >= 4) chips.push(["risk", "alert"]);
  if (task.payoff <= 2) chips.push(["flat", "warn"]);
  if (task.rewrite) chips.push(["rewrite", "warn"]);
  return chips;
}

function paint(row, task) {
  const { suggested, show } = advice(task);

  row.classList.toggle("is-cut", !task.active);

  const tier = row.querySelector(".tier:not(.suggested)");
  tier.textContent = task.points;
  tier.className = `tier t${task.points}`;

  const sug = row.querySelector(".tier.suggested");
  const arrow = row.querySelector(".arrow");
  const dismiss = row.querySelector(".tier-dismiss");
  sug.hidden = !show;
  arrow.hidden = !show;
  dismiss.hidden = !show;
  if (show) {
    sug.textContent = suggested;
    sug.className = `tier suggested t${suggested}`;
    sug.title =
      `Suggestion, not a pending change: this task is ${task.points}pt, ` +
      `but its ratings score ${scoreOf(task).toFixed(1)}, which lands in the ${suggested}pt tier. ` +
      `Click to move it to ${suggested}pt.`;
    dismiss.title =
      `Keep this task at ${task.points}pt and stop suggesting ${suggested}pt. ` +
      `If you re-rate it into a different tier the suggestion comes back.`;
  }

  const title = row.querySelector(".title");
  if (document.activeElement !== title && title.textContent !== task.title) title.textContent = task.title;

  row.querySelector(".chips").replaceChildren(
    ...chipsFor(task).map(([label, kind]) => {
      const span = document.createElement("span");
      span.className = `chip ${kind}`.trim();
      span.textContent = label;
      return span;
    })
  );

  for (const b of row.querySelectorAll(".shown button")) {
    b.classList.toggle("on", (b.dataset.active === "true") === Boolean(task.active));
  }

  for (const [key] of RATINGS) {
    const slider = row.querySelector(`.slider.${key}`);
    if (!slider) continue;
    const input = slider.querySelector("input");
    if (document.activeElement !== input) input.value = task[key];
    slider.querySelector(".val").textContent = task[key];
  }

  const points = row.querySelector(".points");
  if (document.activeElement !== points) points.value = String(task.points);

  const mode = row.querySelector(".scoring-mode");
  if (document.activeElement !== mode) mode.value = task.scoringMode || "fixed";
  for (const [selector, key] of [
    [".measurement-label", "measurementLabel"],
    [".points-per-unit", "pointsPerUnit"],
    [".competition-bonus", "competitionBonus"],
  ]) {
    const input = row.querySelector(selector);
    if (!input || document.activeElement === input) continue;
    input.value = task[key] === null || task[key] === undefined ? "" : String(task[key]);
  }

  const prop = row.querySelector(".prop");
  if (document.activeElement !== prop) prop.value = task.prop;

  const note = row.querySelector(".note");
  if (document.activeElement !== note) note.value = task.note;

  row.querySelector(".clip").checked = task.requiresVideo;
  row.querySelector(".rewrite").checked = task.rewrite;

  const docTitle = row.querySelector(".doc-title");
  const changed = task.docTitle && task.docTitle !== task.title;
  docTitle.hidden = !changed;
  if (changed) docTitle.textContent = `Doc wording: ${task.docTitle}`;
}

function buildRow(task) {
  const row = document.getElementById("row-tpl").content.firstElementChild.cloneNode(true);
  row.dataset.slug = task.slug;

  const sliders = row.querySelector(".sliders");
  for (const [key, label, hint] of RATINGS) {
    const wrap = document.createElement("label");
    wrap.className = `slider ${key}`;
    wrap.title = hint;
    wrap.innerHTML = `<span>${label}</span><input type="range" min="1" max="5" step="1" /><span class="val"></span>`;
    const input = wrap.querySelector("input");
    input.addEventListener("input", () => {
      save(task, { [key]: Number(input.value) });
      paint(row, task);
      renderSummary();
    });
    sliders.append(wrap);
  }

  row.querySelector(".caret").addEventListener("click", () => {
    row.classList.toggle("open");
    row.querySelector(".body").hidden = !row.classList.contains("open");
  });

  // Accept: take the suggested tier. Clearing tierOk matters -- a tier the user
  // has just agreed to is not a tier they have rejected, and leaving a stale
  // rejection behind would silence the next genuine disagreement.
  const acceptTier = () => {
    const { suggested, show } = advice(task);
    if (!show) return;
    save(task, { points: suggested, tierOk: null });
    paint(row, task);
    renderSummary();
  };
  const sug = row.querySelector(".tier.suggested");
  sug.addEventListener("click", acceptTier);
  sug.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); acceptTier(); }
  });

  // Dismiss: record which suggestion was rejected, so re-rating into a
  // different tier resurfaces it. See tier.mjs.
  row.querySelector(".tier-dismiss").addEventListener("click", () => {
    const { suggested, show } = advice(task);
    if (!show) return;
    save(task, { tierOk: suggested });
    paint(row, task);
    renderSummary();
  });

  const title = row.querySelector(".title");
  title.addEventListener("blur", () => {
    const next = title.textContent.trim();
    if (!next) return void (title.textContent = task.title);
    if (next !== task.title) save(task, { title: next });
    paint(row, task);
  });
  title.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); title.blur(); }
    if (e.key === "Escape") { title.textContent = task.title; title.blur(); }
  });

  // Cut hides a task from players immediately. It is never a delete -- that
  // would cascade to submissions -- so anything already scored on it stands,
  // and turning it back on puts it straight back in the list.
  row.querySelector(".shown").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    save(task, { active: btn.dataset.active === "true" });
    paint(row, task);
    renderSummary();
    // The row may no longer belong in the current filter.
    if (filters.shown !== "all") renderList();
  });

  const points = row.querySelector(".points");
  points.addEventListener("change", () => {
    save(task, { points: Number(points.value) });
    paint(row, task);
    renderSummary();
  });

  const mode = row.querySelector(".scoring-mode");
  mode.addEventListener("change", () => {
    save(task, { scoringMode: mode.value });
    paint(row, task);
    renderSummary();
  });

  for (const [selector, key, read] of [
    [".measurement-label", "measurementLabel", (node) => node.value.trim()],
    [".points-per-unit", "pointsPerUnit", (node) => Number(node.value)],
    [".competition-bonus", "competitionBonus", (node) => Number(node.value)],
  ]) {
    const input = row.querySelector(selector);
    input.addEventListener("change", () => {
      const value = read(input);
      if (value === null || Number.isInteger(value) && value >= 0 || typeof value === "string") {
        save(task, { [key]: value });
        paint(row, task);
        renderSummary();
      }
    });
  }

  for (const [sel, key, read] of [
    [".prop", "prop", (n) => n.value],
    [".note", "note", (n) => n.value],
    [".clip", "requiresVideo", (n) => n.checked],
    [".rewrite", "rewrite", (n) => n.checked],
  ]) {
    const node = row.querySelector(sel);
    node.addEventListener(node.type === "checkbox" ? "change" : "input", () => {
      save(task, { [key]: read(node) });
      paint(row, task);
      renderSummary();
    });
  }

  paint(row, task);
  return row;
}

function renderList() {
  const tasks = visibleTasks();
  rows.clear();
  el.list.replaceChildren();

  if (!loaded) {
    // Never "Nothing matches those filters" for a list that has not arrived.
    // A screen claiming a result it does not have is the bug class that has
    // produced most of the serious bugs in this app, and an unreachable list
    // and an empty one look identical unless this says which it is.
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = loadError ? `The task list could not be read. ${loadError}` : "Loading the task list\u2026";
    el.list.replaceChildren(p);
    return;
  }

  if (!tasks.length) {
    el.list.innerHTML = `<p class="empty">Nothing matches those filters.</p>`;
    return;
  }

  let lastGroup = null;
  for (const task of tasks) {
    const group = filters.sort === "doc" ? ROUND_LABELS[task.round] : null;
    if (group && group !== lastGroup) {
      const h = document.createElement("h2");
      h.className = "group";
      h.textContent = group;
      el.list.append(h);
      lastGroup = group;
    }
    const row = buildRow(task);
    rows.set(task.slug, row);
    el.list.append(row);
  }
}

// ── Summary and balance ──────────────────────────────────────────────────────

function renderSummary() {
  const live = data.tasks.filter((t) => t.active);
  const mismatched = live.filter((t) => advice(t).show).length;
  const flagged = data.tasks.filter((t) => t.rewrite).length;
  el.stats.innerHTML =
    `<b>${live.length}</b> live · <b>${data.tasks.length - live.length}</b> cut · ` +
    `<b>${mismatched}</b> tier disagreements` +
    (flagged ? ` · <b>${flagged}</b> flagged` : "");
  // What is on screen was real when it was fetched, so it is not withdrawn. But
  // any session can edit these rows, so a page that has stopped refreshing must
  // not be indistinguishable from a current one. Appended as text, matching how
  // every other untrusted string in here is rendered.
  if (loaded && loadError) {
    const note = document.createElement("span");
    note.className = "stale";
    note.textContent = ` · not refreshing — ${loadError}`;
    el.stats.append(note);
  }
  if (!el.balance.hidden) renderBalance();
}

function renderBalance() {
  const tiers = [1, 3, 5, 10];
  const rowsHtml = [1, 2, 0]
    .map((round) => {
      const inRound = data.tasks.filter((t) => t.round === round && t.active);
      if (!inRound.length) return "";
      const cells = round === 0
        ? `<td colspan="4">${inRound.length} @ 7</td>`
        : tiers.map((tier) => `<td>${inRound.filter((t) => t.points === tier).length}</td>`).join("");
      const avg = (inRound.reduce((s, t) => s + t.payoff, 0) / inRound.length).toFixed(1);
      return `<tr>
        <td>${round === 0 ? "Secret" : `R${round}`}</td>
        ${cells}
        <td>${inRound.reduce((s, t) => s + t.points, 0)}</td>
        <td>${avg}</td>
        <td>${inRound.filter((t) => t.risk >= 4).length}</td>
        <td>${inRound.filter((t) => t.luck >= 4).length}</td>
        <td>${inRound.filter((t) => t.prop).length}</td>
      </tr>`;
    })
    .join("");

  const w = data.model.weights;
  const th = data.model.thresholds;
  el.balance.innerHTML = `
    <table>
      <thead><tr>
        <th></th><th>1</th><th>3</th><th>5</th><th>10</th>
        <th>Max</th><th title="Average payoff rating">Pay</th>
        <th title="Tasks rated 4+ on risk">Risk</th>
        <th title="Tasks rated 4+ on luck">Luck</th>
        <th title="Tasks needing a prop">Prop</th>
      </tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
    <div class="model">
      <span>Weights</span>
      ${["difficulty", "guts", "luck"].map((k) => `<label>${k.slice(0, 4)}<input type="number" step="0.1" min="0" data-weight="${k}" value="${w[k]}" /></label>`).join("")}
      <span>Tier caps</span>
      ${["t1", "t3", "t5"].map((k) => `<label>&le;${k.slice(1)}<input type="number" step="0.1" min="0" data-threshold="${k}" value="${th[k]}" /></label>`).join("")}
    </div>`;

  for (const input of el.balance.querySelectorAll("input")) {
    input.addEventListener("change", () => {
      const value = Number(input.value);
      if (!Number.isFinite(value)) return;
      if (input.dataset.weight) data.model.weights[input.dataset.weight] = value;
      else data.model.thresholds[input.dataset.threshold] = value;
      saveModel();
      for (const [slug, row] of rows) {
        const task = data.tasks.find((t) => t.slug === slug);
        if (task) paint(row, task);
      }
      renderSummary();
    });
  }
}

// ── Wiring ───────────────────────────────────────────────────────────────────

for (const [id, key] of [["round-filter", "round"], ["shown-filter", "shown"]]) {
  document.getElementById(id).addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    for (const b of btn.parentElement.children) b.classList.toggle("on", b === btn);
    filters[key] = btn.dataset[key];
    renderList();
  });
}

el.sort.addEventListener("change", () => { filters.sort = el.sort.value; renderList(); });
el.onlyFlagged.addEventListener("change", () => { filters.flagged = el.onlyFlagged.checked; renderList(); });

let searchTimer;
el.search.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { filters.q = el.search.value.trim(); renderList(); }, 120);
});

document.getElementById("toggle-balance").addEventListener("click", (e) => {
  el.balance.hidden = !el.balance.hidden;
  e.currentTarget.classList.toggle("on", !el.balance.hidden);
  if (!el.balance.hidden) renderBalance();
});

// ── Adding a task ────────────────────────────────────────────────────────────
//
// It is live the moment it lands, so it goes in at 3 points and whatever wording
// was typed, and everything else is edited on the row afterwards. A ratings form
// up here would be a second, worse copy of the row that already exists.

let adding = false;

function syncAddButton() {
  el.addTaskButton.disabled = adding || !el.newTask.value.trim();
  el.addTaskButton.textContent = adding ? "Adding\u2026" : "Add";
}

/**
 * Puts the filters where the new task is actually visible.
 *
 * Adding a Round 2 task while filtered to Round 1 would otherwise look like it
 * did nothing -- a control whose result is hidden by state the user forgot is
 * set. Adding is rare and deliberate, so overriding the filters is the lesser
 * surprise, and the controls are moved to match rather than silently ignored.
 */
function revealTask(task) {
  filters.round = String(task.round);
  filters.shown = "live";
  filters.flagged = false;
  filters.q = "";
  el.onlyFlagged.checked = false;
  el.search.value = "";
  for (const [id, key] of [["round-filter", "round"], ["shown-filter", "shown"]]) {
    for (const b of document.getElementById(id).children) {
      b.classList.toggle("on", b.dataset[key] === filters[key]);
    }
  }
  renderList();
  rows.get(task.slug)?.scrollIntoView({ block: "center" });
}

async function addTask() {
  const title = el.newTask.value.trim();
  if (!title || adding) return;
  adding = true;
  el.taskError.hidden = true;
  syncAddButton();
  try {
    const res = await fetch("/api/task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        round: Number(el.newTaskRound.value),
        points: Number(el.newTaskPoints.value),
      }),
    });
    const task = await res.json().catch(() => null);
    // A body that is not a task is a failure however it arrived. Clearing the
    // box on one would throw away what was typed for a task that does not exist.
    if (!res.ok || !task?.slug) throw new Error(task?.error || `the task was not added (HTTP ${res.status})`);
    el.newTask.value = "";
    // Re-read rather than splicing the response in: the poll is the thing that
    // decides what is on screen, and a task added in another session has to
    // arrive the same way this one does.
    await refreshTasks();
    revealTask(task);
  } catch (e) {
    el.taskError.textContent = String(e?.message ?? e);
    el.taskError.hidden = false;
  } finally {
    adding = false;
    syncAddButton();
  }
}

el.newTask.addEventListener("input", syncAddButton);
el.newTask.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); addTask(); }
});
el.addTaskButton.addEventListener("click", addTask);
syncAddButton();

/** Pushes and poll results both arrive here. Rebuild only if the task set changed. */
function applyTasks(next) {
  const sameTasks =
    next.tasks.length === data.tasks.length &&
    next.tasks.every((t, i) => t.slug === data.tasks[i]?.slug);
  data.model = next.model;

  if (!sameTasks || !rows.size) {
    data.tasks = next.tasks;
    renderList();
  } else {
    // Merge in place rather than swapping the array: every row's event handlers
    // closed over its task object, so replacing them would leave the DOM wired
    // to objects nothing else reads.
    next.tasks.forEach((incoming, i) => Object.assign(data.tasks[i], incoming));
    for (const [slug, row] of rows) {
      const task = data.tasks.find((t) => t.slug === slug);
      if (task) paint(row, task);
    }
  }
  renderSummary();
}

// ── Staying current ──────────────────────────────────────────────────────────
//
// These rows are a table any session can write -- and so can Admin, on a phone,
// mid-event -- so freshness is a requirement rather than an edge case.
// `/events` is served by THIS extension process and each session forks its own,
// so an edit made in another session's canvas can never arrive over the stream;
// it is same-process immediacy and nothing more. The poll is what makes this
// correct, which matches the rest of the app: it polls everywhere and has no
// WebSockets or Realtime anywhere.
//
// Deliberately no entry animation or crossfade on the list. A polled list
// retriggers one on every tick, which is why there are none anywhere in the app.

const POLL_MS = 8000;
let pollTimer = 0;

async function fetchTasks() {
  const res = await fetch("/api/tasks");
  const body = await res.json().catch(() => null);
  // A body that is not a task list is a failure however it arrived. Rendering
  // it would empty the list and read as "there are no tasks".
  if (!res.ok || !body || !Array.isArray(body.tasks)) {
    throw new Error(body?.error || `the task list could not be read (HTTP ${res.status})`);
  }
  return body;
}

async function refreshTasks() {
  // An unsent edit is newer than anything the server can return, and applying
  // the poll over it would visibly undo what was just typed.
  if (pending.size) return;
  try {
    const next = await fetchTasks();
    loadError = null;
    loaded = true;
    applyTasks(next);
  } catch (e) {
    loadError = String(e?.message ?? e);
    // Before the first success there is nothing on screen to keep, so the list
    // has to say why. After one, what is there stands and renderSummary marks it.
    if (loaded) renderSummary();
    else renderList();
  }
}

function schedulePoll() {
  clearTimeout(pollTimer);
  // Pausing while hidden matches `usePoll` in the app: a backgrounded panel
  // should not keep querying, and coming back should be immediate rather than
  // up to a full interval stale.
  if (document.hidden) return;
  pollTimer = setTimeout(async () => {
    await refreshTasks();
    schedulePoll();
  }, POLL_MS);
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    clearTimeout(pollTimer);
    return;
  }
  refreshTasks().finally(schedulePoll);
});

renderList();
await refreshTasks();
schedulePoll();

const events = new EventSource("/events");
events.addEventListener("roster", (e) => {
  window.dispatchEvent(new CustomEvent("roster-update", { detail: e.data }));
});

events.addEventListener("tasks", (e) => {
  // Ignore pushes while an edit is in flight; the local copy is newer.
  if (pending.size) return;
  let next;
  try {
    next = JSON.parse(e.data);
  } catch {
    return;
  }
  if (!next || !Array.isArray(next.tasks)) return;
  loaded = true;
  loadError = null;
  applyTasks(next);
});
