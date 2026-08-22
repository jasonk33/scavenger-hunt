/**
 * Shared harness for the browser QA bug bash.
 *
 * Everything here writes to the SAME Supabase project the live app uses, so the
 * rules are: create your own fixtures, prefix them with `__qa`, and tear them
 * down. `restoreSettings` runs from a `finally` in every driver.
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

export const BASE = process.env.BASE_URL ?? "http://localhost:3000";

const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(BASE);
if (!isLocal && !process.argv.includes("--allow-prod")) {
  console.error(`\nRefusing to run against ${BASE}. Pass --allow-prod if you really mean it.\n`);
  process.exit(1);
}

export const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);

export const PIN = env.ORGANIZER_PIN ?? "";
export const BUCKET = env.SUPABASE_BUCKET || "hunt";
export const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

/* ---------- assertions ---------- */

const results = [];
export function check(name, condition, detail = "") {
  results.push({ name, ok: Boolean(condition), detail });
  const tag = condition ? "\x1b[32mok  \x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  console.log(`  ${tag} ${name}${!condition && detail ? ` — ${detail}` : ""}`);
  return Boolean(condition);
}
export function bug(name, detail) {
  results.push({ name, ok: false, detail, bug: true });
  console.log(`  \x1b[33mBUG \x1b[0m ${name} — ${detail}`);
}
/** Shallow copy without the given keys -- for cloning a DB row minus its identity. */
export function omit(obj, ...keys) {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)));
}

/**
 * An independent copy of a submission row, for drivers that need many of them
 * without paying for a real tus upload each time.
 *
 * `group_id` has to go along with `id`. Files that share one are the SAME piece
 * of evidence, and every screen collapses them into a single card -- so a clone
 * that keeps it produces one post and one queue entry no matter how many rows
 * are inserted. That silently guts any assertion about feed volume or queue
 * length: three drivers asserted against 71, 41 and 9 rows and were really
 * looking at one. Leaving it unset makes each clone its own group, which also
 * exercises the null-group_id path that every row written before the column
 * existed still takes.
 */
export function cloneSubmission(template, overrides = {}) {
  return { ...omit(template, "id", "created_at", "group_id"), ...overrides };
}

export function note(msg) {
  console.log(`  \x1b[36m··  \x1b[0m ${msg}`);
}
export function summary(label) {
  const bad = results.filter((r) => !r.ok);
  console.log(
    `\n${label}: ${results.length - bad.length}/${results.length} passed` +
      (bad.length ? `\n${bad.map((b) => `  ✗ ${b.name} — ${b.detail}`).join("\n")}` : "")
  );
  return bad;
}

/* ---------- api ---------- */

