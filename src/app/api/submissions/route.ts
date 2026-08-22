import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { groupKey } from "@/lib/groups";
import { json, fail, slug, playableType, extOf } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * Step 1 of a submission: reserve the row and the object path BEFORE any bytes
 * move.
 *
 * The client never tells us the round, the team or the point value. All three are
 * resolved here -- team from the roster for the *currently active* round, points
 * from the tasks table -- and then written onto the submission row. That is what
 * makes the 3:30pm roster remix safe: a Round 1 submission keeps pointing at the
 * Round 1 team forever, even after that player moves to a different team.
 */
export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return fail("Malformed request body.");
  }

  // Coerce at the boundary: everything past this point is a real string.
  const playerId = String(body?.playerId ?? "");
  const taskId = String(body?.taskId ?? "");
  const fileName = String(body?.fileName ?? "upload");
  const fileType = String(body?.fileType ?? "");
  // Optional: the id of a submission this file is another angle on. Never a
  // group id -- see the lookup below for why.
  const groupWith = String(body?.groupWith ?? "");
  if (!playerId || !taskId) return fail("playerId and taskId are required.");

  const settings = await getSettings();
  if (!settings.submissions_open) {
    return fail("Submissions are closed right now. Check with an organizer.", 409);
  }
  const round = settings.active_round;
  const sb = db();

  const [{ data: player }, { data: task }] = await Promise.all([
    sb.from("players").select("id,name").eq("id", playerId).maybeSingle(),
    sb
      .from("tasks")
      .select("id,round,title,points,active,is_secret,revealed_at")
      .eq("id", taskId)
      .maybeSingle(),
  ]);

  if (!player) return fail("We don't know who you are. Go back and pick your name again.", 404);
  if (!task || !task.active) return fail("That task no longer exists.", 404);

  const t = task;
  if (t.round !== round) return fail(`That task belongs to Round ${t.round}, not Round ${round}.`, 409);
  if (t.is_secret && !t.revealed_at) return fail("That challenge hasn't been revealed yet.", 409);

  const { data: rosterRow } = await sb
    .from("roster")
    .select("team_id")
    .eq("round", round)
    .eq("player_id", playerId)
    .maybeSingle();

  if (!rosterRow) {
    return fail(`You're not on a Round ${round} team yet. Ask an organizer to add you.`, 409);
  }
  const teamId = rosterRow.team_id;

  const { data: team } = await sb.from("teams").select("name").eq("id", teamId).maybeSingle();

  const contentType = playableType(fileName, fileType);
  const ext = extOf(fileName, contentType);

  /*
   * "Another angle on the thing I just sent."
   *
   * The client names a SUBMISSION it already owns, not a group id, and the
   * server reads that row's group off the database. So a client cannot invent a
   * group id and staple its file onto another team's evidence: the row it names
   * has to be in this same round, on this same team, for this same task, and
   * still unjudged. Anything else silently starts a fresh group instead of
   * failing -- the worst case is the judge seeing two cards where one was
   * intended, which is a cosmetic problem, whereas rejecting the upload would
   * cost a player their photo in the field.
   *
   * `groupKey` rather than `.group_id` directly, so a row that predates the
   * column still anchors a group.
   */
  let groupId: string = randomUUID();
  // A file joining a group inherits its note. Every read that looks at a single
  // row -- the export CSV is one row per file -- would otherwise show the
  // explanation against the first photo and nothing against the rest.
  let note: string | null = null;
  if (groupWith) {
    const { data: anchor } = await sb
      .from("submissions")
      .select("id,group_id,round,team_id,task_id,status,note")
      .eq("id", groupWith)
      .maybeSingle();
    if (
      anchor &&
      anchor.round === round &&
      anchor.team_id === teamId &&
      anchor.task_id === t.id &&
      (anchor.status === "uploading" || anchor.status === "pending")
    ) {
      groupId = groupKey(anchor);
      note = anchor.note;
    }
  }

  // Path is organized so the post-event bulk download unzips into round/team
  // folders with readable filenames, instead of a flat pile of UUIDs.
  //
  // The millisecond stamp alone is NOT enough to make it unique: teammates
  // shooting the same task tend to hit Upload together, and two reservations
  // landing in the same millisecond produce byte-identical paths. Uploads send
  // `x-upsert: true`, so the second one would overwrite the first -- two
  // submission rows pointing at one file, the judge shown the same photo twice,
  // and a player's evidence gone with nothing anywhere reporting a failure.
  // Measured at ~10% duplicates in a burst of 30 before the random suffix.
  //
  // Two files added to the SAME group are the tightest version of that race, so
  // the random suffix matters more now, not less.
  const stamp = Date.now().toString(36);
  const objectName = `round-${round}/${slug(team?.name ?? "team")}/${slug(
    t.title,
    50
  )}--${stamp}-${randomUUID().slice(0, 8)}.${ext}`;

  const { data: created, error } = await sb
    .from("submissions")
    .insert({
      round,
      task_id: t.id,
      player_id: playerId,
      team_id: teamId,
      task_points: t.points,
      object_name: objectName,
      media_type: contentType,
      group_id: groupId,
      note,
      status: "uploading",
    })
    .select("id")
    .single();

  if (error || !created) return fail(`Could not start the submission: ${error?.message}`, 500);

  return json({
    submissionId: created.id,
    groupId,
    objectName,
    contentType,
    task: { id: t.id, title: t.title, points: t.points },
  });
}
