/**
 * The planning board: its schema, its validators, and the queries that read and
 * write it.
 *
 * The board is the source of truth for task content, points and cuts. It lives
 * in the `task_board` table (`supabase/migrate-task-board.sql`) and reaches
 * players only through `scripts/task-sync.mjs`, which writes `tasks` and nothing
 * else. Those two tables are deliberately not one: editing a rating must not
 * change what a player sees until someone publishes.
 *
 * It used to be `data/task-board.json`. A file has one copy per checkout, so a
 * worktree edited a board nobody published, two processes could hold it in
 * memory and silently revert each other, and publishing stranded a commit on
 * whatever branch was checked out. There is one Supabase project behind every
 * session, so the board belongs in it.
 *
 * Two halves, split on purpose:
 *
 *   - Everything above `── Queries ──` is pure. `board-store.test.mjs` proves it
 *     with no client, no network and no `.env.local` -- and therefore with no
 *     way to touch the real event.
 *   - The queries all take `db` as their first argument. Nothing here creates a
 *     connection on import, so a test can pass a fake and `board-db.test.mjs`
 *     can prove the query layer without a database either.
 */

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

export const TIERS = [1, 3, 5, 7, 10];
export const STATUSES = ["keep", "maybe", "cut"];
export const RATINGS = ["difficulty", "guts", "luck", "payoff", "risk"];

/**
 * Which table the board lives in. Overridable so a scratch copy can be pointed
 * at without editing code: there is exactly one Supabase project and it holds
 * the real event, so anything that writes needs a way to write somewhere else.
 */
export const BOARD_TABLE = process.env.SCAVENGER_BOARD_TABLE || "task_board";

/** Where the scoring model is kept in the key/value `settings` table. */
export const MODEL_KEY = "board_model";

/**
 * Column -> the key that column has on a task object.
 *
 * The task shape stays camelCase and is exactly what the planner and the canvas
 * already consume, so moving the board into a table changed no consumer. This
 * map is the only place the two vocabularies meet.
 */
export const COLUMNS = {
  board_id: "id",
  round: "round",
  doc_title: "docTitle",
  title: "title",
  points: "points",
  doc_order: "docOrder",
  difficulty: "difficulty",
  guts: "guts",
  luck: "luck",
  payoff: "payoff",
  risk: "risk",
  needs_clip: "needsClip",
  prop: "prop",
  status: "status",
  rewrite: "rewrite",
  note: "note",
  tier_ok: "tierOk",
};

/** Named explicitly rather than `*`, so a column added later cannot arrive unmapped. */
export const SELECT = Object.keys(COLUMNS).join(",");

const TASK_KEY_TO_COLUMN = Object.fromEntries(Object.entries(COLUMNS).map(([column, key]) => [key, column]));

export function rowToTask(row) {
  const task = {};
  for (const [column, key] of Object.entries(COLUMNS)) task[key] = row?.[column] ?? null;
  return task;
}

export function taskToRow(task) {
  const row = {};
  for (const [column, key] of Object.entries(COLUMNS)) row[column] = task?.[key] ?? null;
  return row;
}

const int = (v) => (typeof v === "boolean" ? NaN : Number(v));
const rating = (v) => {
  const n = int(v);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : undefined;
};

/**
 * The fields a caller may change, with a validator each. Anything not listed is
 * dropped rather than written.
 *
 * `id`, `round`, `docTitle` and `docOrder` are deliberately absent. They are
 * identity and provenance: `docTitle` is the planning doc's own wording and the
 * evidence of what a task used to say, and `id` is the key `tasks.board_id`
 * joins on. A patch that could move a task between rounds would silently break
 * that join.
 *
 * Every validator returns `undefined` for "not a legal value", which is what
 * drops the field. Returning the raw value instead would send it to a column
 * with a `check` constraint, and a rejected statement discards the valid fields
 * alongside the bad one -- losing edits the user did make.
 */
