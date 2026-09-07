import { db } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { groupKey } from "@/lib/groups";
import { json, fail } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const settings = await getSettings();
  const requestedRound = Number(new URL(req.url).searchParams.get("round")) || settings.active_round;
  if (requestedRound !== 1 && requestedRound !== 2) return fail("Round must be 1 or 2.");
  // A stale selection must not reveal the remix before that round starts.
  const round = Math.min(requestedRound, settings.active_round);
  const sb = db();

  const [
    { data: scores, error: scoresError },
    { data: pending, error: pendingError },
    { data: roster, error: rosterError },
    { data: players, error: playersError },
  ] = await Promise.all([
    sb.from("team_scores").select("*").eq("round", round),
    sb.from("submissions").select("id,group_id,team_id").eq("round", round).eq("status", "pending"),
    sb.from("roster").select("team_id,player_id").eq("round", round),
    sb.from("players").select("id,name"),
  ]);
  if (scoresError || pendingError || rosterError || playersError) {
    return fail("Couldn't load the scores right now. Try again.", 503);
  }

  const playerById = new Map((players ?? []).map((player) => [player.id, player]));
  const membersByTeam = new Map<string, Array<{ id: string; name: string }>>();
  for (const entry of roster ?? []) {
    const player = playerById.get(entry.player_id);
    if (!player) return fail("Couldn't load the team members right now. Try again.", 503);
    const members = membersByTeam.get(entry.team_id) ?? [];
    members.push({ id: player.id, name: player.name });
    membersByTeam.set(entry.team_id, members);
  }

  // A team with a big backlog is not losing, it is waiting. Showing the pending
  // count stops a slow judge from looking like a bad score.
  //
  // Counted in DECISIONS, not files: three angles on one task are one thing the
  // judge has to look at, and this number has to mean what the same number means
  // on the judge screen and on the player's own progress card.
  const pendingGroups = new Map<string, Set<string>>();
  for (const p of pending ?? []) {
    const seen = pendingGroups.get(p.team_id) ?? new Set<string>();
    seen.add(groupKey(p));
    pendingGroups.set(p.team_id, seen);
  }

  const rows = (scores ?? [])
    .map((s) => ({
      teamId: s.team_id,
      name: s.name,
      color: s.color,
      points: s.points,
      tasksScored: s.tasks_scored,
      pending: pendingGroups.get(s.team_id)?.size ?? 0,
      members: (membersByTeam.get(s.team_id) ?? []).sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));

  return json({
    round,
    activeRound: settings.active_round,
    totalPending: new Set((pending ?? []).map(groupKey)).size,
    rows,
  });
}
