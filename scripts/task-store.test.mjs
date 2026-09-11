/**
 * The task list's row <-> task mapping and its validators.
 *
 *   node --test scripts/task-store.test.mjs
 *
 * Only the pure half is exercised here: no client, no network, no `.env.local`,
 * and above all no live table. The one shared Supabase project holds the real
 * event, so a test that reached it would be editing the thing it is meant to be
 * proving -- which has already happened twice and cost real edits both times.
 * `task-db.test.mjs` covers the query layer against a fake client.
 *
 * What actually matters here is that a value a person deliberately chose cannot
 * be lost or silently rewritten in transit: an empty note is a decision, `0`
 * is a legal doc_order, `false` is a real answer, and a patch aimed at a column
 * nobody may edit has to be dropped rather than applied. Since the canvas writes
 * the live table directly, every one of those now costs a player-visible edit.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  COLUMNS,
  SELECT,
  rowToTask,
  taskPatchToRow,
} from "./task-store.mjs";

/** A full row as the table actually returns one. */
const ROW = {
  id: "11111111-1111-1111-1111-111111111111",
  slug: "r1-01",
  round: 1,
  doc_title: "Re-create an album cover with the whole team",
  title: "Re-create an album cover — name the album when you submit",
  points: 5,
  scoring_mode: "fixed",
  measurement_label: "",
  points_per_unit: 0,
  competition_bonus: 0,
  doc_order: 1,
  difficulty: 2,
  guts: 1,
  luck: 1,
  payoff: 3,
  risk: 1,
  requires_video: false,
  is_secret: false,
  active: true,
  prop: "",
  rewrite: false,
  note: "Reworded: a judge can't verify a re-creation without the original.",
  tier_ok: null,
};

// ── The mapping ──────────────────────────────────────────────────────────────

test("a row becomes the task shape the canvas consumes", () => {
  assert.deepEqual(rowToTask(ROW), {
    slug: "r1-01",
    round: 1,
    docTitle: "Re-create an album cover with the whole team",
    title: "Re-create an album cover — name the album when you submit",
    points: 5,
    scoringMode: "fixed",
    measurementLabel: "",
    pointsPerUnit: 0,
    docOrder: 1,
    active: true,
    prop: "",
    rewrite: false,
    note: "Reworded: a judge can't verify a re-creation without the original.",
  });
});

test("every column has a task key and the select list names all of them", () => {
  // A column added to the table but not to COLUMNS would be silently dropped on
  // every read and every write -- the failure mode that loses an edit.
  const selected = SELECT.split(",");
  for (const column of Object.keys(COLUMNS)) {
    assert.ok(selected.includes(column), `${column} missing from SELECT`);
  }
  // id is the row's own key rather than the task's.
  assert.deepEqual(
    selected.filter((c) => !(c in COLUMNS)),
    ["id"]
  );
});

test("falsy values survive instead of being defaulted", () => {
  const task = rowToTask({ ...ROW, doc_order: 0, doc_title: "", prop: "", note: "", active: false });
  assert.equal(task.docOrder, 0, "0 is a real position, not a missing one");
  assert.equal(task.docTitle, "");
  assert.equal(task.active, false);
  assert.equal(task.note, "");
  assert.equal(task.prop, "");
  assert.equal(task.rewrite, false);
});

test("a missing row or slug is no task rather than a blank one", () => {
  for (const row of [null, undefined, {}, { ...ROW, slug: "" }, { ...ROW, slug: null }]) {
    assert.equal(rowToTask(row), null);
  }
});

test("a task keeps its assigned round and point value", () => {
  for (const round of [1, 2]) {
    assert.equal(rowToTask({ ...ROW, round, points: 7 }).round, round);
    assert.equal(rowToTask({ ...ROW, round, points: 7 }).points, 7);
  }
});

test("pre-migration competition rows read as fixed without changing assigned points", () => {
  const task = rowToTask({ ...ROW, scoring_mode: "competition", competition_bonus: 5, points: 10 });
  assert.equal(task.scoringMode, "fixed");
  assert.equal(task.points, 10);
  assert.ok(!("competitionBonus" in task));
});

// ── The patch validators ─────────────────────────────────────────────────────

test("a patch is translated to columns and keeps every legal value", () => {
  assert.deepEqual(
    taskPatchToRow({ title: "New wording", points: 10, active: false, rewrite: true }),
    { title: "New wording", points: 10, active: false, rewrite: true }
  );
});

