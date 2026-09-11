/**
 * The task list: its shape, its validators, and the queries that read and write
 * it.
 *
 * There is one table. `tasks` is both what players see and where tasks are
 * planned, so an edit made in the canvas is live the moment it is made -- the
 * same way the roster tab has always worked.
 *
 * It used to be two. A `task_board` table held wording, points and cuts back
 * until someone ran a publish step, and `scripts/task-sync.mjs` was the bridge.
 * The gap did not survive contact with the event: Admin edited `tasks` live and
 * then mirrored the same four fields back onto the board, so the live path
 * already existed and the mirror was only there to stop the two tables
 * disagreeing. The notes and props are never shown to a player at all, so there
 * was nothing left for a staging step to protect. See
 * `supabase/migrate-tasks-one-table.sql`.
 *
 * Two halves, split on purpose:
 *
 *   - Everything above `── Queries ──` is pure. `task-store.test.mjs` proves it
 *     with no client, no network and no `.env.local` -- and therefore with no
 *     way to touch the real event.
 *   - The queries all take `db` as their first argument. Nothing here creates a
 *     connection on import, so a test can pass a fake and `task-db.test.mjs`
 *     can prove the query layer without a database either.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** This checkout, resolved from this file so the cwd is irrelevant. */
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

export const TIERS = [1, 3, 5, 7, 10];

/**
 * Which table the tasks live in. Overridable so a scratch copy can be pointed at
 * without editing code: there is exactly one Supabase project and it holds the
 * real event, so anything that writes needs a way to write somewhere else.
 */
export const TASK_TABLE = process.env.SCAVENGER_TASK_TABLE || "tasks";

/**
 * Column -> the key that column has on a task object.
 *
 * The task object stays camelCase and is what the canvas consumes. This map is
 * the only place the two vocabularies meet.
 */
export const COLUMNS = {
  slug: "slug",
  round: "round",
  doc_title: "docTitle",
  title: "title",
  points: "points",
  scoring_mode: "scoringMode",
  measurement_label: "measurementLabel",
  points_per_unit: "pointsPerUnit",
  doc_order: "docOrder",
  active: "active",
  prop: "prop",
  rewrite: "rewrite",
  note: "note",
};

/** Named explicitly rather than `*`, so a column added later cannot arrive unmapped. */
export const SELECT = ["id", ...Object.keys(COLUMNS)].join(",");

const TASK_KEY_TO_COLUMN = Object.fromEntries(Object.entries(COLUMNS).map(([column, key]) => [key, column]));

/** One ordinary task row, with planning fields named for the canvas. */
export function rowToTask(row) {
  if (!row || typeof row.slug !== "string" || !row.slug) return null;
  const task = {};
  for (const [column, key] of Object.entries(COLUMNS)) {
    const defaults = {
      scoring_mode: "fixed",
      measurement_label: "",
      points_per_unit: 0,
    };
    task[key] = row[column] ?? defaults[column] ?? null;
  }
  // Dormant competition rows can still exist before the cleanup migration.
  task.scoringMode = task.scoringMode === "quantity" ? "quantity" : "fixed";
  return task;
}

const int = (v) => (typeof v === "boolean" ? NaN : Number(v));
const nonNegativeInt = (v) => {
  const n = int(v);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
};
const scoringMode = (v) => (["fixed", "quantity"].includes(v) ? v : undefined);

/**
 * The fields a caller may change, with a validator each. Anything not listed is
 * dropped rather than written.
 *
 * `slug`, `round`, `docTitle` and `docOrder` are deliberately
 * absent. They are identity and provenance: `docTitle` is the planning doc's own
 * wording and the evidence of what a task used to say. A patch that could move a task
 * between rounds is a different operation from
 * editing one -- moving is `moveTask`, which has its own refusals and renumbers
 * `doc_order` to match.
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
  scoringMode,
  measurementLabel: (v) => (typeof v === "string" ? v.trim() : undefined),
  pointsPerUnit: nonNegativeInt,
  // Cut. Never a delete, which would cascade to submissions: a cut task is
  // hidden from players and its scores stand.
  active: (v) => (typeof v === "boolean" ? v : undefined),
  rewrite: (v) => (typeof v === "boolean" ? v : undefined),
};

/**
 * Validates a camelCase patch and returns the columns to write.
 * An empty result means there is nothing legal to write -- not "write nothing to
 * everything".
 */
