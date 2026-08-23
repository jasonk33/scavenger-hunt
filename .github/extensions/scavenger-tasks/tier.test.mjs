#!/usr/bin/env node
/**
 * Unit tests for the tier recommendation and its dismissal.
 *
 *   node --test .github/extensions/scavenger-tasks/tier.test.mjs
 *
 * The property that matters is narrow and easy to get wrong: dismissing a
 * suggestion must silence THAT suggestion and nothing else. A dismissal that
 * outlives a re-rating hides a real disagreement behind a decision made about a
 * different number, which is the same failure mode as a publish banner that
 * says "all live" because the check quietly failed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { scoreOf, suggestedPoints, tierAdvice } from "./tier.mjs";

/** The fitted model the board ships with. */
const model = {
  weights: { difficulty: 1.2, guts: 1.0, luck: 0.6 },
  thresholds: { t1: 5.9, t3: 8.1, t5: 10.8 },
};

const task = (over = {}) => ({
  round: 1, points: 3, difficulty: 3, guts: 3, luck: 3, payoff: 3, risk: 1, tierOk: null, ...over,
});

// -------------------------------------------------------------------- scoring

test("the score is the weighted sum of difficulty, guts and luck only", () => {
  // payoff and risk deliberately do not price a task; they flag it.
  const round2 = (n) => Math.round(n * 100) / 100;
  assert.equal(round2(scoreOf(task({ difficulty: 1, guts: 1, luck: 1 }), model.weights)), 2.8);
  assert.equal(
    round2(scoreOf(task({ difficulty: 1, guts: 1, luck: 1, payoff: 5, risk: 5 }), model.weights)),
    2.8
  );
});

test("each threshold picks the tier at and below its cutoff", () => {
  assert.equal(suggestedPoints(task({ difficulty: 1, guts: 1, luck: 1 }), model), 1);
  assert.equal(suggestedPoints(task({ difficulty: 3, guts: 3, luck: 1 }), model), 3);
  assert.equal(suggestedPoints(task({ difficulty: 4, guts: 4, luck: 2 }), model), 5);
  assert.equal(suggestedPoints(task({ difficulty: 5, guts: 5, luck: 5 }), model), 10);
});

test("a secret is a 7 by definition and is never scored", () => {
  assert.equal(suggestedPoints(task({ round: 0, difficulty: 1, guts: 1, luck: 1 }), model), 7);
  assert.equal(suggestedPoints(task({ round: 0, difficulty: 5, guts: 5, luck: 5 }), model), 7);
});

test("a secret never disagrees with its own tier", () => {
  assert.equal(tierAdvice(task({ round: 0, points: 7 }), model).show, false);
});

// ----------------------------------------------------------------- disagreeing

test("a tier that matches the ratings shows nothing", () => {
  const t = task({ difficulty: 3, guts: 3, luck: 1, points: 3 });
  assert.equal(tierAdvice(t, model).suggested, 3);
  assert.equal(tierAdvice(t, model).show, false);
});

test("a tier that disagrees with the ratings is shown", () => {
  const t = task({ difficulty: 3, guts: 3, luck: 1, points: 1 });
  const advice = tierAdvice(t, model);
  assert.equal(advice.suggested, 3);
  assert.equal(advice.show, true);
});

// ------------------------------------------------------------------ dismissing

test("dismissing a suggestion silences it without changing the tier", () => {
  const t = task({ difficulty: 3, guts: 3, luck: 1, points: 1, tierOk: 3 });
  const advice = tierAdvice(t, model);
  assert.equal(advice.suggested, 3, "the suggestion is still computed");
  assert.equal(advice.show, false, "it is just no longer nagging");
  assert.equal(t.points, 1, "and the tier the user chose stands");
});

test("re-rating into a DIFFERENT tier resurfaces the advice", () => {
  // The whole reason a dismissal stores a number instead of a boolean. The user
  // rejected "this should be a 3". Rating it up so it now reads as a 5 is a
  // different claim, which they have never seen.
  const t = task({ difficulty: 3, guts: 3, luck: 1, points: 1, tierOk: 3 });
  assert.equal(tierAdvice(t, model).show, false);

  const rerated = { ...t, difficulty: 4, guts: 4, luck: 2 };
  const advice = tierAdvice(rerated, model);
  assert.equal(advice.suggested, 5);
  assert.equal(advice.show, true, "a dismissal of 3 must not silence a suggestion of 5");
});

test("re-rating within the same tier stays dismissed", () => {
  // Nudging a slider without changing the conclusion is not new information.
  const t = task({ difficulty: 3, guts: 3, luck: 1, points: 1, tierOk: 3 });
  const nudged = { ...t, luck: 2 };
  assert.equal(tierAdvice(nudged, model).suggested, 3);
  assert.equal(tierAdvice(nudged, model).show, false);
});

test("a dismissal that drifts back into agreement shows nothing either way", () => {
  const t = task({ difficulty: 3, guts: 3, luck: 1, points: 3, tierOk: 3 });
  assert.equal(tierAdvice(t, model).show, false);
});

test("accepting a suggestion clears the disagreement without needing a dismissal", () => {
  const t = task({ difficulty: 3, guts: 3, luck: 1, points: 3, tierOk: null });
  assert.equal(tierAdvice(t, model).show, false);
});

test("a task that has never been dismissed is not silenced by a missing field", () => {
  // Every task on the board predates tierOk, so undefined must read as "never
  // dismissed" rather than accidentally matching a suggestion.
  const { tierOk, ...legacy } = task({ difficulty: 3, guts: 3, luck: 1, points: 1 });
  void tierOk;
  assert.equal(tierAdvice(legacy, model).show, true);
});

test("a stale dismissal cannot silence every tier at once", () => {
  // Guards the tempting `tierOk: true` shortcut: a truthy flag would hide the
  // arrow no matter what the ratings later said.
  const t = task({ difficulty: 5, guts: 5, luck: 5, points: 1, tierOk: 3 });
  assert.equal(tierAdvice(t, model).suggested, 10);
  assert.equal(tierAdvice(t, model).show, true);
});
