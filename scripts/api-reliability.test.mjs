import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { runInNewContext } from "node:vm";
import { createClient } from "@supabase/supabase-js";
import ts from "typescript";
import * as scoring from "../src/lib/scoring.mjs";
import * as entries from "../src/lib/scored-entries.mjs";

const env = {
  SUPABASE_URL: "https://offline-fixture.supabase.test",
  SUPABASE_SERVICE_ROLE_KEY: "offline-fixture-only",
};
function compile(relative, imports = {}, globals = {}) {
  const exports = {};
  const code = ts.transpileModule(readFileSync(new URL(`../${relative}`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(code, {
    exports, URL, Response, Request, process: { env }, Date, ...globals,
    require(name) {
      assert.ok(Object.hasOwn(imports, name), `Unexpected import from ${relative}: ${name}`);
      return imports[name];
    },
  });
  return exports;
}
const http = compile("src/lib/http.ts");
const groups = compile("src/lib/groups.ts");
const event = compile("src/lib/event.ts");
const team = { id: "00000000-0000-0000-0000-000000000001", round: 1, name: "__qa Red", color: "#ff0000", sort_order: 1 };
const player = { id: "00000000-0000-0000-0000-000000000002", name: "__qa Example Guest" };
const task = {
  id: "00000000-0000-0000-0000-000000000003", round: 1, slug: "r1-example",
  title: "__qa Example task", points: 5, scoring_mode: "fixed", measurement_label: "",
  points_per_unit: 0, competition_bonus: 0, winner_team_id: null, active: true,
  is_secret: false, revealed_at: null, requires_video: false, sort_order: 1, doc_order: 1,
};
const submission = {
  id: "00000000-0000-0000-0000-000000000004", round: 1,
  player_id: player.id, team_id: team.id, task_id: task.id,
  task_points: 5, scoring_mode_snapshot: "fixed", points_per_unit_snapshot: 0,
  competition_bonus_snapshot: 0, measurement_value: null, group_id: null, note: null,
  status: "approved", points_awarded: 5, reject_reason: null, object_name: "example.jpg",
  media_type: "image/jpeg", size_bytes: 1,
  created_at: "2026-09-11T13:00:00.000Z", judged_at: "2026-09-11T13:01:00.000Z",
};
const settings = { active_round: 1, started_round: 1, submissions_open: true, saved_epoch: "" };

function fixture(overrides = {}, fail = () => false, { omitCounts = false } = {}) {
  const tables = structuredClone({
    tasks: [task], teams: [team], players: [player],
    roster: [{ round: 1, player_id: player.id, team_id: team.id }],
    submissions: [submission], team_scores: [],
    ...overrides,
  });
  const calls = [];
  let clock = Date.parse("2026-09-11T14:00:00Z");
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [clock++])); }
  }
  // The installed client uses only this in-memory transport. No credentials,
  // environment files, network requests or real database are reachable.
  const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      fetch: async (input, init) => {
        const url = new URL(input);
        assert.equal(url.origin, env.SUPABASE_URL);
        assert.ok(url.pathname.startsWith("/rest/v1/"));
        const table = url.pathname.slice("/rest/v1/".length);
        assert.ok(Object.hasOwn(tables, table), `Unexpected table ${table}`);
        const method = init.method;
        const call = { table, method, params: Object.fromEntries(url.searchParams), body: init.body ? JSON.parse(init.body) : null };
        calls.push(call);
        if (fail(call)) {
          return new Response(method === "HEAD" ? null : JSON.stringify({
            code: "57014", message: "Fixture database is temporarily unavailable",
          }), { status: 503, headers: { "content-type": "application/json", "retry-after": "0" } });
        }
        const matching = (row) => [...url.searchParams].every(([key, value]) => {
          if (["select", "order", "limit", "offset"].includes(key)) return true;
          if (value.startsWith("eq.")) return String(row[key]) === value.slice(3);
          if (value.startsWith("is.")) return String(row[key]) === value.slice(3);
          if (value.startsWith("in.(")) return value.slice(4, -1).split(",").map((s) => s.replace(/^"|"$/g, "")).includes(String(row[key]));
          throw new Error(`Unsupported filter ${key}=${value}`);
        });
        let selected = tables[table].filter(matching);
        if (method === "POST") {
          const row = {
            id: randomUUID(), created_at: new Clock().toISOString(),
            judged_at: null, measurement_value: null, points_awarded: null,
            reject_reason: null, size_bytes: null, ...call.body,
          };
          tables[table].push(row);
          selected = [row];
        } else if (method === "PATCH") {
          for (const row of selected) Object.assign(row, call.body);
        } else if (method === "DELETE") {
          tables[table] = tables[table].filter((row) => !selected.includes(row));
        } else assert.ok(["HEAD", "GET"].includes(method));
        if (method === "HEAD") return new Response(null, {
          headers: omitCounts ? {} : { "content-range": `0-0/${selected.length}` },
        });
        for (const order of (url.searchParams.get("order") ?? "").split(",").reverse().filter(Boolean)) {
          const [key, direction] = order.split(".");
          selected.sort((a, b) => String(a[key]).localeCompare(String(b[key])) * (direction === "desc" ? -1 : 1));
        }
        if (url.searchParams.has("limit")) selected = selected.slice(0, Number(url.searchParams.get("limit")));
        const columns = url.searchParams.get("select");
        const projected = selected.map((row) => columns && columns !== "*"
          ? Object.fromEntries(columns.split(",").map((key) => [key, row[key]])) : row);
        const headers = new Headers(init.headers);
        if (["PATCH", "DELETE", "POST"].includes(method) && !headers.get("prefer")?.includes("return=representation")) {
          return new Response(null, { status: 204 });
        }
        const body = headers.get("accept")?.includes("application/vnd.pgrst.object+json") ? projected[0] : projected;
        return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
      },
    },
  });
  const db = compile("src/lib/db.ts", {
    "@supabase/supabase-js": { createClient: () => sb }, "./groups": groups,
  });
  const imports = {
    "@/lib/db": db,
    "@/lib/settings": { getSettings: async () => settings, isOrganizer: async () => true, resetEnabled: () => false },
    "@/lib/http": http, "@/lib/event": event, "@/lib/groups": groups,
    "@/lib/scoring.mjs": scoring, "@/lib/scored-entries.mjs": entries,
    "node:crypto": { randomUUID },
  };
  return { tables, calls, route: (path) => compile(`src/app/api/${path}/route.ts`, imports, { Date: Clock }) };
}
const req = (path, method = "GET", body) => new Request(`https://website.test/api/${path}`, {
  method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
});
const ctx = (id) => ({ params: Promise.resolve({ id }) });

