import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("./ui.js", import.meta.url), "utf8");
const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("./ui.css", import.meta.url), "utf8");

class Element {
  children = [];
  events = new Map();
  value = "";
  hidden = false;
  textContent = "";
  classList = { toggle() {} };
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute() {}
  querySelectorAll() { return []; }
  addEventListener(name, callback) { this.events.set(name, callback); }
  fire(name, event = {}) { return this.events.get(name)?.(event); }
}

// The real renderer runs with an empty list and an HTTP-only fake. No browser,
// server, credentials or live database can be reached.
async function planner({ initialFailure = false } = {}) {
  const elements = new Map();
  for (const match of html.matchAll(/\bid="([^"]+)"/g)) elements.set(match[1], new Element());
  elements.get("balance").hidden = true;
  elements.get("new-task-scoring-mode").value = "fixed";
  elements.get("new-task-round").value = "1";
  elements.get("new-task-points").value = "3";
  const calls = [];
  let failNext = false;
  let release = null;
  const api = await runInNewContext(`(async () => {
    ${source}
    return { queueSave, flushSave, unsaved, refreshTasks, paint, renderBalance,
      pending, data, filters, visibleTasks };
  })()`, {
    document: {
      hidden: false,
      getElementById(id) {
        assert.ok(elements.has(id), `renderer requests missing element #${id}`);
        return elements.get(id);
      },
      createElement: () => new Element(),
      addEventListener() {},
    },
    window: { addEventListener() {} },
    EventSource: class { addEventListener() {} },
    setTimeout: () => 1,
    clearTimeout() {},
    fetch: async (path, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ path, body });
      if (init.method === "PATCH") {
        if (release) await new Promise((resolve) => { release.resolve = resolve; });
        if (failNext) {
          failNext = false;
          return { ok: false, status: 500, json: async () => ({ error: "try again" }) };
        }
        return { ok: true, status: 200, json: async () => ({ slug: path.split("/").at(-1), ...body }) };
      }
      assert.equal(path, "/api/tasks");
      if (initialFailure) {
        initialFailure = false;
        throw new Error("offline");
      }
      return { ok: true, status: 200, json: async () => ({ tasks: [] }) };
    },
  });
  return {
    ...api, elements, calls,
    failNext() { failNext = true; },
    holdNext() {
      const held = {};
      release = held;
      return () => { release = null; held.resolve(); };
    },
  };
}

test("the canvas has no retired task controls, scripts or styles", () => {
  for (const retired of [
    /tier\.mjs/, /api\/model/, /suggestedPoints|tierOk|tier-dismiss/,
    /requiresVideo|requires-video|video.only/i,
    /competition|leader.bonus/i, /secret|round-both|data-round="0"/i,
    /difficulty|guts|payoff|risk|luck|rating|sliders/i,
  ]) {
    for (const text of [source, html, css]) assert.doesNotMatch(text, retired);
  }
});

