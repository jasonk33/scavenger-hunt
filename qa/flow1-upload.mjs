/**
 * Flow 1 — the upload path, driven through the real UI.
 *
 * Everything before this session tested uploads from Node straight to TUS. This
 * picks files through the actual file chooser, watches the progress bar, cancels
 * mid-flight, and checks what the judge queue ends up holding.
 */
import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import {
  BASE, BUCKET, admin, setup, teardown, snapshot, captureSettings, restoreSettings, check, note, summary, call,
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
  const page = await context.newPage();

  // The offline step below deliberately breaks the network, so only count errors
  // raised while the browser is supposed to be online.
  let expectOffline = false;
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error" && !expectOffline) consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => { if (!expectOffline) consoleErrors.push(`pageerror: ${e.message}`); });

  /* ---- 1. join screen ---- */
  console.log("\n1. Join screen");
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  const aliceBtn = page.getByRole("button", { name: "__qa Alice", exact: false }).first();
  check("player appears on join screen", await aliceBtn.count() > 0);
  await aliceBtn.click();
  await page.waitForURL("**/submit", { timeout: 10000 }).catch(() => {});
  check("tapping a name lands on /submit", page.url().includes("/submit"), page.url());
  const stored = await page.evaluate(() => localStorage.getItem("sh.player"));
  check("identity persisted to localStorage", stored?.includes("__qa Alice"), String(stored));

  /* ---- 2. real upload through the file chooser ---- */
  console.log("\n2. Upload a photo through the real file chooser");
  await page.waitForSelector(".card-flat", { timeout: 10000 });
  const firstTask = page.locator(".card-flat").first();
  const taskTitle = (await firstTask.locator("div").first().innerText()).trim();
  note(`task: ${taskTitle.slice(0, 60)}`);

  const chooserP = page.waitForEvent("filechooser");
  await firstTask.getByRole("button", { name: /Upload|Redo/ }).click();
  const chooser = await chooserP;
  check("Upload button opens a file chooser", true);
  check("file chooser is single-select", !chooser.isMultiple());
  await chooser.setFiles(`${MEDIA}photo.jpg`);

  // progress card should appear
  const jobCard = page.locator(".card-accent, .card-good, .card-bad").filter({ hasText: "photo.jpg" });
  await jobCard.first().waitFor({ timeout: 10000 }).catch(() => {});
  check("progress card appears for the chosen file", await jobCard.count() > 0);

  // other Upload buttons must be disabled while a job runs
  const disabledDuring = await page.locator(".card-flat button:disabled").count();
  note(`upload buttons disabled during job: ${disabledDuring}`);

  await page.getByText("Sent. It's in the judge's queue.", { exact: false })
    .waitFor({ timeout: 30000 })
    .catch(() => {});
  const done = await page.getByText("It's in the judge's queue", { exact: false }).count();
  check("upload completes and reports success", done > 0);

  const { data: subs1 } = await admin
    .from("submissions").select("id,status,media_type,size_bytes,object_name,team_id,points_awarded")
    .eq("player_id", alice.id);
  check("exactly one submission row exists", subs1.length === 1, `got ${subs1.length}`);
  check("row promoted to pending", subs1[0]?.status === "pending", subs1[0]?.status);
  check("media_type recorded as image/jpeg", subs1[0]?.media_type === "image/jpeg", subs1[0]?.media_type);
  check("size_bytes recorded", subs1[0]?.size_bytes > 0, String(subs1[0]?.size_bytes));
  check("team denormalized onto the row", subs1[0]?.team_id === fx.teamOf("__qa Red", 1).id);

  // the bytes are actually retrievable and are a real JPEG
  const { data: pub } = admin.storage.from(BUCKET).getPublicUrl(subs1[0].object_name);
  const head = await fetch(pub.publicUrl);
  check("media is publicly fetchable", head.ok, String(head.status));
  check("stored content-type is image/jpeg", head.headers.get("content-type")?.includes("image/jpeg"), head.headers.get("content-type"));

  await page.getByRole("button", { name: "OK" }).first().click().catch(() => {});

  /* ---- 3. the task row reflects the pending state ---- */
  console.log("\n3. Task row state after upload");
  await page.reload({ waitUntil: "networkidle" });
  const waiting = await page.getByText("waiting on judge", { exact: false }).count();
  check("task row shows 'waiting on judge'", waiting > 0);
  const stats = await page.locator(".stat-value").allInnerTexts();
  note(`stats row: ${stats.join(" / ")}`);
  check("waiting count reads 1", stats.includes("1"), stats.join(","));

  /* ---- 4. cancel mid-upload ---- */
  console.log("\n4. Cancel mid-upload");
  // A 3MB file at 60KB/s, and we wait for partial progress before clicking, so
  // this is unambiguously a mid-flight cancel rather than a race with completion.
  const HUGE = "/tmp/qa-huge.jpg";
  writeFileSync(HUGE, Buffer.concat([readFileSync(`${MEDIA}big.jpg`), Buffer.alloc(3 * 1024 * 1024, 0x20)]));
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false, latency: 50, downloadThroughput: -1, uploadThroughput: 60 * 1024,
  });

  const secondTask = page.locator(".card-flat").nth(1);
  const chooser2P = page.waitForEvent("filechooser");
  await secondTask.getByRole("button", { name: /Upload|Redo/ }).click();
  (await chooser2P).setFiles(HUGE);

  const cancelBtn = page.getByRole("button", { name: "Cancel" });
  await cancelBtn.waitFor({ timeout: 20000 }).catch(() => {});
  check("Cancel button is offered during upload", await cancelBtn.count() > 0);
  const partial = await page.waitForFunction(() => {
    const el = document.querySelector(".bar i");
    const pct = el ? parseFloat(el.style.width) : -1;
    return pct > 2 && pct < 60;
  }, { timeout: 40000 }).then(() => true).catch(() => false);
  check("upload is genuinely mid-flight when Cancel is tapped", partial,
    await page.evaluate(() => document.querySelector(".bar i")?.style.width ?? "n/a"));
  await cancelBtn.click();

  await page.getByText("Cancelled", { exact: false }).waitFor({ timeout: 10000 }).catch(() => {});
  check("cancel reaches a terminal state", await page.getByText("Cancelled", { exact: false }).count() > 0);

  const stuckDisabled = await page.locator(".card-flat button:disabled").count();
  check("upload buttons re-enabled after cancel", stuckDisabled === 0, `${stuckDisabled} still disabled`);

  await cdp.send("Network.emulateNetworkConditions", {
    offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
  });

  await new Promise((r) => setTimeout(r, 1500));
  const { data: subs2 } = await admin.from("submissions").select("id,status").eq("player_id", alice.id);
  const phantom = subs2.filter((s) => s.status === "uploading");
  check("cancel leaves no phantom 'uploading' row", phantom.length === 0, `${phantom.length} phantom(s)`);
  check("a cancelled upload never reaches the judge queue", subs2.filter((s) => s.status === "pending").length === 1,
    JSON.stringify(subs2.map((s) => s.status)));

  await page.getByRole("button", { name: /^(Dismiss|OK)$/ }).first().click().catch(() => {});
  await page.waitForTimeout(500);

  /* ---- 5. video upload + .mov relabel ---- */
  console.log("\n5. Video upload");
  const thirdTask = page.locator(".card-flat").nth(2);
  const chooser3P = page.waitForEvent("filechooser");
  await thirdTask.getByRole("button", { name: /Upload|Redo/ }).click();
  (await chooser3P).setFiles({ name: "IMG_0042.mov", mimeType: "video/quicktime", buffer: readFileSync(`${MEDIA}clip.mp4`) });
  await page.getByText("It's in the judge's queue", { exact: false }).waitFor({ timeout: 40000 }).catch(() => {});
  const { data: subs3 } = await admin.from("submissions").select("id,status,media_type").eq("player_id", alice.id);
  const vid = subs3.find((s) => s.media_type?.startsWith("video"));
  check("video upload lands", Boolean(vid), JSON.stringify(subs3.map((s) => s.media_type)));
  check(".mov relabelled video/mp4", vid?.media_type === "video/mp4", vid?.media_type);
  await page.getByRole("button", { name: "OK" }).first().click().catch(() => {});

  /* ---- 6. offline failure + retry ---- */
  console.log("\n6. Upload while offline");
  expectOffline = true;
  await cdp.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  const fourthTask = page.locator(".card-flat").nth(3);
  const chooser4P = page.waitForEvent("filechooser");
  await fourthTask.getByRole("button", { name: /Upload|Redo/ }).click();
  (await chooser4P).setFiles(`${MEDIA}photo.jpg`);
  await page.getByText("Didn't send", { exact: false }).waitFor({ timeout: 45000 }).catch(() => {});
  const failed = await page.getByText("Didn't send", { exact: false }).count();
  check("offline upload reports a clear failure", failed > 0);
  const stillOnPhone = await page.getByText("still on your phone", { exact: false }).count();
  check("failure tells the player their photo is safe", stillOnPhone > 0);

  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await new Promise((r) => setTimeout(r, 2000));
  expectOffline = false;
  const { data: subs4 } = await admin.from("submissions").select("id,status").eq("player_id", alice.id);
  check("failed upload leaves no phantom row", subs4.filter((s) => s.status === "uploading").length === 0,
    JSON.stringify(subs4.map((s) => s.status)));

  console.log("\nconsole errors: " + (consoleErrors.length ? consoleErrors.join(" | ") : "none"));
  check("no uncaught page errors while online", consoleErrors.length === 0, consoleErrors.join(" | "));

  await page.screenshot({ path: new URL("./shots/submit-after.png", import.meta.url).pathname, fullPage: true });
} finally {
  if (browser) await browser.close();
  await teardown();
  await restoreSettings(settingsBefore);
  const after = await snapshot();
  const intact = JSON.stringify(before) === JSON.stringify(after);
  console.log(`\nreal data intact: ${intact}`);
  if (!intact) console.log("BEFORE", JSON.stringify(before), "\nAFTER ", JSON.stringify(after));
  summary("Flow 1 (upload)");
}
