/**
 * Canvas renderer. Talks to the extension over plain HTTP on the same origin:
 * GET /api/board, PATCH /api/task/:id, PATCH /api/model, and an SSE stream at
 * /events.
 *
 * The board is a database table any session can write, so the page POLLS
 * /api/board. The stream only reaches panels served by the same extension
 * process -- one per session -- so it is same-process immediacy, not the
 * mechanism. See "Staying current" at the bottom.
 *
 * Publishing goes through GET /api/publish/status and POST /api/publish, both of
 * which run the real `scripts/task-sync.mjs`. The banner's wording and its
 * enabled/disabled decision live in publish-state.mjs, which is pure and tested.
 */

import { describeChanges, publishState } from "/publish-state.mjs";
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
  balance: document.getElementById("balance"),
  search: document.getElementById("search"),
  sort: document.getElementById("sort"),
  onlyFlagged: document.getElementById("only-flagged"),
  publish: document.getElementById("publish"),
  publishHeadline: document.getElementById("publish-headline"),
  publishDetail: document.getElementById("publish-detail"),
  publishRecheck: document.getElementById("publish-recheck"),
  publishReview: document.getElementById("publish-review"),
  publishPreview: document.getElementById("publish-preview"),
  publishChanges: document.getElementById("publish-changes"),
  publishWarnings: document.getElementById("publish-warnings"),
  publishConfirm: document.getElementById("publish-confirm"),
  publishCancel: document.getElementById("publish-cancel"),
};

const filters = { round: "all", status: "all", q: "", sort: "doc", flagged: false };

let board = { tasks: [], model: { weights: {}, thresholds: {} } };
/**
 * Whether a board has ever actually arrived, and why the last attempt did not.
 * The empty board above is a placeholder, not a result: without these two the
 * list would say "Nothing matches those filters" about a board it never read.
 */
let loaded = false;
let boardError = null;
/** Rows currently rendered, so an update can patch in place instead of rebuilding. */
const rows = new Map();
/** id -> { patch, timer } for edits still waiting to be sent. */
const pending = new Map();

// ── Model ────────────────────────────────────────────────────────────────────

const scoreOf = (t) => rawScore(t, board.model.weights);

/** The single rule for "does this task disagree with its ratings". */
const advice = (t) => tierAdvice(t, board.model);

// ── Persistence ──────────────────────────────────────────────────────────────

/**
 * Coalesces rapid edits (slider drags, typing) into one request per task, and
 * applies the patch locally first so the UI never waits on the round trip.
 * The timer is held alongside the patch rather than inside it, so what gets
 * sent is exactly the patch and nothing has to be stripped back out.
 */