test("the simplified canvas boots with no model and retains quantity details", async () => {
  const view = await planner();
  assert.match(view.elements.get("stats").innerHTML, /0<\/b> live/);
  const mode = view.elements.get("new-task-scoring-mode");
  const unit = view.elements.get("new-task-measurement-label-field");
  const rate = view.elements.get("new-task-points-per-unit-field");
  assert.ok(unit.hidden && rate.hidden);
  mode.value = "quantity";
  mode.fire("change");
  assert.equal(unit.hidden, false);
  assert.equal(rate.hidden, false);
  assert.equal(view.elements.get("new-task-details").open, true);
  mode.value = "fixed";
  mode.fire("change");
  assert.ok(unit.hidden && rate.hidden);
  assert.match(css, /\.field\[hidden\]\s*\{\s*display:\s*none/);
  assert.ok(view.calls.every((call) => call.path === "/api/tasks"));
});

test("an unavailable first read is never rendered as an empty result", async () => {
  const view = await planner({ initialFailure: true });
  const list = view.elements.get("list");
  assert.match(list.children[0].textContent, /could not be read.*offline/);
  assert.doesNotMatch(list.children[0].textContent, /Nothing matches/);
  await view.refreshTasks();
  assert.match(list.innerHTML, /Nothing matches/);
});

test("per-field saves coalesce without requiring a model", async () => {
  const view = await planner();
  view.queueSave("r1-01", { note: "draft" });
  view.queueSave("r1-01", { note: "final", prop: "hat" });
  await view.flushSave("r1-01");
  assert.deepEqual(view.calls.at(-1), { path: "/api/task/r1-01", body: { note: "final", prop: "hat" } });
  assert.equal(view.pending.size, 0);
});

test("failed saves retain drafts through polls and retries without copying other fields", async () => {
  const view = await planner();
  view.queueSave("r1-01", { note: "draft" });
  view.failNext();
  await view.flushSave("r1-01");
  await view.refreshTasks();
  assert.equal(view.unsaved("r1-01").note, "draft");
  assert.match(view.elements.get("save-status").children[0].textContent, /Not saved.*try again/);
  await view.flushSave("r1-01");
  assert.deepEqual(view.calls.filter((call) => call.path === "/api/task/r1-01").map((call) => call.body),
    [{ note: "draft" }, { note: "draft" }]);
  assert.equal(view.pending.size, 0);
});

test("an in-flight save cannot overwrite a newer edit when it fails", async () => {
  const view = await planner();
  view.queueSave("r1-01", { note: "old", prop: "hat" });
  const release = view.holdNext();
  const flushing = view.flushSave("r1-01");
  view.queueSave("r1-01", { note: "new" });
  view.failNext();
  release();
  await flushing;
  assert.equal(view.unsaved("r1-01").note, "new");
  assert.equal(view.unsaved("r1-01").prop, "hat");
  await view.flushSave("r1-01");
  assert.deepEqual(view.calls.at(-1).body, { note: "new", prop: "hat" });
  assert.equal(view.pending.size, 0);
});

test("row editors retain point values, round controls and quantity-only fields", async () => {
  const view = await planner();
  const nodes = new Map();
  for (const match of html.matchAll(/\bclass="([^"]+)"/g)) {
    for (const name of match[1].split(" ")) nodes.set(`.${name}`, new Element());
  }
  const quantityFields = [new Element(), new Element()];
  const rounds = [1, 2].map((round) => Object.assign(new Element(), { dataset: { round: String(round) } }));
  const row = {
    classList: { toggle() {} },
    querySelector(selector) {
      assert.ok(nodes.has(selector), `row asks for missing selector ${selector}`);
      return nodes.get(selector);
    },
    querySelectorAll(selector) {
      if (selector === ".quantity-field") return quantityFields;
      if (selector === ".seg.round button[data-round]") return rounds;
      return [];
    },
  };
  const task = { slug: "r1-01", round: 2, title: "Keep this wording", points: 7, scoringMode: "fixed", prop: "", note: "" };
  view.paint(row, task);
  assert.ok(quantityFields.every((field) => field.hidden));
  assert.equal(nodes.get(".points").value, "7");
  assert.equal(nodes.get(".title").textContent, task.title);
  assert.ok(rounds.every((button) => !button.hidden && !button.disabled));
  view.paint(row, { ...task, scoringMode: "quantity", measurementLabel: "extra hat", pointsPerUnit: 2 });
  assert.ok(quantityFields.every((field) => !field.hidden));
  assert.equal(nodes.get(".measurement-label").value, "extra hat");
  assert.equal(nodes.get(".points-per-unit").value, "2");
});

test("ordinary point ordering and balance include seven-point tasks without special treatment", async () => {
  const view = await planner();
  view.data.tasks = [
    { slug: "r2-01", round: 2, points: 3, docOrder: 1, active: true },
    { slug: "r1-02", round: 1, points: 7, docOrder: 2, active: true, prop: "hat" },
    { slug: "r1-01", round: 1, points: 3, docOrder: 1, active: true },
    { slug: "r1-03", round: 1, points: 10, docOrder: 3, active: false },
  ];
  assert.deepEqual(Array.from(view.visibleTasks(), (task) => task.slug), ["r1-01", "r1-02", "r2-01"]);
  view.renderBalance();
  const balance = view.elements.get("balance").innerHTML;
  assert.match(balance, /<th>7<\/th>/);
  assert.match(balance, /<td>R1<\/td>[\s\S]*?<td>10<\/td>/);
  assert.doesNotMatch(balance, /model|rating|suggestion/i);
});