test("fields nobody may edit are dropped, not written", () => {
  // Identity and provenance are not content edits; moves have their own guard.
  assert.deepEqual(taskPatchToRow({ slug: "r1-99", round: 2, isSecret: true, docTitle: "rewritten", docOrder: 3 }), {});
});

test("retired fields are not writable", () => {
  const patch = {
    difficulty: 5, guts: 5, luck: 5, payoff: 5, risk: 5, tierOk: 3,
    requiresVideo: true, isSecret: true, competitionBonus: 7, winner_team_id: "team-1",
    revealed_at: "2026-01-01T00:00:00Z", revealed: true, note: "kept",
  };
  assert.deepEqual(taskPatchToRow(patch), { note: "kept" });
});

test("an unknown key is ignored rather than reaching the database", () => {
  assert.deepEqual(taskPatchToRow({ nope: 1, custom: true, version: 99 }), {});
  assert.deepEqual(taskPatchToRow({ nope: 1, note: "kept" }), { note: "kept" });
});

test("an off-tier point value is dropped, so a rejected write cannot lose the rest", () => {
  // Passing 4 through would be a value no tier badge renders, on a row a player
  // is looking at -- and a rejected statement discards the valid fields with it.
  for (const bad of [4, 0, -1, 2.5, "many", null, undefined, NaN]) {
    assert.deepEqual(taskPatchToRow({ points: bad, note: "kept" }), { note: "kept" }, `points ${String(bad)}`);
  }
  assert.deepEqual(taskPatchToRow({ points: "5" }), { points: 5 }, "a numeric string is still a tier");
});

test("fixed and per-item scoring keep the count unit and rate", () => {
  assert.deepEqual(taskPatchToRow({ scoringMode: "quantity", measurementLabel: " extra hat ", pointsPerUnit: 2 }), {
    scoring_mode: "quantity", measurement_label: "extra hat", points_per_unit: 2,
  });
  assert.deepEqual(taskPatchToRow({ scoringMode: "fixed" }), { scoring_mode: "fixed" });
  for (const bad of [-1, 1.5, "many", true, undefined]) {
    assert.deepEqual(taskPatchToRow({ pointsPerUnit: bad, note: "kept" }), { note: "kept" });
  }
  assert.deepEqual(taskPatchToRow({ pointsPerUnit: 0, measurementLabel: "" }), {
    points_per_unit: 0, measurement_label: "",
  });
});

test("an unsupported scoring mode is a clear refusal rather than a partial write", () => {
  for (const scoringMode of ["competition", "other", null, true]) {
    assert.throws(() => taskPatchToRow({ scoringMode, note: "must not land" }), /fixed or quantity/);
  }
});

test("cutting a task is a boolean and nothing else", () => {
  // This one hides a task from every player the moment it lands, so a truthy
  // string must not be read as a decision.
  assert.deepEqual(taskPatchToRow({ active: false }), { active: false });
  assert.deepEqual(taskPatchToRow({ active: true }), { active: true });
  for (const bad of ["cut", "false", 0, 1, null, undefined]) {
    assert.deepEqual(taskPatchToRow({ active: bad, note: "kept" }), { note: "kept" }, String(bad));
  }
});

test("a blank title is dropped, and a padded one is trimmed", () => {
  // `title not null`, and a task with no wording is unreadable to a player.
  for (const bad of ["", "   ", "\n\t ", null, 5, undefined]) {
    assert.deepEqual(taskPatchToRow({ title: bad, note: "kept" }), { note: "kept" }, JSON.stringify(bad));
  }
  assert.deepEqual(taskPatchToRow({ title: "  spaced  " }), { title: "spaced" });
});

test("clearing a note or a prop is a real edit, not an empty patch", () => {
  assert.deepEqual(taskPatchToRow({ note: "" }), { note: "" });
  assert.deepEqual(taskPatchToRow({ prop: "" }), { prop: "" });
});

test("false is a real answer for the booleans", () => {
  assert.deepEqual(taskPatchToRow({ rewrite: false }), { rewrite: false });
  // Only an actual boolean. "false" and 0 are almost certainly a caller bug.
  assert.deepEqual(taskPatchToRow({ rewrite: 0 }), {});
});

test("an empty or absent patch produces no columns", () => {
  for (const input of [{}, null, undefined]) assert.deepEqual(taskPatchToRow(input), {});
});
