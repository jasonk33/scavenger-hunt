export const SCORING_MODES = ["fixed", "quantity"];

function integer(value, fallback = 0) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

/**
 * Which of two approved rows the judge ruled on most recently.
 *
 * Field by field, and with `>` rather than `localeCompare`, so that it agrees
 * with the identical comparator in `scored-entries.mjs` -- the two decide the
 * same question for the same team and task, and the routes now look one up in
 * the other's result.
 *
 * They did not agree. Postgres trims trailing zeros off a fractional second, so
 * a row judged exactly on the second comes back as `...T14:00:00+00:00` while
 * its sibling half a second later is `...T14:00:00.5+00:00`. Concatenating and
 * calling `localeCompare` puts the whole second AFTER the half -- collation does
 * not treat `+` and `.` as their code points -- so the older row won and the
 * newer ruling was ignored. Real rows already carry both two- and three-digit
 * fractions, so the zero-digit form is one judging away.
 */
function compareNewest(a, b) {
  const fields = [
    [a.judged_at ?? "", b.judged_at ?? ""],
    [a.created_at ?? "", b.created_at ?? ""],
    [a.id ?? "", b.id ?? ""],
  ];
  for (const [left, right] of fields) {
    if (left === right) continue;
    return left > right ? 1 : -1;
  }
  return 0;
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
 */
export function effectivePoints(task, measurementValue) {
  const baseline = integer(task?.points);

  if (task?.scoring_mode === "quantity") {
    const measurement =
      measurementValue === null || measurementValue === undefined ? 0 : integer(measurementValue);
    return baseline + measurement * integer(task.points_per_unit);
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
export function pointsBreakdown(task, measurementValue) {
  const base = integer(task?.points);
  const total = effectivePoints(task, measurementValue);
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
    const rule = {
      points: row.task_points ?? task?.points ?? row.points_awarded,
      scoring_mode: row.scoring_mode_snapshot ?? task?.scoring_mode,
      points_per_unit: row.points_per_unit_snapshot ?? task?.points_per_unit,
    };
    const split = rule.scoring_mode === "quantity"
      ? pointsBreakdown(rule, row.measurement_value)
      : // Fixed approvals keep the judge's stored award, including legacy rows.
        { base: row.points_awarded ?? 0, bonus: 0, total: row.points_awarded ?? 0 };
    return { row, points: split.total, base: split.base, bonus: split.bonus };
  });
}
