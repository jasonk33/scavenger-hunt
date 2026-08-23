/**
 * Carrying an Admin task edit back to the planning board.
 *
 * Admin writes the `tasks` table directly, so an edit made there is live the
 * moment it is saved -- that is the point of it, it is the emergency lever on
 * the day. But the board owns the same fields, and `scripts/task-sync.mjs`
 * overwrites them on the next publish, so an Admin edit used to be silently
 * reverted with nothing anywhere saying it had been.
 *
 * Mirroring the edit onto the board closes that, for the fields where the two
 * sides mean the same thing. Two deliberately do not:
 *
 *   isSecret  The board has no such column. A secret is `round: 0` and the
 *             planner fans it out into one `tasks` row per round. Writing that
 *             back would mean reimplementing the fan-out here, which is the
 *             planner's job and nowhere else's.
 *   active    The board's only hidden state is `cut`, which is a decision.
 *             Recording "hide this for now" as `cut` would erase the
 *             keep/maybe/cut distinction the board exists to hold.
 *
 * Those two stay diverged and Admin says so on screen.
 *
 * Plain `.mjs` with no imports so it can be unit-tested under `node --test`
 * without a TypeScript build step; `allowJs` lets the route import it directly.
 */

/** The tiers `task_board.points` accepts. Admin's API accepts any positive number. */
const TIERS = [1, 3, 5, 7, 10];

/**
 * Splits an Admin patch into the board columns to write and the fields that
 * cannot be carried.
 *
 * Nothing questionable is ever put in `row`. A value the column would reject
 * fails the whole statement, taking the fields that were fine down with it --
 * so an off-tier point value is skipped rather than attempted, and the title
 * alongside it still lands.
 *
 * @param {Record<string, unknown>|null|undefined} patch  the Admin PATCH body
 * @returns {{row: Record<string, unknown>, skipped: Array<{field: string, why: string}>}}
 *   `skipped` is only for real divergence -- a field that changed `tasks` and
 *   could not change the board. A value Admin itself would have rejected never
 *   reached `tasks` either, so it is absent rather than skipped.
 */
export function boardMirrorPatch(patch) {
  const row = {};
  const skipped = [];
  const p = patch ?? {};

  // Trimmed to match exactly what Admin writes to `tasks`. If the two sides
  // differed by whitespace, every later publish would see a difference and
  // propose an edit nobody made.
  if (typeof p.title === "string" && p.title.trim()) row.title = p.title.trim();

  if (p.points !== undefined && p.points !== null && typeof p.points !== "boolean") {
    const n = Number(p.points);
    if (TIERS.includes(n)) {
      row.points = n;
    } else if (Number.isFinite(n) && n > 0) {
      // Admin accepted it, so `tasks` has it and the board does not: real
      // divergence, and the publish banner will show it as pending drift.
      skipped.push({
        field: "points",
        why: `the board only holds the ${TIERS.join(", ")} tiers, so ${n} could not be recorded on it.`,
      });
    }
  }

  if (typeof p.requiresVideo === "boolean") row.needs_clip = p.requiresVideo;

  if (typeof p.isSecret === "boolean") {
    skipped.push({
      field: "isSecret",
      why: "the board has no secret column -- a secret is round 0 there and fans out to one task per round, so only the board can change it.",
    });
  }

  if (typeof p.active === "boolean") {
    skipped.push({
      field: "active",
      why: "the board's only hidden state is cut, which is a decision rather than a temporary hide, so only the board can change it.",
    });
  }

  // `revealed` is deliberately absent: revealed_at is Admin-owned by design and
  // the planner never proposes writing it, so it is not a divergence.

  return { row, skipped };
}
