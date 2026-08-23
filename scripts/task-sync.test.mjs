#!/usr/bin/env node
/**
 * Unit tests for the task-sync planner.
 *
 *   node --test scripts/task-sync.test.mjs
 *
 * planTaskSync is a pure function precisely so the risky part -- deciding what
 * happens to live task rows that already have submissions against them -- can be
 * proved against fixtures without touching the shared Supabase project.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeTitle,
  effectiveTitle,
  desiredRows,
  planTaskSync,
  applyPlan,
  boardRefusal,
  changeCount,
  isReorderOnly,
  syncReport,
} from "./task-sync.mjs";

/** Minimal board task; every field the planner reads has a default. */
function task(over = {}) {
  return {
    id: "r1-01",
    round: 1,
    docTitle: "A task",
    title: "A task",
    points: 3,
    docOrder: 1,
    needsClip: false,
    status: "keep",
    ...over,
  };
}

const board = (tasks) => ({ version: 1, tasks });

/** Minimal live row as returned by `select` on the tasks table. */
function live(over = {}) {
  return {
    id: "uuid-1",
    board_id: "r1-01",
    round: 1,
    title: "A task",
    points: 3,
    requires_video: false,
    is_secret: false,
    sort_order: 10,
    active: true,
    ...over,
  };
}

// ---------------------------------------------------------------- normalizing

test("normalizeTitle folds the punctuation that differs between the doc and the board", () => {
  assert.equal(normalizeTitle("A stranger\u2019s hat"), normalizeTitle("A stranger's hat"));
  assert.equal(normalizeTitle("say \u201Cguess who\u201D"), normalizeTitle('say "guess who"'));
  assert.equal(normalizeTitle("statues \u2014 worse"), normalizeTitle("statues - worse"));
  assert.equal(normalizeTitle("  spaced   out  "), normalizeTitle("spaced out"));
  assert.equal(normalizeTitle("CASE"), normalizeTitle("case"));
});

test("effectiveTitle prefers the rewritten title and falls back to the doc title", () => {
  assert.equal(effectiveTitle({ title: "new", docTitle: "old" }), "new");
  // s-x1 is title-only: it was added in the canvas and has no doc provenance.
  assert.equal(effectiveTitle({ title: "canvas only", docTitle: "" }), "canvas only");
  assert.equal(effectiveTitle({ title: "", docTitle: "old" }), "old");
});

// ------------------------------------------------------------------ fan-out

test("a round-0 secret becomes one row per round because tasks.round only allows 1 and 2", () => {
  const rows = desiredRows(board([task({ id: "s-01", round: 0, points: 7 })]));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.round).sort(), [1, 2]);
  assert.ok(rows.every((r) => r.is_secret === true));
  assert.ok(rows.every((r) => r.board_id === "s-01"));
});

test("a normal task becomes exactly one non-secret row", () => {
  const rows = desiredRows(board([task({ round: 2 })]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].round, 2);
  assert.equal(rows[0].is_secret, false);
});

test("sort_order groups by tier ascending with secrets last, then doc order", () => {
  const rows = desiredRows(
    board([
      task({ id: "r1-a", points: 10, docOrder: 1 }),
      task({ id: "r1-b", points: 1, docOrder: 2 }),
      task({ id: "r1-c", points: 5, docOrder: 3 }),
      task({ id: "r1-d", points: 3, docOrder: 4 }),
      task({ id: "s-01", round: 0, points: 7, docOrder: 5 }),
    ])
  );
  const r1 = rows.filter((r) => r.round === 1).sort((a, b) => a.sort_order - b.sort_order);
  assert.deepEqual(
    r1.map((r) => r.board_id),
    ["r1-b", "r1-d", "r1-c", "r1-a", "s-01"]
  );
  assert.ok(r1.every((r, i) => r.sort_order === (i + 1) * 10));
});

test("needsClip maps onto requires_video", () => {
  const [row] = desiredRows(board([task({ needsClip: true })]));
  assert.equal(row.requires_video, true);
});

// ------------------------------------------------------------------ planning

test("a cut task that is live is deactivated, never deleted", () => {
  const plan = planTaskSync(board([task({ status: "cut" })]), [live()]);
  assert.equal(plan.deactivate.length, 1);
  assert.equal(plan.deactivate[0].id, "uuid-1");
  assert.equal(plan.insert.length, 0);
  assert.equal(plan.update.length, 0);
  // The planner must not even be able to express a deletion.
  assert.equal(plan.delete, undefined);
  assert.ok(!("delete" in plan));
});

