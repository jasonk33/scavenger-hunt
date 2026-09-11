import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as scoring from "../src/lib/scoring.mjs";
import * as scoredEntries from "../src/lib/scored-entries.mjs";

function compile(path, imports = {}) {
  const exports = {};
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText;
  runInNewContext(code, {
    exports, URL, process: { env: {} },
    require(name) {
      assert.ok(name in imports, `Unexpected import: ${name}`);
      return imports[name];
    },
  });
  return exports;
}

const groups = compile("../src/lib/groups.ts");
const event = () => compile("../src/lib/event.ts");
const settingsFor = (active_round, started_round, submissions_open = false) => ({
  active_round, started_round, submissions_open, event_name: "Test Hunt", notice: "", saved_epoch: "",
});
const phases = [
  ["welcome", settingsFor(1, 0), false],
  ["round1", settingsFor(1, 1, true), true],
  ["break", settingsFor(1, 1), true],
  ["remix", settingsFor(2, 1), false],
  ["round2", settingsFor(2, 2, true), true],
  ["finished", settingsFor(2, 2), true],
];
const actions = ["start_round_1", "end_round_1", "reveal_round_2", "start_round_2", "end_round_2"];

function route(path, settings, db = () => {
  throw new Error("A locked route must not read private event data");
}) {
  return compile(`../src/app/api/${path}/route.ts`, {
    "@/lib/db": { db, mediaUrl: () => "", uploadConfig: () => ({}) },
    "@/lib/settings": { getSettings: async () => settings },
    get "@/lib/event"() { return event(); },
    "@/lib/http": {
      json: (body) => ({ status: 200, body }),
      fail: (error, status = 400) => ({ status, body: { error } }),
      isVideoObject: () => false,
    },
    "@/lib/groups": groups,
    "@/lib/scoring.mjs": scoring,
    "@/lib/scored-entries.mjs": scoredEntries,
    "node:crypto": { randomUUID: () => "unused" },
  });
}

for (const [label, settings] of [phases[0], phases[3]]) {
  for (const path of ["state", "task-entries", "submissions"]) {
    test(`${path} refuses ${label} before reading tasks or reserving media`, async () => {
      const handler = route(path, settings);
      const request = {
        url: `http://unit.test/api/${path}?playerId=player&taskId=task`,
        json: async () => ({ playerId: "player", taskId: "task", fileName: "photo.jpg" }),
      };
      const response = await (path === "submissions" ? handler.POST(request) : handler.GET(request));
      assert.equal(response.status, 409);
      assert.match(response.body.error, /start/i);
    });
  }
}

for (const path of ["leaderboard", "feed", "leaderboard/[teamId]"]) {
  test(`${path} refuses pre-event reads before any team, task, or media query`, async () => {
    const response = await route(path, settingsFor(1, 0)).GET(
      { url: "http://unit.test/api/leaderboard?round=1" },
      { params: Promise.resolve({ teamId: "team" }) },
    );
    assert.equal(response.status, 409);
  });
}

test("Round 2 details remain hidden after the team reveal but before the round starts", async () => {
  const response = await route("leaderboard/[teamId]", settingsFor(2, 1)).GET(
    { url: "http://unit.test/api/leaderboard/team?round=2" },
    { params: Promise.resolve({ teamId: "team" }) },
  );
  assert.equal(response.status, 404);
});

for (const [phase, settings, tasksVisible] of phases) {
  test(`${phase} has the correct round, visibility, and upload state`, () => {
    const state = event().eventState(settings);
    assert.equal(state.phase, phase);
    assert.equal(state.activeRound, settings.active_round);
    assert.equal(state.startedRound, settings.started_round);
    assert.equal(state.submissionsOpen, settings.submissions_open);
    assert.equal(state.tasksVisible, tasksVisible);
  });
}

test("a raw open flag never opens an unstarted round", () => {
  for (const settings of [settingsFor(1, 0, true), settingsFor(2, 1, true)]) {
    const state = event().eventState(settings);
    assert.equal(state.submissionsOpen, false);
    assert.equal(state.tasksVisible, false);
  }
});

test("a pre-event installation cannot reveal an old Round 2 selection", () => {
  const state = event().eventState(settingsFor(2, 0, true));
  assert.equal(state.phase, "welcome");
  assert.equal(state.activeRound, 1);
  assert.equal(state.tasksVisible, false);
});

