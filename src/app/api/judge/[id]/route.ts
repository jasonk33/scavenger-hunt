import { db } from "@/lib/db";
import { isOrganizer } from "@/lib/settings";
import { json, fail } from "@/lib/http";
import type { Database } from "@/lib/database.types";

type SubmissionUpdate = Database["public"]["Tables"]["submissions"]["Update"];

export const dynamic = "force-dynamic";

/**
 * Record a judging decision.
 *
 * The awarded points come from `task_points`, which was snapshotted onto the row
 * when the submission was created. Editing a task's value later therefore cannot
 * retroactively rewrite scores that were already given.
 *
 * `reset` exists because live judging under time pressure produces misclicks, and
 * the fix has to be one tap, not a database session.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!(await isOrganizer())) return fail("Organizer PIN required.", 401);

  const { id } = await ctx.params;
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return fail("Malformed request body.");
  }

  const action = String(body?.action ?? "");
  const sb = db();

  const { data: existing } = await sb
    .from("submissions")
    .select("id,task_points,bonus,starred,status,round,team_id")
    .eq("id", id)
    .maybeSingle();
  if (!existing) return fail("Submission not found.", 404);

  let patch: SubmissionUpdate;

  /**
   * Optimistic concurrency, not a blanket "must be pending" rule.
   *
   * Two organizers judging at once are not occasionally colliding, they are
   * ALWAYS looking at the same oldest item -- so the second write has to be
   * refused or a decision silently disappears. But re-reviewing a call you got
   * wrong is a deliberate, wanted action.
   *
   * The client sends the status it believes the row is in. A stale judge sends
   * "pending" against an already-approved row and gets 409; a judge who opened
   * the item to change the ruling sends "approved" and is allowed through.
   * Defaults to "pending" so a caller that omits it keeps the strict behaviour.
   */
  const expected = String(body.expectedStatus ?? "pending");
  const guardConflict =
    existing.status !== expected
      ? fail(
          `That submission is now ${existing.status}, not ${expected}. Refresh to see the current decision.`,
          409
        )
      : null;

  if (action === "approve") {
    if (guardConflict) return guardConflict;
    const bonus = Math.min(2, Math.max(0, Math.round(Number(body.bonus ?? 0)) || 0));
    patch = {
      status: "approved",
      points_awarded: existing.task_points,
      bonus,
      starred: Boolean(body.starred ?? existing.starred),
      reject_reason: null,
      judged_at: new Date().toISOString(),
    };
  } else if (action === "reject") {
    if (guardConflict) return guardConflict;
    patch = {
      status: "rejected",
      points_awarded: null,
      bonus: 0,
      reject_reason: String(body.reason ?? "").slice(0, 200) || null,
      judged_at: new Date().toISOString(),
    };
  } else if (action === "star") {
    // Standalone toggle so an award candidate can be flagged without re-judging.
    patch = { starred: Boolean(body.starred) };
  } else if (action === "bonus") {
    patch = { bonus: Math.min(2, Math.max(0, Math.round(Number(body.bonus ?? 0)) || 0)) };
  } else if (action === "reset") {
    patch = {
      status: "pending",
      points_awarded: null,
      bonus: 0,
      reject_reason: null,
      judged_at: null,
    };
  } else if (action === "reassign") {
    // Someone tapped the wrong name on the join screen and their upload is
    // credited to the wrong team. Without this the only fix is editing the
    // database by hand, mid-event.
    //
    // The new team must belong to the SAME round as the submission, or the
    // points would land on a team that doesn't exist in that round's standings.
    const teamId = String(body.teamId ?? "");
    if (!teamId) return fail("teamId required.");
    const { data: team } = await sb
      .from("teams")
      .select("id,round")
      .eq("id", teamId)
      .maybeSingle();
    if (!team) return fail("Team not found.", 404);
    if (team.round !== existing.round) {
      return fail(`That team is in Round ${team.round}, but this is a Round ${existing.round} submission.`, 409);
    }
    patch = { team_id: teamId };
  } else {
    return fail("Unknown action.");
  }

  const { data, error } = await sb
    .from("submissions")
    // Re-assert the status we validated above so two simultaneous approvals
    // cannot both land; the loser gets 409 instead of overwriting.
    .update(patch)
    .eq("id", id)
    .eq("status", existing.status)
    .select("id,status,points_awarded,bonus,starred")
    .maybeSingle();

  if (error) return fail(error.message, 500);
  if (!data) return fail("Someone else just judged this one. Refresh to see the decision.", 409);
  return json({ ok: true, submission: data });
}
