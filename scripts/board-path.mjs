/**
 * Where the one true `data/task-board.json` lives.
 *
 * Both halves of the board pipeline resolve their path through here: the
 * scavenger-tasks canvas (`store.mjs`) and the publisher
 * (`scripts/task-sync.mjs`). They MUST agree. If the canvas writes one file and
 * the sync reads another, the sync computes a plan from a board nobody edited
 * and publishes it over live tasks -- silently, and in the wrong direction.
 *
 * Resolving relative to each file used to mean "whichever checkout I am in",
 * which is correct in the main checkout and wrong in a linked worktree: the
 * worktree holds its own committed copy, older than whatever is being edited in
 * the main checkout, while there is only ever one Supabase project behind all of
 * them. That made worktree sessions unusable for task work.
 *
 * Git names the difference with no absolute path baked in: `--git-dir` and
 * `--git-common-dir` are the same directory in the main checkout and diverge in
 * a linked worktree, where the common dir points back at the main one. So a
 * worktree can find the canonical board rather than being refused.
 */
import { execFileSync } from "node:child_process";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

/**
 * Decides the board path from git's answer. Pure, so every branch is provable
 * from a fixture rather than by building worktrees in a test.
 *
 * @param {object}  o
 * @param {string}  o.localPath       the board in the caller's own checkout
 * @param {string}  [o.gitDir]        `git rev-parse --git-dir`
 * @param {string}  [o.gitCommonDir]  `git rev-parse --git-common-dir`
 * @param {string}  o.cwd             directory the git answers are relative to
 * @returns {{path: string, canonical: boolean, reason: string}}
 *   `canonical` is false only when this is a worktree whose main checkout could
 *   not be located -- the one case a caller still has to refuse, because the
 *   path being returned is known to be the wrong one.
 */
export function pickBoardPath({ localPath, gitDir, gitCommonDir, cwd }) {
  // No git, not a repo, or a git too old for --git-common-dir (which echoes the
  // flag back instead of failing). A fresh clone or a tarball is not a worktree.
  if (!gitDir || !gitCommonDir || gitCommonDir.startsWith("-")) {
    return { path: localPath, canonical: true, reason: "not a git worktree" };
  }

  const common = resolve(cwd, gitCommonDir);
  if (resolve(cwd, gitDir) === common) {
    return { path: localPath, canonical: true, reason: "main checkout" };
  }

  // A linked worktree. The main checkout is the parent of its `.git` directory.
  const root = basename(common) === ".git" ? dirname(common) : null;
  if (!root) {
    return {
      path: localPath,
      canonical: false,
      reason: `this is a linked git worktree and the main checkout could not be located from ${common}`,
    };
  }

  return { path: join(root, "data", "task-board.json"), canonical: true, reason: "main checkout via worktree" };
}

/** Asks git about `startDir`. Returns empty answers rather than throwing. */
export function gitDirs(startDir) {
  try {
    const [gitDir, gitCommonDir] = execFileSync("git", ["rev-parse", "--git-dir", "--git-common-dir"], {
      cwd: startDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\n")
      .map((l) => l.trim());
    return { gitDir, gitCommonDir };
  } catch {
    return { gitDir: undefined, gitCommonDir: undefined };
  }
}

/**
 * The board path for a caller whose own copy would be `localPath`.
 *
 * `SCAVENGER_TASKS_BOARD` overrides everything, which is how the tests point at
 * a scratch file instead of the real board -- exercising this against the one
 * shared board is exactly the thing that must not happen.
 */
export function resolveBoardPath(localPath, startDir = dirname(localPath)) {
  const override = process.env.SCAVENGER_TASKS_BOARD;
  if (override) return { path: isAbsolute(override) ? override : resolve(override), canonical: true, reason: "SCAVENGER_TASKS_BOARD" };
  const { gitDir, gitCommonDir } = gitDirs(startDir);
  return pickBoardPath({ localPath, gitDir, gitCommonDir, cwd: startDir });
}
