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
    exports,
    URL,
    require(name) {
      assert.ok(name in imports, `Unexpected import: ${name}`);
      return imports[name];
    },
  });
  return exports;
}

const groups = compile("../src/lib/groups.ts");
const event = compile("../src/lib/event.ts");
const TEAMS = [
  { id: "r1-a", round: 1, name: "First Round Red", color: "#dc2626" },
  { id: "r1-b", round: 1, name: "First Round Blue", color: "#2563eb" },
  { id: "r2-a", round: 2, name: "Secret Remix North", color: "#16a34a" },
  { id: "r2-b", round: 2, name: "Secret Remix South", color: "#7c3aed" },
];
const PLAYERS = [
  { id: "a", name: "Ada Avery" },
  { id: "b", name: "Bea Bradford" },
  { id: "c", name: "Cal Chen" },
  { id: "d", name: "Future Only Guest" },
];
const ROSTER = [
  { round: 1, team_id: "r1-a", player_id: "b" },
  { round: 1, team_id: "r1-a", player_id: "a" },
  { round: 1, team_id: "r1-b", player_id: "c" },
  { round: 2, team_id: "r2-a", player_id: "b" },
  { round: 2, team_id: "r2-a", player_id: "d" },
  { round: 2, team_id: "r2-b", player_id: "a" },
  { round: 2, team_id: "r2-b", player_id: "c" },
];

function api({ activeRound = 1, startedRound = activeRound, errorTable, players = PLAYERS, roster = ROSTER, detail = false } = {}) {
  const calls = [];
  const tables = {
    players, roster, teams: TEAMS,
    team_scores: TEAMS.map((team, index) => ({
      ...team, team_id: team.id, points: 10 - index, tasks_scored: 1,
    })),
    submissions: [
      { id: "s1", round: 1, team_id: "r1-a", group_id: "g1", status: "pending" },
      { id: "s2", round: 1, team_id: "r1-a", group_id: "g1", status: "pending" },
      { id: "s3", round: 1, team_id: "r1-b", group_id: null, status: "pending" },
      { id: "s4", round: 2, team_id: "r2-a", group_id: "g2", status: "pending" },
    ],
  };
  const route = compile(`../src/app/api/leaderboard/${detail ? "[teamId]/" : ""}route.ts`, {
    "@/lib/db": {
      mediaUrl: () => { throw new Error("No media expected in these fixtures"); },
      db: () => ({
        from(table) {
          assert.ok(table in tables, `Unexpected table: ${table}`);
          const call = { table, filters: [] };
          calls.push(call);
          const result = () => ({
            data: table === errorTable ? null : tables[table].filter((row) =>
              call.filters.every(([key, value]) => row[key] === value)
            ),
            error: table === errorTable ? { message: `${table} unavailable` } : null,
          });
          const query = {
            select(columns) { call.columns = columns; return query; },
            eq(key, value) { call.filters.push([key, value]); return query; },
            order() { return query; },
            async maybeSingle() {
              const { data, error } = result();
              return { data: data?.[0] ?? null, error };
            },
            then(resolve, reject) { return Promise.resolve(result()).then(resolve, reject); },
          };
          return query;
        },
      }),
    },
    "@/lib/settings": { getSettings: async () => ({ active_round: activeRound, started_round: startedRound, submissions_open: true }) },
    "@/lib/event": event,
    "@/lib/http": {
      json: (body) => ({ status: 200, body }),
      fail: (error, status = 400) => ({ status, body: { error } }),
      isVideoObject: () => false,
    },
    "@/lib/groups": groups,
    "@/lib/scoring.mjs": scoring,
    "@/lib/scored-entries.mjs": scoredEntries,
  });
  return {
    calls,
    get: async (query = "", teamId = "r1-a") => structuredClone(await route.GET(
      { url: `http://unit.test/api/leaderboard${detail ? `/${teamId}` : ""}${query}` },
      { params: Promise.resolve({ teamId }) }
    )),
  };
}

