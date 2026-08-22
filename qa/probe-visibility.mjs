/**
 * Three things the app knew but would not show anyone.
 *
 * 1. A player could see THAT their team had submitted a task but never what was
 *    actually sent -- so nobody could check they had uploaded to the right task.
 * 2. The judge could only ever see the front of the queue, with no way to reach
 *    anything behind it.
 * 3. The feed showed approved submissions only, hiding the rejected ones.
 *
 * The assertions here go past "an element exists". A media element that renders
 * but never decodes looks identical in the DOM to one that works, so the image
 * checks read naturalWidth -- the same reason the truncation probe measures
 * geometry rather than text. And the judge check approves a submission picked
 * from the BACK of the queue and then verifies in the database that it was that
 * row which changed, because a picker that silently acts on the head of the
 * queue would pass every check that only looks at the screen.
 */
import { chromium } from "@playwright/test";
import {
  BASE, admin, setup, teardown, teardownTasks, snapshot, captureSettings, restoreSettings,
  asOrganizer, asPlayer, check, note, summary, call, seed, shot,
} from "./lib.mjs";

const before = await snapshot();
const settingsBefore = await captureSettings();
let browser;

/** Waits for the poll to bring `text` onto the page. */
const waitForText = (page, text) =>
  page.getByText(text, { exact: false }).first().waitFor({ timeout: 20000 }).then(() => true).catch(() => false);

