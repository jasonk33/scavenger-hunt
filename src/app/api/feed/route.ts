import { db, mediaUrl } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { groupBy, groupKey } from "@/lib/groups";
import { json, isVideoObject } from "@/lib/http";
import { awardedBreakdown, scoreApproved } from "@/lib/scoring.mjs";

export const dynamic = "force-dynamic";

/** Judged submissions, newest first. This is the "for laughs" screen, so the
    rejected ones belong here too -- they are often the funniest thing anyone
    sent, they just didn't satisfy the task. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const settings = await getSettings();
  const round = Number(url.searchParams.get("round")) || settings.active_round;
  /*
   * The cap has to clear a whole round's judged submissions, or the feed
   * silently stops showing the oldest ones with nothing on screen to say so.
   * Five teams working through 79 tasks can produce a few hundred, and every
   * rejection now counts against this too.
   *
   * Photos are lazy-loaded so extra rows are nearly free, but videos render with
   * preload="auto" (required, or iOS shows an untappable black box), so each one
   * starts fetching as soon as it is rendered. Round 2 has 11 video-only tasks,
   * so a fully-scored round is worth on the order of 50 eager video fetches.
   *
   * The cap counts FILES, while the feed shows one post per group. Multi-file
   * submissions therefore make it show fewer posts, never more -- which is the
   * direction that protects the egress budget rather than spending it.
   */
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 400));
  const sb = db();

  const [{ data: subs }, { data: tasks }, { data: teams }, { data: players }] = await Promise.all([
    sb
      .from("submissions")
      .select(
        "id,task_id,team_id,player_id,object_name,media_type,group_id,note,created_at,status,points_awarded,task_points,reject_reason"
      )
      .eq("round", round)
      .in("status", ["approved", "rejected"])
      .order("judged_at", { ascending: false })
      .limit(limit),
    sb.from("tasks").select("id,title,points,scoring_mode,points_per_unit,competition_bonus,winner_team_id").eq("round", round),
    sb.from("teams").select("id,name,color").eq("round", round),
    sb.from("players").select("id,name"),
  ]);

  const taskById = new Map((tasks ?? []).map((t) => [t.id, t]));
  const teamById = new Map((teams ?? []).map((t) => [t.id, t]));
  const playerById = new Map((players ?? []).map((p) => [p.id, p]));
  const taskIds = [...new Set((subs ?? []).map((submission) => submission.task_id))];
  const { data: approved } = taskIds.length
    ? await sb
        .from("submissions")
        .select("id,round,task_id,team_id,status,points_awarded,measurement_value,task_points,scoring_mode_snapshot,points_per_unit_snapshot,competition_bonus_snapshot,created_at,judged_at")
        .eq("round", round)
        .in("task_id", taskIds)
        .eq("status", "approved")
    : { data: [] };
  const pointsById = new Map(
    scoreApproved(approved ?? [], tasks ?? []).map(({ row, points, base, bonus }) => [
      row.id,
      { total: points, base, bonus },
    ])
  );

  return json({
    round,
    items: groupBy(subs ?? [], groupKey).map((group) => {
      // Oldest first: judged_at is identical across a group, so it says nothing
      // about the order the files were shot in.
      const files = [...group].sort((a, b) => a.created_at.localeCompare(b.created_at));
      const s = files[0];
      /* Every file in the group is offered to the scoring map, not just `s`.
         The map is keyed by the row that actually SCORES, which within a group
         is the newest file -- while `s` is deliberately the oldest. Looking up
         the anchor alone therefore missed on every multi-file post and silently
         took the fallback, which reads only what was frozen at judging time and
         so cannot know about a competition bonus decided afterwards. The
         fallback is for a genuinely unranked row: a second approval on a task
         the team has already scored. */
      const split =
        files.map((f) => pointsById.get(f.id)).find((hit) => hit !== undefined) ??
        awardedBreakdown(s);
      return {
        id: s.id,
        status: s.status,
        // Only the first is rendered up front; the rest sit behind a tap. Every
        // video in a feed post fetches eagerly the moment it renders, so a
        // three-clip submission that auto-expanded would cost three fetches
        // from every phone that scrolled past it.
        media: files.map((f) => ({
          id: f.id,
          url: mediaUrl(f.object_name),
          isVideo: isVideoObject(f.media_type, f.object_name),
        })),
        note: files.find((f) => f.note)?.note ?? null,
        taskTitle: taskById.get(s.task_id)?.title ?? "",
        points: split.total,
        basePoints: split.base,
        bonusPoints: split.bonus,
        rejectReason: s.reject_reason,
        teamName: teamById.get(s.team_id)?.name ?? "",
        teamColor: teamById.get(s.team_id)?.color ?? "#666",
        playerName: playerById.get(s.player_id)?.name ?? "",
      };
    }),
  });
}
