/**
 * The canvas's view of the planning board.
 *
 * The board lives in the `task_board` table, not in this checkout. That is what
 * lets any session edit it: a worktree, a branch, a session on a different git
 * branch entirely, all reading and writing the same rows through the same
 * credentials. It used to be `data/task-board.json`, which gave every checkout
 * its own copy -- so a worktree edited a board nobody published, and two
 * processes each holding it in memory could silently revert each other.
 *
 * There is deliberately no cache. The cache this replaces was the cause of its
 * own bug: a process served its first read forever and wrote that stale copy
 * back over whatever anyone else had done since. `instanceId` is not a storage
 * key either -- every panel, in every session, reads the one board.
 *
 * Queries and validation live in `scripts/board-store.mjs`, shared with the
 * publisher so the two cannot disagree about what a task is. What is left here
 * is the canvas's own arithmetic.
 */

import {
  TIERS,
  addTask as insertTask,
  createAdminClient,
  readBoard,
  updateModel as writeModel,
  updateTask as patchTask,
} from "../../../scripts/board-store.mjs";
import { suggestedPoints } from "./tier.mjs";

/**
 * Built on first use, not on import.
 *
 * The extension is forked by Copilot at session start, long before anyone opens
 * the canvas, and a missing `.env.local` must surface as a failed request with a
 * readable message rather than as an extension that never registers at all.
 */
let db = null;
const client = () => (db ??= createAdminClient());

/** Every write is per-field on one row, so two people editing different tasks never interact. */
export const loadBoard = () => readBoard(client());
export const updateTask = (taskId, patch) => patchTask(client(), taskId, patch);
export const addTask = (input) => insertTask(client(), input);
export const updateModel = (patch) => writeModel(client(), patch);

/**
 * Board-level rollup the UI header and the `summary` action both render.
 *
 * Pure: it takes the board rather than fetching one, so it is provable without a
 * database and cannot be the thing that touches the live event in a test.
 */
export function summarize(board) {
  const tasks = board?.tasks ?? [];
  const model = board?.model;
  const kept = tasks.filter((t) => t.status !== "cut");
  const rounds = {};
  for (const round of [1, 2, 0]) {
    const inRound = kept.filter((t) => t.round === round);
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
      needsClip: inRound.filter((t) => t.needsClip).length,
      needsProp: inRound.filter((t) => t.prop).length,
      highRisk: inRound.filter((t) => t.risk >= 4).length,
      highLuck: inRound.filter((t) => t.luck >= 4).length,
    };
  }
  return {
    total: tasks.length,
    keep: tasks.filter((t) => t.status === "keep").length,
    maybe: tasks.filter((t) => t.status === "maybe").length,
    cut: tasks.filter((t) => t.status === "cut").length,
    flaggedForRewrite: tasks.filter((t) => t.rewrite).length,
    rounds,
  };
}
