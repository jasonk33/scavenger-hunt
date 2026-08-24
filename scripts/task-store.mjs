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
 * disagreeing. Everything the board added on top of those four fields -- the
 * ratings, the notes, the props -- is never shown to a player at all, so there
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
export const RATINGS = ["difficulty", "guts", "luck", "payoff", "risk"];

/**
 * Which table the tasks live in. Overridable so a scratch copy can be pointed at
 * without editing code: there is exactly one Supabase project and it holds the
 * real event, so anything that writes needs a way to write somewhere else.
 */
export const TASK_TABLE = process.env.SCAVENGER_TASK_TABLE || "tasks";

/** Where the tier model is kept in the key/value `settings` table. */
export const MODEL_KEY = "tier_model";

/**
 * Column -> the key that column has on a task object.
 *
 * The task object stays camelCase and is what the canvas consumes. This map is
 * the only place the two vocabularies meet.
 *
 * `round` is deliberately absent: it is derived, not copied. See `rowsToTask`.
 */
export const COLUMNS = {
  slug: "slug",
  doc_title: "docTitle",
  title: "title",
  points: "points",
  scoring_mode: "scoringMode",
  measurement_label: "measurementLabel",
  measurement_threshold: "measurementThreshold",
  points_per_unit: "pointsPerUnit",
  measurement_cap: "measurementCap",
  competition_bonus: "competitionBonus",
  doc_order: "docOrder",
  difficulty: "difficulty",
  guts: "guts",
  luck: "luck",
  payoff: "payoff",
  risk: "risk",
  requires_video: "requiresVideo",
  is_secret: "isSecret",
  active: "active",
  prop: "prop",
  rewrite: "rewrite",
  note: "note",
  tier_ok: "tierOk",
};

/** Named explicitly rather than `*`, so a column added later cannot arrive unmapped. */
export const SELECT = ["id", "round", ...Object.keys(COLUMNS)].join(",");

const TASK_KEY_TO_COLUMN = Object.fromEntries(Object.entries(COLUMNS).map(([column, key]) => [key, column]));

/**
 * The rows sharing one slug, as the single task the canvas edits.
 *
 * A secret challenge is offered in BOTH halves of the event, and `tasks.round`
 * is `check (round in (1, 2))`, so it is stored as two rows that share a slug.
 * That is the only reason grouping exists, and it is why `round` is presented as
 * 0 for a secret rather than read off a row: 0 means "both", which is the thing
 * the planner is actually deciding about. Every other task is a single row and
 * groups to itself.
 *
 * @param {object[]} rows  one or more rows, all with the same slug
 */
export function rowsToTask(rows) {
  const [first] = rows ?? [];
  if (!first) return null;
  const task = {};
  for (const [column, key] of Object.entries(COLUMNS)) {
    const defaults = {
      scoring_mode: "fixed",
      measurement_label: "",
      measurement_threshold: 0,
      points_per_unit: 0,
      measurement_cap: null,
      competition_bonus: 0,
    };
    task[key] = first[column] ?? defaults[column] ?? null;
  }
  task.round = first.is_secret ? 0 : first.round;
  // Which rows this task actually is. Nothing in the UI reads it; it is here so
  // a caller can tell a secret from a normal task without re-querying.
  task.rowIds = rows.map((r) => r.id);
  return task;
}

/** Groups rows by slug, preserving the order the first row of each slug arrived in. */
export function groupRows(rows) {
  const bySlug = new Map();
  for (const row of rows ?? []) {
    if (!row || typeof row.slug !== "string" || !row.slug) continue;
    const group = bySlug.get(row.slug);
    if (group) group.push(row);
    else bySlug.set(row.slug, [row]);
  }
  return [...bySlug.values()].map(rowsToTask);
}

const int = (v) => (typeof v === "boolean" ? NaN : Number(v));
const rating = (v) => {
  const n = int(v);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : undefined;
};
const nonNegativeInt = (v) => {
  const n = int(v);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
};
const scoringMode = (v) => (["fixed", "quantity", "competition"].includes(v) ? v : undefined);

/**
 * The fields a caller may change, with a validator each. Anything not listed is
 * dropped rather than written.
 *
 * `slug`, `round`, `isSecret`, `docTitle` and `docOrder` are deliberately
 * absent. They are identity and provenance: `docTitle` is the planning doc's own
 * wording and the evidence of what a task used to say, and slug/round/isSecret
 * together decide how many rows a task is. A patch that could move a task
 * between rounds, or turn one row into two, is a different operation from
 * editing one -- and `revealed_at` is not here either, because revealing a
 * secret is per-round and belongs to Admin on the day.
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
  measurementThreshold: nonNegativeInt,
  pointsPerUnit: nonNegativeInt,
  measurementCap: (v) => (v === null ? null : nonNegativeInt(v)),
  competitionBonus: nonNegativeInt,
  // Cut. Never a delete, which would cascade to submissions: a cut task is
  // hidden from players and its scores stand.
  active: (v) => (typeof v === "boolean" ? v : undefined),
  requiresVideo: (v) => (typeof v === "boolean" ? v : undefined),
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
 * tasks it already had. Arbitrary cutoffs would flag half the list and the
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
 * whole list without anything looking broken.
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

// ── Queries ──────────────────────────────────────────────────────────────────

/**
 * Every task plus the tier model.
 *
 * Read fresh every time, with no cache. The cache this replaces was the cause of
 * its own bug -- a process served its first read forever and wrote that stale
 * copy back over whatever another session had done since. Any session can edit
 * the task list, so "the copy I loaded" is never a safe thing to hold.
 *
 * @returns {Promise<{model: object, tasks: object[]}>}
 */