test("a cut task that is already inactive is left alone", () => {
  const plan = planTaskSync(board([task({ status: "cut" })]), [live({ active: false })]);
  assert.equal(plan.deactivate.length, 0);
  assert.equal(plan.update.length, 0);
});

test("a cut task with no live row is a no-op", () => {
  const plan = planTaskSync(board([task({ status: "cut" })]), []);
  assert.equal(plan.insert.length, 0);
  assert.equal(plan.deactivate.length, 0);
});

test("re-tiering updates points and touches nothing else", () => {
  const plan = planTaskSync(board([task({ points: 10 })]), [live({ points: 3 })]);
  assert.equal(plan.update.length, 1);
  assert.equal(plan.update[0].patch.points, 10);
  assert.deepEqual(Object.keys(plan.update[0].patch), ["points"]);
});

test("a rewritten title updates the existing row rather than inserting a duplicate", () => {
  // The board keeps docTitle as provenance; the live row still holds the old text.
  const plan = planTaskSync(
    board([task({ docTitle: "Hook up with a statue", title: "Make out with a statue" })]),
    [live({ title: "Hook up with a statue" })]
  );
  assert.equal(plan.insert.length, 0);
  assert.equal(plan.update.length, 1);
  assert.equal(plan.update[0].patch.title, "Make out with a statue");
  assert.equal(plan.update[0].id, "uuid-1");
});

test("matching is keyed on board_id, so a title the board no longer knows still matches", () => {
  const plan = planTaskSync(board([task({ title: "brand new wording" })]), [
    live({ title: "wording from six drafts ago" }),
  ]);
  assert.equal(plan.insert.length, 0);
  assert.equal(plan.update.length, 1);
});

test("before the migration, a rewritten title still matches its row via docTitle", () => {
  // The dangerous case: the live row holds the ORIGINAL wording and has no
  // board_id yet, while the board has since reworded it. Matching only on the
  // new wording misses, and inserts a second copy of the same task -- which
  // unique (round, title) cannot catch, because the two titles differ.
  const plan = planTaskSync(
    board([task({ docTitle: "Hook up with a statue", title: "Make out with a statue" })]),
    [live({ board_id: null, title: "Hook up with a statue" })]
  );
  assert.equal(plan.insert.length, 0, "must not insert a duplicate task");
  assert.equal(plan.update.length, 1);
  assert.equal(plan.update[0].patch.title, "Make out with a statue");
  assert.equal(plan.update[0].patch.board_id, "r1-01");
});

test("before the migration, an unchanged title matches on either field", () => {
  const plan = planTaskSync(board([task()]), [live({ board_id: null })]);
  assert.equal(plan.insert.length, 0);
  assert.equal(plan.update[0].patch.board_id, "r1-01");
});

test("a task with no live row under either wording is still inserted", () => {
  const plan = planTaskSync(
    board([task({ docTitle: "Never seeded", title: "Never seeded either" })]),
    [live({ board_id: null, title: "A completely different task" })]
  );
  assert.equal(plan.insert.length, 1);
});

test("a kept task with no live row is inserted", () => {
  const plan = planTaskSync(board([task({ id: "s-x1", round: 0, points: 7, docTitle: "" })]), []);
  assert.equal(plan.insert.length, 2);
  assert.ok(plan.insert.every((r) => r.board_id === "s-x1"));
  assert.ok(plan.insert.every((r) => r.active === true));
});

test("a kept task whose row was deactivated is reactivated", () => {
  const plan = planTaskSync(board([task()]), [live({ active: false })]);
  assert.equal(plan.reactivate.length, 1);
  assert.equal(plan.reactivate[0].id, "uuid-1");
  assert.equal(plan.deactivate.length, 0);
});

test("an identical board and live row produce no operations at all", () => {
  const plan = planTaskSync(board([task()]), [live()]);
  assert.equal(plan.insert.length, 0);
  assert.equal(plan.update.length, 0);
  assert.equal(plan.deactivate.length, 0);
  assert.equal(plan.reactivate.length, 0);
});

