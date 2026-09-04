/**
 * Several files as one submission, and the note that says what they are.
 *
 * Two features that only exist if they reach the judge, so most of what follows
 * is asserted on the judge screen rather than in the database.
 *
 * The assertions go past "an element is present":
 *
 *  - Images are checked through `naturalWidth`. A media element that renders but
 *    never decodes looks identical in the DOM to one that works, and a set of
 *    three where only the first actually loads is precisely the bug this feature
 *    could introduce.
 *  - Approving is verified in the DATABASE, across every row of the group. A
 *    judge screen that showed three photos and approved one would pass every
 *    check that only looks at the screen, and would silently mis-score.
 *  - Grouping is attacked, not just exercised: a client naming another team's
 *    submission must not be able to staple its file onto their evidence.
 *
 * Every driver here follows the safe judging pattern -- confirm the card is
 * showing this fixture, then click -- rather than trusting the front of the
 * queue.
 */
import { chromium } from "@playwright/test";
import {
  BASE, admin, setup, teardown, teardownTasks, snapshot, captureSettings, restoreSettings,
  asOrganizer, asPlayer, check, note, summary, call, seed, shot,
} from "./lib.mjs";

const before = await snapshot();
const settingsBefore = await captureSettings();
let browser;

const waitForText = (page, text) =>
  page.getByText(text, { exact: false }).first().waitFor({ timeout: 20000 })
    .then(() => true).catch(() => false);

/** Every row of the group this submission belongs to. */
const groupOf = async (id) => {
  const { data: anchor } = await admin.from("submissions").select("id,group_id").eq("id", id).maybeSingle();
  if (!anchor?.group_id) return anchor ? [anchor.id] : [];
  const { data } = await admin.from("submissions").select("id").eq("group_id", anchor.group_id);
  return (data ?? []).map((r) => r.id);
};

const rowsOf = async (ids) => {
  const { data } = await admin
    .from("submissions")
    .select("id,status,points_awarded,note,group_id")
    .in("id", ids);
  return data ?? [];
};

