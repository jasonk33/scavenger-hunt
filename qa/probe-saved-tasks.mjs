/**
 * Saved tasks: the per-player shortlist a guest builds on their first pass
 * through a task list far longer than a round allows them to attempt, and the
 * filter that shows only those. (Do not hardcode the count here -- it is edited
 * live from the canvas and moved by seven inside one hour during development.
 * Derive it as active tasks minus unrevealed secrets, which is the filter
 * /api/state itself applies.)
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
  BASE, admin, setup, teardown, teardownTasks, snapshot, captureSettings, restoreSettings,
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
/* The saved chip now lives behind the Filters fold, so every driver has to make
   the same tap a player makes. What did NOT move is the strand guarantee: the
   fold's own button is always on screen and names whatever filter is inside it,
   so a player is never looking at a short list with no visible cause. */
const foldButton = (page) => page.locator(".filters-toggle");
const openFold = async (page) => {
  const button = foldButton(page);
  if (await button.count() === 0) return;
  if (await button.getAttribute("aria-expanded") === "true") return;
  await button.click();
  await page.waitForTimeout(250);
};
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
  await openFold(page);
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
  await openFold(page);
  await filterChip(page).click();
  await page.waitForTimeout(400);
  const shown = await visibleTitles(page);
  check("filtering shows only the saved task", shown.length === 1 && shown[0] === TITLES[0],
    JSON.stringify(shown));
  check("the filter chip stays on screen while filtering", await filterChip(page).count() > 0);
  check("and the fold that holds it names the filter that is on",
    /saved/i.test(await foldButton(page).innerText()),
    `fold button reads ${JSON.stringify(await foldButton(page).innerText())} -- a player who folds it away has nothing on screen telling them why the list is short`);

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
  await openFold(bobPage);
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
  await openFold(alicePage);
  check("and Alice is offered the saved filter", await filterChip(alicePage).count() > 0);

  console.log("\n10. A task cut mid-event drops out of the saved count, not just the list");
  await call("/api/admin/tasks", { method: "PATCH", body: JSON.stringify({
    id: taskIds[TITLES[1]], active: false }) });
  await alicePage.reload({ waitUntil: "networkidle" });
  await alicePage.waitForTimeout(1500);
  check("the cut task is gone from the list",
    await alicePage.getByText(TITLES[1], { exact: false }).count() === 0);
  await openFold(alicePage);
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
  await openFold(alicePage);
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
  check("and the fold still names it, for a player who had folded it away",
    /saved/i.test(await foldButton(alicePage).innerText()),
    `fold button reads ${JSON.stringify(await foldButton(alicePage).innerText().catch(() => ""))}`);
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

  console.log("\n12. A reset clears the shortlist on a phone nobody is holding");
  /* The stars live in localStorage, so the reset route cannot reach them --
     it bumps a marker in settings and each device clears itself when it sees a
     value it has not seen before. Bumping the marker directly is the same
     signal a real reset sends, without deleting anyone's photos to send it.
     It has to land on a poll, not a reload: a player whose phone is in their
     pocket must not come back to a shortlist of tasks that no longer exist. */
  const aliceStar = () => starIn(cardFor(alicePage, TITLES[0]));
  await aliceStar().click();
  await alicePage.waitForTimeout(400);
  check("a task is saved before the reset",
    await aliceStar().getAttribute("aria-pressed") === "true");

  await admin.from("settings").upsert(
    { key: "saved_epoch", value: `__qa-${Date.now()}` },
    { onConflict: "key" }
  );
  /* Waited for rather than asserted at a fixed delay: usePoll drops a manual
     refresh while a scheduled one is in flight, so the marker can legitimately
     arrive a tick late. Still a real assertion -- against a device that never
     clears, this waits out the whole window and fails. */
  const clearedWithin = async (timeoutMs = 12000) => {
    const end = Date.now() + timeoutMs;
    for (;;) {
      await pollNow(alicePage);
      if ((await aliceStar().getAttribute("aria-pressed")) === "false") return true;
      if (Date.now() > end) return false;
      await alicePage.waitForTimeout(500);
    }
  };
  check("the reset clears the saved task on the next poll", await clearedWithin());
  check("and the saved filter goes with it", await filterChip(alicePage).count() === 0);

  /* Clearing once per reset, not once per poll. A device that re-cleared every
     tick would delete each star a second after it was tapped, which is worse
     than never clearing at all. */
  await aliceStar().click();
  await alicePage.waitForTimeout(400);
  await pollNow(alicePage);
  await alicePage.waitForTimeout(2500);
  check("a star saved after the reset survives the next poll",
    await aliceStar().getAttribute("aria-pressed") === "true",
    String(await aliceStar().getAttribute("aria-pressed")));

  /* A phone that has never seen the marker must adopt it rather than treat it
     as news: shipping this must not wipe a shortlist that predates it. */
  const freshCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await asPlayer(freshCtx, alice);
  await freshCtx.addInitScript(
    ([key, ids]) => localStorage.setItem(key, JSON.stringify(ids)),
    [`sh.saved.${alice.id}`, [taskIds[TITLES[0]]]]
  );
  const freshPage = await freshCtx.newPage();
  await freshPage.goto(`${BASE}/submit`, { waitUntil: "networkidle" });
  await freshPage.waitForTimeout(1800);
  check("a device that has never seen the marker keeps its existing shortlist",
    await starIn(cardFor(freshPage, TITLES[0])).getAttribute("aria-pressed") === "true",
    String(await starIn(cardFor(freshPage, TITLES[0])).getAttribute("aria-pressed")));
} finally {
  if (browser) await browser.close();
  await teardownTasks();
  await teardown();
  await restoreSettings(settingsBefore);
  // restoreSettings only writes keys back; it cannot remove one this run
  // invented, and a leftover row would show up as real data having changed.
  if (settingsBefore && settingsBefore.saved_epoch === undefined) {
    await admin.from("settings").delete().eq("key", "saved_epoch");
  }
  const after = await snapshot();
  console.log(`\nreal data intact: ${JSON.stringify(before) === JSON.stringify(after)}`);
  summary("Saved tasks");
}
