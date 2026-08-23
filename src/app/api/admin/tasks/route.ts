import { db } from "@/lib/db";
import { isOrganizer } from "@/lib/settings";
import { json, fail } from "@/lib/http";
import { boardMirrorPatch } from "@/lib/board-mirror.mjs";
import type { Database } from "@/lib/database.types";

type TaskUpdate = Database["public"]["Tables"]["tasks"]["Update"];

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!(await isOrganizer())) return fail("Organizer PIN required.", 401);
  const b = await req.json().catch(() => ({}));

  const round = Number(b?.round);
  const title = String(b?.title ?? "").trim();
  const points = Number(b?.points);
  if (round !== 1 && round !== 2) return fail("round must be 1 or 2.");
  if (!title) return fail("title required.");
  if (!Number.isFinite(points) || points <= 0) return fail("points must be a positive number.");

  const { data: last } = await db()
    .from("tasks")
    .select("sort_order")
    .eq("round", round)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data, error } = await db()
    .from("tasks")
    .insert({
      round,
      title,
      points,
      requires_video: Boolean(b?.requiresVideo),
      is_secret: Boolean(b?.isSecret),
      sort_order: Number(last?.sort_order ?? 0) + 10,
    })
    .select("id")
    .single();

  if (error) return fail(error.message, 500);
  return json({ ok: true, id: data.id });
}

/**
 * Update a task. Also the reveal mechanism for secret challenges: reveal is
 * organizer-triggered rather than clock-triggered, because the event will run
 * late and a task that unlocks itself at 2:00pm sharp while everyone is still
 * mid-round is worse than no automation at all.
 */
export async function PATCH(req: Request) {
  if (!(await isOrganizer())) return fail("Organizer PIN required.", 401);
  const b = await req.json().catch(() => ({}));
  const id = String(b?.id ?? "");
  if (!id) return fail("id required.");

  const patch: TaskUpdate = {};
  if (typeof b.title === "string" && b.title.trim()) patch.title = b.title.trim();
  if (Number.isFinite(Number(b.points)) && Number(b.points) > 0) patch.points = Number(b.points);
  if (typeof b.requiresVideo === "boolean") patch.requires_video = b.requiresVideo;
  if (typeof b.isSecret === "boolean") patch.is_secret = b.isSecret;
  if (typeof b.active === "boolean") patch.active = b.active;
  if (typeof b.revealed === "boolean") {
    patch.revealed_at = b.revealed ? new Date().toISOString() : null;
  }
  if (!Object.keys(patch).length) return fail("Nothing to update.");

  const { error } = await db().from("tasks").update(patch).eq("id", id);
  if (error) return fail(error.message, 500);
  return json({ ok: true, board: await mirrorToBoard(id, b) });
}

/**
 * Carries an Admin edit back onto the planning board.
 *
 * Runs only after the `tasks` write has succeeded, and can never fail the
 * request: the edit is already live and in front of players by this point, so
 * reporting it as an error would be a lie about the thing that matters. A
 * failure here leaves the board and the live task list disagreeing, which is
 * exactly what `npm run ready` and the canvas's publish banner already detect
 * and report as pending drift -- so it surfaces, rather than being swallowed.
 *
 * Deliberately not done on create: a task added from Admin has no board entry,
 * and inventing one would put it under the planner's control and into the
 * canvas, which is a different decision from fixing a typo mid-event.
 *
 * @returns a short account of what was and was not carried, for the response.
 */
async function mirrorToBoard(taskId: string, body: Record<string, unknown>) {
  const { row, skipped } = boardMirrorPatch(body);
  const notes = skipped.map((s) => `${s.field}: ${s.why}`);
  if (!Object.keys(row).length) return { mirrored: false, reason: "nothing to carry", notes };

  try {
    const { data: task, error: readError } = await db()
      .from("tasks")
      .select("board_id")
      .eq("id", taskId)
      .maybeSingle();
    if (readError) return { mirrored: false, reason: readError.message, notes };
    // A task added from Admin was never on the board, so there is nothing to
    // diverge from and nothing to write.
    if (!task?.board_id) return { mirrored: false, reason: "this task is not on the board", notes };

    const { data, error } = await db()
      .from("task_board")
      .update({ ...row, updated_at: new Date().toISOString() })
      .eq("board_id", task.board_id)
      .select("board_id");
    if (error) return { mirrored: false, reason: error.message, notes };
    if (!data?.length) return { mirrored: false, reason: `no board entry ${task.board_id}`, notes };
    return { mirrored: true, boardId: task.board_id, notes };
  } catch (e) {
    // A missing task_board table on a project that has not run the migration
    // must not take Admin down with it.
    return { mirrored: false, reason: e instanceof Error ? e.message : String(e), notes };
  }
}

/**
 * Tasks with submissions are deactivated rather than deleted -- a hard delete
 * would cascade and silently destroy scored evidence.
 */
export async function DELETE(req: Request) {
  if (!(await isOrganizer())) return fail("Organizer PIN required.", 401);
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return fail("id required.");

  const { count } = await db()
    .from("submissions")
    .select("id", { count: "exact", head: true })
    .eq("task_id", id);

  if (count) {
    const { error } = await db().from("tasks").update({ active: false }).eq("id", id);
    if (error) return fail(error.message, 500);
    return json({ ok: true, deactivated: true, submissions: count });
  }

  const { error } = await db().from("tasks").delete().eq("id", id);
  if (error) return fail(error.message, 500);
  return json({ ok: true, deleted: true });
}
