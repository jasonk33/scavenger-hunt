/**
 * The tier recommendation, kept out of the renderer so the one rule that can go
 * quietly wrong is provable. Imported by `ui.js` in the browser and by
 * `tier.test.mjs` under `node --test`, so it stays plain ESM with no DOM.
 *
 * A task carries both a tier you assigned (`points`) and five ratings. Scoring
 * the ratings against the model's thresholds produces a *suggested* tier. Where
 * the two disagree the row shows `assigned -> suggested`.
 *
 * You can also disagree with the suggestion, and that decision has to stick --
 * otherwise a task you have deliberately priced keeps nagging forever. But a
 * blanket "never show this again" would be a false negative of exactly the kind
 * the publish banner is built to avoid: re-rating a task so it lands in a
 * *different* tier is new information, and must resurface.
 *
 * So a dismissal records WHICH suggestion was rejected (`tierOk`), not merely
 * that one was. It silences that suggestion and nothing else.
 */

/** Point tiers, mirroring TIERS in store.mjs and the 1/3/5/7/10 tiers in the app. */
const SECRET_TIER = 7;

export function scoreOf(task, weights) {
  const w = weights ?? {};
  return (
    Number(task?.difficulty ?? 0) * Number(w.difficulty ?? 0) +
    Number(task?.guts ?? 0) * Number(w.guts ?? 0) +
    Number(task?.luck ?? 0) * Number(w.luck ?? 0)
  );
}

/**
 * The tier the ratings imply. A secret sits outside the scoring model -- it is
 * a 7 by definition -- so it never produces a suggestion to move.
 */
export function suggestedPoints(task, model) {
  if (Number(task?.round) === 0) return SECRET_TIER;
  const s = scoreOf(task, model?.weights);
  const { t1, t3, t5 } = model?.thresholds ?? {};
  if (s <= t1) return 1;
  if (s <= t3) return 3;
  if (s <= t5) return 5;
  return 10;
}

/**
 * What the row should show for a task.
 *
 * `show` is the single source of truth for the arrow, the header's disagreement
 * count and the "Tier disagreement" sort, so those three can never drift into
 * disagreeing about what counts as a disagreement.
 */
export function tierAdvice(task, model) {
  const suggested = suggestedPoints(task, model);
  const points = Number(task?.points);
  const dismissed = task?.tierOk;
  return {
    suggested,
    // A dismissal only covers the exact suggestion it was made against. Re-rate
    // the task into a different tier and the advice is new, so it comes back.
    show: suggested !== points && dismissed !== suggested,
  };
}
