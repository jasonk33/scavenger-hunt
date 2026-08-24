import { test } from "node:test";
import assert from "node:assert/strict";

import {
  effectivePoints,
  latestApproved,
  scoreApproved,
} from "./scoring.mjs";

const task = (overrides = {}) => ({
  id: "task-1",
  points: 5,
  scoring_mode: "fixed",
  measurement_threshold: 0,
  points_per_unit: 0,
  measurement_cap: null,
  competition_bonus: 0,
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

test("quantity tasks add points above the baseline and respect a cap", () => {
  const quantity = task({
    scoring_mode: "quantity",
    measurement_threshold: 3,
    points_per_unit: 2,
    measurement_cap: 6,
  });

  assert.equal(effectivePoints(quantity, 2), 5);
  assert.equal(effectivePoints(quantity, 5), 9);
  assert.equal(effectivePoints(quantity, 99), 11);
});

test("competition tasks award the bonus to every tied leader", () => {
  const competition = task({ scoring_mode: "competition", competition_bonus: 3 });
  assert.equal(effectivePoints(competition, 12, [10, 12, 12]), 8);
  assert.equal(effectivePoints(competition, 10, [10, 12, 12]), 5);
  assert.equal(effectivePoints(competition, null, [10, 12]), 5);
  assert.equal(effectivePoints(competition, null, [null, null]), 5);
});

test("approved scoring uses the latest approval and computes competition bonuses", () => {
  const competition = task({ scoring_mode: "competition", competition_bonus: 3 });
  const scored = scoreApproved(
    [
      row({ id: "old", team_id: "team-a", measurement_value: 10 }),
      row({
        id: "new",
        team_id: "team-a",
        measurement_value: 12,
        judged_at: "2026-08-23T12:11:00.000Z",
      }),
      row({ id: "other", team_id: "team-b", measurement_value: 12 }),
    ],
    [competition]
  );

  assert.deepEqual(
    scored.map(({ row: scoredRow, points }) => [scoredRow.id, points]),
    [
      ["new", 8],
      ["other", 8],
    ]
  );
});

test("approved scoring keeps the submission baseline when the task is edited later", () => {
  const quantity = task({
    points: 10,
    scoring_mode: "quantity",
    measurement_threshold: 0,
    points_per_unit: 1,
  });
  const scored = scoreApproved(
    [row({ task_points: 5, measurement_value: 2, points_awarded: 7 })],
    [quantity]
  );
  assert.equal(scored[0].points, 7);
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
