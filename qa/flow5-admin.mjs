/**
 * Flow 5 — the admin screen (tasks, roster, teams, health) plus the one known
 * open question: what actually happens once a round passes 60 approvals.
 */
import { chromium } from "@playwright/test";
import {
  BASE, PIN, admin, setup, teardown, teardownTasks, snapshot, captureSettings, restoreSettings, seed, check, note, summary, call, cloneSubmission, asOrganizer,
} from "./lib.mjs";

const before = await snapshot();
const settingsBefore = await captureSettings();
let browser;

try {
  await teardown();
  const fx = await setup();
  const alice = fx.player("__qa Alice");
  const red1 = fx.teamOf("__qa Red", 1);
  await call("/api/admin/roster", { method: "POST", body: JSON.stringify({ round: 1, entries: [{ playerId: alice.id, teamId: red1.id }] }) });

  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await asOrganizer(ctx);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  console.log("\n1. Admin is reachable and tabbed");
  await page.goto(`${BASE}/admin`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  // Tabs are plain buttons with lowercase labels, not a .seg control.
  const tabs = await Promise.all(["event", "roster", "tasks", "health"].map(
    (t) => page.getByRole("button", { name: t, exact: true }).count()));
  note(`tabs found: ${JSON.stringify(tabs)}`);
  check("admin exposes all four tabs", tabs.every((n) => n > 0), JSON.stringify(tabs));
  const navHasAdmin = await page.locator("nav a, .topbar a").allInnerTexts();
  check("admin is discoverable from the nav", navHasAdmin.some((t) => /admin|organizer/i.test(t)), JSON.stringify(navHasAdmin));

  console.log("\n2. Tasks tab — add, edit, deactivate");
  const tasksTab = page.getByRole("button", { name: "tasks", exact: true }).first();
  if (await tasksTab.count()) { await tasksTab.click(); await page.waitForTimeout(1200); }

  const addRes = await call("/api/admin/tasks", { method: "POST", body: JSON.stringify({ round: 1, title: "__qa editable task", points: 2 }) });
  const newTaskId = addRes.body.id;
  check("a task can be added", Boolean(newTaskId), JSON.stringify(addRes.body));
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  if (await tasksTab.count()) { await tasksTab.click(); await page.waitForTimeout(1200); }
  check("the new task shows up in admin", await page.getByText("__qa editable task", { exact: false }).count() > 0);

  // Editing is tap-the-row, not an Edit button; probe-admin-ui.mjs drives that
  // interaction end to end. Here we only assert the row is a tap target.
  check("the task row is tappable to edit",
    await page.getByRole("button", { name: /__qa editable task/ }).count() > 0);

  const patched = await call("/api/admin/tasks", { method: "PATCH", body: JSON.stringify({ id: newTaskId, title: "__qa edited task", points: 5 }) });
  check("task edit persists via the API", patched.status === 200, JSON.stringify(patched.body));
  const { data: edited } = await admin.from("tasks").select("title,points").eq("id", newTaskId).single();
  check("edited title and points are stored", edited.title === "__qa edited task" && edited.points === 5, JSON.stringify(edited));

  const validation = await Promise.all([
    call("/api/admin/tasks", { method: "POST", body: JSON.stringify({ round: 1, title: "", points: 1 }) }),
    call("/api/admin/tasks", { method: "POST", body: JSON.stringify({ round: 1, title: "x", points: 0 }) }),
    call("/api/admin/tasks", { method: "POST", body: JSON.stringify({ round: 3, title: "x", points: 1 }) }),
    call("/api/admin/tasks", { method: "POST", body: JSON.stringify({ round: 1, title: "x", points: -5 }) }),
  ]);
  check("empty title, zero/negative points and bad rounds are all refused",
    validation.every((v) => v.status >= 400), JSON.stringify(validation.map((v) => v.status)));

  console.log("\n3. Roster tab — assign, clear, copy between rounds");
  const rosterTab = page.getByRole("button", { name: "roster", exact: true }).first();
  if (await rosterTab.count()) { await rosterTab.click(); await page.waitForTimeout(1200); }
  check("roster tab lists players", await page.getByText("__qa Alice", { exact: false }).count() > 0);

  const copy = await call("/api/admin/roster", { method: "PUT", body: JSON.stringify({ from: 1, to: 2 }) });
  check("copy roster between rounds works", copy.status === 200, JSON.stringify(copy.body));
  const { data: r2row } = await admin.from("roster").select("team_id").eq("round", 2).eq("player_id", alice.id).maybeSingle();
  check("copy landed Alice on the round-2 twin of her round-1 team",
    r2row?.team_id === fx.teamOf("__qa Red", 2).id, JSON.stringify(r2row));

  const crossRound = await call("/api/admin/roster", { method: "POST", body: JSON.stringify({
    round: 2, entries: [{ playerId: alice.id, teamId: red1.id }] }) });
  check("assigning a player to a team from the WRONG round is refused",
    crossRound.status >= 400, `${crossRound.status} ${JSON.stringify(crossRound.body)}`);

  console.log("\n4. Player rename and delete guards");
  const rename = await call("/api/admin/players", { method: "PATCH", body: JSON.stringify({ id: alice.id, name: "__qa Alice Renamed" }) });
  check("a player can be renamed", rename.status === 200, JSON.stringify(rename.body));
  const dupe = await call("/api/admin/players", { method: "PATCH", body: JSON.stringify({ id: fx.player("__qa Bob").id, name: "__qa Alice Renamed" }) });
  check("duplicate names are refused", dupe.status === 409, `${dupe.status} ${JSON.stringify(dupe.body)}`);
  await call("/api/admin/players", { method: "PATCH", body: JSON.stringify({ id: alice.id, name: "__qa Alice" }) });

  const sub = await seed({ playerId: alice.id, taskId: newTaskId });
  const delWithSubs = await call(`/api/admin/players?id=${alice.id}`, { method: "DELETE" });
  check("deleting a player who has submissions is refused", delWithSubs.status === 409,
    `${delWithSubs.status} ${JSON.stringify(delWithSubs.body)}`);
  const delTeamWithSubs = await call(`/api/admin/teams?id=${red1.id}`, { method: "DELETE" });
  check("deleting a team that holds submissions is refused", delTeamWithSubs.status === 409,
    `${delTeamWithSubs.status} ${JSON.stringify(delTeamWithSubs.body)}`);

  console.log("\n5. Health tab");
  const healthTab = page.getByRole("button", { name: "health", exact: true }).first();
  if (await healthTab.count()) { await healthTab.click(); await page.waitForTimeout(4000); }
  const healthJson = await (await fetch(`${BASE}/api/admin/health`, { headers: { cookie: `organizer=${PIN}` } })).json();
  note(`health: ${JSON.stringify(healthJson).slice(0, 400)}`);
  const checksArr = healthJson.checks ?? [];
  const bad = checksArr.filter((c) => c.ok === false);
  check("every health check passes", bad.length === 0, JSON.stringify(bad));
  const healthText = await page.locator("body").innerText();
  check("health tab renders results in the UI", /ok|pass|good|✓/i.test(healthText), healthText.slice(0, 200));

  console.log("\n6. Unauthenticated access is refused");
  const anon = await browser.newContext();
  const ap = await anon.newPage();
  await ap.goto(`${BASE}/admin`, { waitUntil: "networkidle" });
  await ap.waitForTimeout(1500);
  check("admin screen is PIN-gated", await ap.getByPlaceholder("PIN").count() > 0,
    (await ap.locator("body").innerText()).slice(0, 150));
  const noCookie = await fetch(`${BASE}/api/admin/data`);
  check("admin API refuses without the cookie", noCookie.status === 401, String(noCookie.status));
  const writeNoCookie = await fetch(`${BASE}/api/admin/settings`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ active_round: 2 }) });
  check("admin writes refuse without the cookie", writeNoCookie.status === 401, String(writeNoCookie.status));
  const judgeNoCookie = await fetch(`${BASE}/api/judge/${sub}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "approve" }) });
  check("judging refuses without the cookie", judgeNoCookie.status === 401, String(judgeNoCookie.status));

  console.log("\n7. The 60-approval feed cap");
  // Clone one real approved submission 70x so the feed is genuinely over the cap.
  await call(`/api/judge/${sub}`, { method: "POST", body: JSON.stringify({ action: "approve", bonus: 0 }) });
  const { data: template } = await admin.from("submissions").select("*").eq("id", sub).single();
  const clones = Array.from({ length: 70 }, (_, i) => {
    return cloneSubmission(template, { judged_at: new Date(Date.now() - (70 - i) * 60000).toISOString() });
  });
  await admin.from("submissions").insert(clones);
  const total = (await admin.from("submissions").select("id", { count: "exact", head: true })
    .eq("team_id", red1.id).eq("status", "approved")).count;
  note(`approved submissions now in round 1 for __qa Red: ${total}`);

  const feedApi = await (await fetch(`${BASE}/api/feed?round=1`)).json();
  const items = feedApi.items ?? feedApi.rows ?? [];
  note(`GET /api/feed returned ${items.length} items for ${total} approvals`);
  check("the feed shows every approval in the round", items.length >= total,
    `${items.length} shown of ${total} approved — the oldest are invisible with nothing on screen to say so`);

  const feedPage = await ctx.newPage();
  await feedPage.goto(`${BASE}/feed`, { waitUntil: "networkidle" });
  await feedPage.waitForTimeout(3000);
  const counter = await feedPage.locator("h1, .eyebrow, .pill").allInnerTexts();
  note(`feed header says: ${JSON.stringify(counter.slice(0, 4))}`);
  const shownCards = await feedPage.locator(".media-box").count();
  note(`feed rendered ${shownCards} media cards`);
  check("the feed's own counter does not overstate/understate what it shows",
    !counter.some((c) => /\b60\b/.test(c)) || shownCards === 60,
    `counter ${JSON.stringify(counter.slice(0, 3))} vs ${shownCards} cards`);

  await admin.from("submissions").delete().eq("task_id", newTaskId);
  await admin.from("tasks").delete().eq("id", newTaskId);

  check("no uncaught page errors on admin", errors.length === 0, errors.join(" | "));
} finally {
  if (browser) await browser.close();
  await teardownTasks();
  await teardown();
  await restoreSettings(settingsBefore);
  const after = await snapshot();
  const intact = JSON.stringify(before) === JSON.stringify(after);
  console.log(`\nreal data intact: ${intact}`);
  if (!intact) console.log("BEFORE", JSON.stringify(before), "\nAFTER ", JSON.stringify(after));
  summary("Flow 5 (admin + feed cap)");
}
