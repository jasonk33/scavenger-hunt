/**
 * Saved tasks: the per-player shortlist a guest builds on their first pass
 * through ~38 tasks, and the filter that shows only those.
 *
 * The state lives in localStorage keyed by player id, so the two things worth
 * proving are that it survives a reload and that it does NOT survive a change
 * of identity on the same phone -- a handed-over device must not show the
 * previous player's picks.
 *
 * The third is the strand case from AGENTS.md: a control that hides itself
 * while its state persists. Un-saving the last task while the filter is on
 * empties the list, and if the filter chip disappears at that moment the
 * player is left staring at an empty task list with no way back.
 */
import { chromium } from "@playwright/test";
import {
  BASE, setup, teardown, teardownTasks, snapshot, captureSettings, restoreSettings,
  asPlayer, check, note, summary, call, pollNow, shot,
} from "./lib.mjs";

const before = await snapshot();
const settingsBefore = await captureSettings();
let browser;

const TITLES = ["__qa saved alpha", "__qa saved bravo", "__qa saved charlie"];
const taskIds = {};

/** The card for one task, scoped by its title so sibling cards never match. */
const cardFor = (page, title) => page.locator(".card").filter({ hasText: title }).last();
const starIn = (card) => card.getByRole("button", { name: "Save for later" });
const filterChip = (page) => page.locator(".saved-filter");
const visibleTitles = async (page) => {
  const out = [];
  for (const t of TITLES) {
    if (await page.getByText(t, { exact: false }).count() > 0) out.push(t);
  }
  return out;
};

