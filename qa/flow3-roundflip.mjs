/**
 * Flow 3 — the 3:30pm break, driven through the UI.
 *
 * The organizer flips the active round while a Round 1 backlog is still pending,
 * remixes the roster, and keeps judging. This is the highest-stakes sequence in
 * the app: if Round 1 scores move when the roster is remixed, the whole first
 * competition is silently wrong.
 *
 * Also covers two judges racing the same item.
 */
import { chromium } from "@playwright/test";
import {
  BASE, PIN, admin, setup, teardown, snapshot, captureSettings, restoreSettings,
  seed, check, note, summary, call,
} from "./lib.mjs";

const before = await snapshot();
const settingsBefore = await captureSettings();
let browser;

const scoreFor = async (round, teamId) => {
  const lb = await (await fetch(`${BASE}/api/leaderboard?round=${round}`)).json();
  const row = (lb.rows ?? []).find((t) => t.teamId === teamId);
  return row ? row.points : null;
};

try {
  await teardown();
  const fx = await setup();
  const alice = fx.player("__qa Alice");
  const bob = fx.player("__qa Bob");
  const red1 = fx.teamOf("__qa Red", 1), blue1 = fx.teamOf("__qa Blue", 1);
  const red2 = fx.teamOf("__qa Red", 2), blue2 = fx.teamOf("__qa Blue", 2);

  await call("/api/admin/roster", { method: "POST", body: JSON.stringify({ round: 1, entries: [
    { playerId: alice.id, teamId: red1.id }, { playerId: bob.id, teamId: red1.id },
  ] }) });

  const { data: r1tasks } = await admin.from("tasks").select("id,title,points").eq("round", 1).order("sort_order").limit(6);
  const { data: r2tasks } = await admin.from("tasks").select("id,title,points").eq("round", 2).order("sort_order").limit(3);
  check("round 2 has its own tasks", r2tasks.length > 0, `${r2tasks.length}`);

  browser = await chromium.launch();
  const octx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await octx.addCookies([{ name: "organizer", value: PIN, domain: "localhost", path: "/" }]);
  const judge = await octx.newPage();
  const adminPage = await octx.newPage();

  /* ================= Round 1: bank some score ================= */
  console.log("\n1. Round 1 — bank a score, leave a backlog");
  const banked = await seed({ playerId: alice.id, taskId: r1tasks[0].id });
  const backlog1 = await seed({ playerId: alice.id, taskId: r1tasks[1].id });
  const backlog2 = await seed({ playerId: bob.id, taskId: r1tasks[2].id });

  await judge.goto(`${BASE}/judge`, { waitUntil: "networkidle" });
  await judge.waitForSelector(".media-box", { timeout: 15000 });
  await judge.getByRole("button", { name: /^Approve/ }).click();
  await judge.waitForTimeout(1500);
  const r1ScoreBefore = await scoreFor(1, red1.id);
  note(`__qa Red round-1 score after one approval: ${r1ScoreBefore}`);
  check("approving in round 1 banks points", r1ScoreBefore > 0, String(r1ScoreBefore));
  check("2 submissions remain in the round-1 backlog",
    (await admin.from("submissions").select("id").eq("status", "pending").in("id", [backlog1, backlog2])).data.length === 2);

  /* ================= the flip ================= */
  console.log("\n2. Organizer flips to Round 2 through the admin UI");
  await adminPage.goto(`${BASE}/admin`, { waitUntil: "networkidle" });
  await adminPage.waitForTimeout(1000);
  const r2Btn = adminPage.getByRole("button", { name: "Round 2", exact: true }).first();
  check("admin exposes a Round 2 button", await r2Btn.count() > 0);
  await r2Btn.click();
  await adminPage.waitForTimeout(1500);
  const settingsNow = await (await fetch(`${BASE}/api/state`)).json();
  check("active round is now 2", settingsNow.settings.round === 2, JSON.stringify(settingsNow.settings));

  /* ================= remix the roster ================= */
  console.log("\n3. Remix: Alice moves to Blue for round 2");
  await call("/api/admin/roster", { method: "POST", body: JSON.stringify({ round: 2, entries: [
    { playerId: alice.id, teamId: blue2.id }, { playerId: bob.id, teamId: red2.id },
  ] }) });
  const r1ScoreAfterRemix = await scoreFor(1, red1.id);
  check("REMIX DEFENCE: round-1 score is unchanged after the remix",
    r1ScoreAfterRemix === r1ScoreBefore, `${r1ScoreBefore} -> ${r1ScoreAfterRemix}`);
  const blue1Score = await scoreFor(1, blue1.id);
  check("round-1 points did not leak to Alice's new team", !blue1Score, String(blue1Score));

  /* ================= judge screen after the flip ================= */
  console.log("\n4. Judge screen after the flip — is the Round 1 backlog reachable?");
  await judge.reload({ waitUntil: "networkidle" });
  await judge.waitForTimeout(2000);
  const segLabels = await judge.locator(".seg button").allInnerTexts();
  note(`round selector: ${JSON.stringify(segLabels)}`);
  const onLabel = await judge.locator(".seg button.on").innerText().catch(() => "");
  check("judge defaults to the newly active round", /Round 2/.test(onLabel), onLabel);
  check("the round-1 backlog is advertised on the selector",
    segLabels.some((l) => /Round 1 · 2/.test(l)), JSON.stringify(segLabels));
  check("a warning names the stranded backlog",
    await judge.getByText("still waiting in the other round", { exact: false }).count() > 0);

  await judge.getByRole("button", { name: /^Round 1/ }).click();
  await judge.waitForTimeout(2000);
  await judge.waitForSelector(".media-box", { timeout: 15000 }).catch(() => {});
  check("switching to Round 1 shows the backlog", await judge.locator(".media-box").count() > 0);

  console.log("\n5. Judge the Round 1 backlog while Round 2 is the active round");
  await judge.getByRole("button", { name: /^Approve/ }).click();
  await judge.waitForTimeout(2000);
  const r1After = await scoreFor(1, red1.id);
  check("late round-1 approval lands on the ROUND 1 board", r1After > r1ScoreBefore, `${r1ScoreBefore} -> ${r1After}`);
  const r2Leak = await scoreFor(2, red2.id);
  check("late round-1 approval does NOT leak into round 2", !r2Leak, String(r2Leak));
  const { data: lateRow } = await admin.from("submissions").select("round,status").eq("id", backlog1).single();
  check("the judged row kept round=1", lateRow.round === 1, String(lateRow.round));

  /* ================= player mid-flip ================= */
  console.log("\n6. A player who had /submit open when the round flipped");
  const pctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await pctx.addInitScript(([p]) => localStorage.setItem("sh.player", JSON.stringify(p)), [{ id: alice.id, name: alice.name }]);
  const pp = await pctx.newPage();
  await pp.goto(`${BASE}/submit`, { waitUntil: "networkidle" });
  await pp.waitForTimeout(6500); // one poll cycle
  const teamPill = (await pp.locator("header .pill").allInnerTexts()).join("|");
  check("player's team pill shows their ROUND 2 team", /Blue/.test(teamPill), teamPill);
  const roundPill = await pp.locator("header .push").innerText();
  check("player's round indicator reads R2", /R2/.test(roundPill), roundPill);
  const shown = await pp.locator(".card-flat").allInnerTexts();
  const showsR1Task = shown.some((t) => t.includes(r1tasks[0].title.slice(0, 30)));
  const showsR2Task = shown.some((t) => t.includes(r2tasks[0].title.slice(0, 30)));
  check("round 1 tasks are gone from the list", !showsR1Task);
  check("round 2 tasks are listed", showsR2Task, JSON.stringify(shown.slice(0, 2)));

  // A round-2 upload must credit the round-2 team.
  const newSub = await seed({ playerId: alice.id, taskId: r2tasks[0].id });
  const { data: nRow } = await admin.from("submissions").select("round,team_id").eq("id", newSub).single();
  check("a post-flip upload is stamped round 2", nRow.round === 2, String(nRow.round));
  check("a post-flip upload credits the round-2 team", nRow.team_id === blue2.id, nRow.team_id);

  /* ================= two judges racing ================= */
  console.log("\n7. Two judges racing the same submission");
  const octx2 = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await octx2.addCookies([{ name: "organizer", value: PIN, domain: "localhost", path: "/" }]);
  const judge2 = await octx2.newPage();

  await judge.goto(`${BASE}/judge?round=1`, { waitUntil: "networkidle" });
  await judge.getByRole("button", { name: /^Round 1/ }).click();
  await judge2.goto(`${BASE}/judge`, { waitUntil: "networkidle" });
  await judge2.getByRole("button", { name: /^Round 1/ }).click();
  await judge.waitForSelector(".media-box", { timeout: 15000 });
  await judge2.waitForSelector(".media-box", { timeout: 15000 });

  const t1 = await judge.locator(".card > div").nth(2).innerText().catch(() => "");
  const t2 = await judge2.locator(".card > div").nth(2).innerText().catch(() => "");
  check("both judges are looking at the same head-of-queue item", t1 === t2, `${t1.slice(0,40)} vs ${t2.slice(0,40)}`);

  await judge.getByRole("button", { name: /^Approve/ }).click();
  await judge.waitForTimeout(1200);
  // judge2's view is now stale; it still believes the row is pending.
  await judge2.getByRole("button", { name: "Reject" }).click();
  await judge2.getByRole("button", { name: "Wrong round" }).click();
  await judge2.waitForTimeout(1500);

  const { data: raced } = await admin.from("submissions").select("status,reject_reason").eq("id", backlog2).single();
  const errText = (await judge2.locator(".card-bad").allInnerTexts()).join(" ").replace(/\s+/g, " ");
  note(`second judge saw: ${errText.slice(0, 140) || "(no error surfaced)"}`);
  note(`row ended as: ${raced.status}`);
  check("the first judge's decision wins", raced.status === "approved", raced.status);
  check("the losing judge is told, not silently ignored", /already judged|now approved|Refresh/i.test(errText), errText.slice(0, 120));

  await judge.screenshot({ path: new URL("./shots/judge-round1-backlog.png", import.meta.url).pathname, fullPage: true });

  /* ================= submissions closed during the break ================= */
  console.log("\n8. Closing submissions during the break");
  await adminPage.reload({ waitUntil: "networkidle" });
  await adminPage.waitForTimeout(1000);
  const closeBtn = adminPage.getByRole("button", { name: /Open — tap to close/ });
  check("admin offers a close-submissions toggle", await closeBtn.count() > 0);
  await closeBtn.click();
  await adminPage.waitForTimeout(1500);
  await pp.reload({ waitUntil: "networkidle" });
  await pp.waitForTimeout(1500);
  check("player sees a 'submissions are closed' banner",
    await pp.getByText("Submissions are closed", { exact: false }).count() > 0);
  const enabled = await pp.locator(".card-flat button:not(:disabled)").count();
  check("upload buttons are disabled while closed", enabled === 0, `${enabled} still enabled`);
  const blocked = await call("/api/submissions", { method: "POST", body: JSON.stringify({
    playerId: alice.id, taskId: r2tasks[1].id, fileName: "x.jpg", fileType: "image/jpeg" }) });
  check("server also refuses submissions while closed", blocked.status >= 400, `${blocked.status} ${JSON.stringify(blocked.body)}`);
} finally {
  if (browser) await browser.close();
  await teardown();
  await restoreSettings(settingsBefore);
  const after = await snapshot();
  const intact = JSON.stringify(before) === JSON.stringify(after);
  console.log(`\nreal data intact: ${intact}`);
  if (!intact) console.log("BEFORE", JSON.stringify(before), "\nAFTER ", JSON.stringify(after));
  summary("Flow 3 (round flip + concurrency)");
}
