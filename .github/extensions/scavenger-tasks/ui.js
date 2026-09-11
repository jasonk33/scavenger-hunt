/**
 * Task renderer. Talks to the extension over plain HTTP on the same origin:
 * GET /api/tasks, PATCH /api/task/:slug, and an SSE stream at
 * /events. The Roster tab is rendered by roster.js and shares that stream.
 *
 * Every edit here is LIVE. These rows are the `tasks` table the app itself
 * reads, so changing points, retitling a task or cutting one is in front of
 * players on their next poll. There is no draft and no publish step; there used
 * to be, and supabase/migrate-tasks-one-table.sql says why there is not.
 *
 * The table is one any session can write, so the page POLLS /api/tasks. The
 * stream only reaches panels served by the same extension process -- one per
 * session -- so it is same-process immediacy, not the mechanism. See "Staying
 * current" at the bottom.
 */

const ROUND_LABELS = { 1: "Round 1 · Madison Square Park", 2: "Round 2 · NoMad & Flatiron" };

const el = {
  list: document.getElementById("list"),
  stats: document.getElementById("stats"),
  tasksTab: document.getElementById("tasks-tab"),
  rosterTab: document.getElementById("roster-tab"),
  tasksTools: document.getElementById("tasks-tools"),
  rosterView: document.getElementById("roster-view"),
  balance: document.getElementById("balance"),
  search: document.getElementById("search"),
  onlyFlagged: document.getElementById("only-flagged"),
  newTask: document.getElementById("new-task"),
  newTaskRound: document.getElementById("new-task-round"),
  newTaskPoints: document.getElementById("new-task-points"),
  newTaskScoringMode: document.getElementById("new-task-scoring-mode"),
  newTaskDetails: document.getElementById("new-task-details"),
  newTaskMeasurementLabel: document.getElementById("new-task-measurement-label"),
  newTaskMeasurementLabelField: document.getElementById("new-task-measurement-label-field"),
  newTaskPointsPerUnit: document.getElementById("new-task-points-per-unit"),
  newTaskPointsPerUnitField: document.getElementById("new-task-points-per-unit-field"),
  newTaskProp: document.getElementById("new-task-prop"),
  newTaskNote: document.getElementById("new-task-note"),
  addTaskButton: document.getElementById("add-task-button"),
  taskError: document.getElementById("task-error"),
  saveStatus: document.getElementById("save-status"),
};

const filters = { round: "all", shown: "live", q: "", flagged: false };

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

const data = { tasks: [] };
/**
 * Whether a task list has ever actually arrived, and why the last attempt did
 * not. The empty list above is a placeholder, not a result: without these two
 * the page would say "Nothing matches those filters" about a list it never read.
 */
let loaded = false;
let loadError = null;
/** Rows keyed by slug, retained across filters so open editors survive a poll. */
const rows = new Map();
/** Unacknowledged fields, including in-flight and failed writes. */
const pending = new Map();
/** Slugs with a round change in flight. Not in `pending`: a move is not debounced. */
const moving = new Set();
/**
 * Counts local writes that have landed on screen.
 *
 * The `pending`/`moving` gates cannot catch a poll that STARTED before a write
 * and resolves after it: by then the write has finished and both sets are empty
 * again, so the poll merges a body that predates it and visibly undoes what was
 * just done. Comparing this across the await is what closes that window.
 */
let localWrites = 0;

// ── Persistence ──────────────────────────────────────────────────────────────

/**
 * Coalesces rapid edits into one request per task, and
 * applies the patch locally first so the UI never waits on the round trip.
 * The timer is held alongside the patch rather than inside it, so what gets
 * sent is exactly the patch and nothing has to be stripped back out.
 *
 * The 250ms is a write-rate limit, not a staging step: the request that follows
 * writes the table players read.
 */
function save(task, patch) {
  Object.assign(task, patch);
  queueSave(task.slug, patch);
}

const unsaved = (key) => {
  const entry = pending.get(key);
  return entry ? { ...entry.inFlight, ...entry.patch } : {};
};

function queueSave(key, patch) {
  localWrites += 1;
  const entry = pending.get(key) ?? { patch: {}, timer: 0, inFlight: null, error: null };
  entry.patch = { ...entry.patch, ...patch };
  entry.error = null;
  pending.set(key, entry);
  clearTimeout(entry.timer);
  if (!entry.inFlight) entry.timer = setTimeout(() => flushSave(key), 250);
  renderSaveStatus();
}