for (const [index, action] of actions.entries()) {
  test(`${action} advances exactly one lifecycle step`, () => {
    const patch = event().eventTransition(phases[index][1], action);
    assert.deepEqual(structuredClone(patch), {
      active_round: phases[index + 1][1].active_round,
      started_round: phases[index + 1][1].started_round,
      submissions_open: phases[index + 1][1].submissions_open,
    });
    for (const [otherIndex, [, settings]] of phases.entries()) {
      if (otherIndex !== index) assert.throws(() => event().eventTransition(settings, action));
    }
  });
}

test("unknown event actions do not mutate settings", () => {
  assert.throws(() => event().eventTransition(phases[0][1], "reset"));
});

for (const [closed, open, action] of [[2, 1, "reopen_round_1"], [5, 4, "reopen_round_2"]]) {
  test(`${action} recovers an accidental end without resetting the event`, () => {
    assert.equal(event().eventState(event().eventTransition(phases[closed][1], action)).phase, phases[open][0]);
    for (const [index, [, settings]] of phases.entries()) {
      if (index !== closed) assert.throws(() => event().eventTransition(settings, action));
    }
  });
}

function settingsRoute({ settings = phases[0][1], organizer = true, uploading = false, readError = false, writeError = false } = {}) {
  const writes = [];
  const rpcCalls = [];
  const handler = compile("../src/app/api/admin/settings/route.ts", {
    "@/lib/settings": { getSettings: async () => settings, isOrganizer: async () => organizer },
    "@/lib/event": event(),
    "@/lib/db": {
      db: () => ({
        async rpc(name, args) {
          assert.equal(name, "transition_event");
          rpcCalls.push(structuredClone(args));
          if (writeError || readError) return { data: null, error: { message: "database unavailable" } };
          if (uploading && args.expected_active_round === 1 && args.next_active_round === 2) {
            return { data: "uploading", error: null };
          }
          writes.push(["active_round", "started_round", "submissions_open"].map((key) => ({
            key, value: String(args[`next_${key}`]),
          })));
          return { data: "ok", error: null };
        },
        from(table) {
          assert.equal(table, "settings");
          return {
            async upsert(rows) {
              writes.push(structuredClone(rows));
              return { error: writeError ? { message: "write failed" } : null };
            },
          };
        },
      }),
    },
    "@/lib/http": {
      json: (body) => ({ status: 200, body }),
      fail: (error, status = 400) => ({ status, body: { error } }),
    },
  });
  return { writes, rpcCalls, post: (body) => handler.POST({ json: async () => body }) };
}

for (const [index, action] of actions.entries()) {
  test(`Admin ${action} writes all lifecycle fields in one statement`, async () => {
    const api = settingsRoute({ settings: phases[index][1] });
    assert.equal((await api.post({ event_action: action, expected_phase: phases[index][0] })).status, 200);
    assert.equal(api.writes.length, 1);
    assert.deepEqual(Object.fromEntries(api.writes[0].map(({ key, value }) => [key, value])), {
      active_round: String(phases[index + 1][1].active_round),
      started_round: String(phases[index + 1][1].started_round),
      submissions_open: String(phases[index + 1][1].submissions_open),
    });
  });
}

test("a stale, repeated, or unrecognized Admin action cannot rewind the event", async () => {
  const api = settingsRoute({ settings: phases[2][1] });
  for (const body of [
    { event_action: "start_round_1", expected_phase: "welcome" },
    { event_action: "end_round_1", expected_phase: "break" },
    { event_action: "toString", expected_phase: "break" },
  ]) assert.equal((await api.post(body)).status, 409);
  assert.deepEqual(api.writes, []);
});

