/**
 * The query layer, proved against a fake `fetch`.
 *
 *   node --test scripts/task-db.test.mjs
 *
 * There is exactly ONE Supabase project and it holds the live event: the real
 * task list, the real roster, real submissions and real media. So the escape
 * hatch is the point of this file. Every query takes a client whose `fetch` is
 * injectable, which means a test can prove the HTTP that would go over the wire
 * without a network, without `.env.local`, and above all without the ability to
 * touch the real tasks. Driving them as a fixture has cost real edits twice, and
 * now that the canvas writes what players read it would cost player-visible
 * ones; this is what makes it structurally impossible rather than discouraged.
 *
 * The fake records every request, so the assertions are about what was SENT.
 * "It wrote every task" and "it wrote one field" return the same value and are
 * the difference between losing someone else's edits and not.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  TASK_TABLE,
  addTask,
  createTaskClient,
  moveTask,
  readTasks,
  updateTask,
} from "./task-store.mjs";

const ROW = {
  id: "uuid-1",
  slug: "r1-01",
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
  requires_video: false,
  is_secret: false,
  active: true,
  prop: "",
  rewrite: false,
  note: "",
  tier_ok: null,
};

/** A secret challenge: one task, two rows, one slug. */
const SECRET_R1 = { ...ROW, id: "uuid-s1", slug: "s-04", round: 1, is_secret: true, points: 7, title: "A secret" };
const SECRET_R2 = { ...SECRET_R1, id: "uuid-s2", round: 2 };

/**
 * A client whose `fetch` answers from fixtures and records every request.
 *
 * Routing is by method and table. It interprets slug and historical-row filters;
 * assertions inspect the recorded URL as well as the resulting fake state.
 */
function fakeDb({ rows = [ROW], failOn = null, submissions = [] } = {}) {
  const calls = [];
  const state = { rows: rows.map((r) => ({ ...r })), submissions };

  const respond = (url, init) => {
    const method = init.method ?? "GET";
    const table = url.split("/rest/v1/")[1].split("?")[0];
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, table, url, body, headers: init.headers });

    if (failOn === table) return { ok: false, status: 500, text: JSON.stringify({ message: `boom on ${table}` }) };

    // Only ever asked "has this task been played", so it answers with the rows
    // whose task_id was filtered on and interprets nothing else.
    if (table === "submissions") {
      const taskMatch = /task_id=eq\.([^&]+)/.exec(url);
      const taskId = taskMatch ? decodeURIComponent(taskMatch[1]) : null;
      const found = state.submissions.filter((s) => !taskId || s.task_id === taskId);
      return { ok: true, status: 200, text: JSON.stringify(found) };
    }

    const slugMatch = /slug=eq\.([^&]+)/.exec(url);
    const slug = slugMatch ? decodeURIComponent(slugMatch[1]) : null;
    const ordinary = new URL(url).searchParams.get("is_secret") === "eq.false";
    const matches = (r) => (!slug || r.slug === slug) && (!ordinary || r.is_secret === false);

    if (method === "PATCH") {
      // Every row with this slug, which is what one statement would touch.
      const hit = state.rows.filter(matches);
      for (const row of hit) Object.assign(row, body);
      return { ok: true, status: 200, text: JSON.stringify(hit) };
    }
    if (method === "POST") {
      const created = (Array.isArray(body) ? body : [body]).map((b, i) => ({ ...ROW, id: `new-${i}`, ...b }));
      state.rows.push(...created);
      return { ok: true, status: 201, text: JSON.stringify(created) };
    }
    const found = state.rows.filter(matches);
    return { ok: true, status: 200, text: JSON.stringify(found.map((r) => ({ ...r }))) };
  };

  const fetchImpl = async (url, init = {}) => {
    const { ok, status, text } = respond(url, init);
    return { ok, status, text: async () => text };
  };

  const client = createTaskClient({ SUPABASE_URL: "https://fake.test", SUPABASE_SERVICE_ROLE_KEY: "k" }, fetchImpl);
  client.calls = calls;
  client.state = state;
  return client;
}

const taskCalls = (db) => db.calls.filter((c) => c.table === TASK_TABLE);
const writeOf = (db) => taskCalls(db).find((c) => c.method === "PATCH");