for (const [route, id] of [["players", player.id], ["teams", team.id]]) {
  for (const failure of ["error", "unknown count"]) {
    test(`${route}: ${failure} on the evidence guard cannot authorize deletion`, async () => {
      const f = fixture({}, (call) => failure === "error" && call.table === "submissions" && call.method === "HEAD",
        { omitCounts: failure === "unknown count" });
      const response = await f.route(`admin/${route}`).DELETE(req(`admin/${route}?id=${id}`, "DELETE"));
      assert.equal(response.status, 503);
      assert.ok(!f.calls.some((call) => call.method === "DELETE"));
    });
  }
  test(`${route}: confirmed evidence still refuses deletion and a confirmed empty fixture can be removed`, async () => {
    for (const hasEvidence of [true, false]) {
      const f = fixture({ submissions: hasEvidence ? [submission] : [] });
      const response = await f.route(`admin/${route}`).DELETE(req(`admin/${route}?id=${id}`, "DELETE"));
      assert.equal(response.status, hasEvidence ? 409 : 200);
      assert.equal(f.calls.some((call) => call.method === "DELETE"), !hasEvidence);
    }
  });
}
test("cutting a task is always reversible deactivation, even without evidence", async () => {
  for (const submissions of [[submission], []]) {
    const f = fixture({ submissions });
    assert.equal((await f.route("admin/tasks").DELETE(req(`admin/tasks?id=${task.id}`, "DELETE"))).status, 200);
    assert.ok(!f.calls.some((call) => call.method === "DELETE"));
    assert.equal(f.tables.tasks[0].active, false);
  }
});
test("a failed task lookup refuses a cut without any write", async () => {
  const f = fixture({}, (call) => call.table === "tasks");
  assert.equal((await f.route("admin/tasks").DELETE(req(`admin/tasks?id=${task.id}`, "DELETE"))).status, 503);
  assert.ok(!f.calls.some((call) => ["PATCH", "DELETE"].includes(call.method)));
});
test("cutting a secret deactivates both round rows by slug, without deleting their evidence", async () => {
  const second = { ...task, id: randomUUID(), round: 2, is_secret: true };
  const f = fixture({ tasks: [{ ...task, is_secret: true }, second] });
  const response = await f.route("admin/tasks").DELETE(req(`admin/tasks?id=${task.id}`, "DELETE"));
  assert.equal(response.status, 200);
  assert.ok(f.tables.tasks.every((row) => row.active === false));
  assert.equal(f.tables.submissions.length, 1);
  assert.ok(!f.calls.some((call) => call.method === "DELETE"));
});

