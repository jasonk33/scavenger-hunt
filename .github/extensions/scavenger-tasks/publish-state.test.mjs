#!/usr/bin/env node
/**
 * Unit tests for the publish banner's state machine.
 *
 *   node --test .github/extensions/scavenger-tasks/publish-state.test.mjs
 *
 * This is the one piece of the publish feature that genuinely cannot be allowed
 * to be wrong. The banner is read on a phone, in a hurry, minutes before the
 * event, and it is trusted. A banner that says "everything is live" because the
 * check silently failed is worse than no banner at all -- it converts a visible
 * problem into an invisible one.
 *
 * So the tests below are deliberately adversarial about one property: there is
 * no reachable path from a failed, malformed, timed-out, empty or partially
 * written report to a numeric count or to "all live". Every other behaviour here
 * is convenience.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { describeChanges, publishState } from "./publish-state.mjs";

/** A well-formed converged report, as `task-sync.mjs --json` emits one. */
const clean = (over = {}) => ({
  ok: true,
  applied: false,
  count: 0,
  counts: { insert: 0, update: 0, deactivate: 0, reactivate: 0 },
  migrated: true,
  refusal: null,
  collisions: [],
  warnings: [],
  changes: { insert: [], update: [], reactivate: [], deactivate: [] },
  error: null,
  ...over,
});

// ------------------------------------------------------------ the invariant

test("nothing that is not an explicitly successful report can produce a count", () => {
  // Every shape a broken, truncated, timed-out or half-written response could
  // take. None of them may yield a number, and none may yield "all live".
  const broken = [
    undefined,
    null,
    "",
    "not json",
    0,
    false,
    NaN,
    [],
    {},
    { ok: true },                                  // ok but no count at all
    { ok: true, count: undefined },
    { ok: true, count: null },
    { ok: true, count: "7" },                      // a string is not a count
    { ok: true, count: NaN },
    { ok: true, count: Infinity },
    { ok: true, count: -1 },                       // impossible; treat as broken
    { ok: "true", count: 3 },                      // truthy but not the boolean
    { ok: 1, count: 3 },
    { count: 0 },                                  // no ok field at all
    { count: 0, error: "fetch failed" },
    { ok: false, count: 0 },                       // not-ok with no stated reason
    { ok: true, count: 0, error: "fetch failed" }, // contradictory: error wins
  ];

  for (const report of broken) {
    const state = publishState(report);
    assert.equal(
      state.kind,
      "unknown",
      `${JSON.stringify(report)} must be unknown, got "${state.kind}"`
    );
    assert.equal(state.canPublish, false, `${JSON.stringify(report)} must not offer publish`);
    assert.equal(state.count, null, `${JSON.stringify(report)} must not carry a count`);
    assert.doesNotMatch(
      `${state.headline} ${state.detail ?? ""}`,
      /\ball live\b|\beverything\b|\bup to date\b|\bnothing to publish\b/i,
      `${JSON.stringify(report)} must not claim the app is live`
    );
  }
});

test("an unknown state always says why, so a silent failure is impossible", () => {
  assert.match(publishState({ ok: false, count: null, error: "fetch failed" }).detail, /fetch failed/);
  assert.ok(publishState(null).detail, "even a null report explains itself");
  assert.ok(publishState(undefined).detail);
});

test("a timeout is unknown, not clean", () => {
  const state = publishState({ ok: false, count: null, error: "timed out after 30s" });
  assert.equal(state.kind, "unknown");
  assert.match(state.detail, /timed out/);
  assert.equal(state.canPublish, false);
});

// ------------------------------------------------------------ happy states

test("a converged report is clean, and offers nothing to publish", () => {
  const state = publishState(clean());
  assert.equal(state.kind, "clean");
  assert.equal(state.count, 0);
  assert.equal(state.canPublish, false, "there is nothing to publish");
});

test("a report with changes is pending and is the only state that can publish", () => {
  const state = publishState(clean({ count: 7, counts: { insert: 2, update: 4, deactivate: 1, reactivate: 0 } }));
  assert.equal(state.kind, "pending");
  assert.equal(state.count, 7);
  assert.equal(state.canPublish, true);
  assert.match(state.headline, /7 changes? not yet live/i);
});

test("one change reads as singular", () => {
  assert.match(publishState(clean({ count: 1 })).headline, /1 change not yet live/i);
});

test("a successful publish reports as published, not as pending again", () => {
  // The applied report carries the count that was just written; reading it as
  // "still pending" would tell him the publish had not worked.
  const state = publishState(clean({ count: 7, applied: true }));
  assert.equal(state.kind, "published");
  assert.equal(state.canPublish, false);
  assert.match(state.headline, /published 7 changes?/i);
});

