import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const TEAMS = [
  { id: "red-1", round: 1, name: "Red", color: "#dc2626" },
  { id: "blue-1", round: 1, name: "Blue", color: "#2563eb" },
  { id: "red-2", round: 2, name: "Red", color: "#dc2626" },
  { id: "blue-2", round: 2, name: "Blue", color: "#2563eb" },
];

function routeApi(route, teams = TEAMS) {
  const state = {
    teams: structuredClone(teams),
    roster: [
      { round: 1, player_id: "alex", team_id: "red-1" },
      { round: 1, player_id: "bea", team_id: "blue-1" },
      { round: 2, player_id: "alex", team_id: "blue-2" },
      { round: 2, player_id: "bea", team_id: "red-2" },
    ],
  };
  const writes = [];
  const exports = {};
  const code = ts.transpileModule(
    readFileSync(new URL(`../src/app/api/admin/${route}/route.ts`, import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS } }
  ).outputText;
  runInNewContext(code, {
    exports,
    require(name) {
      if (name === "@/lib/settings") return { isOrganizer: async () => true };
      if (name === "@/lib/http") return {
        json: (body) => ({ status: 200, body }),
        fail: (error, status = 400) => ({ status, body: { error } }),
      };
      if (name === "@/lib/db") return { db: () => ({
        from(table) {
          assert.ok(["teams", "roster"].includes(table));
          const filters = [];
          let patch;
          let rows;
          const selected = () => state[table].filter((row) => filters.every((filter) => filter(row)));
          const query = {
            select() { return query; },
            eq(key, value) { filters.push((row) => row[key] === value); return query; },
            in(key, values) { filters.push((row) => values.includes(row[key])); return query; },
            update(value) { patch = structuredClone(value); return query; },
            upsert(value) { rows = structuredClone(value); return query; },
            async maybeSingle() { return { data: structuredClone(selected()[0] ?? null) }; },
            then(resolve, reject) {
              const matches = selected();
              if (patch) {
                writes.push({ table, patch });
                for (const row of matches) Object.assign(row, patch);
              }
              if (rows) {
                writes.push({ table, rows });
                for (const row of rows) {
                  const previous = state[table].find((r) => r.round === row.round && r.player_id === row.player_id);
                  if (previous) Object.assign(previous, row);
                  else state[table].push(row);
                }
              }
              return Promise.resolve({ data: structuredClone(matches) }).then(resolve, reject);
            },
          };
          return query;
        },
      }) };
      throw new Error(`Unexpected import: ${name}`);
    },
  });
  return { state, writes, request: (method, body) => exports[method]({ json: async () => body }) };
}

for (const patch of [{ name: "Pigeon Patrol" }, { color: "#123456" }, { name: "Pigeon Patrol", color: "#123456" }]) {
  test(`Admin team ${Object.keys(patch).join("/")} edit preserves the other round's identity`, async () => {
    const api = routeApi("teams");
    const response = await api.request("PATCH", { id: "red-1", ...patch });
    assert.equal(response.status, 200);
    assert.equal(response.body.updated, 1);
    assert.deepEqual(api.state.teams, TEAMS.map((team) => team.id === "red-1" ? { ...team, ...patch } : team));
    assert.deepEqual(api.writes, [{ table: "teams", patch }]);
  });
}

test("Admin copying still works when all assigned teams have matching names", async () => {
  const api = routeApi("roster");
  const response = await api.request("PUT", { from: 1, to: 2 });
  assert.equal(response.status, 200);
  assert.equal(response.body.copied, 2);
  assert.deepEqual(api.state.roster.filter((row) => row.round === 2), [
    { round: 2, player_id: "alex", team_id: "red-2" },
    { round: 2, player_id: "bea", team_id: "blue-2" },
  ]);
});

for (const unmatched of [["red-2"], ["red-2", "blue-2"]]) {
  test(`Admin refuses a roster copy with ${unmatched.length} unmatched names before any write`, async () => {
    const api = routeApi("roster", TEAMS.map((team) =>
      unmatched.includes(team.id) ? { ...team, name: `${team.name} remixed` } : team
    ));
    const before = structuredClone(api.state.roster);
    const response = await api.request("PUT", { from: 1, to: 2 });
    assert.equal(response.status, 409);
    assert.match(response.body.error, /matching team names/);
    assert.deepEqual(api.state.roster, before);
    assert.deepEqual(api.writes, []);
  });
}