export async function call(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      cookie: `organizer=${PIN}`,
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

/* ---------- fixtures ---------- */

const TAG = "__qa";
// `_` is a single-character wildcard in SQL LIKE, so `__qa%` also matches any
// two characters followed by "qa". These filters drive delete() against real
// players, teams and tasks, and snapshot() uses the same predicate -- so a
// wrongly-matched row would be excluded from the before AND after counts and
// the integrity diff could never see it. Match exactly in JS instead.
const isQa = (s) => typeof s === "string" && s.startsWith(TAG);

/**
 * Refuse to run while a real submission is waiting for review.
 *
 * The drivers that judge through the UI review whatever sits at the FRONT of
 * the queue and assume it is their own fixture. The queue is ordered oldest
 * first, so one real submission awaiting review sits ahead of every `__qa` one
 * -- and the driver approves that instead. This is not hypothetical: a suite run
 * approved one of Jason's photos at +1 with a +2 bonus and starred it, and
 * because the integrity snapshot only counted rows back then, every driver still
 * reported "real data intact: true".
 *
 * A convention for drivers to follow would not have caught it, so this is a hard
 * stop at import time -- it fires for a single driver as much as for `npm run qa`.
 */
if (!process.argv.includes("--allow-real-data")) {
  const { data: allPlayers } = await admin.from("players").select("id,name");
  const qaPlayers = new Set((allPlayers ?? []).filter((p) => isQa(p.name)).map((p) => p.id));
  const { data: waiting } = await admin
    .from("submissions")
    .select("id,player_id")
    .in("status", ["pending", "uploading"]);
  const real = (waiting ?? []).filter((s) => !qaPlayers.has(s.player_id));
  if (real.length > 0) {
    const names = new Map((allPlayers ?? []).map((p) => [p.id, p.name]));
    console.error(
      `\nRefusing to run: ${real.length} real submission${real.length === 1 ? "" : "s"} ` +
        `${real.length === 1 ? "is" : "are"} still waiting to be judged.\n` +
        real.map((s) => `  - ${names.get(s.player_id) ?? s.player_id} (${s.id.slice(0, 8)})`).join("\n") +
        `\n\nThe judging drivers act on the front of the queue, which is one of these.` +
        `\nJudge them at /judge first, or clear them, then run again.` +
        `\nPass --allow-real-data to override.\n`
    );
    process.exit(1);
  }
}

/** Creates an isolated team (both rounds) plus players rostered into round 1. */
export async function setup({ players = ["__qa Alice", "__qa Bob"], teams = ["__qa Red", "__qa Blue"] } = {}) {
  for (const name of teams) {
    await call("/api/admin/teams", { method: "POST", body: JSON.stringify({ name, color: "#7c3aed" }) });
  }
  await call("/api/admin/players", { method: "POST", body: JSON.stringify({ names: players.join("\n") }) });

  const { data: teamRows } = await admin.from("teams").select("id,name,round").in("name", teams);
  const { data: playerRows } = await admin.from("players").select("id,name").in("name", players);

  const teamOf = (name, round) => teamRows.find((t) => t.name === name && t.round === round);
  // Everyone onto the first team in round 1 by default; drivers re-roster as needed.
  await call("/api/admin/roster", {
    method: "POST",
    body: JSON.stringify({
      round: 1,
      entries: playerRows.map((p) => ({ playerId: p.id, teamId: teamOf(teams[0], 1).id })),
    }),
  });

  return {
    players: playerRows,
    teams: teamRows,
    teamOf,
    player: (name) => playerRows.find((p) => p.name === name),
  };
}

/** Removes every __qa artifact: submissions + media, roster, teams, players. */
export async function teardown() {
  const { data: allPlayers } = await admin.from("players").select("id,name");
  const ids = (allPlayers ?? []).filter((p) => isQa(p.name)).map((p) => p.id);

  if (ids.length) {
    const { data: subs } = await admin
      .from("submissions")
      .select("id,object_name")
      .in("player_id", ids);
    const objects = (subs ?? []).map((s) => s.object_name).filter(Boolean);
    if (objects.length) await admin.storage.from(BUCKET).remove(objects);
    if (subs?.length) await admin.from("submissions").delete().in("id", subs.map((s) => s.id));
    await admin.from("roster").delete().in("player_id", ids);
    await admin.from("players").delete().in("id", ids);
  }

  const { data: allTeams } = await admin.from("teams").select("id,name");
  const teamIds = (allTeams ?? []).filter((t) => isQa(t.name)).map((t) => t.id);
  if (teamIds.length) {
    // Any stragglers pointing at a __qa team (e.g. reassigned during a race test).
    const { data: subs } = await admin.from("submissions").select("id,object_name").in("team_id", teamIds);
    const objects = (subs ?? []).map((s) => s.object_name).filter(Boolean);
    if (objects.length) await admin.storage.from(BUCKET).remove(objects);
    if (subs?.length) await admin.from("submissions").delete().in("id", subs.map((s) => s.id));
    await admin.from("roster").delete().in("team_id", teamIds);
    await admin.from("teams").delete().in("id", teamIds);
  }

  // Object names are derived from the team name, so every QA upload lands under
  // a `qa-*` folder. Sweeping by prefix catches media orphaned when a driver
  // deleted its submission rows directly before teardown ran -- otherwise those
  // bytes accumulate in the bucket invisibly.
  for (const round of ["round-1", "round-2"]) {
    const { data: folders } = await admin.storage.from(BUCKET).list(round, { limit: 500 });
    for (const f of folders ?? []) {
      if (!/^qa-/.test(f.name)) continue;
      const { data: files } = await admin.storage.from(BUCKET).list(`${round}/${f.name}`, { limit: 1000 });
      const paths = (files ?? []).map((x) => `${round}/${f.name}/${x.name}`);
      if (paths.length) await admin.storage.from(BUCKET).remove(paths);
    }
  }
}

/** Deletes only the tasks this suite created. Exact-match, never LIKE. */
export async function teardownTasks() {
  const { data } = await admin.from("tasks").select("id,title");
  const ids = (data ?? []).filter((t) => isQa(t.title)).map((t) => t.id);
  if (!ids.length) return;
  await admin.from("submissions").delete().in("task_id", ids);
  await admin.from("tasks").delete().in("id", ids);
}

/** Snapshot of everything the event depends on, for a before/after integrity diff. */
export async function snapshot() {
  const [players, teams, roster, tasks, subs, settings] = await Promise.all([
    admin.from("players").select("id,name"),
    admin.from("teams").select("id,name,round,color"),
    admin.from("roster").select("round,player_id,team_id"),
    // Full task state, not just a count: a stray click on a Reveal button changes
    // nothing countable but spoils a secret challenge, and deactivating a task
    // silently removes it from every player's list.
    admin.from("tasks").select("id,title,points,round,is_secret,revealed_at,active,requires_video").order("id"),
    admin.from("submissions").select("id,status,team_id,player_id,points_awarded,bonus").order("id"),
    admin.from("settings").select("key,value"),
  ]);
  const realPlayers = (players.data ?? []).filter((p) => !isQa(p.name));
  const realTeams = (teams.data ?? []).filter((t) => !isQa(t.name));
  const realTasks = (tasks.data ?? []).filter((t) => !isQa(t.title));
  const qaPlayers = new Set((players.data ?? []).filter((p) => isQa(p.name)).map((p) => p.id));
  // A driver that judged one of Jason's own submissions instead of its own
  // fixture leaves the row COUNT unchanged, so counting alone reported that as
  // intact. Status, team and points are the fields a stray click actually
  // moves, and they are what decides the scoreboard.
  const realSubs = (subs.data ?? []).filter((s) => !qaPlayers.has(s.player_id));
  return {
    players: realPlayers.length,
    teams: realTeams.length,
    roster: (roster.data ?? []).filter((r) => !qaPlayers.has(r.player_id)).length,
    tasks: realTasks.length,
    secretsRevealed: realTasks.filter((t) => t.revealed_at).map((t) => t.title),
    tasksInactive: realTasks.filter((t) => t.active === false).map((t) => t.title),
    taskFingerprint: realTasks
      .map((t) => `${t.id}:${t.points}:${t.requires_video}:${t.is_secret}`)
      .join("|"),
    submissions: realSubs.length,
    submissionFingerprint: realSubs
      .map((s) => `${s.id}:${s.status}:${s.team_id}:${s.points_awarded}:${s.bonus}`)
      .join("|"),
    settings: Object.fromEntries((settings.data ?? []).map((s) => [s.key, s.value])),
  };
}

export async function captureSettings() {
  const { data } = await admin.from("settings").select("key,value");
  return Object.fromEntries((data ?? []).map((s) => [s.key, s.value]));
}

export async function restoreSettings(before) {
  if (!before) return;
  for (const [key, value] of Object.entries(before)) {
    await admin.from("settings").upsert({ key, value }, { onConflict: "key" });
  }
}

/* ---------- browser helpers ---------- */

/** Seeds a player identity into a context before any page script runs. */
export async function asPlayer(context, player) {
  await context.addInitScript(
    ([p]) => localStorage.setItem("sh.player", JSON.stringify(p)),
    [{ id: player.id, name: player.name }]
  );
}

/**
 * Grants organizer access to a context. The cookie domain is derived from BASE
 * rather than hardcoded, so the same driver works against a deployed URL.
 */
export async function asOrganizer(context) {
  await context.addCookies([
    { name: "organizer", value: PIN, domain: new URL(BASE).hostname, path: "/" },
  ]);
}

export async function shot(page, name) {
  await page.screenshot({ path: new URL(`./shots/${name}.png`, import.meta.url).pathname, fullPage: false });
}

/**
 * How many Upload/Redo buttons on /submit are still tappable.
 *
 * Scoped by label rather than counting every enabled button in a task row: those
 * rows also carry a "See" button, and that one deliberately stays live when
 * uploading is blocked. During the 3:30 break submissions are closed and looking
 * back at what you sent is exactly what people want to do.
 */
export function enabledUploadButtons(page) {
  return page
    .locator(".card-flat button:not(:disabled)")
    .evaluateAll((els) => els.filter((e) => /^(Upload|Redo)$/.test(e.textContent.trim())).length);
}

/* ---------- seeding ---------- */

import * as tus from "tus-js-client";

/** Creates a real pending submission the same way a phone does. */
export async function seed({ playerId, taskId, file = "photo.jpg", name, groupWith, note: noteText }) {
  const bytes = readFileSync(new URL(`./media/${file}`, import.meta.url));
  const fileName = name ?? file;
  const init = await call("/api/submissions", {
    method: "POST",
    body: JSON.stringify({
      playerId,
      taskId,
      fileName,
      fileType: file.endsWith(".mp4") ? "video/mp4" : "image/jpeg",
      // Another angle on an existing submission rather than a separate one.
      // The server decides whether the two may actually be grouped.
      groupWith,
    }),
  });
  if (init.status !== 200) throw new Error(`seed reserve failed: ${JSON.stringify(init.body)}`);
  const { submissionId, objectName, contentType } = init.body;

  const state = await (await fetch(`${BASE}/api/state?playerId=${playerId}`)).json();
  await new Promise((resolve, reject) => {
    const up = new tus.Upload(bytes, {
      endpoint: state.upload.endpoint,
      headers: { authorization: `Bearer ${state.upload.anonKey}`, apikey: state.upload.anonKey, "x-upsert": "true" },
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      chunkSize: 6 * 1024 * 1024,
      uploadSize: bytes.length,
      metadata: { bucketName: state.upload.bucket, objectName, contentType, cacheControl: "3600" },
      onError: reject,
      onSuccess: resolve,
    });
    up.start();
  });

  const done = await call(`/api/submissions/${submissionId}`, {
    method: "PATCH",
    body: JSON.stringify({ sizeBytes: bytes.length, mediaType: contentType }),
  });
  if (done.status !== 200) throw new Error(`seed promote failed: ${JSON.stringify(done.body)}`);

  // Notes are never carried by the finalize call -- there is one way to write
  // one, and the harness uses the same one the app does.
  if (noteText !== undefined) {
    const wrote = await call(`/api/submissions/${submissionId}`, {
      method: "PATCH",
      body: JSON.stringify({ noteOnly: true, note: noteText }),
    });
    if (wrote.status !== 200) throw new Error(`seed note failed: ${JSON.stringify(wrote.body)}`);
  }
  return submissionId;
}
