import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("./roster.js", import.meta.url), "utf8");

class Element {
  children = [];
  events = new Map();
  value = "";
  classList = { toggle() {} };
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute() {}
  querySelectorAll() { return []; }
  addEventListener(name, callback) { this.events.set(name, callback); }
  fire(name, event = {}) { this.events.get(name)?.(event); }
}

// Fake only the browser and HTTP boundary; renderTeams and its callbacks run unchanged.
async function rosterView() {
  const elements = new Map();
  const timers = new Map();
  const writes = [];
  let timerId = 0;
  let failNext = false;
  const state = {
    players: [],
    roster: [],
    teams: [
      { id: "team-r1", round: 1, name: "Red", color: "#dc2626", sort_order: 1 },
      { id: "team-r2", round: 2, name: "Red", color: "#dc2626", sort_order: 1 },
    ],
  };
  const api = await runInNewContext(`(async () => {
    ${source}
    return { refreshRoster, settled: () => actionChain };
  })()`, {
    document: {
      hidden: false,
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, new Element());
        return elements.get(id);
      },
      createElement: () => new Element(),
      addEventListener() {},
    },
    window: { addEventListener() {} },
    setTimeout(callback, delay) {
      timers.set(++timerId, { callback, delay });
      return timerId;
    },
    clearTimeout: (id) => timers.delete(id),
    fetch: async (path, init) => {
      if (init.method === "PATCH") {
        assert.equal(path, "/api/roster/teams");
        const patch = JSON.parse(init.body);
        writes.push(patch);
        if (failNext) {
          failNext = false;
          return { ok: false, status: 500, json: async () => ({ error: "try again" }) };
        }
        const name = state.teams.find((team) => team.id === patch.id).name;
        const fields = { ...patch };
        delete fields.id;
        for (const team of state.teams.filter((team) => team.name === name)) {
          Object.assign(team, fields);
        }
      } else {
        assert.equal(path, "/api/roster");
        assert.equal(init.method, "GET");
      }
      return { ok: true, status: 200, json: async () => structuredClone(state) };
    },
  });
  const controls = () => {
    const [color, name] = elements.get("team-list").children[0].children;
    return { color, name };
  };
  return {
    writes,
    state,
    controls,
    edit(field, value) {
      const input = controls()[field];
      input.value = value;
      input.fire("input");
    },
    remote(patch) {
      for (const team of state.teams) Object.assign(team, patch);
    },
    poll: () => api.refreshRoster(),
    failNext() { failNext = true; },
    async blur(field) {
      controls()[field].fire("blur");
      await api.settled();
    },
    async debounce() {
      for (const [id, timer] of [...timers]) {
        if (timer.delay !== 400) continue;
        timers.delete(id);
        timer.callback();
      }
      await api.settled();
    },
  };
}

for (const poll of [false, true]) {
  test(`roster name-only edit preserves another session's colour${poll ? " after a poll" : ""}`, async () => {
    const view = await rosterView();
    view.edit("name", "  Crimson  ");
    view.remote({ color: "#123456" });
    if (poll) await view.poll();
    await view.blur("name");
    assert.deepEqual(view.writes, [{ id: "team-r1", name: "Crimson" }]);
    assert.ok(view.state.teams.every((team) => team.color === "#123456"));
  });

  test(`roster colour-only edit preserves another session's name${poll ? " after a poll" : ""}`, async () => {
    const view = await rosterView();
    view.edit("color", "#123456");
    view.remote({ name: "Crimson" });
    if (poll) await view.poll();
    await view.blur("color");
    assert.deepEqual(view.writes, [{ id: "team-r1", color: "#123456" }]);
    assert.ok(view.state.teams.every((team) => team.name === "Crimson"));
  });
}

test("roster combined edits remain a single paired-team request", async () => {
  const view = await rosterView();
  view.edit("name", "Crimson");
  view.edit("color", "#123456");
  await view.blur("name");
  assert.deepEqual(view.writes, [{ id: "team-r1", name: "Crimson", color: "#123456" }]);
});

test("roster untouched and whitespace-only blur do not write", async () => {
  const view = await rosterView();
  await view.blur("name");
  view.edit("name", "  Red  ");
  await view.blur("name");
  assert.deepEqual(view.writes, []);
});

test("roster reverting a draft to its baseline does not overwrite newer fields", async () => {
  const view = await rosterView();
  view.edit("name", "Temporary name");
  view.edit("color", "#123456");
  view.remote({ name: "Crimson", color: "#654321" });
  await view.poll();
  view.edit("name", "Red");
  view.edit("color", "#dc2626");
  await view.blur("name");
  assert.deepEqual(view.writes, []);
});

test("roster failed saves retain the original baseline for a retry after polling", async () => {
  const view = await rosterView();
  view.edit("name", "Crimson");
  view.failNext();
  await view.blur("name");
  view.remote({ color: "#123456" });
  await view.poll();
  await view.blur("name");
  assert.deepEqual(view.writes, [
    { id: "team-r1", name: "Crimson" },
    { id: "team-r1", name: "Crimson" },
  ]);
  assert.ok(view.state.teams.every((team) => team.color === "#123456"));
});

test("roster debounce retains its baseline when a poll rebuilds the row", async () => {
  const view = await rosterView();
  view.edit("color", "#123456");
  view.remote({ name: "Crimson" });
  await view.poll();
  await view.debounce();
  assert.deepEqual(view.writes, [{ id: "team-r1", color: "#123456" }]);
  assert.equal(view.controls().name.value, "Crimson", "successful save clears its stale draft");
});

test("roster a second edit after saving starts from the new baseline", async () => {
  const view = await rosterView();
  view.edit("name", "Crimson");
  await view.blur("name");
  view.remote({ name: "Scarlet" });
  view.edit("color", "#123456");
  await view.blur("color");
  assert.deepEqual(view.writes, [
    { id: "team-r1", name: "Crimson" },
    { id: "team-r1", color: "#123456" },
  ]);
});

test("roster Escape after a poll cancels the whole edit without a later blur writing", async () => {
  const view = await rosterView();
  view.edit("name", "Temporary name");
  view.remote({ color: "#123456" });
  await view.poll();
  view.controls().name.fire("keydown", { key: "Escape" });
  await view.blur("name");
  assert.deepEqual(view.writes, []);
});

test("roster an empty name does not turn a later blur into an unintended rename", async () => {
  const view = await rosterView();
  view.edit("name", "");
  view.remote({ name: "Crimson" });
  await view.poll();
  await view.blur("name");
  await view.blur("color");
  assert.deepEqual(view.writes, []);
});

test("roster ending a reverted draft adopts the latest row as its next baseline", async () => {
  const view = await rosterView();
  view.edit("name", "Temporary name");
  view.remote({ name: "Crimson", color: "#123456" });
  await view.poll();
  view.edit("name", "Red");
  await view.blur("name");
  assert.equal(view.controls().name.value, "Crimson");
  assert.equal(view.controls().color.value, "#123456");
  view.remote({ color: "#654321" });
  view.edit("name", "Scarlet");
  await view.blur("name");
  assert.deepEqual(view.writes, [{ id: "team-r1", name: "Scarlet" }]);
});
