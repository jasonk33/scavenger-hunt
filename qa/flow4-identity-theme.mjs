/**
 * Flow 4 — identity, theme, /go, notices, and the edge cases around editing
 * tasks and players while the event is live.
 */
import { chromium } from "@playwright/test";
import {
  BASE, admin, setup, teardown, teardownTasks, snapshot, captureSettings, restoreSettings, seed, check, note, summary, call, enabledUploadButtons,
} from "./lib.mjs";

const before = await snapshot();
const settingsBefore = await captureSettings();
let browser;

try {
  await teardown();
  const fx = await setup();
  const alice = fx.player("__qa Alice");
  const bob = fx.player("__qa Bob");
  const red1 = fx.teamOf("__qa Red", 1);
  await call("/api/admin/roster", { method: "POST", body: JSON.stringify({ round: 1, entries: [
    { playerId: alice.id, teamId: red1.id }, { playerId: bob.id, teamId: red1.id },
  ] }) });

  const { data: tasks } = await admin.from("tasks").select("id,title,points").eq("round", 1).order("sort_order").limit(3);

  browser = await chromium.launch();

  /* ---- identity switching ---- */
  console.log("\n1. Identity switching");
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "__qa Alice", exact: false }).first().click();
  await page.waitForURL("**/submit");
  check("joined as Alice", (await page.locator("h1").first().innerText()).includes("__qa Alice"));

  await page.locator("header button.btn-plain").click();
  check("tapping your name offers a switch", await page.getByText("You're submitting as", { exact: false }).count() > 0);
  check("switch panel says nothing has been submitted yet",
    await page.getByText("switching is clean", { exact: false }).count() > 0);
  await page.getByRole("button", { name: "Stay" }).click();
  check("'Stay' keeps the current identity", (await page.locator("h1").first().innerText()).includes("Alice"));

  await page.locator("header button.btn-plain").click();
  await page.getByRole("button", { name: "Pick a different name" }).click();
  await page.waitForURL(new RegExp(`${BASE}/?$`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), { timeout: 8000 }).catch(() => {});
  check("switching returns to the join screen", !page.url().includes("/submit"), page.url());
  const backBtn = page.getByRole("button", { name: /__qa Alice/ });
  check("'go back to Alice' is offered", await backBtn.count() > 0,
    (await page.locator("button").allInnerTexts()).slice(0, 8).join("|"));
  await page.getByRole("button", { name: "__qa Bob", exact: false }).first().click();
  await page.waitForURL("**/submit");
  check("can join as a different player", (await page.locator("h1").first().innerText()).includes("__qa Bob"));

  /* ---- switch warning once something is submitted ---- */
  console.log("\n2. Switch warning after a submission exists");
  await seed({ playerId: bob.id, taskId: tasks[0].id });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  await page.locator("header button.btn-plain").click();
  check("switch panel warns that submissions won't move",
    await page.getByText("Switching won't move those", { exact: false }).count() > 0,
    (await page.locator(".card-accent").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 120));
  await page.getByRole("button", { name: "Stay" }).click();

  /* ---- stale identity: the player row is deleted ---- */
  console.log("\n3. Stale identity — the player row is deleted underneath them");
  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx2.addInitScript(() => localStorage.setItem("sh.player",
    JSON.stringify({ id: "00000000-0000-0000-0000-000000000000", name: "Ghost" })));
  const ghost = await ctx2.newPage();
  await ghost.goto(`${BASE}/submit`, { waitUntil: "networkidle" });
  await ghost.waitForTimeout(3000);
  check("a deleted/unknown player is bounced back to the join screen",
    !ghost.url().includes("/submit"), ghost.url());
  const cleared = await ghost.evaluate(() => localStorage.getItem("sh.player"));
  check("stale identity is cleared from localStorage", !cleared, String(cleared));

  /* ---- player with no team ---- */
  console.log("\n4. Player who isn't on a team");
  await call("/api/admin/roster", { method: "POST", body: JSON.stringify({ round: 1, entries: [{ playerId: bob.id, teamId: null }] }) });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  check("unrostered player is warned", await page.getByText("not on a Round 1 team", { exact: false }).count() > 0);
  const enabledNoTeam = await enabledUploadButtons(page);
  check("unrostered player cannot upload", enabledNoTeam === 0, `${enabledNoTeam} enabled`);
  await call("/api/admin/roster", { method: "POST", body: JSON.stringify({ round: 1, entries: [{ playerId: bob.id, teamId: red1.id }] }) });

  /* ---- theme ---- */
  console.log("\n5. Theme toggle");
  const tctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const tp = await tctx.newPage();
  await tp.goto(`${BASE}/`, { waitUntil: "networkidle" });
  const themeBtn = tp.locator(".theme-btn");
  check("theme button exists", await themeBtn.count() > 0);
  const initial = await tp.evaluate(() => document.documentElement.dataset.theme ?? "auto");
  await themeBtn.click();
  const afterOne = await tp.evaluate(() => document.documentElement.dataset.theme ?? "auto");
  await themeBtn.click();
  const afterTwo = await tp.evaluate(() => document.documentElement.dataset.theme ?? "auto");
  note(`theme cycle: ${initial} -> ${afterOne} -> ${afterTwo}`);
  check("theme cycles to dark", afterTwo === "dark", afterTwo);
  check("theme is persisted", await tp.evaluate(() => localStorage.getItem("sh.theme")) === "dark");

  await tp.reload({ waitUntil: "domcontentloaded" });
  const themeAtPaint = await tp.evaluate(() => document.documentElement.dataset.theme);
  check("dark survives a reload with no white flash (set before first paint)", themeAtPaint === "dark", String(themeAtPaint));
  const bg = await tp.evaluate(() => getComputedStyle(document.body).backgroundColor);
  note(`body background in dark: ${bg}`);
  check("dark theme actually applies a dark background", (() => {
    const [r, g, b] = bg.match(/\d+/g).map(Number);
    return (r * 0.299 + g * 0.587 + b * 0.114) < 90;
  })(), bg);

  await tp.goto(`${BASE}/leaderboard`, { waitUntil: "domcontentloaded" });
  check("theme persists across navigation", await tp.evaluate(() => document.documentElement.dataset.theme) === "dark");
  await tp.screenshot({ path: new URL("./shots/dark-leaderboard.png", import.meta.url).pathname, fullPage: true });
  await themeBtn.click(); // back to auto
  check("third tap returns to auto", await tp.evaluate(() => localStorage.getItem("sh.theme")) === null);

  /* ---- /go ---- */
  console.log("\n6. /go redirect");
  const gp = await (await browser.newContext()).newPage();
  await gp.goto(`${BASE}/go`, { waitUntil: "networkidle" });
  check("/go lands on the join screen by default", new URL(gp.url()).pathname === "/", gp.url());
  await call("/api/admin/settings", { method: "POST", body: JSON.stringify({ fallback_url: "https://example.com/" }) });
  await gp.goto(`${BASE}/go`, { waitUntil: "domcontentloaded" });
  check("/go honours the fallback URL", gp.url().startsWith("https://example.com"), gp.url());
  await call("/api/admin/settings", { method: "POST", body: JSON.stringify({ fallback_url: "" }) });
  await gp.goto(`${BASE}/go`, { waitUntil: "networkidle" });
  check("clearing the fallback restores the join screen", new URL(gp.url()).pathname === "/", gp.url());
  await call("/api/admin/settings", { method: "POST", body: JSON.stringify({ fallback_url: "not a url" }) });
  await gp.goto(`${BASE}/go`, { waitUntil: "networkidle" });
  check("a malformed fallback URL is ignored rather than breaking the QR code",
    new URL(gp.url()).pathname === "/", gp.url());
  await call("/api/admin/settings", { method: "POST", body: JSON.stringify({ fallback_url: "" }) });

  /* ---- broadcast notice ---- */
  console.log("\n7. Broadcast notice");
  await call("/api/admin/settings", { method: "POST", body: JSON.stringify({ notice: "__qa Come back to the bar now" }) });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  check("notice reaches players", await page.getByText("__qa Come back to the bar", { exact: false }).count() > 0);
  const sticky = await page.evaluate(() => {
    const el = document.querySelector(".topbar");
    return el ? getComputedStyle(el).position : null;
  });
  check("notice is inside the sticky topbar so it can't scroll away", sticky === "sticky", String(sticky));
  await call("/api/admin/settings", { method: "POST", body: JSON.stringify({ notice: "" }) });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  check("clearing the notice removes it", await page.getByText("__qa Come back", { exact: false }).count() === 0);

  /* ---- editing a task after it has been scored ---- */
  console.log("\n8. Editing a task's points after a submission was approved");
  const sub = await seed({ playerId: bob.id, taskId: tasks[1].id });
  await call(`/api/judge/${sub}`, { method: "POST", body: JSON.stringify({ action: "approve" }) });
  const lbBefore = await (await fetch(`${BASE}/api/leaderboard?round=1`)).json();
  const ptsBefore = (lbBefore.rows ?? []).find((r) => r.teamId === red1.id)?.points ?? 0;
  await call("/api/admin/tasks", { method: "PATCH", body: JSON.stringify({ id: tasks[1].id, points: 99 }) });
  const lbAfter = await (await fetch(`${BASE}/api/leaderboard?round=1`)).json();
  const ptsAfter = (lbAfter.rows ?? []).find((r) => r.teamId === red1.id)?.points ?? 0;
  check("changing a task's points does NOT rewrite an already-scored submission",
    ptsAfter === ptsBefore, `${ptsBefore} -> ${ptsAfter}`);
  await call("/api/admin/tasks", { method: "PATCH", body: JSON.stringify({ id: tasks[1].id, points: tasks[1].points }) });

  /* ---- retry on a task that was removed after the rejection ---- */
  console.log("\n9. Retry after the task was removed");
  const doomed = await call("/api/admin/tasks", { method: "POST", body: JSON.stringify({
    round: 1, title: "__qa doomed task", points: 1 }) });
  const doomedId = doomed.body.id;
  const dsub = await seed({ playerId: bob.id, taskId: doomedId });
  await call(`/api/judge/${dsub}`, { method: "POST", body: JSON.stringify({ action: "reject", reason: "Wrong round" }) });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  check("rejection banner lists the doomed task",
    await page.getByText("__qa doomed task", { exact: false }).count() > 0);

  const del = await call(`/api/admin/tasks?id=${doomedId}`, { method: "DELETE" });
  note(`deleting a task with submissions: ${JSON.stringify(del.body)}`);
  check("a task with submissions is deactivated, not deleted", del.body?.deactivated === true, JSON.stringify(del.body));

  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  const bannerStill = await page.getByText("__qa doomed task", { exact: false }).count();
  note(`rejection banner still lists the removed task: ${bannerStill > 0}`);
  if (bannerStill > 0) {
    const retryBtn = page.locator(".card-bad").getByRole("button", { name: "Retry" }).first();
    const isDisabled = await retryBtn.isDisabled();
    note(`its Retry button disabled: ${isDisabled}`);
    if (!isDisabled) {
      let chooserOpened = false;
      page.once("filechooser", () => { chooserOpened = true; });
      await retryBtn.click();
      await page.waitForTimeout(2500);
      check("Retry on a removed task does something (not a dead button)", chooserOpened,
        "the banner still offers Retry for a task that is no longer in the list, and tapping it does nothing at all");
    }
  }

  await admin.from("submissions").delete().eq("task_id", doomedId);
  await admin.from("tasks").delete().eq("id", doomedId);
} finally {
  if (browser) await browser.close();
  await teardownTasks();
  await teardown();
  await restoreSettings(settingsBefore);
  const after = await snapshot();
  const intact = JSON.stringify(before) === JSON.stringify(after);
  console.log(`\nreal data intact: ${intact}`);
  if (!intact) console.log("BEFORE", JSON.stringify(before), "\nAFTER ", JSON.stringify(after));
  summary("Flow 4 (identity, theme, go, edits)");
}