async function flushSave(key) {
  const entry = pending.get(key);
  if (!entry || entry.inFlight) return;
  clearTimeout(entry.timer);
  const patch = entry.patch;
  entry.patch = {};
  entry.inFlight = patch;
  entry.error = null;
  renderSaveStatus();
  try {
    const res = await fetch(`/api/task/${key}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    const body = await res.json().catch(() => null);
    const valid = body?.slug === key;
    if (!res.ok || !valid) throw new Error(body?.error || `save failed (HTTP ${res.status})`);
    localWrites += 1;
    if (!Object.keys(entry.patch).length) pending.delete(key);
  } catch (e) {
    entry.patch = { ...patch, ...entry.patch };
    entry.error = String(e?.message ?? e);
  } finally {
    entry.inFlight = null;
    renderSaveStatus();
  }
  if (pending.has(key) && !entry.error) void flushSave(key);
}

function renderSaveStatus() {
  const failed = [...pending].filter(([, entry]) => entry.error);
  el.saveStatus.hidden = !pending.size;
  el.saveStatus.replaceChildren();
  if (!pending.size) return;
  const text = document.createElement("span");
  text.textContent = failed.length
    ? `Not saved — ${failed.map(([key, entry]) => `${key}: ${entry.error}`).join("; ")}. Edits are kept here. `
    : "Saving changes\u2026";
  el.saveStatus.append(text);
  if (failed.length) {
    const retry = document.createElement("button");
    retry.className = "ghost";
    retry.textContent = "Retry saves";
    retry.addEventListener("click", () => {
      for (const [key] of failed) void flushSave(key);
    });
    el.saveStatus.append(retry);
  }
}

window.addEventListener("beforeunload", (e) => {
  if (!pending.size) return;
  e.preventDefault();
  e.returnValue = "";
});

// ── Filtering and sorting ────────────────────────────────────────────────────

function visibleTasks() {
  const q = filters.q.toLowerCase();
  const focusedSlug = document.activeElement?.closest("#list [data-slug]")?.dataset.slug;
  const list = data.tasks.filter((t) => {
    // Keep a focused draft until blur, but still sort it with its round and tier.
    if (t.slug === focusedSlug) return true;
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

  return list.sort((a, b) => a.round - b.round || a.points - b.points || a.docOrder - b.docOrder);
}

// ── Row rendering ────────────────────────────────────────────────────────────

function chipsFor(task) {
  const chips = [];
  if (task.scoringMode === "quantity") chips.push(["per item", ""]);
  if (task.prop) chips.push(["prop", ""]);
  if (task.rewrite) chips.push(["rewrite", "warn"]);
  return chips;
}

function paint(row, task) {
  row.classList.toggle("is-cut", !task.active);

  const tier = row.querySelector(".tier");
  tier.textContent = task.points;
  tier.className = `tier t${task.points}`;

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

  const busy = moving.has(task.slug);
  for (const b of row.querySelectorAll(".seg.round button[data-round]")) {
    const to = Number(b.dataset.round);
    b.disabled = busy;
    b.classList.toggle("on", to === task.round);
    b.title =
      to === task.round
        ? `Players see this task in Round ${to}.`
        : `Move to Round ${to}. It lands last in its tier there. Tasks with submissions cannot move.`;
  }

  const points = row.querySelector(".points");
  if (document.activeElement !== points) points.value = String(task.points);

  const mode = row.querySelector(".scoring-mode");
  if (document.activeElement !== mode) mode.value = task.scoringMode || "fixed";
  for (const field of row.querySelectorAll(".quantity-field")) field.hidden = task.scoringMode !== "quantity";
  for (const [selector, key] of [
    [".measurement-label", "measurementLabel"],
    [".points-per-unit", "pointsPerUnit"],
  ]) {
    const input = row.querySelector(selector);
    if (!input || document.activeElement === input) continue;
    input.value = task[key] === null || task[key] === undefined ? "" : String(task[key]);
  }

  const prop = row.querySelector(".prop");
  if (document.activeElement !== prop) prop.value = task.prop;

  const note = row.querySelector(".note");
  if (document.activeElement !== note) note.value = task.note;

  row.querySelector(".rewrite").checked = task.rewrite;

  const docTitle = row.querySelector(".doc-title");
  const changed = task.docTitle && task.docTitle !== task.title;
  docTitle.hidden = !changed;
  if (changed) docTitle.textContent = `Doc wording: ${task.docTitle}`;
}

function buildRow(task) {
  const row = document.getElementById("row-tpl").content.firstElementChild.cloneNode(true);
  row.dataset.slug = task.slug;

  row.querySelector(".caret").addEventListener("click", () => {
    row.classList.toggle("open");
    row.querySelector(".body").hidden = !row.classList.contains("open");
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

  row.querySelector(".seg.round").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-round]");
    if (btn) moveToRound(task, Number(btn.dataset.round));
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

  const desired = [];
  const headings = new Map([...el.list.querySelectorAll(".group")].map((h) => [h.textContent, h]));
  let lastGroup = null;
  for (const task of tasks) {
    const group = ROUND_LABELS[task.round];
    if (group && group !== lastGroup) {
      const h = headings.get(group) ?? document.createElement("h2");
      h.className = "group";
      h.textContent = group;
      desired.push(h);
      lastGroup = group;
    }
    const row = rows.get(task.slug) ?? buildRow(task);
    paint(row, task);
    rows.set(task.slug, row);
    desired.push(row);
  }
  const keep = new Set(desired);
  for (const node of [...el.list.children]) if (!keep.has(node)) node.remove();
  let cursor = el.list.firstChild;
  for (const node of desired) {
    if (node !== cursor) {
      // Moving a focused DOM subtree blurs its editor. Move its siblings instead.
      if (node.contains(document.activeElement)) {
        while (cursor && cursor !== node) {
          const next = cursor.nextSibling;
          el.list.append(cursor);
          cursor = next;
        }
      } else {
        el.list.insertBefore(node, cursor);
      }
    }
    cursor = node.nextSibling;
  }
}

el.list.addEventListener("focusout", () => setTimeout(renderList, 0));

// ── Moving a task between rounds ─────────────────────────────────────────────

/** Puts the round and live/cut buttons back in step with `filters`. */
function syncFilterButtons() {
  for (const [id, key] of [["round-filter", "round"], ["shown-filter", "shown"]]) {
    for (const b of document.getElementById(id).children) {
      b.classList.toggle("on", b.dataset[key] === filters[key]);
    }
  }
}

/**
 * Keeps a task on screen after its round changed.
 *
 * Filtered to Round 1, moving a task to Round 2 would otherwise make the row
 * vanish -- which reads as "it is gone" rather than "it is in the other round
 * now". Same reasoning as revealTask, and only the round filter is touched:
 * it is the only one a move can fall out of, and clearing a search someone
 * used to find the task would be its own small theft.
 */
function followTask(task) {
  if (filters.round !== "all" && Number(filters.round) !== task.round) {
    filters.round = String(task.round);
    syncFilterButtons();
  }
  renderList();
  rows.get(task.slug)?.scrollIntoView({ block: "center" });
}

/**
 * Moves a task to the other half of the event, live.
 *
 * Deliberately not `save()`. A move is not an optimistic field edit: the server can
 * REFUSE a move -- a task someone has already submitted would strand that evidence in a
 * round its task had left -- and a swallowed refusal would leave the panel
 * showing a round the database does not have, until a poll silently yanked it
 * back.
 *
 * Nothing moves locally until the server says it did, for the same reason: a
 * row that regroups itself and then flips back is the "screen claims a result
 * it does not have" class. The buttons disable for the round trip instead.
 */
async function moveToRound(task, round) {
  if (task.round === round || moving.has(task.slug)) return;
  moving.add(task.slug);
  el.taskError.hidden = true;
  const row = rows.get(task.slug);
  if (row) paint(row, task);
  try {
    const res = await fetch(`/api/task/${task.slug}/round`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ round }),
    });
    const moved = await res.json().catch(() => null);
    // A body that is not a task is a failure however it arrived.
    if (!res.ok || !moved?.slug) throw new Error(moved?.error || `the task was not moved (HTTP ${res.status})`);
    Object.assign(task, moved, unsaved(task.slug));
    localWrites += 1;
  } catch (e) {
    el.taskError.textContent = String(e?.message ?? e);
    el.taskError.hidden = false;
  } finally {
    moving.delete(task.slug);
  }
  // Either way: the round it ended up in is the one the row now shows, and the
  // buttons come back out of their disabled state.
  followTask(task);
  renderSummary();
}

// ── Summary and balance ──────────────────────────────────────────────────────

function renderSummary() {
  const live = data.tasks.filter((t) => t.active);
  const flagged = data.tasks.filter((t) => t.rewrite).length;
  el.stats.innerHTML =
    `<b>${live.length}</b> live · <b>${data.tasks.length - live.length}</b> cut` +
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
  const tiers = [1, 3, 5, 7, 10];
  const rowsHtml = [1, 2]
    .map((round) => {
      const inRound = data.tasks.filter((t) => t.round === round && t.active);
      if (!inRound.length) return "";
      const cells = tiers.map((tier) => `<td>${inRound.filter((t) => t.points === tier).length}</td>`).join("");
      return `<tr>
        <td>R${round}</td>
        ${cells}
        <td>${inRound.reduce((s, t) => s + t.points, 0)}</td>
        <td>${inRound.filter((t) => t.prop).length}</td>
      </tr>`;
    })
    .join("");

  el.balance.innerHTML = `
    <table>
      <thead><tr>
        <th></th><th>1</th><th>3</th><th>5</th><th>7</th><th>10</th>
        <th title="Assigned points before per-item extras">Baseline</th>
        <th title="Tasks needing a prop">Prop</th>
      </tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>`;
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
// It is live the moment it lands. The optional fields mirror the row editor so a
// task can be configured correctly before players see it, rather than briefly
// appearing with the wrong scoring rule.

let adding = false;

function syncAddDetails() {
  const mode = el.newTaskScoringMode.value;
  // Only a quantity task has anything for the judge to count.
  el.newTaskMeasurementLabelField.hidden = mode !== "quantity";
  el.newTaskPointsPerUnitField.hidden = mode !== "quantity";
}

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
  syncFilterButtons();
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
    const round = Number(el.newTaskRound.value);
    const scoringMode = el.newTaskScoringMode.value;
    const res = await fetch("/api/task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        round,
        points: Number(el.newTaskPoints.value),
        scoringMode,
        measurementLabel: scoringMode === "quantity" ? el.newTaskMeasurementLabel.value.trim() : "",
        pointsPerUnit: scoringMode === "quantity" ? Number(el.newTaskPointsPerUnit.value) : 0,
        prop: el.newTaskProp.value.trim(),
        note: el.newTaskNote.value,
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
    el.newTaskScoringMode.value = "fixed";
    el.newTaskMeasurementLabel.value = "";
    el.newTaskPointsPerUnit.value = "0";
    el.newTaskProp.value = "";
    el.newTaskNote.value = "";
    syncAddDetails();
  } catch (e) {
    el.taskError.textContent = String(e?.message ?? e);
    el.taskError.hidden = false;
  } finally {
    adding = false;
    syncAddButton();
  }
}

el.newTask.addEventListener("input", syncAddButton);
el.newTaskScoringMode.addEventListener("change", () => {
  syncAddDetails();
  if (el.newTaskScoringMode.value !== "fixed") el.newTaskDetails.open = true;
});
el.newTask.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); addTask(); }
});
el.addTaskButton.addEventListener("click", addTask);
syncAddDetails();
syncAddButton();

/** Merge by slug: row handlers retain their task object, not a stale snapshot. */
function applyTasks(next) {
  const existing = new Map(data.tasks.map((t) => [t.slug, t]));
  data.tasks = next.tasks.map((incoming) =>
    Object.assign(existing.get(incoming.slug) ?? {}, incoming, unsaved(incoming.slug))
  );
  const present = new Set(data.tasks.map((t) => t.slug));
  for (const [slug, task] of existing) {
    if (present.has(slug)) continue;
    if (pending.has(slug)) data.tasks.push(task);
    else rows.delete(slug);
  }
  renderList();
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
let refreshId = 0;

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
  // Field edits are overlaid in applyTasks; a move is not a field patch.
  if (moving.size) return;
  const at = localWrites;
  const request = ++refreshId;
  try {
    const next = await fetchTasks();
    if (request !== refreshId) return;
    // The fetch succeeded, so any "not refreshing" note is wrong from here on
    // even if the body itself turns out to be too old to apply.
    loadError = null;
    // Checked AGAIN after the await, against the write counter as well as the
    // gates: a poll that started before a move or an edit landed is stale even
    // though nothing is in flight by the time it resolves, and merging it would
    // undo the write on screen for a whole poll interval. Only once something
    // has loaded, because before that nothing local can be newer.
    if (loaded && (moving.size || localWrites !== at)) return;
    loaded = true;
    applyTasks(next);
  } catch (e) {
    if (request !== refreshId) return;
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

events.addEventListener("tasks", () => {
  // Broadcasts can finish out of order. Use them as a nudge for a fresh read.
  void refreshTasks();
});
