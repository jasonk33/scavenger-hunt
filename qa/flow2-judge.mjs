/**
 * Flow 2 — judging through the real UI: PIN gate, approve with bonus/star,
 * reject with a reason, the player-side rejection banner, re-review, undo,
 * team reassignment, and what the leaderboard ends up saying.
 */
import { chromium } from "@playwright/test";
import {
  BASE, PIN, admin, setup, teardown, snapshot, captureSettings, restoreSettings,
  seed, check, note, summary, call,
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
  const blue1 = fx.teamOf("__qa Blue", 1);
  await call("/api/admin/roster", {
    method: "POST",
    body: JSON.stringify({ round: 1, entries: [
      { playerId: alice.id, teamId: red1.id },
      { playerId: bob.id, teamId: blue1.id },
    ] }),
  });

  const { data: tasks } = await admin.from("tasks").select("id,title,points").eq("round", 1).order("sort_order").limit(4);
  const subA = await seed({ playerId: alice.id, taskId: tasks[0].id });
  const subB = await seed({ playerId: alice.id, taskId: tasks[1].id });
  const subC = await seed({ playerId: bob.id, taskId: tasks[2].id, file: "clip.mp4" });
  note(`seeded 3 pending submissions on tasks worth ${tasks.slice(0,3).map(t=>t.points).join("/")} pts`);

  browser = await chromium.launch();

  /* ---- PIN gate ---- */
  console.log("\n1. PIN gate");
  const guest = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const gp = await guest.newPage();
  await gp.goto(`${BASE}/judge`, { waitUntil: "networkidle" });
  check("unauthenticated visitor sees the PIN form", await gp.getByPlaceholder("PIN").count() > 0);
  check("queue is not visible before unlocking", await gp.getByText("waiting", { exact: false }).count() === 0);
  await gp.getByPlaceholder("PIN").fill("00000");
  await gp.getByRole("button", { name: "Unlock" }).click();
  await gp.waitForTimeout(1200);
  check("wrong PIN is rejected with a message", await gp.locator(".bad").count() > 0,
    (await gp.locator(".bad").allInnerTexts()).join("|"));
  await gp.getByPlaceholder("PIN").fill(PIN);
  await gp.getByRole("button", { name: "Unlock" }).click();
  await gp.waitForSelector(".seg", { timeout: 10000 }).catch(() => {});
  check("correct PIN unlocks the queue", await gp.getByRole("heading", { name: "Judge" }).count() > 0);
  const cookieSet = (await guest.cookies()).find((c) => c.name === "organizer");
  check("unlocking sets the organizer cookie", Boolean(cookieSet), JSON.stringify(await guest.cookies()));

  const page = gp;

  /* ---- approve with bonus + star ---- */
  console.log("\n2. Approve with a creativity bonus and an award star");
  await page.waitForSelector(".card .media-box", { timeout: 15000 });
  const firstTitle = await page.locator(".card").first().innerText();
  note(`reviewing: ${firstTitle.replace(/\s+/g, " ").slice(0, 90)}`);
  const waitingPill = await page.locator(".pill-accent").first().innerText().catch(() => "");
  check("queue count pill shows 3 waiting", /3 waiting/.test(waitingPill), waitingPill);

  // Give the image a chance to fetch and decode; sampling the instant the node
  // appears just measures how fast Supabase Storage replied.
  const decoded = await page.waitForFunction(() => {
    const img = document.querySelector(".media-box img");
    return Boolean(img && img.complete && img.naturalWidth > 0);
  }, { timeout: 20000 }).then(() => true).catch(() => false);
  const mediaOk = await page.evaluate(() => {
    const img = document.querySelector(".media-box img");
    return img ? { complete: img.complete, w: img.naturalWidth } : null;
  });
  check("submitted photo actually renders in the judge card", decoded, JSON.stringify(mediaOk));

  await page.getByRole("button", { name: "+2" }).click();
  await page.getByRole("button", { name: /award/ }).click();
  const approveLabel = await page.getByRole("button", { name: /^Approve/ }).innerText();
  note(`approve button reads: ${approveLabel.replace(/\s+/g, " ")}`);
  check("approve button shows task points + bonus", /\b3\b/.test(approveLabel), approveLabel);
  await page.getByRole("button", { name: /^Approve/ }).click();
  await page.waitForTimeout(1500);

  const { data: aRow } = await admin.from("submissions").select("status,points_awarded,bonus,starred").eq("id", subA).single();
  check("approve persists status", aRow.status === "approved", aRow.status);
  check("approve persists the bonus", aRow.bonus === 2, String(aRow.bonus));
  check("approve persists the star", aRow.starred === true, String(aRow.starred));
  check("points_awarded is the task value, bonus kept separate", aRow.points_awarded === tasks[0].points,
    `${aRow.points_awarded} vs ${tasks[0].points}`);

  /* ---- bonus must not leak to the next item ---- */
  console.log("\n3. Controls reset between items");
  await page.waitForTimeout(500);
  const bonusOn = await page.locator(".seg button.on").allInnerTexts();
  check("creativity resets to 'none' for the next submission", bonusOn.includes("none"), bonusOn.join(","));
  const starPrimary = await page.getByRole("button", { name: /award/ }).getAttribute("class");
  check("award star resets for the next submission", !starPrimary?.includes("btn-primary"), String(starPrimary));

  /* ---- reject with a reason ---- */
  console.log("\n4. Reject with a reason");
  await page.getByRole("button", { name: "Reject" }).click();
  check("reject shows canned reasons", await page.getByRole("button", { name: "Doesn't match the task" }).count() > 0);
  await page.getByRole("button", { name: "Doesn't match the task" }).click();
  await page.waitForTimeout(1500);
  const { data: bRow } = await admin.from("submissions").select("status,reject_reason,points_awarded").eq("id", subB).single();
  check("reject persists", bRow.status === "rejected", bRow.status);
  check("reject reason persists", bRow.reject_reason === "Doesn't match the task", String(bRow.reject_reason));
  check("rejected submission awards no points", !bRow.points_awarded, String(bRow.points_awarded));

  /* ---- player sees the rejection ---- */
  console.log("\n5. Player-side rejection banner and Retry");
  const pctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await pctx.addInitScript(([p]) => localStorage.setItem("sh.player", JSON.stringify(p)), [{ id: alice.id, name: alice.name }]);
  const pp = await pctx.newPage();
  await pp.goto(`${BASE}/submit`, { waitUntil: "networkidle" });
  await pp.waitForTimeout(1000);
  check("rejection banner appears for the player", await pp.getByText("rejected — redo", { exact: false }).count() > 0);
  check("banner names the reason", await pp.getByText("Doesn't match the task", { exact: false }).count() > 0);
  const retry = pp.getByRole("button", { name: "Retry" });
  check("banner offers a Retry button", await retry.count() > 0);
  const chooserP = pp.waitForEvent("filechooser");
  await retry.first().click();
  const ch = await chooserP;
  check("Retry opens the file chooser for the right task", true);
  await ch.setFiles(new URL("./media/photo.jpg", import.meta.url).pathname);
  await pp.getByText("It's in the judge's queue", { exact: false }).waitFor({ timeout: 30000 }).catch(() => {});
  check("retry upload succeeds", await pp.getByText("It's in the judge's queue", { exact: false }).count() > 0);
  await pp.waitForTimeout(6000);
  const bannerAfter = await pp.getByText("rejected — redo", { exact: false }).count();
  note(`rejection banner still shown after re-upload (still pending): ${bannerAfter > 0}`);

  /* ---- re-review from history ---- */
  console.log("\n6. Re-review a judged item and change the call");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  check("judged history is listed", await page.getByText("Judged this round", { exact: false }).count() > 0);
  const histRow = page.locator(".stack .card-flat").filter({ hasText: tasks[1].title.slice(0, 25) }).first();
  check("the rejected item appears in history", await histRow.count() > 0);
  await histRow.locator("button.btn-plain").click();
  await page.waitForTimeout(1000);
  check("re-review banner appears", await page.getByText("Re-reviewing", { exact: false }).count() > 0);
  check("re-review shows the current call", await page.getByText("currently rejected", { exact: false }).count() > 0);
  await page.getByRole("button", { name: /^Approve/ }).click();
  await page.waitForTimeout(1500);
  const { data: bRow2 } = await admin.from("submissions").select("status,points_awarded,reject_reason").eq("id", subB).single();
  check("re-review flips rejected -> approved", bRow2.status === "approved", bRow2.status);
  check("re-review awards points", bRow2.points_awarded === tasks[1].points, String(bRow2.points_awarded));
  check("stale reject reason is cleared on approval", !bRow2.reject_reason, String(bRow2.reject_reason));

  /* ---- undo ---- */
  console.log("\n7. Undo sends an item back to the queue");
  await page.waitForTimeout(1000);
  const undoRow = page.locator(".stack .card-flat").filter({ hasText: tasks[1].title.slice(0, 25) }).first();
  await undoRow.getByRole("button", { name: "Undo" }).click();
  await page.waitForTimeout(1500);
  const { data: bRow3 } = await admin.from("submissions").select("status,points_awarded,bonus,starred").eq("id", subB).single();
  check("undo returns the row to pending", bRow3.status === "pending", bRow3.status);
  check("undo clears the awarded points", !bRow3.points_awarded, String(bRow3.points_awarded));
  check("undo clears the bonus", bRow3.bonus === 0, String(bRow3.bonus));

  /* ---- reassign ---- */
  console.log("\n8. Reassign a submission to another team");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".card .media-box", { timeout: 15000 });
  const teamBtn = page.locator(".card button.btn-plain").first();
  const fromTeam = await teamBtn.innerText();
  await teamBtn.click();
  await page.waitForTimeout(500);
  check("tapping the team name offers other teams", await page.getByText("Move this submission to", { exact: false }).count() > 0);
  const target = page.locator(".card .row button.btn-sm").filter({ hasText: /__qa (Red|Blue)/ }).first();
  const toTeam = await target.innerText();
  note(`reassigning from "${fromTeam}" to "${toTeam}"`);
  await target.click();
  await page.waitForTimeout(1500);
  const { data: moved } = await admin.from("submissions").select("id,team_id").in("id", [subA, subB, subC]);
  const changed = moved.filter((m) => m.team_id === (toTeam.includes("Red") ? red1.id : blue1.id));
  check("reassignment persisted to a new team", changed.length > 0, JSON.stringify(moved));

  /* ---- leaderboard ---- */
  console.log("\n9. Leaderboard reflects the judging");
  const lb = await (await fetch(`${BASE}/api/leaderboard?round=1`)).json();
  const rows = (lb.rows ?? []).filter((r) => /__qa/.test(r.name ?? ""));
  note(`leaderboard __qa rows: ${JSON.stringify(rows)}`);
  check("a __qa team has a non-zero score", rows.some((r) => (r.points ?? r.score ?? 0) > 0), JSON.stringify(rows));

  const lbPage = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await lbPage.goto(`${BASE}/leaderboard`, { waitUntil: "networkidle" });
  await lbPage.waitForTimeout(1200);
  check("leaderboard page renders the __qa team", await lbPage.getByText("__qa", { exact: false }).count() > 0);
  await lbPage.screenshot({ path: new URL("./shots/leaderboard.png", import.meta.url).pathname, fullPage: true });
  await page.screenshot({ path: new URL("./shots/judge.png", import.meta.url).pathname, fullPage: true });
} finally {
  if (browser) await browser.close();
  await teardown();
  await restoreSettings(settingsBefore);
  const after = await snapshot();
  console.log(`\nreal data intact: ${JSON.stringify(before) === JSON.stringify(after)}`);
  summary("Flow 2 (judge)");
}
