/**
 * Flow 6 — scoring invariants that would be silently wrong rather than loudly
 * broken, plus how heavy the feed actually is on a phone.
 */
import { chromium } from "@playwright/test";
import {
  BASE, PIN, admin, setup, teardown, snapshot, captureSettings, restoreSettings, seed, check, note, summary, call, cloneSubmission, asOrganizer,
} from "./lib.mjs";

const before = await snapshot();
const settingsBefore = await captureSettings();
let browser;

const score = async (round, teamId) => {
  const lb = await (await fetch(`${BASE}/api/leaderboard?round=${round}`)).json();
  return (lb.rows ?? []).find((r) => r.teamId === teamId) ?? null;
};

try {
  await teardown();
  const fx = await setup();
  const alice = fx.player("__qa Alice"), bob = fx.player("__qa Bob");
  const red1 = fx.teamOf("__qa Red", 1);
  await call("/api/admin/roster", { method: "POST", body: JSON.stringify({ round: 1, entries: [
    { playerId: alice.id, teamId: red1.id }, { playerId: bob.id, teamId: red1.id },
  ] }) });
  // Cut tasks are deactivated rather than deleted, and the API refuses a
  // submission to one -- so an unfiltered pick lands on a board cut and the
  // driver dies before it asserts anything.
  const { data: tasks } = await admin.from("tasks").select("id,title,points").eq("round", 1).eq("points", 5).eq("active", true).limit(2);
  const task = tasks[0];
  note(`using a ${task.points}-point task, two teammates both submitting it`);

  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await asOrganizer(ctx);
  const judge = await ctx.newPage();

  /* ---- once per team ---- */
  console.log("\n1. Two teammates submit the SAME task and both get approved");
  const s1 = await seed({ playerId: alice.id, taskId: task.id });
  const s2 = await seed({ playerId: bob.id, taskId: task.id });

  await judge.goto(`${BASE}/judge`, { waitUntil: "networkidle" });
  await judge.waitForSelector(".media-box", { timeout: 15000 });
  await judge.getByRole("button", { name: /^Approve/ }).click();
  await judge.waitForTimeout(2000);
  const afterFirst = await score(1, red1.id);
  note(`after the first approval: ${JSON.stringify(afterFirst)}`);

  await judge.waitForSelector(".media-box", { timeout: 15000 }).catch(() => {});
  const dupWarned = await judge.getByText("team already has this task approved", { exact: false }).count();
  check("the judge is warned the team already has this task", dupWarned > 0);
  await judge.getByRole("button", { name: /^Approve/ }).click();
  await judge.waitForTimeout(2000);
  const afterSecond = await score(1, red1.id);
  note(`after the duplicate approval: ${JSON.stringify(afterSecond)}`);

  check("a task counts ONCE per team even when two teammates both get approved",
    afterSecond.points === afterFirst.points,
    `score went ${afterFirst.points} -> ${afterSecond.points}; the same task was paid twice`);
  check("tasksScored does not double-count", afterSecond.tasksScored === afterFirst.tasksScored,
    `${afterFirst.tasksScored} -> ${afterSecond.tasksScored}`);

  /* ---- best-of wins ---- */
  console.log("\n2. The better of two duplicates is the one that counts");
  await call(`/api/judge/${s2}`, { method: "POST", body: JSON.stringify({
    action: "approve", bonus: 2, expectedStatus: "approved" }) });
  const withBonus = await score(1, red1.id);
  note(`after adding a +2 bonus to the duplicate: ${JSON.stringify(withBonus)}`);
  check("the higher-scoring duplicate is the one counted",
    withBonus.points === task.points + 2,
    `expected ${task.points + 2}, got ${withBonus.points}`);

  console.log("\n3. Rejecting the better duplicate falls back to the other one");
  await call(`/api/judge/${s2}`, { method: "POST", body: JSON.stringify({
    action: "reject", reason: "Wrong round", expectedStatus: "approved" }) });
  const fallback = await score(1, red1.id);
  check("rejecting the best duplicate falls back to the remaining approval",
    fallback.points === task.points, `expected ${task.points}, got ${fallback.points}`);

  console.log("\n4. Rejecting every submission for a task zeroes it");
  await call(`/api/judge/${s1}`, { method: "POST", body: JSON.stringify({
    action: "reject", reason: "Wrong round", expectedStatus: "approved" }) });
  const zeroed = await score(1, red1.id);
  check("with all duplicates rejected the task pays nothing",
    (zeroed?.points ?? 0) === 0, JSON.stringify(zeroed));

  /* ---- bonus clamp ---- */
  console.log("\n5. Bonus cannot be gamed past the +2 cap");
  await call(`/api/judge/${s1}`, { method: "POST", body: JSON.stringify({
    action: "approve", bonus: 99, expectedStatus: "rejected" }) });
  const { data: clamped } = await admin.from("submissions").select("bonus").eq("id", s1).single();
  check("a bonus over the cap is clamped to 2", clamped.bonus === 2, String(clamped.bonus));
  await call(`/api/judge/${s1}`, { method: "POST", body: JSON.stringify({
    action: "bonus", bonus: -5, expectedStatus: "approved" }) });
  const { data: negative } = await admin.from("submissions").select("bonus").eq("id", s1).single();
  check("a negative bonus is clamped to 0", negative.bonus === 0, String(negative.bonus));

  /* ---- CSV export ---- */
  console.log("\n6. CSV export");
  const csvRes = await fetch(`${BASE}/api/export`, { headers: { cookie: `organizer=${PIN}` } });
  const csv = await csvRes.text();
  check("export returns a CSV", csvRes.ok && csv.includes(","), `${csvRes.status}`);
  check("export contains the __qa team", csv.includes("__qa Red"), csv.slice(0, 200));
  const anonCsv = await fetch(`${BASE}/api/export`);
  check("export is PIN-gated", anonCsv.status === 401, String(anonCsv.status));

  /* ---- feed weight ---- */
  console.log("\n7. How heavy is the feed on a phone?");
  const { data: template } = await admin.from("submissions").select("*").eq("id", s1).single();
  const clones = Array.from({ length: 40 }, (_, i) => {
    return cloneSubmission(template, { status: "approved", points_awarded: 5, bonus: 0,
             judged_at: new Date(Date.now() - i * 60000).toISOString() });
  });
  await admin.from("submissions").insert(clones);

  const feedCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const feed = await feedCtx.newPage();
  let bytes = 0, mediaRequests = 0;
  feed.on("response", async (r) => {
    if (/storage\/v1\/object\/public/.test(r.url())) {
      mediaRequests += 1;
      const len = Number(r.headers()["content-length"] ?? 0);
      bytes += len;
    }
  });
  await feed.goto(`${BASE}/feed`, { waitUntil: "networkidle" });
  await feed.waitForTimeout(4000);

  const imgInfo = await feed.evaluate(() => {
    const els = [...document.querySelectorAll(".media-box img, .media-box video")];
    return {
      total: els.length,
      lazy: els.filter((e) => e.getAttribute("loading") === "lazy").length,
      videosPreloadAuto: els.filter((e) => e.tagName === "VIDEO" && e.getAttribute("preload") === "auto").length,
    };
  });
  note(`feed rendered ${imgInfo.total} media elements; ${imgInfo.lazy} marked loading="lazy"`);
  note(`media requests fired on load: ${mediaRequests}, ~${(bytes / 1024 / 1024).toFixed(2)} MB`);
  check("the feed does not eagerly download every media item at once",
    imgInfo.lazy === imgInfo.total || mediaRequests < imgInfo.total,
    `${mediaRequests} media requests fired for ${imgInfo.total} items with 0 lazy — on a phone at the party this downloads the whole feed immediately`);
  note(`videos with preload="auto" in the feed: ${imgInfo.videosPreloadAuto}`);

  await feed.screenshot({ path: new URL("./shots/feed-heavy.png", import.meta.url).pathname });

} finally {
  if (browser) await browser.close();
  await teardown();
  await restoreSettings(settingsBefore);
  const after = await snapshot();
  const intact = JSON.stringify(before) === JSON.stringify(after);
  console.log(`\nreal data intact: ${intact}`);
  if (!intact) console.log("BEFORE", JSON.stringify(before), "\nAFTER ", JSON.stringify(after));
  summary("Flow 6 (scoring + feed weight)");
}
