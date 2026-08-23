/**
 * The board's query layer, proved against a fake Supabase client.
 *
 *   node --test scripts/board-db.test.mjs
 *
 * There is exactly ONE Supabase project and it holds the live event: the real
 * 76-task board, the real roster, real submissions and real media. So the
 * escape hatch is the point of this file. Every query here takes `db` as its
 * first argument, which means a test can hand it a fake and prove the SQL-facing
 * behaviour without a network, without `.env.local`, and above all without the
 * ability to touch Jason's board. Driving the real board as a fixture has cost
 * real edits twice; this is what makes it structurally impossible instead of
 * merely discouraged.
 *
 * The fake records every call, so the assertions are about what was SENT, not
 * only about what came back -- "it wrote the whole board" and "it wrote one
 * field" return the same value and are the difference between losing someone
 * else's edits and not.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { BOARD_TABLE, MODEL_KEY, addTask, readBoard, updateModel, updateTask } from "./board-store.mjs";

const ROW = {
  board_id: "r1-01",
  round: 1,
  doc_title: "Feed a pigeon out of your hand",
  title: "Feed a pigeon out of your hand",
  points: 3,
  doc_order: 4,
  difficulty: 3,
  guts: 1,
  luck: 3,
  payoff: 3,
  risk: 1,
  needs_clip: false,
  prop: "",
  status: "keep",
  rewrite: false,
  note: "",
  tier_ok: null,
};

/**
 * The smallest thing that behaves like the query builder for the calls this
 * module actually makes. Every builder method returns `this` and the promise
 * resolves to whatever the fixture says, so a chain of any shape terminates.
 */
function fakeDb({ rows = [ROW], settings = null, failOn = null } = {}) {
  const calls = [];
  const state = { rows: rows.map((r) => ({ ...r })), settings };

  const builder = (table) => {
    const call = { table, op: "select", filters: {}, payload: null };
    calls.push(call);

    const result = () => {
      if (failOn === table) return { data: null, error: { message: `boom on ${table}` } };
      if (table === "settings") {
        if (call.op === "upsert") {
          state.settings = call.payload.value;
          return { data: call.payload, error: null };
        }
        return { data: state.settings === null ? null : { key: MODEL_KEY, value: state.settings }, error: null };
      }
      if (call.op === "update") {
        const row = state.rows.find((r) => r.board_id === call.filters.board_id);
        if (!row) return { data: null, error: null };
        Object.assign(row, call.payload);
        return { data: { ...row }, error: null };
      }
      if (call.op === "insert") {
        const row = { ...ROW, ...call.payload };
        state.rows.push(row);
        return { data: row, error: null };
      }
      const rows = call.filters.board_id
        ? state.rows.filter((r) => r.board_id === call.filters.board_id)
        : state.rows;
      return { data: rows.map((r) => ({ ...r })), error: null };
    };

    const chain = {
      select(columns) {
        call.columns = columns;
        return chain;
      },
      update(payload) {
        call.op = "update";
        call.payload = payload;
        return chain;
      },
      insert(payload) {
        call.op = "insert";
        call.payload = payload;
        return chain;
      },
      upsert(payload) {
        call.op = "upsert";
        call.payload = payload;
        return chain;
      },
      eq(column, value) {
        call.filters[column] = value;
        return chain;
      },
      order(column) {
        (call.order ??= []).push(column);
        return chain;
      },
      maybeSingle() {
        const { data, error } = result();
        return Promise.resolve({ data: Array.isArray(data) ? (data[0] ?? null) : data, error });
      },
      single() {
        const { data, error } = result();
        return Promise.resolve({ data: Array.isArray(data) ? (data[0] ?? null) : data, error });
      },
      then(onFulfilled, onRejected) {
        return Promise.resolve(result()).then(onFulfilled, onRejected);
      },
    };
    return chain;
  };

  return { from: builder, calls, state };
}

const boardCalls = (db) => db.calls.filter((c) => c.table === BOARD_TABLE);

// ── Reading ──────────────────────────────────────────────────────────────────

test("reading returns tasks in the task shape plus a model", async () => {
  const db = fakeDb();
  const board = await readBoard(db);
  assert.equal(board.tasks.length, 1);
  assert.equal(board.tasks[0].id, "r1-01");
  assert.equal(board.tasks[0].needsClip, false);
  assert.ok(board.model.weights.difficulty > 0);
});

test("a missing model row is a working board, not a failure", async () => {
  // A board that refuses to load because one settings row is absent would be a
  // canvas that will not open, over a value that has a perfectly good default.
  const board = await readBoard(fakeDb({ settings: null }));
  assert.deepEqual(Object.keys(board.model), ["weights", "thresholds"]);
});

test("a stored model wins over the defaults", async () => {
  const stored = JSON.stringify({ weights: { difficulty: 2, guts: 2, luck: 2 }, thresholds: { t1: 1, t3: 2, t5: 3 } });
  const board = await readBoard(fakeDb({ settings: stored }));
  assert.equal(board.model.weights.difficulty, 2);
  assert.equal(board.model.thresholds.t5, 3);
});

