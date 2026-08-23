#!/usr/bin/env node
/**
 * Publishes the planning board to the app.
 *
 *   npm run sync:tasks           show what would change, write nothing
 *   npm run sync:tasks -- --apply  actually write it
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
import { readFileSync } from "node:fs";

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
export function desiredRows(board) {
  const rows = [];
  for (const task of board?.tasks ?? []) {
    if (!task || typeof task.id !== "string") continue;
    const isSecret = Number(task.round) === 0;
    for (const round of isSecret ? [1, 2] : [Number(task.round)]) {
      if (round !== 1 && round !== 2) continue;
      rows.push({
        board_id: task.id,
        round,
        title: effectiveTitle(task),
        docTitle: String(task.docTitle ?? "").trim(),
        points: Number(task.points),
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
  const rows = desiredRows(board);
  const insert = [];
  const update = [];
  const deactivate = [];
  const reactivate = [];
  const warnings = [];

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
      reactivate.push({ id: current.id, board_id: row.board_id, patch: { ...patch, active: true } });
    } else if (Object.keys(patch).length) {
      update.push({ id: current.id, board_id: row.board_id, title: current.title, patch });
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
  // here rather than blowing up halfway through an --apply.
  const seen = new Map();
  for (const row of rows.filter((r) => r.wanted)) {
    const k = key(row.round, normalizeTitle(row.title));
    if (seen.has(k)) warnings.push(`duplicate title in round ${row.round}: ${seen.get(k)} and ${row.board_id} both read "${row.title}"`);
    else seen.set(k, row.board_id);
  }

  return { insert, update, deactivate, reactivate, warnings };
}

// ---------------------------------------------------------------------------
// Everything below is the Supabase side and only runs when this file is the
// entry point, so importing the planner in a test never opens a connection.
// ---------------------------------------------------------------------------

export const BOARD_PATH = new URL("../data/task-board.json", import.meta.url);

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
export async function applyPlan(db, plan, { migrated = true } = {}) {
  if (!migrated) {
    throw new Error(
      "tasks.board_id does not exist -- run supabase/migrate-task-board-id.sql first. " +
        "Nothing was written."
    );
  }
  if (plan.insert.length) {
    const { error } = await db.from("tasks").insert(plan.insert);
    if (error) throw new Error(`insert failed: ${error.message}`);
  }
  for (const { id, patch } of [...plan.update, ...plan.reactivate]) {
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

export function describePlan(plan, live = []) {
  const out = [];
  const liveById = new Map(live.map((t) => [t.id, t]));
  const n = plan.insert.length + plan.update.length + plan.deactivate.length + plan.reactivate.length;

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

async function main() {
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

  const apply = process.argv.includes("--apply");
  const { plan, live, migrated } = await buildPlan(db);
  console.log(describePlan(plan, live));

  const n = plan.insert.length + plan.update.length + plan.deactivate.length + plan.reactivate.length;
  if (!apply) {
    console.log(
      `\nDry run. ${n} change(s) would be written. Re-run with --apply to publish.` +
        (migrated ? "" : "\nRun supabase/migrate-task-board-id.sql first -- --apply will refuse until you do.")
    );
    return;
  }
  await applyPlan(db, plan, { migrated });
  console.log(`\nPublished ${n} change(s) to the tasks table. Submissions and media untouched.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
}
