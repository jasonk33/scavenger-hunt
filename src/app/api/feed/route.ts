import { db, mediaUrl } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { json, isVideoObject } from "@/lib/http";

export const dynamic = "force-dynamic";

/** Approved submissions, newest first. This is the "for laughs" screen. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const settings = await getSettings();
  const round = Number(url.searchParams.get("round")) || settings.active_round;
  /*
   * The cap has to clear a whole round's approvals, or the feed silently stops
   * showing the oldest ones with nothing on screen to say so. Five teams working
   * through 79 tasks can produce a few hundred; the images are lazy-loaded, so a
   * long list costs DOM nodes rather than bandwidth.
   */
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 400));
  const sb = db();

  const [{ data: subs }, { data: tasks }, { data: teams }, { data: players }] = await Promise.all([
    sb
      .from("submissions")
      .select("*")
      .eq("round", round)
      .eq("status", "approved")
      .order("judged_at", { ascending: false })
      .limit(limit),
    sb.from("tasks").select("id,title").eq("round", round),
    sb.from("teams").select("id,name,color").eq("round", round),
    sb.from("players").select("id,name"),
  ]);

  const taskById = new Map((tasks ?? []).map((t) => [t.id, t]));
  const teamById = new Map((teams ?? []).map((t) => [t.id, t]));
  const playerById = new Map((players ?? []).map((p) => [p.id, p]));

  return json({
    round,
    items: (subs ?? []).map((s) => ({
      id: s.id,
      mediaUrl: mediaUrl(s.object_name),
      isVideo: isVideoObject(s.media_type, s.object_name),
      taskTitle: taskById.get(s.task_id)?.title ?? "",
      points: (s.points_awarded ?? 0) + (s.bonus ?? 0),
      bonus: s.bonus,
      starred: s.starred,
      teamName: teamById.get(s.team_id)?.name ?? "",
      teamColor: teamById.get(s.team_id)?.color ?? "#666",
      playerName: playerById.get(s.player_id)?.name ?? "",
      judgedAt: s.judged_at,
    })),
  });
}
