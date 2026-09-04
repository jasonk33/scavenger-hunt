import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Execute the real component and its handlers, but never import a live API client.
const compiled = ts.transpileModule(
  `${readFileSync(new URL("../src/app/admin/page.tsx", import.meta.url), "utf8")}\nexports.TaskEditor = TaskEditor;`,
  { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }
).outputText;

const task = (overrides = {}) => ({
  id: "task-r1",
  round: 1,
  title: "Original wording",
  points: 3,
  scoring_mode: "fixed",
  measurement_label: "extra shirt",
  points_per_unit: 2,
  competition_bonus: 5,
  winner_team_id: null,
  requires_video: false,
  is_secret: false,
  revealed_at: null,
  active: true,
  ...overrides,
});

function editor(initial = task()) {
  const state = [];
  const saved = [];
  let cancelled = 0;
  let cursor = 0;
  let current = initial;
  let tree;
  const exports = {};
  const jsx = (type, props) => ({ type, props });
  runInNewContext(compiled, {
    exports,
    require(name) {
      if (name === "react") return {
        useState(initialValue) {
          const slot = cursor++;
          if (!(slot in state)) {
            state[slot] = typeof initialValue === "function" ? initialValue() : initialValue;
          }
          return [state[slot], (value) => {
            state[slot] = typeof value === "function" ? value(state[slot]) : value;
          }];
        },
      };
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "fragment" };
      if (name === "@/lib/client") return {};
      throw new Error(`Unexpected import: ${name}`);
    },
  });
  const render = (next = current) => {
    current = next;
    cursor = 0;
    tree = exports.TaskEditor({
      task: current,
      onSave: (body) => saved.push(structuredClone(body)),
      onCancel: () => { cancelled++; },
      onDelete: () => { throw new Error("Unexpected delete"); },
    });
  };
  const find = (predicate) => {
    const visit = (node) => {
      if (!node || typeof node !== "object") return undefined;
      if (Array.isArray(node)) return node.map(visit).find(Boolean);
      return predicate(node) ? node : visit(node.props?.children);
    };
    const found = visit(tree);
    assert.ok(found, "control exists");
    return found;
  };
  const click = (label) => {
    const control = find((node) => node.type === "button" && node.props.children === label);
    assert.equal(Boolean(control.props.disabled), false, `${label} is enabled`);
    control.props.onClick();
    render();
  };
  const change = (predicate, value) => {
    find(predicate).props.onChange({ target: { value } });
    render();
  };
  render();
  return {
    saved,
    render,
    click,
    get cancelled() { return cancelled; },
    title: (value) => change((node) => node.type === "textarea", value),
    mode: (value) => change((node) => node.type === "select", value),
    input: (placeholder, value) => change(
      (node) => node.type === "input" && node.props.placeholder.startsWith(placeholder), value
    ),
  };
}

test("Admin title-only save preserves newer canvas fields, even after a poll", () => {
  const view = editor();
  view.title("New wording");
  view.render(task({
    points: 10,
    scoring_mode: "competition",
    winner_team_id: "team-r1",
    competition_bonus: 8,
    requires_video: true,
    is_secret: true,
    active: false,
  }));
  view.click("Save");
  assert.deepEqual(view.saved, [{ title: "New wording" }]);
});

for (const { name, initial, edit, expected } of [
  { name: "points", edit: (view) => view.click(7), expected: { points: 7 } },
  { name: "video-only", edit: (view) => view.click("video only"), expected: { requiresVideo: true } },
  { name: "secret", edit: (view) => view.click("secret"), expected: { isSecret: true } },
  { name: "scoring mode", edit: (view) => view.mode("competition"), expected: { scoringMode: "competition" } },
  {
    name: "unit label",
    initial: { scoring_mode: "quantity" },
    edit: (view) => view.input("One unit", "  extra pigeon  "),
    expected: { measurementLabel: "extra pigeon" },
  },
  {
    name: "points per item",
    initial: { scoring_mode: "quantity" },
    edit: (view) => view.input("Extra points per item", "0"),
    expected: { pointsPerUnit: 0 },
  },
  {
    name: "leader bonus",
    initial: { scoring_mode: "competition", winner_team_id: "team-r1" },
    edit: (view) => view.input("Leader bonus", "0"),
    expected: { competitionBonus: 0 },
  },
]) {
  test(`Admin ${name} save sends only that deliberately changed field`, () => {
    const view = editor(task(initial));
    edit(view);
    view.render(task({ ...initial, title: "Canvas wording" }));
    view.click("Save");
    assert.deepEqual(view.saved, [expected]);
  });
}

test("Admin no-op save closes without any write, even if the task changed remotely", () => {
  const view = editor();
  view.render(task({ title: "Canvas wording", points: 10, scoring_mode: "competition" }));
  view.click("Save");
  assert.deepEqual(view.saved, []);
  assert.equal(view.cancelled, 1);
});

test("Admin edits reverted to the opening values do not overwrite a poll", () => {
  const view = editor();
  view.title("Temporary wording");
  view.click("video only");
  view.mode("competition");
  view.render(task({ title: "Canvas wording", requires_video: true, scoring_mode: "quantity" }));
  view.title("Original wording");
  view.click("video only");
  view.mode("fixed");
  view.click("Save");
  assert.deepEqual(view.saved, []);
});

