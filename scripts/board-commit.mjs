/**
 * Recording a publish in git.
 *
 * Publishing used to finish the half that players see and leave the board file
 * dirty, with nothing on screen saying so. You clicked Publish, the app was
 * live, and a commit was silently outstanding forever. That seam is the bug
 * this closes: one click finishes the job.
 *
 * Two rules govern everything here:
 *
 * 1. **This can never fail a publish.** The Supabase write has already happened
 *    by the time any of this runs. Offline, no upstream, no git, a hook that
 *    rejects the commit -- all of it is a note on a successful publish, never an
 *    error. A banner that says "failed" about a live task list is worse than one
 *    that says "published, but not pushed".
 *
 * 2. **Only the board is staged.** Staged by explicit path, so whatever else the
 *    working tree happens to hold -- half-finished code, another session's work
 *    -- is never swept into a commit nobody asked for.
 *
 * `run` is injected so every branch is provable without a repo, a network or a
 * remote.
 */

/** Files this is ever allowed to stage. */
export const BOARD_RELATIVE = "data/task-board.json";

/**
 * What the commit says. Derived from the report so the message describes the
 * decisions rather than the row count -- reorderings are not decisions.
 */
export function commitMessage(report) {
  const c = report?.counts ?? {};
  const parts = [];
  if (c.insert) parts.push(`${c.insert} new`);
  if (c.update) parts.push(`${c.update} edited`);
  if (c.deactivate) parts.push(`${c.deactivate} cut`);
  if (c.reactivate) parts.push(`${c.reactivate} restored`);
  if (c.reorder) parts.push(`${c.reorder} reordered`);
  const detail = parts.length ? parts.join(", ") : "no net change";
  const n = Number.isInteger(report?.count) ? report.count : 0;
  return `Board: publish ${n} change${n === 1 ? "" : "s"} (${detail})`;
}

/**
 * Commits the board and pushes it, as far as it can get.
 *
 * @param {object} o
 * @param {string} o.message  commit message
 * @param {(args: string[]) => {ok: boolean, out: string}} o.run  runs `git` in
 *   the checkout that owns the board -- the caller binds that directory, since
 *   it is also the one that has to scrub the environment's credentials.
 * @returns {{committed: boolean, pushed: boolean, note: string}}
 */
export function commitAndPush({ message, run }) {
  const git = (args) => {
    try {
      return run(args);
    } catch (e) {
      // A throwing runner is the same class of event as a non-zero exit.
      return { ok: false, out: String(e?.message ?? e) };
    }
  };

  const staged = git(["add", "--", BOARD_RELATIVE]);
  if (!staged.ok) {
    return { committed: false, pushed: false, note: `could not stage the board: ${firstLine(staged.out)}` };
  }

  // `diff --cached --quiet` exits non-zero when there IS something staged, so
  // ok===true means nothing changed. Publishing a board that was already
  // committed is normal, not a failure.
  const pending = git(["diff", "--cached", "--quiet", "--", BOARD_RELATIVE]);
  if (pending.ok) {
    return { committed: false, pushed: false, note: "the board was already committed" };
  }

  const committed = git(["commit", "-m", message, "--", BOARD_RELATIVE]);
  if (!committed.ok) {
    return { committed: false, pushed: false, note: `published, but the commit failed: ${firstLine(committed.out)}` };
  }

  // Which branch it landed on is load-bearing, not trivia. The board is a
  // record of what players are looking at RIGHT NOW, and the database already
  // has it. A commit stranded on a feature branch means git and the live app
  // disagree about the current state until that branch merges -- so if it is
  // not on the default branch, say so rather than reporting a tidy success.
  const head = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = head.ok ? head.out.trim() : "";
  const stranded = branch && branch !== "main" && branch !== "HEAD";

  const upstream = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (!upstream.ok) {
    return { committed: true, pushed: false, branch, note: "committed locally; this branch has no upstream to push to" };
  }

  const pushed = git(["push"]);
  if (!pushed.ok) {
    return { committed: true, pushed: false, branch, note: `committed, but the push failed: ${firstLine(pushed.out)}` };
  }

  return {
    committed: true,
    pushed: true,
    branch,
    note: stranded
      ? `board committed and pushed to ${branch} — merge it into main, or git and the live app disagree until you do`
      : "board committed and pushed",
  };
}

/** Git errors are multi-line and the first line is the useful one on a banner. */
function firstLine(text) {
  const line = String(text ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .find((l) => !l.startsWith("hint:"));
  return line || "no reason given";
}
