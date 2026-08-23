/**
 * Durable storage for the task board.
 *
 * The board is a design artifact for the event, not session state, so it lives
 * inside the app repo it feeds rather than in the session workspace: edits
 * survive reloads, new canvas instances, and future sessions, and every change
 * is versioned alongside the code. `instanceId` is never a storage key -- every
 * instance of the canvas reads and writes this one file.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MODEL, SEED_TASKS } from "./seed.mjs";

/*
 * Resolved relative to this file, which lives at `.github/extensions/
 * scavenger-tasks/` inside the app repo -- so the canvas and
 * `scripts/task-sync.mjs` always read and write the same board in the same
 * checkout. It used to be an absolute path into one person's home directory,
 * which is both unshippable in a committed file and the asymmetry that made a
 * worktree publish a stale board.
 *
 * The remaining worktree hazard -- a canvas opened in a linked worktree editing
 * a board nobody publishes -- is caught by `worktreeRefusal` in
 * `scripts/task-sync.mjs` and surfaced in the publish banner, rather than being
 * checked a second time here.
 */
export const BOARD_PATH = fileURLToPath(new URL("../../../data/task-board.json", import.meta.url));

const RATINGS = ["difficulty", "guts", "luck", "payoff", "risk"];
const STATUSES = ["keep", "maybe", "cut"];
const TIERS = [1, 3, 5, 7, 10];

/** Fields a caller may change, with a validator each. Anything else is ignored. */
const EDITABLE = {
  title: (v) => (typeof v === "string" && v.trim() ? v.trim() : undefined),
  note: (v) => (typeof v === "string" ? v : undefined),
  prop: (v) => (typeof v === "string" ? v : undefined),
  points: (v) => (TIERS.includes(Number(v)) ? Number(v) : undefined),
  status: (v) => (STATUSES.includes(v) ? v : undefined),
  needsClip: (v) => (typeof v === "boolean" ? v : undefined),
  rewrite: (v) => (typeof v === "boolean" ? v : undefined),
  ...Object.fromEntries(
    RATINGS.map((k) => [k, (v) => (Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 5 ? Number(v) : undefined)])
  ),
};

let cache = null;

/** Shape every task must have, used to backfill anything added after the seed. */
const CUSTOM_DEFAULTS = {
  round: 1, docTitle: "", title: "Untitled task", points: 3, docOrder: 999,
  difficulty: 3, guts: 3, luck: 3, payoff: 3, risk: 1,
  needsClip: false, prop: "", status: "maybe", rewrite: false, note: "", custom: true,
};

function emptyBoard() {
  return { version: 1, model: structuredClone(DEFAULT_MODEL), tasks: structuredClone(SEED_TASKS) };
}

/**
 * Reconciles a board loaded from disk against the seed: unknown keys are
 * dropped, missing ones are backfilled. Keeps an older file readable after the
 * seed gains a field, without clobbering the user's edits.
 */
function normalize(raw) {
  const base = emptyBoard();
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.tasks)) return base;

  const saved = new Map(raw.tasks.filter((t) => t && typeof t.id === "string").map((t) => [t.id, t]));
  const tasks = base.tasks.map((seed) => {
    const prev = saved.get(seed.id);
    if (!prev) return seed;
    const merged = { ...seed };
    for (const [key, validate] of Object.entries(EDITABLE)) {
      const value = validate(prev[key]);
      if (value !== undefined) merged[key] = value;
    }
    return merged;
  });

  // Tasks added after the seed was written. Anything else in the file is a
  // task the seed has since dropped, and is intentionally not resurrected.
  for (const [id, extra] of saved) {
    if (!extra.custom || base.tasks.some((s) => s.id === id)) continue;
    tasks.push({ ...CUSTOM_DEFAULTS, ...extra, id, custom: true });
  }

  const model = structuredClone(DEFAULT_MODEL);
  const m = raw.model;
  if (m?.weights) for (const k of Object.keys(model.weights)) {
    if (Number.isFinite(Number(m.weights[k]))) model.weights[k] = Number(m.weights[k]);
  }
  if (m?.thresholds) for (const k of Object.keys(model.thresholds)) {
    if (Number.isFinite(Number(m.thresholds[k]))) model.thresholds[k] = Number(m.thresholds[k]);
  }

  return { version: 1, model, tasks };
}

export function loadBoard() {
  if (cache) return cache;
  try {
    if (existsSync(BOARD_PATH)) {
      cache = normalize(JSON.parse(readFileSync(BOARD_PATH, "utf8")));
      return cache;
    }
  } catch {
    // A corrupt or partially written file should not take the canvas down;
    // fall through to the seed and let the next save overwrite it.
  }
  cache = emptyBoard();
  saveBoard(cache);
  return cache;
}