export async function readTasks(client) {
  const [rows, model] = await Promise.all([
    rest(client, {
      // Secrets last, then by tier and by the planning doc's own order, which is
      // what the canvas lists in and what groups a secret's two rows together.
      path: `${TASK_TABLE}?select=${SELECT}&order=is_secret.asc,round.asc,doc_order.asc,slug.asc,id.asc`,
    }).catch((e) => {
      throw new Error(`could not read the task list: ${e.message}`);
    }),
    readModel(client),
  ]);
  return { model, tasks: groupRows(Array.isArray(rows) ? rows : []) };
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
 * Filtering on the slug rather than a row id is also what keeps a secret's two
 * rounds in step: one statement, both rows, no window in which they disagree.
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
    const found = await rest(client, { path: `${TASK_TABLE}?select=${SELECT}&slug=${eq(slug)}` }).catch((e) => {
      throw new Error(`could not read task ${slug}: ${e.message}`);
    });
    return groupRows(found)[0] ?? null;
  }

  const updated = await rest(client, {
    method: "PATCH",
    path: `${TASK_TABLE}?slug=${eq(slug)}&select=${SELECT}`,
    body: { ...row, updated_at: new Date().toISOString() },
    prefer: "return=representation",
  }).catch((e) => {
    throw new Error(`could not update task ${slug}: ${e.message}`);
  });
  return groupRows(updated)[0] ?? null;
}

/**
 * Adds a task, live.
 *
 * A secret (`round: 0`) is inserted once per round, sharing a slug -- the fan-out
 * the old publish step used to do. Both rows go in one request so a task can
 * never exist in half the event.
 *
 * The slug is allocated by looking at what is already there, which is a read
 * followed by a write and therefore racy in principle. The insert is the
 * arbiter: (round, slug) is unique, so a genuinely simultaneous add fails loudly
 * on the duplicate instead of overwriting the other one.
 */
export async function addTask(client, input) {
  const round = [0, 1, 2].includes(Number(input?.round)) ? Number(input.round) : 1;
  const prefix = round === 0 ? "s" : `r${round}`;
  const existing = await rest(client, { path: `${TASK_TABLE}?select=slug,round,doc_order` }).catch((e) => {
    throw new Error(`could not read the task list: ${e.message}`);
  });
  const taken = new Set(existing.map((r) => r.slug));
  let n = 1;
  while (taken.has(`${prefix}-x${n}`)) n += 1;

  // Last in its tier. Allocated the same way Admin allocates it -- highest plus
  // one -- because the two must not be able to pick the same number: doc_order
  // is the tie-break inside a tier, and two tasks sharing a sort_order would
  // swap places between polls in the player's list.
  const rounds = round === 0 ? [1, 2] : [round];
  const lastOrder = existing
    .filter((r) => rounds.includes(Number(r.round)))
    .reduce((max, r) => Math.max(max, Number(r.doc_order) || 0), 0);

  const shared = {
    slug: `${prefix}-x${n}`,
    // Empty is what marks a task as not having come from the planning doc.
    doc_title: "",
    title: String(input?.title ?? "").trim() || "Untitled task",
    points: TIERS.includes(Number(input?.points)) ? Number(input.points) : round === 0 ? 7 : 3,
    doc_order: lastOrder + 1,
    is_secret: round === 0,
    active: true,
    note: typeof input?.note === "string" ? input.note : "",
    ...taskPatchToRow(
      Object.fromEntries([
        ...RATINGS.map((k) => [k, input?.[k]]),
        ["scoringMode", input?.scoringMode],
        ["measurementLabel", input?.measurementLabel],
        ["measurementThreshold", input?.measurementThreshold],
        ["pointsPerUnit", input?.pointsPerUnit],
        ["measurementCap", input?.measurementCap],
        ["competitionBonus", input?.competitionBonus],
      ])
    ),
  };

  const created = await rest(client, {
    method: "POST",
    path: `${TASK_TABLE}?select=${SELECT}`,
    body: rounds.map((r) => ({ ...shared, round: r })),
    prefer: "return=representation",
  }).catch((e) => {
    throw new Error(`could not add a task: ${e.message}`);
  });
  return groupRows(created)[0] ?? null;
}

/** Merges a partial model into the stored one and returns the result. */
export async function updateModel(client, patch) {
  const current = await readModel(client);
  const merged = parseModel({
    weights: { ...current.weights, ...(patch?.weights ?? {}) },
    thresholds: { ...current.thresholds, ...(patch?.thresholds ?? {}) },
  });
  await rest(client, {
    method: "POST",
    path: "settings",
    body: { key: MODEL_KEY, value: JSON.stringify(merged) },
    prefer: "resolution=merge-duplicates,return=minimal",
  }).catch((e) => {
    throw new Error(`could not save the tier model: ${e.message}`);
  });
  return merged;
}

export async function readModel(client) {
  // A missing row is a working list on the defaults, so only a real failure is
  // worth raising -- a canvas that refuses to open over one absent settings row
  // would be a canvas nobody can use.
  const rows = await rest(client, { path: `settings?select=value&key=${eq(MODEL_KEY)}` }).catch((e) => {
    throw new Error(`could not read the tier model: ${e.message}`);
  });
  return parseModel(rows[0]?.value);
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
