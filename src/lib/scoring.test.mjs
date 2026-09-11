import { test } from "node:test";
import assert from "node:assert/strict";

import {
  awardedBreakdown,
  SCORING_MODES,
  effectivePoints,
  latestApproved,
  pointsBreakdown,
  scoreApproved,
} from "./scoring.mjs";

const task = (overrides = {}) => ({
  id: "task-1",
  points: 5,
  scoring_mode: "fixed",
  points_per_unit: 0,
  ...overrides,
});

const row = (overrides = {}) => ({
  id: "submission-1",
  round: 1,
  team_id: "team-a",
  task_id: "task-1",
  status: "approved",
  points_awarded: 5,
  measurement_value: null,
  created_at: "2026-08-23T12:00:00.000Z",
  judged_at: "2026-08-23T12:10:00.000Z",
  ...overrides,
});

test("quantity tasks add the configured points for every measured item", () => {
  const quantity = task({
    scoring_mode: "quantity",
    points_per_unit: 2,
  });

  assert.equal(effectivePoints(quantity, 0), 5);
  assert.equal(effectivePoints(quantity, 3), 11);
  assert.equal(effectivePoints(quantity, 99), 203);
});

test("only fixed and quantity scoring remain supported", () => {
  assert.deepEqual(SCORING_MODES, ["fixed", "quantity"]);
});

test("legacy competition tasks are fixed even with a winner and a measurement", () => {
  const decided = task({
    scoring_mode: "competition",
    competition_bonus: 3,
    winner_team_id: "team-b",
  });
  assert.equal(effectivePoints(decided, 99, "team-b"), 5);
  assert.equal(effectivePoints(decided, null, "team-a"), 5);
});

test("approved scoring uses the latest approval, not the highest quantity", () => {
  const quantity = task({ scoring_mode: "quantity", points_per_unit: 2 });
  const scored = scoreApproved(
    [
      row({ id: "old", team_id: "team-a", measurement_value: 10, points_awarded: 25 }),
      row({
        id: "new",
        team_id: "team-a",
        measurement_value: 1,
        points_awarded: 7,
        judged_at: "2026-08-23T12:11:00.000Z",
      }),
      row({ id: "other", team_id: "team-b", measurement_value: 3, points_awarded: 11 }),
    ],
    [quantity]
  );

  assert.deepEqual(
    scored.map(({ row: scoredRow, points }) => [scoredRow.id, points]),
    [
      ["new", 7],
      ["other", 11],
    ]
  );
});

test("legacy competition snapshots retain the stored approval without a winner effect", () => {
  const competition = task({
    scoring_mode: "competition",
    competition_bonus: 99,
    winner_team_id: "team-a",
  });
  const scored = scoreApproved(
    [row({ task_points: 10, points_awarded: 5, scoring_mode_snapshot: "competition", competition_bonus_snapshot: 3 })],
    [competition]
  );
  assert.equal(scored[0].points, 5);
  assert.equal(scored[0].base, 5);
  assert.equal(scored[0].bonus, 0);
});

test("quantity snapshots survive a later fixed task edit", () => {
  const [scored] = scoreApproved([row({
    task_points: 3, scoring_mode_snapshot: "quantity", points_per_unit_snapshot: 2,
    measurement_value: 4, points_awarded: 11,
  })], [task({ points: 10, scoring_mode: "fixed", points_per_unit: 0 })]);
  assert.deepEqual([scored.base, scored.bonus, scored.points], [3, 8, 11]);
});

test("approved scoring keeps the submission baseline when the task is edited later", () => {
  const quantity = task({
    points: 10,
    scoring_mode: "quantity",
    points_per_unit: 1,
  });
  const scored = scoreApproved(
    [row({ task_points: 5, measurement_value: 2, points_awarded: 7 })],
    [quantity]
  );
  assert.equal(scored[0].points, 7);
});