test("retired fields never reach the planner payload or select list", async () => {
  const db = fakeDb();
  const board = await readTasks(db);
  assert.deepEqual(Object.keys(board), ["tasks"]);
  const retired = ["difficulty", "guts", "luck", "payoff", "risk", "requires_video", "is_secret",
    "competition_bonus", "winner_team_id", "tier_ok"];
  const selected = new URL(taskCalls(db)[0].url).searchParams.get("select").split(",");
  for (const key of retired) assert.ok(!selected.includes(key), `${key} is not selected`);
  for (const key of ["requiresVideo", "isSecret", "competitionBonus", "tierOk", ...retired]) {
    assert.ok(!(key in board.tasks[0]), `${key} is not exposed`);
  }
  assert.ok(db.calls.every((call) => call.table !== "settings"), "the task list needs no model");
});

test("historical secret rows stay inaccessible before and after migration", async () => {
  for (const active of [true, false]) {
    const rows = [ROW, { ...SECRET_R1, active }, { ...SECRET_R2, active }];
    const db = fakeDb({ rows });
    const board = await readTasks(db);
    assert.deepEqual(board.tasks.map((t) => t.slug), ["r1-01"]);
    assert.equal(await updateTask(db, "s-04", { active: true, title: "must not land" }), null);
    assert.equal(await updateTask(db, "s-04", {}), null);
    assert.equal(await moveTask(db, "s-04", 2), null);
    assert.deepEqual(db.state.rows, rows, "historical rows are neither renamed, moved nor reactivated");
    for (const call of taskCalls(db)) {
      assert.equal(new URL(call.url).searchParams.get("is_secret"), "eq.false");
    }
  }
});

test("retired creation modes are refused before any database request", async () => {
  for (const input of [
    { round: 0 }, { round: 1, isSecret: true }, { round: 1, scoringMode: "competition" },
    { round: true }, { round: 3 }, { round: 1, scoringMode: "unknown" },
  ]) {
    const db = fakeDb();
    await assert.rejects(() => addTask(db, { title: "A task", ...input }), /Round 1 or Round 2|fixed or quantity|no longer supported/i);
    assert.equal(db.calls.length, 0);
  }
});

test("retired scoring patches are refused without partially applying other fields", async () => {
  const db = fakeDb();
  await assert.rejects(() => updateTask(db, "r1-01", { scoringMode: "competition", note: "must not land" }), /fixed or quantity/i);
  assert.equal(db.calls.length, 0);
});

test("concurrent edits to different fields and tasks never replace each other", async () => {
  const other = { ...ROW, id: "uuid-2", slug: "r1-02" };
  const db = fakeDb({ rows: [ROW, other] });
  await Promise.all([
    updateTask(db, ROW.slug, { note: "one editor" }),
    updateTask(db, ROW.slug, { points: 10 }),
    updateTask(db, other.slug, { prop: "hat", active: false }),
  ]);
  assert.equal(db.state.rows[0].note, "one editor");
  assert.equal(db.state.rows[0].points, 10);
  assert.equal(db.state.rows[0].active, true);
  assert.equal(db.state.rows[1].prop, "hat");
  assert.equal(db.state.rows[1].active, false);
  assert.equal(db.state.rows[1].points, 3);
  assert.equal(taskCalls(db).filter((call) => call.method === "PATCH").length, 3);
});

// ── Reading ──────────────────────────────────────────────────────────────────

test("reading returns ordinary tasks in the task shape", async () => {
  const db = fakeDb();
  const board = await readTasks(db);
  assert.equal(board.tasks.length, 1);
  assert.equal(board.tasks[0].slug, "r1-01");
  assert.equal(board.tasks[0].round, 1);
  assert.equal(board.tasks[0].points, 3);
});

test("a failed read throws rather than returning an empty list", async () => {
  // An empty list renders as "there are no tasks", which is indistinguishable
  // from a list that really is empty. It has to be an error all the way up.
  await assert.rejects(() => readTasks(fakeDb({ failOn: TASK_TABLE })), /could not read the task list/);
});

test("reading names its columns rather than selecting everything", async () => {
  const db = fakeDb();
  await readTasks(db);
  const call = taskCalls(db)[0];
  assert.ok(call.url.includes("select=id,slug,round"), "the select list is explicit");
  assert.ok(!call.url.includes("select=*"), "a new column must not arrive unmapped");
});

// ── Writing ──────────────────────────────────────────────────────────────────

test("an update writes ONLY the fields that changed", async () => {
  // Writing everything is what lets one process overwrite another's unrelated
  // edits; this is the assertion that stops that from coming back.
  const db = fakeDb();
  await updateTask(db, "r1-01", { points: 5 });
  const write = writeOf(db);
  assert.deepEqual(Object.keys(write.body).sort(), ["points", "updated_at"]);
  assert.equal(write.body.points, 5);
  assert.ok(write.url.includes("slug=eq.r1-01"), "scoped to one task");
});