// --------------------------------------------------------------- refusals

test("a refusal blocks publishing and shows the reason verbatim", () => {
  // Summarising a refusal loses the fix, so the banner prints whatever the sync
  // said. Nothing produces one today -- the board is a table, so there is no
  // wrong checkout left to refuse -- but this is the channel a future one
  // arrives through, and it must reach the screen unedited.
  const refusal = "refusing to run: something specific went wrong.\n  do this exact thing to fix it";
  const state = publishState(clean({ ok: false, count: null, refusal }));
  assert.equal(state.kind, "blocked");
  assert.equal(state.canPublish, false);
  assert.ok(state.detail.includes("do this exact thing to fix it"), "the real reason, not a summary");
});

test("a title collision blocks publishing and names the colliding title", () => {
  const state = publishState(
    clean({ ok: false, count: 2, collisions: [{ round: 1, title: "Same", between: ["board_id r1-01", "new task r1-02"] }] })
  );
  assert.equal(state.kind, "blocked");
  assert.equal(state.canPublish, false);
  assert.match(state.detail, /Same/);
});

test("an unmigrated database blocks publishing and names the migration", () => {
  const state = publishState(clean({ ok: false, count: 3, migrated: false }));
  assert.equal(state.kind, "blocked");
  assert.equal(state.canPublish, false);
  assert.match(state.detail, /migrate-task-board-id\.sql/);
});

// ----------------------------------------------------------------- staleness

test("a board edited after the check is stale, and cannot be published from", () => {
  // The number is real but no longer describes the board, so publishing from it
  // would write a plan computed against edits he has since made.
  const state = publishState(clean({ count: 7, checkedAt: 1000 }), { staleSince: 2000 });
  assert.equal(state.kind, "stale");
  assert.equal(state.canPublish, false, "never publish from a number known to be out of date");
  assert.equal(state.count, 7, "the last known number is still shown, just not trusted");
});

test("a converged report also goes stale, rather than still claiming everything is live", () => {
  // The dangerous direction: count was 0, he has since edited, and the banner
  // would otherwise keep saying the app matches the board.
  const state = publishState(clean({ count: 0, checkedAt: 1000 }), { staleSince: 2000 });
  assert.equal(state.kind, "stale");
  assert.doesNotMatch(state.headline, /everything|all live/i);
});

test("an edit older than the check does not make a fresh result stale", () => {
  const state = publishState(clean({ count: 7, checkedAt: 3000 }), { staleSince: 2000 });
  assert.equal(state.kind, "pending");
  assert.equal(state.canPublish, true);
});

test("staleness never rescues a broken report into showing a number", () => {
  for (const report of [null, { ok: false, error: "boom" }, { ok: true, count: null }]) {
    const state = publishState(report, { staleSince: 2000 });
    assert.equal(state.kind, "unknown");
    assert.equal(state.count, null);
  }
});

test("a blocked report stays blocked rather than being softened to stale", () => {
  // A collision does not stop being a collision because a slider moved, and the
  // reason has to stay on screen until the recount clears it.
  const state = publishState(
    clean({ ok: false, count: 2, checkedAt: 1000, collisions: [{ round: 1, title: "Same", between: ["a", "b"] }] }),
    { staleSince: 2000 }
  );
  assert.equal(state.kind, "blocked");
  assert.equal(state.canPublish, false);
});

// --------------------------------------------------------------- reordering
//
// `syncReport` reports a slot move separately from a content change, so the
// count above the publish button describes decisions rather than renumbering.
// The banner then has one new way to be wrong, and it is the familiar one: a
// board whose ONLY pending change is reordering must not read as "all live",
// because the order players see would still be the old one.

const reorder = (n, over = {}) =>
  clean({
    counts: { insert: 0, update: 0, deactivate: 0, reactivate: 0, reorder: n },
    ...over,
  });

test("reordering alone is publishable and never reads as everything being live", () => {
  const state = publishState(reorder(29));
  assert.notEqual(state.kind, "clean", "the player-visible order is still the old one");
  assert.equal(state.canPublish, true);
  assert.match(state.headline + " " + state.detail, /29/);
});

test("one reordering reads as singular", () => {
  const state = publishState(reorder(1));
  assert.match(state.headline + " " + state.detail, /1 task\b/);
  assert.doesNotMatch(state.headline + " " + state.detail, /1 tasks/);
});

test("real changes alongside reordering count only the real ones, but say so", () => {
  const state = publishState(reorder(29, { count: 2, counts: { insert: 0, update: 0, deactivate: 2, reactivate: 0, reorder: 29 } }));
  assert.equal(state.kind, "pending");
  assert.equal(state.count, 2, "the headline number is the number of decisions");
  assert.match(state.headline, /2 changes/);
  assert.match(state.detail, /29/, "the reordering is still disclosed, not hidden");
});