// ----------------------------------------------------------------- warnings

test("maybe counts as live, like the board's own summarize, but is always warned about", () => {
  const plan = planTaskSync(board([task({ status: "maybe" })]), []);
  assert.equal(plan.insert.length, 1);
  assert.equal(plan.deactivate.length, 0);
  assert.ok(plan.warnings.some((w) => /maybe/i.test(w)));
});

test("a live row the board has never heard of is warned about, not removed", () => {
  const plan = planTaskSync(board([task()]), [live(), live({ id: "uuid-9", board_id: "ghost-1" })]);
  assert.equal(plan.deactivate.length, 0);
  assert.ok(plan.warnings.some((w) => w.includes("ghost-1")));
});

test("a live row with no board_id is reported as unlinked so the migration is not skipped", () => {
  const plan = planTaskSync(board([task()]), [live({ board_id: null })]);
  assert.ok(plan.warnings.some((w) => /board_id/i.test(w)));
  // It must not be mistaken for a missing task and re-inserted underneath itself.
  assert.equal(plan.insert.length, 0);
});

test("deactivating a task that already has submissions is surfaced loudly", () => {
  const plan = planTaskSync(board([task({ status: "cut" })]), [live()], {
    submissionCounts: { "uuid-1": 4 },
  });
  assert.equal(plan.deactivate.length, 1);
  assert.ok(plan.warnings.some((w) => w.includes("4") && /submission/i.test(w)));
});

test("the plan never proposes writing revealed_at", () => {
  // Both halves must run against something non-empty, or the assertion passes
  // by looping over nothing.
  const plan = planTaskSync(
    board([
      task({ points: 10, status: "keep" }),
      task({ id: "s-01", round: 0, points: 7, docOrder: 2, title: "A secret" }),
    ]),
    [live({ points: 3, revealed_at: "2026-08-22T00:00:00Z" })]
  );
  assert.ok(plan.update.length > 0, "needs a real update to be meaningful");
  assert.ok(plan.insert.length > 0, "needs a real insert to be meaningful");
  for (const u of plan.update) assert.ok(!("revealed_at" in u.patch));
  for (const r of plan.reactivate) assert.ok(!("revealed_at" in r.patch));
  for (const r of plan.insert) assert.ok(!("revealed_at" in r));
  for (const d of plan.deactivate) assert.ok(!("revealed_at" in d));
});

test("two tasks in the same round may not resolve to the same title", () => {  // unique (round, title) survives the migration, so a collision has to be caught
// here rather than as a constraint violation halfway through an --apply.
const plan = planTaskSync(
  board([task({ id: "r1-a", title: "Same" }), task({ id: "r1-b", docOrder: 2, title: "Same" })]),
  []
);
assert.equal(plan.collisions.length, 1);
assert.ok(plan.warnings.some((w) => /collision/i.test(w)));
});
// ------------------------------------------------------------------- applying

test("applyPlan refuses to write anything if the migration has not been run", async () => {
  // Every insert and update carries a board_id, so an unmigrated database would
  // reject the first write and leave the rest unapplied -- a half-published task
  // list. Refusing up front is the only safe behaviour.
  const calls = [];
  const db = {
    from(tableName) {
      calls.push(tableName);
      throw new Error("must not reach the database");
    },
  };
  const plan = planTaskSync(board([task()]), []);
  assert.equal(plan.insert.length, 1);
  await assert.rejects(
    () => applyPlan(db, plan, { migrated: false }),
    /migrate-task-board-id\.sql/
  );
  assert.deepEqual(calls, [], "nothing may be written");
});

test("applyPlan is a no-op on an empty plan", async () => {
  const calls = [];
  const db = { from: (t) => (calls.push(t), { insert: async () => ({}), update: () => ({ eq: async () => ({}), in: async () => ({}) }) }) };
  await applyPlan(db, planTaskSync(board([task()]), [live()]), { migrated: true });
  assert.deepEqual(calls, []);
});

// ------------------------------------------------------- collisions with live