test("an update carries no field the caller did not name", async () => {
  const db = fakeDb();
  await updateTask(db, "r1-01", { note: "why" });
  const write = writeOf(db);
  for (const key of ["title", "active", "difficulty", "round", "doc_title"]) {
    assert.ok(!(key in write.body), `${key} must not be rewritten`);
  }
});

test("scoring edits write only the mode, leaving dormant rollout columns alone", async () => {
  for (const mode of ["fixed", "quantity"]) {
    const db = fakeDb();
    await updateTask(db, "r1-01", { scoringMode: mode });
    assert.deepEqual(Object.keys(writeOf(db).body).sort(), ["scoring_mode", "updated_at"]);
    assert.equal(writeOf(db).body.scoring_mode, mode);
  }
});

test("an update leaves every other task alone", async () => {
  const other = { ...ROW, id: "uuid-2", slug: "r2-01", round: 2 };
  const db = fakeDb({ rows: [ROW, other, SECRET_R1, SECRET_R2] });
  await updateTask(db, "r1-01", { points: 10 });
  assert.deepEqual(db.state.rows.slice(1), [other, SECRET_R1, SECRET_R2]);
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
  assert.equal(taskCalls(db).some((c) => c.method === "PATCH"), false, "no write may be issued");
  assert.equal(task.slug, "r1-01", "the unchanged task is still returned");
});

test("an unknown slug reports null instead of inventing a row", async () => {
  const db = fakeDb();
  assert.equal(await updateTask(db, "nope-99", { points: 5 }), null);
  assert.equal(await updateTask(db, "nope-99", {}), null);
  assert.equal(await updateTask(db, "", { points: 5 }), null);
  assert.equal(await updateTask(db, null, { points: 5 }), null);
});

test("a failed update throws and names the task", async () => {
  await assert.rejects(
    () => updateTask(fakeDb({ failOn: TASK_TABLE }), "r1-01", { points: 5 }),
    /could not update task r1-01/
  );
});

// ── Moving between rounds ────────────────────────────────────────────────────

/** Round 2 already has two tasks, so "last in the destination round" has a number to beat. */
const R2_ROWS = [
  { ...ROW, id: "uuid-9", slug: "r2-01", round: 2, doc_order: 4, title: "Already in R2" },
  { ...ROW, id: "uuid-10", slug: "r2-02", round: 2, doc_order: 9, title: "Also in R2" },
];

test("a move writes the round and nothing else about the task", async () => {
  const db = fakeDb({ rows: [ROW, ...R2_ROWS] });
  const task = await moveTask(db, "r1-01", 2);
  const write = writeOf(db);
  assert.ok(write.url.includes("slug=eq.r1-01"), "scoped to one task");
  assert.deepEqual(Object.keys(write.body).sort(), ["doc_order", "round", "updated_at"]);
  assert.equal(write.body.round, 2);
  assert.equal(task.round, 2);
});

test("a moved task lands last in the round it arrives in", async () => {
  // doc_order is the tie-break inside a tier, so keeping the one it had in the
  // round it left would drop it into the middle of a list it was never ordered
  // against -- and could hand it a sort_order another task already has.
  const db = fakeDb({ rows: [ROW, ...R2_ROWS] });
  await moveTask(db, "r1-01", 2);
  assert.equal(writeOf(db).body.doc_order, 10, "one past the highest in Round 2");
});

test("a move leaves every other task alone", async () => {
  const db = fakeDb({ rows: [ROW, ...R2_ROWS] });
  await moveTask(db, "r1-01", 2);
  assert.deepEqual(
    db.state.rows.map((r) => [r.slug, r.round, r.doc_order]),
    [["r1-01", 2, 10], ["r2-01", 2, 4], ["r2-02", 2, 9]]
  );
});

test("moving a task to the round it is already in writes nothing", async () => {
  // An empty UPDATE would bump updated_at for an edit nobody made, and
  // renumbering doc_order would silently reorder the round for a no-op.
  const db = fakeDb({ rows: [ROW, ...R2_ROWS] });
  const task = await moveTask(db, "r1-01", 1);
  assert.equal(taskCalls(db).some((c) => c.method === "PATCH"), false, "no write may be issued");
  assert.equal(task.round, 1, "the unchanged task is still returned");
});

test("dormant pre-migration winner columns do not block ordinary unplayed moves", async () => {
  const db = fakeDb({ rows: [{ ...ROW, scoring_mode: "competition", winner_team_id: "team-r1" }] });
  const task = await moveTask(db, "r1-01", 2);
  assert.equal(task.round, 2);
  assert.equal(task.scoringMode, "fixed");
});