test("no changes and no reordering is still clean", () => {
  const state = publishState(reorder(0));
  assert.equal(state.kind, "clean");
  assert.equal(state.canPublish, false);
});

test("a report from before reordering was split out is still clean at zero", () => {
  // counts.reorder is absent on an older report; a missing field must not be
  // read as "there is reordering pending".
  const state = publishState(clean());
  assert.equal(state.kind, "clean");
});

test("reordering never rescues a broken report into looking publishable", () => {
  for (const bad of [null, undefined, "nope", { ok: false, counts: { reorder: 5 } }, { error: "boom", counts: { reorder: 5 } }]) {
    const state = publishState(bad);
    assert.equal(state.canPublish, false);
    assert.equal(state.count, null);
  }
});

test("reordering does not survive the board going stale underneath it", () => {
  const state = publishState(reorder(29, { checkedAt: 100 }), { staleSince: 200 });
  assert.equal(state.canPublish, false, "the renumbering was measured against an older board");
});

// ------------------------------------------------- what a change line says
//
// Filtering out updates that are ONLY a slot move is not enough: a real change
// that happens to also move the task still carried `sort_order 90 -> 240` on
// the end of its line, which is the same noise in a place the filter could not
// reach. A change line should say what a person decided and nothing else.

const updateReport = (fields) =>
  clean({
    count: 1,
    counts: { insert: 0, update: 1, deactivate: 0, reactivate: 0, reorder: 0 },
    changes: {
      insert: [],
      reactivate: [],
      deactivate: [],
      update: [{ board_id: "r2-04", round: 2, title: "Get an old lady to flip off the camera", fields }],
    },
  });

test("a change line shows the decision without the slot move that came with it", () => {
  const [line] = describeChanges(
    updateReport([
      { field: "points", from: 3, to: 10 },
      { field: "sort_order", from: 90, to: 240 },
    ])
  );
  assert.match(line.text, /points 3 → 10/);
  assert.doesNotMatch(line.text, /sort_order/, "the reordering footnote already accounts for this");
  assert.doesNotMatch(line.text, /240/);
});

test("board_id linking is bookkeeping and never appears on a change line", () => {
  const [line] = describeChanges(
    updateReport([
      { field: "title", from: "Old wording", to: "New wording" },
      { field: "board_id", from: null, to: "r2-04" },
    ])
  );
  assert.match(line.text, /title/);
  assert.doesNotMatch(line.text, /board_id/);
});

test("every other field still shows, so nothing real is filtered out", () => {
  const [line] = describeChanges(
    updateReport([
      { field: "points", from: 3, to: 10 },
      { field: "title", from: "A", to: "B" },
      { field: "requires_video", from: false, to: true },
      { field: "is_secret", from: false, to: true },
    ])
  );
  for (const f of ["points", "title", "requires_video", "is_secret"]) {
    assert.match(line.text, new RegExp(f), `${f} must survive the filter`);
  }
});

test("a change line is never left empty by the filter", () => {
  // An update with nothing but invisible fields is excluded upstream by
  // syncReport, so this asserts the two halves agree: if a line is produced at
  // all, it has something to say.
  for (const line of describeChanges(updateReport([{ field: "points", from: 1, to: 3 }]))) {
    assert.match(line.text, /\S — \S/, "a line always names at least one real field");
  }
});

// ----------------------------------------------------------- a live publish
//
// Publishing used to have a second half: it recorded the board in git, because
// the board was a file that the publish had just left dirty. The board is a
// table now, so writing `tasks` IS the whole job -- there is nothing left
// outstanding, and nothing to report about it.

const applied = () => clean({ applied: true, count: 2 });

test("an applied publish says players can see it and offers no further action", () => {
  const s = publishState(applied());
  assert.equal(s.kind, "published");
  assert.equal(s.canPublish, false, "publishing again is not the next step");
  assert.equal(s.detail, "Players see the new task list now.");
  assert.equal(s.count, 2);
});

test("a stray git note from an older report cannot appear or change the outcome", () => {
  // Reports are produced by the script in this repo, but a cached or replayed
  // one must not reintroduce a claim about a commit that no longer happens.
  for (const git of [null, {}, { note: "board committed and pushed" }]) {
    const s = publishState(clean({ applied: true, count: 2, git }));
    assert.equal(s.kind, "published");
    assert.equal(s.canPublish, false);
    assert.equal(s.detail, "Players see the new task list now.", "no commit is claimed");
  }
});