test("cut and legacy-hidden tasks keep stored approvals but never add retired winner bonuses", async () => {
  for (const hidden of [{ active: false }, { is_secret: true, revealed_at: null }, { is_secret: true, revealed_at: "2026-09-01T12:00:00Z" }]) {
    const competition = { ...task, scoring_mode: "competition", competition_bonus: 3, winner_team_id: team.id };
    const approved = { ...submission, scoring_mode_snapshot: "competition", competition_bonus_snapshot: 3 };
    const f = fixture({ tasks: [competition], submissions: [approved] });
    Object.assign(f.tables.tasks[0], hidden);
    const response = await f.route("state").GET(req(`state?playerId=${player.id}`));
    assert.equal(response.status, 200);
    const state = await response.json();
    assert.equal(state.tasks.length, 0);
    assert.equal(state.stats.points, 5);
    assert.equal(state.submissions[0].bonusPoints, 0);
    const detail = await f.route("leaderboard/[teamId]").GET(
      req(`leaderboard/${team.id}?round=1`), { params: Promise.resolve({ teamId: team.id }) },
    );
    const entry = (await detail.json()).entries[0];
    assert.equal(state.stats.points, entry.basePoints + entry.bonusPoints);
  }
});

for (const mode of ["fixed", "quantity"]) {
  for (const endpoint of ["feed", "leaderboard/[teamId]", "export"]) {
    test(`${endpoint}: retained ${mode} evidence keeps its retired task's identity and score`, async () => {
      const bonus = mode === "quantity" ? 6 : 0;
      const approved = {
        ...submission, scoring_mode_snapshot: mode, points_per_unit_snapshot: 2,
        measurement_value: mode === "quantity" ? 3 : null, points_awarded: 5 + bonus,
      };
      const rejected = {
        ...approved, id: randomUUID(), status: "rejected", points_awarded: null,
        reject_reason: "Retained rejection reason", judged_at: "2026-09-11T13:02:00Z",
      };
      const f = fixture({
        tasks: [{ ...task, is_secret: true, active: false, scoring_mode: mode, points_per_unit: 2 }],
        submissions: [approved, rejected],
      });
      const response = await f.route(endpoint).GET(req(`${endpoint}?round=1`),
        { params: Promise.resolve({ teamId: team.id }) });
      assert.equal(response.status, 200);
      const body = await response.json();
      const rows = body.items ?? body.entries ?? body.submissions;
      assert.equal(rows.length, endpoint === "leaderboard/[teamId]" ? 1 : 2);
      for (const row of rows) {
        assert.equal(row.taskTitle ?? row.task, task.title);
        assert.ok((row.media?.[0].url ?? row.mediaUrl).includes(submission.object_name));
      }
      const scored = rows.find((row) => row.id === approved.id);
      if (endpoint === "export") {
        assert.equal(body.tasks.find((row) => row.id === task.id)?.title, task.title);
        assert.equal(scored.pointsAwarded, 5 + bonus);
      } else {
        assert.deepEqual([scored.basePoints, scored.bonusPoints], [5, bonus]);
      }
      if (endpoint !== "leaderboard/[teamId]") {
        assert.equal(rows.find((row) => row.id === rejected.id).rejectReason, rejected.reject_reason);
      }
    });
  }
}

