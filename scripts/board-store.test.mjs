/**
 * The board's row <-> task mapping and its validators.
 *
 *   node --test scripts/board-store.test.mjs
 *
 * Only the pure half is exercised here: no client, no network, no `.env.local`,
 * and above all no live board. The one shared Supabase project holds the real
 * event, so a test that reached it would be editing the thing it is meant to be
 * proving -- which has already happened twice and cost real board edits both
 * times. `board-db.test.mjs` covers the query layer against a fake client.
 *
 * What actually matters here is that a value a person deliberately chose cannot
 * be lost or silently rewritten in transit: `tier_ok: null` is a decision, `0`
 * is a legal doc_order, `false` is a real answer, and a patch aimed at a column
 * nobody may edit has to be dropped rather than applied.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  COLUMNS,
  DEFAULT_MODEL,
  SELECT,
  parseModel,
  rowToTask,
  serializeModel,
  taskPatchToRow,
  taskToRow,
} from "./board-store.mjs";

/** A full row as the table actually returns one. */
const ROW = {
  board_id: "r1-01",
  round: 1,
  doc_title: "Re-create an album cover with the whole team",
  title: "Re-create an album cover — name the album when you submit",
  points: 5,
  doc_order: 1,
  difficulty: 2,
  guts: 1,
  luck: 1,
  payoff: 3,
  risk: 1,
  needs_clip: false,
  prop: "",
  status: "keep",
  rewrite: false,
  note: "Reworded: a judge can't verify a re-creation without the original.",
  tier_ok: null,
};

// ── The mapping ──────────────────────────────────────────────────────────────

test("a row becomes the task shape the planner and the canvas already consume", () => {
  const task = rowToTask(ROW);
  assert.deepEqual(task, {
    id: "r1-01",
    round: 1,
    docTitle: "Re-create an album cover with the whole team",
    title: "Re-create an album cover — name the album when you submit",
    points: 5,
    docOrder: 1,
    difficulty: 2,
    guts: 1,
    luck: 1,
    payoff: 3,
    risk: 1,
    needsClip: false,
    prop: "",
    status: "keep",
    rewrite: false,
    note: "Reworded: a judge can't verify a re-creation without the original.",
    tierOk: null,
  });
});

test("every column has a task key and the select list names all of them", () => {
  // A column added to the table but not to COLUMNS would be silently dropped on
  // every read and every write -- the failure mode that loses an edit.
  assert.equal(SELECT.split(",").length, Object.keys(COLUMNS).length);
  for (const column of Object.keys(COLUMNS)) {
    assert.ok(SELECT.split(",").includes(column), `${column} missing from SELECT`);
  }
});

test("row -> task -> row is lossless", () => {
  assert.deepEqual(taskToRow(rowToTask(ROW)), ROW);
});

test("a secret keeps round 0 rather than being folded into a real round", () => {
  // round 0 is falsy. Fanning it out to rounds 1 and 2 is the sync's job, and it
  // cannot do it if the round arrives here as 1.
  assert.equal(rowToTask({ ...ROW, round: 0 }).round, 0);
  assert.equal(taskToRow({ ...rowToTask(ROW), round: 0 }).round, 0);
});

test("falsy values survive the round trip instead of being defaulted", () => {
  const row = { ...ROW, doc_order: 0, doc_title: "", prop: "", note: "", needs_clip: false, rewrite: false };
  const task = rowToTask(row);
  assert.equal(task.docOrder, 0, "0 is a real position, not a missing one");
  assert.equal(task.needsClip, false);
  assert.equal(task.rewrite, false);
  assert.deepEqual(taskToRow(task), row);
});

test("tier_ok null is a decision and stays null, never undefined", () => {
  const task = rowToTask({ ...ROW, tier_ok: null });
  assert.equal(task.tierOk, null);
  assert.ok("tierOk" in task, "the key has to exist, or a dismissal reads as never-set");
  assert.equal(taskToRow(task).tier_ok, null);
  assert.equal(rowToTask({ ...ROW, tier_ok: 5 }).tierOk, 5);
});

// ── The patch validators ─────────────────────────────────────────────────────

test("a patch is translated to columns and keeps every legal value", () => {
  assert.deepEqual(
    taskPatchToRow({ title: "New wording", points: 10, status: "cut", needsClip: true, difficulty: 5, tierOk: 3 }),
    { title: "New wording", points: 10, status: "cut", needs_clip: true, difficulty: 5, tier_ok: 3 }
  );
});

test("fields nobody may edit are dropped, not written", () => {
  // These are provenance and identity. Letting a patch move a task to another
  // round or rewrite the doc's own wording would break the join to `tasks`.
  assert.deepEqual(taskPatchToRow({ id: "r1-99", round: 2, docTitle: "rewritten", docOrder: 3 }), {});
});

test("an unknown key is ignored rather than reaching the database", () => {
  assert.deepEqual(taskPatchToRow({ nope: 1, custom: true, version: 99 }), {});
  assert.deepEqual(taskPatchToRow({ nope: 1, note: "kept" }), { note: "kept" });
});

