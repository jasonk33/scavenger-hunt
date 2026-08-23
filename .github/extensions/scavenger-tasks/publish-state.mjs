/**
 * The publish banner's state machine, kept out of the click handler so it can be
 * proved against fixtures. Imported by `ui.js` in the browser and by
 * `publish-state.test.mjs` under `node --test`, so it stays plain ESM with no
 * DOM and no Node built-ins.
 *
 * One invariant governs the whole thing: **a check that did not succeed must
 * never be readable as "nothing to publish"**. Jason reads this banner minutes
 * before the event and trusts it, so a false negative -- "all live" when the
 * network was down -- is far worse than an honest "I don't know". Every branch
 * below is written to fail towards `unknown`.
 */

/** Only `pending` may publish. Every other state, including every failure, may not. */
const CAN_PUBLISH = {
  unknown: false,
  clean: false,
  pending: true,
  stale: false,
  blocked: false,
  published: false,
};

const state = (kind, headline, detail, count = null) => ({
  kind,
  headline,
  detail,
  count,
  canPublish: CAN_PUBLISH[kind],
});

const unknown = (detail) => state("unknown", "Can't tell what's live", detail);

const plural = (n) => `${n} change${n === 1 ? "" : "s"}`;

/** A count is only a count if it is a non-negative integer. "7", null and NaN are not. */
const isCount = (v) => typeof v === "number" && Number.isInteger(v) && v >= 0;

/**
 * Turns a `task-sync.mjs --json` report into what the banner should say.
 *
 * @param {object|null|undefined} report  parsed report, or anything at all if the
 *   run failed -- a string, a partial object and `undefined` are all expected
 *   inputs, not defensive padding.
 * @param {{staleSince?: number}} [opts]  timestamp of the most recent local board
 *   edit. Newer than the report's `checkedAt` means the number no longer
 *   describes the board.
 */
export function publishState(report, { staleSince = 0 } = {}) {
  // Anything that is not a plain object is a failed fetch, a timeout, an empty
  // body or a non-JSON error page. None of them know anything about the board.
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return unknown("The last check did not come back. Refresh to try again.");
  }

  // An error always wins, even alongside an `ok: true` or a count: a partially
  // written or self-contradictory report is exactly the case not to trust.
  if (report.error) return unknown(String(report.error));

  // Reasons the sync itself would refuse. Stated exactly as the sync stated
  // them, because summarising a refusal loses the fix.
  if (report.refusal) return state("blocked", "Publishing is blocked", String(report.refusal));

  if (Array.isArray(report.collisions) && report.collisions.length) {
    const detail = report.collisions
      .map((c) => `Round ${c.round}: "${c.title}" would be used twice (${(c.between ?? []).join(" and ")}).`)
      .join(" ");
    return state(
      "blocked",
      `${report.collisions.length} title collision${report.collisions.length === 1 ? "" : "s"}`,
      `${detail} Rename one of them on the board, then check again.`
    );
  }

  if (report.migrated === false) {
    return state(
      "blocked",
      "The database is not ready",
      "tasks.board_id does not exist yet -- run supabase/migrate-task-board-id.sql before publishing."
    );
  }

  // Not-ok with no stated reason, or an `ok` that is merely truthy rather than
  // the boolean: something is wrong that this screen does not model, so refuse
  // to guess. After the refusals, so those keep their specific messages.
  if (report.ok !== true) {
    return unknown("The last check came back in a state this screen doesn't recognise. Refresh to try again.");
  }

  if (!isCount(report.count)) {
    return unknown("The last check came back without a change count. Refresh to try again.");
  }

  const count = report.count;
  // Reordering is published but not counted, so it cannot be allowed to vanish:
  // a board whose only pending change is renumbering would otherwise read as
  // "everything is live" while players still saw the old order. Absent on an
  // older report, which means zero rather than unknown.
  const reorder = isCount(report.counts?.reorder) ? report.counts.reorder : 0;
  const tasks = (n) => `${n} task${n === 1 ? "" : "s"}`;

  if (report.applied === true) {
    // Publishing used to have a second half -- committing the board file to git
    // -- which had to be reported here because it could half-fail. The board is
    // a table now, so reaching players IS the whole job and there is nothing
    // outstanding left to mention.
    return state("published", `Published ${plural(count)}`, "Players see the new task list now.", count);
  }

  // The board moved after this number was measured. Show the number, but
  // visibly do not stand behind it -- including when it was zero, which is the
  // direction that would otherwise read as a reassuring "everything is live".
  if (staleSince > (isCount(report.checkedAt) ? report.checkedAt : 0)) {
    return state(
      "stale",
      count > 0 ? `${plural(count)} not yet live` : "Board edited since the last check",
      "Counted before your latest edits -- rechecking.",
      count
    );
  }

  if (count === 0) {
    if (reorder > 0) {
      return state(
        "pending",
        "Task order not yet live",
        `${tasks(reorder)} would move in the player's list. No task wording, points or cuts changed.`,
        0
      );
    }
    return state("clean", "Everything on the board is live", "The app matches the board.", 0);
  }

  return state(
    "pending",
    `${plural(count)} not yet live`,
    reorder > 0
      ? `Players are still seeing the old task list. ${tasks(reorder)} will also move position.`
      : "Players are still seeing the old task list.",
    count
  );
}

/**
 * Fields that exist for the machine rather than for a person. `sort_order` is
 * covered by the reordering footnote, and `board_id` is migration bookkeeping;
 * neither is a decision anyone made, so neither belongs on a change line.
 */
const INVISIBLE_FIELDS = new Set(["sort_order", "board_id"]);

/**
 * One line per change, for the preview panel. Publishing is a live write to the
 * production database, so the button never fires without showing this first.
 * Rendering happens in `ui.js`; this only decides what a change *says*, so it
 * can be read without a browser.
 */
export function describeChanges(report) {
  const c = report?.changes;
  if (!c) return [];
  const lines = [];
  for (const r of c.insert ?? []) {
    lines.push({ kind: "insert", text: `New in round ${r.round}, ${r.points}pt: "${r.title}"` });
  }
  for (const u of c.update ?? []) {
    const fields = (u.fields ?? [])
      .filter((f) => !INVISIBLE_FIELDS.has(f.field))
      .map((f) => `${f.field} ${JSON.stringify(f.from)} \u2192 ${JSON.stringify(f.to)}`)
      .join(", ");
    lines.push({ kind: "update", text: `Round ${u.round} "${u.title}" \u2014 ${fields}` });
  }
  for (const r of c.reactivate ?? []) {
    lines.push({ kind: "reactivate", text: `Back in round ${r.round}: "${r.title}"` });
  }
  for (const d of c.deactivate ?? []) {
    lines.push({ kind: "deactivate", text: `Hidden from players in round ${d.round}: "${d.title}" (never deleted)` });
  }
  return lines;
}