test("retained hidden history never becomes an available task or a retry prompt", async () => {
  for (const status of ["approved", "rejected"]) {
    const f = fixture({
      tasks: [{ ...task, is_secret: true, active: false, scoring_mode: "quantity", points_per_unit: 2 }],
      submissions: [{
        ...submission, status, scoring_mode_snapshot: "quantity", points_per_unit_snapshot: 2,
        measurement_value: 3, points_awarded: status === "approved" ? 11 : null,
        reject_reason: status === "rejected" ? "Retained reason" : null,
      }],
    });
    const response = await f.route("state").GET(req(`state?playerId=${player.id}`));
    assert.equal(response.status, 200);
    const state = await response.json();
    assert.deepEqual(state.tasks, []);
    assert.deepEqual(state.rejections, []);
    assert.equal(state.submissions.length, 1);
    assert.equal(state.submissions[0].task_id, task.id);
    assert.equal(state.submissions[0].status, status);
    assert.equal(state.stats.points, status === "approved" ? 11 : 0);
    if (status === "approved") {
      assert.deepEqual([state.submissions[0].basePoints, state.submissions[0].bonusPoints], [5, 6]);
    }
  }
});

for (const body of [
  { scoringMode: "competition" }, { scoringMode: "unknown" },
  { isSecret: true }, { revealed: true }, { requiresVideo: true },
  { competitionBonus: 3 }, { winnerTeamId: team.id },
  { scoring_mode: "competition" }, { is_secret: true }, { revealed_at: "2026-09-01T12:00:00Z" },
  { requires_video: true }, { competition_bonus: 3 }, { winner_team_id: team.id },
]) {
  for (const method of ["POST", "PATCH"]) {
    test(`admin/tasks ${method} refuses retired or unsupported input ${JSON.stringify(body)} without any mutation`, async () => {
      const f = fixture();
      const response = await f.route("admin/tasks")[method](req("admin/tasks", method, {
        ...(method === "POST" ? { round: 1 } : { id: task.id }), title: task.title, points: 5, ...body,
      }));
      assert.equal(response.status, 400);
      assert.ok(!f.calls.some((call) => ["POST", "PATCH", "DELETE"].includes(call.method)));
    });
  }
}

test("historic hidden rows cannot be restored or made available even if previously revealed", async () => {
  const f = fixture({ tasks: [{ ...task, is_secret: true, revealed_at: "2026-09-01T12:00:00Z", active: false }] });
  const response = await f.route("admin/tasks").PATCH(req("admin/tasks", "PATCH", { id: task.id, active: true }));
  assert.equal(response.status, 404);
  assert.equal(f.tables.tasks[0].active, false);
  // Simulate old pre-migration data: even an active, previously revealed row is unavailable.
  f.tables.tasks[0].active = true;
  const admin = await (await f.route("admin/data").GET(req("admin/data"))).json();
  assert.equal(admin.tasks.length, 0);
  assert.equal((await f.route("submissions").POST(req("submissions", "POST", {
    playerId: player.id, taskId: task.id, fileName: "example.jpg", fileType: "image/jpeg",
  }))).status, 404);
  assert.equal((await f.route("task-entries").GET(req(`task-entries?playerId=${player.id}&taskId=${task.id}`))).status, 404);
});

test("public task and judge payloads contain only supported scoring and evidence fields", async () => {
  const f = fixture({ tasks: [{ ...task, scoring_mode: "competition", requires_video: true, winner_team_id: team.id }],
    submissions: [{ ...submission, scoring_mode_snapshot: "competition" }] });
  const state = await (await f.route("state").GET(req(`state?playerId=${player.id}`))).json();
  const admin = await (await f.route("admin/data").GET(req("admin/data"))).json();
  const judged = (await (await f.route("judge/queue").GET(req("judge/queue"))).json()).recent[0];
  for (const row of [state.tasks[0], admin.tasks[0]]) {
    assert.equal(row.scoring_mode, "fixed");
    for (const key of ["competition", "competition_bonus", "winner_team_id", "requires_video", "is_secret", "revealed_at"]) {
      assert.ok(!Object.hasOwn(row, key), `${key} must not reach a task screen`);
    }
  }
  assert.equal(judged.scoringMode, "fixed");
  for (const key of ["competitionBonus", "requiresVideo", "isSecret", "isVideo"]) {
    assert.ok(!Object.hasOwn(judged, key), `${key} is retired at group level`);
  }
  assert.equal(judged.media[0].isVideo, false);
  assert.equal(state.submissions[0].scoring_mode_snapshot, "fixed");
  assert.ok(!Object.hasOwn(state.submissions[0], "competition_bonus_snapshot"));
});

