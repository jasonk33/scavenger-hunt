/**
 * The rollup the canvas header and the `summary` action both render.
 *
 *   node --test .github/extensions/scavenger-tasks/store.test.mjs
 *
 * `summarize` takes the task list rather than fetching one, which is what makes
 * this file safe: importing the store must not open a connection, read
 * `.env.local` or reach the one Supabase project holding the live event. The
 * first test below is there to keep it that way -- the client is built lazily on
 * purpose, and a module-level `createTaskClient()` would turn every test run
 * into a live read.
 *
 * The counts matter because they are what Jason reads before deciding the list
 * is done, and because every task in them is one a player can already see. A
 * miscount here is not cosmetic: "35 live" when it is really 34 is the kind of
 * thing nobody notices until the tasks are printed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { summarize } from "./store.mjs";

let n = 0;
const task = (over = {}) => ({
  slug: `t-${++n}`,
  round: 1,
  docTitle: "",
  title: `Task ${n}`,
  points: 3,
  docOrder: n,
  prop: "",
  active: true,
  rewrite: false,
  note: "",
  ...over,
});

const board = (tasks) => ({ tasks });

test("the summary contains only ordinary assigned-point and planning counts", () => {
  const summary = summarize(board([task({ points: 7, prop: "hat" })]));
  assert.deepEqual(Object.keys(summary.rounds), ["1", "2"]);
  assert.deepEqual(summary.rounds[1], {
    count: 1, tiers: { 7: 1 }, maxPoints: 7, needsProp: 1,
  });
});

test("importing the store does not connect to anything", () => {
  // If this file got this far, the import at the top already succeeded without
  // credentials. Stated as a test so the reason is visible when someone is
  // tempted to build the client at module scope.
  assert.equal(typeof summarize, "function");
});

test("an empty list reports zeroes rather than throwing", () => {
  const s = summarize(board([]));
  assert.equal(s.total, 0);
  assert.equal(s.live, 0);
  assert.equal(s.rounds[1].count, 0);
  assert.equal(s.rounds[1].maxPoints, 0);
  assert.deepEqual(s.rounds[1].tiers, {});
});

test("a missing list is survivable", () => {
  // The header renders before the first read lands.
  for (const input of [undefined, null, {}, { tasks: [] }]) {
    assert.equal(summarize(input).total, 0, JSON.stringify(input));
  }
});

test("the live and cut counts cover every task between them", () => {
  const s = summarize(board([
    task({ active: true }), task({ active: true }), task({ active: true }),
    task({ active: false }), task({ active: false }), task({ active: false }),
  ]));
  assert.equal(s.total, 6, "total is every task, cut ones included");
  assert.equal(s.live, 3);
  assert.equal(s.cut, 3);
  assert.equal(s.live + s.cut, s.total, "no task may fall outside the two");
});

test("a cut task is excluded from the round rollup but not from the total", () => {
  // A cut task is hidden from players the moment it is cut, so it must stop
  // counting towards what they will face -- which is what maxPoints is for.
  const s = summarize(board([
    task({ round: 1, points: 5, active: true }),
    task({ round: 1, points: 10, active: false }),
  ]));
  assert.equal(s.total, 2);
  assert.equal(s.rounds[1].count, 1);
  assert.equal(s.rounds[1].maxPoints, 5, "a cut task's points are not on the table");
  assert.deepEqual(s.rounds[1].tiers, { 5: 1 });
});

test("rounds are kept apart", () => {
  const s = summarize(board([
    task({ round: 1 }), task({ round: 1 }),
    task({ round: 2 }),
    task({ round: 2, points: 7 }),
  ]));
  assert.equal(s.rounds[1].count, 2);
  assert.equal(s.rounds[2].count, 2);
  assert.equal(s.rounds[2].maxPoints, 10);
});

test("empty tiers are omitted rather than reported as zero", () => {
  const s = summarize(board([task({ points: 1 }), task({ points: 1 }), task({ points: 10 })]));
  assert.deepEqual(s.rounds[1].tiers, { 1: 2, 10: 1 });
});

test("the prop count includes only tasks still in the running", () => {
  const s = summarize(board([
    task({ round: 1, prop: "hat" }),
    task({ round: 1, prop: "rope", active: false }),
    task({ round: 1, prop: "" }),
  ]));
  assert.equal(s.rounds[1].needsProp, 1);
});

test("flaggedForRewrite spans the whole list, not one round", () => {
  const s = summarize(board([
    task({ round: 1, rewrite: true }),
    task({ round: 2, rewrite: true }),
    task({ round: 2, rewrite: true, active: false }),
    task({ round: 1, rewrite: false }),
  ]));
  assert.equal(s.flaggedForRewrite, 3);
});
