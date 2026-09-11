/**
 * Offline video-loading regression. Every API and media request is intercepted;
 * no credentials, uploads, or live event data are used.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { chromium, expect as baseExpect } from "@playwright/test";

const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";
assert(["localhost", "127.0.0.1", "[::1]"].includes(new URL(BASE).hostname));
const expect = baseExpect.configure({ timeout: 2500 });
const clip = readFileSync(new URL("./media/clip.mp4", import.meta.url));
const photo = readFileSync(new URL("./media/photo.jpg", import.meta.url));
const me = { id: "p1", name: "__qa Video Viewer" };
const teams = [1, 2].map((n) => ({ id: `team${n}`, name: `__qa Team ${n}`, color: "#8855bb" }));
const tasks = [1, 2].map((n) => ({
  id: `task${n}`, title: `__qa Task ${n}`, points: 3, scoring_mode: "fixed",
  measurement_label: "", points_per_unit: 0,
}));
const event = { phase: "round2", activeRound: 2, startedRound: 2, submissionsOpen: true, tasksVisible: true };
const media = (id, isVideo = true) => ({
  id, url: `${BASE}/__qa/${id}.${isVideo ? "mp4" : "jpg"}`, isVideo,
});
const entry = (id, extra = {}) => ({
  id, taskTitle: `__qa Entry ${id}`, status: "approved", points: 3, basePoints: 3, bonusPoints: 0,
  teamId: teams[0].id, teamName: teams[0].name, teamColor: teams[0].color,
  playerName: me.name, note: "All evidence stays accessible.", rejectReason: null,
  media: [media(id)], ...extra,
});
const feed = [1, 2].map((round) => Array.from({ length: 60 }, (_, n) =>
  entry(`r${round}-${n}`, {
    status: n === 1 ? "rejected" : "approved",
    rejectReason: n === 1 ? "Try again." : null,
    media: n === 0 ? [media(`r${round}-0`), media(`r${round}-extra`), media(`r${round}-photo`, false)]
      : [media(`r${round}-${n}`)],
  })));
const own = tasks.flatMap((task, n) => [0, 1].map((file) => ({
  id: `own-${n}-${file}`, task_id: task.id, player_id: me.id, playerName: me.name,
  status: n ? "rejected" : "approved", points_awarded: n ? null : 3, basePoints: n ? null : 3,
  bonusPoints: 0, measurement_value: null, reject_reason: n ? "Try again." : null,
  groupId: `own-${n}`, note: null, isVideo: true, mediaUrl: media(`own-${n}-${file}`).url,
  created_at: `2026-09-11T12:00:0${file}.000Z`, judged_at: "2026-09-11T12:01:00.000Z",
})));
const state = {
  settings: { round: 2, submissions_open: true, saved_epoch: "" }, me, team: teams[0], tasks,
  submissions: own, stats: { submitted: 2, pending: 0, approved: 1, rejected: 1, points: 3 },
  rejections: [], upload: { endpoint: `${BASE}/__qa/tus`, anonKey: "eyJoffline.fixture.signature", bucket: "offline" },
};
let failVideo = null;
const requests = [];
const refused = [];
const errors = [];
const reads = new Map();
const browser = await chromium.launch({ headless: process.env.PW_HEADLESS === "true" });
const deadline = setTimeout(() => { void browser.close(); }, 55000);
try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
  await ctx.addInitScript((player) => {
    localStorage.setItem("sh.player", JSON.stringify(player));
    const interval = window.setInterval.bind(window);
    window.setInterval = (fn, ms, ...args) => interval(fn, ms >= 2000 ? 150 : ms, ...args);
  }, me);
  await ctx.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const respond = (body) => route.fulfill({ json: body });
    if (url.origin !== new URL(BASE).origin) {
      refused.push(req.url());
      return route.abort("blockedbyclient");
    }
    if (url.pathname.startsWith("/__qa/") && url.pathname.endsWith(".mp4")) {
      requests.push(url.pathname);
      return route.fulfill({
        status: url.pathname === failVideo ? 503 : 200, contentType: "video/mp4", body: clip,
      });
    }
    if (url.pathname.startsWith("/__qa/") && url.pathname.endsWith(".jpg")) {
      return route.fulfill({ contentType: "image/jpeg", body: photo });
    }
    if (!url.pathname.startsWith("/api/") && !url.pathname.startsWith("/__qa/")) return route.continue();
    reads.set(url.pathname, (reads.get(url.pathname) ?? 0) + 1);
    if (req.method() === "GET") {
      if (url.pathname === "/api/event") return respond(event);
      if (url.pathname === "/api/notice") return respond({ notice: "" });
      if (url.pathname === "/api/feed") {
        const round = Number(url.searchParams.get("round")) || 2;
        return respond({ round, items: feed[round - 1] });
      }
      if (url.pathname === "/api/state") return respond(state);
      if (url.pathname === "/api/task-entries") return respond({ entries: [
        entry("other1", { teamId: teams[1].id, teamName: teams[1].name, media: [media("other1"), media("other-extra")] }),
        entry("other2", { teamId: "team3", teamName: "__qa Team 3" }),
      ] });
      if (url.pathname === "/api/leaderboard") {
        const round = Number(url.searchParams.get("round")) || 2;
        return respond({ round, activeRound: 2, totalPending: 0, rows: teams.map((t) => ({
          teamId: t.id, name: t.name, color: t.color, points: 60, tasksScored: 20, pending: 0, members: [me],
        })) });
      }
      if (url.pathname.startsWith("/api/leaderboard/")) {
        const team = teams.find((t) => url.pathname.endsWith(t.id));
        return respond({
          round: Number(url.searchParams.get("round")), team,
          entries: Array.from({ length: 20 }, (_, n) => entry(`${team.id}-${n}`, {
            media: n === 0 ? [media(`${team.id}-0`), media(`${team.id}-extra`)] : [media(`${team.id}-${n}`)],
          })),
        });
      }
      if (url.pathname === "/api/judge/queue") return respond({
        round: 2, teams, recent: [], otherRoundPending: 0,
        queue: [{
          ...entry("judge", { media: [media("judge1"), media("judge2")] }),
          taskPoints: 3, scoringMode: "fixed", measurementLabel: "", measurementValue: null,
          pointsPerUnit: 0, duplicate: false, createdAt: "2026-09-11T12:00:00.000Z",
        }],
      });
    }
    if (url.pathname === "/api/submissions" && req.method() === "POST") {
      return respond({ submissionId: "upload", objectName: "offline/upload.mp4", contentType: "video/mp4" });
    }
    if (url.pathname === "/__qa/tus" && req.method() === "POST") {
      return route.fulfill({ status: 201, headers: {
        location: `${BASE}/__qa/tus/file`, "tus-resumable": "1.0.0", "upload-offset": String(clip.length),
      } });
    }
    if (url.pathname === "/api/submissions/upload" && req.method() === "PATCH") return respond({ ok: true });
    refused.push(`${req.method()} ${url.pathname}`);
    return route.abort("blockedbyclient");
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  const card = (title) => page.getByText(title, { exact: true }).locator("..");
  const view = (within = page) => within.getByRole("button", { name: "View video", exact: true });
  const close = () => page.getByRole("button", { name: "Close video", exact: true });
  const polls = async (path) => {
    const before = reads.get(path) ?? 0;
    await expect.poll(() => reads.get(path) ?? 0).toBeGreaterThanOrEqual(before + 2);
  };
  const unloaded = async () => {
    await expect(page.locator("video")).toHaveCount(0);
    assert.equal(requests.length, 0, "Browsing must not fetch any video bytes before a tap");
  };
  const opened = async (id) => {
    await expect(page.locator("video")).toHaveCount(1);
    await expect(page.locator("video")).toHaveAttribute("src", `${media(id).url}#t=0.1`);
    await expect(page.locator("video")).toHaveAttribute("preload", "auto");
    await expect(page.locator("video")).toHaveAttribute("playsinline", "");
    await expect(page.locator("video")).toHaveAttribute("controls", "");
    await expect.poll(() => page.locator("video").evaluate((v) => v.readyState)).toBeGreaterThan(0);
  };
  const released = async (handle) => {
    await expect.poll(() => handle.evaluate((v) => !v.isConnected && v.paused && !v.getAttribute("src"))).toBe(true);
    await handle.dispose();
  };

  await page.goto(`${BASE}/feed`);
  await expect(page.getByText("__qa Entry r2-59", { exact: true })).toHaveCount(1);
  await polls("/api/feed");
  await unloaded();
  await expect(view()).toHaveCount(60);
  await card("__qa Entry r2-0").getByRole("button", { name: "Show 2 more files", exact: true }).click();
  await unloaded();
  await expect(card("__qa Entry r2-0").locator("img")).toHaveCount(1);
  await view(card("__qa Entry r2-0")).first().click();
  await opened("r2-0");
  await page.locator("video").evaluate((v) => v.play());
  await expect.poll(() => page.locator("video").evaluate((v) => v.currentTime)).toBeGreaterThan(0.1);
  const first = await page.locator("video").elementHandle();
  await polls("/api/feed");
  assert(await first.evaluate((v) => v === document.querySelector("video")), "Polling must preserve the actual player");
  await view(card("__qa Entry r2-0")).click();
  await opened("r2-extra");
  await released(first);
  const filtered = await page.locator("video").elementHandle();
  await page.getByRole("button", { name: "Rejected", exact: true }).click();
  await expect(page.locator("video")).toHaveCount(0);
  await released(filtered);
  await view().click();
  await opened("r2-1");
  await page.getByRole("button", { name: "All", exact: true }).click();
  await expect(page.locator("video")).toHaveCount(0);
  await view(card("__qa Entry r2-59")).click();
  await opened("r2-59");
  await page.getByRole("button", { name: "Round 1", exact: true }).click();
  await expect(view()).toHaveCount(60);
  await expect(page.locator("video")).toHaveCount(0);
  failVideo = "/__qa/r1-0.mp4";
  await view(card("__qa Entry r1-0")).click();
  await expect(card("__qa Entry r1-0").getByRole("alert")).toContainText("Couldn't load this video");
  await close().click();
  failVideo = null;
  await view(card("__qa Entry r1-0")).click();
  await opened("r1-0");
  await close().click();
  await page.setViewportSize({ width: 260, height: 844 });
  await view(card("__qa Entry r1-0")).click();
  await opened("r1-0");
  assert(await close().evaluate((b) => b.getBoundingClientRect().right <= innerWidth), "Close fits a narrow phone");
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "No horizontal overflow");
  mkdirSync(new URL("./shots/", import.meta.url), { recursive: true });
  await page.screenshot({ path: "qa/shots/video-tap-narrow.png", fullPage: false });
  await page.setViewportSize({ width: 390, height: 844 });
  console.log("PASS Feed: 60 posts, zero eager video requests, one player, groups, polling, filters, rounds and retry");

  await page.goto(`${BASE}/leaderboard`);
  requests.length = 0;
  const teamButton = (n) => page.getByRole("button", { name: new RegExp(teams[n].name) }).first();
  await teamButton(0).click();
  await expect(view()).toHaveCount(20);
  await polls("/api/leaderboard/team1");
  await unloaded();
  await view(card("__qa Entry team1-19")).click();
  await opened("team1-19");
  const teamVideo = await page.locator("video").elementHandle();
  await teamButton(0).click();
  await released(teamVideo);
  await teamButton(0).click();
  await expect(view()).toHaveCount(20);
  await expect(page.locator("video")).toHaveCount(0);
  await card("__qa Entry team1-0").getByRole("button", { name: "Show 1 more file", exact: true }).click();
  await expect(page.locator("video")).toHaveCount(0);
  await view(card("__qa Entry team1-0")).last().click();
  await opened("team1-extra");
  await teamButton(1).click();
  await expect(view()).toHaveCount(20);
  await expect(page.locator("video")).toHaveCount(0);
  console.log("PASS Scores: all scored history available, group expansion stays unloaded, collapse releases video");

  await page.goto(`${BASE}/submit`);
  requests.length = 0;
  const taskCard = (n) => page.locator(".card-flat").filter({ has: page.getByText(tasks[n].title, { exact: true }) });
  await taskCard(0).getByRole("button", { name: "See", exact: true }).click();
  await taskCard(1).getByRole("button", { name: "See", exact: true }).click();
  await taskCard(0).getByRole("button", { name: "See other teams' entries", exact: true }).click();
  await expect(view()).toHaveCount(6);
  await polls("/api/task-entries");
  await unloaded();
  await view(taskCard(0)).first().click();
  await opened("own-0-0");
  const ownVideo = await page.locator("video").elementHandle();
  await view(taskCard(1)).first().click();
  await opened("own-1-0");
  await released(ownVideo);
  await taskCard(0).getByRole("button", { name: "Show 1 more file", exact: true }).click();
  await view(taskCard(0)).nth(3).click();
  await opened("other-extra");
  const otherVideo = await page.locator("video").elementHandle();
  await taskCard(0).getByRole("button", { name: "Hide other teams", exact: true }).click();
  await released(otherVideo);
  await taskCard(0).getByRole("button", { name: "See other teams' entries", exact: true }).click();
  await expect(view()).toHaveCount(6);
  await expect(page.locator("video")).toHaveCount(0);
  await taskCard(0).getByRole("button", { name: "Redo", exact: true }).click();
  await page.locator('input[type="file"]').setInputFiles({ name: "upload.mov", mimeType: "video/quicktime", buffer: clip });
  await expect(page.locator(".media-preview video")).toHaveAttribute("preload", "auto");
  await expect(page.locator(".media-preview").getByRole("button", { name: "View video", exact: true })).toHaveCount(0);
  assert.equal(await page.locator('input[type="file"]').getAttribute("capture"), null);
  await expect(page.getByText("It's in the judge's queue", { exact: false })).toBeVisible();
  console.log("PASS Tasks: own/rejected/other-team evidence shares one player; upload preview and completion unchanged");

  await page.goto(`${BASE}/judge`);
  await expect(page.locator("video")).toHaveCount(2);
  await expect(view()).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Approve/ })).toBeVisible();
  assert.deepEqual(errors, [], "No browser exceptions");
  assert.deepEqual(refused, [], "No unexpected APIs or external requests");
  console.log("PASS Judge: current multi-file evidence still loads directly");
  console.log("real data intact: true (all APIs mocked; no live database access)");
} finally {
  clearTimeout(deadline);
  await browser.close();
}
