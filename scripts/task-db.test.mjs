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
  MODEL_KEY,
  TASK_TABLE,
  addTask,
  createTaskClient,
  moveTask,
  readTasks,
  updateModel,
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
 * Routing is by method and table. It reads the `slug=eq.` filter because a
 * secret is two rows and "did the write reach both" is the thing worth proving,
 * but it deliberately interprets nothing else -- so an assertion about
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

    const slugMatch = /slug=eq\.([^&]+)/.exec(url);
    const slug = slugMatch ? decodeURIComponent(slugMatch[1]) : null;

    if (method === "PATCH") {
      // Every row with this slug, which is what one statement would touch.
      const hit = state.rows.filter((r) => r.slug === slug);
      for (const row of hit) Object.assign(row, body);
      return { ok: true, status: 200, text: JSON.stringify(hit) };
    }
    if (method === "POST") {
      const created = (Array.isArray(body) ? body : [body]).map((b, i) => ({ ...ROW, id: `new-${i}`, ...b }));
      state.rows.push(...created);
      return { ok: true, status: 201, text: JSON.stringify(created) };
    }
    const found = slug ? state.rows.filter((r) => r.slug === slug) : state.rows;
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

// ── Reading ──────────────────────────────────────────────────────────────────

test("reading returns tasks in the task shape plus a model", async () => {
  const db = fakeDb();
  const board = await readTasks(db);
  assert.equal(board.tasks.length, 1);
  assert.equal(board.tasks[0].slug, "r1-01");
  assert.equal(board.tasks[0].requiresVideo, false);
  assert.ok(board.model.weights.difficulty > 0);
});

test("a secret's two rows read as one task", async () => {
  // Otherwise the canvas lists every secret twice and an edit to one copy
  // silently disagrees with the other half of the event.
  const board = await readTasks(fakeDb({ rows: [ROW, SECRET_R1, SECRET_R2] }));
  assert.deepEqual(board.tasks.map((t) => t.slug), ["r1-01", "s-04"]);
  assert.equal(board.tasks[1].round, 0);
});

test("a missing model row is a working task list, not a failure", async () => {
  // A canvas that refuses to load because one settings row is absent would be
  // unusable over a value that has a perfectly good default.
  const board = await readTasks(fakeDb({ settings: null }));
  assert.deepEqual(Object.keys(board.model), ["weights", "thresholds"]);
});

