/** Isolating the cancel-race and the video-upload failures from flow 1. */
import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import {
  BASE, admin, setup, teardown, snapshot, captureSettings, restoreSettings,
  check, note, summary, call,
} from "./lib.mjs";

const MEDIA = new URL("./media/", import.meta.url).pathname;
// A genuinely large file so a throttled upload is unambiguously mid-flight.
const HUGE = "/tmp/qa-cancel-huge.jpg";
const base = readFileSync(`${MEDIA}big.jpg`);
writeFileSync(HUGE, Buffer.concat([base, Buffer.alloc(3 * 1024 * 1024, 0x20)]));

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
  await context.addInitScript(([p]) => localStorage.setItem("sh.player", JSON.stringify(p)),
    [{ id: alice.id, name: alice.name }]);
  const page = await context.newPage();
  await page.goto(`${BASE}/submit`, { waitUntil: "networkidle" });
  await page.waitForSelector(".card-flat", { timeout: 10000 });

  /* ---- A. video upload, isolated ---- */
  console.log("\nA. Video upload (isolated, no prior state)");
  const t0 = page.locator(".card-flat").first();
  const c0 = page.waitForEvent("filechooser");
  await t0.getByRole("button", { name: /Upload|Redo/ }).click();
  (await c0).setFiles({ name: "IMG_0042.mov", mimeType: "video/quicktime", buffer: readFileSync(`${MEDIA}clip.mp4`) });

  await page.waitForTimeout(1000);
  const cardText = await page.locator(".card-accent, .card-good, .card-bad").allInnerTexts();
  note(`job card after 1s: ${JSON.stringify(cardText).slice(0, 300)}`);

  await page.getByText("It's in the judge's queue", { exact: false }).waitFor({ timeout: 40000 }).catch(() => {});
  const finalText = await page.locator(".card-accent, .card-good, .card-bad").allInnerTexts();
  note(`job card final: ${JSON.stringify(finalText).slice(0, 400)}`);

  const { data: v } = await admin.from("submissions").select("id,status,media_type,object_name").eq("player_id", alice.id);
  check("video upload creates a row", v.length === 1, `${v.length} rows`);
  check("video row is pending", v[0]?.status === "pending", v[0]?.status);
  check(".mov relabelled video/mp4", v[0]?.media_type === "video/mp4", v[0]?.media_type);
  note(`object_name: ${v[0]?.object_name}`);

  // clear for part B
  await admin.from("submissions").delete().eq("player_id", alice.id);

  /* ---- B. cancel genuinely mid-flight ---- */
  console.log("\nB. Cancel a genuinely mid-flight upload (3MB @ 60KB/s)");
  await page.reload({ waitUntil: "networkidle" });
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false, latency: 50, downloadThroughput: -1, uploadThroughput: 60 * 1024,
  });

  const t1 = page.locator(".card-flat").first();
  const c1 = page.waitForEvent("filechooser");
  await t1.getByRole("button", { name: /Upload|Redo/ }).click();
  (await c1).setFiles(HUGE);

  // Wait until progress is genuinely partial, so this is a true mid-flight cancel.
  await page.waitForFunction(() => {
    const el = document.querySelector(".bar i");
    if (!el) return false;
    const pct = parseFloat(el.style.width);
    return pct > 2 && pct < 60;
  }, { timeout: 30000 }).catch(() => note("never observed partial progress"));
  const pctAtCancel = await page.evaluate(() => document.querySelector(".bar i")?.style.width ?? "n/a");
  note(`progress at cancel: ${pctAtCancel}`);
  check("cancel happens mid-flight", pctAtCancel !== "n/a" && parseFloat(pctAtCancel) < 100, pctAtCancel);

  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByText("Cancelled", { exact: false }).waitFor({ timeout: 10000 }).catch(() => {});
  check("mid-flight cancel shows 'Cancelled. Nothing was sent.'",
    (await page.getByText("Nothing was sent", { exact: false }).count()) > 0);

  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await page.waitForTimeout(3000);
  const { data: c } = await admin.from("submissions").select("id,status").eq("player_id", alice.id);
  check("mid-flight cancel leaves NO row at all", c.length === 0, JSON.stringify(c.map((x) => x.status)));

  /* ---- C. cancel racing a completing upload ---- */
  console.log("\nC. Cancel clicked the instant an upload completes (the race)");
  await admin.from("submissions").delete().eq("player_id", alice.id);
  await page.reload({ waitUntil: "networkidle" });

  const t2 = page.locator(".card-flat").first();
  const c2 = page.waitForEvent("filechooser");
  await t2.getByRole("button", { name: /Upload|Redo/ }).click();
  (await c2).setFiles(`${MEDIA}photo.jpg`); // small + full speed: finishes fast

  // Click Cancel as soon as it exists — likely after onSuccess has already run.
  await page.getByRole("button", { name: /^Cancel$/ }).click({ timeout: 5000 }).catch(() => note("Cancel already gone — upload finished first"));
  await page.waitForTimeout(3000);

  const shown = (await page.locator(".card-accent, .card-good, .card-bad").allInnerTexts()).join(" ");
  const { data: r } = await admin.from("submissions").select("id,status").eq("player_id", alice.id);
  note(`UI says: ${shown.replace(/\s+/g, " ").slice(0, 160)}`);
  note(`DB has: ${JSON.stringify(r.map((x) => x.status))}`);
  const claimsCancelled = /Nothing was sent/.test(shown);
  const actuallyQueued = r.some((x) => x.status === "pending");
  check("UI and DB agree after a cancel/complete race",
    !(claimsCancelled && actuallyQueued),
    claimsCancelled && actuallyQueued
      ? "UI says 'Cancelled. Nothing was sent.' but a PENDING row is in the judge queue"
      : "");
} finally {
  if (browser) await browser.close();
  await teardown();
  await restoreSettings(settingsBefore);
  const after = await snapshot();
  console.log(`\nreal data intact: ${JSON.stringify(before) === JSON.stringify(after)}`);
  summary("Isolation");
}