function save(task, patch) {
  Object.assign(task, patch);
  touchBoard();
  const queued = pending.get(task.id) ?? { patch: {}, timer: 0 };
  Object.assign(queued.patch, patch);
  pending.set(task.id, queued);
  clearTimeout(queued.timer);
  queued.timer = setTimeout(async () => {
    const body = pending.get(task.id)?.patch ?? {};
    pending.delete(task.id);
    await fetch(`/api/task/${task.id}`, {
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
    body: JSON.stringify(board.model),
  }).catch(() => {});
}

// ── Filtering and sorting ────────────────────────────────────────────────────

function visibleTasks() {
  const q = filters.q.toLowerCase();
  let list = board.tasks.filter((t) => {
    if (filters.round !== "all" && t.round !== Number(filters.round)) return false;
    // "In" is everything still in the running. A cut task is a decision already
    // made, so it stops taking up room in the list you are working through --
    // the Cut tab is where it lives, and is the only way back.
    if (filters.status === "all") {
      if (t.status === "cut") return false;
    } else if (t.status !== filters.status) return false;
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
  if (task.needsClip) chips.push(["clip", ""]);
  if (task.prop) chips.push(["prop", ""]);
  if (task.luck >= 4) chips.push(["luck", "warn"]);
  if (task.risk >= 4) chips.push(["risk", "alert"]);
  if (task.payoff <= 2) chips.push(["flat", "warn"]);
  if (task.rewrite) chips.push(["rewrite", "warn"]);
  return chips;
}

function paint(row, task) {
  const { suggested, show } = advice(task);

  row.classList.toggle("is-cut", task.status === "cut");

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

  for (const b of row.querySelectorAll(".status button")) b.classList.toggle("on", b.dataset.status === task.status);

  for (const [key] of RATINGS) {
    const slider = row.querySelector(`.slider.${key}`);
    if (!slider) continue;
    const input = slider.querySelector("input");
    if (document.activeElement !== input) input.value = task[key];
    slider.querySelector(".val").textContent = task[key];
  }

  const points = row.querySelector(".points");
  if (document.activeElement !== points) points.value = String(task.points);

  const prop = row.querySelector(".prop");
  if (document.activeElement !== prop) prop.value = task.prop;

  const note = row.querySelector(".note");
  if (document.activeElement !== note) note.value = task.note;

  row.querySelector(".clip").checked = task.needsClip;
  row.querySelector(".rewrite").checked = task.rewrite;

  const docTitle = row.querySelector(".doc-title");
  const changed = task.docTitle && task.docTitle !== task.title;
  docTitle.hidden = !changed;
  if (changed) docTitle.textContent = `Doc wording: ${task.docTitle}`;
}

function buildRow(task) {
  const row = document.getElementById("row-tpl").content.firstElementChild.cloneNode(true);
  row.dataset.id = task.id;

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

  row.querySelector(".status").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    save(task, { status: btn.dataset.status });
    paint(row, task);
    renderSummary();
  });

  const points = row.querySelector(".points");
  points.addEventListener("change", () => {
    save(task, { points: Number(points.value) });
    paint(row, task);
    renderSummary();
  });

  for (const [sel, key, read] of [
    [".prop", "prop", (n) => n.value],
    [".note", "note", (n) => n.value],
    [".clip", "needsClip", (n) => n.checked],
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
    // Never "Nothing matches those filters" for a board that has not arrived.
    // A screen claiming a result it does not have is the bug class that has
    // produced most of the serious bugs in this app, and an unreachable board
    // and an empty one look identical unless this says which it is.
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = boardError ? `The board could not be read. ${boardError}` : "Loading the board\u2026";
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
    rows.set(task.id, row);
    el.list.append(row);
  }
}

// ── Summary and balance ──────────────────────────────────────────────────────

function renderSummary() {
  const kept = board.tasks.filter((t) => t.status !== "cut");
  const mismatched = kept.filter((t) => advice(t).show).length;
  const flagged = board.tasks.filter((t) => t.rewrite).length;
  el.stats.innerHTML =
    `<b>${kept.length}</b> in · <b>${board.tasks.length - kept.length}</b> cut · ` +
    `<b>${mismatched}</b> tier disagreements` +
    (flagged ? ` · <b>${flagged}</b> flagged` : "");
  // The board on screen was real when it was fetched, so it is not withdrawn.
  // But any session can edit these rows now, so a board that has stopped
  // refreshing must not be indistinguishable from a current one. Appended as
  // text, matching how every other untrusted string in here is rendered.
  if (loaded && boardError) {
    const note = document.createElement("span");
    note.className = "stale";
    note.textContent = ` · not refreshing — ${boardError}`;
    el.stats.append(note);
  }
  if (!el.balance.hidden) renderBalance();
}

function renderBalance() {
  const tiers = [1, 3, 5, 10];
  const rowsHtml = [1, 2, 0]
    .map((round) => {
      const inRound = board.tasks.filter((t) => t.round === round && t.status !== "cut");
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

  const w = board.model.weights;
  const th = board.model.thresholds;
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
      if (input.dataset.weight) board.model.weights[input.dataset.weight] = value;
      else board.model.thresholds[input.dataset.threshold] = value;
      saveModel();
      for (const [id, row] of rows) paint(row, board.tasks.find((t) => t.id === id));
      renderSummary();
    });
  }
}

// ── Publishing ───────────────────────────────────────────────────────────────
//
// The board is written to the database the instant a slider moves, but none of it
// reaches players until the sync runs. That gap is the point -- it makes
// re-tiering an hour before the event safe -- but it was invisible, which is
// what this banner fixes.
//
// No planning logic lives here. `/api/publish/status` runs the real
// `scripts/task-sync.mjs --json`, so every refusal it can raise arrives intact.

/** Last report from the sync, or null before the first one comes back. */
let report = null;
/** When the board was last edited locally. Newer than the report means the count is stale. */
let staleSince = 0;
let recheckTimer;
let checking = false;

function renderPublish() {
  const state = publishState(report, { staleSince });
  el.publish.dataset.kind = state.kind;
  el.publishHeadline.textContent = checking && !report ? "Checking what's live\u2026" : state.headline;
  el.publishDetail.textContent = checking && !report ? "" : state.detail ?? "";
  el.publishRecheck.disabled = checking;
  el.publishRecheck.textContent = checking ? "Checking\u2026" : "Recheck";

  // Only ever offered from `pending`: a stale, blocked, failed or already-clean
  // state must not be publishable, and that decision belongs to publish-state.
  el.publishReview.hidden = !state.canPublish;
  if (!state.canPublish && !el.publishPreview.hidden) closePreview();
}

async function refreshStatus() {
  clearTimeout(recheckTimer);
  checking = true;
  renderPublish();
  try {
    const res = await fetch("/api/publish/status");
    report = await res.json();
  } catch (e) {
    // Never fall back to a count. A check that did not happen is unknown.
    report = { ok: false, count: null, error: `Could not reach the sync: ${e.message}` };
  }
  // Staleness is decided purely by the report's own `checkedAt`, which the
  // extension stamps at the moment the run started. An edit made while the run
  // was in flight is therefore newer than the count, and correctly stays stale.
  checking = false;
  renderPublish();
}

/**
 * A local edit invalidates the count immediately, then schedules one recount
 * once editing settles. Recomputing per keystroke would hammer Supabase; not
 * recomputing at all would leave a number on screen that quietly stopped being
 * true. This does neither.
 */
function touchBoard() {
  staleSince = Date.now();
  renderPublish();
  clearTimeout(recheckTimer);
  recheckTimer = setTimeout(refreshStatus, 4000);
}

function closePreview() {
  el.publishPreview.hidden = true;
  el.publishReview.textContent = "Review & publish";
}

function openPreview() {
  const lines = describeChanges(report);
  const reorder = report?.counts?.reorder ?? 0;
  el.publishChanges.replaceChildren(
    ...lines.map(({ kind, text }) => {
      const li = document.createElement("li");
      li.dataset.kind = kind;
      li.textContent = text;
      return li;
    })
  );

  // Disclosed as one line rather than one line per task. Cutting a task
  // renumbers everything below it, so itemizing these buries the decisions that
  // matter -- but hiding them entirely would mean the preview did not account
  // for something the publish is about to write.
  if (reorder > 0) {
    const li = document.createElement("li");
    li.dataset.kind = "reorder";
    li.textContent = `${reorder} other task${reorder === 1 ? "" : "s"} move position in the player's list`;
    el.publishChanges.append(li);
  }

  const warnings = report?.warnings ?? [];
  el.publishWarnings.hidden = !warnings.length;
  el.publishWarnings.replaceChildren(
    ...warnings.map((w) => {
      const p = document.createElement("p");
      p.textContent = `! ${w}`;
      return p;
    })
  );

  // Counts decisions, not rows written, so it matches the banner above it.
  el.publishConfirm.textContent = lines.length
    ? `Publish ${lines.length} change${lines.length === 1 ? "" : "s"}`
    : "Publish new task order";
  el.publishPreview.hidden = false;
  el.publishReview.textContent = "Hide";
}

el.publishRecheck.addEventListener("click", refreshStatus);

el.publishReview.addEventListener("click", () => {
  if (el.publishPreview.hidden) openPreview();
  else closePreview();
});

el.publishCancel.addEventListener("click", closePreview);

el.publishConfirm.addEventListener("click", async () => {
  el.publishConfirm.disabled = true;
  el.publishCancel.disabled = true;
  el.publishConfirm.textContent = "Publishing\u2026";
  try {
    const res = await fetch("/api/publish", { method: "POST" });
    report = await res.json();
  } catch (e) {
    report = { ok: false, count: null, error: `The publish did not come back: ${e.message}` };
  }
  el.publishConfirm.disabled = false;
  el.publishCancel.disabled = false;
  closePreview();
  renderPublish();
  // Re-read rather than trusting the applied report, so what the banner settles
  // on is a fresh measurement of the live table.
  if (report?.applied) setTimeout(refreshStatus, 1200);
});

// ── Wiring ───────────────────────────────────────────────────────────────────

for (const [id, key] of [["round-filter", "round"], ["status-filter", "status"]]) {
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

/** Board pushes and poll results both arrive here. Rebuild only if the task set changed. */
function applyBoard(next) {
  const sameIds =
    next.tasks.length === board.tasks.length &&
    next.tasks.every((t, i) => t.id === board.tasks[i]?.id);
  board.model = next.model;

  if (!sameIds || !rows.size) {
    board.tasks = next.tasks;
    renderList();
  } else {
    // Merge in place rather than swapping the array: every row's event handlers
    // closed over its task object, so replacing them would leave the DOM wired
    // to objects nothing else reads.
    next.tasks.forEach((incoming, i) => Object.assign(board.tasks[i], incoming));
    for (const [id, row] of rows) {
      const task = board.tasks.find((t) => t.id === id);
      if (task) paint(row, task);
    }
  }
  renderSummary();
}

// ── Staying current ──────────────────────────────────────────────────────────
//
// The board is a table any session can write, so freshness is a requirement
// rather than an edge case. `/events` is served by THIS extension process and
// each session forks its own, so an edit made in another session's canvas can
// never arrive over the stream -- it is same-process immediacy and nothing more.
// The poll is what makes this correct, which matches the rest of the app: it
// polls everywhere and has no WebSockets or Realtime anywhere.
//
// A stale panel is cosmetic rather than dangerous, and deliberately so: publish
// re-runs the real sync against the database, so what gets published is the
// board's rows and never this page's copy of them.
//
// Deliberately no entry animation or crossfade on the list. A polled list
// retriggers one on every tick, which is why there are none anywhere in the app.

const POLL_MS = 8000;
let pollTimer = 0;

async function fetchBoard() {
  const res = await fetch("/api/board");
  const body = await res.json().catch(() => null);
  // A body that is not a board is a failure however it arrived. Rendering it
  // would empty the list and read as "there are no tasks".
  if (!res.ok || !body || !Array.isArray(body.tasks)) {
    throw new Error(body?.error || `the board could not be read (HTTP ${res.status})`);
  }
  return body;
}

async function refreshBoard() {
  // An unsent edit is newer than anything the server can return, and applying
  // the poll over it would visibly undo what was just typed.
  if (pending.size) return;
  try {
    const next = await fetchBoard();
    const changed = loaded && JSON.stringify(next.tasks) !== JSON.stringify(board.tasks);
    boardError = null;
    loaded = true;
    // Someone else changed the board, so the pending count the publish banner
    // is showing was measured against a board that no longer exists.
    if (changed) touchBoard();
    applyBoard(next);
  } catch (e) {
    boardError = String(e?.message ?? e);
    // Before the first success there is nothing on screen to keep, so the list
    // has to say why. After one, the board stands and renderSummary marks it.
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
    await refreshBoard();
    schedulePoll();
  }, POLL_MS);
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    clearTimeout(pollTimer);
    return;
  }
  refreshBoard().finally(schedulePoll);
});

renderList();
await refreshBoard();
schedulePoll();
refreshStatus();

new EventSource("/events").addEventListener("board", (e) => {
  // Ignore pushes while an edit is in flight; the local copy is newer.
  if (pending.size) return;
  let next;
  try {
    next = JSON.parse(e.data);
  } catch {
    return;
  }
  if (!next || !Array.isArray(next.tasks)) return;
  // An agent edit changes the board just as a slider does, so the pending count
  // it was measured against is no longer the board that is on screen.
  if (JSON.stringify(next.tasks) !== JSON.stringify(board.tasks)) touchBoard();
  loaded = true;
  boardError = null;
  applyBoard(next);
});