export function taskPatchToRow(patch) {
  if (patch?.scoringMode !== undefined && !scoringMode(patch.scoringMode)) {
    throw refuse("scoringMode must be fixed or quantity");
  }
  const row = {};
  for (const [key, value] of Object.entries(patch ?? {})) {
    const validate = EDITABLE[key];
    if (!validate) continue;
    const clean = validate(value);
    if (clean !== undefined) row[TASK_KEY_TO_COLUMN[key]] = clean;
  }
  return row;
}

// ── Talking to PostgREST ─────────────────────────────────────────────────────
//
// Deliberately `fetch` and nothing else. This module is in the canvas's import
// graph, and `node_modules` is gitignored -- so a worktree does not have one.
// A top-level `import ... from "@supabase/supabase-js"` here does not fail a
// query, it fails the EXTENSION: the import throws before registration, the
// canvas never appears, and there is nothing on screen to click or to explain
// itself. That happened. Node has had global fetch since 18, the queries here
// are four shapes of CRUD, and the canvas is supposed to work from any session
// -- so the dependency is not worth its cost.

/** Builds the client the queries take. `fetchImpl` is injectable for tests. */
export function createTaskClient(env = loadEnv(), fetchImpl = globalThis.fetch) {
  const url = String(env?.SUPABASE_URL ?? "").replace(/\/+$/, "");
  const key = String(env?.SUPABASE_SERVICE_ROLE_KEY ?? "");
  if (!url || !key) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set, in .env.local or the environment. " +
        "In a worktree they are read from the main checkout, which has to have been set up first."
    );
  }
  return { url, key, fetch: fetchImpl };
}

/**
 * One PostgREST request.
 *
 * Errors carry the response body, because PostgREST puts the useful part there
 * -- a check-constraint violation names the constraint -- and a bare status code
 * on the canvas banner is unactionable.
 */
