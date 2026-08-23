import { db, mediaUrl } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { json, fail, isVideoObject } from "@/lib/http";
import { winningGroups } from "@/lib/scored-entries.mjs";
import type { Database } from "@/lib/database.types";

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
    )
    .eq("round", round)
    .eq("team_id", teamId)
    .eq("status", "approved")
    .order("judged_at", { ascending: false })
    .order("created_at", { ascending: false })
    .order("id", { ascending: false });

  if (submissionsError) return fail("Couldn't load that team's entries right now. Try again.", 503);

  const groups = winningGroups((submissions ?? []) as SubmissionRow[]) as SubmissionRow[][];
  const taskIds = [...new Set(groups.map((files) => files[0].task_id))];
  const playerIds = [...new Set(groups.flatMap((files) => files.map((file) => file.player_id)))];

  let tasks: Array<{ id: string; title: string; sort_order: number }> = [];
  let players: Array<{ id: string; name: string }> = [];
  if (groups.length > 0) {
    const [{ data: taskRows, error: tasksError }, { data: playerRows, error: playersError }] = await Promise.all([
      sb.from("tasks").select("id,title,sort_order").in("id", taskIds),
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
          taskId: first.task_id,
          taskTitle: task?.title ?? "(deleted task)",
          points: first.points_awarded ?? 0,
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
