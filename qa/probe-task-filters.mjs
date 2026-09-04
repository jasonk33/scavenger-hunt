/**
 * Finding your way around a 50-task list.
 *
 * The list is long enough that a player scrolling it loses track of what tier
 * they are in, so three things carry the navigation: a points pill on every
 * card, a heading per tier that stays pinned while you scroll that tier, and
 * chips that narrow the list to one tier.
 *
 * The pinned heading is the part worth a driver. It is positioned at
 * `top: var(--topbar-h)`, a variable published by <Topbar> from a measurement of
 * the real nav-and-notice bar -- because that bar's height is not a constant,
 * it grows by however many lines a broadcast notice wraps to. Every way this can
 * regress (Topbar reverted to a plain <header>, the variable renamed, the offset
 * swapped for a hardcoded constant) fails the same way: the heading slides
 * underneath the nav and is simply not there any more. Nothing else in the suite
 * would notice, and a screenshot taken at the top of the page looks perfect --
 * the heading is only wrong once you have scrolled past it. So this asserts
 * geometry, at both bar heights.
 *
 * The other one is the strand shape from AGENTS.md, the same one the saved
 * filter has: a player filtered to one tier when an organizer cuts every task in
 * it is looking at an empty list, and if the chips went with the tasks the
 * control that caused it would be gone from the screen.
 *
 * Fixtures sit on a points tier no live task uses, found at runtime rather than
 * hardcoded -- tiers are edited from the canvas and the 7-pointers were all cut
 * at one point. That is what lets the strand test empty a whole tier without
 * touching a single real task.
 */
import { chromium } from "@playwright/test";
import {
  BASE, setup, teardown, teardownTasks, snapshot, captureSettings, restoreSettings,
  asPlayer, check, note, summary, call, pollNow, shot, seed,
} from "./lib.mjs";

const before = await snapshot();
const settingsBefore = await captureSettings();
let browser;

/* Long enough that the section outlasts a screen, so its heading is genuinely
   pinned rather than merely sitting at the top of a short list. */
const FIXTURES = Array.from({ length: 12 }, (_, i) => `__qa tier task ${i + 1}`);

const chips = (page) => page.locator(".tier-filter");
/* Scoped to the tier row rather than matched by name across the page: the status
   filter has an "All" of its own, and a bare getByRole would match both. */
const chipNamed = (page, name) =>
  chips(page).filter({ hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) });
const foldButton = (page) => page.locator(".filters-toggle");
/* The tier chips fold away, so the driver taps the fold open exactly as a player
   does. Folding does not hide state: the button names whatever is inside it. */
const openFold = async (page) => {
  const button = foldButton(page);
  if (await button.count() === 0) return;
  if (await button.getAttribute("aria-expanded") === "true") return;
  await button.click();
  await page.waitForTimeout(250);
};

/** Whichever tier heading is currently stuck to the bottom of the top bar. */
const pinnedHeading = (page) =>
  page.evaluate(() => {
    const bar = document.querySelector(".topbar").getBoundingClientRect();
    const found = [...document.querySelectorAll(".tier-head")]
      .map((h) => ({ text: h.innerText.trim(), rect: h.getBoundingClientRect() }))
      .filter((h) => h.rect.top >= 0 && h.rect.top <= bar.bottom + 1);
    return {
      barBottom: Math.round(bar.bottom),
      variable: getComputedStyle(document.documentElement).getPropertyValue("--topbar-h").trim(),
      count: found.length,
      text: found[0]?.text ?? null,
      top: found[0] ? Math.round(found[0].rect.top) : null,
    };
  });