test("a task someone has already submitted refuses to move", async () => {
  // The judge's queue, the player's task list and the feed all resolve a
  // submission's task out of the tasks for THAT round, so the row leaving would
  // strand real evidence: "(deleted task)" in the queue, a blank title in the
  // feed, and a pending submission nobody can read.
  const db = fakeDb({ rows: [ROW, ...R2_ROWS], submissions: [{ id: "sub-1", task_id: "uuid-1" }] });
  await assert.rejects(() => moveTask(db, "r1-01", 2), /already submitted this task in Round 1/);
  assert.equal(taskCalls(db).some((c) => c.method === "PATCH"), false);
});

test("a submission on a DIFFERENT task does not block a move", async () => {
  const db = fakeDb({ rows: [ROW, ...R2_ROWS], submissions: [{ id: "sub-1", task_id: "uuid-9" }] });
  const task = await moveTask(db, "r1-01", 2);
  assert.equal(task.round, 2);
});

test("a task already in the target round is never refused", async () => {
  // Nothing is moving, so a played submission is not a
  // reason to say no -- refusing there would be a control failing at a no-op.
  const rows = [ROW];
  const db = fakeDb({ rows, submissions: [{ id: "sub-1", task_id: "uuid-1" }] });
  const task = await moveTask(db, "r1-01", 1);
  assert.equal(task.round, 1);
  assert.equal(taskCalls(db).some((c) => c.method === "PATCH"), false);
});

test("only Round 1 and Round 2 are somewhere to move to", async () => {
  // `true` is in here because Number(true) is 1: a request to move a task to
  // `true` must be refused, not quietly answered with Round 1.
  for (const round of [0, 3, -1, null, "2x", undefined, true, false]) {
    await assert.rejects(() => moveTask(fakeDb(), "r1-01", round), /Round 1 or Round 2/);
  }
});

test("moving an unknown slug reports null instead of inventing a row", async () => {
  const db = fakeDb();
  assert.equal(await moveTask(db, "nope-99", 2), null);
  assert.equal(await moveTask(db, "", 2), null);
  assert.equal(await moveTask(db, null, 2), null);
});

test("a failed move throws and names the task", async () => {
  await assert.rejects(() => moveTask(fakeDb({ failOn: TASK_TABLE }), "r1-01", 2), /r1-01/);
});

test("an added task is live, with a slug that is not already taken", async () => {
  const db = fakeDb({ rows: [ROW, { ...ROW, id: "uuid-2", slug: "r1-x1" }] });
  const task = await addTask(db, { title: "  A new one  ", round: 1, points: 10, rewrite: true });
  assert.equal(task.slug, "r1-x2", "r1-x1 is taken");
  assert.equal(task.active, true, "there is no staging state to land in");
  assert.equal(task.title, "A new one");
  assert.equal(task.points, 10);
  assert.equal(task.rewrite, true);
  assert.equal(task.docTitle, "", "it did not come from the planning doc");
});

test("an added task keeps the details chosen in the planner", async () => {
  const db = fakeDb({ rows: [] });
  const task = await addTask(db, {
    title: "Count the red hats",
    round: 1,
    points: 5,
    scoringMode: "quantity",
    measurementLabel: "Extra hats",
    pointsPerUnit: 2,
    prop: "red hat",
    note: "Keep the count visible.",
  });
  const insert = taskCalls(db).find((c) => c.method === "POST");
  assert.equal(insert.body[0].scoring_mode, "quantity");
  assert.equal(insert.body[0].measurement_label, "Extra hats");
  assert.equal(insert.body[0].points_per_unit, 2);
  assert.equal(insert.body[0].prop, "red hat");
  assert.equal(insert.body[0].note, "Keep the count visible.");
  assert.equal(task.scoringMode, "quantity");
  assert.equal(task.prop, "red hat");
});

test("an added normal task is exactly one row", async () => {
  const db = fakeDb({ rows: [] });
  await addTask(db, { title: "x", round: 2 });
  const insert = taskCalls(db).find((c) => c.method === "POST");
  assert.equal(insert.body.length, 1);
  assert.equal(insert.body[0].scoring_mode, "fixed");
  assert.ok(!("is_secret" in insert.body[0]), "legacy default is enough; no secret field is writable");
  assert.equal(insert.body[0].round, 2);
});