test("revealing the remix keeps Scores on Round 1 until Round 2 actually starts", async () => {
  for (const query of ["", "?round=2"]) {
    const { status, body } = await api({ activeRound: 2, startedRound: 1 }).get(query);
    assert.equal(status, 200);
    assert.equal(body.round, 1);
    assert.equal(body.activeRound, 1);
    assert.doesNotMatch(JSON.stringify(body), /Secret Remix|Future Only Guest/);
  }
});

for (const [activeRound, query, expected] of [
  [1, "", 1], [1, "?round=1", 1], [1, "?round=2", 1],
  [2, "", 2], [2, "?round=2", 2], [2, "?round=1", 1],
]) {
  test(`Scores active ${activeRound}, ${query || "default"} returns only round ${expected} and its roster`, async () => {
    const endpoint = api({ activeRound });
    const { status, body } = await endpoint.get(query);
    assert.equal(status, 200);
    assert.equal(body.round, expected);
    assert.equal(body.activeRound, activeRound);
    assert.equal(body.rows.length, 2);
    for (const row of body.rows) {
      assert.ok(TEAMS.some((team) => team.id === row.teamId && team.round === expected));
      const members = ROSTER.filter((entry) => entry.round === expected && entry.team_id === row.teamId)
        .map((entry) => PLAYERS.find((player) => player.id === entry.player_id))
        .sort((a, b) => a.name.localeCompare(b.name));
      assert.deepEqual(row.members, members);
    }
    for (const table of ["team_scores", "submissions", "roster"]) {
      assert.ok(endpoint.calls.some((call) => call.table === table));
      assert.ok(endpoint.calls.filter((call) => call.table === table)
        .every((call) => call.filters.some(([key, value]) => key === "round" && value === expected)));
    }
    if (expected === 1) assert.doesNotMatch(JSON.stringify(body), /Secret Remix|Future Only Guest/);
  });
}

test("member names do not change points or count multi-file pending evidence twice", async () => {
  const { body } = await api().get();
  assert.equal(body.totalPending, 2);
  assert.equal(body.rows[0].points, 10);
  assert.equal(body.rows[0].tasksScored, 1);
  assert.equal(body.rows[0].pending, 1);
});

test("a team with no assignments has an explicitly empty member list", async () => {
  const { body } = await api({ roster: [] }).get();
  assert.ok(body.rows.every((row) => Array.isArray(row.members) && row.members.length === 0));
});

for (const errorTable of ["team_scores", "submissions", "players", "roster"]) {
  test(`a failed ${errorTable} read is an error, not an empty Scores result`, async () => {
    const response = await api({ errorTable }).get();
    assert.equal(response.status, 503);
    assert.equal(response.body.rows, undefined);
  });
}

test("missing player data is not presented as an unassigned team", async () => {
  const response = await api({ players: [] }).get();
  assert.equal(response.status, 503);
});

test("Scores rejects an invalid round before loading any team data", async () => {
  const endpoint = api();
  assert.equal((await endpoint.get("?round=3")).status, 400);
  assert.deepEqual(endpoint.calls, []);
});

test("future team details are refused before any team or submission lookup", async () => {
  const endpoint = api({ detail: true });
  const response = await endpoint.get("?round=2", "r2-a");
  assert.equal(response.status, 404);
  assert.equal(response.body.team, undefined);
  assert.deepEqual(endpoint.calls, []);
});

test("a future team id cannot be exposed by requesting the current round", async () => {
  const endpoint = api({ detail: true });
  const response = await endpoint.get("?round=1", "r2-a");
  assert.equal(response.status, 404);
  assert.equal(response.body.team, undefined);
});

for (const round of [1, 2]) {
  test(`Round ${round} team details remain available once Round 2 starts`, async () => {
    const response = await api({ activeRound: 2, detail: true }).get(`?round=${round}`, `r${round}-a`);
    assert.equal(response.status, 200);
    assert.equal(response.body.round, round);
    assert.equal(response.body.team.id, `r${round}-a`);
    assert.deepEqual(response.body.entries, []);
  });
}
