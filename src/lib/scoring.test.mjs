import { test } from "node:test";
import assert from "node:assert/strict";

import {
  competitionWinners,
  effectivePoints,
  latestApproved,
  scoreApproved,
} from "./scoring.mjs";

const task = (overrides = {}) => ({
  id: "task-1",
  points: 5,
  scoring_mode: "fixed",
  points_per_unit: 0,
  competition_bonus: 0,
  winner_team_id: null,
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

test("competition tasks award the bonus only to the team the organizer picked", () => {
  const undecided = task({ scoring_mode: "competition", competition_bonus: 3 });
  assert.equal(effectivePoints(undecided, null, "team-a"), 5);

  const decided = task({
    scoring_mode: "competition",
    competition_bonus: 3,
    winner_team_id: "team-b",
  });
  assert.equal(effectivePoints(decided, null, "team-b"), 8);
  assert.equal(effectivePoints(decided, null, "team-a"), 5);
});

test("competition bonuses ignore measurements entirely", () => {
  // The old rule handed the bonus to whoever posted the highest number, so a
  // team's score moved when somebody else was judged. Nothing but the
  // organizer's pick decides it now.
  const decided = task({
    scoring_mode: "competition",
    competition_bonus: 3,
    winner_team_id: "team-b",
  });
  assert.equal(effectivePoints(decided, 99, "team-a"), 5);
  assert.equal(effectivePoints(decided, 0, "team-b"), 8);
});

test("approved scoring uses the latest approval and the picked competition winner", () => {
  const competition = task({
    scoring_mode: "competition",
    competition_bonus: 3,
    winner_team_id: "team-b",
  });
  const scored = scoreApproved(
    [
      row({ id: "old", team_id: "team-a" }),
      row({
        id: "new",
        team_id: "team-a",
        judged_at: "2026-08-23T12:11:00.000Z",
      }),
      row({ id: "other", team_id: "team-b" }),
    ],
    [competition]
  );

  assert.deepEqual(
    scored.map(({ row: scoredRow, points }) => [scoredRow.id, points]),
    [
      ["new", 5],
      ["other", 8],
    ]
  );
});

test("approved scoring reads the winner from the task, never from a snapshot", () => {
  // The winner is chosen after the round, so it cannot have been snapshotted
  // onto the submission at judging time. The frozen bonus AMOUNT still wins.
  const competition = task({
    scoring_mode: "competition",
    competition_bonus: 99,
    winner_team_id: "team-a",
  });
  const scored = scoreApproved(
    [row({ team_id: "team-a", competition_bonus_snapshot: 3 })],
    [competition]
  );
  assert.equal(scored[0].points, 8);
});

test("competitionWinners reports the decided winner and nothing before that", () => {
  const teams = [{ id: "team-b", name: "Blue" }];
  assert.deepEqual(
    competitionWinners([task({ scoring_mode: "competition", competition_bonus: 3 })], teams),
    {}
  );
  assert.deepEqual(
    competitionWinners(
      [
        task({
          scoring_mode: "competition",
          competition_bonus: 3,
          winner_team_id: "team-b",
        }),
      ],
      teams
    ),
    { "task-1": { team: "Blue", bonus: 3 } }
  );
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
