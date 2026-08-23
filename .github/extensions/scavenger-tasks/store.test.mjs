/**
 * The board rollup the canvas header and the `summary` action both render.
 *
 *   node --test .github/extensions/scavenger-tasks/store.test.mjs
 *
 * `summarize` takes a board rather than fetching one, which is what makes this
 * file safe: importing the store must not open a connection, read `.env.local`
 * or reach the one Supabase project holding the live event. The first test below
 * is there to keep it that way -- the client is built lazily on purpose, and a
 * module-level `createAdminClient()` would turn every test run into a live read.
 *
 * The counts matter because they are what Jason reads before deciding the board
 * is done. A miscount here is not cosmetic: "35 in" when it is really 34 is the
 * kind of thing nobody notices until the tasks are printed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { summarize } from "./store.mjs";

/** The fitted model, so `mismatched` means what it means in the real canvas. */
const MODEL = { weights: { difficulty: 1.2, guts: 1.0, luck: 0.6 }, thresholds: { t1: 5.9, t3: 8.1, t5: 10.8 } };

let n = 0;
const task = (over = {}) => ({
  id: `t-${++n}`,
  round: 1,
  docTitle: "",
  title: `Task ${n}`,
  points: 3,
  docOrder: n,
  difficulty: 3,
  guts: 3,
  luck: 3,
  payoff: 3,
  risk: 1,
  needsClip: false,
  prop: "",
  status: "keep",
  rewrite: false,
  note: "",
  tierOk: null,
  ...over,
});

const board = (tasks) => ({ model: MODEL, tasks });

test("importing the store does not connect to anything", () => {
  // If this file got this far, the import at the top already succeeded without
  // credentials. Stated as a test so the reason is visible when someone is
  // tempted to build the client at module scope.
  assert.equal(typeof summarize, "function");
});

test("an empty board reports zeroes rather than throwing", () => {
  const s = summarize(board([]));
  assert.equal(s.total, 0);
  assert.equal(s.keep, 0);
  assert.equal(s.rounds[1].count, 0);
  assert.equal(s.rounds[1].avgPayoff, 0, "no division by zero");
  assert.deepEqual(s.rounds[1].tiers, {});
});

test("a missing board is survivable", () => {
  // The header renders before the first read lands.
  for (const input of [undefined, null, {}, { tasks: [] }]) {
    assert.equal(summarize(input).total, 0, JSON.stringify(input));
  }
});

test("status counts cover every task, cut included", () => {
  const s = summarize(board([
    task({ status: "keep" }), task({ status: "keep" }),
    task({ status: "maybe" }),
    task({ status: "cut" }), task({ status: "cut" }), task({ status: "cut" }),
  ]));
  assert.equal(s.total, 6, "total is every task on the board");
  assert.equal(s.keep, 2);
  assert.equal(s.maybe, 1);
  assert.equal(s.cut, 3);
  assert.equal(s.keep + s.maybe + s.cut, s.total, "no task may fall outside the three");
});

test("a cut task is excluded from the round rollup but not from the board total", () => {
  // Cutting a task is a decision already made; it must stop counting towards
  // what players will actually face, which is what maxPoints is for.
  const s = summarize(board([
    task({ round: 1, points: 5, status: "keep" }),
    task({ round: 1, points: 10, status: "cut" }),
  ]));
  assert.equal(s.total, 2);
  assert.equal(s.rounds[1].count, 1);
  assert.equal(s.rounds[1].maxPoints, 5, "a cut task's points are not on the table");
  assert.deepEqual(s.rounds[1].tiers, { 5: 1 });
});

test("a maybe still counts as in — it publishes as live", () => {
  const s = summarize(board([task({ round: 1, points: 3, status: "maybe" })]));
  assert.equal(s.rounds[1].count, 1);
  assert.equal(s.rounds[1].maxPoints, 3);
});

test("rounds are kept apart, and secrets are their own round", () => {
  const s = summarize(board([
    task({ round: 1 }), task({ round: 1 }),
    task({ round: 2 }),
    task({ round: 0, points: 7 }),
  ]));
  assert.equal(s.rounds[1].count, 2);
  assert.equal(s.rounds[2].count, 1);
  assert.equal(s.rounds[0].count, 1, "round 0 is falsy and must not be lost");
  assert.equal(s.rounds[0].maxPoints, 7);
});

test("empty tiers are omitted rather than reported as zero", () => {
  const s = summarize(board([task({ points: 1 }), task({ points: 1 }), task({ points: 10 })]));
  assert.deepEqual(s.rounds[1].tiers, { 1: 2, 10: 1 });
});

test("a secret never counts as disagreeing with its ratings", () => {
  // Secrets sit outside the scoring model -- they are a 7 by definition -- so a
  // 7 that the thresholds would price differently is not a disagreement.
  const s = summarize(board([task({ round: 0, points: 7, difficulty: 1, guts: 1, luck: 1 })]));
  assert.equal(s.rounds[0].mismatched, 0);
});

test("a tier that disagrees with the ratings is counted, and one that agrees is not", () => {
  // difficulty 1, guts 1, luck 1 scores 2.8, which is under t1 -- a 1-pointer.
  const cheap = { difficulty: 1, guts: 1, luck: 1 };
  assert.equal(summarize(board([task({ points: 1, ...cheap })])).rounds[1].mismatched, 0);
  assert.equal(summarize(board([task({ points: 10, ...cheap })])).rounds[1].mismatched, 1);
});

test("a dismissed suggestion still counts here, because this is not the row's advice", () => {
  // `summarize` answers "does the tier match the ratings", which tierOk does not
  // change. The row's arrow uses tierAdvice, which does. Conflating them would
  // make the header disagree with the list it sits above -- in either direction.
  const cheap = { difficulty: 1, guts: 1, luck: 1 };
  assert.equal(summarize(board([task({ points: 10, tierOk: 1, ...cheap })])).rounds[1].mismatched, 1);
});

test("the per-round flags count only tasks still in the running", () => {
  const s = summarize(board([
    task({ round: 1, needsClip: true, prop: "hat", risk: 5, luck: 5, payoff: 5 }),
    task({ round: 1, needsClip: true, prop: "", risk: 1, luck: 1, payoff: 1, status: "cut" }),
  ]));
  assert.equal(s.rounds[1].needsClip, 1, "the cut one does not need a clip from anybody");
  assert.equal(s.rounds[1].needsProp, 1);
  assert.equal(s.rounds[1].highRisk, 1);
  assert.equal(s.rounds[1].highLuck, 1);
  assert.equal(s.rounds[1].avgPayoff, 5, "averaged over what is left, not over everything");
});

test("high risk and high luck start at 4, not above it", () => {
  assert.equal(summarize(board([task({ risk: 3, luck: 3 })])).rounds[1].highRisk, 0);
  assert.equal(summarize(board([task({ risk: 4, luck: 4 })])).rounds[1].highRisk, 1);
  assert.equal(summarize(board([task({ risk: 4, luck: 4 })])).rounds[1].highLuck, 1);
});

test("flaggedForRewrite spans the whole board, not one round", () => {
  const s = summarize(board([
    task({ round: 1, rewrite: true }),
    task({ round: 2, rewrite: true }),
    task({ round: 0, rewrite: false }),
  ]));
  assert.equal(s.flaggedForRewrite, 2);
});

test("avgPayoff is rounded to two places rather than left as a long float", () => {
  const s = summarize(board([task({ payoff: 1 }), task({ payoff: 2 }), task({ payoff: 2 })]));
  assert.equal(s.rounds[1].avgPayoff, 1.67);
});
