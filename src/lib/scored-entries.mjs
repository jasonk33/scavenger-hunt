/**
 * Selects the approved evidence that contributes to a team's score.
 *
 * This mirrors `team_scores`: one latest approved row per round/team/task,
 * followed by restoring the other approved files in that winning group.
 * Rejections are intentionally excluded.
 */

function groupKey(row) {
  return row.group_id ?? row.id;
}

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

function scoreKey(row) {
  return `${row.round}:${row.team_id}:${row.task_id}`;
}

function isAwarded(row) {
  return row.status === "approved" && row.points_awarded !== null && row.points_awarded !== undefined;
}

/** Return the one approved row that scores each round/team/task combination. */
export function latestApproved(rows) {
  const winners = new Map();
  for (const row of rows) {
    if (!isAwarded(row)) continue;
    const key = scoreKey(row);
    const current = winners.get(key);
    if (!current || compareNewest(row, current) > 0) winners.set(key, row);
  }
  return [...winners.values()];
}

function sameEvidence(row, winner) {
  return (
    row.round === winner.round &&
    row.team_id === winner.team_id &&
    row.task_id === winner.task_id &&
    groupKey(row) === groupKey(winner)
  );
}

function compareOldest(a, b) {
  const fields = [
    [a.created_at ?? "", b.created_at ?? ""],
    [a.id ?? "", b.id ?? ""],
  ];
  for (const [left, right] of fields) {
    if (left === right) continue;
    return left < right ? -1 : 1;
  }
  return 0;
}

/**
 * Return winning evidence groups, with files in capture order.
 *
 * Each returned group is one score-bearing task for one team. The caller can
 * attach task, team, player, and media metadata without accidentally showing
 * duplicate approvals that do not contribute to the score.
 */
export function winningGroups(rows) {
  const approved = rows.filter(isAwarded);
  return latestApproved(approved).map((winner) =>
    approved
      .filter((row) => sameEvidence(row, winner))
      .sort(compareOldest)
  );
}