test("an insert that lands on a deactivated row's title is reported as a collision", () => {
  // Re-adding a cut task as a NEW board entry, instead of un-cutting the old
  // one, is the natural move in the canvas. The old row keeps its title while
  // deactivated, so unique (round, title) would reject the insert.
  const plan = planTaskSync(board([task({ id: "r1-new", title: "Pick up a pigeon" })]), [
    live({ id: "uuid-dead", board_id: "r1-old", title: "Pick up a pigeon", active: false }),
  ]);
  assert.equal(plan.insert.length, 1);
  assert.equal(plan.collisions.length, 1);
  assert.ok(plan.warnings.some((w) => /Pick up a pigeon/.test(w)));
});

test("a title change that lands on an untouched live row's title is reported as a collision", () => {
  // The board only mentions r1-01. The other row is live, keeps its title, and
  // the board has no idea it exists -- so comparing board rows against each
  // other could never have caught this.
  const plan = planTaskSync(
    board([task({ id: "r1-01", title: "Feed a pigeon out of your hand" })]),
    [
      live({ id: "uuid-1", board_id: "r1-01", title: "Re-create an album cover" }),
      live({ id: "uuid-9", board_id: "r1-orphan", title: "Feed a pigeon out of your hand", sort_order: 20 }),
    ]
  );
  assert.equal(plan.update.length, 1);
  assert.equal(plan.collisions.length, 1);
  assert.ok(plan.warnings.some((w) => /collision/i.test(w)));
});

test("collisions are matched on normalized text, not exact text", () => {
  const plan = planTaskSync(board([task({ id: "r1-new", title: "A stranger\u2019s hat" })]), [
    live({ id: "uuid-dead", board_id: "r1-old", title: "A stranger's  hat", active: false }),
  ]);
  assert.equal(plan.collisions.length, 1);
});

test("swapping two titles is NOT a collision -- the end state is distinct", () => {
  const plan = planTaskSync(
    board([
      task({ id: "r1-01", title: "Beta" }),
      task({ id: "r1-02", docOrder: 2, title: "Alpha" }),
    ]),
    [
      live({ id: "uuid-1", board_id: "r1-01", title: "Alpha" }),
      live({ id: "uuid-2", board_id: "r1-02", title: "Beta", sort_order: 20 }),
    ]
  );
  assert.equal(plan.collisions.length, 0, "a swap converges and must not be blocked");
  assert.equal(plan.update.length, 2);
});

// --------------------------------------------------------- invalid board rows

test("a board entry with an unusable id or round is skipped loudly, not silently", () => {
  const warnings = [];
  const rows = desiredRows(
    board([
      task(),
      { ...task({ id: "r1-bad" }), round: 7 },
      { ...task(), id: 42 },
    ]),
    warnings
  );
  assert.equal(rows.length, 1, "only the valid task produces a row");
  assert.equal(warnings.length, 2);
  assert.ok(warnings.some((w) => w.includes("r1-bad")));
});

test("a board entry with non-numeric points is skipped loudly", () => {
  // Number(undefined) is NaN, which serializes to null against a `points not
  // null` column, and compares unequal to itself so it would be re-proposed on
  // every single run.
  const warnings = [];
  const rows = desiredRows(board([task({ id: "r1-np", points: undefined })]), warnings);
  assert.equal(rows.length, 0);
  assert.ok(warnings.some((w) => w.includes("r1-np") && /points/i.test(w)));
});

test("an invalid board entry surfaces through planTaskSync too", () => {
  const plan = planTaskSync(board([{ ...task({ id: "r1-bad" }), round: 9 }]), []);
  assert.equal(plan.insert.length, 0);
  assert.ok(plan.warnings.some((w) => w.includes("r1-bad")));
});

// ------------------------------------------------------- board_id on cut rows

test("a cut task linked only by title still gets its board_id written back", () => {
  const plan = planTaskSync(board([task({ status: "cut" })]), [live({ board_id: null })]);
  assert.equal(plan.deactivate.length, 1);
  const patch = plan.update.find((u) => u.id === "uuid-1")?.patch;
  assert.equal(patch?.board_id, "r1-01", "otherwise its migration warning never clears");
});

test("an already-inactive cut task linked only by title still gets its board_id", () => {
  const plan = planTaskSync(board([task({ status: "cut" })]), [live({ board_id: null, active: false })]);
  assert.equal(plan.deactivate.length, 0);
  assert.equal(plan.update.find((u) => u.id === "uuid-1")?.patch.board_id, "r1-01");
});

// ---------------------------------------------------------------- applyPlan

