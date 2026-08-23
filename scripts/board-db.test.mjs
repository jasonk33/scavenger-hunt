/**
 * The board's query layer, proved against a fake `fetch`.
 *
 *   node --test scripts/board-db.test.mjs
 *
 * There is exactly ONE Supabase project and it holds the live event: the real
 * 76-task board, the real roster, real submissions and real media. So the
 * escape hatch is the point of this file. Every query takes a client whose
 * `fetch` is injectable, which means a test can prove the HTTP that would go
 * over the wire without a network, without `.env.local`, and above all without
 * the ability to touch Jason's board. Driving the real board as a fixture has
 * cost real edits twice; this is what makes it structurally impossible rather
 * than merely discouraged.
 *
 * The fake records every request, so the assertions are about what was SENT.
 * "It wrote the whole board" and "it wrote one field" return the same value and
 * are the difference between losing someone else's edits and not.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { BOARD_TABLE, MODEL_KEY, addTask, createBoardClient, readBoard, updateModel, updateTask } from "./board-store.mjs";

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
 * A client whose `fetch` answers from fixtures and records every request.
 *
 * Routing is by method and table, which is all these queries need -- and it
 * deliberately does NOT interpret the query string, so an assertion about
 * filtering has to look at the recorded URL rather than trusting the fake.
 */
function fakeDb({ rows = [ROW], settings = null, failOn = null } = {}) {
  const calls = [];
  const state = { rows: rows.map((r) => ({ ...r })), settings };

  const respond = (url, init) => {
    const method = init.method ?? "GET";
    const table = url.split("/rest/v1/")[1].split("?")[0];
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, table, url, body, headers: init.headers });

    if (failOn === table) return { ok: false, status: 500, text: JSON.stringify({ message: `boom on ${table}` }) };

    if (table === "settings") {
      if (method === "POST") {
        state.settings = body.value;
        return { ok: true, status: 201, text: "" };
      }
      return { ok: true, status: 200, text: JSON.stringify(state.settings === null ? [] : [{ value: state.settings }]) };
    }

    const idMatch = /board_id=eq\.([^&]+)/.exec(url);
    const id = idMatch ? decodeURIComponent(idMatch[1]) : null;

    if (method === "PATCH") {
      const row = state.rows.find((r) => r.board_id === id);
      if (!row) return { ok: true, status: 200, text: "[]" };
      Object.assign(row, body);
      return { ok: true, status: 200, text: JSON.stringify([row]) };
    }
    if (method === "POST") {
      const row = { ...ROW, ...body };
      state.rows.push(row);
      return { ok: true, status: 201, text: JSON.stringify([row]) };
    }
    const found = id ? state.rows.filter((r) => r.board_id === id) : state.rows;
    return { ok: true, status: 200, text: JSON.stringify(found.map((r) => ({ ...r }))) };
  };

  const fetchImpl = async (url, init = {}) => {
    const { ok, status, text } = respond(url, init);
    return { ok, status, text: async () => text };
  };

  const client = createBoardClient({ SUPABASE_URL: "https://fake.test", SUPABASE_SERVICE_ROLE_KEY: "k" }, fetchImpl);
  client.calls = calls;
  client.state = state;
  return client;
}

const boardCalls = (db) => db.calls.filter((c) => c.table === BOARD_TABLE);
const writeOf = (db) => boardCalls(db).find((c) => c.method === 'PATCH');

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
  assert.ok(call.url.includes("select=board_id"), "the select list is explicit");
  assert.ok(!call.url.includes("select=*"), "a new column must not arrive unmapped");
});

// ── Writing ──────────────────────────────────────────────────────────────────

test("an update writes ONLY the fields that changed", async () => {
  // The whole reason the board moved out of a file. Writing the whole board is
  // what let one process overwrite another's unrelated edits; this is the
  // assertion that stops that from coming back.
  const db = fakeDb();
  await updateTask(db, "r1-01", { points: 5 });
  const write = writeOf(db);
  assert.deepEqual(Object.keys(write.body).sort(), ["points", "updated_at"]);
  assert.equal(write.body.points, 5);
  assert.ok(write.url.includes("board_id=eq.r1-01"), "scoped to one row");
});

test("an update carries no field the caller did not name", async () => {
  const db = fakeDb();
  await updateTask(db, "r1-01", { note: "why" });
  const write = writeOf(db);
  for (const key of ["title", "status", "difficulty", "round", "doc_title"]) {
    assert.ok(!(key in write.body), `${key} must not be rewritten`);
  }
});

test("an update drops invalid fields but still applies the valid ones", async () => {
  const db = fakeDb();
  const task = await updateTask(db, "r1-01", { points: 4, note: "kept" });
  const write = writeOf(db);
  assert.deepEqual(Object.keys(write.body).sort(), ["note", "updated_at"]);
  assert.equal(task.note, "kept");
});