test("legacy competition uploads snapshot fixed scoring and still accept photos", async () => {
  const f = fixture({ tasks: [{ ...task, scoring_mode: "competition", requires_video: true }], submissions: [] });
  const response = await f.route("submissions").POST(req("submissions", "POST", {
    playerId: player.id, taskId: task.id, fileName: "example.jpg", fileType: "image/jpeg",
  }));
  assert.equal(response.status, 200);
  assert.equal(f.tables.submissions[0].scoring_mode_snapshot, "fixed");
  assert.ok(!Object.hasOwn(f.calls.find((call) => call.method === "POST").body, "competition_bonus_snapshot"));
});

for (const [endpoint, tables] of [
  ["judge/queue", ["submissions", "tasks", "teams", "players"]],
  ["state", ["submissions", "tasks", "teams", "players", "roster"]],
  ["feed", ["submissions", "tasks", "teams", "players"]],
  ["admin/data", ["submissions", "tasks", "teams", "players", "roster"]],
  ["export", ["submissions", "tasks", "teams", "players", "team_scores"]],
]) {
  for (const table of tables) {
    test(`${endpoint}: failed ${table} reads return an error, never invented empty data`, async () => {
      const f = fixture({}, (call) => call.table === table);
      const response = await f.route(endpoint).GET(req(`${endpoint}?playerId=${player.id}`));
      assert.equal(response.status, 503);
      assert.ok((await response.json()).error);
    });
  }
  test(`${endpoint}: a genuinely empty submission list is still a valid response`, async () => {
    const f = fixture({ submissions: [] });
    assert.equal((await f.route(endpoint).GET(req(`${endpoint}?playerId=${player.id}`))).status, 200);
  });
}
for (const [endpoint, table, match] of [
  ["judge/queue", "submissions", (p) => p.select === "team_id,task_id"],
  ["judge/queue", "submissions", (p) => p.round === "eq.2"],
  ["state", "players", (p) => p.id?.startsWith("in.")],
  ["feed", "submissions", (p) => p.select?.includes("scoring_mode_snapshot")],
  ["leaderboard/[teamId]", "tasks", (p) => p.select?.includes("scoring_mode")],
  ["leaderboard/[teamId]", "submissions", (p) => !p.select?.includes("object_name")],
]) {
  test(`${endpoint}: a failed supplemental ${table} lookup cannot change the reported score or backlog`, async () => {
    const f = fixture({}, (call) => call.table === table && match(call.params));
    const response = await f.route(endpoint).GET(req(`${endpoint}?playerId=${player.id}`),
      { params: Promise.resolve({ teamId: team.id }) });
    assert.equal(response.status, 503);
  });
}
test("CSV counts distinct task IDs independently even when their titles match", async () => {
  const otherTask = { ...task, id: randomUUID(), slug: "r1-second", points: 3 };
  const otherSubmission = { ...submission, id: randomUUID(), task_id: otherTask.id,
    task_points: 3, points_awarded: 3, judged_at: "2026-09-11T13:02:00.000Z" };
  const f = fixture({ tasks: [task, otherTask], submissions: [submission, otherSubmission] });
  const response = await f.route("export").GET(req("export?format=csv"));
  const lines = (await response.text()).split("\n");
  const counts = lines.slice(1, 3).map((line) => Number(line.split(",")[7].replaceAll('"', "")));
  assert.deepEqual(counts, [1, 1]);
});

