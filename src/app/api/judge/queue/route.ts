import { db, mediaUrl } from "@/lib/db";
import { getSettings, isOrganizer } from "@/lib/settings";
import { groupBy, groupKey } from "@/lib/groups";
import { json, fail, isVideoObject } from "@/lib/http";
import { awardedBreakdown } from "@/lib/scoring.mjs";
import type { Database } from "@/lib/database.types";

type SubmissionRow = Database["public"]["Tables"]["submissions"]["Row"];

export const dynamic = "force-dynamic";

/**
 * The judging queue, plus the last few decisions so a misclick during live
 * scoring is one tap from being undone rather than a hunt through the database.
 *
 * One entry per GROUP, not per file. A team that sent three angles on one task
 * is one decision, so it has to be one card -- three cards would triple the
 * judge's work, and under once-per-team scoring approving them separately would
 * not even mean anything.
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
      //
      // The limit counts FILES while the list shows groups. That is the safe
      // direction to be wrong in: it can only show fewer groups than the cap,
      // and a group is written in lockstep so its files sort together.
      sb
        .from("submissions")
        .select("*")
        .eq("round", round)
        .in("status", ["approved", "rejected"])
        .order("judged_at", { ascending: false })
        .limit(300),
      sb.from("tasks").select("id,title,points,scoring_mode,measurement_label,points_per_unit,competition_bonus,requires_video,is_secret").eq("round", round),
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

  const shape = (group: SubmissionRow[]) => {
    // Oldest file first, so the judge sees them in the order they were shot.
    // `recent` arrives ordered by judged_at, which is identical across a group
    // and therefore says nothing about the order within one.
    const files = [...group].sort((a, b) => a.created_at.localeCompare(b.created_at));
    const s = files[0];
    const task = taskById.get(s.task_id);
    const team = teamById.get(s.team_id);
    const scoringMode = s.scoring_mode_snapshot ?? task?.scoring_mode ?? "fixed";
    const media = files.map((f) => ({
      id: f.id,
      url: mediaUrl(f.object_name),
      isVideo: isVideoObject(f.media_type, f.object_name),
      sizeBytes: f.size_bytes,
    }));
    const awarded = awardedBreakdown(s);
    return {
      // The anchor's id. Judging it applies to the whole group server-side, so
      // every existing caller keeps working unchanged.
      id: s.id,
      status: s.status,
      createdAt: s.created_at,
      media,
      // True if ANY file is a video. This only drives the "task is video-only"
      // warning, and one clip in the set does satisfy that task.
      isVideo: media.some((m) => m.isVideo),
      sizeBytes: files.reduce((sum, f) => sum + (f.size_bytes ?? 0), 0) || null,
      // Whichever file carries it -- the note is written across the whole group.
      note: files.find((f) => f.note)?.note ?? null,
      taskTitle: task?.title ?? "(deleted task)",
      taskPoints: s.task_points,
      scoringMode,
      measurementLabel: task?.measurement_label ?? "",
      measurementValue: s.measurement_value,
      pointsPerUnit: s.points_per_unit_snapshot ?? task?.points_per_unit ?? 0,
      competitionBonus: s.competition_bonus_snapshot ?? task?.competition_bonus ?? 0,
      requiresVideo: Boolean(task?.requires_video),
      isSecret: Boolean(task?.is_secret),
      teamId: s.team_id,
      teamName: team?.name ?? "(unknown team)",
      teamColor: team?.color ?? "#666",
      playerName: playerById.get(s.player_id)?.name ?? "someone",
      // Only meaningful for something still waiting: an approved row is itself
      // in `alreadyApproved`, so testing it here would tell a judge reopening
      // any past approval that it duplicates itself.
      duplicate: s.status === "pending" && alreadyApproved.has(`${s.team_id}:${s.task_id}`),
      pointsAwarded: s.points_awarded,
      // Split the same way the players see it, off the baseline frozen onto the
      // row. A competition bonus is deliberately absent: it is picked in Admin
      // after the round, so at judging time there is nothing to show.
      awardedBase: awarded.base,
      awardedBonus: awarded.bonus,
      rejectReason: s.reject_reason,
    };
  };

  const queue = groupBy(pending ?? [], groupKey).map(shape);
  const recentGroups = groupBy(recent ?? [], groupKey).map(shape);

  // Pending count for the OTHER round. After the 3:30pm flip there is normally
  // still a Round 1 backlog, and if the judge screen never mentions it those
  // submissions quietly never get scored. Counted in DECISIONS, so it means the
  // same thing as the count shown for the round on display.
  const { data: otherPending } = await sb
    .from("submissions")
    .select("id,group_id")
    .eq("round", round === 1 ? 2 : 1)
    .eq("status", "pending");
  const otherRoundPending = new Set((otherPending ?? []).map(groupKey)).size;

  return json({
    round,
    // Sent so the judge can move a submission that landed on the wrong team --
    // the realistic cause being a player tapping the wrong name when joining.
    teams: teams ?? [],
    queue,
    recent: recentGroups,
    pendingCount: queue.length,
    otherRoundPending,
  });
}
