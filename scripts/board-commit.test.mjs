#!/usr/bin/env node
/**
 * Unit tests for recording a publish in git.
 *
 *   node --test scripts/board-commit.test.mjs
 *
 * The load-bearing property is negative: none of this may ever turn a
 * successful publish into a failure. By the time it runs, players are already
 * seeing the new task list, so every git problem is a note. The second property
 * is narrower but just as important -- only `data/task-board.json` is ever
 * staged, because the working tree routinely holds unrelated work.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { BOARD_RELATIVE, commitAndPush, commitMessage } from "./board-commit.mjs";

/** A fake git. `fail` maps a subcommand to the output it should fail with. */
function fakeGit({ fail = {}, staged = true } = {}) {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    const cmd = args[0];
    if (cmd in fail) return { ok: false, out: fail[cmd] };
    // `diff --cached --quiet` exits non-zero when something IS staged.
    if (cmd === "diff") return { ok: !staged, out: "" };
    return { ok: true, out: "" };
  };
  return { run, calls };
}

const ran = (calls, cmd) => calls.find((c) => c[0] === cmd);

// ------------------------------------------------------------------ message

test("the message counts decisions, not rows written", () => {
  const msg = commitMessage({ count: 2, counts: { insert: 0, update: 1, deactivate: 1, reactivate: 0, reorder: 29 } });
  assert.match(msg, /publish 2 changes/);
  assert.match(msg, /1 edited/);
  assert.match(msg, /1 cut/);
  assert.match(msg, /29 reordered/, "reordering is disclosed but is not the headline number");
});

test("one change reads as singular", () => {
  assert.match(commitMessage({ count: 1, counts: { update: 1 } }), /publish 1 change \(/);
});

test("a malformed report still produces a usable message", () => {
  for (const bad of [null, undefined, {}, { count: "7" }]) {
    const msg = commitMessage(bad);
    assert.match(msg, /^Board: publish 0 changes/);
  }
});

// ------------------------------------------------------------ happy path

test("a normal publish commits and pushes", () => {
  const { run, calls } = fakeGit();
  const r = commitAndPush({ root: "/repo", message: "m", run });
  assert.deepEqual(r, { committed: true, pushed: true, note: "board committed and pushed" });
  assert.ok(ran(calls, "push"));
});

test("only the board is ever staged or committed", () => {
  // The working tree routinely holds unrelated work -- another session's
  // changes, half-finished code. A bare `git add` or `git commit -a` here would
  // sweep it into a commit nobody asked for.
  const { run, calls } = fakeGit();
  commitAndPush({ root: "/repo", message: "m", run });

  const add = ran(calls, "add");
  assert.deepEqual(add, ["add", "--", BOARD_RELATIVE]);

  const commit = ran(calls, "commit");
  assert.ok(commit.includes("--") && commit.includes(BOARD_RELATIVE), "the commit is path-scoped too");
  assert.ok(!commit.includes("-a") && !commit.includes("--all"), "never commit everything");
});

test("a board that was already committed is not an error", () => {
  const { run, calls } = fakeGit({ staged: false });
  const r = commitAndPush({ root: "/repo", message: "m", run });
  assert.equal(r.committed, false);
  assert.match(r.note, /already committed/);
  assert.equal(ran(calls, "commit"), undefined, "nothing to commit means no empty commit");
});

// --------------------------------------------------------------- failures

test("a failed push leaves the commit standing and says why", () => {
  const { run } = fakeGit({ fail: { push: "fatal: Authentication failed for 'https://github.com/...'" } });
  const r = commitAndPush({ root: "/repo", message: "m", run });
  assert.equal(r.committed, true, "the commit already happened and is still good");
  assert.equal(r.pushed, false);
  assert.match(r.note, /push failed/);
  assert.match(r.note, /Authentication failed/, "the reason has to survive to the banner");
});

test("no upstream is reported calmly rather than as a failure", () => {
  const { run } = fakeGit({ fail: { "rev-parse": "fatal: no upstream configured" } });
  const r = commitAndPush({ root: "/repo", message: "m", run });
  assert.equal(r.committed, true);
  assert.equal(r.pushed, false);
  assert.match(r.note, /no upstream/);
});

test("a rejected commit does not claim to have committed", () => {
  const { run } = fakeGit({ fail: { commit: "error: pre-commit hook refused" } });
  const r = commitAndPush({ root: "/repo", message: "m", run });
  assert.equal(r.committed, false);
  assert.match(r.note, /commit failed/);
  assert.match(r.note, /pre-commit hook refused/);
});

test("a git that cannot even stage is reported, not thrown", () => {
  const { run } = fakeGit({ fail: { add: "fatal: not a git repository" } });
  const r = commitAndPush({ root: "/repo", message: "m", run });
  assert.deepEqual({ committed: r.committed, pushed: r.pushed }, { committed: false, pushed: false });
  assert.match(r.note, /could not stage/);
});

test("a runner that THROWS is handled like a non-zero exit", () => {
  // No git binary at all raises rather than returning. Publishing must survive
  // it, because the task list is already live.
  const run = () => { throw new Error("spawn git ENOENT"); };
  const r = commitAndPush({ root: "/repo", message: "m", run });
  assert.equal(r.committed, false);
  assert.match(r.note, /ENOENT/);
});

test("nothing here can throw, whatever git does", () => {
  // The negative property, stated once and checked across every failure point.
  const points = ["add", "diff", "commit", "rev-parse", "push"];
  for (const cmd of points) {
    const { run } = fakeGit({ fail: { [cmd]: "boom" } });
    assert.doesNotThrow(() => commitAndPush({ root: "/repo", message: "m", run }), `failing at ${cmd} must not throw`);
  }
  assert.doesNotThrow(() => commitAndPush({ root: "/repo", message: "m", run: () => { throw new Error("x"); } }));
});

test("the note never leaks git's hint noise", () => {
  const { run } = fakeGit({ fail: { push: "hint: Updates were rejected\nfatal: the real reason" } });
  const r = commitAndPush({ root: "/repo", message: "m", run });
  assert.match(r.note, /the real reason/);
  assert.doesNotMatch(r.note, /hint:/);
});
