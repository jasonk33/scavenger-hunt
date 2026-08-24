/**
 * The canvas's view of the task list.
 *
 * The tasks live in the `tasks` table, not in this checkout. That is what lets
 * any session edit them: a worktree, a branch, a session on a different git
 * branch entirely, all reading and writing the same rows through the same
 * credentials.
 *
 * There is deliberately no cache. The cache this replaces was the cause of its
 * own bug: a process served its first read forever and wrote that stale copy
 * back over whatever anyone else had done since. `instanceId` is not a storage
 * key either -- every panel, in every session, reads the one list.
 *
 * Queries and validation live in `scripts/task-store.mjs`, so a task means the
 * same thing to the canvas as it does to `npm run ready`. What is left here is
 * the canvas's own arithmetic.
 */

import {
  TIERS,
  addTask as insertTask,
  createTaskClient,
  readTasks,
  updateModel as writeModel,
  updateTask as patchTask,
} from "../../../scripts/task-store.mjs";
import { suggestedPoints } from "./tier.mjs";

/**
 * Built on first use, never on import.
 *
 * The extension is forked by Copilot at session start, long before anyone opens
 * the canvas. Anything that can throw up here does not fail a query, it fails
 * the EXTENSION -- no registration, no panel, nothing on screen to explain
 * itself. That is exactly how this broke once: a package import at module scope,
 * in a worktree that has no `node_modules`.
 *
 * So nothing in this file's import graph may need a package or a credential.
 * `scripts/portable.test.mjs` imports it in a bare directory to prove it, and a
 * missing `.env.local` surfaces as a failed request the panel can render.
 */
let db = null;
const client = () => (db ??= createTaskClient());

/**
 * Every write is per-field, on the rows of one task, and LIVE -- a player sees
 * it on their next poll. There is no publish step and nothing staged: the table
 * the canvas edits is the table the app reads.
 */
export const loadTasks = () => readTasks(client());
export const updateTask = (slug, patch) => patchTask(client(), slug, patch);
export const addTask = (input) => insertTask(client(), input);
export const updateModel = (patch) => writeModel(client(), patch);

/**
 * The rollup the UI header and the `summary` action both render.
 *
 * Pure: it takes the list rather than fetching one, so it is provable without a
 * database and cannot be the thing that touches the live event in a test.
 */
export function summarize(board) {
  const tasks = board?.tasks ?? [];
  const model = board?.model;
  const live = tasks.filter((t) => t.active);
  const rounds = {};
  for (const round of [1, 2, 0]) {
    const inRound = live.filter((t) => t.round === round);
    const tiers = {};
    for (const tier of TIERS) {
      const n = inRound.filter((t) => t.points === tier).length;
      if (n) tiers[tier] = n;
    }
    rounds[round] = {
      count: inRound.length,
      tiers,
      maxPoints: inRound.reduce((sum, t) => sum + t.points, 0),
      mismatched: inRound.filter((t) => t.points !== suggestedPoints(t, model)).length,
      avgPayoff: inRound.length ? +(inRound.reduce((s, t) => s + t.payoff, 0) / inRound.length).toFixed(2) : 0,
      requiresVideo: inRound.filter((t) => t.requiresVideo).length,
      needsProp: inRound.filter((t) => t.prop).length,
      highRisk: inRound.filter((t) => t.risk >= 4).length,
      highLuck: inRound.filter((t) => t.luck >= 4).length,
    };
  }
  return {
    total: tasks.length,
    live: live.length,
    cut: tasks.filter((t) => !t.active).length,
    flaggedForRewrite: tasks.filter((t) => t.rewrite).length,
    rounds,
  };
}
