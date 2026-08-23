#!/usr/bin/env node
/**
 * Loads the real event data: the guest list, the team split, and the task list
 * from the planning board.
 *
 *   npm run seed         load guests + teams, reconcile tasks, clear scoring
 *   npm run seed:reset   remove the guests, every submission and every file
 *
 * Re-runnable. The guest list and the team split below are the source of truth,
 * so as people RSVP or drop, edit the arrays and run it again rather than
 * clicking through Admin. Both commands clear every submission, which is what
 * makes a re-run safe -- a roster change would otherwise leave Round 1 scores
 * credited to teams that no longer exist.
 *
 * Tasks are NOT defined here. To change a task without touching anyone's
 * submissions, edit the board and run `npm run sync:tasks` instead.
 */

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { buildPlan, applyPlan } from "./task-sync.mjs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);

const BUCKET = env.SUPABASE_BUCKET || "hunt";
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

/*
 * Everyone marked Going on the invite, minus the two organizers -- the doc is
 * explicit that "Jason and Anna aren't running", so Jason Katz and Anna Toderas
 * are not on the roster. They get in with the PIN instead. Names are cleaned up
 * from the RSVP export ("hanxiao lu", "Mira!") because they show on a scoreboard.
 *
 * Round 1 teams. 24 players over five teams is 5/5/5/5/4, which fits the doc's
 * "4 or 5 people, never fewer than 4". The one thing here that is not arbitrary
 * is that the three plus-one pairs are split up, per "split up people who
 * already know each other extremely well" -- see PAIRS below. Everything else is
 * a placeholder: the doc wants teams built on purpose (a stranger-talker on
 * every team, friend groups spread out) and only Jason can do that.
 */
const ROUND_1 = [
  ["Hanxiao Lu", "Frankie", "Afrah", "Altan", "Amanda"],
  ["Loren", "Andrew Toderas", "Avery", "Ayis", "David"],
  ["Stefan", "Felicia R", "Haris", "Jack Nugent", "Jessica Creedon"],
  ["Mira", "Katia Matora", "Kiran Cartolari", "Mollie", "Nigel Despinasse"],
  ["Steph", "Oliver Hermann", "Rachel McMahon", "Toby Okwara"],
];

/** Plus-ones from the RSVP export. Never put one of these on the same team. */
const PAIRS = [
  ["Hanxiao Lu", "Loren"],
  ["Stefan", "Mira"],
  ["Steph", "Frankie"],
];

/**
 * Round 2 is the remix, derived rather than typed out: the player at index k of
 * Round 1 team t moves to team (t + k + 1) % 5. Because that offset is distinct
 * for every k, no two Round 1 teammates land together again -- everyone gets a
 * completely new set of teammates, which is the point of the break. Four players
 * keep their team *name*; that is unavoidable with five teams of five, and it
 * doesn't matter because the roster around them is entirely different.
 *
 * The real swap gets decided on the day. This just makes the handover
 * rehearsable, and every property above is asserted below rather than trusted.
 */
function remix(round1) {
  const teams = round1.map(() => []);
  round1.forEach((team, t) => {
    team.forEach((name, k) => teams[(t + k + 1) % round1.length].push(name));
  });
  return teams;
}

const ROUND_2 = remix(ROUND_1);

/*
 * The task list is not defined here. It lives on the planning board at
 * `data/task-board.json` and is published by `scripts/task-sync.mjs`, which this
 * calls so a seed and a sync can never leave the app in different states.
 */

const GUESTS = ROUND_1.flat();
const reset = process.argv.includes("--reset");

/** Fails loudly rather than seeding a roster that breaks the doc's own rules. */
function verifyTeams() {
  const problems = [];
  const r2 = ROUND_2;

  const seen1 = ROUND_1.flat();
  const seen2 = r2.flat();
  if (seen1.length !== new Set(seen1).size) problems.push("a player is on two Round 1 teams");
  if (seen2.length !== new Set(seen2).size) problems.push("a player is on two Round 2 teams");
  if (seen1.length !== seen2.length) problems.push("the two rounds have different headcounts");
  for (const name of seen1) if (!seen2.includes(name)) problems.push(`${name} is missing from Round 2`);

  for (const [round, layout] of [["Round 1", ROUND_1], ["Round 2", r2]]) {
    layout.forEach((team, i) => {
      if (team.length < 4 || team.length > 5) {
        problems.push(`${round} team ${i + 1} has ${team.length} players (the doc says 4 or 5)`);
      }
    });
    for (const [a, b] of PAIRS) {
      const together = layout.find((t) => t.includes(a) && t.includes(b));
      if (together) problems.push(`${round} puts the pair ${a} + ${b} on the same team`);
    }
  }

  // The remix only works if it actually breaks up the old teams.
  for (const team1 of ROUND_1) {
    for (const team2 of r2) {
      const shared = team1.filter((n) => team2.includes(n));
      if (shared.length > 1) problems.push(`${shared.join(" + ")} are teammates in both rounds`);
    }
  }

  if (problems.length) {
    console.error(`\nRefusing to seed -- the team layout is wrong:\n${problems.map((p) => `  - ${p}`).join("\n")}\n`);
    process.exit(1);
  }
}

/*
 * Both commands delete EVERY submission and every media object in the bucket,
 * and .env.local points at the same Supabase project the live app uses. Run
 * either one after the party and the photos are gone, so it refuses once
 * submissions exist that did not come from this script's own guest list.
 */
