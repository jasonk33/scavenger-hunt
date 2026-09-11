import { db, mediaUrl, uploadConfig } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { decisionKey } from "@/lib/scored-entries.mjs";
import { json, fail, isVideoObject } from "@/lib/http";
import { eventState } from "@/lib/event";
import { awardedBreakdown, scoreApproved } from "@/lib/scoring.mjs";

export const dynamic = "force-dynamic";

/** How many distinct pieces of evidence these rows amount to. */
const countGroups = (rows: Array<{ id: string; group_id: string | null; team_id: string; status: string; judged_at: string | null }>) =>
  new Set(rows.map(decisionKey)).size;

/**
 * The single endpoint the player app polls every 5 seconds. One round trip
 * returns everything the Submit screen needs, so there is no fan-out of requests
 * to get out of sync with each other.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const playerId = url.searchParams.get("playerId");

  const settings = await getSettings();
  if (!eventState(settings).tasksVisible) return fail("That round hasn't started yet. Head to Home to meet your team.", 409);
  const round = settings.active_round;
  const sb = db();

  // History still needs retained task metadata. Filter only the available list.
  const tasksQ = sb
    .from("tasks")
    .select("id,round,title,points,scoring_mode,measurement_label,points_per_unit,sort_order,active,is_secret")
    .eq("round", round)
    // id only breaks ties: two tasks CAN share sort_order, and an unstable list
    // polled every 5 seconds would visibly reshuffle under the player's thumb.
    .order("sort_order")
    .order("id");

  const [{ data: tasksRaw, error: tasksError }, { data: teams, error: teamsError }] = await Promise.all([
    tasksQ,
    sb.from("teams").select("id,round,name,color,sort_order").eq("round", round).order("sort_order"),
  ]);
  if (tasksError || teamsError) return fail("Couldn't load your team's progress. Try again.", 503);

  const tasks = (tasksRaw ?? []).flatMap(({ is_secret, ...task }) =>
    task.active && !is_secret
      ? [{ ...task, scoring_mode: task.scoring_mode === "quantity" ? "quantity" : "fixed" }]
      : []
  );

  let me: { id: string; name: string } | null = null;
  let team: { id: string; round: number; name: string; color: string; sort_order: number } | null =
    null;
  let mine: Array<{
    id: string;
    task_id: string;
    team_id: string;
    status: string;
    points_awarded: number | null;
    created_at: string;
    reject_reason: string | null;
    player_id: string;
    object_name: string;
    media_type: string | null;
    group_id: string | null;
    note: string | null;
    judged_at: string | null;
    measurement_value: number | null;
    task_points: number | null;
    scoring_mode_snapshot: "fixed" | "quantity";
  }> = [];
  // Names of whoever on the team actually sent each submission. Progress is
  // team-wide, so "you already submitted this" is often really a teammate --
  // and telling the two apart is the whole point of being able to look.
  let submitterName = new Map<string, string>();

  if (playerId) {
    const { data: p, error: playerError } = await sb.from("players").select("id,name").eq("id", playerId).maybeSingle();
    if (playerError) return fail("Couldn't load your player details. Try again.", 503);
    me = p ?? null;

    if (me) {
      const { data: r, error: rosterError } = await sb
        .from("roster")
        .select("team_id")
        .eq("round", round)
        .eq("player_id", playerId)
        .maybeSingle();
      if (rosterError) return fail("Couldn't load your team assignment. Try again.", 503);

      if (r) team = (teams ?? []).find((t) => t.id === r.team_id) ?? null;

      // Progress is shown per TEAM, not per player -- any teammate's submission
      // counts for everyone, and people need to see what has already been done so
      // two people don't burn time on the same task.
      if (team) {
        // Keep team_id: decisionKey distinguishes reassigned group members.
        const { data: subs, error: submissionsError } = await sb
          .from("submissions")
          .select(
            "id,task_id,team_id,status,points_awarded,created_at,judged_at,reject_reason,player_id,object_name,media_type,group_id,note,measurement_value,task_points,scoring_mode_snapshot,points_per_unit_snapshot"
          )
          .eq("round", round)
          .eq("team_id", team.id)
          .order("created_at", { ascending: false });
        if (submissionsError) return fail("Couldn't load your team's submissions. Try again.", 503);
        mine = subs ?? [];

        // Scoped to the handful of people who actually submitted rather than
        // selecting the whole players table: this endpoint is polled by every
        // phone every 5 seconds.
        const submitterIds = [...new Set(mine.map((s) => s.player_id))];
        if (submitterIds.length > 0) {
          const { data: submitters, error: submittersError } = await sb
            .from("players")
            .select("id,name")
            .in("id", submitterIds);
          if (submittersError) return fail("Couldn't load the submission names. Try again.", 503);
          submitterName = new Map((submitters ?? []).map((p) => [p.id, p.name]));
        }
      }
    }
  }

  const scored = mine.filter((s) => s.status === "approved");
  /*
   * Mirrors the team_scores view: a task counts once, at whatever the judge
   * ruled MOST RECENTLY. `mine` is ordered created_at descending, which is not
   * the same thing -- an older upload re-approved just now is the live ruling --
   * so this sorts by judged_at explicitly rather than trusting the query order.
   *
   * If these two ever disagree, a team sees one score on their own task list and
   * a different one on the leaderboard.
   */
  const scoredRows = scoreApproved(mine, tasksRaw ?? []) as Array<{
    row: { id: string; task_id: string; group_id: string | null; team_id: string; status: string; judged_at: string | null };
    points: number;
    base: number;
    bonus: number;
  }>;
  const bestByTask = new Map(
    scoredRows.map(({ row: s, points }) => [s.task_id, { pts: points }])
  );
  /* Keyed by GROUP, not by row. Several files sent as one piece of evidence are
     one thing the judge decided, but only the newest of them is the row that
     scores -- and the expanded list on /submit reads its pill off the OLDEST.
     Resolve the scoring decision, not an arbitrary file's frozen numbers. */
  const rankedByGroup = new Map(
    scoredRows.map(({ row, base, bonus, points }) => [
      decisionKey(row),
      { base, bonus, total: points },
    ])
  );
  /* Every judged row the screen may render, not just the scoring ones: a second
     approval on a task the team already banked still shows its own pill in the
     expanded list, and it has to split into baseline and bonus the same way. It
     is its own group, so it misses the map above and takes the frozen split. */
  const splitById = new Map(
    mine
      .filter((s) => s.status === "approved")
      .map((s) => [s.id, rankedByGroup.get(decisionKey(s)) ?? awardedBreakdown(s)])
  );

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
    // has since removed would render as "a task" with
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
      saved_epoch: settings.saved_epoch,
    },
    me,
    team,
    tasks,
    // Media URLs are just strings, so sending them costs nothing; the Submit
    // screen only fetches the bytes for a submission the player opens. The
    // object path itself is dropped -- the URL already contains it, and this
    // endpoint is polled by every phone every 5 seconds.
    submissions: mine.map(({ object_name, media_type, group_id, ...s }) => ({
      ...s,
      scoring_mode_snapshot: s.scoring_mode_snapshot === "quantity" ? "quantity" : "fixed",
      points_awarded: splitById.get(s.id)?.total ?? s.points_awarded,
      // What the task itself was worth, and what the team earned on top of it.
      // Sent split rather than as one number so no screen has to subtract a
      // baseline it fetched separately and get a different answer.
      basePoints: splitById.get(s.id)?.base ?? null,
      bonusPoints: splitById.get(s.id)?.bonus ?? 0,
      // What ties several files into one piece of evidence.
      groupId: decisionKey({ ...s, group_id }),
      mediaUrl: mediaUrl(object_name),
      isVideo: isVideoObject(media_type, object_name),
      playerName: submitterName.get(s.player_id) ?? "a teammate",
    })),
    stats: {
      // Counted in pieces of evidence rather than files, so "waiting" means the
      // same number of decisions the judge sees. Three angles on one task are
      // one thing the team did, not three.
      submitted: countGroups(mine.filter((s) => s.status !== "uploading")),
      pending: countGroups(mine.filter((s) => s.status === "pending")),
      approved: countGroups(scored),
      rejected: countGroups(mine.filter((s) => s.status === "rejected")),
      points: [...bestByTask.values()].reduce((a, b) => a + b.pts, 0),
    },
    upload: { endpoint: up.endpoint, anonKey: up.anonKey, bucket: up.bucket },
  });
}
