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

  const settingsBefore = data.settings;
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

  const board1 = (await call("/api/leaderboard?round=1")).body;
  const rowA = board1.rows.find((r) => r.teamId === teamA.id);
  check(
    "leaderboard credits the round 1 team",
    rowA && rowA.points >= taskPoints + 2,
    `${rowA?.points} points`
  );

  // --- THE regression test ------------------------------------------------
  // Flip to Round 2, where this player is on a DIFFERENT team. If submissions
  // resolved team by joining to the player's current roster row, the Round 1
  // score would move to team B here and nobody would notice until awards.
  await call("/api/admin/settings", { method: "POST", body: JSON.stringify({ active_round: 2 }) });

  const board1After = (await call("/api/leaderboard?round=1")).body;
  const rowAAfter = board1After.rows.find((r) => r.teamId === teamA.id);
  check(
    "REMIX: round 1 score is unchanged after the roster is remixed",
    rowAAfter?.points === rowA?.points,
    `${rowA?.points} -> ${rowAAfter?.points}`
  );

  const board2 = (await call("/api/leaderboard?round=2")).body;
  const rowB = board2.rows.find((r) => r.teamId === teamB.id);
  check("REMIX: round 2 team did not inherit round 1 points", (rowB?.points ?? 0) === 0, `${rowB?.points}`);

  const stateR2 = (await call(`/api/state?playerId=${playerId}`)).body;
  check("player is now on their round 2 team", stateR2.team?.id === teamB.id, stateR2.team?.name);

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
  const csv = await fetch(`${BASE}/api/export?format=csv`, { headers: { cookie } });
  const csvText = await csv.text();
  check("CSV export includes the submission", csvText.includes(NAME) || csvText.includes(teamA.name));

  const sh = await fetch(`${BASE}/api/export?format=sh`, { headers: { cookie } });
  const shText = await sh.text();
  check("download script is generated", shText.includes("curl -fsSL"));
  check("award candidates are marked in the download script", shText.includes("STAR--"));

  // --- unauthenticated access --------------------------------------------
  const noCookie = await fetch(`${BASE}/api/judge/queue`);
  check("judge queue requires the PIN", PIN ? noCookie.status === 401 : true, `HTTP ${noCookie.status}`);

  // --- restore ------------------------------------------------------------
  await call("/api/admin/settings", {
    method: "POST",
    body: JSON.stringify({
      active_round: settingsBefore.active_round,
      submissions_open: String(settingsBefore.submissions_open),
    }),
  });
}

main()
  .then(cleanup, async (e) => {
    console.error("\n\x1b[31mAborted:\x1b[0m", e.message);
    await cleanup();
    process.exitCode = 1;
  })
  .then(() => {
    console.log(`\n${passed} passed, ${failures.length} failed`);
    if (failures.length) {
      console.log("\nFailed:");
      for (const f of failures) console.log(`  - ${f}`);
      process.exitCode = 1;
    }
  });
