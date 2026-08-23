#!/usr/bin/env node
/**
 * End-to-end smoke test against a running server and a real Supabase project.
 *
 *   npm run dev            # in one terminal
 *   npm run smoke          # in another
 *
 * Exercises the whole submission path the way a phone does -- reserve, upload
 * over TUS, complete, judge, score -- and then asserts the one bug that would be
 * silent and catastrophic: that remixing the roster does not move Round 1 scores.
 *
 * Creates its own throwaway player and cleans up after itself.
 */

import * as tus from "tus-js-client";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";

// This script writes to the SAME project the live app uses -- it flips
// active_round and closes submissions. Running it against production mid-event
// would show every player "Submissions are closed right now" with no
// explanation, so refuse unless it is pointed at localhost or explicitly forced.
const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(BASE);
if (!isLocal && !process.argv.includes("--allow-prod")) {
  console.error(
    `\nRefusing to run against ${BASE}.\n` +
      `This test closes submissions and switches rounds on the live project.\n` +
      `Re-run with --allow-prod only if the event is not currently running.\n`
  );
  process.exit(1);
}

// Read .env.local directly so the script needs no extra tooling.
const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);

const PIN = env.ORGANIZER_PIN ?? "";
const BUCKET = env.SUPABASE_BUCKET || "hunt";
const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

