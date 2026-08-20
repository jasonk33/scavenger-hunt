import { db } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { json } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const settings = await getSettings();
  const round = Number(new URL(req.url).searchParams.get("round")) || settings.active_round;
  const sb = db();

  const [{ data: scores }, { data: pending }] = await Promise.all([
    sb.from("team_scores").select("*").eq("round", round),
    sb.from("submissions").select("team_id").eq("round", round).eq("status", "pending"),
  ]);

  // A team with a big backlog is not losing, it is waiting. Showing the pending
  // count stops a slow judge from looking like a bad score.
  const pendingByTeam = new Map<string, number>();
  for (const p of pending ?? []) {
    const k = p.team_id;
    pendingByTeam.set(k, (pendingByTeam.get(k) ?? 0) + 1);
  }

  const rows = (scores ?? [])
    .map((s) => ({
      teamId: s.team_id,
      name: s.name,
      color: s.color,
      points: s.points,
      tasksScored: s.tasks_scored,
      pending: pendingByTeam.get(s.team_id) ?? 0,
    }))
    .sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));

  return json({
    round,
    activeRound: settings.active_round,
    totalPending: (pending ?? []).length,
    rows,
  });
}