test("a failed read throws rather than returning an empty board", async () => {
  // An empty board renders as "there are no tasks", which is indistinguishable
  // from a board that really is empty and would invite publishing over the live
  // task list. It has to be an error all the way up.
  await assert.rejects(() => readBoard(fakeDb({ failOn: BOARD_TABLE })), /could not read the task board/);
});

test("reading names its columns rather than selecting everything", async () => {
  const db = fakeDb();
  await readBoard(db);
  const call = boardCalls(db)[0];
  assert.ok(call.columns.includes("board_id"), "the select list is explicit");
  assert.ok(!call.columns.includes("*"), "a new column must not arrive unmapped");
});

// ── Writing ──────────────────────────────────────────────────────────────────

test("an update writes ONLY the fields that changed", async () => {
  // The whole reason the board moved out of a file. Writing the whole board is
  // what let one process overwrite another's unrelated edits; this is the
  // assertion that stops that from coming back.
  const db = fakeDb();
  await updateTask(db, "r1-01", { points: 5 });
  const write = boardCalls(db).find((c) => c.op === "update");
  assert.deepEqual(Object.keys(write.payload).sort(), ["points", "updated_at"]);
  assert.equal(write.payload.points, 5);
  assert.equal(write.filters.board_id, "r1-01", "scoped to one row");
});

test("an update carries no field the caller did not name", async () => {
  const db = fakeDb();
  await updateTask(db, "r1-01", { note: "why" });
  const write = boardCalls(db).find((c) => c.op === "update");
  for (const key of ["title", "status", "difficulty", "round", "doc_title"]) {
    assert.ok(!(key in write.payload), `${key} must not be rewritten`);
  }
});

test("an update drops invalid fields but still applies the valid ones", async () => {
  const db = fakeDb();
  const task = await updateTask(db, "r1-01", { points: 4, note: "kept" });
  const write = boardCalls(db).find((c) => c.op === "update");
  assert.deepEqual(Object.keys(write.payload).sort(), ["note", "updated_at"]);
  assert.equal(task.note, "kept");
});

test("a patch with nothing legal in it writes nothing at all", async () => {
  // Not an empty UPDATE, which would bump updated_at and look like an edit
  // nobody made -- and not an error either, since the task does exist.
  const db = fakeDb();
  const task = await updateTask(db, "r1-01", { round: 2, bogus: true });
  assert.equal(boardCalls(db).some((c) => c.op === "update"), false, "no write may be issued");
  assert.equal(task.id, "r1-01", "the unchanged task is still returned");
});

test("an unknown task id reports null instead of inventing a row", async () => {
  const db = fakeDb();
  assert.equal(await updateTask(db, "nope-99", { points: 5 }), null);
  assert.equal(await updateTask(db, "nope-99", {}), null);
  assert.equal(await updateTask(db, "", { points: 5 }), null);
  assert.equal(await updateTask(db, null, { points: 5 }), null);
});

test("a failed update throws and names the task", async () => {
  await assert.rejects(
    () => updateTask(fakeDb({ failOn: BOARD_TABLE }), "r1-01", { points: 5 }),
    /could not update task r1-01/
  );
});

test("an added task lands as maybe, with an id that is not already taken", async () => {
  const db = fakeDb({ rows: [ROW, { ...ROW, board_id: "r1-x1" }] });
  const task = await addTask(db, { title: "  A new one  ", round: 1, points: 10, difficulty: 5 });
  assert.equal(task.id, "r1-x2", "r1-x1 is taken");
  assert.equal(task.status, "maybe", "a new task must be reviewed before it counts");
  assert.equal(task.title, "A new one");
  assert.equal(task.points, 10);
  assert.equal(task.difficulty, 5);
  assert.equal(task.docTitle, "", "it did not come from the planning doc");
});

test("an added secret defaults to the flat secret tier", async () => {
  const db = fakeDb({ rows: [] });
  const task = await addTask(db, { title: "Secret", round: 0 });
  assert.equal(task.id, "s-x1");
  assert.equal(task.points, 7);
});

test("an added task with an illegal tier falls back rather than being rejected by the column", async () => {
  const db = fakeDb({ rows: [] });
  assert.equal((await addTask(db, { title: "x", round: 2, points: 4 })).points, 3);
});

test("the model merges rather than replacing what it was not given", async () => {
  const db = fakeDb({ settings: JSON.stringify({ weights: { difficulty: 9, guts: 9, luck: 9 }, thresholds: { t1: 1, t3: 2, t5: 3 } }) });
  const model = await updateModel(db, { weights: { guts: 4 } });
  assert.equal(model.weights.guts, 4, "the change lands");
  assert.equal(model.weights.difficulty, 9, "everything else survives");
  assert.equal(model.thresholds.t5, 3);
  const write = db.calls.find((c) => c.op === "upsert");
  assert.equal(write.payload.key, MODEL_KEY);
  assert.deepEqual(JSON.parse(write.payload.value), model, "what was stored is what was returned");
});

test("a nonsense model value cannot be stored", async () => {
  const db = fakeDb({ settings: null });
  const model = await updateModel(db, { weights: { guts: "heavy" }, thresholds: { t3: null } });
  for (const n of [...Object.values(model.weights), ...Object.values(model.thresholds)]) {
    assert.ok(Number.isFinite(n), `${n} is not a number`);
  }
});
