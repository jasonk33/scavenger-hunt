/**
 * The roster query layer, proved against a fake PostgREST client.
 *
 * The canvas shares the live event database with Admin, so these tests must never
 * use the real Supabase project. The fake records requests and applies just
 * enough table behaviour to prove the writes are scoped and paired correctly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createTaskClient } from "../../../scripts/task-store.mjs";
import {
  addPlayers,
  addTeam,
  assignRoster,
  copyRoster,
  deletePlayer,
  deleteTeam,
  loadRoster,
  normalizeNames,
  updatePlayer,
  updateTeam,
} from "./roster-store.mjs";

const PLAYERS = [
  { id: "p-1", name: "Alex" },
  { id: "p-2", name: "Bea" },
];
const TEAMS = [
  { id: "t-1a", round: 1, name: "Red", color: "#dc2626", sort_order: 10 },
  { id: "t-2a", round: 1, name: "Blue", color: "#2563eb", sort_order: 20 },
  { id: "t-1b", round: 2, name: "Red", color: "#dc2626", sort_order: 10 },
  { id: "t-2b", round: 2, name: "Blue", color: "#2563eb", sort_order: 20 },
];

function fakeDb({ players = PLAYERS, teams = TEAMS, roster = [], submissions = [] } = {}) {
  const calls = [];
  const state = {
    players: players.map((p) => ({ ...p })),
    teams: teams.map((t) => ({ ...t })),
    roster: roster.map((r) => ({ ...r })),
    submissions: submissions.map((s) => ({ ...s })),
  };

  const values = (url, key) => {
    const parsed = new URL(url);
    const raw = parsed.searchParams.get(key);
    if (!raw) return null;
    if (raw.startsWith("eq.")) return { type: "eq", value: decodeURIComponent(raw.slice(3)) };
    if (raw.startsWith("in.(") && raw.endsWith(")")) {
      return { type: "in", value: raw.slice(4, -1).split(",").map(decodeURIComponent) };
    }
    return null;
  };

  const selected = (table, url) =>
    state[table].filter((row) =>
      Object.keys(row).every((key) => {
        const filter = values(url, key);
        return !filter || (filter.type === "eq" ? String(row[key]) === filter.value : filter.value.includes(String(row[key])));
      })
    );

  const respond = (url, init) => {
    const method = init.method ?? "GET";
    const table = url.split("/rest/v1/")[1].split("?")[0];
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, table, url, body, headers: init.headers });

    if (method === "GET") {
      let rows = selected(table, url).map((row) => ({ ...row }));
      const parsed = new URL(url);
      const order = parsed.searchParams.get("order");
      if (order?.startsWith("sort_order.desc")) rows.sort((a, b) => b.sort_order - a.sort_order);
      if (order?.startsWith("name.asc")) rows.sort((a, b) => a.name.localeCompare(b.name));
      if (parsed.searchParams.has("limit")) rows = rows.slice(0, Number(parsed.searchParams.get("limit")));
      return { status: 200, text: JSON.stringify(rows) };
    }

    if (method === "POST") {
      for (const row of Array.isArray(body) ? body : [body]) {
        if (table === "players") {
          if (!state.players.some((p) => p.name === row.name)) {
            state.players.push({ id: `p-${state.players.length + 1}`, ...row });
          }
        } else if (table === "teams") {
          if (!state.teams.some((t) => t.round === row.round && t.name === row.name)) {
            state.teams.push({ id: `t-${state.teams.length + 1}`, ...row });
          }
        } else if (table === "roster") {
          const existing = state.roster.find((r) => r.round === row.round && r.player_id === row.player_id);
          if (existing) Object.assign(existing, row);
          else state.roster.push({ ...row });
        }
      }
      return { status: 201, text: JSON.stringify(Array.isArray(body) ? body : [body]) };
    }

    const matches = selected(table, url);
    if (method === "PATCH") {
      for (const row of matches) Object.assign(row, body);
      return { status: 200, text: JSON.stringify(matches) };
    }
    if (method === "DELETE") {
      for (const row of matches) {
        const index = state[table].indexOf(row);
        if (index >= 0) state[table].splice(index, 1);
      }
      if (table === "teams") {
        const ids = new Set(matches.map((t) => t.id));
        state.roster = state.roster.filter((r) => !ids.has(r.team_id));
      }
      return { status: 204, text: "" };
    }

    return { status: 405, text: JSON.stringify({ message: "method not allowed" }) };
  };

  const fetchImpl = async (url, init = {}) => {
    const response = respond(url, init);
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      text: async () => response.text,
    };
  };

  const db = createTaskClient(
    { SUPABASE_URL: "https://fake.test", SUPABASE_SERVICE_ROLE_KEY: "service-role" },
    fetchImpl
  );
  db.calls = calls;
  db.state = state;
  return db;
}

test("normalizeNames handles a pasted guest list and removes duplicates", () => {
  assert.deepEqual(normalizeNames(" Alex \nBea, Alex\n\nBea "), ["Alex", "Bea"]);
  assert.deepEqual(normalizeNames(["Alex", null, undefined, " Bea "]), ["Alex", "Bea"]);
});

test("loadRoster reads explicit player, team and assignment columns", async () => {
  const db = fakeDb({ roster: [{ round: 1, player_id: "p-1", team_id: "t-1a" }] });
  const data = await loadRoster(db);
  assert.deepEqual(data.players, PLAYERS);
  assert.deepEqual(data.teams, TEAMS);
  assert.deepEqual(data.roster, [{ round: 1, player_id: "p-1", team_id: "t-1a" }]);
  for (const call of db.calls) {
    assert.match(call.url, /select=/);
    assert.equal(call.headers.apikey, "service-role");
    assert.match(call.headers.Authorization, /^Bearer /);
  }
});

test("adding players uses ignore-duplicates and sends only names", async () => {
  const db = fakeDb();
  const result = await addPlayers(db, "Alex\nCara");
  assert.deepEqual(result, { added: 2 });
  const write = db.calls.find((call) => call.table === "players" && call.method === "POST");
  assert.deepEqual(write.body, [{ name: "Alex" }, { name: "Cara" }]);
  assert.match(write.headers.Prefer, /ignore-duplicates/);
});

test("renaming a player is scoped to one id", async () => {
  const db = fakeDb();
  await updatePlayer(db, "p-1", "  Alex Prime  ");
  const write = db.calls.find((call) => call.table === "players" && call.method === "PATCH");
  assert.match(write.url, /id=eq\.p-1/);
  assert.deepEqual(write.body, { name: "Alex Prime" });
});

test("a player with submissions cannot be deleted", async () => {
  const db = fakeDb({ submissions: [{ id: "s-1", player_id: "p-1" }] });
  await assert.rejects(() => deletePlayer(db, "p-1"), /has 1 submission/);
  assert.equal(db.calls.some((call) => call.table === "players" && call.method === "DELETE"), false);
});

test("adding a team creates paired rows with one sort position", async () => {
  const db = fakeDb();
  await addTeam(db, { name: " Green ", color: "#16a34a" });
  const write = db.calls.find((call) => call.table === "teams" && call.method === "POST");
  assert.deepEqual(write.body, [
    { round: 1, name: "Green", color: "#16a34a", sort_order: 30 },
    { round: 2, name: "Green", color: "#16a34a", sort_order: 30 },
  ]);
});

test("renaming or recolouring a team updates both round rows in one scoped write", async () => {
  const db = fakeDb();
  await updateTeam(db, "t-1a", { name: "Crimson", color: "#b91c1c" });
  const writes = db.calls.filter((call) => call.table === "teams" && call.method === "PATCH");
  assert.equal(writes.length, 1);
  assert.match(writes[0].url, /id=in\.\(/);
  assert.deepEqual(writes[0].body, { name: "Crimson", color: "#b91c1c" });
});

test("a team with submissions cannot be deleted", async () => {
  const db = fakeDb({ submissions: [{ id: "s-1", team_id: "t-1a" }] });
  await assert.rejects(() => deleteTeam(db, "t-1a"), /has 1 submission/);
  assert.equal(db.calls.some((call) => call.table === "teams" && call.method === "DELETE"), false);
});

test("deleting a team removes both round rows and reports unassigned members", async () => {
  const db = fakeDb({
    roster: [
      { round: 1, player_id: "p-1", team_id: "t-1a" },
      { round: 2, player_id: "p-2", team_id: "t-1b" },
    ],
  });
  const result = await deleteTeam(db, "t-1a");
  assert.deepEqual(result, { ok: true, deleted: 2, unassigned: 2 });
  const write = db.calls.find((call) => call.table === "teams" && call.method === "DELETE");
  assert.match(write.url, /id=in\.\(t-1a,t-1b\)/);
  assert.equal(db.state.teams.some((team) => team.name === "Red"), false);
});

test("assigning validates the round before upserting roster rows", async () => {
  const db = fakeDb();
  await assignRoster(db, 1, [
    { playerId: "p-1", teamId: "t-1a" },
    { playerId: "p-2", teamId: null },
  ]);
  const write = db.calls.find((call) => call.table === "roster" && call.method === "POST");
  assert.deepEqual(write.body, [{ round: 1, player_id: "p-1", team_id: "t-1a" }]);
  const clear = db.calls.find((call) => call.table === "roster" && call.method === "DELETE");
  assert.match(clear.url, /player_id=in\.\(p-2\)/);
});

test("duplicate player entries collapse to the last assignment", async () => {
  const db = fakeDb();
  await assignRoster(db, 1, [
    { playerId: "p-1", teamId: "t-1a" },
    { playerId: "p-1", teamId: "t-2a" },
  ]);
  const write = db.calls.find((call) => call.table === "roster" && call.method === "POST");
  assert.deepEqual(write.body, [{ round: 1, player_id: "p-1", team_id: "t-2a" }]);
});

test("assigning to a team from the other round is refused before a write", async () => {
  const db = fakeDb();
  await assert.rejects(() => assignRoster(db, 1, [{ playerId: "p-1", teamId: "t-1b" }]), /do not belong to Round 1/);
  assert.equal(db.calls.some((call) => call.table === "roster" && call.method !== "GET"), false);
});

test("copying a roster maps paired teams by name", async () => {
  const db = fakeDb({
    roster: [
      { round: 1, player_id: "p-1", team_id: "t-1a" },
      { round: 1, player_id: "p-2", team_id: "t-2a" },
    ],
  });
  const result = await copyRoster(db, 1, 2);
  assert.equal(result.copied, 2);
  const write = db.calls.find((call) => call.table === "roster" && call.method === "POST");
  assert.deepEqual(write.body, [
    { round: 2, player_id: "p-1", team_id: "t-1b" },
    { round: 2, player_id: "p-2", team_id: "t-2b" },
  ]);
});