/**
 * A stand-in for the tasks table that enforces `unique (round, title)` the way
 * Postgres does and records every call. Deleting is not implemented on purpose:
 * if applyPlan ever grows a delete, these tests fail loudly.
 */
function fakeDb(initial = []) {
  const table = initial.map((r) => ({ ...r }));
  const calls = [];
  const violation = () => {
    const seen = new Set();
    for (const r of table) {
      const k = `${r.round}|${normalizeTitle(r.title)}`;
      if (seen.has(k)) return { error: { message: `duplicate key value violates unique constraint "tasks_round_title_key"` } };
      seen.add(k);
    }
    return {};
  };
  const applyTo = (matcher, patch) => {
    for (const r of table) if (matcher(r)) Object.assign(r, patch);
    return violation();
  };
  return {
    table,
    calls,
    from() {
      return {
        insert(rows) {
          calls.push({ op: "insert", n: rows.length });
          table.push(...rows.map((r) => ({ id: `new-${table.length}`, ...r })));
          return Promise.resolve(violation());
        },
        update(patch) {
          return {
            eq(_col, id) {
              calls.push({ op: "update", id, patch });
              return Promise.resolve(applyTo((r) => r.id === id, patch));
            },
            in(_col, ids) {
              calls.push({ op: "updateIn", ids, patch });
              return Promise.resolve(applyTo((r) => ids.includes(r.id), patch));
            },
          };
        },
        delete() {
          throw new Error("applyPlan must never delete a task");
        },
      };
    },
  };
}

test("applyPlan writes inserts, then updates, then deactivations, and never deletes", async () => {
  const db = fakeDb([
    { id: "uuid-1", board_id: "r1-01", round: 1, title: "A task", points: 3, requires_video: false, is_secret: false, sort_order: 10, active: true },
    { id: "uuid-2", board_id: "r1-02", round: 1, title: "Doomed", points: 3, requires_video: false, is_secret: false, sort_order: 20, active: true },
  ]);
  const plan = planTaskSync(
    board([
      task({ points: 10 }),
      task({ id: "r1-02", docOrder: 2, title: "Doomed", status: "cut" }),
      task({ id: "r1-03", docOrder: 3, title: "Brand new" }),
    ]),
    db.table
  );
  assert.equal(plan.insert.length, 1);
  assert.equal(plan.deactivate.length, 1);

  await applyPlan(db, plan, { migrated: true });

  const ops = db.calls.map((c) => c.op);
  assert.equal(ops[0], "insert", "inserts go first");
  assert.equal(ops.at(-1), "updateIn", "the deactivation batch goes last");
  assert.ok(!ops.includes("delete"));
  assert.equal(db.table.find((r) => r.id === "uuid-1").points, 10);
  assert.equal(db.table.find((r) => r.id === "uuid-2").active, false);
  assert.ok(db.table.some((r) => r.id === "uuid-2"), "the deactivated row is still there");
  assert.equal(db.table.length, 3, "2 existing + 1 insert, nothing removed");
});

test("applyPlan converges when two tasks swap titles", async () => {
  // Without parking, the first update collides with the row still holding the
  // target title, and every re-run fails at the same point forever.
  const db = fakeDb([
    { id: "uuid-1", board_id: "r1-01", round: 1, title: "Alpha", points: 3, requires_video: false, is_secret: false, sort_order: 10, active: true },
    { id: "uuid-2", board_id: "r1-02", round: 1, title: "Beta", points: 3, requires_video: false, is_secret: false, sort_order: 20, active: true },
  ]);
  const b = board([task({ id: "r1-01", title: "Beta" }), task({ id: "r1-02", docOrder: 2, title: "Alpha" })]);
  await applyPlan(db, planTaskSync(b, db.table), { migrated: true });

  assert.equal(db.table.find((r) => r.id === "uuid-1").title, "Beta");
  assert.equal(db.table.find((r) => r.id === "uuid-2").title, "Alpha");
  // And a second run is a no-op, which is what "converged" means.
  const again = planTaskSync(b, db.table);
  assert.equal(again.update.length, 0);
  assert.equal(again.collisions.length, 0);
});

