/** Secret-challenge reveal: hidden until the organizer says so, then live. */
import { chromium } from "@playwright/test";
import {
  BASE, admin, setup, teardown, teardownTasks, snapshot, captureSettings, restoreSettings, asOrganizer, asPlayer, check, note, summary, call,
} from "./lib.mjs";

const before = await snapshot();
const settingsBefore = await captureSettings();
let browser;

try {
  await teardown();
  const fx = await setup();
  const alice = fx.player("__qa Alice");
  const red1 = fx.teamOf("__qa Red", 1);
  await call("/api/admin/roster", { method: "POST", body: JSON.stringify({ round: 1, entries: [{ playerId: alice.id, teamId: red1.id }] }) });

  const made = await call("/api/admin/tasks", { method: "POST", body: JSON.stringify({
    round: 1, title: "__qa secret challenge", points: 10, isSecret: true }) });
  const secretId = made.body.id;
  check("a secret task can be created", Boolean(secretId), JSON.stringify(made.body));

  browser = await chromium.launch();
  const pctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await asPlayer(pctx, alice);
  const page = await pctx.newPage();

  console.log("\n1. Before reveal");
  await page.goto(`${BASE}/submit`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  check("an unrevealed secret task is invisible to players",
    await page.getByText("__qa secret challenge", { exact: false }).count() === 0);

  const state = await (await fetch(`${BASE}/api/state?playerId=${alice.id}`)).json();
  check("the unrevealed task never reaches the browser at all",
    !JSON.stringify(state.tasks).includes("__qa secret challenge"));

  const sneak = await call("/api/submissions", { method: "POST", body: JSON.stringify({
    playerId: alice.id, taskId: secretId, fileName: "x.jpg", fileType: "image/jpeg" }) });
  note(`submitting directly to the hidden task id: ${sneak.status} ${JSON.stringify(sneak.body).slice(0, 120)}`);
  check("the server refuses a submission to an unrevealed secret task",
    sneak.status >= 400, `accepted with ${sneak.status} — a guessed task id bypasses the reveal`);

  console.log("\n2. Organizer reveals it");
  const octx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await asOrganizer(octx);
  const adminPage = await octx.newPage();
  await adminPage.goto(`${BASE}/admin`, { waitUntil: "networkidle" });
  await adminPage.waitForTimeout(1200);
  await adminPage.getByRole("button", { name: "tasks", exact: true }).first().click();
  await adminPage.waitForTimeout(1500);
  check("admin lists the secret task", await adminPage.getByText("__qa secret challenge", { exact: false }).count() > 0);
  // Scope to OUR task's row. A page-wide .first() hits whichever secret task is
  // listed first, which during a real event is one of the organizer's own -- and
  // revealing that early spoils it with no obvious way to notice.
  // The event-day control lives in its own "Secret challenges" card. Scope to
  // that card AND to our row: a page-wide .first() reveals whichever secret task
  // happens to be listed first, which in the real event is one of Jason's.
  const secretCard = adminPage.locator(".card").filter({ hasText: "Secret challenges" });
  check("admin has a dedicated Secret challenges card", await secretCard.count() > 0);
  const secretRow = secretCard.locator("div").filter({ hasText: "__qa secret challenge" }).last();
  const revealBtn = secretRow.getByRole("button", { name: /^Reveal$/ });
  const hasRevealBtn = await revealBtn.count() > 0;
  note(`a dedicated Reveal control on the task row: ${hasRevealBtn}`);
  if (hasRevealBtn) {
    await revealBtn.click();
    await adminPage.waitForTimeout(1500);
  } else {
    await call("/api/admin/tasks", { method: "PATCH", body: JSON.stringify({ id: secretId, revealed: true }) });
  }
  const { data: revealed } = await admin.from("tasks").select("revealed_at").eq("id", secretId).single();
  check("revealing stamps revealed_at", Boolean(revealed.revealed_at), String(revealed.revealed_at));
  check("the Reveal button was the real UI control, not an API fallback", hasRevealBtn,
    "no Reveal button found in the Secret challenges card");
  if (hasRevealBtn) {
    check("the revealed task's button now reads Live",
      (await secretRow.getByRole("button").first().innerText()).trim() === "Live",
      await secretRow.getByRole("button").first().innerText());
  }

  console.log("\n3. After reveal");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  check("the revealed task appears for players",
    await page.getByText("__qa secret challenge", { exact: false }).count() > 0);
  check("it is flagged as a secret challenge in the list",
    await page.getByText("secret", { exact: false }).count() > 0);
  const nowAllowed = await call("/api/submissions", { method: "POST", body: JSON.stringify({
    playerId: alice.id, taskId: secretId, fileName: "x.jpg", fileType: "image/jpeg" }) });
  check("submissions to a revealed secret task are accepted", nowAllowed.status === 200,
    `${nowAllowed.status} ${JSON.stringify(nowAllowed.body).slice(0, 120)}`);
  if (nowAllowed.status === 200) {
    await call(`/api/submissions/${nowAllowed.body.submissionId}`, { method: "DELETE" });
  }

  console.log("\n4. Un-revealing hides it again");
  await call("/api/admin/tasks", { method: "PATCH", body: JSON.stringify({ id: secretId, revealed: false }) });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  check("un-revealing hides the task again",
    await page.getByText("__qa secret challenge", { exact: false }).count() === 0);

  console.log("\n5. Jason's real secret tasks are untouched");
  const { data: realSecrets } = await admin.from("tasks").select("revealed_at")
    .eq("is_secret", true).not("title", "like", "__qa%");
  check("all 8 real secret challenges are still unrevealed",
    realSecrets.every((t) => t.revealed_at === null), JSON.stringify(realSecrets));
} finally {
  if (browser) await browser.close();
  await teardownTasks();
  await teardown();
  await restoreSettings(settingsBefore);
  const after = await snapshot();
  console.log(`\nreal data intact: ${JSON.stringify(before) === JSON.stringify(after)}`);
  summary("Secret challenges");
}
