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
let playerId, teamA, teamB, taskId, submissionId, objectName;
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
  const data = (await call("/api/admin/data")).body;
  const r1Teams = data.teams.filter((t) => t.round === 1);
  const r2Teams = data.teams.filter((t) => t.round === 2);
  check("round 1 teams seeded", r1Teams.length >= 2, `${r1Teams.length} found`);
  check("round 2 teams seeded", r2Teams.length >= 1, `${r2Teams.length} found`);
  if (r1Teams.length < 2 || !r2Teams.length) throw new Error("Seed data missing — run 03-seed.sql");

  teamA = r1Teams[0];
  teamB = r2Teams.find((t) => t.name !== teamA.name) ?? r2Teams[0];

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
    body: JSON.stringify({ action: "approve", bonus: 2, starred: true }),
  });
  check("approve succeeds", approve.status === 200, JSON.stringify(approve.body));
  check(
    "points come from the task, not the client",
    approve.body?.submission?.points_awarded === taskPoints,
    `${approve.body?.submission?.points_awarded} vs ${taskPoints}`
  );

  const overBonus = await call(`/api/judge/${submissionId}`, {
    method: "POST",
    body: JSON.stringify({ action: "bonus", bonus: 99 }),
  });
  check("bonus is clamped to 2", overBonus.body?.submission?.bonus === 2, String(overBonus.body?.submission?.bonus));

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

  const board1 = (await call("/api/leaderboard?round=1")).body;
  const rowA = board1.rows.find((r) => r.teamId === teamA.id);
  // Assert the row EXISTS before comparing anything to it. Without this, the
  // remix check below degenerates into `undefined === undefined`, which passes
  // -- reporting the one guarantee this whole design exists to provide as
  // verified while having compared nothing.
  check("leaderboard returns the round 1 team", Boolean(rowA), "team missing from leaderboard");
  check(
    "leaderboard credits the round 1 team",
    rowA && rowA.points >= taskPoints + 2,
    `${rowA?.points} points`
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
  check("download script marks it as an award candidate", Boolean(myLine?.includes("STAR--")));
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
