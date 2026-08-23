/**
 * Several files, one piece of evidence.
 *
 * A submission row is still one file -- that is what keeps the upload path, the
 * team/points denormalization and the `team_scores` view exactly as they were.
 * What changes is that rows can be tied together by `group_id`, so the judge
 * reviews and decides them as a unit and the player sees them as one thing.
 *
 * `group_id` is nullable and every read goes through `groupKey`, so a row
 * without one is a group of one -- precisely how the app behaved before groups
 * existed. A missing or half-finished backfill is therefore a non-event rather
 * than an outage.
 *
 * Isomorphic on purpose: the route handlers and the three screens all group the
 * same way, and two implementations would eventually disagree about it.
 */

/** The id several files share. A row without one stands alone. */
export function groupKey(row: { id: string; group_id: string | null }): string {
  return row.group_id ?? row.id;
}

/**
 * Collapse rows into groups, preserving the order they arrived in: a group sits
 * wherever its first row sat. Callers sort rows the way they want the groups
 * sorted, and this never reorders them.
 *
 * Takes the key as a function because the server groups database rows
 * (`group_id`) and the browser groups the shapes the API sends back
 * (`groupId`), and one implementation is better than two that drift.
 */
export function groupBy<T>(rows: readonly T[], key: (row: T) => string): T[][] {
  const members = new Map<string, T[]>();
  const order: string[] = [];
  for (const row of rows) {
    const k = key(row);
    const existing = members.get(k);
    if (existing) {
      existing.push(row);
    } else {
      members.set(k, [row]);
      order.push(k);
    }
  }
  return order.map((k) => members.get(k) as T[]);
}

/**
 * Longest note we store. Long enough for the "the guy in the red hat is a
 * stranger" clarification this exists for, short enough that it cannot push the
 * judge's Approve button off the screen or bloat the five-second poll.
 */
export const NOTE_MAX = 280;

/** Trim and cap a player-supplied note. Empty becomes null, never "". */
export function cleanNote(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.trim().slice(0, NOTE_MAX) || null;
}

/**
 * Longest rejection reason we store. The judge types this free-hand under time
 * pressure -- a fixed menu of four reasons could not say "the stranger is
 * clearly your brother" -- so it needs room for a sentence, but it renders on
 * the player's task list and in the feed, where a paragraph would push
 * everything else off a phone screen.
 *
 * Lives here beside NOTE_MAX so the browser's maxLength and the server's cap
 * are one number. Two copies would silently truncate text the judge watched
 * themselves type.
 */
export const REASON_MAX = 200;

/** Trim and cap a judge-typed rejection reason. Empty becomes null, never "". */
export function cleanReason(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.trim().slice(0, REASON_MAX) || null;
}
