#!/usr/bin/env node
/**
 * Publishes the planning board to the app.
 *
 *   npm run sync:tasks           show what would change, write nothing
 *   npm run sync:tasks -- --apply  actually write it
 *   npm run sync:tasks -- --json   the same run as one JSON object on stdout
 *
 * `data/task-board.json` is the source of truth for task content, points and
 * cuts; this is the only thing that carries it into Supabase. It is deliberately
 * separate from `npm run seed`, which clears every submission and every media
 * file: re-tiering a task an hour before the party has to be safe, so this
 * touches nothing but the `tasks` table -- never submissions, storage, players,
 * the roster, the settings, or `revealed_at`.
 *
 * The planner is a pure function so the decisions that matter can be tested
 * against fixtures instead of against the one shared project. See
 * `scripts/task-sync.test.mjs`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Tasks are ordered for players by tier, with the secrets last. */
const secretsLast = (row) => [row.is_secret ? 1 : 0, row.points, row.docOrder];

/**
 * The board and the app disagree about punctuation in ways that are invisible on
 * screen: curly vs straight quotes, em dash vs hyphen, stray double spaces. Only
 * used for the pre-migration title fallback and the duplicate check -- the real
 * key is `board_id`.
 */
export function normalizeTitle(value) {
  return String(value ?? "")
    .normalize("NFC")
    .replace(/[\u2018\u2019\u02BC]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2014\u2013]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * What a player should actually read. `title` is the reworded version and wins;
 * `docTitle` is the original wording kept for provenance, and is empty on tasks
 * added straight into the canvas.
 */
export function effectiveTitle(task) {
  return String(task?.title || task?.docTitle || "").trim();
}

/**
 * Expands the board into the rows the `tasks` table should hold.
 *
 * A secret sits at `round: 0` on the board -- one entry, offered in both halves
 * of the event -- but `tasks.round` is `check (round in (1, 2))`, so it cannot be
 * stored that way and becomes one row per round. That is the whole of the
 * 76-vs-79 difference between the board and the original inline seed.
 *
 * `status: "cut"` still produces a row, marked `wanted: false`, because the
 * planner needs to know a cut task exists in order to deactivate it.
 */
export function desiredRows(board, warnings = []) {
  const rows = [];
  for (const task of board?.tasks ?? []) {
    if (!task || typeof task.id !== "string" || !task.id) {
      warnings.push(`board entry skipped: no usable id (${JSON.stringify(task?.id ?? null)})`);
      continue;
    }
    const rawRound = Number(task.round);
    if (![0, 1, 2].includes(rawRound)) {
      warnings.push(`board task ${task.id} skipped: round ${JSON.stringify(task.round)} is not 0, 1 or 2`);
      continue;
    }
    // Number(undefined) is NaN, which serializes to null against a `points not
    // null` column and compares unequal to itself -- so it would be proposed
    // again on every run without ever landing.
    const points = Number(task.points);
    if (!Number.isFinite(points)) {
      warnings.push(`board task ${task.id} skipped: points ${JSON.stringify(task.points)} is not a number`);
      continue;
    }
    const isSecret = rawRound === 0;
    for (const round of isSecret ? [1, 2] : [rawRound]) {
      rows.push({
        board_id: task.id,
        round,
        title: effectiveTitle(task),
        docTitle: String(task.docTitle ?? "").trim(),
        points,
        requires_video: Boolean(task.needsClip),
        is_secret: isSecret,
        docOrder: Number(task.docOrder) || 0,
        status: task.status,
        wanted: task.status !== "cut",
      });
    }
  }

  // Only the rows that stay live get a position; a cut task is on its way out.
  for (const round of [1, 2]) {
    rows
      .filter((r) => r.round === round && r.wanted)
      .sort((a, b) => {
        const [as, ap, ad] = secretsLast(a);
        const [bs, bp, bd] = secretsLast(b);
        return as - bs || ap - bp || ad - bd || a.board_id.localeCompare(b.board_id);
      })
      .forEach((row, i) => {
        row.sort_order = (i + 1) * 10;
      });
  }
  return rows;
}

/** The columns the board owns. Everything else on the row is the app's business. */
const OWNED = ["title", "points", "requires_video", "is_secret", "sort_order"];

/**
 * True when an update changes nothing a player could see.
 *
 * `sort_order` is dense -- `(i + 1) * 10` over the live tasks only -- so cutting
 * one task renumbers every task below it. Two real cuts produced 31 updates, 29
 * of which were renumbering, and the preview listed all 31 directly above a live
 * write button. Reordering is still published; it just stops being counted and
 * itemized as though someone had decided something.
 *
 * `board_id` is migration bookkeeping rather than anything a player sees, so it
 * does not promote a slot move into a content change, and a patch that is
 * nothing but a link write is not a change either. Every other field is.
 */
const INVISIBLE = new Set(["sort_order", "board_id"]);

export function isReorderOnly(update) {
  const keys = Object.keys(update?.patch ?? {});
  if (!keys.length) return false;
  return keys.every((k) => INVISIBLE.has(k));
}

/**
 * Works out what would have to change for the app to match the board.
 *
 * Nothing here can express a deletion. A task that is cut is deactivated
 * instead: `/api/state` filters on `active` so players stop seeing it and
 * `/api/submissions` refuses new uploads, but `/api/judge/queue` deliberately
 * does not filter, so anything already in the queue stays judgeable rather than
 * stranding a judge mid-decision. Scores are unaffected either way -- the
 * `team_scores` view reads only `submissions` and its denormalized
 * `points_awarded`, and never joins `tasks`.
 *
 * @param {{tasks: object[]}} board          parsed task-board.json
 * @param {object[]} liveRows                rows from the tasks table
 * @param {{submissionCounts?: Record<string, number>}} [opts]
 */
export function planTaskSync(board, liveRows, opts = {}) {
  const counts = opts.submissionCounts ?? {};
  const warnings = [];
  const rows = desiredRows(board, warnings);
  const insert = [];
  const update = [];
  const deactivate = [];
  const reactivate = [];

  const key = (round, boardId) => `${round}|${boardId}`;
  const byKey = new Map();
  const unlinked = [];
  for (const row of liveRows ?? []) {
    if (row.board_id) byKey.set(key(row.round, row.board_id), row);
    else unlinked.push(row);
  }

  if (unlinked.length) {
    warnings.push(
      `${unlinked.length} live task row(s) have no board_id -- run supabase/migrate-task-board-id.sql. ` +
        `Falling back to title matching for those rows.`
    );
  }

  // Pre-migration, or after a row was added through Admin, the link has to be
  // re-derived from the text. The live row still holds the ORIGINAL wording, so
  // the original has to be tried too: eight tasks have been reworded on the
  // board, and matching only on the new wording would miss all eight and insert
  // a second copy of each -- which unique (round, title) cannot catch, because
  // the two titles genuinely differ. Matching on prose is exactly what board_id
  // exists to stop, so this is a fallback only and the match is written back.
  const claimed = new Set();
  const matchUnlinked = (row) => {
    const candidates = [normalizeTitle(row.title), normalizeTitle(row.docTitle)].filter(Boolean);
    for (const wanted of candidates) {
      const hit = unlinked.find(
        (l) => !claimed.has(l.id) && l.round === row.round && normalizeTitle(l.title) === wanted
      );
      if (hit) {
        claimed.add(hit.id);
        return hit;
      }
    }
    return undefined;
  };

  for (const row of rows) {
    const linked = byKey.get(key(row.round, row.board_id));
    const current = linked ?? matchUnlinked(row);

    if (!row.wanted) {
      // Still worth linking: a row matched only by its title would otherwise
      // stay unlinked forever and keep raising the migration warning.
      if (current && !current.board_id) {
        update.push({
          id: current.id,
          board_id: row.board_id,
          round: row.round,
          title: current.title,
          patch: { board_id: row.board_id },
        });
      }
      if (current?.active) {
        deactivate.push({ id: current.id, board_id: row.board_id, round: row.round, title: current.title });
        const n = counts[current.id] ?? 0;
        if (n > 0) {
          warnings.push(
            `"${current.title}" is cut on the board but has ${n} submission(s). ` +
              `It will be hidden, not deleted, and any points already awarded stand.`
          );
        }
      }
      continue;
    }

    if (!current) {
      insert.push({
        board_id: row.board_id,
        round: row.round,
        title: row.title,
        points: row.points,
        requires_video: row.requires_video,
        is_secret: row.is_secret,
        sort_order: row.sort_order,
        active: true,
      });
      continue;
    }

    const patch = {};
    if (!current.board_id) patch.board_id = row.board_id;
    for (const field of OWNED) if (current[field] !== row[field]) patch[field] = row[field];

    if (!current.active) {
      reactivate.push({
        id: current.id,
        board_id: row.board_id,
        round: row.round,
        title: current.title,
        patch: { ...patch, active: true },
      });
    } else if (Object.keys(patch).length) {
      update.push({ id: current.id, board_id: row.board_id, round: row.round, title: current.title, patch });
    }
  }

  const known = new Set(rows.map((r) => key(r.round, r.board_id)));
  for (const row of liveRows ?? []) {
    if (row.board_id && !known.has(key(row.round, row.board_id))) {
      warnings.push(
        `live task "${row.title}" (board_id ${row.board_id}, round ${row.round}) is not on the board. ` +
          `Left untouched -- remove it from Admin if it is genuinely dead.`
      );
    }
  }

  const maybes = [...new Set(rows.filter((r) => r.status === "maybe").map((r) => r.board_id))];
  if (maybes.length) {
    warnings.push(
      `${maybes.length} task(s) are still "maybe" on the board and are being published as live: ${maybes.join(", ")}`
    );
  }

  // unique (round, title) is still on the table, so a collision has to surface
  // here rather than as an opaque Postgres error halfway through an --apply.
  //
  // Comparing board rows against each other is not enough: a deactivated row
  // keeps its title, so re-adding a cut task as a NEW board entry -- the natural
  // move in the canvas -- collides with a row the board no longer mentions.
  // What matters is the state the table would be left in, so model that: every
  // live row under the title it would end up with, plus every planned insert.
  const finalTitle = new Map();
  for (const u of [...update, ...reactivate]) if (u.patch.title !== undefined) finalTitle.set(u.id, u.patch.title);

  const endState = [];
  for (const row of liveRows ?? []) {
    endState.push({
      round: row.round,
      title: finalTitle.has(row.id) ? finalTitle.get(row.id) : row.title,
      label: row.board_id ? `board_id ${row.board_id}` : `existing row "${row.title}"`,
    });
  }
  for (const row of insert) endState.push({ round: row.round, title: row.title, label: `new task ${row.board_id}` });

  const collisions = [];
  const holder = new Map();
  for (const entry of endState) {
    const k = key(entry.round, normalizeTitle(entry.title));
    const first = holder.get(k);
    if (first) {
      collisions.push({ round: entry.round, title: entry.title, between: [first.label, entry.label] });
      warnings.push(
        `title collision in round ${entry.round}: ${first.label} and ${entry.label} would both read ` +
          `"${entry.title}". unique (round, title) would reject this, so nothing will be published ` +
          `until one of them changes.`
      );
    } else holder.set(k, entry);
  }

  return { insert, update, deactivate, reactivate, warnings, collisions };
}

// ---------------------------------------------------------------------------
// Everything below is the Supabase side and only runs when this file is the
// entry point, so importing the planner in a test never opens a connection.
// ---------------------------------------------------------------------------

export const BOARD_PATH = new URL("../data/task-board.json", import.meta.url);

/**
 * The board and the app must be read from the same checkout. In a linked
 * worktree they are not: the worktree holds its own committed copy of
 * `data/task-board.json`, which is older than whatever is being edited in the
 * main checkout -- and there is only ever one Supabase project behind all of
 * them. So a run there computes a plan from a stale board and publishes it,
 * quietly reverting live tasks while reporting success. It fails silently and in
 * the wrong direction, so both the dry run and `--apply` refuse.
 *
 * The scavenger-tasks canvas resolves the board relative to itself for the same
 * reason, which means a canvas opened in a worktree session edits that
 * worktree's board -- edits nobody publishes and the worktree throws away. The
 * canvas surfaces this refusal rather than repeating the check, so both halves
 * are governed by this one function.
 *
 * Git separates the two with no absolute path baked in: `--git-dir` and
 * `--git-common-dir` name the same directory in the main checkout and diverge in
 * a linked worktree. Pure, so every branch is provable from a fixture.
 *
 * @returns {string|null} the refusal, or null when the board is the canonical one.
 */
export function worktreeRefusal({ gitDir, gitCommonDir, cwd, boardPath }) {
  // No git, not a repo, or a git too old for --git-common-dir (which echoes the
  // flag back instead of failing). Refusing here would break a fresh clone.
  if (!gitDir || !gitCommonDir || gitCommonDir.startsWith("-")) return null;
  const common = resolve(cwd, gitCommonDir);
  if (resolve(cwd, gitDir) === common) return null;

  const root = basename(common) === ".git" ? dirname(common) : null;
  const canonical = root ? join(root, "data", "task-board.json") : "(main checkout not locatable)";
  return (
    `refusing to run: this is a linked git worktree.\n` +
    `  would read: ${boardPath}\n` +
    `  canonical:  ${canonical}\n` +
    `The scavenger-tasks canvas writes the board by absolute path into the main checkout, ` +
    `so edits made there are invisible here and this run would publish a stale board over ` +
    `live tasks. Run it from the main checkout -- use a branch session rather than a ` +
    `worktree for task work. TASK_SYNC_ALLOW_WORKTREE=1 overrides deliberately.`
  );
}

/** Asks git about this script's own directory, since BOARD_PATH is relative to it. */
function checkoutRefusal() {
  if (process.env.TASK_SYNC_ALLOW_WORKTREE) return null;
  const cwd = dirname(fileURLToPath(import.meta.url));
  let dirs = [];
  try {
    dirs = execFileSync("git", ["rev-parse", "--git-dir", "--git-common-dir"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\n")
      .map((l) => l.trim());
  } catch {
    // No git binary, or not a repo at all. Nothing to check against.
  }
  return worktreeRefusal({
    gitDir: dirs[0],
    gitCommonDir: dirs[1],
    cwd,
    boardPath: fileURLToPath(BOARD_PATH),
  });
}

export function loadBoard() {
  return JSON.parse(readFileSync(BOARD_PATH, "utf8"));
}

/**
 * Reads the task rows, tolerating a database where migrate-task-board-id.sql has
 * not been run yet: selecting a column that does not exist fails outright, so
 * fall back and let the planner match on titles. Every unlinked row is warned
 * about, so this cannot pass unnoticed.
 */
export async function fetchTaskRows(db, extra = "") {
  return (await readTasks(db, extra)).rows;
}

/**
 * @returns {{rows: object[], migrated: boolean}} `migrated` is false when the
 * board_id column is not there yet, which is the signal that
 * migrate-task-board-id.sql still needs running.
 */
async function readTasks(db, extra = "") {
  const columns = `id,round,title,points,requires_video,is_secret,sort_order,active${extra}`;
  let { data, error } = await db.from("tasks").select(`${columns},board_id`);
  if (error?.message?.includes("board_id")) {
    ({ data, error } = await db.from("tasks").select(columns));
    if (!error) return { rows: data ?? [], migrated: false };
  }
  if (error) throw new Error(`could not read tasks: ${error.message}`);
  return { rows: data ?? [], migrated: true };
}

/** Reads the board and the live table and returns the plan. Read-only. */
export async function buildPlan(db) {
  const { rows, migrated } = await readTasks(db);
  const { data: subs } = await db.from("submissions").select("task_id");
  const submissionCounts = {};
  for (const s of subs ?? []) submissionCounts[s.task_id] = (submissionCounts[s.task_id] ?? 0) + 1;

  return { plan: planTaskSync(loadBoard(), rows, { submissionCounts }), live: rows, migrated };
}

/**
 * Applies a plan. Only ever writes to `tasks`.
 *
 * Refuses outright if the board_id column is missing. Every insert and update
 * carries a board_id, so an unmigrated database would reject the first write and
 * leave the rest unapplied -- a half-published task list, which is precisely the
 * state that cannot be allowed to happen on the day.
 */
/**
 * Applies a plan. Only ever writes to `tasks`.
 *
 * Refuses if the board_id column is missing, or if the plan carries a title
 * collision. Every insert and update carries a board_id, so an unmigrated
 * database would reject the first write and leave the rest unapplied -- a
 * half-published task list, which is precisely the state that cannot be allowed
 * to happen on the day. A collision would do the same thing for a different
 * reason, so both are caught before anything is written.
 */
export async function applyPlan(db, plan, { migrated = true } = {}) {
  if (!migrated) {
    throw new Error(
      "tasks.board_id does not exist -- run supabase/migrate-task-board-id.sql first. " +
        "Nothing was written."
    );
  }
  if (plan.collisions?.length) {
    throw new Error(
      `refusing to publish: ${plan.collisions.length} title collision(s) would violate ` +
        `unique (round, title). Nothing was written. See the warnings above.`
    );
  }

  if (plan.insert.length) {
    const { error } = await db.from("tasks").insert(plan.insert);
    if (error) throw new Error(`insert failed: ${error.message}`);
  }

  const writes = [...plan.update, ...plan.reactivate];

  /*
   * Renames are applied one row at a time, so a chain of them can collide with
   * itself even though the end state is perfectly valid: swap two titles and
   * whichever goes first lands on the title the other still holds. Postgres
   * rejects it, the rest of the plan never runs, and because the next run
   * recomputes the same plan it fails in the same place forever.
   *
   * So any rename whose target is currently held by another row that is *also*
   * being renamed gets parked on a throwaway title first. The park value is
   * keyed on the row id, so it cannot collide with anything either. If a run
   * dies between the two phases the row is left reading a parked title, which
   * matches nothing on the board -- so the next run simply renames it to where
   * it was going. It converges rather than wedging.
   */
  const renames = writes.filter((w) => w.patch.title !== undefined);
  const heldBy = new Map(renames.map((w) => [`${w.round}|${normalizeTitle(w.title)}`, w.id]));
  const parked = renames.filter((w) => {
    const owner = heldBy.get(`${w.round}|${normalizeTitle(w.patch.title)}`);
    return owner && owner !== w.id;
  });

  for (const { id } of parked) {
    const { error } = await db.from("tasks").update({ title: `__task-sync parking ${id}` }).eq("id", id);
    if (error) throw new Error(`could not park a renamed task: ${error.message}`);
  }

  for (const { id, patch } of writes) {
    const { error } = await db.from("tasks").update(patch).eq("id", id);
    if (error) throw new Error(`update failed: ${error.message}`);
  }

  if (plan.deactivate.length) {
    const { error } = await db
      .from("tasks")
      .update({ active: false })
      .in("id", plan.deactivate.map((d) => d.id));
    if (error) throw new Error(`deactivate failed: ${error.message}`);
  }
}

/** How many rows a plan would actually write. Warnings are advisory, not changes. */
export function changeCount(plan) {
  return (
    (plan?.insert?.length ?? 0) +
    (plan?.update?.length ?? 0) +
    (plan?.deactivate?.length ?? 0) +
    (plan?.reactivate?.length ?? 0)
  );
}

/**
 * The same plan as `describePlan`, shaped for a machine.
 *
 * `--json` exists so the scavenger-tasks canvas can ask this script what is
 * pending rather than reimplementing the planner behind a button -- which is the
 * whole point, because it means the canvas inherits the collision refusal, the
 * pre-migration refusal and the worktree refusal instead of drifting from them.
 *
 * `ok` is the field the button hangs off, so it is false for every reason
 * `applyPlan` would refuse AND for an outright failure. `error` and `count: 0`
 * are deliberately different states: a check that could not run must never be
 * readable as "nothing to publish".
 *
 * Pure, so every refusal path is provable from a fixture.
 */
export function syncReport({ plan, live = [], migrated = true, refusal = null, applied = false, error = null } = {}) {
  if (error || !plan) {
    return {
      ok: false,
      applied: false,
      count: null,
      counts: null,
      migrated,
      refusal: refusal ?? null,
      collisions: [],
      warnings: [],
      changes: null,
      error: error ?? "no plan was produced",
    };
  }

  const liveById = new Map((live ?? []).map((t) => [t.id, t]));
  const itemize = (list) =>
    list.map(({ id, board_id, round, patch }) => {
      const was = liveById.get(id) ?? {};
      return {
        board_id,
        round,
        title: was.title ?? "",
        fields: Object.entries(patch ?? {}).map(([field, to]) => ({
          field,
          from: was[field] === undefined ? null : was[field],
          to,
        })),
      };
    });

  const collisions = plan.collisions ?? [];
  // Split, never drop: the reorderings are still applied by applyPlan, which
  // reads `plan.update`. Only the number and the list the canvas shows change,
  // so `counts.reorder` keeps them visible rather than silently disappearing a
  // difference between the board and what players see.
  const reorder = plan.update.filter(isReorderOnly);
  const material = plan.update.filter((u) => !isReorderOnly(u));
  return {
    ok: !refusal && !collisions.length && migrated,
    applied,
    // Deliberately not `changeCount(plan)`, which stays the number of rows that
    // would be written and is what the CLI and the apply path want.
    count: plan.insert.length + material.length + plan.deactivate.length + plan.reactivate.length,
    counts: {
      insert: plan.insert.length,
      update: material.length,
      deactivate: plan.deactivate.length,
      reactivate: plan.reactivate.length,
      reorder: reorder.length,
    },
    migrated,
    refusal: refusal ?? null,
    collisions,
    warnings: plan.warnings ?? [],
    changes: {
      insert: plan.insert.map((r) => ({
        board_id: r.board_id,
        round: r.round,
        title: r.title,
        points: r.points,
      })),
      update: itemize(material),
      reactivate: itemize(plan.reactivate),
      deactivate: plan.deactivate.map((d) => ({ board_id: d.board_id, round: d.round, title: d.title })),
    },
    error: null,
  };
}

export function describePlan(plan, live = []) {
  const out = [];
  const liveById = new Map(live.map((t) => [t.id, t]));
  const n = changeCount(plan);

  if (plan.insert.length) {
    out.push(`\nINSERT (${plan.insert.length})`);
    for (const r of plan.insert) out.push(`  + r${r.round} ${r.points}pt ${r.board_id.padEnd(6)} "${r.title}"`);
  }
  if (plan.update.length) {
    out.push(`\nUPDATE (${plan.update.length})`);
    for (const u of plan.update) {
      const was = liveById.get(u.id) ?? {};
      out.push(`  ~ r${was.round} ${u.board_id.padEnd(6)} "${u.title}"`);
      for (const [k, v] of Object.entries(u.patch)) {
        const before = was[k] === undefined ? "(unset)" : JSON.stringify(was[k]);
        out.push(`      ${k}: ${before} -> ${JSON.stringify(v)}`);
      }
    }
  }
  if (plan.reactivate.length) {
    out.push(`\nREACTIVATE (${plan.reactivate.length})`);
    for (const r of plan.reactivate) out.push(`  ^ ${r.board_id}`);
  }
  if (plan.deactivate.length) {
    out.push(`\nDEACTIVATE -- hidden from players, never deleted (${plan.deactivate.length})`);
    for (const d of plan.deactivate) out.push(`  - r${d.round} ${d.board_id.padEnd(6)} "${d.title}"`);
  }
  if (plan.warnings.length) {
    out.push(`\nWARNINGS (${plan.warnings.length})`);
    for (const w of plan.warnings) out.push(`  ! ${w}`);
  }
  if (!n) out.push("\nThe app already matches the board. Nothing to do.");
  return out.join("\n");
}

const JSON_MODE = process.argv.includes("--json");

/**
 * The one thing `--json` writes to stdout, ever. Everything else in JSON mode is
 * suppressed so the canvas can parse stdout without stripping prose out of it.
 */
function emitJson(report) {
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!report.ok) process.exitCode = 1;
}

async function main() {
  const say = JSON_MODE ? () => {} : (line) => console.log(line);
  const apply = process.argv.includes("--apply");

  // Runs before any Supabase work, so the worktree refusal reaches the canvas
  // even with no network and no credentials.
  const refusal = checkoutRefusal();
  if (refusal) {
    if (!JSON_MODE) throw new Error(refusal);
    return emitJson(syncReport({ plan: null, refusal, error: refusal }));
  }

  const { createClient } = await import("@supabase/supabase-js");
  const env = Object.fromEntries(
    readFileSync(new URL("../.env.local", import.meta.url), "utf8")
      .split("\n")
      .filter((l) => l.trim() && !l.trim().startsWith("#") && l.includes("="))
      .map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
      })
  );
  const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const { plan, live, migrated } = await buildPlan(db);
  say(describePlan(plan, live));

  const n = changeCount(plan);
  if (plan.collisions?.length) {
    say(
      `\n${plan.collisions.length} title collision(s). --apply will refuse until the board changes; ` +
        `nothing can be published in this state.`
    );
    process.exitCode = 1;
    // Reported, not applied: syncReport marks a collision not-ok, so --apply
    // stops here in JSON mode exactly as it does for a human.
    if (JSON_MODE) return emitJson(syncReport({ plan, live, migrated, refusal: null }));
    if (!apply) return;
  }
  if (!apply) {
    say(
      `\nDry run. ${n} change(s) would be written. Re-run with --apply to publish.` +
        (migrated ? "" : "\nRun supabase/migrate-task-board-id.sql first -- --apply will refuse until you do.")
    );
    return JSON_MODE ? emitJson(syncReport({ plan, live, migrated, refusal: null })) : undefined;
  }

  // applyPlan throws on an unmigrated database; let that surface as an error
  // report rather than a half-published task list reported as a success.
  await applyPlan(db, plan, { migrated });
  say(`\nPublished ${n} change(s) to the tasks table. Submissions and media untouched.`);
  if (JSON_MODE) emitJson(syncReport({ plan, live, migrated, refusal: null, applied: true }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    // In JSON mode a crash still has to produce something parseable: a caller
    // that gets nothing back cannot tell a failure from a clean zero, and that
    // is the one confusion this whole feature exists to prevent.
    if (JSON_MODE) emitJson(syncReport({ plan: null, error: e.message }));
    else console.error(e.message);
    process.exitCode = 1;
  });
}