export const EDITABLE = {
  title: (v) => (typeof v === "string" && v.trim() ? v.trim() : undefined),
  note: (v) => (typeof v === "string" ? v : undefined),
  prop: (v) => (typeof v === "string" ? v : undefined),
  points: (v) => (TIERS.includes(int(v)) ? int(v) : undefined),
  status: (v) => (STATUSES.includes(v) ? v : undefined),
  needsClip: (v) => (typeof v === "boolean" ? v : undefined),
  rewrite: (v) => (typeof v === "boolean" ? v : undefined),
  // The tier suggestion this task's owner rejected, or null for "never
  // dismissed". A number rather than a flag on purpose: see tier.mjs.
  tierOk: (v) => (v === null ? null : TIERS.includes(int(v)) ? int(v) : undefined),
  ...Object.fromEntries(RATINGS.map((k) => [k, rating])),
};

/**
 * Validates a camelCase patch and returns the columns to write.
 * An empty result means there is nothing legal to write -- not "write nothing to
 * everything".
 */
export function taskPatchToRow(patch) {
  const row = {};
  for (const [key, value] of Object.entries(patch ?? {})) {
    const validate = EDITABLE[key];
    if (!validate) continue;
    const clean = validate(value);
    if (clean !== undefined) row[TASK_KEY_TO_COLUMN[key]] = clean;
  }
  return row;
}

/**
 * Defaults for the tier model, used whenever the stored one is missing or
 * unreadable.
 *
 * The thresholds are fitted, not invented: they are the score cutoffs that
 * reproduce the planning doc's own tier distribution (10/22/23/14) across the
 * tasks it already had. Arbitrary cutoffs would flag half the board and the
 * disagreements would be noise.
 */
export const DEFAULT_MODEL = Object.freeze({
  weights: Object.freeze({ difficulty: 1.2, guts: 1.0, luck: 0.6 }),
  // Upper bound of each tier's weighted score. Anything above `t5` is a 10.
  thresholds: Object.freeze({ t1: 5.9, t3: 8.1, t5: 10.8 }),
});

/**
 * Reads the model out of its settings row.
 *
 * Every failure lands on the defaults rather than on a partial model: one NaN
 * weight makes every tier comparison false, which would quietly re-tier the
 * whole board without anything looking broken.
 */
export function parseModel(value) {
  let raw = null;
  if (value && typeof value === "string") {
    try {
      raw = JSON.parse(value);
    } catch {
      raw = null;
    }
  } else if (value && typeof value === "object") {
    raw = value;
  }

  const model = { weights: { ...DEFAULT_MODEL.weights }, thresholds: { ...DEFAULT_MODEL.thresholds } };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return model;
  for (const group of ["weights", "thresholds"]) {
    const from = raw[group];
    if (!from || typeof from !== "object") continue;
    for (const key of Object.keys(model[group])) {
      // Number(null) is 0 and Number("") is 0, so both have to be excluded by
      // type before the finite check, or a missing weight becomes a zero one.
      if (from[key] === null || from[key] === "" || typeof from[key] === "boolean") continue;
      const n = Number(from[key]);
      if (Number.isFinite(n)) model[group][key] = n;
    }
  }
  return model;
}

export function serializeModel(model) {
  return JSON.stringify(parseModel(model));
}

// ── Queries ──────────────────────────────────────────────────────────────────

/**
 * The whole board: every task plus the scoring model.
 *
 * Read fresh every time, with no cache. The cache this replaces was the cause of
 * its own bug -- a process served its first read forever and wrote that stale
 * copy back over whatever another session had done since. Any session can edit
 * the board now, so "the copy I loaded" is never a safe thing to hold.
 *
 * @returns {Promise<{model: object, tasks: object[]}>}
 */
export async function readBoard(db) {
  const [tasks, settings] = await Promise.all([
    db.from(BOARD_TABLE).select(SELECT).order("round").order("doc_order").order("board_id"),
    db.from("settings").select("key,value").eq("key", MODEL_KEY).maybeSingle(),
  ]);
  if (tasks.error) throw new Error(`could not read the task board: ${tasks.error.message}`);
  // A missing model row is a working board on the defaults, so only a real
  // failure is worth raising. `maybeSingle` reports no rows as no error.
  if (settings.error) throw new Error(`could not read the board model: ${settings.error.message}`);
  return {
    model: parseModel(settings.data?.value),
    tasks: (tasks.data ?? []).map(rowToTask),
  };
}

/**
 * Writes only the fields that changed, on one row.
 *
 * Per-field rather than whole-board on purpose. Saving the whole board is what
 * let one process overwrite another's unrelated edits; patching named columns of
 * a named row makes that impossible rather than unlikely. Two people editing
 * different tasks -- or different fields of the same task -- no longer interact
 * at all, and last-write-wins on the same field is the only remaining race,
 * which is the expected one.
 *
 * @returns {Promise<object|null>} the updated task, or null if the id is unknown.
 */
