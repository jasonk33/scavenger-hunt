import { db } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { groupKey } from "@/lib/groups";
import { json } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const settings = await getSettings();
  const round = Number(new URL(req.url).searchParams.get("round")) || settings.active_round;
  const sb = db();

  const [{ data: scores }, { data: pending }] = await Promise.all([
    sb.from("team_scores").select("*").eq("round", round),
    sb.from("submissions").select("id,group_id,team_id").eq("round", round).eq("status", "pending"),
  ]);

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
    }))
    .sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));

  return json({
    round,
    activeRound: settings.active_round,
    totalPending: new Set((pending ?? []).map(groupKey)).size,
    rows,
  });
}
