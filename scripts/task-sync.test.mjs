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

import { normalizeTitle, effectiveTitle, desiredRows, planTaskSync, applyPlan } from "./task-sync.mjs";

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
  const plan = planTaskSync(board([task({ points: 10, status: "keep" })]), [
    live({ points: 3, revealed_at: "2026-08-22T00:00:00Z" }),
  ]);
  for (const u of plan.update) assert.ok(!("revealed_at" in u.patch));
  for (const r of plan.insert) assert.ok(!("revealed_at" in r));
});

test("two tasks in the same round may not resolve to the same title", () => {  // unique (round, title) survives the migration, so a collision has to be caught
  // here rather than as a constraint violation halfway through an --apply.
  const plan = planTaskSync(
    board([task({ id: "r1-a", title: "Same" }), task({ id: "r1-b", docOrder: 2, title: "Same" })]),
    []
  );
  assert.ok(plan.warnings.some((w) => /duplicate title/i.test(w)));
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