try {
  await teardown();
  await teardownTasks();
  const fx = await setup({ players: ["__qa Alice", "__qa Bartholomew Fitzwilliam-Vance"], teams: ["__qa Red", "__qa Blue"] });
  const alice = fx.player("__qa Alice");
  const bob = fx.player("__qa Bartholomew Fitzwilliam-Vance");
  const red1 = fx.teamOf("__qa Red", 1);

  // Both on the same team: progress on /submit is team-wide, so Alice must be
  // able to open what Bob sent as well as her own.
  await call("/api/admin/roster", {
    method: "POST",
    body: JSON.stringify({
      round: 1,
      entries: [
        { playerId: alice.id, teamId: red1.id },
        { playerId: bob.id, teamId: red1.id },
      ],
    }),
  });

  const titles = ["__qa Visible task A", "__qa Visible task B", "__qa Visible task C", "__qa Visible task D"];
  const taskIds = [];
  for (const title of titles) {
    const made = await call("/api/admin/tasks", {
      method: "POST",
      body: JSON.stringify({ round: 1, title, points: 3 }),
    });
    if (made.status !== 200) throw new Error(`task create failed: ${JSON.stringify(made.body)}`);
    taskIds.push(made.body.id);
  }

  browser = await chromium.launch();

  /* ------------------------------------------------------------------ */
  console.log("\n1. A player can open what their team submitted");

  // Alice sends task A, Bob sends task B. Both land as pending.
  const aliceSub = await seed({ playerId: alice.id, taskId: taskIds[0] });
  const bobSub = await seed({ playerId: bob.id, taskId: taskIds[1] });

  const pctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await asPlayer(pctx, alice);
  const submitPage = await pctx.newPage();
  await submitPage.goto(`${BASE}/submit`, { waitUntil: "networkidle" });
  check("the task Alice submitted is on screen", await waitForText(submitPage, "__qa Visible task A"));

  const rowA = submitPage.locator(".card-flat").filter({ hasText: "__qa Visible task A" });
  const seeA = rowA.getByRole("button", { name: /^(See|Hide)/ });
  const hasSee = await seeA.count() > 0;
  check("a submitted task offers a way to see what was sent", hasSee,
    "no See control on a task the team has already submitted");

  // Nothing may download until asked: the whole point of not putting thumbnails
  // in the task list is that a player scrolling 33 tasks fetches nothing.
  const eagerMedia = await submitPage.locator(".media-box").count();
  check("no media is fetched until the player asks for it", eagerMedia === 0,
    `${eagerMedia} media boxes rendered before anything was tapped`);

  if (hasSee) {
    await seeA.click();
    const img = rowA.locator(".media-box img");
    const appeared = await img.first().waitFor({ timeout: 20000 }).then(() => true).catch(() => false);
    check("tapping it shows the submitted photo", appeared, "no image rendered inside the task row");

    if (appeared) {
      // An <img> whose src 404s is present, sized and completely invisible.
      await submitPage.waitForTimeout(2500);
      const decoded = await img.first().evaluate((el) => ({ w: el.naturalWidth, src: el.src }));
      check("the photo actually loads rather than rendering as a broken image",
        decoded.w > 0, `naturalWidth 0 for ${decoded.src}`);
    }

    check("Alice's own submission is labelled as hers",
      await rowA.getByText("you", { exact: true }).count() > 0);

    await shot(submitPage, "vis-submit-open");
    await seeA.click();
    check("it collapses again", await rowA.locator(".media-box").count() === 0);
  }

  // Bob's submission sits on the team's task list too, and has to be
  // attributed to him rather than reading as something Alice sent.
  const rowB = submitPage.locator(".card-flat").filter({ hasText: "__qa Visible task B" });
  const seeB = rowB.getByRole("button", { name: /^(See|Hide)/ });
  if (await seeB.count() > 0) {
    await seeB.click();
    await submitPage.waitForTimeout(1500);
    check("a teammate's submission is credited to the teammate, not to you",
      await rowB.getByText("__qa Bartholomew Fitzwilliam-Vance", { exact: false }).count() > 0,
      "Bob's upload does not name Bob on Alice's screen");
    await seeB.click();
  } else {
    check("a teammate's submission can be opened too", false, "no See control on Bob's task");
  }

  /* ------------------------------------------------------------------ */
  console.log("\n2. The judge can reach the whole queue, not just its front");

  // Four pending, in a known order. seed() is sequential, so created_at
  // ascending is A, B, C, D -- and the queue is ordered by created_at.
  const cSub = await seed({ playerId: alice.id, taskId: taskIds[2] });
  const dSub = await seed({ playerId: bob.id, taskId: taskIds[3] });
  note(`queue seeded: A=${aliceSub.slice(0, 8)} B=${bobSub.slice(0, 8)} C=${cSub.slice(0, 8)} D=${dSub.slice(0, 8)}`);

  const octx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await asOrganizer(octx);
  const judgePage = await octx.newPage();
  await judgePage.goto(`${BASE}/judge`, { waitUntil: "networkidle" });
  check("the judge screen loads a queue", await waitForText(judgePage, "__qa Visible task"));

  // Everything waiting has to be reachable. Counting occurrences of each task
  // title catches a list that renders only the first few.
  await judgePage.waitForTimeout(2000);
  const reachable = [];
  for (const t of titles) {
    if (await judgePage.getByText(t, { exact: false }).count() > 0) reachable.push(t);
  }
  check("every submission waiting for review is reachable on screen",
    reachable.length === titles.length,
    `only ${reachable.length} of ${titles.length} visible: ${JSON.stringify(reachable)}`);

  await shot(judgePage, "vis-judge-queue");

  // The one at the BACK. Approving it must change that row and leave the head
  // of the queue untouched -- a picker that quietly acts on queue[0] would
  // otherwise look identical from the outside.
  const backRow = judgePage.locator(".card-flat").filter({ hasText: "__qa Visible task D" });
  const canPick = await backRow.count() > 0;
  check("the back of the queue is tappable", canPick, "no row for the last submission");

  if (canPick) {
    await backRow.getByRole("button").first().click();
    await judgePage.waitForTimeout(1200);
    const focusedTitle = await judgePage.locator(".card .cardhead").first()
      .evaluate((el) => el.closest(".card").innerText).catch(() => "");
    const onTarget = /Visible task D/.test(focusedTitle);
    check("tapping it moves that submission into the review card", onTarget,
      `review card shows: ${JSON.stringify(focusedTitle.slice(0, 120))}`);

    // Only ever press Approve once the card is provably showing OUR fixture.
    // The review card defaults to the head of the queue, which during real
    // testing is one of Jason's own submissions -- and approving that changes
    // the actual scoreboard.
    if (onTarget) {
      const approve = judgePage.getByRole("button", { name: /^(Approve|Update to)/ });
      if (await approve.count() > 0) {
        await approve.first().click();
        await judgePage.waitForTimeout(2500);
      }
    }

    const { data: rows } = await admin
      .from("submissions")
      .select("id,status")
      .in("id", [aliceSub, dSub]);
    const byId = Object.fromEntries((rows ?? []).map((r) => [r.id, r.status]));
    check("the submission the judge picked is the one that got approved",
      byId[dSub] === "approved", `back-of-queue row is ${byId[dSub]}`);
    check("the front of the queue was left alone",
      byId[aliceSub] === "pending",
      `head of queue is ${byId[aliceSub]} — the pick acted on the wrong submission`);
  }

  /* ------------------------------------------------------------------ */
  console.log("\n3. Rejected submissions show up in the feed");

  await call(`/api/judge/${cSub}`, {
    method: "POST",
    body: JSON.stringify({ action: "reject", reason: "Doesn't match the task" }),
  });

  const api = await (await fetch(`${BASE}/api/feed?round=1`)).json();
  const items = api.items ?? [];
  const rejected = items.find((i) => i.id === cSub);
  const approved = items.find((i) => i.id === dSub);
  check("the feed returns the rejected submission", Boolean(rejected),
    `${items.length} items, none of them the rejected one`);
  check("the feed still returns the approved one", Boolean(approved));
  check("the rejected item is marked as rejected", rejected?.status === "rejected",
    JSON.stringify(rejected?.status));
  check("its reject reason comes through", rejected?.rejectReason === "Doesn't match the task",
    JSON.stringify(rejected?.rejectReason));

  const fctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const feedPage = await fctx.newPage();
  await feedPage.goto(`${BASE}/feed`, { waitUntil: "networkidle" });
  check("the rejected submission is on the feed screen",
    await waitForText(feedPage, "__qa Visible task C"));
  await feedPage.waitForTimeout(2000);

  const rejectedCard = feedPage.locator(".card").filter({ hasText: "__qa Visible task C" });
  const cardText = await rejectedCard.first().innerText().catch(() => "");
  // A rejected card showing "0 pts" beside an approved card showing "3 pts"
  // reads as a score that was earned and lost, not as something that never
  // counted. This is the trap worth asserting against.
  check("a rejected card does not show a points score", !/\d+\s*pts/.test(cardText),
    `card reads: ${JSON.stringify(cardText.slice(0, 160))}`);
  check("it says plainly that it didn't count", /didn't count|didn’t count/i.test(cardText),
    JSON.stringify(cardText.slice(0, 160)));
  check("the reason is shown", /Doesn't match|Doesn’t match/i.test(cardText),
    JSON.stringify(cardText.slice(0, 160)));

  const rejectedImg = rejectedCard.locator(".media-box img").first();
  if (await rejectedImg.count() > 0) {
    check("the rejected media actually loads",
      await rejectedImg.evaluate((el) => el.naturalWidth) > 0);
  }

  await shot(feedPage, "vis-feed-mixed");

  // The filter is what keeps a merged feed usable, and it must not drop the
  // approved items it is not filtering out.
  const rejOnly = feedPage.getByRole("button", { name: "Rejected", exact: true });
  if (await rejOnly.count() > 0) {
    await rejOnly.click();
    await feedPage.waitForTimeout(800);
    check("filtering to Rejected hides the approved ones",
      await feedPage.getByText("__qa Visible task D", { exact: false }).count() === 0);
    check("filtering to Rejected keeps the rejected ones",
      await feedPage.getByText("__qa Visible task C", { exact: false }).count() > 0);
    await feedPage.getByRole("button", { name: "Scored", exact: true }).click();
    await feedPage.waitForTimeout(800);
    check("filtering to Scored hides the rejected ones",
      await feedPage.getByText("__qa Visible task C", { exact: false }).count() === 0);
  } else {
    check("the feed offers a way to filter rejected submissions out", false, "no Rejected control");
  }

  /* ------------------------------------------------------------------ */
  console.log("\n4. The player sees the outcome on their own screen");

  await submitPage.reload({ waitUntil: "networkidle" });
  await submitPage.waitForTimeout(2500);
  const rowC = submitPage.locator(".card-flat").filter({ hasText: "__qa Visible task C" });
  const seeC = rowC.getByRole("button", { name: /^(See|Hide)/ });
  check("a rejected submission is still openable, so you can see what got turned down",
    await seeC.count() > 0);
  if (await seeC.count() > 0) {
    await seeC.click();
    await submitPage.waitForTimeout(1500);
    const text = await rowC.first().innerText();
    check("the rejection reason is shown next to it", /Doesn't match|Doesn’t match/i.test(text),
      JSON.stringify(text.slice(0, 160)));
  }
  /* ------------------------------------------------------------------ */
  console.log("\n5. None of it breaks on a narrow phone");

  /* The new places a name appears -- the byline on an opened submission and the
     rows of the waiting list -- are organizer-typed data on the two screens
     people stare at all afternoon. Names here get measured, not read: an
     ellipsised name is still whole in the DOM, which is how "Alex Riv…" once
     passed a suite of text assertions. 320px covers a small phone with iOS
     larger-text turned on, which lays out like a much narrower screen. */
  const nctx = await browser.newContext({ viewport: { width: 320, height: 844 } });
  await asPlayer(nctx, alice);
  await asOrganizer(nctx);
  const narrow = await nctx.newPage();

  await narrow.goto(`${BASE}/submit`, { waitUntil: "networkidle" });
  await waitForText(narrow, "__qa Visible task B");
  const narrowRowB = narrow.locator(".card-flat").filter({ hasText: "__qa Visible task B" });
  const narrowSee = narrowRowB.getByRole("button", { name: /^(See|Hide)/ });
  if (await narrowSee.count() > 0) {
    await narrowSee.click();
    await narrow.waitForTimeout(1500);
    const m = await narrow.evaluate(() => {
      const el = [...document.querySelectorAll(".card-flat .name")].pop();
      return {
        pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
        clipped: el ? el.scrollWidth - el.clientWidth : null,
        text: el ? el.innerText.trim() : null,
      };
    });
    note(`320px submit: byline "${m.text}" clipped by ${m.clipped}px`);
    check("opening a submission doesn't scroll the page sideways", m.pageOverflow <= 1,
      `document is ${m.pageOverflow}px wider than the viewport`);
    check("the submitter's name is shown in full at 320px", m.clipped !== null && m.clipped <= 1,
      `"${m.text}" clipped by ${m.clipped}px`);
    await shot(narrow, "vis-submit-narrow");
  }

  await narrow.goto(`${BASE}/judge`, { waitUntil: "networkidle" });
  await waitForText(narrow, "__qa Visible task");
  await narrow.waitForTimeout(1500);
  const judgeOverflow = await narrow.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth
  );
  check("the judge's waiting list doesn't scroll the page sideways", judgeOverflow <= 1,
    `document is ${judgeOverflow}px wider than the viewport`);
  await shot(narrow, "vis-judge-narrow");

  await narrow.goto(`${BASE}/feed`, { waitUntil: "networkidle" });
  await waitForText(narrow, "__qa Visible task");
  await narrow.waitForTimeout(1500);
  const feedOverflow = await narrow.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth
  );
  check("the feed with its filter row doesn't scroll the page sideways", feedOverflow <= 1,
    `document is ${feedOverflow}px wider than the viewport`);
  await shot(narrow, "vis-feed-narrow");
} finally {
  if (browser) await browser.close();
  await teardownTasks();
  await teardown();
  await restoreSettings(settingsBefore);
  const after = await snapshot();
  console.log(`\nreal data intact: ${JSON.stringify(before) === JSON.stringify(after)}`);
  summary("Submission visibility");
}
