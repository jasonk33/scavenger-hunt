/**
 * Offline lifecycle regression. Every API request is intercepted; unknown APIs
 * and external requests are refused rather than reaching the event database.
 */
import assert from "node:assert/strict";
import { chromium, expect as baseExpect } from "@playwright/test";

const BASE = process.env.BASE_URL || "http://localhost:3000";
assert(["localhost", "127.0.0.1", "[::1]"].includes(new URL(BASE).hostname), "Use a local dev server");
const expect = baseExpect.configure({ timeout: 3000 });

const phases = [
  { phase: "welcome", activeRound: 1, startedRound: 0, submissionsOpen: false, tasksVisible: false },
  { phase: "round1", activeRound: 1, startedRound: 1, submissionsOpen: true, tasksVisible: true },
  { phase: "break", activeRound: 1, startedRound: 1, submissionsOpen: false, tasksVisible: true },
  { phase: "remix", activeRound: 2, startedRound: 1, submissionsOpen: false, tasksVisible: false },
  { phase: "round2", activeRound: 2, startedRound: 2, submissionsOpen: true, tasksVisible: true },
  { phase: "finished", activeRound: 2, startedRound: 2, submissionsOpen: false, tasksVisible: true },
];
const actions = ["start_round_1", "end_round_1", "reveal_round_2", "start_round_2", "end_round_2"];
const labels = ["Start Round 1", "End Round 1", "Reveal Round 2 teams", "Start Round 2", "End Round 2"];
const me = { id: "p1", name: "__qa Alexandria Montgomery-Wellington" };
const teammate = { id: "p2", name: "__qa Bartholomew Fitzgerald" };
const remixMate = { id: "p3", name: "__qa Charlotte AnotherTeammate" };
const teams = [
  { id: "t1", name: "__qa The ExceptionallyLongUnbrokenBirthdayTeamName", color: "#cceeff" },
  { id: "t2", name: "__qa Other Team", color: "#ffccdd" },
  { id: "t3", name: "__qa Remixed Friends", color: "#ccffee" },
];
let stage = 0;
let eventError = false;
let playerError = false;
let holdEvent = false;
let holdPlayers = false;
let holdAdmin = false;
let refuseReveal = false;
let refuseWelcome = false;
let dismissConfirmation = false;
const refused = [];
const sentActions = [];
let stateRequests = 0;
let eventRequests = 0;
let playerRequests = 0;
let adminRequests = 0;
const event = () => phases[stage];
const roster = () => [
  { ...me, team: teams[event().activeRound === 1 ? 0 : 2] },
  { ...teammate, team: teams[event().activeRound === 1 ? 0 : 1] },
  { ...remixMate, team: teams[event().activeRound === 1 ? 1 : 2] },
];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const browser = await chromium.launch();
const deadline = setTimeout(() => { void browser.close(); }, 55000);
try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
  await ctx.addCookies([{ name: "organizer", value: "offline", url: BASE }]);
  await ctx.addInitScript((player) => {
    localStorage.setItem("sh.player", JSON.stringify({ ...player, name: "Outdated cached name" }));
    // Speed up only the app's polling timers; no wall-clock waits per phase.
    const interval = window.setInterval.bind(window);
    window.setInterval = (fn, ms, ...args) => interval(fn, ms >= 2000 ? 120 : ms, ...args);
    window.__welcomeDocument = Math.random();
  }, me);
  await ctx.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin !== new URL(BASE).origin) {
      refused.push(`${req.method()} ${req.url()}`);
      return route.abort("blockedbyclient");
    }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const respond = (body, status = 200) => route.fulfill({ status, json: body });
    if (req.method() === "GET") {
      if (url.pathname === "/api/event") {
        eventRequests++;
        while (holdEvent) await pause(10);
        return eventError ? respond({ error: "Offline event status" }, 503) : respond(event());
      }
      if (url.pathname === "/api/notice") return respond({ notice: "" });
      if (url.pathname === "/api/players") {
        playerRequests++;
        const snapshot = { eventName: "__qa Birthday", players: roster(), event: event() };
        while (holdPlayers) await pause(10);
        return playerError ? respond({ error: "Offline player list" }, 503) : respond(snapshot);
      }
      if (url.pathname === "/api/admin/data") {
        adminRequests++;
        const snapshot = {
          settings: {
            active_round: event().activeRound, started_round: event().startedRound,
            submissions_open: event().submissionsOpen, event_name: "__qa Birthday", notice: "",
          },
          players: [], teams: [], roster: [], tasks: [], stuck: [], counts: {}, resetEnabled: false,
        };
        while (holdAdmin) await pause(10);
        return respond(snapshot);
      }
      if (url.pathname === "/api/judge/queue") return respond({ error: "Organizer PIN required" }, 401);
      if (url.pathname === "/api/feed") {
        return respond({ round: Number(url.searchParams.get("round")) || event().startedRound,
          activeRound: event().startedRound, items: [] });
      }
      if (url.pathname === "/api/leaderboard") {
        return respond({ round: Number(url.searchParams.get("round")) || event().startedRound,
          activeRound: event().startedRound, totalPending: 0, rows: [] });
      }
      if (url.pathname === "/api/state") {
        stateRequests++;
        return respond({
          settings: { round: event().activeRound, submissions_open: event().submissionsOpen, saved_epoch: "" },
          event: event(), me, team: roster()[0].team,
          tasks: [{
            id: `task-${event().activeRound}`, title: `__qa Round ${event().activeRound} task`, points: 3,
            scoring_mode: "fixed", measurement_label: "", points_per_unit: 0,
          }],
          submissions: [], stats: { submitted: 0, pending: 0, approved: 0, rejected: 0, points: 0 },
          rejections: [], upload: { endpoint: "", anonKey: "", bucket: "" },
        });
      }
    }
    if (url.pathname === "/api/admin/settings" && req.method() === "POST") {
      const body = req.postDataJSON();
      assert.equal(body.expected_phase, event().phase);
      if (body.event_action === "return_to_welcome") {
        if (refuseWelcome) return respond({ error: "An upload is still in progress. Let it finish before returning to welcome." }, 409);
        sentActions.push(body.event_action);
        stage = 0;
        return respond({ ok: true });
      }
      if (body.event_action === "reopen_round_2") {
        assert.equal(stage, 5);
        sentActions.push(body.event_action);
        stage = 4;
        return respond({ ok: true });
      }
      assert.equal(body.event_action, actions[stage]);
      if (refuseReveal && body.event_action === "reveal_round_2") {
        return respond({ error: "A Round 1 upload is still in progress" }, 409);
      }
      sentActions.push(body.event_action);
      stage++;
      return respond({ ok: true });
    }
    refused.push(`${req.method()} ${url.pathname}`);
    return route.abort("blockedbyclient");
  });
  const home = await ctx.newPage();
  const navLink = (page, name) => page.locator("nav").getByRole("link", { name, exact: true });
  await home.goto(BASE);
  await expect(home.getByRole("button", { name: "Change name", exact: true })).toBeVisible();
  assert.equal(new URL(home.url()).pathname, "/", "Remembered players must remain on Home");
  await expect(home.getByText("Outdated cached name", { exact: true })).toHaveCount(0);
  await expect(home.getByText(me.name, { exact: true }).first()).toBeVisible();
  await expect(home.getByText(teammate.name, { exact: true })).toBeVisible();
  await expect(home.getByText(remixMate.name, { exact: true })).toHaveCount(0);
  await expect(home.getByText(teams[1].name, { exact: true })).toHaveCount(0);
  await expect(home.getByRole("heading", { name: "Rules", exact: true })).toBeVisible();
  await expect(home.getByText(/Stay together/)).toBeVisible();
  await expect(home.getByText(/same stranger.*3.*per team.*per round/i)).toBeVisible();
  await expect(home.getByRole("region", { name: "Event status" })).toContainText("when Jason starts Round 1");
  const howTo = home.getByRole("region", { name: "How it works", exact: true });
  await expect(howTo).not.toContainText("Meet at Jason's apartment");
  await expect(howTo.getByRole("list", { name: "Afternoon schedule" }).getByRole("listitem")).toHaveText([
    "Round 190 min", "Break1 hour", "Round 290 min",
  ]);
  await expect(howTo).toContainText(/After Round 1, meet back at Jason's apartment for a 1-hour break.*relax.*refreshments/i);
  await expect(howTo).toContainText(/switch teams for Round 2.*each round is scored separately/i);
  await expect(howTo).toContainText(/Each round, every team gets a bag of challenge props and a separate bag of handy supplies/i);
  await expect(howTo).toContainText(/50 tasks per round.*as many as you can/i);
  await expect(howTo.getByRole("list", { name: "Task points" }).getByRole("listitem")).toHaveText([
    "1 pt", "3 pts", "5 pts", "10 pts",
  ]);
  await expect(howTo).toContainText(/bonus points for doing extra/i);
  const rules = home.getByRole("region", { name: "Rules", exact: true });
  await expect(rules.locator("b, strong")).toHaveCount(0);
  assert.equal(await rules.getByRole("listitem").first().evaluate((node) => getComputedStyle(node).listStyleType), "disc");
  assert.equal(await rules.getByRole("listitem").first().evaluate((node) => getComputedStyle(node).fontWeight), "400");
  const website = home.getByRole("region", { name: "Using the website" });
  await expect(website).toContainText(/Tasks:.*upload photo or video evidence/i);
  await expect(website).toContainText(/once per team.*approved/i);
  await expect(website).toContainText(/Scores:.*standings/i);
  await expect(website).toContainText(/Feed:.*photos and videos/i);
  await expect(website.getByRole("listitem")).toHaveCount(3);
  await expect(website).not.toContainText(/Waiting:|Rejected:/);
  for (const name of ["Tasks", "Scores", "Feed"]) await expect(navLink(home, name)).toHaveCount(0);
  await expect(navLink(home, "Home")).toHaveClass("on");

  await home.setViewportSize({ width: 260, height: 844 });
  assert.deepEqual(await home.locator(".name, .pill-wrap").evaluateAll((nodes) => nodes
    .filter((node) => node.scrollWidth > node.clientWidth + 1 || getComputedStyle(node).textOverflow === "ellipsis")
    .map((node) => node.textContent)), [], "Full names wrap at 260px");
  assert(await home.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "No horizontal overflow");
  assert(await home.getByText(me.name, { exact: true }).first().evaluate((node) => node.clientWidth >= 150),
    "Change name must wrap rather than squeeze the player's identity at 260px");
  await home.screenshot({ path: "qa/shots/welcome-narrow.png", fullPage: true });
  await home.getByRole("button", { name: "Change name", exact: true }).click();
  await expect(home.getByRole("heading", { name: "Who are you?" })).toBeVisible();
  const search = home.getByPlaceholder("Search your name");
  assert(await search.evaluate((node) => parseFloat(getComputedStyle(node).fontSize) >= 16));
  await search.fill("Alexandria");
  await home.getByRole("button", { name: me.name, exact: true }).click();
  await expect(search).toHaveCount(0);
  assert.equal(new URL(home.url()).pathname, "/", "Choosing a name must not navigate away");
  await home.setViewportSize({ width: 390, height: 844 });
  await home.screenshot({ path: "qa/shots/welcome-home.png", fullPage: true });
  await home.emulateMedia({ colorScheme: "dark" });
  await home.screenshot({ path: "qa/shots/welcome-dark.png", fullPage: true });
  await home.emulateMedia({ colorScheme: "light" });
  console.log("PASS Home identity, team-only welcome, event format, website guide, plain rules, narrow names");

  const direct = await ctx.newPage();
  holdEvent = true;
  const seen = eventRequests;
  await direct.goto(`${BASE}/submit`);
  await expect.poll(() => eventRequests).toBeGreaterThan(seen);
  assert.equal(stateRequests, 0, "Protected child must not mount before event status");
  await expect(direct.getByText("__qa Round 1 task")).toHaveCount(0);
  holdEvent = false;
  await expect(direct).toHaveURL(`${BASE}/`);
  for (const path of ["/leaderboard", "/feed"]) {
    await direct.goto(`${BASE}${path}`);
    await expect(direct).toHaveURL(`${BASE}/`);
  }
  eventError = true;
  await direct.goto(`${BASE}/submit`);
  await expect(direct.getByText(/Offline event status/)).toBeVisible();
  assert.equal(stateRequests, 0, "Failed status must not mount protected child");
  const admin = await ctx.newPage();
  admin.on("dialog", (dialog) => dismissConfirmation ? dialog.dismiss() : dialog.accept());
  await admin.goto(`${BASE}/admin`);
  await expect(admin.getByRole("button", { name: labels[0], exact: true })).toBeVisible();
  await direct.goto(BASE);
  await expect(direct.getByRole("heading", { name: "Rules", exact: true })).toBeVisible();
  playerError = true;
  await direct.goto(BASE);
  await expect(direct.getByText(/Offline player list/)).toBeVisible();
  await expect(direct.getByText(/no team yet|not on a.*team|no name matches/i)).toHaveCount(0);
  playerError = false;
  eventError = false;
  await direct.close();
  console.log("PASS delayed/error event gate, deep links, organizer/Home recovery");

  const documentId = await home.evaluate(() => window.__welcomeDocument);
  const advance = async (index) => {
    const button = admin.getByRole("button", { name: labels[index], exact: true });
    await expect(button).toBeVisible();
    holdAdmin = true;
    const seenAdmin = adminRequests;
    await expect.poll(() => adminRequests).toBeGreaterThan(seenAdmin);
    await button.click();
    await pause(200);
    await expect(button).toBeDisabled();
    holdAdmin = false;
    if (index < 4) await expect(admin.getByRole("button", { name: labels[index + 1], exact: true })).toBeVisible();
    assert.equal(stage, index + 1);
  };
  await advance(0);
  await expect(home.getByRole("link", { name: "View tasks", exact: true })).toBeVisible();
  assert.equal(new URL(home.url()).pathname, "/");
  for (const name of ["Tasks", "Scores", "Feed"]) await expect(navLink(home, name)).toBeVisible();
  const tasks = await ctx.newPage();
  await tasks.goto(`${BASE}/submit`);
  await expect(tasks.getByText("__qa Round 1 task", { exact: true })).toBeVisible();
  await expect(tasks.getByRole("button", { name: "Upload", exact: true })).toBeEnabled();
  await expect(navLink(tasks, "Home")).not.toHaveClass("on");
  const tasksDocument = await tasks.evaluate(() => window.__welcomeDocument);
  const taskNode = await tasks.getByText("__qa Round 1 task", { exact: true }).elementHandle();
  assert(taskNode, "The mounted task must exist before ending the round");
  await advance(1);
  await expect(admin.getByRole("button", { name: "Reopen Round 1", exact: true })).toBeVisible();
  await expect(tasks.getByRole("button", { name: "Upload", exact: true })).toBeDisabled();
  await expect(tasks.getByText("__qa Round 1 task", { exact: true })).toBeVisible();
  assert(await taskNode.evaluate((node) => node.isConnected), "Ending the round must not unmount Tasks");
  assert.equal(await tasks.evaluate(() => window.__welcomeDocument), tasksDocument);
  eventError = true;
  await expect(home.getByText(/Offline event status/)).toBeVisible();
  await expect(navLink(home, "Tasks")).toBeVisible();
  assert(await taskNode.evaluate((node) => node.isConnected), "Poll errors must retain the mounted task page");
  eventError = false;
  const feed = await ctx.newPage();
  await feed.goto(`${BASE}/feed`);
  await expect(feed.getByRole("heading", { name: "Feed", exact: true })).toBeVisible();
  await expect(feed.getByRole("button", { name: "Round 2", exact: true })).toHaveCount(0);
  const scores = await ctx.newPage();
  await scores.goto(`${BASE}/leaderboard`);
  await expect(scores.getByRole("heading", { name: "Scores", exact: true })).toBeVisible();
  await expect(scores.getByRole("button", { name: "Round 2", exact: true })).toHaveCount(0);

  refuseReveal = true;
  await admin.getByRole("button", { name: labels[2], exact: true }).click();
  await expect(admin.getByText("A Round 1 upload is still in progress", { exact: true })).toBeVisible();
  assert.equal(stage, 2);
  refuseReveal = false;
  // An in-flight old-roster response must never be relabelled as Round 2.
  holdPlayers = true;
  const seenPlayers = playerRequests;
  await expect.poll(() => playerRequests).toBeGreaterThan(seenPlayers);
  await advance(2);
  await expect(admin.getByRole("button", { name: "Reopen Round 1", exact: true })).toHaveCount(0);
  await expect(navLink(home, "Tasks")).toHaveCount(0);
  await expect(home.getByRole("link", { name: "View tasks", exact: true })).toHaveCount(0);
  if (await home.getByText(teammate.name, { exact: true }).count()) {
    await expect(home.getByRole("heading", { name: "Your Round 2 team", exact: true })).toHaveCount(0);
  }
  holdPlayers = false;
  await expect(home.getByRole("heading", { name: "Your Round 2 team", exact: true })).toBeVisible();
  await expect(home.getByText(remixMate.name, { exact: true })).toBeVisible();
  await expect(home.getByText(teammate.name, { exact: true })).toHaveCount(0);
  await expect(home.getByRole("region", { name: "Event status" })).toContainText("when Jason starts the round");
  await expect(tasks).toHaveURL(`${BASE}/`);
  await tasks.goto(`${BASE}/submit`);
  await expect(tasks).toHaveURL(`${BASE}/`);
  await expect(navLink(home, "Scores")).toBeVisible();
  await expect(navLink(home, "Feed")).toBeVisible();
  await expect(feed.getByRole("button", { name: "Round 2", exact: true })).toHaveCount(0);
  console.log("PASS start, break read-only, refused reveal, remix roster and hidden future tasks");

  await advance(3);
  await expect(home.getByRole("link", { name: "View tasks", exact: true })).toBeVisible();
  assert.equal(new URL(home.url()).pathname, "/");
  await expect(feed.getByRole("button", { name: "Round 2", exact: true })).toBeVisible();
  await feed.getByRole("button", { name: "Round 1", exact: true }).click();
  await expect(feed.getByRole("button", { name: "Round 1", exact: true })).toHaveClass("on");
  await tasks.goto(`${BASE}/submit`);
  await expect(tasks.getByText("__qa Round 2 task", { exact: true })).toBeVisible();
  await expect(tasks.getByRole("button", { name: "Upload", exact: true })).toBeEnabled();
  await advance(4);
  await expect(tasks.getByRole("button", { name: "Upload", exact: true })).toBeDisabled();
  await expect(navLink(home, "Tasks")).toBeVisible();
  await expect(feed.getByRole("button", { name: "Round 1", exact: true })).toHaveClass("on");
  assert.equal(await home.evaluate(() => window.__welcomeDocument), documentId, "Phase polls must never reload Home");
  assert.deepEqual(sentActions, actions);
  await admin.getByRole("button", { name: "Reopen Round 2", exact: true }).click();
  await expect(admin.getByRole("button", { name: "End Round 2", exact: true })).toBeEnabled();
  await expect(tasks.getByRole("button", { name: "Upload", exact: true })).toBeEnabled();
  await expect(tasks.getByText("__qa Round 2 task", { exact: true })).toBeVisible();
  assert.deepEqual(sentActions, [...actions, "reopen_round_2"]);
  const backToWelcome = admin.getByRole("button", { name: "Return to welcome", exact: true });
  await expect(backToWelcome).toBeVisible();
  dismissConfirmation = true;
  await backToWelcome.click();
  assert.equal(stage, 4, "Dismissing confirmation must leave the event running");
  assert.deepEqual(sentActions, [...actions, "reopen_round_2"]);
  dismissConfirmation = false;
  refuseWelcome = true;
  await backToWelcome.click();
  await expect(admin.getByText(/before returning to welcome/)).toBeVisible();
  assert.equal(stage, 4, "In-progress uploads must prevent the return");
  await expect(tasks.getByText("__qa Round 2 task", { exact: true })).toBeVisible();
  refuseWelcome = false;
  await backToWelcome.click();
  await expect(admin.getByRole("button", { name: "Start Round 1", exact: true })).toBeEnabled();
  await expect(backToWelcome).toHaveCount(0);
  for (const page of [tasks, feed, scores]) await expect(page).toHaveURL(`${BASE}/`);
  await expect(home.getByRole("heading", { name: "Your Round 1 team", exact: true })).toBeVisible();
  await expect(home.getByText(teammate.name, { exact: true })).toBeVisible();
  await expect(home.getByText(me.name, { exact: true }).first()).toBeVisible();
  for (const name of ["Tasks", "Scores", "Feed"]) await expect(navLink(home, name)).toHaveCount(0);
  await expect(home.getByRole("link", { name: "View tasks", exact: true })).toHaveCount(0);
  assert.equal(await home.evaluate(() => window.__welcomeDocument), documentId);
  await admin.getByRole("button", { name: "Start Round 1", exact: true }).click();
  await expect(home.getByRole("link", { name: "View tasks", exact: true })).toBeVisible();
  assert.deepEqual(sentActions, [...actions, "reopen_round_2", "return_to_welcome", "start_round_1"]);
  assert.deepEqual(refused, [], "Every API and external request must be explicitly mocked");
  console.log("PASS Round 2 start/end/reopen, historical Feed, all five actions, no reloads");
  console.log("PASS return to welcome, confirmation, upload refusal and rehearsal restart");
  console.log("real data intact: true (all API requests mocked; no database credentials)");
} finally {
  holdEvent = holdPlayers = holdAdmin = false;
  clearTimeout(deadline);
  await browser.close();
}
