/**
 * Player renames must reach already-open phones, not just the guest list.
 * All API requests are mocked; no database client or live fixtures are used.
 */
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
assert.match(BASE, /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/);
const cached = { id: "__qa-player", name: "__qa Jessica Formal" };
const team = { id: "__qa-team", name: "__qa Red", color: "#dc2626" };
let name = "__qa Jess";
let exists = true;
const unexpected = [];
const errors = [];
const browser = await chromium.launch({ headless: process.env.PW_HEADLESS === "true" });
const deadline = setTimeout(() => {
  console.error("Player-name probe exceeded 55 seconds.");
  process.exitCode = 1;
  void browser.close();
}, 55000);

try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript((player) => {
    if (sessionStorage.getItem("__qa-name-initialized")) return;
    localStorage.setItem("sh.player", JSON.stringify(player));
    sessionStorage.setItem("sh.previous", JSON.stringify(player));
    sessionStorage.setItem("__qa-name-initialized", "true");
  }, cached);
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
    const send = (body) => route.fulfill({
      contentType: "application/json",
      headers: { "x-name-probe": "mocked" },
      body: JSON.stringify(body),
    });
    if (url.pathname === "/api/notice") return send({ notice: "" });
    if (url.pathname === "/api/players") {
      return send({ eventName: "__qa Event", players: exists ? [{ id: cached.id, name, team }] : [] });
    }
    if (url.pathname === "/api/state") {
      assert.equal(url.searchParams.get("playerId"), cached.id);
      return send({
        settings: { round: 1, submissions_open: true, saved_epoch: "" },
        me: exists ? { id: cached.id, name } : null,
        team: exists ? team : null,
        tasks: [], submissions: [], rejections: [],
        stats: { submitted: 0, pending: 0, approved: 0, rejected: 0, points: 0 },
        upload: {
          endpoint: "https://upload.invalid",
          anonKey: "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.signature",
          bucket: "__qa",
        },
      });
    }
    unexpected.push(`${request.method()} ${url.pathname}`);
    return route.abort();
  });
  page.on("response", (response) => {
    if (new URL(response.url()).pathname.startsWith("/api/") && response.headers()["x-name-probe"] !== "mocked") {
      unexpected.push(`Unmocked response: ${response.url()}`);
    }
  });

  await page.goto(`${BASE}/submit`, { waitUntil: "domcontentloaded" });
  await expect(page.getByText(team.name, { exact: true })).toBeVisible();
  await expect(page.locator("header h1")).toHaveText(name);
  await page.getByTitle("Not you? Tap to switch").click();
  await expect(page.getByText(`You're submitting as ${name}`, { exact: true })).toBeVisible();
  await expect(page.locator(".wrap")).not.toContainText(cached.name);

  name = "__qa Jess Updated";
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.locator("header h1")).toHaveText(name);
  await expect(page.getByText(`You're submitting as ${name}`, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Pick a different name", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Who are you?", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: new RegExp(name) })).toBeVisible();
  await expect(page.getByText(`You were just ${name}.`, { exact: true })).toBeVisible();
  await expect(page.locator(".wrap")).not.toContainText(cached.name);
  await page.getByRole("button", { name: "Go back", exact: true }).click();
  await expect(page.locator("header h1")).toHaveText(name);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("sh.player")));
  assert.deepEqual(stored, { id: cached.id, name });

  exists = false;
  await page.evaluate(() => localStorage.removeItem("sh.player"));
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await expect(page.getByText("No name matches that", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Go back", exact: true })).toHaveCount(0);
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  console.log("Current names reach Submit, its switch confirmation, and the previous-player shortcut.");
  console.log("real data intact: true (every API response mocked; no database connection)");
} finally {
  clearTimeout(deadline);
  await browser.close();
}
