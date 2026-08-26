import { db, mediaUrl } from "@/lib/db";
import { getSettings, isOrganizer } from "@/lib/settings";
import { json, fail } from "@/lib/http";

export const dynamic = "force-dynamic";

/** Everything the Admin screen needs, in one request. */
export async function GET() {
  if (!(await isOrganizer())) return fail("Organizer PIN required.", 401);

  const settings = await getSettings();
  const sb = db();

  const [{ data: players }, { data: teams }, { data: roster }, { data: tasks }, { data: subs }] =
    await Promise.all([
      sb.from("players").select("id,name").order("name"),
      sb.from("teams").select("id,round,name,color,sort_order").order("round").order("sort_order"),
      sb.from("roster").select("round,player_id,team_id"),
      sb
        .from("tasks")
        .select("id,round,title,points,scoring_mode,measurement_label,points_per_unit,competition_bonus,winner_team_id,requires_video,is_secret,revealed_at,sort_order,active")
        .order("round")
        .order("sort_order")
        .order("id"),
      sb.from("submissions").select("id,round,status,object_name,created_at,player_id,task_id"),
    ]);

  const all = subs ?? [];
  // Rows stuck in `uploading` are submissions whose bytes may or may not have
  // landed -- a dead phone, a closed tab, or a final PATCH that failed after a
  // successful upload. They never reach the judge queue on their own, so they
  // have to be visible AND recoverable: mediaUrl lets the organizer check
  // whether the file actually arrived before promoting it.
  const stuck = all
    .filter((s) => s.status === "uploading")
    .map((s) => ({
      id: s.id,
      round: s.round,
      objectName: s.object_name,
      mediaUrl: mediaUrl(s.object_name),
      createdAt: s.created_at,
      playerName: (players ?? []).find((p) => p.id === s.player_id)?.name ?? "?",
      taskTitle: (tasks ?? []).find((t) => t.id === s.task_id)?.title ?? "?",
    }));

  const counts = (round: number) => {
    const r = all.filter((s) => s.round === round);
    return {
      total: r.length,
      uploading: r.filter((s) => s.status === "uploading").length,
      pending: r.filter((s) => s.status === "pending").length,
      approved: r.filter((s) => s.status === "approved").length,
      rejected: r.filter((s) => s.status === "rejected").length,
    };
  };

  return json({
    settings,
    players: players ?? [],
    teams: teams ?? [],
    roster: roster ?? [],
    tasks: tasks ?? [],
    stuck,
    counts: { 1: counts(1), 2: counts(2) },
  });
}
