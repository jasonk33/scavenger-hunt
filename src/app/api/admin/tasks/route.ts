import { db } from "@/lib/db";
import { isOrganizer } from "@/lib/settings";
import { json, fail } from "@/lib/http";
import type { Database } from "@/lib/database.types";

type TaskUpdate = Database["public"]["Tables"]["tasks"]["Update"];

export const dynamic = "force-dynamic";

/**
 * Admin and the planner canvas write the same rows. There is nothing to keep in
 * step and nothing to publish: an edit made here is what the canvas shows, and
 * an edit made there is what players see.
 */
export async function POST(req: Request) {
  if (!(await isOrganizer())) return fail("Organizer PIN required.", 401);
  const b = await req.json().catch(() => ({}));

  const round = Number(b?.round);
  const title = String(b?.title ?? "").trim();
  const points = Number(b?.points);
  if (b?.scoringMode !== undefined && !["fixed", "quantity", "competition"].includes(b.scoringMode)) {
    return fail("scoringMode must be fixed, quantity, or competition.");
  }
  const scoringMode = ["fixed", "quantity", "competition"].includes(b?.scoringMode)
    ? b.scoringMode
    : "fixed";
  const pointsPerUnit = Number.isInteger(Number(b?.pointsPerUnit)) ? Number(b.pointsPerUnit) : 0;
  const competitionBonus = Number.isInteger(Number(b?.competitionBonus))
    ? Number(b.competitionBonus)
    : 0;
  if (round !== 1 && round !== 2) return fail("round must be 1 or 2.");
  if (!title) return fail("title required.");
  if (!Number.isFinite(points) || points <= 0) return fail("points must be a positive number.");
  if (
    !Number.isInteger(pointsPerUnit) ||
    pointsPerUnit < 0 ||
    !Number.isInteger(competitionBonus) ||
    competitionBonus < 0
  ) {
    return fail("Scoring measurements must be non-negative whole numbers.");
  }

  // sort_order is generated from (is_secret, points, doc_order), so position is
  // set by choosing where in the planning order this lands -- last, here.
  const { data: last } = await db()
    .from("tasks")
    .select("doc_order")
    .eq("round", round)
    .order("doc_order", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data, error } = await db()
    .from("tasks")
    .insert({
      round,
      title,
      points,
      scoring_mode: scoringMode,
      measurement_label: String(b?.measurementLabel ?? "").trim(),
      points_per_unit: pointsPerUnit,
      competition_bonus: competitionBonus,
      requires_video: Boolean(b?.requiresVideo),
      is_secret: Boolean(b?.isSecret),
      doc_order: Number(last?.doc_order ?? 0) + 1,
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
 *
 * A secret challenge is two rows sharing a slug, so this splits the patch:
 * `revealed_at` and `winner_team_id` are per-round and land on the one row they
 * were given, everything else lands on every row of the task. A content edit
 * that moved only Round 1 would leave the two halves of the event reading
 * different wording for the same challenge, with nothing to notice it -- the
 * canvas shows the Round 1 row. A winner is the opposite: each half is its own
 * competition between different teams, so it must never cross rounds.
 */
export async function PATCH(req: Request) {
  if (!(await isOrganizer())) return fail("Organizer PIN required.", 401);
  const b = await req.json().catch(() => ({}));
  const id = String(b?.id ?? "");
  if (!id) return fail("id required.");

  const task: TaskUpdate = {};
  if (typeof b.title === "string" && b.title.trim()) task.title = b.title.trim();
  if (Number.isFinite(Number(b.points)) && Number(b.points) > 0) task.points = Number(b.points);
  if (["fixed", "quantity", "competition"].includes(b.scoringMode)) task.scoring_mode = b.scoringMode;
  // Moving a task off the leader bonus drops any winner with it, or the column
  // would keep quietly paying a bonus the task no longer has.
  if (task.scoring_mode && task.scoring_mode !== "competition") task.winner_team_id = null;
  if (typeof b.measurementLabel === "string") task.measurement_label = b.measurementLabel.trim();
  for (const [input, key] of [
    ["pointsPerUnit", "points_per_unit"],
    ["competitionBonus", "competition_bonus"],
  ]) {
    if (Number.isInteger(Number(b[input])) && Number(b[input]) >= 0) {
      Object.assign(task, { [key]: Number(b[input]) });
    }
  }
  if (typeof b.requiresVideo === "boolean") task.requires_video = b.requiresVideo;
  if (typeof b.isSecret === "boolean") task.is_secret = b.isSecret;
  if (typeof b.active === "boolean") task.active = b.active;

  const row: TaskUpdate = {};
  if (typeof b.revealed === "boolean") {
    row.revealed_at = b.revealed ? new Date().toISOString() : null;
  }
  // Clearing is a first-class action, not an omission: an organizer who picked
  // the wrong team has to be able to take it back, and `undefined` already means
  // "this request isn't about the winner".
  const clearsWinner = b.winnerTeamId === null || b.winnerTeamId === "";
  const setsWinner = typeof b.winnerTeamId === "string" && b.winnerTeamId !== "";
  if (clearsWinner) row.winner_team_id = null;

  if (!Object.keys(task).length && !Object.keys(row).length && !setsWinner) {
    return fail("Nothing to update.");
  }

  // Resolved before either branch, so a reveal on an id that does not exist is a
  // 404 rather than an `ok: true` that changed nothing. Admin renders the
  // response, so a silent success there is a Live badge for a reveal that never
  // happened -- the "screen claims a result it does not have" class.
  const { data: found } = await db()
    .from("tasks")
    .select("slug,is_secret,round,scoring_mode")
    .eq("id", id)
    .maybeSingle();
  if (!found) return fail("No such task.", 404);

  if (setsWinner) {
    // A foreign key can only say "some team". The bonus has to land on a team
    // that exists in THIS round, or it would be awarded to a team that is not in
    // the standings the task belongs to.
    const { data: team } = await db()
      .from("teams")
      .select("id,round")
      .eq("id", b.winnerTeamId)
      .maybeSingle();
    if (!team) return fail("Team not found.", 404);
    if (team.round !== found.round) {
      return fail(`That team is in Round ${team.round}, but this is a Round ${found.round} task.`, 409);
    }
    const mode = task.scoring_mode ?? found.scoring_mode;
    if (mode !== "competition") {
      return fail("Only a leader-bonus task has a winner to pick.");
    }
    row.winner_team_id = b.winnerTeamId;
  }

  if (Object.keys(task).length) {
    // Turning a secret into a normal task would leave two rows sharing a slug
    // with nothing marking them as one task, which `tasks_slug_solo_idx` refuses
    // outright. Say why here rather than surfacing a constraint name.
    if (found.is_secret && task.is_secret === false) {
      const { count } = await db()
        .from("tasks")
        .select("id", { count: "exact", head: true })
        .eq("slug", found.slug);
      if ((count ?? 0) > 1) {
        return fail(
          "This secret challenge is offered in both rounds, so it cannot become a normal task here. " +
            "Cut it and add a replacement in the planner instead."
        );
      }
    }

    const { error } = await db()
      .from("tasks")
      .update({ ...task, updated_at: new Date().toISOString() })
      .eq("slug", found.slug);
    if (error) return fail(error.message, 500);
  }

  // Last, so a failure here cannot land on top of a content write that already
  // succeeded and then report the whole thing as having done nothing.
  if (Object.keys(row).length) {
    const { error } = await db().from("tasks").update(row).eq("id", id);
    if (error) return fail(error.message, 500);
  }

  return json({ ok: true });
}

/**
 * Tasks with submissions are deactivated rather than deleted -- a hard delete
 * would cascade and silently destroy scored evidence.
 *
 * Scoped by slug, so a secret challenge goes from both rounds at once. Removing
 * it from one would leave the other half of the event still offering it, and the
 * planner would still show it as offered in both.
 */
export async function DELETE(req: Request) {
  if (!(await isOrganizer())) return fail("Organizer PIN required.", 401);
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return fail("id required.");

  const { data: found } = await db().from("tasks").select("slug").eq("id", id).maybeSingle();
  if (!found) return fail("No such task.", 404);

  const { data: rows, error: readError } = await db().from("tasks").select("id").eq("slug", found.slug);
  if (readError) return fail(readError.message, 500);
  // Never an empty list: `in("id", [])` matches nothing, so a failed read would
  // delete nothing and still report a deletion.
  const ids = rows?.length ? rows.map((r) => r.id) : [id];

  const { count } = await db()
    .from("submissions")
    .select("id", { count: "exact", head: true })
    .in("task_id", ids);

  if (count) {
    const { error } = await db().from("tasks").update({ active: false }).in("id", ids);
    if (error) return fail(error.message, 500);
    return json({ ok: true, deactivated: true, submissions: count });
  }

  const { error } = await db().from("tasks").delete().in("id", ids);
  if (error) return fail(error.message, 500);
  return json({ ok: true, deleted: true });
}
