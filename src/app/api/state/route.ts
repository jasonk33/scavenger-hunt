import { db, uploadConfig } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { json } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * The single endpoint the player app polls every 5 seconds. One round trip
 * returns everything the Submit screen needs, so there is no fan-out of requests
 * to get out of sync with each other.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const playerId = url.searchParams.get("playerId");

  const settings = await getSettings();
  const round = settings.active_round;
  const sb = db();

  // Secret challenges are hidden until an organizer reveals them. Filtering here
  // rather than in the client means an unrevealed task never reaches the browser.
  const tasksQ = sb
    .from("tasks")
    .select("id,round,title,points,requires_video,is_secret,revealed_at,sort_order")
    .eq("round", round)
    .eq("active", true)
    .order("sort_order");

  const [{ data: tasksRaw }, { data: teams }] = await Promise.all([
    tasksQ,
    sb.from("teams").select("id,round,name,color,sort_order").eq("round", round).order("sort_order"),
  ]);

  const tasks = (tasksRaw ?? []).filter((t) => !t.is_secret || t.revealed_at);

  let me: { id: string; name: string } | null = null;
  let team: { id: string; round: number; name: string; color: string; sort_order: number } | null =
    null;
  let mine: Array<{
    id: string;
    task_id: string;
    status: string;
    points_awarded: number | null;
    bonus: number;
    created_at: string;
    reject_reason: string | null;
    player_id: string;
  }> = [];

  if (playerId) {
    const { data: p } = await sb.from("players").select("id,name").eq("id", playerId).maybeSingle();
    me = p ?? null;

    if (me) {
      const { data: r } = await sb
        .from("roster")
        .select("team_id")
        .eq("round", round)
        .eq("player_id", playerId)
        .maybeSingle();

      if (r) team = (teams ?? []).find((t) => t.id === r.team_id) ?? null;

      // Progress is shown per TEAM, not per player -- any teammate's submission
      // counts for everyone, and people need to see what has already been done so
      // two people don't burn time on the same task.
      if (team) {
        const { data: subs } = await sb
          .from("submissions")
          .select("id,task_id,status,points_awarded,bonus,created_at,reject_reason,player_id")
          .eq("round", round)
          .eq("team_id", team.id)
          .order("created_at", { ascending: false });
        mine = subs ?? [];
      }
    }
  }

  const scored = mine.filter((s) => s.status === "approved");
  // Mirrors the team_scores view: a task counts once, at its best result.
  const bestByTask = new Map<string, number>();
  for (const s of scored) {
    const pts = (s.points_awarded ?? 0) + (s.bonus ?? 0);
    if (pts > (bestByTask.get(s.task_id) ?? -1)) bestByTask.set(s.task_id, pts);
  }

  /**
   * Rejections the team still needs to act on: rejected, and no approved
   * submission for that task since. A rejection the team has already redone
   * successfully drops off by itself, so this list is always "what to fix now"
   * rather than a running tally of failures.
   */
  const approvedTasks = new Set(scored.map((s) => s.task_id));
  const taskTitle = new Map((tasks ?? []).map((t) => [t.id, t.title]));
  const openRejections = mine
    // Only tasks still in the visible list: a rejection on a task the organizer
    // has since removed (or an unrevealed secret) would render as "a task" with
    // a Retry button that does nothing.
    .filter((s) => s.status === "rejected" && !approvedTasks.has(s.task_id) && taskTitle.has(s.task_id))
    // One entry per task, even if two teammates both got rejected on it.
    .filter((s, i, arr) => arr.findIndex((o) => o.task_id === s.task_id) === i)
    .map((s) => ({
      id: s.id,
      taskId: s.task_id,
      taskTitle: taskTitle.get(s.task_id) ?? "a task",
      reason: s.reject_reason,
      at: s.created_at,
    }));

  const up = uploadConfig();

  return json({
    rejections: openRejections,
    settings: {
      round,
      submissions_open: settings.submissions_open,
      event_name: settings.event_name,
    },
    me,
    team,
    tasks,
    submissions: mine,
    stats: {
      submitted: mine.filter((s) => s.status !== "uploading").length,
      pending: mine.filter((s) => s.status === "pending").length,
      approved: scored.length,
      rejected: mine.filter((s) => s.status === "rejected").length,
      points: [...bestByTask.values()].reduce((a, b) => a + b, 0),
    },
    upload: { endpoint: up.endpoint, anonKey: up.anonKey, bucket: up.bucket },
    configOk: Boolean(up.keyLooksValid),
  });
}
