/**
 * Offline browser bug bash. All APIs and media are intercepted; no credentials,
 * database access, or live event changes. Run against a local app with:
 * BASE_URL=http://127.0.0.1:3000 node qa/probe-bug-bash.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium, expect as baseExpect } from "@playwright/test";

const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";
assert(["localhost", "127.0.0.1", "[::1]"].includes(new URL(BASE).hostname));
const expect = baseExpect.configure({ timeout: 1800 });
const photo = readFileSync(new URL("./media/photo.jpg", import.meta.url));
const clip = readFileSync(new URL("./media/clip.mp4", import.meta.url));
const me = { id: "p1", name: "__qa Alexandria Montgomery-Wellington" };
const mate = { id: "p2", name: "__qa BartholomewFitzgeraldWithALongName" };
const teams = [
  { id: "t1", round: 1, name: "__qa The Pigeon Intelligence Agency", color: "#cceeff" },
  { id: "t2", round: 1, name: "__qa Birthday Bureau", color: "#8855bb" },
  { id: "t3", round: 2, name: "__qa Remixed Friends", color: "#99ddbb" },
];
const tasks = [
  { id: "task1", title: "__qa A photo with a stranger", points: 3 },
  { id: "task2", title: "__qa Gather extra pigeons", points: 5, scoring_mode: "quantity", measurement_label: "extra pigeon", points_per_unit: 1 },
  { id: "task3", title: "__qa Rejected performance", points: 10, requires_video: true },
  { id: "task4", title: "__qa Best birthday picture", points: 5, scoring_mode: "competition", competition_bonus: 7, winner_team_id: "t1" },
  { id: "task5", title: "__qa A secret challenge", points: 5, is_secret: true },
].map((t) => ({
  round: 1, active: true, scoring_mode: "fixed", measurement_label: "", points_per_unit: 0,
  competition_bonus: 0, winner_team_id: null, requires_video: false, is_secret: false,
  revealed_at: null, competition: null, ...t,
}));
let phase = "round1";
const event = () => ({
  phase, activeRound: phase === "round2" ? 2 : 1, startedRound: phase === "welcome" ? 0 : phase === "round2" ? 2 : 1,
  submissionsOpen: phase === "round1" || phase === "round2", tasksVisible: phase !== "welcome",
});
const media = (id, video = false) => ({ id, url: `${BASE}/__qa/${video ? "clip.mp4" : "photo.jpg"}`, isVideo: video, sizeBytes: 12345 });
const item = (id, taskIndex, status, extra = {}) => {
  const task = tasks[taskIndex];
  return {
    id, taskId: task.id, status, media: [media(id)], isVideo: false, sizeBytes: 12345,
    note: "Look at the pigeon on the left.", taskTitle: task.title, taskPoints: task.points,
    scoringMode: task.scoring_mode, measurementLabel: task.measurement_label,
    measurementValue: null, pointsPerUnit: task.points_per_unit,
    competitionBonus: task.competition_bonus, requiresVideo: task.requires_video, isSecret: false,
    teamId: teams[0].id, teamName: teams[0].name, teamColor: teams[0].color, playerName: me.name,
    duplicate: false, pointsAwarded: status === "approved" ? task.points : null,
    awardedBase: task.points, awardedBonus: 0, rejectReason: null, ...extra,
  };
};
let items = [
  item("s1", 1, "pending"),
  item("s2", 0, "pending"),
  item("s3", 2, "rejected", { rejectReason: "The stranger is out of frame. Please include everyone." }),
  item("s4", 3, "approved", { awardedBonus: 7, media: [media("s4"), media("s4b", true)] }),
];
let queueError = false;
let adminError = false;
let authorized = true;
let holdNextQueue = false;
let holdQueueRound = null;
let releaseQueue = null;
let holdNextDecision = false;
let releaseDecision = null;
let undoOnApprove = false;
let failRefreshOnApprove = false;
let healthError = false;
let stateHeld = false;
let queueReads = 0;
let healthReads = 0;
let stateReads = 0;
let taskSaveError = false;
let playerSaveError = false;
let promotionError = false;
let noteError = false;
let feedHeld = false;
let uploads = 0;
let holdTaskWrite = false;
let releaseTaskWrite = null;
let stuck = [];
const refused = [];
const pageErrors = [];
const mutations = [];
const failures = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const entries = () => items.filter((i) => i.status === "approved").map((i) => ({
  ...i, basePoints: i.awardedBase, bonusPoints: i.awardedBonus,
}));
const state = () => ({
  settings: { round: 1, submissions_open: event().submissionsOpen, saved_epoch: "" },
  event: event(), me, team: teams[0], tasks: tasks.filter((t) => t.active && (!t.is_secret || t.revealed_at)),
  submissions: items.flatMap((i) => i.media.map((m, index) => ({
    id: m.id, task_id: i.taskId, player_id: me.id, status: i.status,
    points_awarded: i.pointsAwarded, basePoints: i.awardedBase, bonusPoints: i.awardedBonus,
    measurement_value: i.measurementValue, reject_reason: i.rejectReason,
    created_at: `2026-09-11T12:00:0${index}.000Z`, judged_at: "2026-09-11T12:01:00.000Z",
    groupId: i.groupId ?? i.id, note: i.note, mediaUrl: m.url, isVideo: m.isVideo, playerName: me.name,
  }))),
  stats: { submitted: items.length, pending: items.filter((i) => i.status === "pending").length,
    approved: entries().length, rejected: items.filter((i) => i.status === "rejected").length,
    points: entries().reduce((n, i) => n + i.basePoints + i.bonusPoints, 0) },
  rejections: items.filter((i) => i.status === "rejected").map((i) => ({
    id: i.id, taskId: i.taskId, taskTitle: i.taskTitle, reason: i.rejectReason, at: "2026-09-11T12:01:00.000Z",
  })),
  upload: { endpoint: `${BASE}/__qa/tus`, anonKey: "eyJoffline.fixture.signature", bucket: "offline" },
});
const adminData = () => ({
  settings: { active_round: event().activeRound, started_round: event().startedRound,
    submissions_open: event().submissionsOpen, event_name: "__qa Birthday", notice: "" },
  players: [me, mate], teams, roster: [me, mate].map((p) => ({ round: 1, player_id: p.id, team_id: "t1" })),
  tasks, stuck, counts: { "1": { total: items.length, uploading: stuck.length, pending: 2, approved: 1, rejected: 1 } },
  resetEnabled: false,
});
const browser = await chromium.launch({ headless: process.env.PW_HEADLESS === "true" });
const deadline = setTimeout(() => { void browser.close(); }, 55000);
let checks = 0;
try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
  await ctx.addInitScript((player) => {
    localStorage.setItem("sh.player", JSON.stringify(player));
    const interval = window.setInterval.bind(window);
    window.setInterval = (fn, ms, ...args) => interval(fn, ms >= 2000 ? 150 : ms, ...args);
    const timeout = window.setTimeout.bind(window);
    window.setTimeout = (fn, ms, ...args) => timeout(fn, window.__fastTimeouts && ms === 15000 ? 300 : ms, ...args);
  }, me);
  await ctx.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const respond = (body, status = 200) => route.fulfill({ status, json: body });
    if (url.origin !== new URL(BASE).origin) {
      refused.push(req.url());
      return route.abort("blockedbyclient");
    }
    if (url.pathname === "/__qa/photo.jpg") return route.fulfill({ contentType: "image/jpeg", body: photo });
    if (url.pathname === "/__qa/clip.mp4") return route.fulfill({ contentType: "video/mp4", body: clip });
    if (url.pathname === "/__qa/tus" && req.method() === "POST") {
      return route.fulfill({ status: 201, headers: {
        location: `${BASE}/__qa/tus/file`, "tus-resumable": "1.0.0",
        "upload-offset": String(req.postDataBuffer()?.length ?? 0),
      } });
    }
    if (!url.pathname.startsWith("/api/") && !url.pathname.startsWith("/__qa/")) return route.continue();
    if (req.method() === "GET") {
      if (url.pathname === "/api/event") return respond(event());
      if (url.pathname === "/api/notice") return respond({ notice: "" });
      if (url.pathname === "/api/players") return respond({
        eventName: "__qa Birthday", event: event(), players: [me, mate].map((p) => ({ ...p, team: teams[0] })),
      });
      if (url.pathname === "/api/state") {
        stateReads++;
        while (stateHeld) await sleep(10);
        return respond(state());
      }
      if (url.pathname === "/api/judge/queue") {
        queueReads++;
        if (queueError) return respond({ error: "Queue temporarily unavailable" }, 503);
        if (!authorized) return respond({ error: "Organizer PIN required" }, 401);
        const round = Number(url.searchParams.get("round") || "1");
        const snapshot = structuredClone({ round, teams,
          queue: round === 2 ? [item("round2", 0, "pending", { taskTitle: "__qa Round 2 evidence" })]
            : items.filter((i) => i.status === "pending"),
          recent: round === 2 ? [] : items.filter((i) => ["approved", "rejected"].includes(i.status)), otherRoundPending: 0 });
        if (holdNextQueue && (holdQueueRound === null || round === holdQueueRound)) {
          holdNextQueue = false;
          await new Promise((resolve) => { releaseQueue = resolve; });
        }
        return respond(snapshot);
      }
      if (url.pathname === "/api/admin/data") {
        if (adminError) return respond({ error: "Admin temporarily unavailable" }, 503);
        if (!authorized) return respond({ error: "Organizer PIN required" }, 401);
        return respond(adminData());
      }
      if (url.pathname === "/api/admin/health") {
        healthReads++;
        return healthError ? respond({ error: "Health service unavailable" }, 503)
          : respond({ ok: true, checks: [{ name: "Offline sample", ok: true, detail: "Fixture response, not a live health check" }] });
      }
      if (url.pathname === "/api/feed") {
        while (feedHeld) await sleep(10);
        return respond({ round: 1, items: entries().concat(
          items.filter((i) => i.status === "rejected").map((i) => ({ ...i, basePoints: 0, bonusPoints: 0 })),
        ) });
      }
      if (url.pathname === "/api/leaderboard") return respond({
        round: 1, activeRound: event().startedRound, totalPending: 2,
        rows: teams.filter((t) => t.round === 1).map((t) => ({
          teamId: t.id, name: t.name, color: t.color, points: t.id === "t1" ? 12 : 0,
          tasksScored: t.id === "t1" ? 1 : 0, pending: 1, members: [me, mate],
        })),
      });
      if (url.pathname.startsWith("/api/leaderboard/")) return respond({ round: 1, team: teams[0], entries: entries() });
      if (url.pathname === "/api/task-entries") return respond({ entries: entries() });
    } else {
      const body = req.postDataJSON();
      mutations.push({ path: url.pathname, method: req.method(), body });
      if (url.pathname === "/api/admin/login") {
        if (body.pin !== "offline") return respond({ error: "Wrong PIN" }, 401);
        authorized = true;
        return respond({ ok: true });
      }
      if (url.pathname === "/api/admin/settings") {
        if (body.event_action === "end_round_1") phase = "break";
        if (body.event_action === "reopen_round_1") phase = "round1";
        return respond({ ok: true });
      }
      if (url.pathname === "/api/admin/tasks" && req.method() === "PATCH") {
        if (holdTaskWrite) {
          holdTaskWrite = false;
          await new Promise((resolve) => { releaseTaskWrite = resolve; });
        }
        if (taskSaveError) return respond({ error: "Task changes could not be saved" }, 503);
        const t = tasks.find((t) => t.id === body.id);
        if (body.title !== undefined) t.title = body.title;
        if (body.revealed !== undefined) t.revealed_at = body.revealed ? "2026-09-11" : null;
        if (body.active !== undefined) t.active = body.active;
        return respond({ ok: true });
      }
      if (url.pathname === "/api/admin/tasks" && req.method() === "DELETE") {
        const t = tasks.find((t) => t.id === url.searchParams.get("id"));
        assert(t, "Only a sample task can be cut");
        t.active = false;
        return respond({ ok: true, deactivated: true });
      }
      if (url.pathname === "/api/admin/tasks" && req.method() === "POST") {
        const t = { ...tasks[0], id: `created-${tasks.length}`, title: body.title,
          points: body.points, round: body.round, is_secret: body.isSecret };
        tasks.push(t);
        return respond({ id: t.id });
      }
      if (url.pathname === "/api/admin/players" && req.method() === "PATCH") {
        if (playerSaveError) return respond({ error: "Player changes could not be saved" }, 503);
        Object.assign(body.id === me.id ? me : mate, { name: body.name });
        return respond({ ok: true });
      }
      if (url.pathname.startsWith("/api/judge/")) {
        const i = items.find((i) => i.id === url.pathname.split("/").at(-1));
        if (body.action === "approve" && i.scoringMode === "quantity" && body.measurementValue === null) {
          return respond({ error: "Enter the measured amount before approving." }, 400);
        }
        i.status = body.action === "reset" ? "pending" : body.action === "approve" ? "approved" : "rejected";
        i.pointsAwarded = i.status === "approved" ? i.taskPoints : null;
        i.rejectReason = body.reason ?? null;
        i.measurementValue = body.measurementValue ?? null;
        i.awardedBonus = i.scoringMode === "quantity" ? (i.measurementValue ?? 0) * i.pointsPerUnit : 0;
        if (undoOnApprove && body.action === "approve") i.status = "pending";
        if (failRefreshOnApprove && body.action === "approve") queueError = true;
        if (holdNextDecision) {
          holdNextDecision = false;
          await new Promise((resolve) => { releaseDecision = resolve; });
        }
        return respond({ ok: true });
      }
      if (url.pathname === "/api/submissions") {
        const anchor = items.find((i) => i.id === body.groupWith);
        const id = `upload${++uploads}`;
        const video = /\.(mov|mp4)$/i.test(body.fileName);
        const i = item(id, tasks.findIndex((t) => t.id === body.taskId), "uploading", {
          groupId: anchor?.groupId ?? anchor?.id, note: anchor?.note ?? "",
          media: [media(id, video)],
        });
        items.push(i);
        return respond({ submissionId: i.id, objectName: `offline/${body.fileName}`, contentType: video ? "video/mp4" : "image/jpeg" });
      }
      if (url.pathname.startsWith("/api/submissions/")) {
        const i = items.find((i) => i.id === url.pathname.split("/").at(-1));
        assert(i, "Only a sample submission can be changed");
        if (body.noteOnly) {
          if (noteError) return respond({ error: "Note could not be saved" }, 503);
          for (const sibling of items.filter((s) => (s.groupId ?? s.id) === (i.groupId ?? i.id))) sibling.note = body.note;
        } else {
          if (promotionError) return respond({ error: "Registration unavailable" }, 503);
          i.status = "pending";
        }
        return respond({ ok: true });
      }
    }
    refused.push(`${req.method()} ${url.pathname}`);
    return route.abort("blockedbyclient");
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(1800);
  page.setDefaultNavigationTimeout(10000);
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("dialog", (dialog) => dialog.accept());
  const check = async (name, fn) => {
    checks++;
    try { await fn(); console.log(`PASS ${name}`); }
    catch (e) {
      failures.push(name);
      console.error(`FAIL ${name}: ${e.message}`);
      await page.screenshot({ path: `qa/shots/bug-bash-failure-${checks}.png`, fullPage: false });
    }
  };
  const shot = (name) => page.screenshot({ path: `qa/shots/bug-bash-${name}.png`, fullPage: false });
  const fits = async () => {
    const overflow = await page.locator("body *").evaluateAll((nodes) => nodes.filter((node) => {
      const r = node.getBoundingClientRect();
      return r.width > 0 && (r.right > innerWidth + 1 || r.left < -1);
    }).slice(0, 8).map((node) => `${node.tagName}.${node.className}: ${node.textContent.slice(0, 80)}`));
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), JSON.stringify(overflow));
  };

  await page.goto(BASE);
  await expect(page.getByRole("button", { name: "Change name", exact: true })).toBeVisible();
  await check("Home shows the selected player and teammates", async () => {
    await expect(page.getByText(mate.name, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Change name", exact: true }).click();
    await page.getByPlaceholder("Search your name").fill("Alexandria");
    await page.getByRole("button", { name: me.name, exact: true }).click();
    await expect(page.getByRole("link", { name: "View tasks", exact: true })).toBeVisible();
  });
  await shot("home");
  await page.goto(`${BASE}/submit`);
  await expect(page.getByText(tasks[0].title, { exact: true })).toBeVisible();
  await check("Task filters and saved tasks remain recoverable", async () => {
    await page.getByRole("button", { name: "Save for later", exact: true }).first().click();
    await page.getByRole("button", { name: /Filters/ }).click();
    await page.getByRole("button", { name: /Saved/ }).click();
    await expect(page.getByText(tasks[0].title, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Save for later", exact: true }).click();
    await expect(page.getByText("Nothing saved yet", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Show all tasks", exact: true }).click();
  });
  await shot("tasks");
  await check("Photo picker, local preview and upload completion", async () => {
    await page.locator(".card-flat").filter({ hasText: tasks[0].title }).getByRole("button", { name: "Redo", exact: true }).click();
    await page.locator('input[type="file"]').setInputFiles({ name: "sample.jpg", mimeType: "image/jpeg", buffer: photo });
    await expect(page.getByText("It's in the judge's queue", { exact: false })).toBeVisible();
    assert(mutations.some((m) => m.path === "/api/submissions/upload1" && m.method === "PATCH"));
    assert.equal(await page.locator('input[type="file"]').getAttribute("capture"), null);
  });
  await shot("uploaded");

  await page.goto(`${BASE}/feed`);
  await expect(page.getByText(tasks[3].title, { exact: true })).toBeVisible();
  await check("Grouped feed shows baseline, bonus and playable clip", async () => {
    await expect(page.getByText("+7 bonus", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Show 1 more file", exact: true }).click();
    await expect(page.locator("video")).toHaveAttribute("preload", "auto");
    await expect(page.locator("video")).toHaveAttribute("src", /#t=0.1$/);
    await expect.poll(() => page.locator("video").evaluate((v) => v.readyState)).toBeGreaterThan(0);
    await page.locator("video").evaluate((v) => v.play());
    await expect.poll(() => page.locator("video").evaluate((v) => v.currentTime)).toBeGreaterThan(0.1);
  });
  await shot("feed");
  await check("Feed rejection filter has a way back", async () => {
    await page.getByRole("button", { name: "Rejected", exact: true }).click();
    await expect(page.getByText("The stranger is out of frame.", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "All", exact: true }).click();
  });
  await page.goto(`${BASE}/leaderboard`);
  await check("Team scores expand to grouped evidence", async () => {
    await page.getByRole("button", { name: new RegExp(teams[0].name) }).click();
    await expect(page.getByText(tasks[3].title, { exact: true })).toBeVisible();
    await expect(page.getByText("+7 bonus", { exact: true })).toBeVisible();
  });
  await shot("scores");

  await page.goto(`${BASE}/judge`);
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
  await check("Quantity judging sends the count, not discretionary points", async () => {
    await page.getByRole("spinbutton").fill("3");
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await expect.poll(() => items[0].status).toBe("approved");
    assert.equal(items[0].measurementValue, 3);
    await expect(page.getByText("Judged this round", { exact: false })).toBeVisible();
  });
  await check("Another organizer's Undo restores an item in this judge's queue", async () => {
    await expect.poll(() => items[0].status).toBe("approved");
    await expect(page.locator(".stack .card-flat").filter({ hasText: tasks[1].title }).getByRole("button", { name: "Undo", exact: true })).toBeVisible();
    const reads = queueReads;
    items[0].status = "pending";
    await expect.poll(() => queueReads).toBeGreaterThan(reads + 1);
    await expect(page.getByRole("spinbutton")).toBeVisible();
  });
  await check("Judging refreshes past an older poll and sees an immediate remote Undo", async () => {
    // Reload only sets up this independent race, not the cross-judge check above.
    await page.reload();
    await expect(page.getByRole("spinbutton")).toBeVisible();
    holdNextQueue = true;
    await expect.poll(() => Boolean(releaseQueue)).toBe(true);
    undoOnApprove = true;
    const writes = mutations.length;
    const reads = queueReads;
    try {
      await page.getByRole("spinbutton").fill("3");
      await page.getByRole("button", { name: "Approve", exact: true }).click();
      await expect.poll(() => mutations.length).toBeGreaterThan(writes);
      await expect.poll(() => queueReads).toBeGreaterThan(reads);
      await expect(page.getByRole("spinbutton")).toBeVisible();
    } finally {
      undoOnApprove = false;
      releaseQueue?.();
      releaseQueue = null;
    }
  });
  await check("A late Round 1 decision never replaces the selected Round 2 queue", async () => {
    items[0].status = "pending";
    await page.reload();
    await page.getByRole("button", { name: "Round 1", exact: true }).click();
    await expect(page.getByRole("spinbutton")).toBeVisible();
    await page.getByRole("spinbutton").fill("3");
    holdNextDecision = true;
    const responsePromise = page.waitForResponse((r) => r.url().endsWith("/api/judge/s1") && r.request().method() === "POST");
    try {
      await page.getByRole("button", { name: "Approve", exact: true }).click();
      await expect.poll(() => Boolean(releaseDecision)).toBe(true);
      holdNextQueue = true;
      holdQueueRound = 2;
      await page.getByRole("button", { name: "Round 2", exact: true }).click();
      await expect.poll(() => Boolean(releaseQueue)).toBe(true);
      await page.evaluate((titles) => {
        window.__wrongRound = [];
        window.__roundObserver = new MutationObserver(() => {
          const selected = document.querySelector(".wrap .seg button.on")?.textContent;
          const card = document.querySelector(".cardhead")?.parentElement?.textContent;
          if (selected?.startsWith("Round 2") && titles.some((title) => card?.includes(title))) {
            window.__wrongRound.push(card);
          }
        });
        window.__roundObserver.observe(document.querySelector(".wrap"), { subtree: true, childList: true, attributes: true });
      }, tasks.map((t) => t.title));
      releaseDecision();
      await (await responsePromise).finished();
      releaseQueue();
      const reads = queueReads;
      await expect.poll(() => queueReads).toBeGreaterThan(reads + 3);
      await expect(page.getByText("__qa Round 2 evidence", { exact: true }).first()).toBeVisible();
      assert.deepEqual(await page.evaluate(() => window.__wrongRound), [], "Round 1 evidence appeared beneath the Round 2 selector");
    } finally {
      releaseDecision?.();
      releaseDecision = null;
      releaseQueue?.();
      releaseQueue = null;
      holdQueueRound = null;
      await page.evaluate(() => window.__roundObserver?.disconnect());
    }
  });
  await check("A failed post-decision refresh never resurrects the judged item", async () => {
    items[0].status = "pending";
    await page.goto(`${BASE}/judge`);
    await expect(page.getByRole("spinbutton")).toBeVisible();
    await page.getByRole("spinbutton").fill("3");
    failRefreshOnApprove = true;
    try {
      await page.getByRole("button", { name: "Approve", exact: true }).click();
      await expect(page.getByRole("alert").filter({ hasText: "Couldn't refresh the queue" })).toBeVisible();
      await expect(page.getByRole("spinbutton")).toHaveCount(0);
      assert.equal(items[0].status, "approved");
      queueError = false;
      await expect(page.getByRole("alert").filter({ hasText: "Couldn't refresh the queue" })).toHaveCount(0);
      await expect(page.getByRole("spinbutton")).toHaveCount(0);
      items[0].status = "pending";
      await expect(page.getByRole("spinbutton")).toBeVisible();
    } finally {
      failRefreshOnApprove = false;
      queueError = false;
    }
  });
  await check("Judge exposes failed refreshes instead of a stale all-clear", async () => {
    queueError = true;
    const reads = queueReads;
    await expect.poll(() => queueReads).toBeGreaterThan(reads + 1);
    await expect(page.getByText(/couldn't refresh|connection hiccup|temporarily unavailable/i)).toBeVisible();
  });
  await shot("judge-offline");
  queueError = false;
  await page.goto(`${BASE}/admin`);
  await expect(page.getByRole("button", { name: "End Round 1", exact: true })).toBeVisible();
  await check("End and reopen round controls update without resetting data", async () => {
    await page.getByRole("button", { name: "End Round 1", exact: true }).click();
    await expect(page.getByRole("button", { name: "Reopen Round 1", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Reopen Round 1", exact: true }).click();
    await expect(page.getByRole("button", { name: "End Round 1", exact: true })).toBeVisible();
    assert.equal(items.length, 5);
  });
  await page.getByRole("button", { name: "roster", exact: true }).click();
  await check("Roster player names and controls fit a narrow phone", async () => {
    await page.setViewportSize({ width: 320, height: 844 });
    await fits();
    const name = page.getByRole("button", { name: `${mate.name} edit`, exact: true });
    assert(await name.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), "Player name overflows its available width");
  });
  await shot("roster");
  await page.getByRole("button", { name: `${me.name} edit`, exact: true }).click();
  await check("Player rename controls fit at 320px", fits);
  await shot("roster-edit");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "tasks", exact: true }).click();
  await check("Secret reveal is independent of its five-point tier", async () => {
    await page.getByRole("button", { name: "Reveal", exact: true }).click();
    await expect(page.getByRole("button", { name: "Live", exact: true })).toBeVisible();
  });
  await shot("admin-tasks");
  await page.getByRole("button", { name: "health", exact: true }).click();
  await expect(page.getByText("Offline sample", { exact: true })).toBeVisible();
  await check("Health exposes failed refreshes instead of stale green checks", async () => {
    healthError = true;
    const reads = healthReads;
    await expect.poll(() => healthReads).toBeGreaterThan(reads + 1);
    await expect(page.getByText(/couldn't refresh|health service unavailable|connection hiccup/i)).toBeVisible();
    await expect(page.getByRole("button", { name: "Reset submissions", exact: true })).toHaveCount(0);
  });
  await shot("health-offline");
  healthError = false;
  await check("Health clears the stale-results warning after recovery", async () => {
    await expect(page.getByRole("alert").filter({ hasText: "Couldn't refresh health checks" })).toHaveCount(0);
  });

  for (const path of ["/judge", "/admin"]) {
    await check(`${path} distinguishes an initial outage from a PIN refusal`, async () => {
      queueError = path === "/judge";
      adminError = path === "/admin";
      try {
        await page.goto(`${BASE}${path}`);
        await expect(page.getByText(/temporarily unavailable/i)).toBeVisible();
        await expect(page.getByPlaceholder("PIN", { exact: true })).toHaveCount(0);
        queueError = false;
        adminError = false;
        await page.getByRole("button", { name: "Try again", exact: true }).click();
        await expect(page.getByRole("heading", { name: path === "/judge" ? "Judge" : "Admin", exact: true })).toBeVisible();
      } finally {
        queueError = false;
        adminError = false;
      }
    });
  }
  await check("Organizer PIN rejects a bad value and unlocks with a valid value", async () => {
    authorized = false;
    await page.goto(`${BASE}/judge`);
    await page.getByPlaceholder("PIN", { exact: true }).fill("incorrect");
    await page.getByRole("button", { name: "Unlock", exact: true }).click();
    await expect(page.getByText("Wrong PIN", { exact: true })).toBeVisible();
    await page.getByPlaceholder("PIN", { exact: true }).fill("offline");
    await page.getByRole("button", { name: "Unlock", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Judge", exact: true })).toBeVisible();
  });

  stateHeld = true;
  await page.goto(`${BASE}/submit`);
  await expect.poll(() => stateReads).toBeGreaterThan(0);
  await page.getByRole("button", { name: `${me.name} switch`, exact: true }).click();
  await expect(page.getByText("You're submitting as", { exact: false })).toBeVisible();
  await check("Identity switching does not claim zero submissions before loading", async () => {
    await expect(page.getByText("Nothing has been submitted under this name yet", { exact: false })).toHaveCount(0);
  });
  await shot("switch-loading");
  stateHeld = false;

  for (const width of [260, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    for (const path of ["/", "/submit", "/feed", "/leaderboard", "/judge"]) {
      await page.goto(`${BASE}${path}`);
      await expect(page.locator(".card").first()).toBeVisible();
      await check(`${path} fits at ${width}px`, fits);
    }
  }
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/feed`);
  await expect(page.getByText(tasks[3].title, { exact: true })).toBeVisible();
  await shot("feed-dark-mobile");

  await page.goto(`${BASE}/admin`);
  await page.getByRole("button", { name: "tasks", exact: true }).click();
  await check("A failed task edit keeps the editor and draft available for retry", async () => {
    const title = tasks[0].title;
    taskSaveError = true;
    try {
      await page.getByRole("button", { name: new RegExp(`${title}.*edit`) }).click();
      const draft = page.locator("textarea");
      await draft.fill("__qa Corrected task wording");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByText("Task changes could not be saved", { exact: true })).toBeVisible();
      await expect(draft).toHaveValue("__qa Corrected task wording");
      assert.equal(tasks[0].title, title);
      taskSaveError = false;
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect.poll(() => tasks[0].title).toBe("__qa Corrected task wording");
      await expect(draft).toHaveCount(0);
    } finally {
      taskSaveError = false;
      await page.reload();
      await page.getByRole("button", { name: "tasks", exact: true }).click();
    }
  });
  await check("A normal seven-point task is not silently made secret", async () => {
    const form = page.locator(".card").filter({ has: page.getByText("Add a task", { exact: true }) });
    await form.getByPlaceholder("Task description").fill("__qa Public seven-point task");
    await form.getByRole("button", { name: "7", exact: true }).click();
    await form.getByRole("button", { name: "Add to Round 1", exact: true }).click();
    await expect.poll(() => tasks.at(-1).title).toBe("__qa Public seven-point task");
    assert.equal(tasks.at(-1).is_secret, false);
  });
  await check("A five-point secret is an explicit choice independent of its tier", async () => {
    const form = page.locator(".card").filter({ has: page.getByText("Add a task", { exact: true }) });
    await form.getByPlaceholder("Task description").fill("__qa Explicit five-point secret");
    await form.getByRole("button", { name: "5", exact: true }).click();
    await form.getByRole("button", { name: "secret", exact: true }).click();
    await form.getByRole("button", { name: "Add to Round 1", exact: true }).click();
    await expect.poll(() => tasks.at(-1).title).toBe("__qa Explicit five-point secret");
    assert.equal(tasks.at(-1).points, 5);
    assert.equal(tasks.at(-1).is_secret, true);
  });
  await check("A task being saved cannot accept edits that its response would discard", async () => {
    await page.getByRole("button", { name: new RegExp(`${tasks[0].title}.*edit`) }).click();
    const draft = page.locator("textarea");
    await draft.fill("__qa Wording with a slow save");
    holdTaskWrite = true;
    try {
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect.poll(() => Boolean(releaseTaskWrite)).toBe(true);
      await expect(draft).toBeDisabled();
      await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    } finally {
      releaseTaskWrite?.();
      releaseTaskWrite = null;
      await expect.poll(() => tasks[0].title).toBe("__qa Wording with a slow save");
    }
  });
  await check("Removing and restoring a task keeps its evidence intact", async () => {
    const evidenceCount = items.length;
    const edit = () => page.getByRole("button", { name: new RegExp(`${tasks[0].title}.*edit`) }).click();
    await edit();
    await page.getByRole("button", { name: "Remove", exact: true }).click();
    await expect.poll(() => tasks[0].active).toBe(false);
    await edit();
    await page.getByRole("button", { name: "Restore", exact: true }).click();
    await expect.poll(() => tasks[0].active).toBe(true);
    assert.equal(items.length, evidenceCount);
  });
  await page.getByRole("button", { name: "roster", exact: true }).click();
  await check("A failed player rename keeps the typed name available for retry", async () => {
    playerSaveError = true;
    const oldName = me.name;
    try {
      await page.getByRole("button", { name: `${oldName} edit`, exact: true }).click();
      const draft = page.locator(".card").filter({ has: page.getByText("Everyone is assigned.", { exact: true }) }).getByRole("textbox");
      await draft.fill("__qa Corrected guest name");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByText("Player changes could not be saved", { exact: true })).toBeVisible();
      await expect(draft).toHaveValue("__qa Corrected guest name");
      assert.equal(me.name, oldName);
      playerSaveError = false;
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect.poll(() => me.name).toBe("__qa Corrected guest name");
    } finally {
      playerSaveError = false;
      me.name = oldName;
    }
  });
  await page.goto(`${BASE}/submit`);
  await check("A saved upload note survives moving its card out of the task list", async () => {
    const row = page.locator(".card-flat").filter({ hasText: tasks[0].title });
    await row.getByRole("button", { name: "Redo", exact: true }).click();
    await page.locator('input[type="file"]').setInputFiles({ name: "note.jpg", mimeType: "image/jpeg", buffer: photo });
    await expect(page.getByText("It's in the judge's queue", { exact: false })).toBeVisible();
    const note = page.getByPlaceholder("Add a note for the judge (optional)");
    await note.fill("The person holding the yellow umbrella is our stranger.");
    await note.blur();
    await expect(page.getByText("Note saved.", { exact: true })).toBeVisible();
    await page.getByPlaceholder("Search tasks").fill("no-such-task");
    await expect(note).toHaveValue("The person holding the yellow umbrella is our stranger.");
    await page.getByPlaceholder("Search tasks").fill("");
    await expect(note).toHaveValue("The person holding the yellow umbrella is our stranger.");
    await shot("saved-note");
  });
  await check("Adding a video preserves the group's saved note and retries a failed note save", async () => {
    const anchor = items.at(-1);
    await page.getByRole("button", { name: "Add another photo or clip to this", exact: true }).click();
    await page.locator('input[type="file"]').setInputFiles({ name: "another.mov", mimeType: "video/quicktime", buffer: clip });
    await expect(page.getByText("It's in the judge's queue", { exact: false })).toBeVisible();
    assert.equal(items.at(-1).groupId, anchor.id);
    const note = page.getByPlaceholder("Add a note for the judge (optional)");
    await expect(note).toHaveValue(anchor.note);
    await expect(page.locator(".media-preview video")).toHaveAttribute("preload", "auto");
    noteError = true;
    try {
      await note.fill("Both angles show the same stranger.");
      await note.blur();
      await expect(page.getByText("Couldn't save that note.", { exact: true })).toBeVisible();
      noteError = false;
      await note.locator("..").getByRole("button", { name: "Retry", exact: true }).click();
      await expect(page.getByText("Note saved.", { exact: true })).toBeVisible();
      assert.equal(anchor.note, "Both angles show the same stranger.");
      assert.equal(items.at(-1).note, anchor.note);
    } finally {
      noteError = false;
    }
  });
  await check("An upload that reached Storage is not labelled as never sent", async () => {
    promotionError = true;
    try {
      await page.getByPlaceholder("Search tasks").fill("");
      await page.locator(".card-flat").filter({ hasText: tasks[0].title }).getByRole("button", { name: "Redo", exact: true }).click();
      await page.locator('input[type="file"]').setInputFiles({ name: "arrived.jpg", mimeType: "image/jpeg", buffer: photo });
      await expect(page.getByText(/Uploaded, but couldn't register it/)).toBeVisible();
      await expect(page.getByText("Didn't send.", { exact: true })).toHaveCount(0);
      await shot("registration-failure");
    } finally {
      promotionError = false;
    }
  });
  await check("A stalled feed request times out and polling recovers without a reload", async () => {
    feedHeld = true;
    try {
      await page.goto(`${BASE}/submit`);
      await page.evaluate(() => { window.__fastTimeouts = true; });
      await page.getByRole("link", { name: "Feed", exact: true }).click();
      await expect(page.getByText(/Connection hiccup/)).toBeVisible();
      feedHeld = false;
      await expect(page.getByText(tasks[3].title, { exact: true })).toBeVisible();
      await expect(page.getByText(/Connection hiccup/)).toHaveCount(0);
    } finally {
      feedHeld = false;
    }
  });
  await check("Stuck-upload recovery keeps the player's name readable at 260px", async () => {
    stuck = [{ id: "stuck-fixture", round: 1, playerName: mate.name,
      taskTitle: tasks[0].title, createdAt: "2026-09-11T12:00:00Z", mediaUrl: `${BASE}/__qa/clip.mp4` }];
    try {
      await page.goto(`${BASE}/admin`);
      await page.getByRole("button", { name: "health", exact: true }).click();
      await page.setViewportSize({ width: 260, height: 844 });
      const card = page.locator(".card").filter({ has: page.getByText("Stuck uploads", { exact: true }) });
      await expect(card.getByText(mate.name, { exact: true })).toBeVisible();
      await card.scrollIntoViewIfNeeded();
      await fits();
      await shot("stuck-upload-narrow");
    } finally {
      stuck = [];
    }
  });
  await check("Browser has no uncaught application errors or unmocked requests", async () => {
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(refused, []);
  });
} finally {
  stateHeld = false;
  feedHeld = false;
  releaseQueue?.();
  releaseDecision?.();
  releaseTaskWrite?.();
  clearTimeout(deadline);
  await browser.close();
}
console.log(`\nBrowser bug bash: ${checks - failures.length}/${checks} passed; live database requests: 0`);
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
}
