import { db, mediaUrl } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { json, fail, isVideoObject } from "@/lib/http";
import { winningGroups } from "@/lib/scored-entries.mjs";
import type { Database } from "@/lib/database.types";
import { scoreApproved } from "@/lib/scoring.mjs";

type SubmissionRow = Database["public"]["Tables"]["submissions"]["Row"];

export const dynamic = "force-dynamic";

/**
 * Approved evidence for one task, excluding the player's current team.
 *
 * This is deliberately lazy: the task list already polls every few seconds, but
 * media URLs should not be handed to the browser until someone asks to see them.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const taskId = url.searchParams.get("taskId") ?? "";
  const playerId = url.searchParams.get("playerId") ?? "";
  if (!taskId || !playerId) return fail("taskId and playerId are required.");

  const settings = await getSettings();
  const round = settings.active_round;
  const sb = db();

  const [
    { data: player, error: playerError },
    { data: task, error: taskError },
    { data: roster, error: rosterError },
  ] = await Promise.all([
    sb.from("players").select("id").eq("id", playerId).maybeSingle(),
    sb
      .from("tasks")
      .select("id,round,title,points,scoring_mode,measurement_label,measurement_threshold,points_per_unit,measurement_cap,competition_bonus,active,is_secret,revealed_at")
      .eq("id", taskId)
      .eq("round", round)
      .maybeSingle(),
    sb.from("roster").select("team_id").eq("round", round).eq("player_id", playerId).maybeSingle(),
  ]);

  if (playerError || taskError || rosterError) {
    return fail("Couldn't load task entries right now. Try again.", 503);
  }
  if (!player) return fail("We don't know who you are. Pick your name again.", 404);
  if (!task || !task.active) return fail("That task no longer exists.", 404);
  if (task.is_secret && !task.revealed_at) return fail("That challenge hasn't been revealed yet.", 409);
  if (!roster) return fail(`You're not on a Round ${round} team yet.`, 409);

  const { data: submissions, error: submissionsError } = await sb
    .from("submissions")
    .select(
      "id,round,task_id,player_id,team_id,object_name,media_type,points_awarded,measurement_value,task_points,scoring_mode_snapshot,measurement_threshold_snapshot,points_per_unit_snapshot,measurement_cap_snapshot,competition_bonus_snapshot,group_id,note,created_at,judged_at,status"
    )
    .eq("round", round)
    .eq("task_id", taskId)
    .eq("status", "approved")
    .order("judged_at", { ascending: false })
    .order("created_at", { ascending: false })
    .order("id", { ascending: false });

  if (submissionsError) return fail("Couldn't load task entries right now. Try again.", 503);

  const scored = scoreApproved(submissions ?? [], [task]).map(({ row, points }) => ({ ...row, effectivePoints: points }));
  const groups = (winningGroups(scored as SubmissionRow[]) as SubmissionRow[][]).filter(
    (files) => files[0]?.team_id !== roster.team_id
  );
  if (groups.length === 0) return json({ entries: [] });

  const teamIds = [...new Set(groups.map((files) => files[0].team_id))];
  const playerIds = [...new Set(groups.flatMap((files) => files.map((file) => file.player_id)))];

  const [{ data: teams, error: teamsError }, { data: players, error: playersError }] = await Promise.all([
    sb.from("teams").select("id,name,color,sort_order").in("id", teamIds),
    sb.from("players").select("id,name").in("id", playerIds),
  ]);

  if (teamsError || playersError) return fail("Couldn't load task entries right now. Try again.", 503);

  const teamById = new Map((teams ?? []).map((team) => [team.id, team]));
  const playerById = new Map((players ?? []).map((p) => [p.id, p]));
  const teamOrder = new Map((teams ?? []).map((team) => [team.id, team.sort_order]));

  const entries = groups
    .map((files) => {
      const first = files[0];
      const team = teamById.get(first.team_id);
      return {
        sortOrder: teamOrder.get(first.team_id) ?? Number.MAX_SAFE_INTEGER,
        entry: {
          id: first.id,
          taskTitle: task.title,
          points: scored.find((row) => row.id === first.id)?.effectivePoints ?? first.points_awarded ?? 0,
          media: files.map((file) => ({
            id: file.id,
            url: mediaUrl(file.object_name),
            isVideo: isVideoObject(file.media_type, file.object_name),
          })),
          note: files.find((file) => file.note)?.note ?? null,
          teamId: first.team_id,
          teamName: team?.name ?? "(unknown team)",
          teamColor: team?.color ?? "#666",
          playerName: playerById.get(first.player_id)?.name ?? "someone",
        },
      };
    })
    .sort((a, b) => a.sortOrder - b.sortOrder || a.entry.teamName.localeCompare(b.entry.teamName))
    .map(({ entry }) => entry);

  return json({ entries });
}