test("latestApproved agrees with scored-entries on a trimmed fractional second", async () => {
  // Postgres returns a whole second with no fractional part at all, so two
  // rulings a fraction apart have different-length timestamps. Both modules
  // pick the winner for the same team and task, and a route looks one up in the
  // other's answer, so they have to agree on this shape.
  const { winningGroups } = await import("./scored-entries.mjs");
  const onTheSecond = row({ id: "on-the-second", judged_at: "2026-09-04T14:00:00+00:00" });
  const aHalfLater = row({ id: "a-half-later", judged_at: "2026-09-04T14:00:00.5+00:00" });

  assert.deepEqual(
    latestApproved([onTheSecond, aHalfLater]).map((r) => r.id),
    ["a-half-later"]
  );
  assert.deepEqual(
    winningGroups([onTheSecond, aHalfLater]).map((files) => files.map((f) => f.id)),
    [["a-half-later"]]
  );
});

test("latestApproved excludes rejected and unawarded rows", () => {
  assert.deepEqual(
    latestApproved([
      row(),
      row({ id: "rejected", status: "rejected", points_awarded: null }),
      row({ id: "unawarded", points_awarded: null }),
    ]).map((item) => item.id),
    ["submission-1"]
  );
});

test("pointsBreakdown splits what the task was worth from what was earned on top", () => {
  const quantity = task({ points: 10, scoring_mode: "quantity", points_per_unit: 1 });
  assert.deepEqual(pointsBreakdown(quantity, 2), { base: 10, bonus: 2, total: 12 });
  assert.deepEqual(pointsBreakdown(quantity, 0), { base: 10, bonus: 0, total: 10 });
  assert.deepEqual(pointsBreakdown(quantity, null), { base: 10, bonus: 0, total: 10 });

  const fixed = task({ points: 3 });
  assert.deepEqual(pointsBreakdown(fixed, null), { base: 3, bonus: 0, total: 3 });
});

test("pointsBreakdown ignores retired winner metadata", () => {
  const decided = task({
    scoring_mode: "competition",
    competition_bonus: 3,
    winner_team_id: "team-b",
  });
  assert.deepEqual(pointsBreakdown(decided, null, "team-b"), { base: 5, bonus: 0, total: 5 });
  assert.deepEqual(pointsBreakdown(decided, null, "team-a"), { base: 5, bonus: 0, total: 5 });
});

test("scoreApproved reports the breakdown alongside the total", () => {
  const quantity = task({ points: 10, scoring_mode: "quantity", points_per_unit: 1 });
  const [scored] = scoreApproved([row({ measurement_value: 2, points_awarded: 12 })], [quantity]);
  assert.equal(scored.points, 12);
  assert.equal(scored.base, 10);
  assert.equal(scored.bonus, 2);
});

test("scoreApproved breaks down the frozen baseline, not the edited one", () => {
  // A task re-tiered after judging must not make the bonus look bigger (or
  // negative) in hindsight: both halves come off the same snapshot.
  const quantity = task({ points: 10, scoring_mode: "quantity", points_per_unit: 1 });
  const [scored] = scoreApproved(
    [row({ task_points: 5, measurement_value: 2, points_awarded: 7 })],
    [quantity]
  );
  assert.equal(scored.base, 5);
  assert.equal(scored.bonus, 2);
  assert.equal(scored.points, 7);
});

test("scoreApproved falls back to the awarded number when the task is gone", () => {
  const [scored] = scoreApproved([row({ points_awarded: 4, task_id: "deleted" })], []);
  assert.equal(scored.points, 4);
  assert.equal(scored.base, 4);
  assert.equal(scored.bonus, 0);
});

test("awardedBreakdown reads the baseline the judge froze onto the row", () => {
  assert.deepEqual(awardedBreakdown(row({ points_awarded: 12, task_points: 10 })), {
    base: 10,
    bonus: 2,
    total: 12,
  });
  // No snapshot to compare against, so the whole award is baseline rather than
  // an invented bonus.
  assert.deepEqual(awardedBreakdown(row({ points_awarded: 5, task_points: null })), {
    base: 5,
    bonus: 0,
    total: 5,
  });
  // A baseline above the award (a task re-tiered up after judging) must never
  // render as a negative bonus.
  assert.deepEqual(awardedBreakdown(row({ points_awarded: 3, task_points: 10 })), {
    base: 3,
    bonus: 0,
    total: 3,
  });
});
