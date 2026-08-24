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
 * be lost or silently rewritten in transit: `tier_ok: null` is a decision, `0`
 * is a legal doc_order, `false` is a real answer, and a patch aimed at a column
 * nobody may edit has to be dropped rather than applied. Since the canvas writes
 * the live table directly, every one of those now costs a player-visible edit.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  COLUMNS,
  DEFAULT_MODEL,
  SELECT,
  groupRows,
  parseModel,
  rowsToTask,
  serializeModel,
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
  measurement_threshold: 0,
  points_per_unit: 0,
  measurement_cap: null,
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
  assert.deepEqual(rowsToTask([ROW]), {
    slug: "r1-01",
    round: 1,
    docTitle: "Re-create an album cover with the whole team",
    title: "Re-create an album cover — name the album when you submit",
    points: 5,
    scoringMode: "fixed",
    measurementLabel: "",
    measurementThreshold: 0,
    pointsPerUnit: 0,
    measurementCap: null,
    competitionBonus: 0,
    docOrder: 1,
    difficulty: 2,
    guts: 1,
    luck: 1,
    payoff: 3,
    risk: 1,
    requiresVideo: false,
    isSecret: false,
    active: true,
    prop: "",
    rewrite: false,
    note: "Reworded: a judge can't verify a re-creation without the original.",
    tierOk: null,
    rowIds: [ROW.id],
  });
});

test("every column has a task key and the select list names all of them", () => {
  // A column added to the table but not to COLUMNS would be silently dropped on
  // every read and every write -- the failure mode that loses an edit.
  const selected = SELECT.split(",");
  for (const column of Object.keys(COLUMNS)) {
    assert.ok(selected.includes(column), `${column} missing from SELECT`);
  }
  // id and round are read but not mapped: round is derived, and id is the row's
  // own key rather than the task's.
  assert.deepEqual(
    selected.filter((c) => !(c in COLUMNS)),
    ["id", "round"]
  );
});

test("falsy values survive instead of being defaulted", () => {
  const task = rowsToTask([{ ...ROW, doc_order: 0, doc_title: "", prop: "", note: "", requires_video: false }]);
  assert.equal(task.docOrder, 0, "0 is a real position, not a missing one");
  assert.equal(task.docTitle, "");
  assert.equal(task.requiresVideo, false);
  assert.equal(task.rewrite, false);
});

test("tier_ok null is a decision and stays null, never undefined", () => {
  const task = rowsToTask([{ ...ROW, tier_ok: null }]);
  assert.equal(task.tierOk, null);
  assert.ok("tierOk" in task, "the key has to exist, or a dismissal reads as never-set");
  assert.equal(rowsToTask([{ ...ROW, tier_ok: 5 }]).tierOk, 5);
});

test("an empty set of rows is no task rather than a blank one", () => {
  assert.equal(rowsToTask([]), null);
  assert.equal(rowsToTask(undefined), null);
});

// ── Grouping: a secret is two rows ───────────────────────────────────────────

const SECRET_R1 = { ...ROW, id: "a", slug: "s-04", round: 1, is_secret: true, points: 7, title: "A secret" };
const SECRET_R2 = { ...SECRET_R1, id: "b", round: 2 };

test("a secret's two rows are one task, at round 0", () => {
  // `tasks.round` is `check (round in (1, 2))`, so a challenge offered in both
  // halves has to be stored twice. 0 means "both", which is the thing actually
  // being decided -- and tier.mjs keys the fixed 7pt tier off exactly this.
  const task = rowsToTask([SECRET_R1, SECRET_R2]);
  assert.equal(task.round, 0);
  assert.equal(task.slug, "s-04");
  assert.deepEqual(task.rowIds, ["a", "b"], "both rows, so a caller never has to re-query for the other");
});

test("a normal task is a group of one and keeps its own round", () => {
  const task = rowsToTask([{ ...ROW, round: 2 }]);
  assert.equal(task.round, 2);
});

test("a secret that only exists in one round still reads as a secret", () => {
  // Admin can create one. It must not read as a Round 1 task, or the tier model
  // would start suggesting a point value for something that is a 7 by definition.
  assert.equal(rowsToTask([SECRET_R1]).round, 0);
});

test("groupRows folds rows by slug and preserves the order they arrived in", () => {
  const other = { ...ROW, id: "c", slug: "r1-02", doc_order: 2 };
  const tasks = groupRows([ROW, SECRET_R1, other, SECRET_R2]);
  assert.deepEqual(
    tasks.map((t) => t.slug),
    ["r1-01", "s-04", "r1-02"]
  );
  assert.deepEqual(tasks[1].rowIds, ["a", "b"]);
});

test("a row with no slug is skipped rather than grouped under nothing", () => {
  // The column is `not null` with a default, so this cannot happen -- but
  // grouping every slugless row together would silently merge unrelated tasks,
  // and one of them would win the whole group's wording.
  assert.deepEqual(groupRows([{ ...ROW, slug: null }, { ...ROW, slug: "" }, ROW]).map((t) => t.slug), ["r1-01"]);
  assert.deepEqual(groupRows(null), []);
});

// ── The patch validators ─────────────────────────────────────────────────────

test("a patch is translated to columns and keeps every legal value", () => {
  assert.deepEqual(
    taskPatchToRow({ title: "New wording", points: 10, active: false, requiresVideo: true, difficulty: 5, tierOk: 3 }),
    { title: "New wording", points: 10, active: false, requires_video: true, difficulty: 5, tier_ok: 3 }
  );
});

test("fields nobody may edit are dropped, not written", () => {
  // Identity, provenance, and the two that decide how many rows a task is.
  // Letting a patch move a task between rounds, or flip it to a secret, would
  // leave one round of it behind.
  assert.deepEqual(taskPatchToRow({ slug: "r1-99", round: 2, isSecret: true, docTitle: "rewritten", docOrder: 3 }), {});
});

test("revealing a secret is not something this can do", () => {
  // Reveal is per-round and organizer-triggered from Admin on the day. A patch
  // here writes both rows of a secret at once, which would spoil the other half
  // of the event.
  assert.deepEqual(taskPatchToRow({ revealed_at: "2026-01-01T00:00:00Z", revealed: true }), {});
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
  assert.deepEqual(taskPatchToRow({ requiresVideo: false }), { requires_video: false });
  assert.deepEqual(taskPatchToRow({ rewrite: false }), { rewrite: false });
  // Only an actual boolean. "false" and 0 are almost certainly a caller bug.
  assert.deepEqual(taskPatchToRow({ requiresVideo: "false" }), {});
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
  // back to something arbitrary would flag half the list as disagreeing.
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
  // re-tier the entire list.
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
