/**
 * Realistic concurrent load: the whole party uploading phone-sized media at once.
 *
 * The other concurrency checks use tiny fixtures, which never exercise TUS's 6MB
 * chunking or real transfer time. These files are padded to genuine iPhone sizes
 * so the upload path is stressed the way it will be on the day.
 */
import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync, statSync } from "node:fs";
import {
  BASE, BUCKET, admin, setup, teardown, snapshot, captureSettings, restoreSettings, asPlayer, check, note, summary, call,
} from "./lib.mjs";

const MEDIA = new URL("./media/", import.meta.url).pathname;
const PHOTO = "/tmp/qa-load-photo.jpg";
const VIDEO = "/tmp/qa-load-video.mp4";
// Padded to real-world transfer sizes; the decoded image is small but the bytes
// on the wire are what this test is about. The video crosses TUS's 6MB chunk
// boundary, which the small fixtures never do.
writeFileSync(PHOTO, Buffer.concat([readFileSync(`${MEDIA}iphone-photo.jpg`), Buffer.alloc(3.2 * 1024 * 1024, 0x20)]));
writeFileSync(VIDEO, Buffer.concat([readFileSync(`${MEDIA}iphone-clip.mp4`), Buffer.alloc(20 * 1024 * 1024, 0x20)]));

const PHOTO_BYTES = readFileSync(PHOTO);
const VIDEO_BYTES = readFileSync(VIDEO);
// Defaults to the upper end of the guest list; override to point a smaller run
// at production, e.g. QA_N=8 BASE_URL=https://... node qa/flow8-load.mjs --allow-prod
const N = Number(process.env.QA_N) || 12;

const before = await snapshot();
const settingsBefore = await captureSettings();
let browser;

