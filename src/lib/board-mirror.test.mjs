/**
 * Which Admin edits are carried back to the planning board.
 *
 *   node --test src/lib/board-mirror.test.mjs
 *
 * Admin writes `tasks` directly, so its edits are live immediately -- it is the
 * emergency lever on the day. The board owns the same fields, so the next
 * publish used to silently revert whatever Admin had set. Mirroring the edit
 * back to the board closes that, but only for the fields where the two sides
 * mean the same thing.
 *
 * The safety property under test is NOT "it copies fields". It is that a field
 * it cannot faithfully carry is **skipped and named**, never guessed at and
 * never sent to a column that would reject it -- because a rejected statement
 * takes the whole write with it, including the fields that were fine.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { boardMirrorPatch } from "./board-mirror.mjs";

const skippedFields = (r) => r.skipped.map((s) => s.field).sort();

// ── What carries ─────────────────────────────────────────────────────────────

test("the three fields that mean the same thing on both sides are carried", () => {
  const r = boardMirrorPatch({ title: "New wording", points: 5, requiresVideo: true });
  assert.deepEqual(r.row, { title: "New wording", points: 5, needs_clip: true });
  assert.deepEqual(r.skipped, []);
});

test("a title is trimmed, matching what Admin itself writes to tasks", () => {
  // The two sides must not disagree by whitespace, or every publish afterwards
  // sees a difference and proposes an edit nobody made.
  assert.equal(boardMirrorPatch({ title: "  padded  " }).row.title, "padded");
});

test("requiresVideo false is a real answer, not an absent one", () => {
  assert.deepEqual(boardMirrorPatch({ requiresVideo: false }).row, { needs_clip: false });
});

test("only the named fields are carried", () => {
  const r = boardMirrorPatch({ title: "t", nonsense: 1, sort_order: 5, board_id: "r1-01", round: 2 });
  assert.deepEqual(Object.keys(r.row), ["title"]);
});

test("an empty patch produces nothing to write", () => {
  for (const input of [{}, null, undefined]) {
    const r = boardMirrorPatch(input);
    assert.deepEqual(r.row, {}, JSON.stringify(input));
    assert.deepEqual(r.skipped, []);
  }
});

// ── What is deliberately NOT carried ─────────────────────────────────────────

test("isSecret is skipped, because the board has no such column", () => {
  // A secret is `round: 0` on the board and fans out to one task row per round.
  // Writing that back means reimplementing the planner's fan-out in the app.
  const r = boardMirrorPatch({ isSecret: true });
  assert.deepEqual(r.row, {});
  assert.deepEqual(skippedFields(r), ["isSecret"]);
  assert.match(r.skipped[0].why, /round 0|fan|no column/i, "the reason has to be the actual reason");
});

test("active is skipped, because hiding is not the same decision as cutting", () => {
  // The board's only hidden state is `cut`, which is a decision. Writing
  // "hide this for now" back as `cut` would erase the keep/maybe distinction.
  const r = boardMirrorPatch({ active: false });
  assert.deepEqual(r.row, {});
  assert.deepEqual(skippedFields(r), ["active"]);
});

test("revealing a secret is not a divergence and is not reported as one", () => {
  // revealed_at is Admin-owned by design and the planner is tested never to
  // propose writing it. Reporting it as skipped would cry wolf every reveal.
  const r = boardMirrorPatch({ revealed: true });
  assert.deepEqual(r.row, {});
  assert.deepEqual(r.skipped, []);
});

// ── The field that would take the whole write down with it ───────────────────

test("an off-tier point value is skipped rather than sent to a column that rejects it", () => {
  // `task_board.points` is `check (points in (1,3,5,7,10))` but the Admin API
  // accepts any positive number. Sending 4 fails the statement, which would
  // discard the title alongside it -- losing an edit that was perfectly valid.
  const r = boardMirrorPatch({ title: "kept", points: 4 });
  assert.deepEqual(r.row, { title: "kept" }, "the good field still lands");
  assert.deepEqual(skippedFields(r), ["points"]);
  assert.match(r.skipped[0].why, /1, 3, 5, 7, 10|tier/i);
});

test("every legal tier is carried and every illegal one is skipped", () => {
  for (const p of [1, 3, 5, 7, 10]) {
    assert.equal(boardMirrorPatch({ points: p }).row.points, p, `tier ${p}`);
  }
  for (const p of [0, 2, 4, 6, 9, 99, -5, 2.5]) {
    assert.deepEqual(boardMirrorPatch({ points: p }).row, {}, `points ${p} must not be written`);
  }
});

test("a numeric string tier is still a tier", () => {
  assert.equal(boardMirrorPatch({ points: "5" }).row.points, 5);
});

// ── Inputs that are a caller bug rather than a decision ──────────────────────

test("a blank or non-string title is dropped without claiming a skip", () => {
  // Admin's own validation already refuses these, so they never reached `tasks`
  // either. There is nothing diverging, so there is nothing to report.
  for (const bad of ["", "   ", null, 5, undefined, {}]) {
    const r = boardMirrorPatch({ title: bad });
    assert.deepEqual(r.row, {}, JSON.stringify(bad));
    assert.deepEqual(r.skipped, [], "not a divergence, just absent");
  }
});

test("a non-boolean requiresVideo is ignored rather than coerced", () => {
  for (const bad of ["true", 1, null]) {
    assert.deepEqual(boardMirrorPatch({ requiresVideo: bad }).row, {}, JSON.stringify(bad));
  }
});

test("a non-boolean isSecret or active is not reported as skipped", () => {
  // Admin only ever sends real booleans. Anything else did not change `tasks`
  // either, so it is not a divergence.
  assert.deepEqual(boardMirrorPatch({ isSecret: "yes", active: 1 }).skipped, []);
});

// ── The combination that matters on the day ──────────────────────────────────

test("a normal Admin save carries everything and reports nothing", () => {
  // What the Save button actually sends: all four, every time, changed or not.
  const r = boardMirrorPatch({ title: "Fix the wording", points: 3, requiresVideo: false, isSecret: false });
  assert.deepEqual(r.row, { title: "Fix the wording", points: 3, needs_clip: false });
  assert.deepEqual(skippedFields(r), ["isSecret"], "toggling secret is the one thing Save cannot carry");
});

test("skips are reported per field, so two problems are two lines", () => {
  const r = boardMirrorPatch({ points: 4, isSecret: true, active: false });
  assert.deepEqual(skippedFields(r), ["active", "isSecret", "points"]);
  for (const s of r.skipped) assert.ok(s.why && s.why.length > 10, `${s.field} needs a real reason`);
});
