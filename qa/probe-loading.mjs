/** How long does each screen show nothing before its first data arrives? */
import { chromium } from "@playwright/test";
import { BASE, PIN, check, note, summary } from "./lib.mjs";

const browser = await chromium.launch();
try {
  for (const [label, down, up] of [["fast 5G", -1, -1], ["weak signal", 200 * 1024, 100 * 1024]]) {
    console.log(`\n--- ${label}`);
    for (const route of ["/leaderboard", "/feed"]) {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
      await ctx.addCookies([{ name: "organizer", value: PIN, domain: "localhost", path: "/" }]);
      const page = await ctx.newPage();
      const cdp = await ctx.newCDPSession(page);
      await cdp.send("Network.enable");
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false, latency: down === -1 ? 0 : 300, downloadThroughput: down, uploadThroughput: up });

      await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded" });
      const t0 = Date.now();
      // What is on screen below the header before any data lands?
      const early = await page.evaluate(() => {
        const wrap = document.querySelector(".wrap");
        return wrap ? wrap.innerText.replace(/\s+/g, " ").trim() : "";
      });
      const gotRows = await page.waitForFunction(
        () => document.querySelectorAll(".card-flat, .media-box").length > 0,
        { timeout: 30000 }).then(() => true).catch(() => false);
      const ms = Date.now() - t0;
      const bodyAfterHeader = early.replace(/^Scores|^Feed/, "").replace(/Round 1 Round 2/, "").trim();
      check(`${route} (${label}) reaches its data`, gotRows || early.includes("Nothing approved"), `after ${ms}ms`);
      note(`${route.padEnd(13)} blank for ~${ms}ms; pre-load body: ${JSON.stringify(bodyAfterHeader.slice(0, 60))}`);
      check(`${route} (${label}) shows something other than an empty page while loading`,
        bodyAfterHeader.length > 0,
        `nothing but the heading and the round toggle for ~${ms}ms`);
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  summary("Loading states");
}