export async function rest(client, { method = "GET", path, body, prefer }) {
  const headers = {
    apikey: client.key,
    Authorization: `Bearer ${client.key}`,
    Accept: "application/json",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (prefer) headers.Prefer = prefer;

  let res;
  try {
    res = await client.fetch(`${client.url}/rest/v1/${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    // Offline, DNS, a dead project. A thrown fetch must not surface as
    // "undefined" three frames later.
    throw new Error(`could not reach the database: ${String(e?.message ?? e)}`);
  }

  const text = await res.text();
  if (!res.ok) {
    let detail = text.trim();
    try {
      const parsed = JSON.parse(text);
      detail = parsed.message || parsed.error || parsed.hint || detail;
    } catch {
      // Not JSON -- a gateway error page. The raw text is what there is.
    }
    throw new Error(detail || `HTTP ${res.status}`);
  }
  if (!text.trim()) return [];
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("the database returned a response that was not JSON");
  }
}

const eq = (value) => `eq.${encodeURIComponent(value)}`;

/**
 * A refusal: the request was understood and is not allowed, as opposed to
 * something going wrong. Tagged so a caller can answer 409 rather than 500 --
 * "this cannot be done" and "the database is unreachable" must not look alike.
 */
const refuse = (message) => Object.assign(new Error(message), { refusal: true });

// ── Queries ──────────────────────────────────────────────────────────────────

/**
 * Every ordinary task, including cuts.
 *
 * Read fresh every time, with no cache. The cache this replaces was the cause of
 * its own bug -- a process served its first read forever and wrote that stale
 * copy back over whatever another session had done since. Any session can edit
 * the task list, so "the copy I loaded" is never a safe thing to hold.
 *
 * @returns {Promise<{tasks: object[]}>}
 */
export async function readTasks(client) {
  // Historical shared-slug secret rows stay in the database but never enter
  // this editor, including its cut list or any write path.
  const rows = await rest(client, {
    path: `${TASK_TABLE}?select=${SELECT}&is_secret=eq.false&order=round.asc,doc_order.asc,slug.asc,id.asc`,
  }).catch((e) => {
    throw new Error(`could not read the task list: ${e.message}`);
  });
  return { tasks: (Array.isArray(rows) ? rows : []).map(rowToTask).filter(Boolean) };
}

/**
 * Writes only the fields that changed, on the rows of one task.
 *
 * Per-field rather than whole-list on purpose. Saving everything is what let one
 * process overwrite another's unrelated edits; patching named columns of a named
 * slug makes that impossible rather than unlikely. Two people editing different
 * tasks -- or different fields of the same task -- no longer interact at all,
 * and last-write-wins on the same field is the only remaining race, which is the
 * expected one.
 *
 * @returns {Promise<object|null>} the updated task, or null if the slug is unknown.
 */
export async function updateTask(client, slug, patch) {
  if (typeof slug !== "string" || !slug) return null;
  const row = taskPatchToRow(patch);

  // Nothing legal to write. Still a read, so the caller can tell "no such task"
  // from "nothing to do" -- returning the task unchanged is the honest answer,
  // and an empty UPDATE would move updated_at for an edit nobody made.
  if (!Object.keys(row).length) {
    const found = await rest(client, { path: `${TASK_TABLE}?select=${SELECT}&is_secret=eq.false&slug=${eq(slug)}` }).catch((e) => {
      throw new Error(`could not read task ${slug}: ${e.message}`);
    });
    return rowToTask(found[0]);
  }

  const updated = await rest(client, {
    method: "PATCH",
    path: `${TASK_TABLE}?slug=${eq(slug)}&is_secret=eq.false&select=${SELECT}`,
    body: { ...row, updated_at: new Date().toISOString() },
    prefer: "return=representation",
  }).catch((e) => {
    throw new Error(`could not update task ${slug}: ${e.message}`);
  });
  return rowToTask(updated[0]);
}

/**
 * Moves a task to the other half of the event.
 *
 * Its own operation rather than a field on `updateTask`, because `round` is not
 * content: it decides which half a task is offered in, it is half of what makes
 * a task's rows unique, and changing it has to renumber `doc_order` as well.
 * Those are refusals and a second write, neither of which belongs in a
 * per-field patch.
 *
 * It moves a task that has not been played yet, and nothing else. `team_scores`
 * would survive a move -- a submission carries its own `round`, `team_id` and
 * `task_points`, snapshotted at insert -- but the screens that show that history
 * would not: `/api/judge/queue`, `/api/state` and `/api/feed` all read
 * `tasks ... eq(round, round)` and look each submission's task up in that map,
 * so a task that has left the round renders as "(deleted task)" in the judge's
 * queue and as a blank title in the feed, with a pending submission stranded
 * behind it. What already happened is never
 * rewritten because a move that would strand it does not happen.
 *
 * @returns {Promise<object|null>} the moved task, or null if the slug is unknown.
 */
export async function moveTask(client, slug, round) {
  if (typeof slug !== "string" || !slug) return null;
  // `int` rather than `Number`, so a boolean cannot arrive as a round: JSON
  // `true` is Number 1, and a request asking to move a task to `true` must be
  // refused rather than quietly answered with Round 1.
  const target = int(round);
  if (![1, 2].includes(target)) throw refuse("a task can only be moved to Round 1 or Round 2");

  // One read across both rounds, because the destination's highest doc_order is needed
  // as well as this task's own rows -- the same shape `addTask` uses.
  const rows = await rest(client, {
    path: `${TASK_TABLE}?select=id,slug,round,doc_order&is_secret=eq.false`,
  }).catch((e) => {
    throw new Error(`could not move task ${slug}: ${e.message}`);
  });

  const mine = rows.filter((r) => r.slug === slug);
  if (!mine.length) return null;

  const current = mine[0];
  // Already there. Still a read, so the caller gets the task back rather than a
  // silent no-op -- and no empty UPDATE to bump updated_at for an edit nobody
  // made, and no renumbering of a doc_order that is already correct. Ahead of
  // the refusals below on purpose: a task that is not moving cannot be refused
  // permission to move.
  if (Number(current.round) === target) {
    const found = await rest(client, { path: `${TASK_TABLE}?select=${SELECT}&is_secret=eq.false&slug=${eq(slug)}` }).catch((e) => {
      throw new Error(`could not read task ${slug}: ${e.message}`);
    });
    return rowToTask(found[0]);
  }

  // Anything already submitted against this task pins it to the round it is in.
  // The judge's queue, the player's task list and the feed all resolve a
  // submission's task out of the tasks for THAT round, so moving the row leaves
  // real evidence with no task behind it: "(deleted task)" in the queue, a blank
  // title in the feed, and a pending submission the judge can no longer read.
  // Cheaper to refuse than to teach three screens to look across rounds.
  const played = await rest(client, {
    path: `submissions?select=id&task_id=${eq(current.id)}&limit=1`,
  }).catch((e) => {
    throw new Error(`could not move task ${slug}: ${e.message}`);
  });
  if (played.length) {
    throw refuse(
      `Someone has already submitted this task in Round ${current.round}, and the judge's queue and the ` +
        "feed look a submission's task up in the round it was submitted in. Moving it would leave that " +
        "evidence with no task behind it. Cut it and add a replacement in the round you want instead."
    );
  }

  // Last in the round it arrives in. doc_order is the tie-break inside a tier,
  // and the number it carried from the other round was never ordered against
  // this one -- it could land mid-list, or share a sort_order with a task that
  // is already there and swap places with it between polls.
  const lastOrder = rows
    .filter((r) => Number(r.round) === target)
    .reduce((max, r) => Math.max(max, Number(r.doc_order) || 0), 0);

  const moved = await rest(client, {
    method: "PATCH",
    path: `${TASK_TABLE}?slug=${eq(slug)}&is_secret=eq.false&select=${SELECT}`,
    body: { round: target, doc_order: lastOrder + 1, updated_at: new Date().toISOString() },
    prefer: "return=representation",
  }).catch((e) => {
    throw new Error(`could not move task ${slug}: ${e.message}`);
  });
  return rowToTask(moved[0]);
}

/**
 * Adds a task, live.
 *
 * The slug is allocated by looking at what is already there, which is a read
 * followed by a write and therefore racy in principle. The insert is the
 * arbiter: (round, slug) is unique, so a genuinely simultaneous add fails loudly
 * on the duplicate instead of overwriting the other one.
 */
export async function addTask(client, input) {
  const round = int(input?.round);
  if (![1, 2].includes(round)) throw refuse("a task must be assigned to Round 1 or Round 2");
  if (input?.isSecret === true) throw refuse("secret tasks are no longer supported");
  const details = taskPatchToRow(input);
  const prefix = `r${round}`;
  const existing = await rest(client, { path: `${TASK_TABLE}?select=slug,round,doc_order&is_secret=eq.false` }).catch((e) => {
    throw new Error(`could not read the task list: ${e.message}`);
  });
  const taken = new Set(existing.map((r) => r.slug));
  let n = 1;
  while (taken.has(`${prefix}-x${n}`)) n += 1;

  // Last in its tier. Allocated the same way Admin allocates it -- highest plus
  // one -- because the two must not be able to pick the same number: doc_order
  // is the tie-break inside a tier, and two tasks sharing a sort_order would
  // swap places between polls in the player's list.
  const lastOrder = existing
    .filter((r) => Number(r.round) === round)
    .reduce((max, r) => Math.max(max, Number(r.doc_order) || 0), 0);

  const row = {
    slug: `${prefix}-x${n}`,
    // Empty is what marks a task as not having come from the planning doc.
    doc_title: "",
    title: String(input?.title ?? "").trim() || "Untitled task",
    points: TIERS.includes(int(input?.points)) ? int(input.points) : 3,
    doc_order: lastOrder + 1,
    round,
    active: true,
    scoring_mode: "fixed",
    note: typeof input?.note === "string" ? input.note : "",
    ...details,
  };

  const created = await rest(client, {
    method: "POST",
    path: `${TASK_TABLE}?select=${SELECT}`,
    body: [row],
    prefer: "return=representation",
  }).catch((e) => {
    throw new Error(`could not add a task: ${e.message}`);
  });
  return rowToTask(created[0]);
}

// ── Finding the credentials ──────────────────────────────────────────────────

/**
 * The main checkout, or null.
 *
 * A worktree has no `.env.local` and no `node_modules` -- both are gitignored,
 * so they exist only where someone actually set the app up. Git names the
 * difference without an absolute path baked in: `--git-dir` and
 * `--git-common-dir` are the same in the main checkout and diverge in a linked
 * worktree, where the common dir points back at the main one.
 *
 * The only question this answers is where the credentials live, and being wrong
 * about that fails loudly at connect time.
 */
export function mainCheckout(startDir, run = gitRun) {
  const gitDir = run(["rev-parse", "--git-dir"], startDir);
  const commonDir = run(["rev-parse", "--git-common-dir"], startDir);
  // No git, not a repo, or a git too old for --git-common-dir, which echoes the
  // flag back instead of failing.
  if (!gitDir || !commonDir || commonDir.startsWith("-")) return null;
  const common = resolve(startDir, commonDir);
  if (resolve(startDir, gitDir) === common) return null; // already the main checkout
  return basename(common) === ".git" ? dirname(common) : null;
}

function gitRun(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function parseEnvFile(path) {
  try {
    return Object.fromEntries(
      readFileSync(path, "utf8")
        .split("\n")
        .filter((l) => l.trim() && !l.trim().startsWith("#") && l.includes("="))
        .map((l) => {
          const i = l.indexOf("=");
          return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
        })
    );
  } catch {
    return null;
  }
}

/** The credentials this module needs, whichever of them are set. */
const NEEDED = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY", "SUPABASE_BUCKET", "ORGANIZER_PIN"];

/**
 * Credentials, from the first place that has them.
 *
 * An exported variable wins, then this checkout's `.env.local`, then the main
 * checkout's -- which is what makes a worktree session work at all. Absence is
 * an empty object rather than a throw: the canvas has to be able to open and say
 * what is wrong, and an extension that throws while loading says nothing.
 */
export function loadEnv({ cwd = REPO_ROOT, mainCheckout: main, env = process.env } = {}) {
  const found = {};
  const fromFile =
    parseEnvFile(join(cwd, ".env.local")) ??
    parseEnvFile(join(main ?? mainCheckout(cwd) ?? cwd, ".env.local")) ??
    {};
  for (const key of NEEDED) {
    const value = env?.[key] || fromFile[key];
    if (value) found[key] = value;
  }
  return found;
}

/**
 * The Supabase client, for the callers that query the rest of the schema.
 *
 * Imported dynamically so this module stays loadable without `node_modules`.
 * Only `ready` and `seed` reach for it, and both already require a full checkout
 * to run at all.
 */
export async function createAdminClient(env = loadEnv()) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local");
  }
  const { createClient } = await import("@supabase/supabase-js");
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}
