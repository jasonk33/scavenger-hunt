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
import { createAdminClient, loadEnv } from "./task-store.mjs";

const env = loadEnv();
const admin = await createAdminClient(env);

const problems = [];
const warnings = [];
const ok = [];
const check = (cond, good, bad, hard = true) =>
  cond ? ok.push(good) : (hard ? problems : warnings).push(bad);

const [{ data: settings }, { data: players }, { data: teams }, { data: roster }, { data: tasks }, { data: subs }] =
  await Promise.all([
    admin.from("settings").select("key,value"),
    admin.from("players").select("id,name"),
    admin.from("teams").select("id,name,round"),
    admin.from("roster").select("round,player_id,team_id"),
    admin.from("tasks").select("id,round,slug,title,points,requires_video,is_secret,revealed_at,active"),
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

// A secret challenge is offered in both halves of the event, so it is two rows
// sharing a slug. Nothing in the app can normally pull them apart -- the canvas
// and Admin both write by slug -- but a hand-edit in the Supabase table editor
// can, and the result is invisible: the canvas shows the Round 1 row, so Round 2
// would quietly be offering different wording, a different point value, or a
// task the other half cannot see at all.
const bySlug = new Map();
for (const t of tasks ?? []) {
  if (!bySlug.has(t.slug)) bySlug.set(t.slug, []);
  bySlug.get(t.slug).push(t);
}
const shape = (t) => `${t.title}|${t.points}|${t.requires_video}|${t.is_secret}|${t.active}`;
const split = [];
const lonely = [];
for (const [slug, rows] of bySlug) {
  // A task marked secret but present in only one round. The planner shows it at
  // round 0 -- "offered in both halves" -- so this is invisible there, and it is
  // reachable from Admin's Secret toggle and from a hand-edit.
  if (rows[0].is_secret && rows.length === 1) {
    lonely.push(`${rows[0].slug} ("${rows[0].title}", Round ${rows[0].round} only)`);
    continue;
  }
  if (rows.length < 2) continue;
  if (rows.some((t) => shape(t) !== shape(rows[0]))) split.push(`${slug} ("${rows[0].title}")`);
}
const paired = [...bySlug.values()].filter((r) => r.length > 1).length;
check(split.length === 0, `all ${paired} secret challenges match across both rounds`,
  `these are offered in both rounds but the two rows disagree: ${split.join(", ")} — ` +
    `open the planner and re-type the field to write both rounds at once`);
check(lonely.length === 0, `every secret challenge exists in both rounds`,
  `marked secret but only in one round, so half the event will never see it: ${lonely.join(", ")}`);

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