test("Admin whitespace-only changes are not writes", () => {
  const view = editor(task({ scoring_mode: "quantity" }));
  view.title("  Original wording  ");
  view.input("One unit", "  extra shirt  ");
  view.click("Save");
  assert.deepEqual(view.saved, []);
});

test("Admin can deliberately change several fields, including turning booleans off", () => {
  const view = editor(task({ requires_video: true, is_secret: true }));
  view.title("New wording");
  view.click(10);
  view.click("video only");
  view.click("secret");
  view.click("Save");
  assert.deepEqual(view.saved, [{
    title: "New wording",
    points: 10,
    requiresVideo: false,
    isSecret: false,
  }]);
});

test("Admin only sends a mode change away from competition when deliberately selected", () => {
  const view = editor(task({ scoring_mode: "competition", winner_team_id: "team-r1" }));
  view.mode("fixed");
  view.click("Save");
  assert.deepEqual(view.saved, [{ scoringMode: "fixed" }]);
});

test("Admin restore stays an explicit active-only action", () => {
  const view = editor(task({ active: false }));
  view.title("Unsaved wording");
  view.click("Restore");
  assert.deepEqual(view.saved, [{ active: true }]);
});

function taskApi(rows) {
  const writes = [];
  const exports = {};
  const code = ts.transpileModule(
    readFileSync(new URL("../src/app/api/admin/tasks/route.ts", import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS } }
  ).outputText;
  const db = () => ({
    from(table) {
      assert.ok(["tasks", "teams"].includes(table), `unexpected table ${table}`);
      const filters = [];
      let patch;
      const selected = () => (
        table === "tasks" ? rows : [{ id: "team-r1", round: 1 }, { id: "team-r2", round: 2 }]
      ).filter((row) => filters.every(([key, value]) => row[key] === value));
      const query = {
        select() { return query; },
        eq(key, value) { filters.push([key, value]); return query; },
        update(fields) { patch = structuredClone(fields); return query; },
        async maybeSingle() { return { data: structuredClone(selected()[0] ?? null) }; },
        then(resolve, reject) {
          const matches = selected();
          if (patch) {
            writes.push({ table, filters, patch });
            for (const row of matches) Object.assign(row, patch);
          }
          return Promise.resolve({ data: structuredClone(matches), count: matches.length }).then(resolve, reject);
        },
      };
      return query;
    },
  });
  runInNewContext(code, {
    exports,
    require(name) {
      if (name === "@/lib/db") return { db };
      if (name === "@/lib/settings") return { isOrganizer: async () => true };
      if (name === "@/lib/http") return {
        json: (body) => ({ body, status: 200 }),
        fail: (error, status = 400) => ({ body: { error }, status }),
      };
      throw new Error(`Unexpected import: ${name}`);
    },
  });
  return {
    writes,
    async patch(body) {
      const response = await exports.PATCH({ json: async () => body });
      assert.equal(response.status, 200, JSON.stringify(response.body));
    },
  };
}

const secrets = (overrides = {}) => [1, 2].map((round) => task({
  id: `task-r${round}`,
  round,
  slug: "secret-both",
  is_secret: true,
  scoring_mode: "competition",
  winner_team_id: `team-r${round}`,
  revealed_at: round === 1 ? "2026-09-04T12:00:00Z" : null,
  ...overrides,
}));

test("Admin title-only save through the real route preserves both winners and per-round reveals", async () => {
  const view = editor(secrets({ scoring_mode: "fixed", winner_team_id: null })[0]);
  const rows = secrets({ points: 10, competition_bonus: 8 });
  const before = structuredClone(rows);
  const api = taskApi(rows);
  view.title("New shared wording");
  view.render(structuredClone(rows[0]));
  view.click("Save");
  for (const body of view.saved) await api.patch({ id: "task-r1", ...body });
  assert.equal(api.writes.length, 1);
  assert.deepEqual(api.writes[0].filters, [["slug", "secret-both"]]);
  assert.deepEqual(Object.keys(api.writes[0].patch).sort(), ["title", "updated_at"]);
  assert.deepEqual(rows, before.map((row, index) => ({
    ...row,
    title: "New shared wording",
    updated_at: rows[index].updated_at,
  })));
});

test("a deliberate mode change through the real route clears both secret winners only", async () => {
  const rows = secrets();
  const view = editor(structuredClone(rows[0]));
  const api = taskApi(rows);
  view.mode("fixed");
  view.click("Save");
  for (const body of view.saved) await api.patch({ id: "task-r1", ...body });
  assert.equal(api.writes.length, 1);
  assert.deepEqual(api.writes[0].filters, [["slug", "secret-both"]]);
  assert.ok(rows.every((row) => row.scoring_mode === "fixed" && row.winner_team_id === null));
  assert.deepEqual(rows.map((row) => row.revealed_at), ["2026-09-04T12:00:00Z", null]);
});

test("the existing reveal and winner actions still target only the selected round", async () => {
  const rows = secrets({ revealed_at: null, winner_team_id: null });
  const api = taskApi(rows);
  await api.patch({ id: "task-r1", revealed: true });
  await api.patch({ id: "task-r2", winnerTeamId: "team-r2" });
  assert.deepEqual(api.writes.map((write) => write.filters), [
    [["id", "task-r1"]],
    [["id", "task-r2"]],
  ]);
  assert.ok(rows[0].revealed_at);
  assert.equal(rows[1].revealed_at, null);
  assert.deepEqual(rows.map((row) => row.winner_team_id), [null, "team-r2"]);
});