test("an off-tier point value is dropped, so a rejected write cannot lose the rest", () => {
  // The column has `check (points in (1,3,5,7,10))`. Passing 4 through would
  // fail the whole statement and silently discard the valid fields alongside it.
  for (const bad of [4, 0, -1, 2.5, "many", null, undefined, NaN]) {
    assert.deepEqual(taskPatchToRow({ points: bad, note: "kept" }), { note: "kept" }, `points ${String(bad)}`);
  }
  assert.deepEqual(taskPatchToRow({ points: "5" }), { points: 5 }, "a numeric string is still a tier");
});

test("ratings are clamped to the 1-5 the column allows", () => {
  for (const key of ["difficulty", "guts", "luck", "payoff", "risk"]) {
    for (const bad of [0, 6, -1, 1.5, "high", null, undefined]) {
      assert.deepEqual(taskPatchToRow({ [key]: bad }), {}, `${key} ${String(bad)}`);
    }
    assert.deepEqual(taskPatchToRow({ [key]: 1 }), { [key]: 1 });
    assert.deepEqual(taskPatchToRow({ [key]: 5 }), { [key]: 5 });
    assert.deepEqual(taskPatchToRow({ [key]: "4" }), { [key]: 4 });
  }
});

test("an unknown status is dropped", () => {
  for (const bad of ["nope", "KEEP", "", null, 1]) {
    assert.deepEqual(taskPatchToRow({ status: bad }), {}, String(bad));
  }
  for (const good of ["keep", "maybe", "cut"]) {
    assert.deepEqual(taskPatchToRow({ status: good }), { status: good });
  }
});

test("a blank title is dropped, and a padded one is trimmed", () => {
  // `check (length(btrim(title)) > 0)` would reject it, and a task with no
  // wording is unreadable to a player anyway.
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
  assert.deepEqual(taskPatchToRow({ needsClip: false }), { needs_clip: false });
  assert.deepEqual(taskPatchToRow({ rewrite: false }), { rewrite: false });
  // Only an actual boolean. "false" and 0 are almost certainly a caller bug.
  assert.deepEqual(taskPatchToRow({ needsClip: "false" }), {});
  assert.deepEqual(taskPatchToRow({ rewrite: 0 }), {});
});

test("tierOk accepts null to clear it but rejects a tier that does not exist", () => {
  assert.deepEqual(taskPatchToRow({ tierOk: null }), { tier_ok: null });
  assert.deepEqual(taskPatchToRow({ tierOk: 7 }), { tier_ok: 7 });
  assert.deepEqual(taskPatchToRow({ tierOk: 4 }), {});
  assert.deepEqual(taskPatchToRow({ tierOk: undefined }), {});
});

test("an empty or absent patch produces no columns", () => {
  for (const input of [{}, null, undefined]) assert.deepEqual(taskPatchToRow(input), {});
});

// ── The model ────────────────────────────────────────────────────────────────

test("a missing or unreadable model falls back to the fitted defaults", () => {
  // The thresholds reproduce the planning doc's own tier distribution. Falling
  // back to something arbitrary would flag half the board as disagreeing.
  for (const bad of [undefined, null, "", "not json", "[]", "7", '{"weights":null}']) {
    assert.deepEqual(parseModel(bad), DEFAULT_MODEL, JSON.stringify(bad));
  }
});

test("a stored model is read back exactly", () => {
  const model = { weights: { difficulty: 1.5, guts: 0.8, luck: 0.2 }, thresholds: { t1: 4, t3: 7, t5: 9 } };
  assert.deepEqual(parseModel(serializeModel(model)), model);
});

test("a partial model keeps the defaults for what it does not say", () => {
  const parsed = parseModel(JSON.stringify({ weights: { guts: 2 } }));
  assert.equal(parsed.weights.guts, 2);
  assert.equal(parsed.weights.difficulty, DEFAULT_MODEL.weights.difficulty);
  assert.deepEqual(parsed.thresholds, DEFAULT_MODEL.thresholds);
});

test("a non-numeric weight is ignored rather than poisoning every suggestion", () => {
  // NaN propagates: one bad weight would make every comparison false and quietly
  // re-tier the entire board.
  const parsed = parseModel(JSON.stringify({ weights: { guts: "heavy", luck: null }, thresholds: { t1: "x" } }));
  assert.deepEqual(parsed, DEFAULT_MODEL);
  assert.equal(parseModel(JSON.stringify({ weights: { guts: "2.5" } })).weights.guts, 2.5, "numeric strings are fine");
});

test("parsing does not mutate the shared defaults", () => {
  const before = structuredClone(DEFAULT_MODEL);
  parseModel(JSON.stringify({ weights: { guts: 99 }, thresholds: { t1: 99 } }));
  assert.deepEqual(DEFAULT_MODEL, before, "DEFAULT_MODEL is the fallback for every later read");
});

test("an unknown model key is not carried through", () => {
  const parsed = parseModel(JSON.stringify({ weights: { payoff: 3 }, thresholds: { t9: 1 }, extra: true }));
  assert.deepEqual(parsed, DEFAULT_MODEL);
});