test("an added task takes the next doc_order in its round, never a shared one", async () => {
  // doc_order is the tie-break inside a tier, and sort_order is generated from
  // it. Two tasks in one round sharing a doc_order at the same point value get
  // the same sort_order, and the player's list -- polled every 5 seconds --
  // would swap them under their thumb. Admin allocates highest-plus-one too.
  const db = fakeDb({
    rows: [
      { ...ROW, id: "a", slug: "r1-01", round: 1, doc_order: 4 },
      { ...ROW, id: "b", slug: "r1-02", round: 1, doc_order: 12 },
      { ...ROW, id: "c", slug: "r2-01", round: 2, doc_order: 90 },
    ],
  });
  const task = await addTask(db, { title: "x", round: 1 });
  assert.equal(task.docOrder, 13, "one past round 1's highest, not past round 2's");
});

test("an added task with an illegal tier falls back rather than being rejected by the column", async () => {
  const db = fakeDb({ rows: [] });
  assert.equal((await addTask(db, { title: "x", round: 2, points: 4 })).points, 3);
});

// ── The wire itself ──────────────────────────────────────────────────────────
//
// These queries are hand-rolled HTTP rather than a library's, so the parts the
// library used to get right have to be asserted.

test("every request carries the service_role key both ways round", async () => {
  // PostgREST needs `apikey`; RLS needs the bearer token. Missing either returns
  // an empty result rather than an error, which would read as an empty list.
  const db = fakeDb();
  await readTasks(db);
  for (const call of db.calls) {
    assert.equal(call.headers.apikey, "k");
    assert.equal(call.headers.Authorization, "Bearer k");
  }
});

test("a write asks for the rows back, or the canvas cannot show what it saved", async () => {
  const db = fakeDb();
  await updateTask(db, "r1-01", { points: 5 });
  assert.match(writeOf(db).headers.Prefer, /return=representation/);
});

test("a slug is escaped into the URL rather than concatenated", async () => {
  // A slug is `r1-01` today, but a hand-built query string that trusts its input
  // is how a filter silently stops filtering -- and an unfiltered PATCH would
  // rewrite every task in the event.
  const db = fakeDb();
  await updateTask(db, "r1-01&slug=neq.x", { points: 5 });
  const call = taskCalls(db).find((c) => c.method === "PATCH") ?? taskCalls(db).at(-1);
  assert.ok(!call.url.includes("&slug=neq.x"), "the injected filter must not survive as syntax");
  assert.ok(call.url.includes("slug=eq.r1-01%26slug%3Dneq.x"), "it is one encoded value");
});

test("a PostgREST error message reaches the caller, not just a status code", async () => {
  // A check-constraint violation names the constraint, and that is the entire
  // actionable content. `HTTP 400` on the banner is unactionable.
  await assert.rejects(() => readTasks(fakeDb({ failOn: TASK_TABLE })), /boom on tasks/);
});

test("a thrown fetch is reported as unreachable rather than as undefined", async () => {
  // Offline, DNS, a paused project. This is the state the canvas has to be able
  // to distinguish from an empty task list.
  const client = createTaskClient({ SUPABASE_URL: "https://fake.test", SUPABASE_SERVICE_ROLE_KEY: "k" }, async () => {
    throw new Error("getaddrinfo ENOTFOUND");
  });
  await assert.rejects(() => readTasks(client), /could not reach the database/);
});

test("an empty body is an empty result, not a parse failure", async () => {
  // `return=minimal` and a 204 both come back with no body.
  const client = createTaskClient({ SUPABASE_URL: "https://fake.test", SUPABASE_SERVICE_ROLE_KEY: "k" }, async () => ({
    ok: true,
    status: 204,
    text: async () => "",
  }));
  const board = await readTasks(client);
  assert.deepEqual(board.tasks, []);
});

test("an HTML error page is reported as such rather than crashing the parser", async () => {
  const client = createTaskClient({ SUPABASE_URL: "https://fake.test", SUPABASE_SERVICE_ROLE_KEY: "k" }, async () => ({
    ok: true,
    status: 200,
    text: async () => "<html>gateway timeout</html>",
  }));
  await assert.rejects(() => readTasks(client), /not JSON/);
});

test("building a client without credentials fails immediately and says what is missing", async () => {
  for (const env of [{}, { SUPABASE_URL: "https://x.test" }, { SUPABASE_SERVICE_ROLE_KEY: "k" }]) {
    assert.throws(() => createTaskClient(env), /SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY/);
  }
});

test("a trailing slash on the URL does not produce a double slash", async () => {
  const seen = [];
  const client = createTaskClient({ SUPABASE_URL: "https://fake.test/", SUPABASE_SERVICE_ROLE_KEY: "k" }, async (url) => {
    seen.push(url);
    return { ok: true, status: 200, text: async () => "[]" };
  });
  await readTasks(client);
  for (const url of seen) assert.ok(!url.includes(".test//"), url);
});