export async function updateTask(db, boardId, patch) {
  if (typeof boardId !== "string" || !boardId) return null;
  const row = taskPatchToRow(patch);
  // Nothing legal to write. Still a read, so the caller can tell "no such task"
  // from "nothing to do" -- returning the task unchanged is the honest answer.
  if (!Object.keys(row).length) {
    const { data, error } = await db.from(BOARD_TABLE).select(SELECT).eq("board_id", boardId).maybeSingle();
    if (error) throw new Error(`could not read task ${boardId}: ${error.message}`);
    return data ? rowToTask(data) : null;
  }

  const { data, error } = await db
    .from(BOARD_TABLE)
    .update({ ...row, updated_at: new Date().toISOString() })
    .eq("board_id", boardId)
    .select(SELECT)
    .maybeSingle();
  if (error) throw new Error(`could not update task ${boardId}: ${error.message}`);
  return data ? rowToTask(data) : null;
}

/**
 * Adds a task. It lands as `maybe` so it has to be reviewed before it counts.
 *
 * The id is allocated by looking at what is already there, which is a read
 * followed by a write and therefore racy in principle. The insert is the
 * arbiter: `board_id` is the primary key, so a genuinely simultaneous add fails
 * loudly on the duplicate instead of overwriting the other one.
 */
export async function addTask(db, input) {
  const round = [0, 1, 2].includes(Number(input?.round)) ? Number(input.round) : 1;
  const prefix = round === 0 ? "s" : `r${round}`;
  const { data: existing, error: readError } = await db.from(BOARD_TABLE).select("board_id");
  if (readError) throw new Error(`could not read the task board: ${readError.message}`);
  const taken = new Set((existing ?? []).map((r) => r.board_id));
  let n = 1;
  while (taken.has(`${prefix}-x${n}`)) n += 1;

  const row = {
    board_id: `${prefix}-x${n}`,
    round,
    // Empty is what marks a task as not having come from the planning doc.
    doc_title: "",
    title: String(input?.title ?? "").trim() || "Untitled task",
    points: TIERS.includes(Number(input?.points)) ? Number(input.points) : round === 0 ? 7 : 3,
    doc_order: 999 + n,
    status: "maybe",
    note: typeof input?.note === "string" ? input.note : "",
    ...taskPatchToRow(Object.fromEntries(RATINGS.map((k) => [k, input?.[k]]))),
  };

  const { data, error } = await db.from(BOARD_TABLE).insert(row).select(SELECT).single();
  if (error) throw new Error(`could not add a task: ${error.message}`);
  return rowToTask(data);
}

/** Merges a partial model into the stored one and returns the result. */
export async function updateModel(db, patch) {
  const current = await readModel(db);
  const merged = parseModel({
    weights: { ...current.weights, ...(patch?.weights ?? {}) },
    thresholds: { ...current.thresholds, ...(patch?.thresholds ?? {}) },
  });
  const { error } = await db.from("settings").upsert({ key: MODEL_KEY, value: JSON.stringify(merged) });
  if (error) throw new Error(`could not save the board model: ${error.message}`);
  return merged;
}

export async function readModel(db) {
  const { data, error } = await db.from("settings").select("value").eq("key", MODEL_KEY).maybeSingle();
  if (error) throw new Error(`could not read the board model: ${error.message}`);
  return parseModel(data?.value);
}

// ── Connecting ───────────────────────────────────────────────────────────────

/**
 * `.env.local`, resolved next to this file rather than from the cwd.
 *
 * The canvas extension is forked by Copilot from somewhere unrelated, and the
 * publisher is run from whichever directory the user happens to be in. Both have
 * to find the same file.
 */
export function loadEnv() {
  return Object.fromEntries(
    readFileSync(new URL("../.env.local", import.meta.url), "utf8")
      .split("\n")
      .filter((l) => l.trim() && !l.trim().startsWith("#") && l.includes("="))
      .map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
      })
  );
}

/** The service_role client. RLS is on with no policies, so nothing else can read these tables. */
export function createAdminClient(env = loadEnv()) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local");
  }
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}
