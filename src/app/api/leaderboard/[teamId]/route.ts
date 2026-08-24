import { db, mediaUrl } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { json, fail, isVideoObject } from "@/lib/http";
import { winningGroups } from "@/lib/scored-entries.mjs";
import type { Database } from "@/lib/database.types";
import { scoreApproved } from "@/lib/scoring.mjs";

type SubmissionRow = Database["public"]["Tables"]["submissions"]["Row"];

export const dynamic = "force-dynamic";

/**
 * The approved entries that make up one team's displayed score.
 *
 * The aggregate leaderboard comes from `team_scores`; this endpoint repeats its
 * latest-approved selection so expanding a team never shows duplicate approvals
 * that are not part of the number beside the team.
 */
export async function GET(req: Request, ctx: { params: Promise<{ teamId: string }> }) {
  const { teamId } = await ctx.params;
  const settings = await getSettings();
  const round = Number(new URL(req.url).searchParams.get("round")) || settings.active_round;
  if (round !== 1 && round !== 2) return fail("Round must be 1 or 2.");

  const sb = db();
  const { data: team, error: teamError } = await sb
    .from("teams")
    .select("id,round,name,color")
    .eq("id", teamId)
    .eq("round", round)
    .maybeSingle();

  if (teamError) return fail("Couldn't load that team's entries right now. Try again.", 503);
  if (!team) return fail("Team not found.", 404);

  const { data: submissions, error: submissionsError } = await sb
    .from("submissions")
    .select(
      "id,round,task_id,player_id,team_id,object_name,media_type,points_awarded,group_id,note,created_at,judged_at,status"
      + ",measurement_value,task_points,scoring_mode_snapshot,measurement_threshold_snapshot,points_per_unit_snapshot,measurement_cap_snapshot,competition_bonus_snapshot"
    )
    .eq("round", round)
    .eq("team_id", teamId)
    .eq("status", "approved")
    .order("judged_at", { ascending: false })
    .order("created_at", { ascending: false })
    .order("id", { ascending: false });

  if (submissionsError) return fail("Couldn't load that team's entries right now. Try again.", 503);

  const teamSubmissions = (submissions ?? []) as unknown as SubmissionRow[];
  const taskIds = [...new Set(teamSubmissions.map((submission) => submission.task_id))];
  let taskRows: Array<Record<string, unknown>> = [];
  let allApproved: Array<Record<string, unknown>> = [];
  if (taskIds.length > 0) {
    const result = await Promise.all([
      sb.from("tasks").select("id,title,points,scoring_mode,measurement_threshold,points_per_unit,measurement_cap,competition_bonus,sort_order").in("id", taskIds),
      sb
        .from("submissions")
        .select("id,round,task_id,team_id,status,points_awarded,measurement_value,task_points,scoring_mode_snapshot,measurement_threshold_snapshot,points_per_unit_snapshot,measurement_cap_snapshot,competition_bonus_snapshot,created_at,judged_at")
        .eq("round", round)
        .in("task_id", taskIds)
        .eq("status", "approved"),
    ]);
    taskRows = result[0].data ?? [];
    allApproved = result[1].data ?? [];
  }
  const scored = scoreApproved(allApproved ?? [], taskRows ?? []);
  const pointsById = new Map(scored.map(({ row, points }) => [row.id, points]));
  const groups = winningGroups(teamSubmissions) as SubmissionRow[][];
  const groupTaskIds = [...new Set(groups.map((files) => files[0].task_id))];
  const playerIds = [...new Set(groups.flatMap((files) => files.map((file) => file.player_id)))];

  let tasks: Array<{ id: string; title: string; sort_order: number }> = [];
  let players: Array<{ id: string; name: string }> = [];
  if (groups.length > 0) {
    const [{ data: taskRows, error: tasksError }, { data: playerRows, error: playersError }] = await Promise.all([
      sb.from("tasks").select("id,title,sort_order").in("id", groupTaskIds),
      sb.from("players").select("id,name").in("id", playerIds),
    ]);
    if (tasksError || playersError) return fail("Couldn't load that team's entries right now. Try again.", 503);
    tasks = taskRows ?? [];
    players = playerRows ?? [];
  }

  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const playerById = new Map(players.map((player) => [player.id, player]));
  const entries = groups
    .map((files) => {
      const first = files[0];
      const task = taskById.get(first.task_id);
      return {
        sortOrder: task?.sort_order ?? Number.MAX_SAFE_INTEGER,
        entry: {
          id: first.id,
          taskTitle: task?.title ?? "(deleted task)",
          points: pointsById.get(first.id) ?? first.points_awarded ?? 0,
          media: files.map((file) => ({
            id: file.id,
            url: mediaUrl(file.object_name),
            isVideo: isVideoObject(file.media_type, file.object_name),
          })),
          note: files.find((file) => file.note)?.note ?? null,
          teamId: first.team_id,
          teamName: team.name,
          teamColor: team.color,
          playerName: playerById.get(first.player_id)?.name ?? "someone",
        },
      };
    })
    .sort((a, b) => a.sortOrder - b.sortOrder || a.entry.taskTitle.localeCompare(b.entry.taskTitle))
    .map(({ entry }) => entry);

  return json({
    round,
    team: { id: team.id, name: team.name, color: team.color },
    entries,
  });
}