try {
  await teardown();
  const names = Array.from({ length: N }, (_, i) => `__qa L${i + 1}`);
  const fx = await setup({ players: names, teams: ["__qa Red", "__qa Blue", "__qa Green"] });
  const teams = [1, 2, 3].map((_, i) => fx.teamOf(["__qa Red", "__qa Blue", "__qa Green"][i], 1));
  await call("/api/admin/roster", { method: "POST", body: JSON.stringify({ round: 1, entries:
    fx.players.map((p, i) => ({ playerId: p.id, teamId: teams[i % 3].id })) }) });

  note(`photo fixture ${(statSync(PHOTO).size / 1024 / 1024).toFixed(1)} MB, video fixture ${(statSync(VIDEO).size / 1024 / 1024).toFixed(1)} MB`);
  note(`${N} players across 3 teams`);

  browser = await chromium.launch();
  const pages = await Promise.all(fx.players.map(async (p) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await asPlayer(ctx, p);
    const page = await ctx.newPage();
    await page.goto(`${BASE}/submit`, { waitUntil: "networkidle" });
    await page.waitForSelector(".card-flat", { timeout: 30000 });
    return { p, ctx, page };
  }));

  console.log(`\n1. ${N} phones upload real-sized media simultaneously (2 of them video)`);
  const t0 = Date.now();
  const outcomes = await Promise.all(pages.map(async ({ p, page }, i) => {
    const isVideo = i % 6 === 0; // 2 of 12 send a clip
    const file = isVideo
      ? { name: `IMG_${i}.mov`, mimeType: "video/quicktime", buffer: VIDEO_BYTES }
      : { name: `IMG_${i}.jpg`, mimeType: "image/jpeg", buffer: PHOTO_BYTES };
    const row = page.locator(".card-flat").nth(i % 3); // deliberate task overlap within teams
    const chooserP = page.waitForEvent("filechooser");
    await row.getByRole("button", { name: /Upload|Redo/ }).click();
    (await chooserP).setFiles(file);
    const start = Date.now();
    const ok = await page.getByText("It's in the judge's queue", { exact: false })
      .waitFor({ timeout: 180000 }).then(() => true).catch(() => false);
    const msg = ok ? "" : (await page.locator(".card-bad").allInnerTexts().catch(() => [])).join(" ").replace(/\s+/g, " ").slice(0, 150);
    return { name: p.name, ok, isVideo, ms: Date.now() - start, msg };
  }));
  const elapsed = Date.now() - t0;

  const failed = outcomes.filter((o) => !o.ok);
  const mb = outcomes.reduce((a, o) => a + (o.isVideo ? VIDEO_BYTES.length : PHOTO_BYTES.length), 0) / 1024 / 1024;
  note(`${outcomes.length - failed.length}/${N} succeeded — ${mb.toFixed(0)} MB in ${(elapsed / 1000).toFixed(1)}s wall clock`);
  const times = outcomes.filter((o) => o.ok).map((o) => o.ms).sort((a, b) => a - b);
  if (times.length) {
    note(`per-upload: fastest ${(times[0] / 1000).toFixed(1)}s, median ${(times[Math.floor(times.length / 2)] / 1000).toFixed(1)}s, slowest ${(times[times.length - 1] / 1000).toFixed(1)}s`);
  }
  failed.forEach((f) => note(`  FAILED ${f.name}: ${f.msg || "timed out"}`));
  check(`all ${N} concurrent real-sized uploads succeed`, failed.length === 0,
    failed.map((f) => `${f.name}: ${f.msg || "timeout"}`).join(" | "));

  console.log("\n2. Nothing was lost or overwritten");
  const { data: rows } = await admin.from("submissions")
    .select("id,player_id,team_id,object_name,size_bytes,status,media_type")
    .in("player_id", fx.players.map((p) => p.id));
  check("one row per player", rows.length === N, `${rows.length} of ${N}`);
  check("every row reached pending", rows.every((r) => r.status === "pending"), JSON.stringify(rows.map((r) => r.status)));
  const paths = rows.map((r) => r.object_name);
  check("no two uploads share a storage path", new Set(paths).size === paths.length,
    `${paths.length - new Set(paths).size} collision(s)`);
  check("videos were relabelled video/mp4", rows.filter((r) => r.media_type === "video/mp4").length === outcomes.filter((o) => o.isVideo).length,
    JSON.stringify(rows.map((r) => r.media_type)));

  const sizes = await Promise.all(rows.map(async (r) => {
    const { data: pub } = admin.storage.from(BUCKET).getPublicUrl(r.object_name);
    const res = await fetch(pub.publicUrl, { method: "HEAD" });
    return { ok: res.ok, len: Number(res.headers.get("content-length") ?? 0), expected: r.size_bytes };
  }));
  check("every file is in Storage at exactly its full size",
    sizes.every((s) => s.ok && s.len === s.expected),
    JSON.stringify(sizes.filter((s) => !s.ok || s.len !== s.expected)));

  console.log("\n3. The organizer's screens still work under that load");
  const t1 = Date.now();
  const [q, lb, feed] = await Promise.all([
    call("/api/judge/queue?round=1"),
    fetch(`${BASE}/api/leaderboard?round=1`).then((r) => r.json()),
    fetch(`${BASE}/api/feed?round=1`).then((r) => r.json()),
  ]);
  note(`judge queue + leaderboard + feed answered in ${Date.now() - t1}ms`);
  const mine = (q.body.queue ?? []).filter((i) => /__qa/.test(i.teamName));
  check("every upload is in the judge queue", mine.length === N, `${mine.length} of ${N}`);
  check("leaderboard still responds", Array.isArray(lb.rows));
  check("feed still responds", Array.isArray(feed.items));

  console.log("\n4. Sustained polling from every phone while uploads land");
  const pollStart = Date.now();
  const rounds = await Promise.all(Array.from({ length: 3 }, async (_, k) => {
    await new Promise((r) => setTimeout(r, k * 400));
    const res = await Promise.all([
      ...fx.players.map((p) => fetch(`${BASE}/api/state?playerId=${p.id}`).then((r) => r.status)),
      ...Array.from({ length: 8 }, () => fetch(`${BASE}/api/leaderboard`).then((r) => r.status)),
    ]);
    return res;
  }));
  const all = rounds.flat();
  note(`${all.length} reads across 3 waves in ${Date.now() - pollStart}ms`);
  check("no read failed under sustained polling", all.every((s) => s === 200),
    JSON.stringify(all.filter((s) => s !== 200)));

  await Promise.all(pages.map(({ ctx }) => ctx.close()));
} finally {
  if (browser) await browser.close();
  await teardown();
  await restoreSettings(settingsBefore);
  const after = await snapshot();
  const intact = JSON.stringify(before) === JSON.stringify(after);
  console.log(`\nreal data intact: ${intact}`);
  if (!intact) console.log("BEFORE", JSON.stringify(before), "\nAFTER ", JSON.stringify(after));
  summary("Flow 8 (realistic load)");
}