for (const actions of [["approve", "reject"], ["reject", "approve"], ["approve", "approve"]]) {
  test(`late grouped upload: ${actions.join(" then ")} retains separate decisions across every read`, async () => {
    const quantity = actions[0] === actions[1];
    const f = fixture({ submissions: [], tasks: [{
      ...task, scoring_mode: quantity ? "quantity" : "fixed", points_per_unit: quantity ? 1 : 0,
    }] });
    const reserve = f.route("submissions");
    const finish = f.route("submissions/[id]");
    const judge = f.route("judge/[id]");
    const payload = { playerId: player.id, taskId: task.id, fileName: "example.jpg", fileType: "image/jpeg" };
    const first = await (await reserve.POST(req("submissions", "POST", payload))).json();
    assert.equal((await finish.PATCH(req("submissions", "PATCH", {}), ctx(first.submissionId))).status, 200);
    const second = await (await reserve.POST(req("submissions", "POST", { ...payload, groupWith: first.submissionId }))).json();
    assert.equal((await judge.POST(req("judge", "POST", {
      action: actions[0], expectedStatus: "pending", reason: "First file reason", measurementValue: 1,
    }), ctx(first.submissionId))).status, 200);
    assert.equal(f.tables.submissions[1].status, "uploading");
    assert.equal((await finish.PATCH(req("submissions", "PATCH", {}), ctx(second.submissionId))).status, 200);
    assert.equal((await judge.POST(req("judge", "POST", {
      action: actions[1], expectedStatus: "pending", reason: "Second file reason", measurementValue: 3,
    }), ctx(second.submissionId))).status, 200);
    const feed = await (await f.route("feed").GET(req("feed"))).json();
    const history = await (await f.route("judge/queue").GET(req("judge/queue"))).json();
    const state = await (await f.route("state").GET(req(`state?playerId=${player.id}`))).json();
    assert.equal(feed.items.length, 2);
    assert.equal(history.recent.length, 2);
    assert.equal(new Set(state.submissions.map((s) => s.groupId)).size, 2);
    for (const row of f.tables.submissions) {
      for (const list of [feed.items, history.recent]) {
        const item = list.find((i) => i.id === row.id);
        assert.equal(item.status, row.status);
        assert.equal(item.rejectReason, row.reject_reason);
        assert.deepEqual(item.media.map((m) => m.id), [row.id]);
      }
      if (row.status === "approved") {
        const item = feed.items.find((i) => i.id === row.id);
        assert.equal(item.basePoints + item.bonusPoints, row.points_awarded);
      }
    }
    const winner = scoring.latestApproved(f.tables.submissions)[0];
    const detail = await (await f.route("leaderboard/[teamId]").GET(req("leaderboard/example"),
      { params: Promise.resolve({ teamId: team.id }) })).json();
    assert.deepEqual(detail.entries[0].media.map((m) => m.id), [winner.id]);
    const firstStatus = f.tables.submissions[0].status;
    assert.equal((await judge.POST(req("judge", "POST", {
      action: "reject", expectedStatus: f.tables.submissions[1].status, reason: "Corrected second decision",
    }), ctx(second.submissionId))).status, 200);
    assert.equal(f.tables.submissions[0].status, firstStatus);
    assert.equal(f.tables.submissions[1].reject_reason, "Corrected second decision");
  });
}

test("quantity files finalized before one decision remain one complete scored group on every surface", async () => {
  const f = fixture({ submissions: [], tasks: [{ ...task, scoring_mode: "quantity", points_per_unit: 2 }] });
  const reserve = f.route("submissions");
  const finish = f.route("submissions/[id]");
  const payload = { playerId: player.id, taskId: task.id, fileName: "example.jpg", fileType: "image/jpeg" };
  const first = await (await reserve.POST(req("submissions", "POST", payload))).json();
  await finish.PATCH(req("submissions", "PATCH", {}), ctx(first.submissionId));
  const second = await (await reserve.POST(req("submissions", "POST", { ...payload, groupWith: first.submissionId }))).json();
  await finish.PATCH(req("submissions", "PATCH", {}), ctx(second.submissionId));
  const judged = await f.route("judge/[id]").POST(req("judge", "POST", {
    action: "approve", expectedStatus: "pending", measurementValue: 3,
  }), ctx(first.submissionId));
  assert.equal((await judged.json()).files, 2);
  const feed = await (await f.route("feed").GET(req("feed"))).json();
  const history = await (await f.route("judge/queue").GET(req("judge/queue"))).json();
  const state = await (await f.route("state").GET(req(`state?playerId=${player.id}`))).json();
  const detail = await (await f.route("leaderboard/[teamId]").GET(req("leaderboard/example"),
    { params: Promise.resolve({ teamId: team.id }) })).json();
  for (const list of [feed.items, history.recent, detail.entries]) {
    assert.equal(list.length, 1);
    assert.deepEqual(list[0].media.map((m) => m.id), [first.submissionId, second.submissionId]);
    const base = list[0].basePoints ?? list[0].awardedBase;
    const bonus = list[0].bonusPoints ?? list[0].awardedBonus;
    assert.deepEqual([base, bonus], [5, 6]);
  }
  assert.equal(new Set(state.submissions.map((s) => s.groupId)).size, 1);
  assert.equal(state.stats.points, 11);
  for (const row of state.submissions) assert.deepEqual([row.basePoints, row.bonusPoints], [5, 6]);
  const otherPlayer = { id: randomUUID(), name: "__qa Other Guest" };
  f.tables.players.push(otherPlayer);
  f.tables.roster.push({ round: 1, player_id: otherPlayer.id, team_id: randomUUID() });
  const other = await (await f.route("task-entries").GET(
    req(`task-entries?playerId=${otherPlayer.id}&taskId=${task.id}`),
  )).json();
  assert.deepEqual(other.entries[0].media.map((m) => m.id), [first.submissionId, second.submissionId]);
  assert.deepEqual([other.entries[0].basePoints, other.entries[0].bonusPoints], [5, 6]);
});