let cookie = "";
let passed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  \x1b[32mok\x1b[0m   ${name}`);
  } else {
    failures.push(name);
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function call(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", cookie, ...(init.headers ?? {}) },
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

const NAME = `__smoke_${Date.now()}`;
const TEAM_A = "__smoke Team A";
const TEAM_B = "__smoke Team B";
let playerId, teamA, teamB, teamAlt, taskId, submissionId, objectName;
// Captured before the test mutates anything, so the restore in `finally` always
// has something to put back even if main() throws on its first statement.
let settingsBefore = null;

async function restoreSettings() {
  if (!settingsBefore) return;
  try {
    await call("/api/admin/settings", {
      method: "POST",
      body: JSON.stringify({
        active_round: settingsBefore.active_round,
        submissions_open: String(settingsBefore.submissions_open),
      }),
    });
    console.log(
      `  (restored active_round=${settingsBefore.active_round} submissions_open=${settingsBefore.submissions_open})`
    );
  } catch (e) {
    console.error(
      `\n  !! COULD NOT RESTORE SETTINGS: ${e.message}\n` +
        `  !! Set active_round=${settingsBefore.active_round} and ` +
        `submissions_open=${settingsBefore.submissions_open} by hand in Admin.\n`
    );
  }
}

async function cleanup() {
  try {
    if (submissionId) await admin.from("submissions").delete().eq("id", submissionId);
    if (objectName) await admin.storage.from(BUCKET).remove([objectName]);
    if (playerId) {
      await admin.from("roster").delete().eq("player_id", playerId);
      await admin.from("players").delete().eq("id", playerId);
    }
    await admin.from("teams").delete().in("name", [TEAM_A, TEAM_B]);
  } catch (e) {
    console.log("  (cleanup warning)", e.message);
  }
}

async function main() {
  console.log(`\nSmoke test against ${BASE}\n`);

  // --- config -------------------------------------------------------------
  const login = await call("/api/admin/login", {
    method: "POST",
    body: JSON.stringify({ pin: PIN }),
  });
  check("organizer login", login.status === 200, JSON.stringify(login.body));

  const health = await call("/api/admin/health");
  check("health endpoint responds", health.status === 200);
  for (const c of health.body?.checks ?? []) check(`health: ${c.name}`, c.ok, c.detail);

  // --- fixtures -----------------------------------------------------------
  const seeded = (await call("/api/admin/data")).body;
  check("round 1 teams seeded", seeded.teams.filter((t) => t.round === 1).length >= 2);
  check("round 2 teams seeded", seeded.teams.filter((t) => t.round === 2).length >= 1);
  check("tasks seeded", seeded.tasks.length > 0, `${seeded.tasks.length} tasks`);
  if (!seeded.tasks.length) throw new Error("Seed data missing — run supabase/setup.sql");

  /*
   * The test scores against its OWN throwaway teams, never the real ones.
   *
   * Reusing a real team means every absolute assertion below ("the team now has
   * 3 points") silently becomes wrong the moment anyone plays with the app for
   * real -- and it reports as an app bug when it is only contamination. Fresh
   * teams start at zero and nothing else ever writes to them.
   */
  await admin.from("teams").upsert(
    [
      { round: 1, name: TEAM_A, color: "#111111", sort_order: 9001 },
      { round: 2, name: TEAM_A, color: "#111111", sort_order: 9001 },
      { round: 1, name: TEAM_B, color: "#222222", sort_order: 9002 },
      { round: 2, name: TEAM_B, color: "#222222", sort_order: 9002 },
    ],
    { onConflict: "round,name", ignoreDuplicates: true }
  );

  const data = (await call("/api/admin/data")).body;
  teamA = data.teams.find((t) => t.round === 1 && t.name === TEAM_A);
  teamB = data.teams.find((t) => t.round === 2 && t.name === TEAM_B);
  teamAlt = data.teams.find((t) => t.round === 1 && t.name === TEAM_B);
  check("created isolated test teams", Boolean(teamA && teamB && teamAlt));
  if (!teamA || !teamB || !teamAlt) throw new Error("Could not create test teams");

  const settingsBackup = data.settings;
  settingsBefore = settingsBackup;
  await call("/api/admin/settings", {
    method: "POST",
    body: JSON.stringify({ active_round: 1, submissions_open: "true" }),
  });

  const created = await admin.from("players").insert({ name: NAME }).select("id").single();
  playerId = created.data.id;
  check("created test player", Boolean(playerId));

  // Deliberately different teams per round: this is the remix.
  await call("/api/admin/roster", {
    method: "POST",
    body: JSON.stringify({ round: 1, playerId, teamId: teamA.id }),
  });
  await call("/api/admin/roster", {
    method: "POST",
    body: JSON.stringify({ round: 2, playerId, teamId: teamB.id }),
  });

  const state = (await call(`/api/state?playerId=${playerId}`)).body;
  check("player sees their round 1 team", state.team?.id === teamA.id, state.team?.name);
  check("tasks are visible", (state.tasks ?? []).length > 0, `${state.tasks?.length} tasks`);
  check(
    "unrevealed secret tasks are hidden",
    (state.tasks ?? []).every((t) => !t.is_secret || t.revealed_at)
  );
  check("upload key is a JWT", /^ey[A-Za-z0-9_-]+\./.test(state.upload?.anonKey ?? ""));

  taskId = state.tasks[0].id;
  const taskPoints = state.tasks[0].points;

  // --- the submission path ------------------------------------------------
  // A .mov name on purpose: the response must relabel it as video/mp4, which is
  // what stops Chrome from downloading iPhone videos instead of playing them.
  const init = (
    await call("/api/submissions", {
      method: "POST",
      body: JSON.stringify({
        playerId,
        taskId,
        fileName: "smoke-clip.mov",
        fileType: "video/quicktime",
      }),
    })
  ).body;
  submissionId = init.submissionId;
  objectName = init.objectName;
  check("submission reserved", Boolean(submissionId), JSON.stringify(init));
  check(".mov is relabelled video/mp4", init.contentType === "video/mp4", init.contentType);
  check("object path is organized by round and team", objectName?.startsWith("round-1/"), objectName);

  // Real TUS upload through the same endpoint and headers the browser uses.
  const payload = Buffer.from("smoke test payload");
  await new Promise((resolve, reject) => {
    const up = new tus.Upload(payload, {
      endpoint: state.upload.endpoint,
      chunkSize: 6 * 1024 * 1024,
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      headers: {
        authorization: `Bearer ${state.upload.anonKey}`,
        apikey: state.upload.anonKey,
        "x-upsert": "true",
      },
      uploadSize: payload.length,
      metadata: {
        bucketName: state.upload.bucket,
        objectName,
        contentType: init.contentType,
        cacheControl: "3600",
      },
      onSuccess: resolve,
      onError: reject,
    });
    up.start();
  }).then(
    () => check("TUS upload to Storage", true),
    (e) => check("TUS upload to Storage", false, e.message)
  );

  const publicRes = await fetch(
    `${env.SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${objectName}`
  );
  check("uploaded file is publicly readable", publicRes.ok, `HTTP ${publicRes.status}`);
  check(
    "stored content-type is video/mp4",
    publicRes.headers.get("content-type")?.includes("video/mp4"),
    publicRes.headers.get("content-type") ?? ""
  );

  const done = await call(`/api/submissions/${submissionId}`, {
    method: "PATCH",
    body: JSON.stringify({ sizeBytes: payload.length, mediaType: init.contentType }),
  });
  check("submission marked pending", done.status === 200, JSON.stringify(done.body));

  const replay = await call(`/api/submissions/${submissionId}`, {
    method: "PATCH",
    body: JSON.stringify({ sizeBytes: 1 }),
  });
  check("a replayed completion is rejected", replay.status === 409);

  // --- judging ------------------------------------------------------------
  const queue = (await call("/api/judge/queue")).body;
  const mine = queue.queue.find((q) => q.id === submissionId);
  check("submission appears in the judge queue", Boolean(mine));
  check("queue exposes a playable media URL", Boolean(mine?.mediaUrl?.includes(objectName)));
  check("queue marks it as video", mine?.isVideo === true);

  const approve = await call(`/api/judge/${submissionId}`, {
    method: "POST",
    body: JSON.stringify({ action: "approve" }),
  });
  check("approve succeeds", approve.status === 200, JSON.stringify(approve.body));
  check(
    "points come from the task, not the client",
    approve.body?.submission?.points_awarded === taskPoints,
    `${approve.body?.submission?.points_awarded} vs ${taskPoints}`
  );

  // The client does not get to say what a task is worth. Nothing in the request
  // body should be able to move the number.
  const inflated = await call(`/api/judge/${submissionId}`, {
    method: "POST",
    body: JSON.stringify({
      action: "approve",
      expectedStatus: "approved",
      points_awarded: 999,
      pointsAwarded: 999,
      bonus: 99,
    }),
  });
  check(
    "a client-supplied point value is ignored",
    inflated.body?.submission?.points_awarded === taskPoints,
    `${inflated.body?.submission?.points_awarded} vs ${taskPoints}`
  );

  // Two organizers judging at once always see the same oldest item. The second
  // decision must be refused, not silently overwrite the first.
  const doubleJudge = await call(`/api/judge/${submissionId}`, {
    method: "POST",
    body: JSON.stringify({ action: "reject", reason: "race" }),
  });
  check(
    "a second judge cannot overwrite an existing decision",
    doubleJudge.status === 409,
    `HTTP ${doubleJudge.status}`
  );

  const stillApproved = (await call("/api/judge/queue?round=1")).body.recent.find(
    (r) => r.id === submissionId
  );
  check("the first decision survived the race", stillApproved?.status === "approved", stillApproved?.status);

  // A player who tapped the wrong name on the join screen lands on the wrong
  // team, so the judge must be able to move the submission. It must NOT be
  // movable to a team from the other round.
  const otherTeam = teamAlt;
  const reassign = await call(`/api/judge/${submissionId}`, {
    method: "POST",
    body: JSON.stringify({ action: "reassign", teamId: otherTeam.id, expectedStatus: "approved" }),
  });
  check("a submission can be moved to the right team", reassign.status === 200, JSON.stringify(reassign.body));

  const movedBoard = (await call("/api/leaderboard?round=1")).body;
  const movedTo = movedBoard.rows.find((r) => r.teamId === otherTeam.id);
  check("the points followed the reassignment", (movedTo?.points ?? 0) >= taskPoints, `${movedTo?.points}`);

  const crossRoundMove = await call(`/api/judge/${submissionId}`, {
    method: "POST",
    body: JSON.stringify({ action: "reassign", teamId: teamB.id, expectedStatus: "approved" }),
  });
  check("cross-round reassignment is refused", crossRoundMove.status === 409, `HTTP ${crossRoundMove.status}`);

  // Put it back so the remix assertions below measure team A.
  await call(`/api/judge/${submissionId}`, {
    method: "POST",
    body: JSON.stringify({ action: "reassign", teamId: teamA.id, expectedStatus: "approved" }),
  });

  // Editing a task's wording and value must not rescore anything already judged.
  const renamed = await call("/api/admin/tasks", {
    method: "PATCH",
    body: JSON.stringify({ id: taskId, points: taskPoints === 10 ? 1 : 10 }),
  });
  check("a task's point value can be edited", renamed.status === 200, JSON.stringify(renamed.body));

  const afterEdit = (await call("/api/leaderboard?round=1")).body.rows.find(
    (r) => r.teamId === teamA.id
  );
  check(
    "editing a task does not rescore what was already judged",
    afterEdit?.points === taskPoints,
    `expected ${taskPoints}, got ${afterEdit?.points}`
  );
  await call("/api/admin/tasks", {
    method: "PATCH",
    body: JSON.stringify({ id: taskId, points: taskPoints }),
  });

  // --- re-review and rejection visibility ---------------------------------
  // Changing a call you got wrong must be possible at any point, and the team
  // has to find out they were rejected or they will never redo it.
  const flip = await call(`/api/judge/${submissionId}`, {
    method: "POST",
    body: JSON.stringify({ action: "reject", reason: "changed my mind", expectedStatus: "approved" }),
  });
  check("an approved submission can be re-reviewed and rejected", flip.status === 200, JSON.stringify(flip.body));

  const stale = await call(`/api/judge/${submissionId}`, {
    method: "POST",
    body: JSON.stringify({ action: "approve", expectedStatus: "pending" }),
  });
  check("a stale judge is still refused after a re-review", stale.status === 409, `HTTP ${stale.status}`);

  const rejectedState = (await call(`/api/state?playerId=${playerId}&_=${Date.now()}`)).body;
  const seen = (rejectedState.rejections ?? []).find((r) => r.taskId === taskId);
  check("the team is told which task was rejected", Boolean(seen), JSON.stringify(rejectedState.rejections));
  check("the rejection carries the reason", seen?.reason === "changed my mind", seen?.reason);

  // The reason is free text the judge types, so the cap lives on the server. It
  // renders on the player's task list and in the feed, where a pasted essay
  // would push everything else off a phone screen.
  const capped = await call(`/api/judge/${submissionId}`, {
    method: "POST",
    body: JSON.stringify({ action: "reject", reason: "x".repeat(400), expectedStatus: "rejected" }),
  });
  check("a too-long rejection reason is capped, not refused", capped.status === 200, JSON.stringify(capped.body));
  check(
    "the stored reason is capped at 200 characters",
    capped.body?.submission?.reject_reason?.length === 200,
    String(capped.body?.submission?.reject_reason?.length)
  );

  const blank = await call(`/api/judge/${submissionId}`, {
    method: "POST",
    body: JSON.stringify({ action: "reject", reason: "   ", expectedStatus: "rejected" }),
  });
  check(
    "a whitespace-only reason is stored as no reason at all",
    blank.body?.submission?.reject_reason === null,
    JSON.stringify(blank.body?.submission?.reject_reason)
  );

  const zeroed = (await call("/api/leaderboard?round=1")).body.rows.find(
    (r) => r.teamId === teamA.id
  );
  check("a re-review removes the points", zeroed?.points === 0, `${zeroed?.points}`);

  const back = await call(`/api/judge/${submissionId}`, {
    method: "POST",
    body: JSON.stringify({ action: "approve", expectedStatus: "rejected" }),
  });
  check("a rejected submission can be re-reviewed and approved", back.status === 200, JSON.stringify(back.body));

  // approved -> approved is a legitimate transition, not a collision. It is also
  // how a re-submission judged at a different value takes over the score, so it
  // has to succeed rather than being treated as a no-op.
  const again = await call(`/api/judge/${submissionId}`, {
    method: "POST",
    body: JSON.stringify({ action: "approve", expectedStatus: "approved" }),
  });
  check("an approved item can be re-reviewed again", again.status === 200, JSON.stringify(again.body));

  const clearedState = (await call(`/api/state?playerId=${playerId}&_=${Date.now()}`)).body;
  check(
    "the rejection notice clears once the task is approved",
    !(clearedState.rejections ?? []).some((r) => r.taskId === taskId),
    JSON.stringify(clearedState.rejections)
  );

  const restored = (await call("/api/leaderboard?round=1")).body.rows.find(
    (r) => r.teamId === teamA.id
  );
  check("the points come back", restored?.points === taskPoints, `${restored?.points}`);

  const judged = (await call("/api/judge/queue?round=1")).body.recent;
  check("judged items stay reachable for re-review", judged.some((r) => r.id === submissionId));

  const board1 = (await call("/api/leaderboard?round=1")).body;
  const rowA = board1.rows.find((r) => r.teamId === teamA.id);
  // Assert the row EXISTS before comparing anything to it. Without this, the
  // remix check below degenerates into `undefined === undefined`, which passes
  // -- reporting the one guarantee this whole design exists to provide as
  // verified while having compared nothing.
  check("leaderboard returns the round 1 team", Boolean(rowA), "team missing from leaderboard");
  check(
    "leaderboard credits the round 1 team",
    rowA && rowA.points === taskPoints,
    `${rowA?.points} points, expected ${taskPoints}`
  );

  const board2Before = (await call("/api/leaderboard?round=2")).body;
  const rowBBefore = board2Before.rows.find((r) => r.teamId === teamB.id);

  // --- THE regression test ------------------------------------------------
  // Flip to Round 2, where this player is on a DIFFERENT team. If submissions
  // resolved team by joining to the player's current roster row, the Round 1
  // score would move to team B here and nobody would notice until awards.
  await call("/api/admin/settings", { method: "POST", body: JSON.stringify({ active_round: 2 }) });

  const board1After = (await call("/api/leaderboard?round=1")).body;
  const rowAAfter = board1After.rows.find((r) => r.teamId === teamA.id);
  check(
    "REMIX: round 1 score is unchanged after the roster is remixed",
    Boolean(rowA) && Boolean(rowAAfter) && rowAAfter.points === rowA.points,
    `${rowA?.points} -> ${rowAAfter?.points}`
  );

  const board2 = (await call("/api/leaderboard?round=2")).body;
  const rowB = board2.rows.find((r) => r.teamId === teamB.id);
  check("leaderboard returns the round 2 team", Boolean(rowB), "team missing from leaderboard");
  // Compared against its own prior value rather than hardcoded 0, so the check
  // still means something on a project that already has real submissions.
  check(
    "REMIX: round 2 team did not inherit round 1 points",
    Boolean(rowB) && Boolean(rowBBefore) && rowB.points === rowBBefore.points,
    `${rowBBefore?.points} -> ${rowB?.points}`
  );

  const stateR2 = (await call(`/api/state?playerId=${playerId}`)).body;
  check("player is now on their round 2 team", stateR2.team?.id === teamB.id, stateR2.team?.name);

  // The judge must still be able to reach the OTHER round's backlog after the
  // flip, or Round 1 submissions still in the queue at 3:30pm never get scored.
  const queueR2 = (await call("/api/judge/queue")).body;
  check(
    "judge is told about the other round's backlog",
    typeof queueR2.otherRoundPending === "number",
    JSON.stringify(queueR2.otherRoundPending)
  );
  const queueR1 = (await call("/api/judge/queue?round=1")).body;
  check("judge can still open round 1 after the flip", queueR1.round === 1);

  // Cross-round roster assignment must be refused: it would attribute scores to
  // a team that doesn't exist in that round's standings.
  const crossRound = await call("/api/admin/roster", {
    method: "POST",
    body: JSON.stringify({ round: 2, playerId, teamId: teamA.id }),
  });
  check("cross-round team assignment is refused", crossRound.status === 409, JSON.stringify(crossRound.body));

  const wrongRound = await call("/api/submissions", {
    method: "POST",
    body: JSON.stringify({ playerId, taskId, fileName: "x.jpg", fileType: "image/jpeg" }),
  });
  check("submitting a round 1 task during round 2 is refused", wrongRound.status === 409);

  // --- closed submissions -------------------------------------------------
  await call("/api/admin/settings", {
    method: "POST",
    body: JSON.stringify({ submissions_open: "false" }),
  });
  const closed = await call("/api/submissions", {
    method: "POST",
    body: JSON.stringify({ playerId, taskId: stateR2.tasks[0].id, fileName: "x.jpg" }),
  });
  check("submissions are refused while closed", closed.status === 409);

  // --- export -------------------------------------------------------------
  // Every export assertion tests for THIS run's artifacts. Matching on the team
  // name or a bare "STAR--" would pass off any pre-existing submission.
  const csv = await fetch(`${BASE}/api/export?format=csv`, { headers: { cookie } });
  const csvText = await csv.text();
  check("CSV export includes this run's submission", csvText.includes(NAME));
  check("CSV carries a dedup column", csvText.split("\n")[0].includes("counts"));
  check("CSV includes authoritative team totals", csvText.includes("TEAM TOTALS"));

  const sh = await fetch(`${BASE}/api/export?format=sh`, { headers: { cookie } });
  const shText = await sh.text();
  const myLine = shText.split("\n").find((l) => l.includes(objectName));
  check("download script includes this run's media", Boolean(myLine), objectName);
  check("download script sorts into round/team folders", Boolean(myLine?.includes("round-1/")));

  // --- unauthenticated access --------------------------------------------
  const noCookie = await fetch(`${BASE}/api/judge/queue`);
  check("judge queue requires the PIN", PIN ? noCookie.status === 401 : true, `HTTP ${noCookie.status}`);
}

// Settings are restored in a `finally`, not on the happy path. Any throw after
// the round flip would otherwise leave the live event stuck in Round 2 with
// submissions closed -- and every player would just see "Submissions are closed
// right now" with no clue why.
(async () => {
  try {
    await main();
  } catch (e) {
    console.error("\n\x1b[31mAborted:\x1b[0m", e?.stack ?? e?.message ?? e);
    failures.push("run aborted before finishing");
  } finally {
    await restoreSettings();
    await cleanup();
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log("\nFailed:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
})();
