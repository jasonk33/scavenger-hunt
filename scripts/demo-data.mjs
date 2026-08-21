#!/usr/bin/env node
/**
 * Demo data for kicking the tyres before the real guest list exists.
 *
 *   npm run demo         load 16 test players, rostered for both rounds
 *   npm run demo:reset   remove them, plus every submission and media file
 *
 * The reset is exact: it only touches the names in DEMO_PLAYERS below, so it
 * cannot eat a real guest you added by hand. It does clear ALL submissions
 * though -- that is the point of a reset before the event.
 *
 * Teams are deliberately remixed between rounds (no two Round 1 teammates stay
 * together) so the 3:30pm handover can actually be rehearsed.
 */

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

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

// 16 players = 4 teams of 4, which is the layout the plan calls for at that
// headcount. Replace these with the real guest list when you have it.
const DEMO_PLAYERS = [
  "Alex Rivera", "Sam Chen", "Jordan Blake", "Casey Nguyen",
  "Morgan Ellis", "Riley Novak", "Avery Cruz", "Quinn Barrett",
  "Devon Park", "Harper Lane", "Emerson Reid", "Rowan Diaz",
  "Sasha Kim", "Micah Torres", "Noel Frost", "Blair Okafor",
];

// Round 1: straight blocks of four.
// Round 2: a full remix -- every player changes team and no pairing repeats.
const R1 = [
  [0, 1, 2, 3],
  [4, 5, 6, 7],
  [8, 9, 10, 11],
  [12, 13, 14, 15],
];
const R2 = [
  [0, 4, 8, 12],
  [1, 5, 9, 13],
  [2, 6, 10, 14],
  [3, 7, 11, 15],
];

const reset = process.argv.includes("--reset");

async function wipe() {
  const { data: players } = await db.from("players").select("id,name").in("name", DEMO_PLAYERS);
  const ids = (players ?? []).map((p) => p.id);

  // Media first: deleting the rows would orphan the files in Storage.
  const { data: subs } = await db.from("submissions").select("id,object_name");
  const objects = (subs ?? []).map((s) => s.object_name).filter(Boolean);
  if (objects.length) {
    for (let i = 0; i < objects.length; i += 100) {
      await db.storage.from(BUCKET).remove(objects.slice(i, i + 100));
    }
  }
  await db.from("submissions").delete().neq("id", "00000000-0000-0000-0000-000000000000");

  if (ids.length) {
    await db.from("roster").delete().in("player_id", ids);
    await db.from("players").delete().in("id", ids);
  }

  // Put the secret challenges back in the box and reopen the event.
  await db.from("tasks").update({ revealed_at: null }).not("revealed_at", "is", null);
  await db.from("settings").upsert(
    [
      { key: "active_round", value: "1" },
      { key: "submissions_open", value: "true" },
      { key: "notice", value: "" },
    ],
    { onConflict: "key" }
  );

  console.log(
    `Removed ${ids.length} demo player(s), ${subs?.length ?? 0} submission(s), ` +
      `${objects.length} media file(s). Secrets re-hidden, back to Round 1.`
  );
}

async function seed() {
  await db.from("players").upsert(
    DEMO_PLAYERS.map((name) => ({ name })),
    { onConflict: "name", ignoreDuplicates: true }
  );

  const { data: players } = await db.from("players").select("id,name").in("name", DEMO_PLAYERS);
  const idOf = new Map((players ?? []).map((p) => [p.name, p.id]));

  for (const [round, layout] of [
    [1, R1],
    [2, R2],
  ]) {
    const { data: teams } = await db
      .from("teams")
      .select("id,name")
      .eq("round", round)
      .order("sort_order");

    const rows = [];
    layout.forEach((group, teamIndex) => {
      const team = teams[teamIndex];
      if (!team) return;
      for (const playerIndex of group) {
        const id = idOf.get(DEMO_PLAYERS[playerIndex]);
        if (id) rows.push({ round, player_id: id, team_id: team.id });
      }
    });

    await db.from("roster").upsert(rows, { onConflict: "round,player_id" });

    console.log(`\nRound ${round}`);
    layout.forEach((group, i) => {
      if (!teams[i]) return;
      console.log(`  ${teams[i].name.padEnd(32)} ${group.map((g) => DEMO_PLAYERS[g]).join(", ")}`);
    });
  }

  console.log(
    `\n${DEMO_PLAYERS.length} players loaded across 4 teams, remixed between rounds.` +
      `\nEveryone changes team at the break, so you can watch Round 1 scores stay put.` +
      `\n\nWipe it all with:  npm run demo:reset`
  );
}

(reset ? wipe() : seed()).catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