try {
  await teardown();
  const fx = await setup();
  const alice = fx.player("__qa Alice");
  const bob = fx.player("__qa Bob");
  const red1 = fx.teamOf("__qa Red", 1);
  await call("/api/admin/roster", { method: "POST", body: JSON.stringify({
    round: 1, entries: [{ playerId: alice.id, teamId: red1.id }, { playerId: bob.id, teamId: red1.id }] }) });

  for (const title of TITLES) {
    const made = await call("/api/admin/tasks", { method: "POST", body: JSON.stringify({
      round: 1, title, points: 3 }) });
    taskIds[title] = made.body.id;
  }

  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await asPlayer(ctx, alice);
  const page = await ctx.newPage();

  console.log("\n1. Every task offers a save control");
  await page.goto(`${BASE}/submit`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  check("all three fixture tasks are listed", (await visibleTitles(page)).length === 3,
    JSON.stringify(await visibleTitles(page)));
  const alphaStar = starIn(cardFor(page, TITLES[0]));
  check("a task card has a save control", await alphaStar.count() > 0);
  check("the save control starts unpressed",
    await alphaStar.getAttribute("aria-pressed") === "false",
    String(await alphaStar.getAttribute("aria-pressed")));

  console.log("\n2. Nothing saved means no filter chip cluttering the list");
  check("the saved filter is absent while nothing is saved and the filter is off",
    await filterChip(page).count() === 0);

  console.log("\n3. Saving a task");
  await alphaStar.click();
  await page.waitForTimeout(400);
  check("the save control reads as pressed after tapping",
    await starIn(cardFor(page, TITLES[0])).getAttribute("aria-pressed") === "true",
    String(await starIn(cardFor(page, TITLES[0])).getAttribute("aria-pressed")));
  check("the saved filter appears once something is saved", await filterChip(page).count() > 0);
  note(`filter chip reads: ${(await filterChip(page).innerText().catch(() => "")).replace(/\s+/g, " ")}`);
  check("the filter chip reports the saved count",
    /\b1\b/.test(await filterChip(page).innerText()),
    await filterChip(page).innerText());

  console.log("\n4. It survives a reload (this is the whole point)");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  check("the saved task is still saved after a reload",
    await starIn(cardFor(page, TITLES[0])).getAttribute("aria-pressed") === "true",
    String(await starIn(cardFor(page, TITLES[0])).getAttribute("aria-pressed")));

  console.log("\n5. Filtering to saved only");
  await filterChip(page).click();
  await page.waitForTimeout(400);
  const shown = await visibleTitles(page);
  check("filtering shows only the saved task", shown.length === 1 && shown[0] === TITLES[0],
    JSON.stringify(shown));
  check("the filter chip stays on screen while filtering", await filterChip(page).count() > 0);

  console.log("\n6. Un-saving the last task must not strand the player");
  await starIn(cardFor(page, TITLES[0])).click();
  await page.waitForTimeout(400);
  check("the filter chip is STILL on screen with zero saved tasks",
    await filterChip(page).count() > 0,
    "the only control that can undo the filter vanished — the player is stuck on an empty list");
  const escape = page.getByRole("button", { name: "Show all tasks" });
  check("the empty state offers a way back to the full list", await escape.count() > 0);
  /* Assert on exactly one .empty before reading it. An earlier version read
     innerText() with a .catch(() => "") fallback, which passed on the empty
     string -- so the very regression this exists to catch (dropping the
     `!onlySaved` guard, rendering BOTH empty states at once) tripped
     Playwright's strict-mode multi-match, got swallowed, and reported green. */
  const emptyCount = await page.locator(".empty").count();
  check("exactly one empty state renders, never both stacked", emptyCount === 1,
    `found ${emptyCount} .empty elements`);
  const emptyText = emptyCount === 1 ? await page.locator(".empty").innerText() : "";
  note(`empty state reads: ${emptyText.replace(/\s+/g, " ")}`);
  check("the empty state blames the saved filter, not the search box",
    emptyCount === 1 && !/shorter search/i.test(emptyText), emptyText);

  console.log("\n7. Escaping restores the full list");
  await escape.click();
  await page.waitForTimeout(400);
  check("all tasks are listed again", (await visibleTitles(page)).length === 3,
    JSON.stringify(await visibleTitles(page)));

  console.log("\n8. A handed-over phone does not leak the previous player's picks");
  /* Seed Alice's shortlist into a device whose current player is Bob. This is
     the real hand-over shape: her data is genuinely present in localStorage, so
     the only thing stopping Bob seeing it is that the key carries a player id.
     (Switching identity by hand on the existing page cannot test this -- the
     harness re-seeds sh.player on every navigation.) */
  const seedAlice = [`sh.saved.${alice.id}`, [taskIds[TITLES[1]]]];
  const bobCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await asPlayer(bobCtx, bob);
  await bobCtx.addInitScript(([key, ids]) => localStorage.setItem(key, JSON.stringify(ids)), seedAlice);
  const bobPage = await bobCtx.newPage();
  await bobPage.goto(`${BASE}/submit`, { waitUntil: "networkidle" });
  await bobPage.waitForTimeout(1500);
  check("Bob sees no saved tasks on a device holding Alice's shortlist",
    await starIn(cardFor(bobPage, TITLES[1])).getAttribute("aria-pressed") === "false",
    String(await starIn(cardFor(bobPage, TITLES[1])).getAttribute("aria-pressed")));
  check("and no saved filter is offered to Bob", await filterChip(bobPage).count() === 0);

  console.log("\n9. The same stored shortlist is Alice's when Alice is the player");
  const aliceCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await asPlayer(aliceCtx, alice);
  await aliceCtx.addInitScript(([key, ids]) => localStorage.setItem(key, JSON.stringify(ids)), seedAlice);
  const alicePage = await aliceCtx.newPage();
  await alicePage.goto(`${BASE}/submit`, { waitUntil: "networkidle" });
  await alicePage.waitForTimeout(1500);
  check("Alice sees her saved task on that same storage",
    await starIn(cardFor(alicePage, TITLES[1])).getAttribute("aria-pressed") === "true",
    String(await starIn(cardFor(alicePage, TITLES[1])).getAttribute("aria-pressed")));
  check("and Alice is offered the saved filter", await filterChip(alicePage).count() > 0);

  console.log("\n10. A task cut mid-event drops out of the saved count, not just the list");
  await call("/api/admin/tasks", { method: "PATCH", body: JSON.stringify({
    id: taskIds[TITLES[1]], active: false }) });
  await alicePage.reload({ waitUntil: "networkidle" });
  await alicePage.waitForTimeout(1500);
  check("the cut task is gone from the list",
    await alicePage.getByText(TITLES[1], { exact: false }).count() === 0);
  check("and the stale id does not inflate the saved filter",
    await filterChip(alicePage).count() === 0,
    `chip still shown: ${await filterChip(alicePage).innerText().catch(() => "")}`);

  console.log("\n11. Being cut out from under the filter, with no action by the player");
  /* The strand shape step 10 cannot see: there the filter was off, so an empty
     list was unremarkable. Here the player is actively filtered when an
     organizer cuts their only saved task, and the change arrives on a poll
     rather than a reload -- no tap of theirs is involved. If the chip were
     hidden at savedCount === 0 they would be looking at an empty task list with
     the control that caused it gone from the screen. */
  await call("/api/admin/tasks", { method: "PATCH", body: JSON.stringify({
    id: taskIds[TITLES[1]], active: true }) });
  await alicePage.reload({ waitUntil: "networkidle" });
  await alicePage.waitForTimeout(1500);
  await filterChip(alicePage).click();
  await alicePage.waitForTimeout(400);
  check("the player is filtered down to their one saved task",
    (await visibleTitles(alicePage)).length === 1,
    JSON.stringify(await visibleTitles(alicePage)));

  await call("/api/admin/tasks", { method: "PATCH", body: JSON.stringify({
    id: taskIds[TITLES[1]], active: false }) });
  await pollNow(alicePage);
  await alicePage.waitForTimeout(1200);
  check("the cut arrives on the poll without a reload",
    await alicePage.getByText(TITLES[1], { exact: false }).count() === 0);
  check("the filter chip survives being emptied by someone else",
    await filterChip(alicePage).count() > 0,
    "chip vanished on a poll -- the player is stranded on an empty list they did not empty");
  const strandedEscape = alicePage.getByRole("button", { name: "Show all tasks" });
  check("and the escape is still offered", await strandedEscape.count() > 0);
  const strandedText = await alicePage.locator(".empty").innerText().catch(() => "");
  note(`empty state reads: ${strandedText.replace(/\s+/g, " ")}`);
  check("the empty state does not claim they saved nothing when they did",
    !/Nothing saved yet/i.test(strandedText), strandedText);
  await shot(alicePage, "saved-stranded-by-organizer");
  await strandedEscape.click();
  await alicePage.waitForTimeout(400);
  check("escaping returns them to a populated list",
    (await visibleTitles(alicePage)).length > 0,
    JSON.stringify(await visibleTitles(alicePage)));
} finally {
  if (browser) await browser.close();
  await teardownTasks();
  await teardown();
  await restoreSettings(settingsBefore);
  const after = await snapshot();
  console.log(`\nreal data intact: ${JSON.stringify(before) === JSON.stringify(after)}`);
  summary("Saved tasks");
}
