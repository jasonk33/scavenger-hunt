/**
 * Flow 7 — what happens when a lot of people submit at the same moment.
 *
 * Covers the three things that actually collide: the reserved object path, the
 * uploads themselves, and everyone's 5-second poll running at once.
 */
import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
import {
  BASE, BUCKET, admin, setup, teardown, snapshot, captureSettings, restoreSettings, asPlayer, check, note, summary, call,
} from "./lib.mjs";

const MEDIA = new URL("./media/", import.meta.url).pathname;
const before = await snapshot();
const settingsBefore = await captureSettings();
const N = 10;
let browser;

try {
  await teardown();
  const names = Array.from({ length: N }, (_, i) => `__qa P${i + 1}`);
  const fx = await setup({ players: names, teams: ["__qa Red", "__qa Blue"] });
  const red1 = fx.teamOf("__qa Red", 1);
  const blue1 = fx.teamOf("__qa Blue", 1);

  // Half on each team, so we exercise both "same team, same task" (the path that
  // can collide) and normal spread.
  await call("/api/admin/roster", { method: "POST", body: JSON.stringify({ round: 1, entries:
    fx.players.map((p, i) => ({ playerId: p.id, teamId: i % 2 === 0 ? red1.id : blue1.id })) }) });

  const { data: tasks } = await admin.from("tasks").select("id,title,points").eq("round", 1).order("sort_order").limit(3);

  /* ---- 1. object path collisions ---- */
  console.log(`\n1. ${N} people on the same team reserve the SAME task simultaneously`);
  const sameTeam = fx.players.filter((_, i) => i % 2 === 0);
  const reserved = await Promise.all(sameTeam.map((p) =>
    call("/api/submissions", { method: "POST", body: JSON.stringify({
      playerId: p.id, taskId: tasks[0].id, fileName: "shot.jpg", fileType: "image/jpeg" }) })));

  const okReserved = reserved.filter((r) => r.status === 200);
  check("every concurrent reservation succeeds", okReserved.length === sameTeam.length,
    JSON.stringify(reserved.map((r) => r.status)));
  const objectNames = okReserved.map((r) => r.body.objectName);
  const unique = new Set(objectNames);
  note(`${objectNames.length} reservations produced ${unique.size} distinct object paths`);
  check("concurrent reservations never share a storage path", unique.size === objectNames.length,
    `${objectNames.length - unique.size} collision(s) — uploads use x-upsert, so a shared path means one player's evidence silently overwrites another's. Sample: ${objectNames.filter((n, i) => objectNames.indexOf(n) !== i)[0] ?? ""}`);
  const ids = okReserved.map((r) => r.body.submissionId);
  check("each reservation is a distinct submission row", new Set(ids).size === ids.length);
  await admin.from("submissions").delete().in("id", ids);

  /* ---- 1b. the same thing, hard enough to expose a millisecond window ---- */
  console.log("\n1b. Bursts against the same team + task, tight enough to collide");
  for (const burst of [30, 60]) {
    const res = await Promise.all(Array.from({ length: burst }, () =>
      call("/api/submissions", { method: "POST", body: JSON.stringify({
        playerId: sameTeam[0].id, taskId: tasks[0].id, fileName: "a.jpg", fileType: "image/jpeg" }) })));
    const ok = res.filter((r) => r.status === 200);
    const paths = ok.map((r) => r.body.objectName);
    const dupes = paths.filter((n, i) => paths.indexOf(n) !== i);
    note(`burst of ${burst}: ${ok.length} reserved, ${new Set(paths).size} distinct paths, ${dupes.length} duplicate(s)`);
    check(`a burst of ${burst} same-team same-task reservations produces no duplicate storage path`,
      dupes.length === 0,
      `${dupes.length} collisions — with x-upsert the later upload silently overwrites the earlier one. e.g. ${dupes[0] ?? ""}`);
    await admin.from("submissions").delete().in("id", ok.map((r) => r.body.submissionId));
  }

  /* ---- 2. concurrent real uploads through real browsers ---- */
  console.log(`\n2. ${N} real browsers uploading at the same time`);
  browser = await chromium.launch();
  const bytes = readFileSync(`${MEDIA}big.jpg`);

  const pages = await Promise.all(fx.players.map(async (p) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await asPlayer(ctx, p);
    const page = await ctx.newPage();
    await page.goto(`${BASE}/submit`, { waitUntil: "networkidle" });
    await page.waitForSelector(".card-flat", { timeout: 20000 });
    return { p, ctx, page };
  }));
  note(`${pages.length} phones on /submit, all polling every 5s`);

  const t0 = Date.now();
  const outcomes = await Promise.all(pages.map(async ({ p, page }, i) => {
    // Same task for everyone on a team: the worst realistic case.
    const row = page.locator(".card-flat").nth(i % 2);
    const chooserP = page.waitForEvent("filechooser");
    await row.getByRole("button", { name: /Upload|Redo/ }).click();
    (await chooserP).setFiles({ name: `IMG_${i}.jpg`, mimeType: "image/jpeg", buffer: bytes });
    const ok = await page.getByText("It's in the judge's queue", { exact: false })
      .waitFor({ timeout: 90000 }).then(() => true).catch(() => false);
    const msg = ok ? "" : (await page.locator(".card-bad").allInnerTexts().catch(() => [])).join(" ").replace(/\s+/g, " ").slice(0, 120);
    return { name: p.name, ok, msg };
  }));
  const elapsed = Date.now() - t0;
  const failed = outcomes.filter((o) => !o.ok);
  note(`${outcomes.length - failed.length}/${outcomes.length} uploads succeeded in ${(elapsed / 1000).toFixed(1)}s`);
  if (failed.length) failed.forEach((f) => note(`  failed: ${f.name} — ${f.msg || "timed out"}`));
  check(`all ${N} simultaneous uploads succeed`, failed.length === 0,
    failed.map((f) => `${f.name}: ${f.msg || "timeout"}`).join(" | "));

  /* ---- 3. every upload is intact and distinct ---- */
  console.log("\n3. Did anything overwrite anything?");
  const { data: rows } = await admin.from("submissions")
    .select("id,player_id,team_id,object_name,size_bytes,status")
    .in("player_id", fx.players.map((p) => p.id));
  check("one row per player", rows.length === N, `${rows.length} rows for ${N} players`);
  check("every row reached pending", rows.every((r) => r.status === "pending"),
    JSON.stringify(rows.map((r) => r.status)));
  const paths = rows.map((r) => r.object_name);
  check("no two submissions share a storage path", new Set(paths).size === paths.length,
    `${paths.length - new Set(paths).size} collision(s)`);
  check("every row recorded the real byte size", rows.every((r) => r.size_bytes === bytes.length),
    JSON.stringify(rows.map((r) => r.size_bytes)));

  // Fetch every object and confirm the bytes are actually there and complete.
  const fetched = await Promise.all(rows.map(async (r) => {
    const { data: pub } = admin.storage.from(BUCKET).getPublicUrl(r.object_name);
    const res = await fetch(pub.publicUrl);
    const buf = Buffer.from(await res.arrayBuffer());
    return { ok: res.ok, len: buf.length };
  }));
  check("every uploaded file is retrievable at full size",
    fetched.every((f) => f.ok && f.len === bytes.length),
    JSON.stringify(fetched.map((f) => `${f.ok}:${f.len}`)));

  const teamCounts = rows.reduce((a, r) => ({ ...a, [r.team_id]: (a[r.team_id] ?? 0) + 1 }), {});
  check("team attribution survived the concurrency",
    teamCounts[red1.id] === N / 2 && teamCounts[blue1.id] === N / 2, JSON.stringify(teamCounts));

  /* ---- 4. the judge queue under load ---- */
  console.log("\n4. Judge queue with everything arriving at once");
  const q = await call("/api/judge/queue?round=1");
  const mine = (q.body.queue ?? []).filter((i) => /__qa/.test(i.teamName));
  check("all concurrent submissions appear in the judge queue", mine.length === N, `${mine.length} of ${N}`);
  check("the queue reports the right pending count", q.body.pendingCount >= N, String(q.body.pendingCount));

  /* ---- 5. polling load ---- */
  console.log("\n5. Poll load with every phone on screen");
  const t1 = Date.now();
  const polls = await Promise.all([
    ...fx.players.map((p) => fetch(`${BASE}/api/state?playerId=${p.id}`).then((r) => r.status)),
    ...Array.from({ length: 10 }, () => fetch(`${BASE}/api/leaderboard`).then((r) => r.status)),
    ...Array.from({ length: 10 }, () => fetch(`${BASE}/api/feed`).then((r) => r.status)),
  ]);
  const pollMs = Date.now() - t1;
  note(`${polls.length} simultaneous API reads in ${pollMs}ms`);
  check("every concurrent read returns 200", polls.every((s) => s === 200), JSON.stringify(polls.filter((s) => s !== 200)));

  await Promise.all(pages.map(({ ctx }) => ctx.close()));
} finally {
  if (browser) await browser.close();
  await teardown();
  await restoreSettings(settingsBefore);
  const after = await snapshot();
  const intact = JSON.stringify(before) === JSON.stringify(after);
  console.log(`\nreal data intact: ${intact}`);
  if (!intact) console.log("BEFORE", JSON.stringify(before), "\nAFTER ", JSON.stringify(after));
  summary("Flow 7 (concurrency)");
}