test("applyPlan converges on a three-way title rotation", async () => {
  const db = fakeDb(
    ["Alpha", "Beta", "Gamma"].map((t, i) => ({
      id: `uuid-${i + 1}`, board_id: `r1-0${i + 1}`, round: 1, title: t,
      points: 3, requires_video: false, is_secret: false, sort_order: (i + 1) * 10, active: true,
    }))
  );
  const b = board([
    task({ id: "r1-01", docOrder: 1, title: "Beta" }),
    task({ id: "r1-02", docOrder: 2, title: "Gamma" }),
    task({ id: "r1-03", docOrder: 3, title: "Alpha" }),
  ]);
  await applyPlan(db, planTaskSync(b, db.table), { migrated: true });
  assert.deepEqual(db.table.map((r) => r.title), ["Beta", "Gamma", "Alpha"]);
  assert.equal(planTaskSync(b, db.table).update.length, 0);
});

test("applyPlan refuses a plan with a genuine title collision and writes nothing", async () => {
  const db = fakeDb([
    { id: "uuid-dead", board_id: "r1-old", round: 1, title: "Pick up a pigeon", points: 3, requires_video: false, is_secret: false, sort_order: 10, active: false },
  ]);
  const plan = planTaskSync(board([task({ id: "r1-new", title: "Pick up a pigeon" })]), db.table);
  assert.equal(plan.collisions.length, 1);
  await assert.rejects(() => applyPlan(db, plan, { migrated: true }), /collision|duplicate/i);
  assert.deepEqual(db.calls, [], "nothing may be written");
});

// ------------------------------------------------------- wrong-checkout guard

/**
 * A linked worktree no longer refuses: `scripts/board-path.mjs` resolves it to
 * the MAIN checkout's board, which is the same file the canvas edits, so a
 * worktree session is usable for task work. Which path is chosen is proved in
 * `board-path.test.mjs`.
 *
 * What survives here is the one case that is still unsafe: a worktree whose
 * main checkout could not be located, where the only reachable board is known
 * to be the wrong one. Publishing it would revert live tasks to a stale copy.
 */

test("a resolvable board never refuses, however it was resolved", () => {
  for (const reason of ["main checkout", "main checkout via worktree", "not a git worktree"]) {
    assert.equal(boardRefusal({ canonical: true, reason, path: "/repo/data/task-board.json" }), null);
  }
});

test("an unlocatable main checkout refuses and names the board it would have read", () => {
  const msg = boardRefusal({
    canonical: false,
    reason: "this is a linked git worktree and the main checkout could not be located from /srv/bare.git",
    path: "/wt/data/task-board.json",
  });
  assert.ok(msg, "an unlocatable main checkout must refuse");
  assert.ok(msg.includes("/wt/data/task-board.json"), "must name the board it would have read");
  assert.match(msg, /revert live tasks/, "must say what goes wrong, not just that it stopped");
  assert.match(msg, /TASK_SYNC_ALLOW_WORKTREE/, "must name the override");
});

test("the refusal carries the resolver's own reason rather than a generic one", () => {
  const msg = boardRefusal({ canonical: false, reason: "some specific git situation", path: "/wt/data/task-board.json" });
  assert.ok(msg.includes("some specific git situation"), "the fix is in the reason, so it must survive");
});

// --------------------------------------------------------------- json report
/*
 * `--json` exists so the scavenger-tasks canvas can ask the real script what is
 * pending instead of reimplementing the planner behind a button. That makes the
 * shape of the report load-bearing: the canvas decides whether to enable a live
 * write to the tasks table from these fields alone, so a refusal that fails to
 * set `ok: false` is a button that publishes a stale board.
 *
 * `syncReport` is pure for the same reason `planTaskSync` is -- every refusal
 * path is provable from a fixture rather than by breaking the one shared project.
 */
const emptyPlan = (over = {}) => ({
  insert: [], update: [], deactivate: [], reactivate: [], warnings: [], collisions: [], ...over,
});

test("changeCount sums every bucket that would be written", () => {
  assert.equal(changeCount(emptyPlan()), 0);
  assert.equal(
    changeCount(emptyPlan({
      insert: [1, 2],
      update: [1, 2, 3],
      deactivate: [1],
      reactivate: [1, 2, 3, 4],
    })),
    10
  );
  // Warnings are advisory: they are not changes and must not inflate the count
  // the banner puts in front of a publish button.
  assert.equal(changeCount(emptyPlan({ warnings: ["a", "b"], collisions: [{}] })), 0);
});

