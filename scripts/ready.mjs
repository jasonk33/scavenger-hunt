#!/usr/bin/env node
/**
 * Pre-event readiness check. Read-only, ~2 seconds, safe to run any time.
 *
 *   npm run ready
 *
 * The QA and smoke suites prove the app works. This proves YOUR EVENT is set up,
 * which is a different question and the one that actually bites on the day. It
 * exists because a crashed test run once left `submissions_open` false, and
 * nothing about the app looks broken in that state -- every player just sees
 * "Submissions are closed right now" and assumes it's them.
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { planTaskSync, loadBoard, fetchTaskRows } from "./task-sync.mjs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);
const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const problems = [];
const warnings = [];
const ok = [];
const check = (cond, good, bad, hard = true) =>
  cond ? ok.push(good) : (hard ? problems : warnings).push(bad);

const [{ data: settings }, { data: players }, { data: teams }, { data: roster }, tasks, { data: subs }] =
  await Promise.all([
    admin.from("settings").select("key,value"),
    admin.from("players").select("id,name"),
    admin.from("teams").select("id,name,round"),
    admin.from("roster").select("round,player_id,team_id"),
    fetchTaskRows(admin, ",revealed_at"),
    admin.from("submissions").select("id,status"),
  ]);

const s = Object.fromEntries((settings ?? []).map((r) => [r.key, r.value]));
const round = Number(s.active_round) === 2 ? 2 : 1;

check(s.submissions_open !== "false", "submissions are open",
  "SUBMISSIONS ARE CLOSED — every player will see \"Submissions are closed right now\". Admin → event → tap the toggle.");
check(!s.notice, "no stale broadcast banner",
  `a banner is still showing: "${s.notice}" — Admin → event → Clear`, false);
check(Boolean(s.event_name), "event name set", "no event name set", false);

const leftovers = [
  ...(players ?? []).filter((p) => p.name.startsWith("__qa")).map((p) => `player ${p.name}`),
  ...(teams ?? []).filter((t) => t.name.startsWith("__qa")).map((t) => `team ${t.name}`),
  ...(tasks ?? []).filter((t) => t.title.startsWith("__qa")).map((t) => `task ${t.title}`),
];
check(leftovers.length === 0, "no test fixtures left behind",
  `test fixtures still present: ${leftovers.join(", ")}`);

const revealed = (tasks ?? []).filter((t) => t.is_secret && t.revealed_at);
check(revealed.length === 0, `all ${(tasks ?? []).filter((t) => t.is_secret).length} secret challenges still hidden`,
  `secret challenge(s) already revealed: ${revealed.map((t) => t.title).join(", ")} — Admin → tasks → tap "Live" to hide again`);

const rostered = new Set((roster ?? []).filter((r) => r.round === round).map((r) => r.player_id));
const unrostered = (players ?? []).filter((p) => !rostered.has(p.id));
check(unrostered.length === 0, `all ${players?.length ?? 0} players are on a Round ${round} team`,
  `not on a Round ${round} team (they cannot upload): ${unrostered.map((p) => p.name).join(", ")}`);

// The roster can change by hand on the day -- someone no-shows and gets pulled
// in Admin -- and the doc's floor is four. A team that drops to three is still
// playable, so this is a note rather than a blocker.
const sizes = new Map();
for (const r of roster ?? []) {
  if (r.round !== round) continue;
  sizes.set(r.team_id, (sizes.get(r.team_id) ?? 0) + 1);
}
const nameOf = new Map((teams ?? []).map((t) => [t.id, t.name]));
const short = [...sizes.entries()].filter(([, n]) => n < 4);
check(short.length === 0, `every Round ${round} team has at least 4 players`,
  `short-handed: ${short.map(([id, n]) => `${nameOf.get(id) ?? id} (${n})`).join(", ")}`, false);

const activeTasks = (tasks ?? []).filter((t) => t.active !== false && t.round === round);
check(activeTasks.length > 0, `${activeTasks.length} active tasks in Round ${round}`, `no active tasks in Round ${round}`);
check((teams ?? []).filter((t) => t.round === round).length >= 2,
  `${(teams ?? []).filter((t) => t.round === round).length} teams in Round ${round}`, `fewer than 2 teams in Round ${round}`);

const stuck = (subs ?? []).filter((x) => x.status === "uploading");
check(stuck.length === 0, "no half-finished uploads",
  `${stuck.length} submission(s) stuck mid-upload — Admin → health lists them`, false);

// The board is where tasks are actually decided, so "ready" has to mean the app
// is showing what the board says, not just that it is showing something.
const drift = planTaskSync(loadBoard(), tasks ?? []);
const pending = drift.insert.length + drift.update.length + drift.deactivate.length + drift.reactivate.length;
check(pending === 0, "task list matches the planning board",
  `${pending} task change(s) on the board are not live yet ` +
    `(${drift.insert.length} new, ${drift.update.length} edited, ${drift.deactivate.length} cut) — ` +
    `run npm run sync:tasks to see them`, false);

check(env.SUPABASE_ANON_KEY?.startsWith("ey"), "upload key is the legacy anon JWT",
  "SUPABASE_ANON_KEY is not a JWT — uploads will fail. It must be the legacy anon key.");
check(Boolean(env.ORGANIZER_PIN), "organizer PIN is set", "no ORGANIZER_PIN — the judge screen is wide open", false);

console.log(`\nRound ${round} · ${players?.length ?? 0} players · ${(teams ?? []).filter((t) => t.round === round).length} teams · ${activeTasks.length} tasks · ${(subs ?? []).filter((x) => x.status === "pending").length} waiting on the judge\n`);
for (const line of ok) console.log(`  \x1b[32mok\x1b[0m   ${line}`);
for (const line of warnings) console.log(`  \x1b[33mnote\x1b[0m ${line}`);
for (const line of problems) console.log(`  \x1b[31mFIX\x1b[0m  ${line}`);

console.log(
  problems.length
    ? `\n\x1b[31m${problems.length} thing(s) would break the event. Fix before you start.\x1b[0m\n`
    : warnings.length
      ? `\n\x1b[33mReady to run — ${warnings.length} thing(s) worth a look above.\x1b[0m\n`
      : "\n\x1b[32mReady to run.\x1b[0m\n"
);
process.exit(problems.length ? 1 : 0);
