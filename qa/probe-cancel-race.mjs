/**
 * Forces the cancel-vs-complete race by holding the PATCH that promotes a
 * submission to `pending`. During that window tus has already succeeded, so
 * `currentSubmissionId` is null and `handle` is null -- but the JobCard is still
 * rendering `status: "uploading"`, so the Cancel button is still on screen and
 * still clickable.
 */
import { chromium } from "@playwright/test";
import {
  BASE, admin, setup, teardown, snapshot, captureSettings, restoreSettings, asPlayer, check, note, summary, call,
} from "./lib.mjs";

const MEDIA = new URL("./media/", import.meta.url).pathname;
const before = await snapshot();
const settingsBefore = await captureSettings();
let browser;

try {
  await teardown();
  const fx = await setup();
  const alice = fx.player("__qa Alice");
  await call("/api/admin/roster", {
    method: "POST",
    body: JSON.stringify({ round: 1, entries: [{ playerId: alice.id, teamId: fx.teamOf("__qa Red", 1).id }] }),
  });

  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await asPlayer(context, alice);
  const page = await context.newPage();

  // The PATCH is issued from inside tus's onSuccess, which is exactly the moment
  // `currentSubmissionId` and `handle` are nulled. Firing Cancel once the PATCH is
  // in flight puts us precisely inside the race window.
  let patchSeen = false;
  await page.route("**/api/submissions/*", async (route) => {
    if (route.request().method() === "PATCH") {
      patchSeen = true;
      note("PATCH in flight — holding it for 6s…");
      await new Promise((r) => setTimeout(r, 6000));
    }
    await route.continue();
  });

  await page.goto(`${BASE}/submit`, { waitUntil: "networkidle" });
  await page.waitForSelector(".card-flat", { timeout: 10000 });

  const task = page.locator(".card-flat").first();
  const taskTitle = (await task.locator("div").first().innerText()).trim();
  const chooser = page.waitForEvent("filechooser");
  await task.getByRole("button", { name: /Upload|Redo/ }).click();
  (await chooser).setFiles(`${MEDIA}photo.jpg`);

  // Wait for the PATCH to be issued: onSuccess has run, the row is NOT yet pending.
  const t0 = Date.now();
  while (!patchSeen && Date.now() - t0 < 30000) await page.waitForTimeout(50);
  check("upload reached onSuccess (PATCH issued)", patchSeen);

  const cancelVisible = await page.getByRole("button", { name: /^Cancel$/ }).count();
  note(`Cancel button still on screen after the bytes landed: ${cancelVisible > 0}`);
  check("Cancel is still offered after the upload has actually finished", cancelVisible > 0,
    "if this is false the race is unreachable and there is no bug");

  if (cancelVisible > 0) {
    await page.getByRole("button", { name: /^Cancel$/ }).click();
    await page.waitForTimeout(6000); // let the held PATCH land

    const shown = (await page.locator(".card-accent, .card-good, .card-bad").allInnerTexts()).join(" ").replace(/\s+/g, " ");
    const { data: rows } = await admin.from("submissions").select("id,status").eq("player_id", alice.id);
    note(`UI says: ${shown.slice(0, 200)}`);
    note(`DB has:  ${JSON.stringify(rows.map((r) => r.status))}`);

    const claimsCancelled = /Nothing was sent/.test(shown);
    const queued = rows.some((r) => r.status === "pending");
    check("UI does not claim 'nothing was sent' while the row is queued",
      !(claimsCancelled && queued),
      claimsCancelled && queued
        ? `player told "Cancelled. Nothing was sent." but a PENDING submission for "${taskTitle.slice(0, 40)}" is in the judge queue`
        : "");

    // Second half of the same bug: does the task row show it as submitted?
    await page.waitForTimeout(5500); // one poll cycle
    const rowText = await page.locator(".card-flat").first().innerText();
    note(`task row now: ${rowText.replace(/\s+/g, " ").slice(0, 120)}`);
  }
} finally {
  if (browser) await browser.close();
  await teardown();
  await restoreSettings(settingsBefore);
  const after = await snapshot();
  console.log(`\nreal data intact: ${JSON.stringify(before) === JSON.stringify(after)}`);
  summary("Cancel race");
}