test("a delayed organizer write cannot undo a later successful team reveal", async () => {
  let current = { ...phases[1][1] };
  let releaseFirst;
  let reachedFirst;
  let writes = 0;
  const held = new Promise((resolve) => { releaseFirst = resolve; });
  const reached = new Promise((resolve) => { reachedFirst = resolve; });
  const beforeWrite = async () => {
    if (++writes === 1) {
      reachedFirst();
      await held;
    }
  };
  const db = () => ({
    async rpc(name, args) {
      assert.equal(name, "transition_event");
      await beforeWrite();
      if (["active_round", "started_round", "submissions_open"].some(
        (key) => current[key] !== args[`expected_${key}`],
      )) return { data: "stale", error: null };
      current = Object.fromEntries(["active_round", "started_round", "submissions_open"]
        .map((key) => [key, args[`next_${key}`]]));
      return { data: "ok", error: null };
    },
    from(table) {
      if (table === "settings") return {
        async upsert(rows) {
          await beforeWrite();
          current = Object.fromEntries(rows.map(({ key, value }) => [
            key, key === "submissions_open" ? value === "true" : Number(value),
          ]));
          return { error: null };
        },
      };
      assert.equal(table, "submissions");
      const query = {
        select() { return query; }, eq() { return query; },
        async limit() { return { data: [], error: null }; },
      };
      return query;
    },
  });
  const handler = compile("../src/app/api/admin/settings/route.ts", {
    "@/lib/settings": { getSettings: async () => ({ ...current }), isOrganizer: async () => true },
    "@/lib/event": event(),
    "@/lib/db": { db },
    "@/lib/http": {
      json: (body) => ({ status: 200, body }),
      fail: (error, status = 400) => ({ status, body: { error } }),
    },
  });
  const post = (event_action, expected_phase) => handler.POST({ json: async () => ({ event_action, expected_phase }) });
  const delayed = post("end_round_1", "round1");
  await reached;
  assert.equal((await post("end_round_1", "round1")).status, 200);
  assert.equal((await post("reveal_round_2", "break")).status, 200);
  releaseFirst();
  assert.equal((await delayed).status, 409);
  assert.equal(event().eventState(current).phase, "remix");
});

test("the organizer gate protects the new start action", async () => {
  const api = settingsRoute({ organizer: false });
  assert.equal((await api.post({ event_action: actions[0], expected_phase: "welcome" })).status, 401);
  assert.deepEqual(api.writes, []);
});

for (const option of ["uploading", "readError"]) {
  test(`revealing teams refuses ${option} without disrupting an in-flight upload`, async () => {
    const api = settingsRoute({ settings: phases[2][1], [option]: true });
    assert.equal((await api.post({ event_action: "reveal_round_2", expected_phase: "break" })).status,
      option === "uploading" ? 409 : 503);
    assert.deepEqual(api.writes, []);
    assert.equal(api.rpcCalls[0].expected_active_round, 1);
    assert.equal(api.rpcCalls[0].next_active_round, 2);
  });

  test("setup and the migration install the same atomic lifecycle function", () => {
    const migration = readFileSync(new URL("../supabase/migrations/20260911043000_event_welcome.sql", import.meta.url), "utf8");
    const setup = readFileSync(new URL("../supabase/setup.sql", import.meta.url), "utf8");
    const start = migration.indexOf("create or replace function public.transition_event(");
    assert.ok(start >= 0);
    assert.ok(setup.includes(migration.slice(start).trim()));
  });
}

test("a failed settings write reports failure, not a successful start", async () => {
  const api = settingsRoute({ writeError: true });
  assert.equal((await api.post({ event_action: actions[0], expected_phase: "welcome" })).status, 503);
});

test("invalid legacy settings cannot create an impossible start value", async () => {
  const api = settingsRoute();
  for (const body of [{ started_round: 3 }, { active_round: 0 }, { submissions_open: "maybe" }]) {
    assert.equal((await api.post(body)).status, 400);
  }
  assert.deepEqual(api.writes, []);
});

test("settings default to a closed welcome stage without assuming a failed read means pre-event", async () => {
  for (const readError of [false, true]) {
    const handler = compile("../src/lib/settings.ts", {
      "next/headers": { cookies: () => ({ get: () => undefined }) },
      "./event": event(),
      "./db": { db: () => ({
        from: () => ({
          select: async () => ({
            data: [{ key: "active_round", value: "2" }, { key: "submissions_open", value: "true" }],
            error: readError ? { message: "offline" } : null,
          }),
        }),
      }) },
    });
    if (readError) await assert.rejects(handler.getSettings(), /load event settings/);
    else {
      const settings = await handler.getSettings();
      assert.equal(settings.active_round, 1);
      assert.equal(settings.started_round, 0);
      assert.equal(settings.submissions_open, false);
    }
  }
});

test("an upload reserved before End Round 1 can still finalize afterwards", async () => {
  const calls = [];
  const handler = compile("../src/app/api/submissions/[id]/route.ts", {
    "@/lib/db": { db: () => ({
      from(table) {
        assert.equal(table, "submissions");
        const query = {
          update(patch) { calls.push(structuredClone(patch)); return query; },
          eq(key, value) { calls.push([key, value]); return query; },
          select() { return query; },
          async maybeSingle() { return { data: { id: "reserved", status: "pending" }, error: null }; },
        };
        return query;
      },
    }) },
    "@/lib/groups": groups,
    "@/lib/http": {
      json: (body) => ({ status: 200, body }),
      fail: (error, status = 400) => ({ status, body: { error } }),
    },
  });
  assert.equal((await handler.PATCH(
    { json: async () => ({ sizeBytes: 10 }) }, { params: Promise.resolve({ id: "reserved" }) },
  )).status, 200);
  assert.deepEqual(calls, [{ status: "pending", size_bytes: 10 }, ["id", "reserved"], ["status", "uploading"]]);
});