test("a stored model wins over the defaults", async () => {
  const stored = JSON.stringify({ weights: { difficulty: 2, guts: 2, luck: 2 }, thresholds: { t1: 1, t3: 2, t5: 3 } });
  const board = await readTasks(fakeDb({ settings: stored }));
  assert.equal(board.model.weights.difficulty, 2);
  assert.equal(board.model.thresholds.t5, 3);
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
  assert.ok(call.url.includes("select=id,round,slug"), "the select list is explicit");
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

test("moving a task off the leader bonus clears its winner", async () => {
  // team_scores reads coalesce(scoring_mode_snapshot, tasks.scoring_mode), so an
  // already-judged row keeps its 'competition' snapshot -- a winner left behind
  // here goes on paying a bonus for a task that is no longer a competition.
  for (const mode of ["fixed", "quantity"]) {
    const db = fakeDb();
    await updateTask(db, "r1-01", { scoringMode: mode });
    assert.equal(writeOf(db).body.winner_team_id, null, `${mode} must clear the winner`);
  }
});

test("staying on the leader bonus leaves the winner alone", async () => {
  const db = fakeDb();
  await updateTask(db, "r1-01", { scoringMode: "competition" });
  assert.ok(!("winner_team_id" in writeOf(db).body), "an unrelated edit must not clear a winner");

  const other = fakeDb();
  await updateTask(other, "r1-01", { points: 5 });
  assert.ok(!("winner_team_id" in writeOf(other).body), "a points edit must not clear a winner");
});

test("updating a secret writes both rounds in ONE statement", async () => {
  // Two statements would leave a window where Round 1 and Round 2 players are
  // looking at different wording for the same challenge, and a crash between
  // them would make that permanent.
  const db = fakeDb({ rows: [ROW, SECRET_R1, SECRET_R2] });
  const task = await updateTask(db, "s-04", { title: "Reworded secret" });
  const writes = taskCalls(db).filter((c) => c.method === "PATCH");
  assert.equal(writes.length, 1, "one request, filtered by slug");
  assert.ok(writes[0].url.includes("slug=eq.s-04"));
  assert.equal(db.state.rows.filter((r) => r.title === "Reworded secret").length, 2, "both rounds moved");
  assert.equal(task.round, 0, "and it comes back as the single task it is");
});

test("an update leaves every other task alone", async () => {
  const db = fakeDb({ rows: [ROW, SECRET_R1, SECRET_R2] });
  await updateTask(db, "s-04", { points: 10 });
  assert.equal(db.state.rows.find((r) => r.slug === "r1-01").points, 3);
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

test("a secret challenge refuses to move", async () => {
  // It is two rows because it runs in BOTH halves. Moving it to one round means
  // deleting the other row, and that cascades to submissions.
  const db = fakeDb({ rows: [ROW, SECRET_R1, SECRET_R2] });
  await assert.rejects(() => moveTask(db, "s-04", 2), /both halves/);
  assert.equal(taskCalls(db).some((c) => c.method === "PATCH"), false);
});

test("a task whose leader bonus has been awarded refuses to move", async () => {
  // The winner is a team in the round the task is leaving, and team_scores pays
  // the bonus on `winner_team_id = team_id`. Moving the row silently either
  // takes points off a team that already earned them or leaves a winner that is
  // not in the task's round. Say so instead.
  const db = fakeDb({ rows: [{ ...ROW, scoring_mode: "competition", winner_team_id: "team-r1" }] });
  await assert.rejects(() => moveTask(db, "r1-01", 2), /winner/i);
  assert.equal(taskCalls(db).some((c) => c.method === "PATCH"), false);
});

test("only Round 1 and Round 2 are somewhere to move to", async () => {
  for (const round of [0, 3, -1, null, "2x", undefined]) {
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
  const task = await addTask(db, { title: "  A new one  ", round: 1, points: 10, difficulty: 5 });
  assert.equal(task.slug, "r1-x2", "r1-x1 is taken");
  assert.equal(task.active, true, "there is no staging state to land in");
  assert.equal(task.title, "A new one");
  assert.equal(task.points, 10);
  assert.equal(task.difficulty, 5);
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
    requiresVideo: true,
    note: "Keep the count visible.",
    difficulty: 4,
    guts: 2,
    luck: 3,
    payoff: 5,
    risk: 2,
  });
  const insert = taskCalls(db).find((c) => c.method === "POST");
  assert.equal(insert.body[0].scoring_mode, "quantity");
  assert.equal(insert.body[0].measurement_label, "Extra hats");
  assert.equal(insert.body[0].points_per_unit, 2);
  assert.equal(insert.body[0].prop, "red hat");
  assert.equal(insert.body[0].requires_video, true);
  assert.equal(insert.body[0].note, "Keep the count visible.");
  assert.equal(task.scoringMode, "quantity");
  assert.equal(task.prop, "red hat");
  assert.equal(task.requiresVideo, true);
});

test("an added secret is inserted once per round, in one request", async () => {
  // Two requests could leave a challenge existing in half the event.
  const db = fakeDb({ rows: [] });
  const task = await addTask(db, { title: "Secret", round: 0 });
  const inserts = taskCalls(db).filter((c) => c.method === "POST");
  assert.equal(inserts.length, 1);
  assert.deepEqual(inserts[0].body.map((r) => r.round), [1, 2]);
  assert.ok(inserts[0].body.every((r) => r.slug === "s-x1" && r.is_secret === true));
  assert.equal(task.round, 0, "and reads back as one task");
  assert.equal(task.points, 7, "the flat secret tier");
});

test("an added secret always uses the secret tier", async () => {
  const db = fakeDb({ rows: [] });
  const task = await addTask(db, { title: "Secret", round: 0, points: 3 });
  const insert = taskCalls(db).find((c) => c.method === "POST");
  assert.deepEqual(insert.body.map((row) => row.points), [7, 7]);
  assert.equal(task.points, 7);
});

test("an explicit secret choice fans out to both rounds", async () => {
  const db = fakeDb({ rows: [] });
  const task = await addTask(db, { title: "Secret", round: 1, isSecret: true, points: 3 });
  const insert = taskCalls(db).find((c) => c.method === "POST");
  assert.deepEqual(insert.body.map((row) => row.round), [1, 2]);
  assert.ok(insert.body.every((row) => row.is_secret === true && row.points === 7));
  assert.equal(task.round, 0);
});

test("an added normal task is exactly one row", async () => {
  const db = fakeDb({ rows: [] });
  await addTask(db, { title: "x", round: 2 });
  const insert = taskCalls(db).find((c) => c.method === "POST");
  assert.equal(insert.body.length, 1);
  assert.equal(insert.body[0].is_secret, false);
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

test("an added secret clears the highest doc_order in BOTH rounds", async () => {
  // Its two rows share a doc_order, so a number that is free in Round 1 but
  // taken in Round 2 would collide in half the event.
  const db = fakeDb({
    rows: [
      { ...ROW, id: "a", slug: "r1-01", round: 1, doc_order: 5 },
      { ...ROW, id: "b", slug: "r2-01", round: 2, doc_order: 40 },
    ],
  });
  const task = await addTask(db, { title: "Secret", round: 0 });
  assert.equal(task.docOrder, 41);
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
