export const SCORING_MODES = ["fixed", "quantity", "competition"];

function integer(value, fallback = 0) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function compareNewest(a, b) {
  const left = `${a.judged_at ?? ""}|${a.created_at ?? ""}|${a.id ?? ""}`;
  const right = `${b.judged_at ?? ""}|${b.created_at ?? ""}|${b.id ?? ""}`;
  return left.localeCompare(right);
}

function isAwarded(row) {
  return row.status === "approved" && row.points_awarded !== null && row.points_awarded !== undefined;
}

export function latestApproved(rows) {
  const winners = new Map();
  for (const row of rows ?? []) {
    if (!isAwarded(row)) continue;
    const key = `${row.round}:${row.team_id}:${row.task_id}`;
    const current = winners.get(key);
    if (!current || compareNewest(row, current) > 0) winners.set(key, row);
  }
  return [...winners.values()];
}

/**
 * What one approved submission is worth.
 *
 * `quantity` is the only mode the judge measures: they count the shirts in the
 * photo and the count buys points at a fixed rate. Objective, decided on the
 * spot, and it never moves afterwards.
 *
 * `competition` deliberately does NOT look at a measurement. The bonus goes to
 * the team named in `winner_team_id`, which an organizer picks once the round is
 * over. It used to go to whoever had posted the highest number so far, which
 * meant an approved task silently lost points the moment another team was
 * judged -- a team watched its own score fall for something it had already
 * finished, and had every reason to go redo it. It also demanded a number for
 * tasks like "the worst photo of Jason", which has no number to give. Until
 * somebody wins, a competition task is simply worth its face value.
 */
export function effectivePoints(task, measurementValue, teamId = null) {
  const baseline = integer(task?.points);
  const mode = SCORING_MODES.includes(task?.scoring_mode) ? task.scoring_mode : "fixed";

  if (mode === "quantity") {
    const measurement =
      measurementValue === null || measurementValue === undefined ? 0 : integer(measurementValue);
    return baseline + measurement * integer(task.points_per_unit);
  }

  if (mode === "competition" && task?.winner_team_id && task.winner_team_id === teamId) {
    return baseline + integer(task.competition_bonus);
  }

  return baseline;
}

export function scoreApproved(rows, tasks) {
  const taskById = new Map((tasks ?? []).map((task) => [task.id, task]));

  return latestApproved(rows).map((row) => {
    const task = taskById.get(row.task_id);
    const rule = task
      ? {
          ...task,
          points: row.task_points ?? task.points,
          scoring_mode: row.scoring_mode_snapshot ?? task.scoring_mode,
          points_per_unit: row.points_per_unit_snapshot ?? task.points_per_unit,
          competition_bonus: row.competition_bonus_snapshot ?? task.competition_bonus,
          // Never snapshotted: the winner is chosen after the round, long after
          // this row was judged, so the task row is the only place it lives.
          winner_team_id: task.winner_team_id ?? null,
        }
      : null;
    return {
      row,
      points: rule
        ? effectivePoints(rule, row.measurement_value, row.team_id)
        : row.points_awarded ?? 0,
    };
  });
}

/**
 * The decided competition winners, for display.
 *
 * Reads tasks alone -- no submissions, because the answer is a column now. An
 * undecided task is absent rather than present-and-empty, so a caller can only
 * render a winner that actually exists.
 */
export function competitionWinners(tasks, teams = []) {
  const teamById = new Map((teams ?? []).map((team) => [team.id, team]));
  const winners = {};
  for (const task of tasks ?? []) {
    if (task?.scoring_mode !== "competition" || !task.winner_team_id) continue;
    winners[task.id] = {
      team: teamById.get(task.winner_team_id)?.name ?? "a team",
      bonus: integer(task.competition_bonus),
    };
  }
  return winners;
}