function emptyDb(calls, tables = {}, errorTable) {
  return () => ({
    from(table) {
      const filters = [];
      calls.push({ table, filters });
      const query = {
        select() { return query; },
        eq(key, value) { filters.push([key, value]); return query; },
        in() { return query; },
        order() { return query; },
        limit() { return query; },
        then(resolve, reject) {
          const data = (tables[table] ?? []).filter((row) =>
            filters.every(([key, value]) => row[key] === value));
          return Promise.resolve({ data, error: table === errorTable ? {} : null }).then(resolve, reject);
        },
      };
      return query;
    },
  });
}

test("Feed clamps future/default round reads to the latest started round throughout the break", async () => {
  for (const settings of [phases[2][1], phases[3][1]]) {
    for (const query of ["", "?round=2"]) {
      const calls = [];
      const response = await route("feed", settings, emptyDb(calls)).GET({
        url: `http://unit.test/api/feed${query}`,
      });
      assert.equal(response.status, 200);
      assert.equal(response.body.round, 1);
      assert.equal(response.body.activeRound, 1);
      for (const call of calls.filter(({ table }) => table !== "players")) {
        assert.deepEqual(call.filters, [["round", 1]]);
      }
    }
  }
});

test("Home reveals only the active roster, paired with that same round's event state", async () => {
  const tables = {
    players: [{ id: "guest", name: "Current Guest Name" }],
    teams: [
      { id: "team1", round: 1, name: "First Team", color: "#ff0000" },
      { id: "team2", round: 2, name: "Remixed Team", color: "#0000ff" },
    ],
    roster: [
      { player_id: "guest", team_id: "team1", round: 1 },
      { player_id: "guest", team_id: "team2", round: 2 },
    ],
  };
  for (const [phase, settings] of phases) {
    const response = await route("players", settings, emptyDb([], tables)).GET();
    assert.equal(response.body.event.phase, phase);
    assert.equal(response.body.eventName, "Test Hunt");
    assert.equal(response.body.players[0].name, "Current Guest Name");
    assert.equal(response.body.players[0].team.id, `team${settings.active_round}`);
    if (settings.active_round === 1) assert.doesNotMatch(JSON.stringify(response.body), /Remixed Team/);
  }
});

for (const table of ["players", "teams", "roster"]) {
  test(`Home does not say "no team" when its ${table} lookup failed`, async () => {
    assert.equal((await route("players", phases[0][1], emptyDb([], {}, table)).GET()).status, 503);
  });
}

test("the readiness command accepts intentional welcome and remix waits without a live database", async () => {
  const code = ts.transpileModule(readFileSync(new URL("./ready.mjs", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText;
  for (const [phase, settings] of [phases[0], phases[3], phases[1], ["welcome", settingsFor(2, 0)]]) {
    const lines = [];
    let exitCode;
    const tables = {
      settings: Object.entries(settings).map(([key, value]) => ({ key, value: String(value) })),
      players: [{ id: "one", name: "Guest One" }],
      teams: [1, 2].flatMap((round) => [1, 2].map((n) => ({ id: `r${round}-t${n}`, name: `Team ${n}`, round }))),
      roster: [1, 2].map((round) => ({ round, player_id: "one", team_id: `r${round}-t1` })),
      tasks: [1, 2].map((round) => ({ id: `task${round}`, slug: `r${round}-one`, round, title: "Test task", active: true })),
      submissions: [],
    };
    await runInNewContext(`(async () => { ${code.replace(/^#![^\n]*\n/, "")} })()`, {
      exports: {},
      process: { exit: (value) => { exitCode = value; } },
      console: { log: (line) => lines.push(line) },
      require(name) {
        assert.equal(name, "./task-store.mjs");
        return {
          loadEnv: () => ({ SUPABASE_ANON_KEY: "ey.test-fixture", ORGANIZER_PIN: "fixture" }),
          createAdminClient: async () => emptyDb([], tables)(),
        };
      },
    });
    assert.equal(exitCode, 0, `${phase}: ${lines.join("\n")}`);
    assert.ok(lines.some((line) => line.startsWith(`\nRound ${event().eventState(settings).activeRound} ·`)));
    assert.doesNotMatch(lines.join("\n"), /SUBMISSIONS ARE CLOSED/);
  }
});