try {
  await teardown();
  await teardownTasks();
  const fx = await setup();
  const alice = fx.player("__qa Alice");
  await call("/api/admin/roster", { method: "POST", body: JSON.stringify({
    round: 1, entries: [{ playerId: alice.id, teamId: fx.teamOf("__qa Red", 1).id }] }) });

  /* A tier the live list does not use, so cutting every task in it later empties
     a whole tier and strands nobody but the fixture. */
  const state = await (await fetch(`${BASE}/api/state?playerId=${alice.id}`)).json();
  const liveTiers = new Set((state.tasks ?? []).map((t) => t.points));
  const TIER = [7, 9, 11, 13, 17, 19].find((p) => !liveTiers.has(p));
  check("found a points tier the live list does not use", Boolean(TIER),
    `live tiers: ${JSON.stringify([...liveTiers].sort((a, b) => a - b))}`);
  note(`live tiers ${JSON.stringify([...liveTiers].sort((a, b) => a - b))}; fixtures on ${TIER}`);

  const ids = [];
  for (const title of FIXTURES) {
    const made = await call("/api/admin/tasks", { method: "POST", body: JSON.stringify({
      round: 1, title, points: TIER }) });
    ids.push(made.body.id);
  }

  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await asPlayer(ctx, alice);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/submit`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);

  console.log("\n1. Every card says what it is worth");
  const counts = await page.evaluate(() => ({
    cards: document.querySelectorAll(".card-flat").length,
    priced: document.querySelectorAll(".card-flat .pill-solid").length,
  }));
  note(`${counts.cards} task cards on screen`);
  check("every task card carries a points pill", counts.cards > 0 && counts.priced === counts.cards,
    `${counts.priced} pills across ${counts.cards} cards`);

  console.log("\n2. A chip per tier, derived from the round rather than hardcoded");
  check("the tier chips start folded away", await chips(page).count() === 0,
    "four stacked filter rows leave almost no task list above the fold");
  await openFold(page);
  const labels = (await chips(page).allInnerTexts()).map((s) => s.trim());
  note(`chips: ${JSON.stringify(labels)}`);
  check("there is an All chip", labels.includes("All"));
  check("the fixture tier has a chip", labels.includes(`${TIER} pts`), JSON.stringify(labels));
  check("every live tier has a chip",
    [...liveTiers].every((p) => labels.includes(`${p} pt${p === 1 ? "" : "s"}`)),
    JSON.stringify(labels));
  check("All starts selected", await chips(page).first().getAttribute("aria-pressed") === "true");

  console.log("\n3. Filtering to one tier");
  await chipNamed(page, `${TIER} pts`).click();
  await page.waitForTimeout(500);
  check("the fold names the tier it is holding, so folding it hides no state",
    (await foldButton(page).innerText()).includes(`${TIER} pts`),
    `fold button reads ${JSON.stringify(await foldButton(page).innerText())}`);
  const filtered = await page.evaluate(() => ({
    headings: [...document.querySelectorAll("section h2.tier-head")].map((h) => h.innerText.trim()),
    pills: [...new Set([...document.querySelectorAll(".card-flat .pill-solid")].map((p) => p.innerText.trim()))],
  }));
  check("exactly one section is left", filtered.headings.length === 1, JSON.stringify(filtered.headings));
  check("and every card in it is that tier", filtered.pills.length === 1 && filtered.pills[0] === `${TIER} pts`,
    JSON.stringify(filtered.pills));

  console.log("\n4. The heading stays on screen while you scroll its section");
  const flat = await pinnedHeading(page);
  check("the topbar publishes its measured height", /^\d+(\.\d+)?px$/.test(flat.variable),
    `--topbar-h is ${JSON.stringify(flat.variable)} -- without it the heading has nothing to stop against`);
  await page.evaluate(() => window.scrollTo(0, 900));
  await page.waitForTimeout(400);
  const scrolled = await pinnedHeading(page);
  note(`scrolled: ${JSON.stringify(scrolled)}`);
  check("a heading is pinned once you have scrolled past it", scrolled.count === 1,
    `${scrolled.count} headings within the top bar`);
  check("the pinned heading clears the nav rather than hiding under it",
    scrolled.count === 1 && scrolled.top >= scrolled.barBottom - 1,
    `heading top ${scrolled.top} vs bar bottom ${scrolled.barBottom}`);
  check("and it is the section actually being scrolled", scrolled.text === `${TIER} POINTS`,
    JSON.stringify(scrolled.text));
  await shot(page, "tier-head-pinned");

  console.log("\n5. The same, with a broadcast notice making the bar taller");
  /* The whole reason the offset is measured. A notice is several lines tall and
     is set on the day; against a hardcoded offset the heading would sit behind
     it, which is the same as not being there. */
  await call("/api/admin/settings", { method: "POST", body: JSON.stringify({
    notice: "__qa Head back to the bar by 3:30 sharp for the team remix, no exceptions, we are running to a timetable" }) });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1800);
  await openFold(page);
  await chipNamed(page, `${TIER} pts`).click();
  await page.waitForTimeout(400);
  await page.evaluate(() => window.scrollTo(0, 900));
  await page.waitForTimeout(500);
  const withNotice = await pinnedHeading(page);
  note(`with notice: ${JSON.stringify(withNotice)}`);
  check("the published height grew with the notice",
    parseFloat(withNotice.variable) > parseFloat(flat.variable),
    `${flat.variable} -> ${withNotice.variable}`);
  check("the heading still clears the whole bar, notice included",
    withNotice.count === 1 && withNotice.top >= withNotice.barBottom - 1,
    `heading top ${withNotice.top} vs bar bottom ${withNotice.barBottom} -- the heading is behind the notice`);
  await shot(page, "tier-head-pinned-with-notice");
  await call("/api/admin/settings", { method: "POST", body: JSON.stringify({ notice: "" }) });

  console.log("\n6. Being emptied out from under the filter must not strand the player");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1800);
  await openFold(page);
  await chipNamed(page, `${TIER} pts`).click();
  await page.waitForTimeout(400);
  check("the player is filtered down to the fixture tier",
    (await page.locator(".card-flat").count()) === FIXTURES.length,
    `${await page.locator(".card-flat").count()} cards`);

  for (const id of ids) {
    await call("/api/admin/tasks", { method: "PATCH", body: JSON.stringify({ id, active: false }) });
  }
  await pollNow(page);
  await page.waitForTimeout(1500);
  check("the cut arrives on the poll without a reload",
    (await page.getByText(FIXTURES[0], { exact: false }).count()) === 0);
  check("the points chips survive the tier being emptied by someone else",
    (await chips(page).count()) > 0,
    "the chips vanished on a poll -- the player is stranded on an empty list they did not empty");
  const stillThere = (await chips(page).allInnerTexts()).map((s) => s.trim());
  check("including a chip for the tier they are still filtered to",
    stillThere.includes(`${TIER} pts`), JSON.stringify(stillThere));
  check("and that chip is still marked as the one in effect",
    await chipNamed(page, `${TIER} pts`).getAttribute("aria-pressed") === "true",
    "nothing on screen is marked as the reason the list is empty");
  const emptyCount = await page.locator(".empty").count();
  check("exactly one empty state renders, never both stacked", emptyCount === 1,
    `found ${emptyCount} .empty elements`);
  const emptyText = emptyCount === 1 ? await page.locator(".empty").innerText() : "";
  note(`empty state reads: ${emptyText.replace(/\s+/g, " ")}`);
  check("the empty state does not blame a search box the player never typed in",
    emptyCount === 1 && !/shorter search/i.test(emptyText), JSON.stringify(emptyText));
  /* An escape rather than a sentence naming a chip. The chips fold away, so
     "tap All" was an instruction to tap something that may not be on screen. */
  check("and it offers a way out that is on the screen",
    await page.locator(".empty").getByRole("button", { name: "Show all tasks" }).count() === 1,
    JSON.stringify(emptyText));
  await shot(page, "tier-stranded-by-organizer");

  console.log("\n7. All gets them out again");
  await chipNamed(page, "All").click();
  await page.waitForTimeout(500);
  check("tapping All restores a populated list",
    (await page.locator(".card-flat").count()) > 0,
    `${await page.locator(".card-flat").count()} cards`);
  check("and the fixture tier's chip is gone with its tasks",
    !(await chips(page).allInnerTexts()).map((s) => s.trim()).includes(`${TIER} pts`),
    JSON.stringify((await chips(page).allInnerTexts()).map((s) => s.trim())));

  console.log("\n8. Each empty state blames only the filter that is actually on");
  /* The saved and points filters narrow the same list, so the saved empty state
     has to name whichever one is really responsible. It used to name the points
     filter unconditionally, which told a player looking at a chip row reading
     "All" to go and clear a filter they had never set -- the same misdirection
     the unsaved empty state above branches to avoid. Search-only is the case
     that catches it, because there the points filter is provably off. */
  for (const id of ids) {
    await call("/api/admin/tasks", { method: "PATCH", body: JSON.stringify({ id, active: true }) });
  }
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1800);
  await page.locator(".card-flat").first().getByRole("button", { name: "Save for later" }).click();
  await page.waitForTimeout(300);
  await openFold(page);
  await page.locator(".saved-filter").click();
  await page.waitForTimeout(300);
  await page.getByPlaceholder("Search tasks").fill("__qa nothing matches this");
  await page.waitForTimeout(500);

  const activeChip = (await page.locator(".tier-filter.is-on").innerText()).trim();
  const savedEmpty = await page.locator(".empty").innerText();
  note(`points chip on: ${JSON.stringify(activeChip)}; empty reads: ${savedEmpty.replace(/\s+/g, " ")}`);
  check("the points filter really is off for this case", activeChip === "All", activeChip);
  check("the saved empty state does not blame a points filter that is not set",
    !/points filter/i.test(savedEmpty),
    `told the player to clear a points filter while the chip row reads "All": ${JSON.stringify(savedEmpty.replace(/\s+/g, " "))}`);
  check("and it names the search, which is what actually emptied the list",
    /search/i.test(savedEmpty), JSON.stringify(savedEmpty.replace(/\s+/g, " ")));

  console.log("\n9. Filtering by what the judge has done with it");
  /* The reason this filter exists: by the second half of a round most of a
     fifty-row list is work the team has already dealt with, and scrolling past
     it to find what is left is the whole cost. Three fixture tasks, one in each
     terminal state, so every chip has something to be right and wrong about.
     The colours are asserted alongside, because the chip row and the card tint
     are one derivation and a green card under a "To do" chip is the failure. */
  const [doneTask, waitTask, failTask] = [ids[3], ids[4], ids[5]];
  const doneSub = await seed({ playerId: alice.id, taskId: doneTask });
  const failSub = await seed({ playerId: alice.id, taskId: failTask });
  await seed({ playerId: alice.id, taskId: waitTask });
  await call(`/api/judge/${doneSub}`, { method: "POST", body: JSON.stringify({ action: "approve" }) });
  await call(`/api/judge/${failSub}`, { method: "POST", body: JSON.stringify({
    action: "reject", reason: "__qa not even close" }) });

  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1800);
  await openFold(page);
  await chipNamed(page, `${TIER} pts`).click();
  await page.waitForTimeout(500);

  const seg = page.locator(".status-filter");
  check("the status filter is on screen once the team has sent something",
    await seg.count() === 1, `${await seg.count()} status controls`);

  /* Four labels in one row, on the narrowest screen the app is held to. Sized
     into four equal parts they do not fit: "Rejected" is two and a half times
     the width of "All" and spills out of its share into its neighbour, with
     under 4px of slack left even at 320px. Nothing else would notice -- the
     row is width-constrained, so the page does not scroll sideways and
     probe-truncation's overflow assertion stays green while the label bleeds. */
  await page.setViewportSize({ width: 260, height: 844 });
  await page.waitForTimeout(400);
  const segFit = await page.evaluate(() => {
    const row = document.querySelector(".status-filter");
    return [...row.querySelectorAll("button")].map((el) => ({
      label: el.textContent.trim(),
      box: Math.round(el.getBoundingClientRect().width),
      needs: el.scrollWidth,
    }));
  });
  const spilling = segFit.filter((x) => x.needs > x.box + 1);
  note(`status labels at 260px: ${segFit.map((x) => `${x.label}:${x.box}`).join(" ")}`);
  check("no status label spills out of its own button at 260px",
    spilling.length === 0,
    `${JSON.stringify(spilling)} -- the label runs into the one beside it`);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);

  /** The tint on each fixture card, keyed by title. */
  const tints = () =>
    page.evaluate((titles) =>
      Object.fromEntries(
        titles.map((t) => {
          const card = [...document.querySelectorAll(".card-flat")]
            .find((c) => c.innerText.includes(t));
          const cls = card ? [...card.classList].find((c) => c.startsWith("card-w")
            || c === "card-done" || c === "card-fail") : "gone";
          return [t, cls ?? "none"];
        })
      ), FIXTURES.slice(3, 6));

  const painted = await tints();
  note(`tints: ${JSON.stringify(painted)}`);
  check("the scored task is green", painted[FIXTURES[3]] === "card-done", JSON.stringify(painted));
  check("the one with the judge is amber, not left looking untouched",
    painted[FIXTURES[4]] === "card-wait",
    `a task already sent rendered as ${JSON.stringify(painted[FIXTURES[4]])} -- indistinguishable from work still to do`);
  check("and the rejected one is red", painted[FIXTURES[5]] === "card-fail", JSON.stringify(painted));
  await shot(page, "status-tints");

  /* Scoped to the task list. A page-wide getByText also matched the rejections
     banner at the top, which lists a rejected task by name whatever the filter
     is set to -- so every bucket looked like it still contained it. */
  const titlesOn = async () => {
    const out = [];
    for (const t of FIXTURES) {
      if (await page.locator("section .card-flat").filter({ hasText: t }).count() > 0) out.push(t);
    }
    return out;
  };

  await seg.getByRole("button", { name: "To do" }).click();
  await page.waitForTimeout(400);
  const todo = await titlesOn();
  check("To do drops everything the team has already sent",
    !todo.includes(FIXTURES[3]) && !todo.includes(FIXTURES[4]) && !todo.includes(FIXTURES[5]),
    JSON.stringify(todo));
  check("and keeps the ones nobody has touched", todo.length === FIXTURES.length - 3,
    `${todo.length} of ${FIXTURES.length - 3} untouched fixtures`);

  await seg.getByRole("button", { name: "Rejected" }).click();
  await page.waitForTimeout(400);
  check("Rejected shows only the one that needs redoing",
    JSON.stringify(await titlesOn()) === JSON.stringify([FIXTURES[5]]),
    JSON.stringify(await titlesOn()));

  await seg.getByRole("button", { name: "Sent", exact: true }).click();
  await page.waitForTimeout(400);
  const sent = await titlesOn();
  check("Sent covers both scored and still-with-the-judge",
    JSON.stringify(sent) === JSON.stringify([FIXTURES[3], FIXTURES[4]]), JSON.stringify(sent));

  console.log("\n10. A bucket emptied by another filter must not blame the wrong one");
  /* The case that made the status empty state take precedence: filtered to
     Rejected with a points chip on, the points empty state announced that
     nothing is worth that tier any more, in a round that was full of them. */
  await seg.getByRole("button", { name: "Rejected" }).click();
  await page.waitForTimeout(300);
  await page.getByPlaceholder("Search tasks").fill("__qa nothing matches this");
  await page.waitForTimeout(500);
  const bucketEmpty = await page.locator(".empty").count();
  check("exactly one empty state renders, never both stacked", bucketEmpty === 1,
    `found ${bucketEmpty} .empty elements`);
  const bucketText = bucketEmpty === 1 ? await page.locator(".empty").innerText() : "";
  note(`empty state reads: ${bucketText.replace(/\s+/g, " ")}`);
  check("it does not claim nothing was rejected when something was",
    !/Nothing rejected/i.test(bucketText), JSON.stringify(bucketText));
  check("and it names the search that is really narrowing it",
    /search/i.test(bucketText), JSON.stringify(bucketText));
  const out = page.locator(".empty").getByRole("button", { name: "Show all tasks" });
  await out.click();
  await page.waitForTimeout(500);
  check("and one tap clears every filter at once",
    (await page.getByPlaceholder("Search tasks").inputValue()) === ""
      && await page.locator(".card-flat").count() > 3,
    `${await page.locator(".card-flat").count()} cards, search ${JSON.stringify(await page.getByPlaceholder("Search tasks").inputValue())}`);


  console.log("\n11. An empty bucket must own up to being empty, not blame a filter");
  /* The other direction of section 10, and the one that was wrong: with nothing
     rejected in the whole round, "your search is narrowing it too" points at a
     control that is narrowing nothing, and the true reason never gets said. */
  /* expectedStatus is not optional here: it defaults to "pending", so a bare
     approve on an already-rejected row is refused with a 409 and the setup
     silently does nothing -- which is exactly what happened, and left this
     asserting against a round that still had a rejection in it. */
  const unrejected = await call(`/api/judge/${failSub}`, { method: "POST", body: JSON.stringify({
    action: "approve", expectedStatus: "rejected" }) });
  check("the fixture rejection was cleared, so the bucket really is empty",
    unrejected.status === 200, `judge returned ${unrejected.status}: ${JSON.stringify(unrejected.body)}`);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1800);
  await page.locator(".status-filter").getByRole("button", { name: "Rejected" }).click();
  await page.waitForTimeout(300);
  await page.getByPlaceholder("Search tasks").fill("__qa nothing matches this");
  await page.waitForTimeout(500);
  const noneText = await page.locator(".empty").innerText();
  note(`empty state reads: ${noneText.replace(/\s+/g, " ")}`);
  check("it says the bucket is empty rather than blaming the search",
    /Nothing rejected/i.test(noneText),
    `nothing is rejected all round, and the empty state said: ${JSON.stringify(noneText.replace(/\s+/g, " "))}`);
  check("and it does not point at a filter that is narrowing nothing",
    !/narrowing it too/i.test(noneText), JSON.stringify(noneText.replace(/\s+/g, " ")));

} finally {
  if (browser) await browser.close();
  await teardownTasks();
  await teardown();
  await restoreSettings(settingsBefore);
  const after = await snapshot();
  console.log(`\nreal data intact: ${JSON.stringify(before) === JSON.stringify(after)}`);
  summary("Task list navigation");
}