test("a converged plan reports ok with a zero count", () => {
  const report = syncReport({ plan: emptyPlan(), live: [], migrated: true, refusal: null });
  assert.equal(report.ok, true);
  assert.equal(report.count, 0);
  assert.equal(report.refusal, null);
  assert.equal(report.error, null);
  assert.equal(report.applied, false);
  assert.deepEqual(report.counts, { insert: 0, update: 0, deactivate: 0, reactivate: 0, reorder: 0 });
});

test("a board refusal makes the report not-ok and carries the reason verbatim", () => {
  // The canvas renders `refusal` straight into the banner, so it has to survive
  // intact rather than being flattened into a generic failure.
  const refusal = boardRefusal({
    canonical: false,
    reason: "this is a linked git worktree and the main checkout could not be located from /srv/bare.git",
    path: "/wt/data/task-board.json",
  });
  const report = syncReport({ plan: emptyPlan(), live: [], migrated: true, refusal });
  assert.equal(report.ok, false, "a refusal must never report ok");
  assert.equal(report.refusal, refusal);
  assert.ok(report.refusal.includes("/wt/data/task-board.json"));
});

test("a title collision makes the report not-ok and lists the collisions", () => {
  const plan = planTaskSync(
    board([task({ id: "r1-01", title: "Same" }), task({ id: "r1-02", docOrder: 2, title: "Same" })]),
    []
  );
  const report = syncReport({ plan, live: [], migrated: true, refusal: null });
  assert.equal(report.ok, false, "applyPlan would refuse this, so the report must too");
  assert.equal(report.collisions.length, 1);
  assert.equal(report.collisions[0].title, "Same");
});

test("an unmigrated database makes the report not-ok", () => {
  // applyPlan throws outright without board_id, so the button must be dead
  // before it is pressed rather than failing halfway through a publish.
  const report = syncReport({ plan: emptyPlan({ insert: [{}] }), live: [], migrated: false, refusal: null });
  assert.equal(report.ok, false);
  assert.equal(report.migrated, false);
});

test("an update is itemized field by field, from the live value to the board value", () => {
  const live1 = live({ points: 3, title: "Old wording" });
  const plan = planTaskSync(board([task({ points: 5, title: "New wording" })]), [live1]);
  const report = syncReport({ plan, live: [live1], migrated: true, refusal: null });

  assert.equal(report.count, 1);
  assert.deepEqual(report.counts, { insert: 0, update: 1, deactivate: 0, reactivate: 0, reorder: 0 });
  const [change] = report.changes.update;
  assert.equal(change.board_id, "r1-01");
  assert.equal(change.round, 1);
  const fields = Object.fromEntries(change.fields.map((f) => [f.field, f]));
  assert.deepEqual(fields.points, { field: "points", from: 3, to: 5 });
  assert.deepEqual(fields.title, { field: "title", from: "Old wording", to: "New wording" });
});

test("inserts and deactivations are itemized enough to preview before writing", () => {
  const gone = live({ id: "uuid-2", board_id: "r1-09", title: "On its way out", round: 2 });
  const plan = planTaskSync(
    board([
      task({ id: "r1-07", title: "Brand new", points: 10, round: 1 }),
      task({ id: "r1-09", title: "On its way out", round: 2, status: "cut" }),
    ]),
    [gone]
  );
  const report = syncReport({ plan, live: [gone], migrated: true, refusal: null });

  assert.deepEqual(report.changes.insert, [
    { board_id: "r1-07", round: 1, title: "Brand new", points: 10 },
  ]);
  assert.deepEqual(report.changes.deactivate, [
    { board_id: "r1-09", round: 2, title: "On its way out" },
  ]);
});

test("an error report carries the reason and is never mistaken for a clean run", () => {
  // No network, no .env.local, Supabase down: the canvas must be able to tell
  // this apart from "nothing to publish", which is the one lie that matters.
  const report = syncReport({ error: "could not read tasks: fetch failed" });
  assert.equal(report.ok, false);
  assert.equal(report.error, "could not read tasks: fetch failed");
  assert.equal(report.count, null, "a failed check has no count, and must not claim zero");
});