/** Writes via a temp file + rename so a crash mid-write can't truncate the board. */
export function saveBoard(board) {
  cache = board;
  mkdirSync(dirname(BOARD_PATH), { recursive: true });
  const tmp = `${BOARD_PATH}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(board, null, 2)}\n`, "utf8");
  renameSync(tmp, BOARD_PATH);
  return board;
}

/**
 * Applies a validated patch to one task.
 * @returns the updated task, or null if the id is unknown.
 */
export function updateTask(taskId, patch) {
  const board = loadBoard();
  const task = board.tasks.find((t) => t.id === taskId);
  if (!task) return null;
  for (const [key, value] of Object.entries(patch ?? {})) {
    const validate = EDITABLE[key];
    if (!validate) continue;
    const clean = validate(value);
    if (clean !== undefined) task[key] = clean;
  }
  saveBoard(board);
  return task;
}

export function updateModel(patch) {
  const board = loadBoard();
  for (const k of Object.keys(board.model.weights)) {
    if (Number.isFinite(Number(patch?.weights?.[k]))) board.model.weights[k] = Number(patch.weights[k]);
  }
  for (const k of Object.keys(board.model.thresholds)) {
    if (Number.isFinite(Number(patch?.thresholds?.[k]))) board.model.thresholds[k] = Number(patch.thresholds[k]);
  }
  saveBoard(board);
  return board.model;
}

export function addTask(input) {
  const board = loadBoard();
  const round = [0, 1, 2].includes(Number(input?.round)) ? Number(input.round) : 1;
  const prefix = round === 0 ? "s" : `r${round}`;
  let n = 1;
  while (board.tasks.some((t) => t.id === `${prefix}-x${n}`)) n += 1;
  const task = {
    ...CUSTOM_DEFAULTS,
    id: `${prefix}-x${n}`,
    round,
    title: String(input?.title ?? "Untitled task").trim() || "Untitled task",
    points: TIERS.includes(Number(input?.points)) ? Number(input.points) : round === 0 ? 7 : 3,
    docOrder: 999 + n,
    note: String(input?.note ?? ""),
  };
  for (const k of RATINGS) {
    const v = EDITABLE[k](input?.[k]);
    if (v !== undefined) task[k] = v;
  }
  board.tasks.push(task);
  saveBoard(board);
  return task;
}

/** Weighted score for a task under the current model. */
export function scoreOf(task, model) {
  const w = model.weights;
  return task.difficulty * w.difficulty + task.guts * w.guts + task.luck * w.luck;
}

/** The tier the model thinks a task belongs in. Secrets are a flat tier, so they're exempt. */
export function suggestedPoints(task, model) {
  if (task.round === 0) return 7;
  const s = scoreOf(task, model);
  const { t1, t3, t5 } = model.thresholds;
  if (s <= t1) return 1;
  if (s <= t3) return 3;
  if (s <= t5) return 5;
  return 10;
}

/** Board-level rollup the UI header and the `summary` action both render. */
export function summarize(board) {
  const kept = board.tasks.filter((t) => t.status !== "cut");
  const rounds = {};
  for (const round of [1, 2, 0]) {
    const inRound = kept.filter((t) => t.round === round);
    const tiers = {};
    for (const tier of TIERS) {
      const n = inRound.filter((t) => t.points === tier).length;
      if (n) tiers[tier] = n;
    }
    rounds[round] = {
      count: inRound.length,
      tiers,
      maxPoints: inRound.reduce((sum, t) => sum + t.points, 0),
      mismatched: inRound.filter((t) => t.points !== suggestedPoints(t, board.model)).length,
      avgPayoff: inRound.length ? +(inRound.reduce((s, t) => s + t.payoff, 0) / inRound.length).toFixed(2) : 0,
      needsClip: inRound.filter((t) => t.needsClip).length,
      needsProp: inRound.filter((t) => t.prop).length,
      highRisk: inRound.filter((t) => t.risk >= 4).length,
      highLuck: inRound.filter((t) => t.luck >= 4).length,
    };
  }
  return {
    total: board.tasks.length,
    keep: board.tasks.filter((t) => t.status === "keep").length,
    maybe: board.tasks.filter((t) => t.status === "maybe").length,
    cut: board.tasks.filter((t) => t.status === "cut").length,
    flaggedForRewrite: board.tasks.filter((t) => t.rewrite).length,
    rounds,
  };
}
