/**
 * Scores roster, spoiler gate, and round navigation. Every API response is
 * mocked: no qa/lib.mjs import, database connection, or live settings writes.
 */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
assert.match(BASE, /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/);
const names = [
  "__qa Alexandria Montgomery-Sinclair",
  "__qa BenjaminChristopherVeryLongUnbrokenSurname",
  "__qa Casey Chen",
  "__qa Danielle de la Cruz",
  "__qa Emerson Reid",
  "__qa Finley Brooks",
];
const members = (...ids) => ids.map((id) => ({ id: `p${id}`, name: names[id] }));
const row = (round, team, people, points = 0) => ({
  teamId: `r${round}-${team}`,
  name: `__qa ${round === 1 ? "Original" : "Secret Remix"} ${team}`,
  color: team === "A" ? "#dc2626" : "#2563eb",
  points, tasksScored: points ? 1 : 0, pending: 0, members: people,
});
const boards = {
  1: [row(1, "A", members(0, 1, 2, 3, 4), 12), row(1, "B", members(5)), row(1, "Empty", [])],
  2: [row(2, "A", members(1, 2, 3, 4, 5), 15), row(2, "B", members(0)), row(2, "Empty", [])],
};
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const firstSeen = deferred();
const firstRelease = deferred();
const historySeen = deferred();
const historyRelease = deferred();
let initial = true;
let holdHistory = false;
let activeRound = 1;
const requests = [];
const unexpected = [];
const errors = [];
const started = Date.now();
const browser = await chromium.launch({ headless: process.env.PW_HEADLESS === "true" });
const deadline = setTimeout(() => {
  console.error("Scores roster probe exceeded 55 seconds.");
  process.exitCode = 1;
  void browser.close();
}, 55000);

