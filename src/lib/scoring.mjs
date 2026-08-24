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

export function effectivePoints(task, measurementValue, comparisonValues = []) {
  const baseline = integer(task?.points);
  const mode = SCORING_MODES.includes(task?.scoring_mode) ? task.scoring_mode : "fixed";
  const measurement =
    measurementValue === null || measurementValue === undefined ? null : integer(measurementValue);

  if (mode === "quantity") {
    return baseline + (measurement ?? 0) * integer(task.points_per_unit);
  }

  if (mode === "competition" && measurement !== null && comparisonValues.length > 0) {
    const valid = comparisonValues
      .filter((value) => value !== null && value !== undefined)
      .map(integer)
      .filter((value) => value >= 0);
    if (valid.length > 0 && measurement === Math.max(...valid)) {
      return baseline + integer(task.competition_bonus);
    }
  }

  return baseline;
}

export function scoreApproved(rows, tasks) {
  const taskById = new Map((tasks ?? []).map((task) => [task.id, task]));
  const latest = latestApproved(rows);
  const valuesByTask = new Map();
  for (const row of latest) {
    const task = taskById.get(row.task_id);
    if (!task || (row.scoring_mode_snapshot ?? task.scoring_mode) !== "competition") continue;
    const key = `${row.round}:${row.task_id}`;
    const values = valuesByTask.get(key) ?? [];
    values.push(row.measurement_value);
    valuesByTask.set(key, values);
  }

  return latest.map((row) => {
    const task = taskById.get(row.task_id);
    const comparisonValues = task && (row.scoring_mode_snapshot ?? task.scoring_mode) === "competition"
      ? valuesByTask.get(`${row.round}:${row.task_id}`) ?? []
      : [];
    const rule = task
      ? {
          ...task,
          points: row.task_points ?? task.points,
          scoring_mode: row.scoring_mode_snapshot ?? task.scoring_mode,
          measurement_threshold: row.measurement_threshold_snapshot ?? task.measurement_threshold,
          points_per_unit: row.points_per_unit_snapshot ?? task.points_per_unit,
          measurement_cap: row.measurement_cap_snapshot ?? task.measurement_cap,
          competition_bonus: row.competition_bonus_snapshot ?? task.competition_bonus,
        }
      : null;
    return {
      row,
      points: rule
        ? effectivePoints(rule, row.measurement_value, comparisonValues)
        : row.points_awarded ?? 0,
    };
  });
}

export function competitionLeaders(rows, tasks, teams = []) {
  const taskById = new Map((tasks ?? []).map((task) => [task.id, task]));
  const teamById = new Map((teams ?? []).map((team) => [team.id, team]));
  const latest = latestApproved(rows);
  const leaders = {};
  const grouped = new Map();

  for (const row of latest) {
    const task = taskById.get(row.task_id);
    const mode = row.scoring_mode_snapshot ?? task?.scoring_mode;
    if (!task || mode !== "competition" || row.measurement_value === null) continue;
    const key = `${row.round}:${row.task_id}`;
    const entries = grouped.get(key) ?? [];
    entries.push(row);
    grouped.set(key, entries);
  }

  for (const entries of grouped.values()) {
    const best = Math.max(...entries.map((row) => integer(row.measurement_value)));
    const winners = entries
      .filter((row) => integer(row.measurement_value) === best)
      .map((row) => teamById.get(row.team_id)?.name ?? "a team");
    const task = taskById.get(entries[0].task_id);
    const bonus = entries[0].competition_bonus_snapshot ?? task?.competition_bonus;
    leaders[entries[0].task_id] = {
      value: best,
      teams: winners,
      bonus: integer(bonus),
    };
  }
  return leaders;
}