// ------------------------------------------------- reordering vs real changes
//
// Cutting one task renumbers every task below it, because sort_order is dense
// (`(i + 1) * 10`) and assigned only over the tasks that stay live. Two cuts on
// the real board produced 31 changes, 29 of which were nothing but a task
// sliding up one slot. The preview listed all 31, so the two decisions that
// actually mattered were buried in noise directly above a live-write button.
//
// Reordering is still published -- players do see the new order -- it just stops
// being counted and itemized as though it were a content change.

/** An update whose patch is exactly a slot move. */
const reorderUpdate = (id, sort_order) => ({
  id, board_id: `r1-${id}`, round: 1, title: `Task ${id}`, patch: { sort_order },
});

test("a sort_order-only update is reordering, not a change to count or list", () => {
  const plan = emptyPlan({ update: [reorderUpdate("02", 20), reorderUpdate("03", 30)] });
  const report = syncReport({ plan, live: [], migrated: true, refusal: null });

  assert.equal(report.count, 0, "pure reordering is not a change count");
  assert.equal(report.counts.update, 0);
  assert.equal(report.counts.reorder, 2, "but it is still reported, never silently dropped");
  assert.deepEqual(report.changes.update, [], "and it is not itemized into the preview");
});

test("an update that moves a task AND changes its content is a real change", () => {
  // The dangerous direction: a re-tier that also happens to shift the task's
  // slot must never be filtered out as mere reordering.
  const plan = emptyPlan({
    update: [{ id: "u1", board_id: "r1-05", round: 1, title: "Re-tiered", patch: { points: 5, sort_order: 60 } }],
  });
  const report = syncReport({ plan, live: [], migrated: true, refusal: null });

  assert.equal(report.count, 1);
  assert.equal(report.counts.reorder, 0);
  assert.equal(report.changes.update.length, 1);
});

test("reordering is separated from real changes rather than replacing them", () => {
  const plan = emptyPlan({
    update: [
      { id: "u1", board_id: "r1-05", round: 1, title: "Re-tiered", patch: { points: 5 } },
      reorderUpdate("06", 70),
      reorderUpdate("07", 80),
    ],
    deactivate: [{ id: "d1", board_id: "r1-09", round: 1, title: "Cut" }],
  });
  const report = syncReport({ plan, live: [], migrated: true, refusal: null });

  assert.equal(report.count, 2, "one re-tier plus one cut -- the reorderings are not changes");
  assert.equal(report.counts.reorder, 2);
  assert.equal(report.changes.update.length, 1);
  assert.equal(report.changes.deactivate.length, 1);
});

test("linking a row's board_id alongside a slot move is still only reordering", () => {
  // board_id is bookkeeping from the migration, not anything a player can see,
  // so it must not promote a slot move into a content change.
  const plan = emptyPlan({
    update: [{ id: "u1", board_id: "r1-04", round: 1, title: "Task", patch: { board_id: "r1-04", sort_order: 40 } }],
  });
  const report = syncReport({ plan, live: [], migrated: true, refusal: null });

  assert.equal(report.count, 0);
  assert.equal(report.counts.reorder, 1);
});

test("reordering still reaches the tasks table, so applyPlan keeps every update", () => {
  // The filter is a presentation decision. If it ever reached applyPlan, the
  // published task order would silently stop matching the board.
  const plan = emptyPlan({ update: [reorderUpdate("02", 20)] });
  syncReport({ plan, live: [], migrated: true, refusal: null });
  assert.equal(plan.update.length, 1, "syncReport must not mutate the plan it was given");
});

test("a patch that only links board_id is bookkeeping, not a change to count", () => {
  // Pre-migration linking writes a board_id and nothing else. Counting it would
  // put a number above the publish button that no one can act on, and listing it
  // would render a change line with no fields on it at all.
  const plan = emptyPlan({
    update: [{ id: "u1", board_id: "r1-04", round: 1, title: "Task", patch: { board_id: "r1-04" } }],
  });
  const report = syncReport({ plan, live: [], migrated: true, refusal: null });

  assert.equal(report.count, 0);
  assert.deepEqual(report.changes.update, []);
});

test("an empty patch is not silently swallowed as reordering", () => {
  // A patch with no keys is a planner bug, not a slot move. It must not be
  // classified as something the preview is entitled to hide.
  assert.equal(isReorderOnly({ patch: {} }), false);
  assert.equal(isReorderOnly({}), false);
});
