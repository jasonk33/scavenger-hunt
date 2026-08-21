/**
 * What does each polled screen say before its first data arrives?
 *
 * Two failure shapes matter: showing nothing at all (reads as broken), and --
 * worse -- showing a confident wrong answer. /judge is included because an empty
 * `queue` array is indistinguishable from "not loaded yet" unless the screen
 * checks, and telling an organizer the queue is clear when it isn't is the kind
 * of thing that gets a backlog abandoned.
 *
 * The pre-load window is created deterministically by holding the screen's data
 * endpoint, not by racing the network: sampling "whatever is on screen right
 * after domcontentloaded" is timing-dependent and silently stops testing
 * anything the moment a screen gains an earlier render phase to sample instead.
 */
import { chromium } from "@playwright/test";
import {
  BASE, asOrganizer, asPlayer, setup, teardown, call, check, note, summary, snapshot,
} from "./lib.mjs";

const HOLD_MS = 4000;

// `skipFirst` exists because /judge probes the same endpoint once to test the
// PIN before mounting the queue; holding that call would freeze the auth gate
// instead of the screen under test.
const SCREENS = [
  { route: "/leaderboard", api: "**/api/leaderboard**", skipFirst: 0, heading: "Scores" },
  { route: "/feed", api: "**/api/feed**", skipFirst: 0, heading: "Feed" },
  { route: "/judge", api: "**/api/judge/queue**", skipFirst: 1, heading: "Judge" },
  { route: "/submit", api: "**/api/state**", skipFirst: 0, heading: "", player: true },
];

const before = await snapshot();
await teardown();
const fx = await setup({ players: ["__qa Loader"], teams: ["__qa LoadTeam"] });
const player = fx.player("__qa Loader");
await call("/api/admin/roster", {
  method: "POST",
  body: JSON.stringify({ round: 1, entries: [{ playerId: player.id, teamId: fx.teamOf("__qa LoadTeam", 1).id }] }),
});

const browser = await chromium.launch();
try {
  for (const s of SCREENS) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await asOrganizer(ctx);
    if (s.player) await asPlayer(ctx, player);
    const page = await ctx.newPage();

    let seen = 0;
    let held = false;
    await page.route(s.api, async (route) => {
      seen += 1;
      if (seen > s.skipFirst) {
        held = true;
        await new Promise((r) => setTimeout(r, HOLD_MS));
      }
      await route.continue();
    });

    await page.goto(`${BASE}${s.route}`, { waitUntil: "domcontentloaded" });
    // Wait until the held request is actually in flight, so we sample the real
    // pre-load window rather than whatever renders first.
    const t0 = Date.now();
    while (!held && Date.now() - t0 < 20000) await page.waitForTimeout(50);
    await page.waitForTimeout(600);
    check(`${s.route} holds its data request (window is real)`, held);

    const body = (await page.evaluate(() => {
      const wrap = document.querySelector(".wrap");
      return wrap ? wrap.innerText.replace(/\s+/g, " ").trim() : "";
    }))
      .replace(new RegExp(`^${s.heading || "\\u0000"}`), "")
      .replace(/^__qa Loader switch/, "")
      .replace(/Round 1 Round 2/, "")
      .replace(/\d+ waiting/, "")
      .trim();

    note(`${s.route.padEnd(13)} while loading: ${JSON.stringify(body.slice(0, 60))}`);

    check(`${s.route} shows something rather than an empty page while loading`,
      body.length > 0, "nothing but the heading and the round toggle");

    // The one that actually matters: a screen may say nothing, but it must never
    // assert a result it does not have.
    check(`${s.route} does not claim a result before its data has loaded`,
      !/Queue is empty|Nothing approved yet|Nothing waiting|Nothing scored|no team|not on a Round/i.test(body),
      `claimed "${body.slice(0, 70)}" while its data request was still in flight`);

    // And it must recover once the data lands.
    const settled = await page.waitForFunction(
      () => document.querySelectorAll(".card-flat, .media-box, .empty, .card").length > 0,
      { timeout: 30000 }).then(() => true).catch(() => false);
    check(`${s.route} renders its data once the request completes`, settled);

    await ctx.close();
  }
} finally {
  await browser.close();
  await teardown();
  const after = await snapshot();
  console.log(`\nreal data intact: ${JSON.stringify(before) === JSON.stringify(after)}`);
  summary("Loading states");
}
