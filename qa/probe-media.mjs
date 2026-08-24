/** Does media actually render for the judge and in the feed? Photos and video. */
import { chromium } from "@playwright/test";
import {
  BASE, admin, setup, teardown, snapshot, captureSettings, restoreSettings, seed, check, note, summary, call, asOrganizer,
} from "./lib.mjs";

const before = await snapshot();
const settingsBefore = await captureSettings();
let browser;

try {
  await teardown();
  const fx = await setup();
  const alice = fx.player("__qa Alice");
  const red1 = fx.teamOf("__qa Red", 1);
  await call("/api/admin/roster", {
    method: "POST",
    body: JSON.stringify({ round: 1, entries: [{ playerId: alice.id, teamId: red1.id }] }),
  });

  // Cut tasks keep their row and now keep a position in the ordering too --
  // sort_order is generated for every row, live or not -- so an unfiltered pick
  // can land on one, and /api/submissions rightly refuses it as "no longer
  // exists". Filter here, as flow6 already does.
  const { data: tasks } = await admin.from("tasks").select("id,title").eq("round", 1).eq("active", true).order("sort_order").limit(2);
  await seed({ playerId: alice.id, taskId: tasks[0].id, file: "photo.jpg" });
  await seed({ playerId: alice.id, taskId: tasks[1].id, file: "clip.mp4", name: "IMG_1.mov" });

  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await asOrganizer(ctx);
  const page = await ctx.newPage();

  const failedRequests = [];
  page.on("requestfailed", (r) => failedRequests.push(`${r.url().slice(0, 80)} ${r.failure()?.errorText}`));
  page.on("response", (r) => { if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.url().slice(0, 90)}`); });

  console.log("\n1. Judge card — photo");
  await page.goto(`${BASE}/judge`, { waitUntil: "networkidle" });
  await page.waitForSelector(".media-box img, .media-box video", { timeout: 15000 });

  const src = await page.locator(".media-box img, .media-box video").first().getAttribute("src");
  note(`media src: ${String(src).slice(0, 110)}`);

  const loaded = await page.waitForFunction(() => {
    const img = document.querySelector(".media-box img");
    if (!img) return false;
    return img.complete && img.naturalWidth > 0;
  }, { timeout: 20000 }).then(() => true).catch(() => false);
  const dims = await page.evaluate(() => {
    const img = document.querySelector(".media-box img");
    return img ? { complete: img.complete, nw: img.naturalWidth, nh: img.naturalHeight,
                   cw: img.clientWidth, ch: img.clientHeight } : null;
  });
  check("judge photo decodes and has real pixels", loaded, JSON.stringify(dims));
  note(`rendered at ${dims?.cw}x${dims?.ch} from ${dims?.nw}x${dims?.nh}`);
  check("judge photo is actually visible (non-zero box)", (dims?.cw ?? 0) > 0 && (dims?.ch ?? 0) > 0, JSON.stringify(dims));

  await page.screenshot({ path: new URL("./shots/judge-photo.png", import.meta.url).pathname });

  console.log("\n2. Judge card — video");
  // Approve the photo so the video becomes head of queue.
  await page.getByRole("button", { name: /^Approve/ }).click();
  await page.waitForTimeout(2000);
  await page.waitForSelector(".media-box video", { timeout: 15000 }).catch(() => {});
  const hasVideo = await page.locator(".media-box video").count();
  check("video submission renders a <video> element", hasVideo > 0);
  const vsrc = await page.locator(".media-box video").first().getAttribute("src").catch(() => null);
  check("video src carries the #t=0.1 poster-frame fragment", String(vsrc).includes("#t=0.1"), String(vsrc));
  check("video has preload=auto", await page.locator(".media-box video").first().getAttribute("preload") === "auto");
  check("video has playsinline", await page.locator(".media-box video").first().getAttribute("playsinline") !== null);

  const vmeta = await page.waitForFunction(() => {
    const v = document.querySelector(".media-box video");
    return v && v.readyState >= 1 ? { w: v.videoWidth, h: v.videoHeight, rs: v.readyState, d: v.duration } : false;
  }, { timeout: 20000 }).then((h) => h.jsonValue()).catch(() => null);
  check("video metadata loads (judge can actually play it)", Boolean(vmeta?.w), JSON.stringify(vmeta));
  note(`video: ${JSON.stringify(vmeta)}`);
  await page.screenshot({ path: new URL("./shots/judge-video.png", import.meta.url).pathname });

  console.log("\n3. Feed renders approved media");
  await page.getByRole("button", { name: /^Approve/ }).click();
  await page.waitForTimeout(2000);
  const feed = await ctx.newPage();
  await feed.goto(`${BASE}/feed`, { waitUntil: "networkidle" });
  await feed.waitForTimeout(2500);
  const feedImgs = await feed.evaluate(() =>
    [...document.querySelectorAll(".media-box img, .media-box video")].map((el) =>
      el.tagName === "IMG"
        ? { t: "img", lazy: el.loading === "lazy", ok: el.complete && el.naturalWidth > 0 }
        : { t: "video", ok: el.readyState >= 1 })
  );
  note(`feed media: ${JSON.stringify(feedImgs)}`);
  check("feed shows the approved submissions", feedImgs.length >= 2, JSON.stringify(feedImgs));

  /*
   * Scroll a photo in and prove THAT one decodes, rather than asserting every
   * photo on the page has loaded. Feed photos carry loading="lazy" on purpose --
   * a fully-scored round is hundreds of files -- so the blanket version passed
   * or failed on how much history happened to exist, not on whether media works.
   */
  const firstImg = feed.locator(".media-box img").first();
  check("the feed has a photo in it", await firstImg.count() > 0, JSON.stringify(feedImgs));
  await firstImg.scrollIntoViewIfNeeded();
  const imgHandle = await firstImg.elementHandle();
  const imgOk = await feed
    .waitForFunction((el) => el.complete && el.naturalWidth > 0, imgHandle, { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  check(
    "a feed photo scrolled into view actually decodes",
    imgOk,
    JSON.stringify(await firstImg.evaluate((el) => ({ complete: el.complete, w: el.naturalWidth })))
  );
  await feed.screenshot({ path: new URL("./shots/feed.png", import.meta.url).pathname, fullPage: true });

  console.log("\nnetwork failures: " + (failedRequests.length ? failedRequests.join(" | ") : "none"));
  check("no failed media requests", failedRequests.length === 0, failedRequests.join(" | "));
} finally {
  if (browser) await browser.close();
  await teardown();
  await restoreSettings(settingsBefore);
  const after = await snapshot();
  console.log(`\nreal data intact: ${JSON.stringify(before) === JSON.stringify(after)}`);
  summary("Media rendering");
}
