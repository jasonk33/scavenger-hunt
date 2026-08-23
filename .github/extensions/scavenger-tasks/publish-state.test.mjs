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

import { publishState } from "./publish-state.mjs";

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

test("a worktree refusal blocks publishing and shows the reason verbatim", () => {
  const refusal = "refusing to run: this is a linked git worktree.\n  would read: /wt/data/task-board.json";
  const state = publishState(clean({ ok: false, count: null, refusal }));
  assert.equal(state.kind, "blocked");
  assert.equal(state.canPublish, false);
  assert.ok(state.detail.includes("/wt/data/task-board.json"), "the real reason, not a summary");
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