test("a patch with nothing legal in it writes nothing at all", async () => {
  // Not an empty UPDATE, which would bump updated_at and look like an edit
  // nobody made -- and not an error either, since the task does exist.
  const db = fakeDb();
  const task = await updateTask(db, "r1-01", { round: 2, bogus: true });
  assert.equal(boardCalls(db).some((c) => c.method === "PATCH"), false, "no write may be issued");
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
  const write = db.calls.find((c) => c.table === "settings" && c.method === "POST");
  assert.equal(write.body.key, MODEL_KEY);
  assert.deepEqual(JSON.parse(write.body.value), model, "what was stored is what was returned");
  assert.match(write.headers.Prefer, /merge-duplicates/, "an upsert, so a first save and a later one both work");
});

test("a nonsense model value cannot be stored", async () => {
  const db = fakeDb({ settings: null });
  const model = await updateModel(db, { weights: { guts: "heavy" }, thresholds: { t3: null } });
  for (const n of [...Object.values(model.weights), ...Object.values(model.thresholds)]) {
    assert.ok(Number.isFinite(n), `${n} is not a number`);
  }
});

// ── The wire itself ──────────────────────────────────────────────────────────
//
// These queries are hand-rolled HTTP now rather than a library's, so the parts
// the library used to get right have to be asserted.

test("every request carries the service_role key both ways round", async () => {
  // PostgREST needs `apikey`; RLS needs the bearer token. Missing either returns
  // an empty result rather than an error, which would read as an empty board.
  const db = fakeDb();
  await readBoard(db);
  for (const call of db.calls) {
    assert.equal(call.headers.apikey, "k");
    assert.equal(call.headers.Authorization, "Bearer k");
  }
});

test("a write asks for the row back, or the canvas cannot show what it saved", async () => {
  const db = fakeDb();
  await updateTask(db, "r1-01", { points: 5 });
  assert.match(writeOf(db).headers.Prefer, /return=representation/);
});

test("a board id is escaped into the URL rather than concatenated", async () => {
  // An id is `r1-01` today, but a hand-built query string that trusts its input
  // is how a filter silently stops filtering -- and an unfiltered PATCH would
  // rewrite every row on the board.
  const db = fakeDb();
  await updateTask(db, "r1-01&board_id=neq.x", { points: 5 });
  const call = boardCalls(db).find((c) => c.method === "PATCH") ?? boardCalls(db).at(-1);
  assert.ok(!call.url.includes("&board_id=neq.x"), "the injected filter must not survive as syntax");
  assert.ok(call.url.includes("board_id=eq.r1-01%26board_id%3Dneq.x"), "it is one encoded value");
});

test("a PostgREST error message reaches the caller, not just a status code", async () => {
  // A check-constraint violation names the constraint, and that is the entire
  // actionable content. `HTTP 400` on the banner is unactionable.
  await assert.rejects(() => readBoard(fakeDb({ failOn: BOARD_TABLE })), /boom on task_board/);
});

test("a thrown fetch is reported as unreachable rather than as undefined", async () => {
  // Offline, DNS, a paused project. This is the state the canvas has to be able
  // to distinguish from an empty board.
  const client = createBoardClient({ SUPABASE_URL: "https://fake.test", SUPABASE_SERVICE_ROLE_KEY: "k" }, async () => {
    throw new Error("getaddrinfo ENOTFOUND");
  });
  await assert.rejects(() => readBoard(client), /could not reach the database/);
});

test("an empty body is an empty result, not a parse failure", async () => {
  // `return=minimal` and a 204 both come back with no body.
  const client = createBoardClient({ SUPABASE_URL: "https://fake.test", SUPABASE_SERVICE_ROLE_KEY: "k" }, async () => ({
    ok: true,
    status: 204,
    text: async () => "",
  }));
  const board = await readBoard(client);
  assert.deepEqual(board.tasks, []);
});

test("an HTML error page is reported as such rather than crashing the parser", async () => {
  const client = createBoardClient({ SUPABASE_URL: "https://fake.test", SUPABASE_SERVICE_ROLE_KEY: "k" }, async () => ({
    ok: true,
    status: 200,
    text: async () => "<html>gateway timeout</html>",
  }));
  await assert.rejects(() => readBoard(client), /not JSON/);
});

test("building a client without credentials fails immediately and says what is missing", async () => {
  for (const env of [{}, { SUPABASE_URL: "https://x.test" }, { SUPABASE_SERVICE_ROLE_KEY: "k" }]) {
    assert.throws(() => createBoardClient(env), /SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY/);
  }
});

test("a trailing slash on the URL does not produce a double slash", async () => {
  const seen = [];
  const client = createBoardClient({ SUPABASE_URL: "https://fake.test/", SUPABASE_SERVICE_ROLE_KEY: "k" }, async (url) => {
    seen.push(url);
    return { ok: true, status: 200, text: async () => "[]" };
  });
  await readBoard(client);
  for (const url of seen) assert.ok(!url.includes(".test//"), url);
});
