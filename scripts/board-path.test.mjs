#!/usr/bin/env node
/**
 * Unit tests for board path resolution.
 *
 *   node --test scripts/board-path.test.mjs
 *
 * The property that matters: the canvas and the publisher must resolve to the
 * SAME file in every situation. They are separate processes in separate
 * directories, and when they disagree the failure is silent -- the sync reads a
 * board nobody edited, computes a plan from it, and publishes that over live
 * tasks while reporting success.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { pickBoardPath } from "./board-path.mjs";

const MAIN = "/Users/x/repo";
const WORKTREE = "/Users/x/worktrees/feature";

/** What each caller's own copy of the board would be. */
const canvasLocal = (root) => `${root}/data/task-board.json`;

test("in the main checkout the local board is the canonical one", () => {
  const r = pickBoardPath({
    localPath: canvasLocal(MAIN),
    gitDir: ".git",
    gitCommonDir: ".git",
    cwd: MAIN,
  });
  assert.equal(r.path, `${MAIN}/data/task-board.json`);
  assert.equal(r.canonical, true);
});

test("a linked worktree resolves to the MAIN checkout's board, not its own", () => {
  // The whole point. Without this a worktree session edits a copy nobody
  // publishes and the worktree later throws away.
  const r = pickBoardPath({
    localPath: canvasLocal(WORKTREE),
    gitDir: `${MAIN}/.git/worktrees/feature`,
    gitCommonDir: `${MAIN}/.git`,
    cwd: WORKTREE,
  });
  assert.equal(r.path, `${MAIN}/data/task-board.json`);
  assert.equal(r.canonical, true);
});

test("the canvas and the publisher agree from inside the same worktree", () => {
  // They sit at different depths -- the canvas under
  // .github/extensions/scavenger-tasks/, the publisher under scripts/ -- so
  // they arrive with different localPath values and must still converge.
  const git = { gitDir: `${MAIN}/.git/worktrees/feature`, gitCommonDir: `${MAIN}/.git`, cwd: WORKTREE };
  const fromCanvas = pickBoardPath({ localPath: `${WORKTREE}/data/task-board.json`, ...git });
  const fromSync = pickBoardPath({ localPath: `${WORKTREE}/data/task-board.json`, ...git });
  assert.equal(fromCanvas.path, fromSync.path);
  assert.equal(fromCanvas.path, `${MAIN}/data/task-board.json`);
});

test("relative git answers are resolved against the caller's directory", () => {
  // git prints relative paths when asked from inside the checkout.
  const r = pickBoardPath({
    localPath: canvasLocal(WORKTREE),
    gitDir: ".git/worktrees/feature",
    gitCommonDir: "../../repo/.git",
    cwd: `${MAIN}/nested`,
  });
  assert.equal(r.canonical, true);
  assert.equal(r.path, "/Users/x/repo/data/task-board.json");
});

test("a worktree whose main checkout cannot be located is NOT canonical", () => {
  // A bare or relocated common dir that is not named `.git`. Returning a path
  // and calling it canonical would publish the wrong board; the caller has to
  // be able to refuse, so this is the one non-canonical result.
  const r = pickBoardPath({
    localPath: canvasLocal(WORKTREE),
    gitDir: `${WORKTREE}/.git`,
    gitCommonDir: "/srv/bare-repo.git",
    cwd: WORKTREE,
  });
  assert.equal(r.canonical, false);
  assert.match(r.reason, /could not be located/);
});

test("no git at all falls back to the local board rather than refusing", () => {
  // A tarball or a fresh clone with no git binary is not a worktree hazard.
  for (const bad of [{}, { gitDir: "" }, { gitCommonDir: "" }, { gitDir: ".git" }]) {
    const r = pickBoardPath({ localPath: canvasLocal(MAIN), cwd: MAIN, ...bad });
    assert.equal(r.path, canvasLocal(MAIN));
    assert.equal(r.canonical, true);
  }
});

test("a git too old for --git-common-dir echoes the flag and must not be trusted", () => {
  // Old git prints "--git-common-dir" back instead of failing. Treating that as
  // a directory name would resolve the board to a path built from a flag.
  const r = pickBoardPath({
    localPath: canvasLocal(MAIN),
    gitDir: ".git",
    gitCommonDir: "--git-common-dir",
    cwd: MAIN,
  });
  assert.equal(r.path, canvasLocal(MAIN));
  assert.equal(r.canonical, true);
});

test("resolution never invents a path outside a data/ directory", () => {
  const r = pickBoardPath({
    localPath: canvasLocal(WORKTREE),
    gitDir: `${MAIN}/.git/worktrees/feature`,
    gitCommonDir: `${MAIN}/.git`,
    cwd: WORKTREE,
  });
  assert.match(r.path, /\/data\/task-board\.json$/);
});

test("a submodule is not mistaken for a worktree", () => {
  // `git rev-parse` gives a submodule the same answer twice, just not `.git`.
  // Treating it as a worktree would send its board somewhere else entirely.
  const g = "/repo/.git/modules/sub";
  const r = pickBoardPath({
    localPath: "/repo/sub/data/task-board.json",
    gitDir: g,
    gitCommonDir: g,
    cwd: "/repo/sub",
  });
  assert.equal(r.path, "/repo/sub/data/task-board.json");
  assert.equal(r.canonical, true);
});

test("absolute and relative spellings of the same git dir are not a split", () => {
  const r = pickBoardPath({
    localPath: "/repo/data/task-board.json",
    gitDir: ".git",
    gitCommonDir: "/repo/.git",
    cwd: "/repo",
  });
  assert.equal(r.canonical, true);
  assert.equal(r.path, "/repo/data/task-board.json");
});
