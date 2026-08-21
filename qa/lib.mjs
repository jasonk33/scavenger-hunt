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
  const { data: players } = await admin.from("players").select("id,name").like("name", `${TAG}%`);
  const ids = (players ?? []).map((p) => p.id);

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

  const { data: teams } = await admin.from("teams").select("id").like("name", `${TAG}%`);
  const teamIds = (teams ?? []).map((t) => t.id);
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

/** Snapshot of everything the event depends on, for a before/after integrity diff. */
export async function snapshot() {
  const [players, teams, roster, tasks, subs, settings] = await Promise.all([
    admin.from("players").select("id,name").not("name", "like", `${TAG}%`),
    admin.from("teams").select("id,name,round,color").not("name", "like", `${TAG}%`),
    admin.from("roster").select("round,player_id,team_id"),
    // Full task state, not just a count: a stray click on a Reveal button changes
    // nothing countable but spoils a secret challenge, and deactivating a task
    // silently removes it from every player's list.
    admin.from("tasks").select("id,title,points,round,is_secret,revealed_at,active,requires_video")
      .not("title", "like", `${TAG}%`).order("id"),
    admin.from("submissions").select("id,status,team_id,points_awarded,bonus"),
    admin.from("settings").select("key,value"),
  ]);
  const qaPlayers = new Set(); // roster rows for __qa players are expected to vanish
  const { data: qp } = await admin.from("players").select("id").like("name", `${TAG}%`);
  for (const p of qp ?? []) qaPlayers.add(p.id);
  return {
    players: (players.data ?? []).length,
    teams: (teams.data ?? []).length,
    roster: (roster.data ?? []).filter((r) => !qaPlayers.has(r.player_id)).length,
    tasks: (tasks.data ?? []).length,
    secretsRevealed: (tasks.data ?? []).filter((t) => t.revealed_at).map((t) => t.title),
    tasksInactive: (tasks.data ?? []).filter((t) => t.active === false).map((t) => t.title),
    taskFingerprint: (tasks.data ?? [])
      .map((t) => `${t.id}:${t.points}:${t.requires_video}:${t.is_secret}`)
      .join("|"),
    submissions: (subs.data ?? []).length,
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

export async function asPlayer(page, player) {
  await page.addInitScript(
    ([p]) => {
      localStorage.setItem("sh.player", JSON.stringify({ id: p.id, name: p.name }));
    },
    [player]
  );
}

export async function asOrganizer(context) {
  const url = new URL(BASE);
  await context.addCookies([
    { name: "organizer", value: PIN, domain: url.hostname, path: "/" },
  ]);
}

export async function shot(page, name) {
  await page.screenshot({ path: new URL(`./shots/${name}.png`, import.meta.url).pathname, fullPage: false });
}

/* ---------- seeding ---------- */

import * as tus from "tus-js-client";

/** Creates a real pending submission the same way a phone does. */
export async function seed({ playerId, taskId, file = "photo.jpg", name }) {
  const bytes = readFileSync(new URL(`./media/${file}`, import.meta.url));
  const fileName = name ?? file;
  const init = await call("/api/submissions", {
    method: "POST",
    body: JSON.stringify({ playerId, taskId, fileName, fileType: file.endsWith(".mp4") ? "video/mp4" : "image/jpeg" }),
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
  return submissionId;
}
