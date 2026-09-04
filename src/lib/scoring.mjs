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

/**
 * The same answer as `effectivePoints`, split into what the task was worth and
 * what the team earned on top of it.
 *
 * Both halves come off ONE rule object, so a task re-tiered after judging can
 * never make the bonus look bigger -- or negative -- in hindsight. Every screen
 * that shows a score renders this, rather than each one subtracting a baseline
 * it fetched separately and getting a different answer.
 */
export function pointsBreakdown(task, measurementValue, teamId = null) {
  const base = integer(task?.points);
  const total = effectivePoints(task, measurementValue, teamId);
  return { base, bonus: Math.max(0, total - base), total };
}

/**
 * Breakdown for a judged row that `scoreApproved` did not rank -- a second
 * approval on a task the team has already scored, or one whose task has since
 * been cut. There is no task rule to consult, so it reads the baseline the judge
 * froze onto the row and treats the rest of the award as the bonus.
 */
export function awardedBreakdown(row) {
  const total = integer(row?.points_awarded);
  // `integer` treats null as 0, which would report the whole award as bonus.
  const snapshot = row?.task_points;
  const base =
    snapshot === null || snapshot === undefined ? total : Math.min(total, integer(snapshot, total));
  return { base, bonus: total - base, total };
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
    const split = rule
      ? pointsBreakdown(rule, row.measurement_value, row.team_id)
      : // No task row to reason from -- the judge's number is all there is, so
        // it is reported as the baseline with nothing on top of it.
        { base: row.points_awarded ?? 0, bonus: 0, total: row.points_awarded ?? 0 };
    return { row, points: split.total, base: split.base, bonus: split.bonus };
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