try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== "GET") {
      unexpected.push(`${request.method()} ${url.pathname}`);
      return route.abort();
    }
    const send = (body, status = 200) => route.fulfill({
      status,
      contentType: "application/json",
      headers: { "x-scores-probe": "mocked" },
      body: JSON.stringify(body),
    });
    if (url.pathname === "/api/notice") return send({ notice: "" });
    if (url.pathname === "/api/leaderboard") {
      const requested = Number(url.searchParams.get("round")) || activeRound;
      const round = Math.min(requested, activeRound);
      requests.push({ requested, activeRound });
      const body = structuredClone({ round, activeRound, totalPending: 0, rows: boards[round] });
      if (initial) {
        firstSeen.resolve();
        await firstRelease.promise;
      } else if (holdHistory && requested === 1) {
        historySeen.resolve();
        await historyRelease.promise;
      }
      return send(body);
    }
    if (url.pathname.startsWith("/api/leaderboard/")) {
      const round = Number(url.searchParams.get("round")) || activeRound;
      const team = boards[round]?.find((team) => url.pathname.endsWith(`/${team.teamId}`));
      if (round > activeRound || !team) return send({ error: "Team not available" }, 404);
      return send({ round, team: { id: team.teamId, name: team.name, color: team.color }, entries: [] });
    }
    unexpected.push(`${request.method()} ${url.pathname}`);
    return route.abort();
  });
  page.on("response", (response) => {
    if (new URL(response.url()).pathname.startsWith("/api/") && response.headers()["x-scores-probe"] !== "mocked") {
      unexpected.push(`Unmocked response: ${response.url()}`);
    }
  });
  const poll = () => page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  const rosterLine = () => page.locator(".team-members").first();
  const rosterText = (round) => boards[round][0].members.map((member) => member.name).join(", ");

  await page.goto(`${BASE}/leaderboard`, { waitUntil: "domcontentloaded" });
  await firstSeen.promise;
  await expect(page.getByText("Loading…", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Round 2", exact: true })).toHaveCount(0);
  await expect(page.locator(".team-members")).toHaveCount(0);
  await expect(page.getByText("No players assigned", { exact: true })).toHaveCount(0);
  initial = false;
  firstRelease.resolve();
  await expect(rosterLine()).toHaveText(rosterText(1));
  await expect(page.getByRole("button", { name: "Round 2", exact: true })).toHaveCount(0);
  await expect(page.locator(".wrap")).not.toContainText("Secret Remix");
  await expect(page.getByText("No players assigned", { exact: true })).toBeVisible();
  assert.ok(requests.every((request) => request.requested === 1));
  console.log("Round 1: member names visible; no future round control, names, or request.");

  for (const width of [390, 320, 260]) {
    await page.setViewportSize({ width, height: 844 });
    const geometry = await page.locator(".team-members").evaluateAll((elements) => ({
      pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
      names: elements.map((element) => ({
        width: element.clientWidth,
        clipped: element.scrollWidth - element.clientWidth,
        heightClipped: element.scrollHeight - element.clientHeight,
        textOverflow: getComputedStyle(element).textOverflow,
        fontSize: parseFloat(getComputedStyle(element).fontSize),
      })),
    }));
    assert.ok(geometry.names.length > 0);
    assert.ok(geometry.pageOverflow <= 1, `${width}px page overflow: ${geometry.pageOverflow}`);
    for (const name of geometry.names) {
      assert.ok(name.width > 0 && name.clipped <= 1 && name.heightClipped <= 1, `${width}px clipped member names`);
      assert.notEqual(name.textOverflow, "ellipsis");
      assert.ok(name.fontSize >= 14, "member names must remain readable");
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await mkdir(new URL("./shots/", import.meta.url), { recursive: true });
  await page.screenshot({ path: new URL("./shots/scores-roster-round1.png", import.meta.url).pathname, fullPage: false });

  await page.locator(".card-flat").first().getByRole("button").click();
  await expect(page.getByText("No scored entries yet", { exact: true })).toBeVisible();
  await expect(rosterLine()).toHaveText(rosterText(1));
  activeRound = 2;
  await poll();
  await expect(rosterLine()).toHaveText(rosterText(2));
  await expect(page.getByRole("button", { name: "Round 2", exact: true })).toHaveClass("on");
  await expect(page.getByRole("button", { name: "Round 1", exact: true })).toBeVisible();
  await expect(page.getByText("No scored entries yet", { exact: true })).toHaveCount(0);

  holdHistory = true;
  await page.getByRole("button", { name: "Round 1", exact: true }).click();
  await historySeen.promise;
  await expect(page.getByText("Loading…", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Round 2", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Round 2", exact: true }).click();
  await expect(rosterLine()).toHaveText(rosterText(2));
  const lateResponse = page.waitForResponse((response) => response.url().includes("/api/leaderboard?round=1"));
  holdHistory = false;
  historyRelease.resolve();
  await (await lateResponse).finished();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(rosterLine()).toHaveText(rosterText(2));

  await page.getByRole("button", { name: "Round 1", exact: true }).click();
  await expect(rosterLine()).toHaveText(rosterText(1));
  await expect(page.getByRole("button", { name: "Round 1", exact: true })).toHaveClass("on");
  boards[1][0].members[0].name = "__qa Updated Guest Name";
  await poll();
  await expect(rosterLine()).toContainText("__qa Updated Guest Name");
  activeRound = 1;
  await poll();
  await expect(page.getByRole("button", { name: "Round 2", exact: true })).toHaveCount(0);
  await expect(rosterLine()).toHaveText(rosterText(1));
  activeRound = 2;
  await poll();
  await expect(rosterLine()).toHaveText(rosterText(2));
  await expect(page.getByRole("button", { name: "Round 2", exact: true })).toHaveClass("on");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: new URL("./shots/scores-roster-round2-dark.png", import.meta.url).pathname, fullPage: false });
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  console.log("Round 2: active view, historical roster, slow-request escape, and reset behavior pass.");
  console.log("real data intact: true (every API response mocked; no database connection)");
  console.log(`Scores roster probe passed in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
} finally {
  firstRelease.resolve();
  historyRelease.resolve();
  clearTimeout(deadline);
  await browser.close();
}
