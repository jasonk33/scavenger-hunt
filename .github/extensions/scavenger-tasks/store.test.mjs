#!/usr/bin/env node
/**
 * Unit tests for the board store's cache.
 *
 *   node --test .github/extensions/scavenger-tasks/store.test.mjs
 *
 * `loadBoard` used to be `if (cache) return cache` with nothing that could ever
 * invalidate it, so a process held its first read of the board forever. Any
 * later `saveBoard` wrote that stale copy back over the file. With more than one
 * session open on the same board -- two branch sessions, or a worktree session
 * now that both resolve to the same canonical file -- whichever process holds
 * the older cache silently reverts the other's edits.
 *
 * That is not hypothetical: it overwrote a restore during development, and the
 * loss is invisible until someone re-reads the file.
 *
 * These tests point the store at a scratch file via SCAVENGER_TASKS_BOARD. They
 * must never touch the real `data/task-board.json`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "board-store-"));
const BOARD = join(dir, "task-board.json");
process.env.SCAVENGER_TASKS_BOARD = BOARD;

const seed = {
  version: 1,
  model: { weights: { difficulty: 1.2, guts: 1, luck: 0.6 }, thresholds: { t1: 5.9, t3: 8.1, t5: 10.8 } },
  tasks: [
    { id: "r1-01", round: 1, docTitle: "A", title: "A", points: 3, docOrder: 1,
      difficulty: 3, guts: 3, luck: 3, payoff: 3, risk: 1,
      needsClip: false, prop: "", status: "keep", rewrite: false, note: "", tierOk: null },
  ],
};
writeFileSync(BOARD, `${JSON.stringify(seed, null, 2)}\n`);

const { loadBoard, saveBoard, updateTask, BOARD_PATH } = await import("./store.mjs");

/** Simulates the other session: a direct write, as saveBoard would leave it. */
function writeExternally(mutate) {
  const board = JSON.parse(readFileSync(BOARD, "utf8"));
  mutate(board);
  writeFileSync(BOARD, `${JSON.stringify(board, null, 2)}\n`);
  return board;
}

test("the store reads the board the override points at, never the real one", () => {
  assert.equal(BOARD_PATH, BOARD);
  assert.doesNotMatch(BOARD_PATH, /scavenger-hunt\/app\/data/);
});

test("a first load returns what is on disk", () => {
  assert.equal(loadBoard().tasks[0].title, "A");
});

test("an edit by ANOTHER process is picked up, not served from a stale cache", () => {
  loadBoard(); // prime the cache
  writeExternally((b) => { b.tasks[0].title = "Edited elsewhere"; });
  assert.equal(
    loadBoard().tasks[0].title,
    "Edited elsewhere",
    "the cache must not outlive the file it was read from"
  );
});

test("a stale cache cannot be written back over a newer file", () => {
  // The actual data-loss path: prime a cache, let another process change a
  // DIFFERENT field, then save. The other process's change must survive.
  loadBoard();
  writeExternally((b) => { b.tasks[0].note = "note from the other session"; });

  updateTask("r1-01", { points: 5 });

  const onDisk = JSON.parse(readFileSync(BOARD, "utf8"));
  assert.equal(onDisk.tasks[0].points, 5, "this session's edit lands");
  assert.equal(
    onDisk.tasks[0].note,
    "note from the other session",
    "and the other session's edit is not reverted"
  );
});

test("an unchanged file is still served from cache", () => {
  // Invalidation must be driven by the file changing, not by re-reading every
  // call for its own sake.
  const a = loadBoard();
  const b = loadBoard();
  assert.equal(a, b, "same object identity when nothing on disk moved");
});

test("a save makes its own write visible without a re-read", () => {
  saveBoard({ ...loadBoard(), version: 99 });
  assert.equal(loadBoard().version, 99);
});

test("a rewrite of identical length is still detected", () => {
  // Guards a size-only staleness check: same byte count, different content.
  loadBoard();
  writeExternally((b) => { b.tasks[0].title = "B"; });
  assert.equal(loadBoard().tasks[0].title, "B");
  loadBoard();
  writeExternally((b) => { b.tasks[0].title = "C"; });
  assert.equal(loadBoard().tasks[0].title, "C", "same size, different bytes");
});

test("a corrupt file does not take the canvas down", () => {
  writeFileSync(BOARD, "{ not json");
  const board = loadBoard();
  assert.ok(Array.isArray(board.tasks), "falls back to a usable board");
});