for (const endpoint of ["feed", "state", "task-entries", "leaderboard/[teamId]"]) {
  test(`${endpoint}: a stale quantity anchor still displays the complete decision's bonus`, async () => {
    const group = randomUUID();
    const viewer = { id: randomUUID(), name: "__qa Other Viewer" };
    const first = {
      ...submission, group_id: group, scoring_mode_snapshot: "quantity",
      points_per_unit_snapshot: 2, measurement_value: 3, points_awarded: 5,
    };
    const last = {
      ...first, id: randomUUID(), points_awarded: 11, created_at: "2026-09-11T13:00:30.000Z",
    };
    // Deliberately stale only the oldest file's award: a row-id score lookup
    // would fall back to 5 + 0, while the decision is worth 5 + 6.
    const f = fixture({
      tasks: [{ ...task, scoring_mode: "quantity", points_per_unit: 2 }],
      submissions: [first, last], players: [player, viewer],
      roster: [
        { round: 1, player_id: player.id, team_id: team.id },
        { round: 1, player_id: viewer.id, team_id: randomUUID() },
      ],
    });
    const playerId = endpoint === "task-entries" ? viewer.id : player.id;
    const response = await f.route(endpoint).GET(
      req(`${endpoint}?playerId=${playerId}&taskId=${task.id}&round=1`),
      { params: Promise.resolve({ teamId: team.id }) },
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    const list = body.items ?? body.entries ?? body.submissions;
    const anchor = list.find((entry) => entry.id === first.id);
    assert.deepEqual([anchor.basePoints, anchor.bonusPoints], [5, 6]);
    if (endpoint === "state") assert.equal(body.stats.points, 11);
    else assert.deepEqual(anchor.media.map((file) => file.id), [first.id, last.id]);
  });
}

test("a late file on the original team is not judged with an already reassigned sibling", async () => {
  const otherTeam = { ...team, id: randomUUID(), name: "__qa Blue" };
  const f = fixture({ submissions: [], teams: [team, otherTeam] });
  const reserve = f.route("submissions");
  const finish = f.route("submissions/[id]");
  const judge = f.route("judge/[id]");
  const payload = { playerId: player.id, taskId: task.id, fileName: "example.jpg", fileType: "image/jpeg" };
  const first = await (await reserve.POST(req("submissions", "POST", payload))).json();
  await finish.PATCH(req("submissions", "PATCH", {}), ctx(first.submissionId));
  const second = await (await reserve.POST(req("submissions", "POST", { ...payload, groupWith: first.submissionId }))).json();
  assert.equal((await judge.POST(req("judge", "POST", {
    action: "reassign", expectedStatus: "pending", teamId: otherTeam.id,
  }), ctx(first.submissionId))).status, 200);
  await finish.PATCH(req("submissions", "PATCH", {}), ctx(second.submissionId));
  const queue = await (await f.route("judge/queue").GET(req("judge/queue"))).json();
  assert.equal(queue.queue.length, 2);
  const response = await judge.POST(req("judge", "POST", { action: "approve", expectedStatus: "pending" }), ctx(first.submissionId));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).files, 1);
  assert.equal(f.tables.submissions[1].status, "pending");
  assert.equal(f.tables.submissions[1].team_id, team.id);
});
