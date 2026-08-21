import { db, mediaUrl } from "@/lib/db";
import { getSettings, isOrganizer } from "@/lib/settings";
import { json, fail, isVideoObject } from "@/lib/http";
import type { Database } from "@/lib/database.types";

type SubmissionRow = Database["public"]["Tables"]["submissions"]["Row"];

export const dynamic = "force-dynamic";

/**
 * The judging queue, plus the last few decisions so a misclick during live
 * scoring is one tap from being undone rather than a hunt through the database.
 */
export async function GET(req: Request) {
  if (!(await isOrganizer())) return fail("Organizer PIN required.", 401);

  const url = new URL(req.url);
  const settings = await getSettings();
  const round = Number(url.searchParams.get("round")) || settings.active_round;
  const sb = db();

  const [{ data: pending }, { data: recent }, { data: tasks }, { data: teams }, { data: players }] =
    await Promise.all([
      sb
        .from("submissions")
        .select("*")
        .eq("round", round)
        .eq("status", "pending")
        .order("created_at", { ascending: true }),
      // Everything judged this round, not just the last few. Any call can be
      // reopened and changed at any point, so the whole history has to be
      // reachable -- a 12-item window is useless an hour later.
      sb
        .from("submissions")
        .select("*")
        .eq("round", round)
        .in("status", ["approved", "rejected"])
        .order("judged_at", { ascending: false })
        .limit(300),
      sb.from("tasks").select("id,title,points,requires_video,is_secret").eq("round", round),
      sb.from("teams").select("id,name,color").eq("round", round),
      sb.from("players").select("id,name"),
    ]);

  const taskById = new Map((tasks ?? []).map((t) => [t.id, t]));
  const teamById = new Map((teams ?? []).map((t) => [t.id, t]));
  const playerById = new Map((players ?? []).map((p) => [p.id, p]));

  // Teams sometimes submit the same task twice -- two teammates racing, or a
  // retry after a rejection. That is allowed (a hard constraint would throw an
  // error in the field), and scoring counts a task once. The judge just needs to
  // SEE it, so approving a duplicate is a deliberate choice.
  const { data: approved } = await sb
    .from("submissions")
    .select("team_id,task_id")
    .eq("round", round)
    .eq("status", "approved");
  const alreadyApproved = new Set(
    (approved ?? []).map((s) => `${s.team_id}:${s.task_id}`)
  );

  const shape = (s: SubmissionRow) => {
    const task = taskById.get(s.task_id);
    const team = teamById.get(s.team_id);
    return {
      id: s.id,
      status: s.status,
      createdAt: s.created_at,
      mediaUrl: mediaUrl(s.object_name),
      mediaType: s.media_type,
      sizeBytes: s.size_bytes,
      isVideo: isVideoObject(s.media_type, s.object_name),
      taskTitle: task?.title ?? "(deleted task)",
      taskPoints: s.task_points,
      requiresVideo: Boolean(task?.requires_video),
      isSecret: Boolean(task?.is_secret),
      teamId: s.team_id,
      teamName: team?.name ?? "(unknown team)",
      teamColor: team?.color ?? "#666",
      playerName: playerById.get(s.player_id)?.name ?? "someone",
      duplicate: alreadyApproved.has(`${s.team_id}:${s.task_id}`),
      pointsAwarded: s.points_awarded,
      bonus: s.bonus,
      starred: s.starred,
      rejectReason: s.reject_reason,
    };
  };

  // Pending count for the OTHER round. After the 3:30pm flip there is normally
  // still a Round 1 backlog, and if the judge screen never mentions it those
  // submissions quietly never get scored.
  const { count: otherRoundPending } = await sb
    .from("submissions")
    .select("id", { count: "exact", head: true })
    .eq("round", round === 1 ? 2 : 1)
    .eq("status", "pending");

  return json({
    round,
    // Sent so the judge can move a submission that landed on the wrong team --
    // the realistic cause being a player tapping the wrong name when joining.
    teams: teams ?? [],
    queue: (pending ?? []).map(shape),
    recent: (recent ?? []).map(shape),
    pendingCount: (pending ?? []).length,
    otherRoundPending: otherRoundPending ?? 0,
  });
}
