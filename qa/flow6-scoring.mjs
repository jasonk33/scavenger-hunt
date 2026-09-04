/**
 * Flow 6 — scoring invariants that would be silently wrong rather than loudly
 * broken, plus how heavy the feed actually is on a phone.
 */
import { chromium } from "@playwright/test";
import {
  BASE, PIN, admin, setup, teardown, teardownTasks, snapshot, captureSettings, restoreSettings, seed, check, note, summary, call, cloneSubmission, asOrganizer,
} from "./lib.mjs";

const before = await snapshot();
const settingsBefore = await captureSettings();
let browser;

const score = async (round, teamId) => {
  const lb = await (await fetch(`${BASE}/api/leaderboard?round=${round}`)).json();
  return (lb.rows ?? []).find((r) => r.teamId === teamId) ?? null;
};

try {
  await teardown();
  await teardownTasks();
  const fx = await setup();
  const alice = fx.player("__qa Alice"), bob = fx.player("__qa Bob");
  const red1 = fx.teamOf("__qa Red", 1);
  await call("/api/admin/roster", { method: "POST", body: JSON.stringify({ round: 1, entries: [
    { playerId: alice.id, teamId: red1.id }, { playerId: bob.id, teamId: red1.id },
  ] }) });
  // Cut tasks are deactivated rather than deleted, and the API refuses a
  // submission to one -- so an unfiltered pick lands on a cut task and the
  // driver dies before it asserts anything.
  const { data: tasks } = await admin.from("tasks").select("id,title,points").eq("round", 1).eq("points", 5).eq("active", true).limit(2);
  const task = tasks[0];
  note(`using a ${task.points}-point task, two teammates both submitting it`);

  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await asOrganizer(ctx);
  const judge = await ctx.newPage();

  /* ---- once per team ---- */
  console.log("\n1. Two teammates submit the SAME task and both get approved");
  const s1 = await seed({ playerId: alice.id, taskId: task.id });
  const s2 = await seed({ playerId: bob.id, taskId: task.id });

  await judge.goto(`${BASE}/judge`, { waitUntil: "networkidle" });
  await judge.waitForSelector(".media-box", { timeout: 15000 });
  await judge.getByRole("button", { name: /^Approve/ }).click();
  await judge.waitForTimeout(2000);
  const afterFirst = await score(1, red1.id);
  note(`after the first approval: ${JSON.stringify(afterFirst)}`);

  await judge.waitForSelector(".media-box", { timeout: 15000 }).catch(() => {});
  const dupWarned = await judge.getByText("team already has this task approved", { exact: false }).count();
  check("the judge is warned the team already has this task", dupWarned > 0);
  await judge.getByRole("button", { name: /^Approve/ }).click();
  await judge.waitForTimeout(2000);
  const afterSecond = await score(1, red1.id);
  note(`after the duplicate approval: ${JSON.stringify(afterSecond)}`);

  check("a task counts ONCE per team even when two teammates both get approved",
    afterSecond.points === afterFirst.points,
    `score went ${afterFirst.points} -> ${afterSecond.points}; the same task was paid twice`);
  check("tasksScored does not double-count", afterSecond.tasksScored === afterFirst.tasksScored,
    `${afterFirst.tasksScored} -> ${afterSecond.tasksScored}`);

  /* ---- the judge's LATEST ruling is the one that counts ---- */
  console.log("\n2. A re-submission judged at a different value replaces the old score");
  /*
   * The bug this exists for: a team redoes a task after its point value was
   * changed, the judge approves the new attempt at the new value, and the score
   * doesn't move -- because scoring used to count the HIGHEST approval and the
   * stale, more generous one kept winning.
   *
   * task_points is snapshotted at upload, so a row genuinely carries whatever
   * the task was worth when it was sent. Editing it here rather than editing the
   * task reproduces that without touching a real task's value.
   */
  const s3 = await seed({ playerId: alice.id, taskId: task.id });
  await admin.from("submissions").update({ task_points: 1 }).eq("id", s3);
  await call(`/api/judge/${s3}`, { method: "POST", body: JSON.stringify({ action: "approve" }) });
  const revalued = await score(1, red1.id);
  note(`after approving a re-submission worth 1 instead of ${task.points}: ${JSON.stringify(revalued)}`);
  check("the most recently judged approval is the one that counts",
    revalued.points === 1,
    `expected 1, got ${revalued.points} — the older, higher approval is still winning`);
  check("a re-submission does not add a second score for the same task",
    revalued.tasksScored === afterFirst.tasksScored,
    `${afterFirst.tasksScored} -> ${revalued.tasksScored}`);

  console.log("\n3. Re-approving an older submission makes it the live ruling again");
  // Proves the rule is "latest", not "lowest": the same tap has to be able to
  // move the score back up, or a judge who mis-set a task's points is stuck.
  await call(`/api/judge/${s1}`, { method: "POST", body: JSON.stringify({
    action: "approve", expectedStatus: "approved" }) });
  const restored = await score(1, red1.id);
  check("re-approving an already-approved item is a real decision, not a no-op",
    restored.points === task.points, `expected ${task.points}, got ${restored.points}`);

  console.log("\n4. Rejecting the counted submission falls back to a surviving approval");
  await call(`/api/judge/${s1}`, { method: "POST", body: JSON.stringify({
    action: "reject", reason: "Wrong round", expectedStatus: "approved" }) });
  const fallback = await score(1, red1.id);
  // Falls back to s3 -- the latest of what is still approved. A rejection must
  // never count as "the latest ruling" itself, or rejecting one duplicate would
  // un-score a task the team already got right.
  check("rejecting the counted duplicate falls back to the latest surviving approval",
    fallback.points === 1, `expected 1, got ${fallback.points}`);
  check("the task is still scored once", fallback.tasksScored === afterFirst.tasksScored,
    `${afterFirst.tasksScored} -> ${fallback.tasksScored}`);

  console.log("\n5. Rejecting every submission for a task zeroes it");
  for (const id of [s2, s3]) {
    await call(`/api/judge/${id}`, { method: "POST", body: JSON.stringify({
      action: "reject", reason: "Wrong round", expectedStatus: "approved" }) });
  }
  const zeroed = await score(1, red1.id);
  check("with all duplicates rejected the task pays nothing",
    (zeroed?.points ?? 0) === 0, JSON.stringify(zeroed));

  /* ---- CSV export ---- */
  console.log("\n6. CSV export");
  // Put all three approvals back, so the CSV has a genuine duplicate to dedup
  // rather than a single row that trivially counts.
  for (const id of [s2, s3, s1]) {
    await call(`/api/judge/${id}`, { method: "POST", body: JSON.stringify({
      action: "approve", expectedStatus: "rejected" }) });
  }
  // format=csv explicitly. Without it this endpoint returns JSON, and a check
  // for "contains a comma" passes against JSON just as happily -- which is how
  // this step spent its whole life asserting nothing about the CSV at all.
  const csvRes = await fetch(`${BASE}/api/export?format=csv`, { headers: { cookie: `organizer=${PIN}` } });
  const csv = await csvRes.text();
  check("export returns a CSV", csvRes.ok && csv.startsWith("round,team,player,task,"), csv.slice(0, 80));
  check("export contains the __qa team", csv.includes("__qa Red"), csv.slice(0, 200));
  /*
   * The CSV is what somebody actually totals in Sheets at the awards, so its
   * own dedup has to reach the same answer as the view. The team total printed
   * at the bottom is the line that gets read out, so that is what is checked.
   */
  const live = await score(1, red1.id);
  const totals = csv.slice(csv.indexOf("TEAM TOTALS")).split("\n");
  const totalLine = totals.find((l) => l.startsWith(`1,"__qa Red"`));
  check("the CSV team total agrees with the leaderboard",
    totalLine === `1,"__qa Red",${live.points},${live.tasksScored}`,
    `${totalLine} vs leaderboard ${live.points}/${live.tasksScored}`);
  // Three approvals exist for this task and exactly one of them may count, or
  // the spreadsheet pays the team twice for it. Parsed properly rather than
  // split on commas: task titles contain them, and a check that silently
  // mis-parses is worse than no check.
  const parseRow = (line) => (line.match(/"((?:[^"]|"")*)"/g) ?? []).map((c) => c.slice(1, -1).replace(/""/g, '"'));
  // The header row is the one line that is NOT quoted, and column names never
  // contain a comma, so it splits safely.
  const header = csv.split("\n")[0].split(",");
  const countsAt = header.indexOf("counts");
  const teamAt = header.indexOf("team");
  const statusAt = header.indexOf("status");
  const dataRows = csv.slice(0, csv.indexOf("TEAM TOTALS")).split("\n").slice(1).map(parseRow);
  const mine = dataRows.filter((r) => r[teamAt] === "__qa Red" && r[statusAt] === "approved");
  const counted = mine.filter((r) => r[countsAt] === "1");
  note(`csv rows for the __qa team's approvals: ${mine.length}, marked as counting: ${counted.length}`);
  check("exactly one duplicate is marked as counting in the CSV",
    mine.length > 1 && counted.length === 1,
    `${mine.length} approved rows, ${counted.length} counting`);
  const anonCsv = await fetch(`${BASE}/api/export?format=csv`);
  check("export is PIN-gated", anonCsv.status === 401, String(anonCsv.status));

  /* ---- a group's own pills vs the team's total ---- */
  console.log("\n7. A multi-file group's pills add up to what the team is credited");
  /*
   * Every screen shows a scored entry as a baseline plus a bonus, and the
   * leaderboard shows one total. If those two disagree a team is looking at
   * evidence of points it was not paid, which is the same class of bug as the
   * CSV disagreeing with the view above.
   *
   * A COMPETITION task with a decided winner is the case that separates them:
   * the bonus lives on the task, is chosen after the round, and is therefore
   * added on read -- it is not in the `points_awarded` frozen onto the row. And
   * it takes TWO files, because a group is anchored on its oldest file while
   * the row that actually scores is the newest. Looking the anchor up in the
   * scoring map missed on every multi-file group, silently fell back to the
   * frozen number, and dropped the bonus.
   */
  const comp = await call("/api/admin/tasks", { method: "POST", body: JSON.stringify({
    round: 1, title: "__qa competition group task", points: 5,
    scoringMode: "competition", competitionBonus: 5 }) });
  const compId = comp.body.id;
  const anchor = await seed({ playerId: alice.id, taskId: compId });
  await seed({ playerId: alice.id, taskId: compId, name: "photo-2.jpg", groupWith: anchor });
  const { data: compFiles } = await admin.from("submissions").select("id,group_id").eq("task_id", compId);
  check("the two files are one piece of evidence",
    // Non-null explicitly: two ungrouped rows both carry null, and comparing
    // them for equality would pass while grouping was completely broken.
    compFiles.length === 2 && Boolean(compFiles[0].group_id) &&
      compFiles[0].group_id === compFiles[1].group_id,
    JSON.stringify(compFiles.map((r) => r.group_id)));
  await call(`/api/judge/${anchor}`, { method: "POST", body: JSON.stringify({
    action: "approve", expectedStatus: "pending" }) });
  await call("/api/admin/tasks", { method: "PATCH", body: JSON.stringify({
    id: compId, winnerTeamId: red1.id }) });

  const feedJson = await (await fetch(`${BASE}/api/feed?round=1`)).json();
  const post = (feedJson.items ?? []).find((i) => i.taskTitle === "__qa competition group task");
  note(`feed post: ${JSON.stringify(post && { base: post.basePoints, bonus: post.bonusPoints, files: post.media.length })}`);
  check("the feed post carries both files", post?.media.length === 2, String(post?.media.length));
  check("the feed shows the bonus the team won", post?.bonusPoints === 5,
    `bonus ${post?.bonusPoints} — a multi-file group lost the competition bonus`);

  const teamView = await (await fetch(`${BASE}/api/leaderboard/${red1.id}?round=1`, {
    headers: { cookie: `organizer=${PIN}` } })).json();
  const pillTotal = (teamView.entries ?? []).reduce((sum, e) => sum + e.basePoints + e.bonusPoints, 0);
  const teamNow = await score(1, red1.id);
  note(`entry pills add to ${pillTotal}; team_scores says ${teamNow.points}`);
  check("the team's own entries add up to the score beside its name",
    pillTotal === teamNow.points,
    `${pillTotal} on the entries vs ${teamNow.points} on the leaderboard`);

  /*
   * The same evidence through the two endpoints the player screens read. Both
   * resolve a group's score, and neither had any coverage: /api/state feeds the
   * task card AND the expanded list under it, which anchor on opposite ends of
   * the group, so a per-row split let one card show two different numbers for
   * one piece of evidence.
   */
  const aliceState = await (await fetch(`${BASE}/api/state?playerId=${alice.id}`)).json();
  const compSubs = (aliceState.submissions ?? []).filter((x) => x.task_id === compId && x.status === "approved");
  note(`/api/state pills for the group: ${JSON.stringify(compSubs.map((x) => `${x.basePoints}+${x.bonusPoints}`))}`);
  check("every file of the group reports the same score", compSubs.length === 2 &&
    new Set(compSubs.map((x) => `${x.basePoints}+${x.bonusPoints}`)).size === 1,
    JSON.stringify(compSubs.map((x) => ({ base: x.basePoints, bonus: x.bonusPoints }))));
  check("and it is the score the task was actually paid", compSubs[0]?.bonusPoints === 5,
    `bonus ${compSubs[0]?.bonusPoints} — the expanded list disagrees with the card above it`);

  // "See other teams' entries" is read by somebody NOT on the team that scored.
  await call("/api/admin/players", { method: "POST", body: JSON.stringify({ names: "__qa Carol" }) });
  const { data: carolRow } = await admin.from("players").select("id").eq("name", "__qa Carol").single();
  await call("/api/admin/roster", { method: "POST", body: JSON.stringify({
    round: 1, entries: [{ playerId: carolRow.id, teamId: fx.teamOf("__qa Blue", 1).id }] }) });
  const others = await (await fetch(`${BASE}/api/task-entries?taskId=${compId}&playerId=${carolRow.id}`)).json();
  const shown = (others.entries ?? [])[0];
  note(`other teams' entry: ${JSON.stringify(shown && { base: shown.basePoints, bonus: shown.bonusPoints, files: shown.media.length })}`);
  check("another team sees the whole piece of evidence", shown?.media.length === 2,
    `${shown?.media.length} file(s) — the rest of the group was dropped`);
  check("and sees what it actually scored", shown?.bonusPoints === 5, String(shown?.bonusPoints));

  /* ---- feed weight ---- */
  console.log("\n8. How heavy is the feed on a phone?");
  const { data: template } = await admin.from("submissions").select("*").eq("id", s1).single();
  const clones = Array.from({ length: 40 }, (_, i) => {
    return cloneSubmission(template, { status: "approved", points_awarded: 5,
             judged_at: new Date(Date.now() - i * 60000).toISOString() });
  });
  await admin.from("submissions").insert(clones);

  const feedCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const feed = await feedCtx.newPage();
  let bytes = 0, mediaRequests = 0;
  feed.on("response", async (r) => {
    if (/storage\/v1\/object\/public/.test(r.url())) {
      mediaRequests += 1;
      const len = Number(r.headers()["content-length"] ?? 0);
      bytes += len;
    }
  });
  await feed.goto(`${BASE}/feed`, { waitUntil: "networkidle" });
  await feed.waitForTimeout(4000);

  const imgInfo = await feed.evaluate(() => {
    const els = [...document.querySelectorAll(".media-box img, .media-box video")];
    return {
      total: els.length,
      lazy: els.filter((e) => e.getAttribute("loading") === "lazy").length,
      videosPreloadAuto: els.filter((e) => e.tagName === "VIDEO" && e.getAttribute("preload") === "auto").length,
    };
  });
  note(`feed rendered ${imgInfo.total} media elements; ${imgInfo.lazy} marked loading="lazy"`);
  note(`media requests fired on load: ${mediaRequests}, ~${(bytes / 1024 / 1024).toFixed(2)} MB`);
  check("the feed does not eagerly download every media item at once",
    imgInfo.lazy === imgInfo.total || mediaRequests < imgInfo.total,
    `${mediaRequests} media requests fired for ${imgInfo.total} items with 0 lazy — on a phone at the party this downloads the whole feed immediately`);
  note(`videos with preload="auto" in the feed: ${imgInfo.videosPreloadAuto}`);

  await feed.screenshot({ path: new URL("./shots/feed-heavy.png", import.meta.url).pathname });

} finally {
  if (browser) await browser.close();
  await teardown();
  // This driver creates a task of its own now, and `teardown` only sweeps
  // players, teams, roster and submissions -- so without this the fixture task
  // stays ACTIVE in round 1 and shows up in every player's list.
  await teardownTasks();
  await restoreSettings(settingsBefore);
  const after = await snapshot();
  const intact = JSON.stringify(before) === JSON.stringify(after);
  console.log(`\nreal data intact: ${intact}`);
  if (!intact) console.log("BEFORE", JSON.stringify(before), "\nAFTER ", JSON.stringify(after));
  summary("Flow 6 (scoring + feed weight)");
}
