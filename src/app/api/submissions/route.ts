import { db } from "@/lib/db";
import { getSettings } from "@/lib/settings";
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

  // Path is organized so the post-event bulk download unzips into round/team
  // folders with readable filenames, instead of a flat pile of UUIDs.
  const stamp = Date.now().toString(36);
  const objectName = `round-${round}/${slug(team?.name ?? "team")}/${slug(
    t.title,
    50
  )}--${stamp}.${ext}`;

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
      status: "uploading",
    })
    .select("id")
    .single();

  if (error || !created) return fail(`Could not start the submission: ${error?.message}`, 500);

  return json({
    submissionId: created.id,
    objectName,
    contentType,
    task: { id: t.id, title: t.title, points: t.points },
  });
}