try {
  await teardown();
  await teardownTasks();
  const fx = await setup({ players: ["__qa Alice", "__qa Bob"], teams: ["__qa Red", "__qa Blue"] });
  const alice = fx.player("__qa Alice");
  const bob = fx.player("__qa Bob");
  const red1 = fx.teamOf("__qa Red", 1);
  const blue1 = fx.teamOf("__qa Blue", 1);

  // Alice on Red, Bob on Blue: two teams, so the cross-team grouping attack in
  // section 4 is a real attempt rather than a formality.
  await call("/api/admin/roster", {
    method: "POST",
    body: JSON.stringify({
      round: 1,
      entries: [
        { playerId: alice.id, teamId: red1.id },
        { playerId: bob.id, teamId: blue1.id },
      ],
    }),
  });

  const titles = ["__qa Group task A", "__qa Group task B", "__qa Group task C", "__qa Group task D"];
  const taskIds = [];
  for (const title of titles) {
    const made = await call("/api/admin/tasks", {
      method: "POST",
      body: JSON.stringify({ round: 1, title, points: 5 }),
    });
    if (made.status !== 200) throw new Error(`task create failed: ${JSON.stringify(made.body)}`);
    taskIds.push(made.body.id);
  }

  browser = await chromium.launch();

  /* ------------------------------------------------------------------ */
  console.log("\n1. Three files are one thing to judge");

  const first = await seed({ playerId: alice.id, taskId: taskIds[0], note: "the guy in the red hat is a stranger" });
  await seed({ playerId: alice.id, taskId: taskIds[0], groupWith: first, name: "second.jpg" });
  await seed({ playerId: alice.id, taskId: taskIds[0], groupWith: first, file: "clip.mp4", name: "third.mp4" });

  const trio = await groupOf(first);
  check("the three files share one group", trio.length === 3, `got ${trio.length}`);
  check("every file carries the note", (await rowsOf(trio)).every((r) => r.note?.includes("red hat")));

  const octx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await asOrganizer(octx);
  const judge = await octx.newPage();
  await judge.goto(`${BASE}/judge`, { waitUntil: "networkidle" });
  check("the judge screen loads the fixture", await waitForText(judge, "__qa Group task A"));

  const waitingPill = judge.locator("header .pill").first();
  check(
    "the queue counts one decision, not three files",
    (await waitingPill.textContent())?.trim() === "1 waiting",
    `saw "${(await waitingPill.textContent())?.trim()}"`
  );

  const card = judge.locator(".card").filter({ hasText: "__qa Group task A" }).first();
  const shownMedia = card.locator(".media-box");
  check("all three files are on the review card", (await shownMedia.count()) === 3, `saw ${await shownMedia.count()}`);

  // Rendered is not the same as loaded. A set where only the first decodes is
  // exactly the failure this feature could introduce, and it is invisible in
  // the DOM.
  const decoded = await card.locator("img.media").evaluateAll((els) =>
    els.filter((e) => e.complete && e.naturalWidth > 0).length
  );
  check("both photos in the set actually decoded", decoded === 2, `${decoded} of 2 decoded`);
  check("the video in the set is rendered as a video", (await card.locator("video.media").count()) === 1);

  await shot(judge, "groups-judge-card");

  /* ------------------------------------------------------------------ */
  console.log("\n2. The note reaches the judge");

  check("the player's note is on the review card", await waitForText(judge, "the guy in the red hat is a stranger"));
  check("the note is labelled as theirs", await waitForText(judge, "They said"));

  /* ------------------------------------------------------------------ */
  console.log("\n3. One decision covers the whole set");

  // Safe judging: confirm the card really is showing this fixture before
  // clicking anything, rather than trusting the front of the queue.
  const heading = await card.locator("div").filter({ hasText: /^__qa Group task A$/ }).first().count();
  check("the card on screen is this fixture before approving", heading > 0);

  await card.getByRole("button", { name: /^Approve/ }).click();
  await judge.waitForTimeout(1500);

  const afterApprove = await rowsOf(trio);
  check(
    "all three rows were approved together",
    afterApprove.length === 3 && afterApprove.every((r) => r.status === "approved"),
    afterApprove.map((r) => r.status).join(",")
  );
  check(
    "every row of the set carries the award",
    afterApprove.every((r) => r.points_awarded === 5),
    afterApprove.map((r) => r.points_awarded).join(",")
  );

  // Scoring counts a task once per team, so three approved rows must not be
  // fifteen points. This is the whole reason a set is one decision.
  const { data: score } = await admin
    .from("team_scores")
    .select("points,tasks_scored")
    .eq("team_id", red1.id)
    .maybeSingle();
  check("the task scored once, not once per file", score?.points === 5, `got ${score?.points}`);
  check("the task counts as one scored task", score?.tasks_scored === 1, `got ${score?.tasks_scored}`);

  /* ------------------------------------------------------------------ */
  console.log("\n4. A group cannot be forged across teams or tasks");

  const mine = await seed({ playerId: alice.id, taskId: taskIds[1] });

  // Bob is on the other team. Naming Alice's submission must not attach his
  // file to Red's evidence -- the server reads the anchor's team from the
  // database rather than trusting what the client claims.
  const stolen = await seed({ playerId: bob.id, taskId: taskIds[1], groupWith: mine, name: "stolen.jpg" });
  const [mineRow] = await rowsOf([mine]);
  const [stolenRow] = await rowsOf([stolen]);
  check(
    "another team's file did not join the group",
    mineRow.group_id !== stolenRow.group_id,
    `both ${mineRow.group_id}`
  );

  // Same player, different task: also a different piece of evidence.
  const otherTask = await seed({ playerId: alice.id, taskId: taskIds[2], groupWith: mine, name: "othertask.jpg" });
  const [otherRow] = await rowsOf([otherTask]);
  check("a different task did not join the group", mineRow.group_id !== otherRow.group_id);

  // A group id that does not exist at all falls back to standing alone rather
  // than failing the upload -- losing a player's photo in the field would be a
  // far worse outcome than an extra card for the judge.
  const orphan = await seed({
    playerId: alice.id,
    taskId: taskIds[3],
    groupWith: "00000000-0000-0000-0000-000000000000",
    name: "orphan.jpg",
  });
  const [orphanRow] = await rowsOf([orphan]);
  check("an unknown anchor still produces a usable submission", Boolean(orphanRow?.group_id));

  /* ------------------------------------------------------------------ */
  console.log("\n5. Notes are editable while waiting and frozen once judged");

  const late = await call(`/api/submissions/${mine}`, {
    method: "PATCH",
    body: JSON.stringify({ noteOnly: true, note: "actually it was the blue hat" }),
  });
  check("a waiting submission accepts a note", late.status === 200, `status ${late.status}`);
  check("the new note is stored", (await rowsOf([mine]))[0].note === "actually it was the blue hat");

  const locked = await call(`/api/submissions/${first}`, {
    method: "PATCH",
    body: JSON.stringify({ noteOnly: true, note: "rewriting history" }),
  });
  check("a judged submission refuses a note edit", locked.status === 409, `status ${locked.status}`);
  check(
    "the judged note is untouched",
    (await rowsOf([first]))[0].note?.includes("red hat"),
    "note was overwritten"
  );

  // A finalize call must never be mistaken for a note edit: that would leave the
  // row stuck in `uploading`, out of the queue and unscored, with nothing on any
  // screen reporting a problem.
  const notes = await seed({ playerId: alice.id, taskId: taskIds[3], name: "finalize.jpg" });
  check("an ordinary finalize still reaches the queue", (await rowsOf([notes]))[0].status === "pending");

  /* ------------------------------------------------------------------ */
  console.log("\n6. The player sees their set as one thing");

  const pctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await asPlayer(pctx, alice);
  const submit = await pctx.newPage();
  await submit.goto(`${BASE}/submit`, { waitUntil: "networkidle" });
  check("the player's task list loads", await waitForText(submit, "__qa Group task A"));

  const rowA = submit.locator(".card-flat").filter({ hasText: "__qa Group task A" });
  // Anchored at BOTH ends: the same row carries "See other teams' entries", so
  // an unanchored /^(See|Hide)/ matches two buttons and Playwright refuses to
  // act on either. That button landed in August and quietly broke this probe.
  const seeA = rowA.getByRole("button", { name: /^(See( \d+)?|Hide)$/ });
  check(
    "three files count as one submission to look at",
    (await seeA.textContent())?.trim() === "See",
    `button said "${(await seeA.textContent())?.trim()}"`
  );

  await seeA.click();
  await submit.waitForTimeout(600);
  check("the set says how many files it holds", await waitForText(submit, "3 files"));
  check("all three are shown to the player", (await rowA.locator(".media-box").count()) === 3);
  check("the judged note is shown back to the player", await waitForText(submit, "red hat"));

  const rowB = submit.locator(".card-flat").filter({ hasText: "__qa Group task B" });
  await rowB.getByRole("button", { name: /^(See( \d+)?|Hide)$/ }).click();
  await submit.waitForTimeout(600);
  check(
    "a waiting submission offers to take another file",
    await rowB.getByRole("button", { name: /Add another file/ }).isVisible()
  );
  check(
    "a waiting submission offers an editable note",
    await rowB.locator("textarea").isVisible()
  );

  /* ------------------------------------------------------------------ */
  console.log("\n7. The feed shows a set as one post");

  const fctx = await browser.newContext({ viewport: { width: 320, height: 844 } });
  const feed = await fctx.newPage();
  await feed.goto(`${BASE}/feed`, { waitUntil: "networkidle" });
  check("the feed loads the approved set", await waitForText(feed, "__qa Group task A"));

  const post = feed.locator(".card").filter({ hasText: "__qa Group task A" }).first();
  check("only one file loads before it is asked for", (await post.locator(".media-box").count()) === 1);
  check("the post says how many are behind the tap", await waitForText(feed, "Show 2 more files"));
  check("the note is the caption", await waitForText(feed, "red hat"));

  await post.getByRole("button", { name: /Show 2 more files/ }).click();
  await feed.waitForTimeout(800);
  check("expanding reveals the rest of the set", (await post.locator(".media-box").count()) === 3);

  // Long organizer- and player-typed text has repeatedly been the thing that
  // broke these screens on a phone. 320px is narrower than any real handset.
  const overflow = await feed.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  check("nothing overflows sideways at 320px", overflow <= 0, `${overflow}px of horizontal scroll`);
  await shot(feed, "groups-feed-post");

  /* ------------------------------------------------------------------ */
  console.log("\n8. Counts everywhere mean decisions, not files");

  const state = await (await fetch(`${BASE}/api/state?playerId=${alice.id}`)).json();
  // Alice: the approved set (1), task B (1), task C (1), task D orphan (1) and
  // the finalize fixture (1) -- five pieces of evidence across seven files.
  check(
    "the player's own counts are in submissions, not files",
    state.stats.submitted === 5,
    `got ${state.stats.submitted}`
  );
  check("the player's approved count collapses the set", state.stats.approved === 1, `got ${state.stats.approved}`);
  check("the player's points count the task once", state.stats.points === 5, `got ${state.stats.points}`);

  const board = await (await fetch(`${BASE}/api/leaderboard?round=1`)).json();
  const red = (board.rows ?? []).find((r) => r.teamId === red1.id);
  check("the leaderboard counts waiting decisions", red?.pending === 4, `got ${red?.pending}`);

  note("cleaning up");
} finally {
  await restoreSettings(settingsBefore);
  await teardown();
  await teardownTasks();
  await browser?.close();
}

const after = await snapshot();
const intact = JSON.stringify(before) === JSON.stringify(after);
console.log(`\nreal data intact: ${intact}`);
if (!intact) {
  console.log("BEFORE", JSON.stringify(before));
  console.log("AFTER ", JSON.stringify(after));
}
const bad = summary("probe-groups-notes");
process.exit(bad.length || !intact ? 1 : 0);