async function confirmDestructive() {
  const force = process.argv.includes("--force");
  const { count } = await db.from("submissions").select("id", { count: "exact", head: true });
  if (!count || force) return;

  const { data: players } = await db.from("players").select("id,name");
  const knownIds = new Set((players ?? []).filter((p) => GUESTS.includes(p.name)).map((p) => p.id));
  const { data: rows } = await db.from("submissions").select("player_id");
  const real = (rows ?? []).filter((r) => !knownIds.has(r.player_id)).length;

  if (real > 0) {
    console.error(
      `\nRefusing to run: ${real} submission(s) are from players not in this script's guest list.\n` +
        `This would delete all ${count} submission(s) and every file in the bucket.\n` +
        `Re-run with --force if that is genuinely what you want.\n`
    );
    process.exit(1);
  }
}

/** Clears every submission and its media, re-hides the secrets, reopens Round 1. */
async function clearScoring() {
  const { data: subs } = await db.from("submissions").select("id,object_name");
  const objects = (subs ?? []).map((s) => s.object_name).filter(Boolean);
  for (let i = 0; i < objects.length; i += 100) {
    await db.storage.from(BUCKET).remove(objects.slice(i, i + 100));
  }
  await db.from("submissions").delete().neq("id", "00000000-0000-0000-0000-000000000000");

  await db.from("tasks").update({ revealed_at: null }).not("revealed_at", "is", null);
  await db.from("settings").upsert(
    [
      { key: "active_round", value: "1" },
      { key: "submissions_open", value: "true" },
      { key: "notice", value: "" },
    ],
    { onConflict: "key" }
  );
  return { submissions: subs?.length ?? 0, objects: objects.length };
}

async function wipe() {
  const cleared = await clearScoring();
  const { data: players } = await db.from("players").select("id,name");
  const ids = (players ?? []).filter((p) => GUESTS.includes(p.name)).map((p) => p.id);
  if (ids.length) {
    await db.from("roster").delete().in("player_id", ids);
    await db.from("players").delete().in("id", ids);
  }
  console.log(
    `Removed ${ids.length} player(s), ${cleared.submissions} submission(s), ` +
      `${cleared.objects} media file(s). Secrets re-hidden, back to Round 1.`
  );
}

/**
 * Brings the task list in line with the planning board. Keyed on `board_id`, so
 * rewording a task does not lose track of it, and a task the board cuts is
 * deactivated rather than deleted -- this must not take submissions with it.
 */
async function reconcileTasks() {
  const { plan, migrated } = await buildPlan(db);
  await applyPlan(db, plan, { migrated });
  for (const w of plan.warnings) console.log(`  ! ${w}`);
  return {
    inserted: plan.insert.length,
    updated: plan.update.length + plan.reactivate.length,
    hidden: plan.deactivate.length,
  };
}

async function seed() {
  // Anyone in the app who is not on the current guest list is a leftover -- the
  // demo names, or someone who has since dropped out.
  const { data: existing } = await db.from("players").select("id,name");
  const staleIds = (existing ?? []).filter((p) => !GUESTS.includes(p.name)).map((p) => p.id);

  const cleared = await clearScoring();
  const cut = await reconcileTasks();

  if (staleIds.length) {
    await db.from("roster").delete().in("player_id", staleIds);
    await db.from("players").delete().in("id", staleIds);
  }

  await db.from("players").upsert(
    GUESTS.map((name) => ({ name })),
    { onConflict: "name", ignoreDuplicates: true }
  );

  const { data: players } = await db.from("players").select("id,name").in("name", GUESTS);
  const idOf = new Map((players ?? []).map((p) => [p.name, p.id]));
  const missing = GUESTS.filter((n) => !idOf.has(n));
  if (missing.length) throw new Error(`players failed to insert: ${missing.join(", ")}`);

  for (const [round, layout] of [[1, ROUND_1], [2, ROUND_2]]) {
    const { data: teams } = await db
      .from("teams")
      .select("id,name")
      .eq("round", round)
      .order("sort_order");

    if (teams.length < layout.length) {
      throw new Error(`Round ${round} has ${teams.length} teams but the layout needs ${layout.length}`);
    }

    const rows = [];
    layout.forEach((group, i) => {
      for (const name of group) rows.push({ round, player_id: idOf.get(name), team_id: teams[i].id });
    });
    await db.from("roster").upsert(rows, { onConflict: "round,player_id" });

    console.log(`\nRound ${round}`);
    layout.forEach((group, i) => {
      console.log(`  ${teams[i].name.padEnd(32)} ${group.join(", ")}`);
    });
  }

  const { count: taskCount } = await db
    .from("tasks")
    .select("id", { count: "exact", head: true })
    .eq("active", true);

  console.log(
    `\n${GUESTS.length} players across ${ROUND_1.length} teams, remixed at the break.` +
      (staleIds.length ? `\nRemoved ${staleIds.length} player(s) no longer on the guest list.` : "") +
      `\nTasks: ${cut.inserted} added, ${cut.updated} updated, ${cut.hidden} hidden from the board.` +
      `\nCleared ${cleared.submissions} submission(s) and ${cleared.objects} media file(s).` +
      `\n${taskCount} tasks live. Secrets hidden, submissions open, Round 1.` +
      `\n\nStart over with:  npm run seed:reset`
  );
}

verifyTeams();
confirmDestructive()
  .then(reset ? wipe : seed)
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
