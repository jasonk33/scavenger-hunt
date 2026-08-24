import { db, groupMemberIds } from "@/lib/db";
import { isOrganizer } from "@/lib/settings";
import { cleanReason } from "@/lib/groups";
import { json, fail } from "@/lib/http";
import type { Database } from "@/lib/database.types";
import { effectivePoints } from "@/lib/scoring.mjs";

type SubmissionUpdate = Database["public"]["Tables"]["submissions"]["Update"];

export const dynamic = "force-dynamic";

/**
 * Record a judging decision.
 *
 * A submission is approved or rejected, and an approved one is worth exactly the
 * task's value -- there is no discretionary top-up. The value comes from
 * `task_points`, which was snapshotted onto the row when the submission was
 * created, so editing a task later cannot retroactively rewrite scores that were
 * already given.
 *
 * Re-approving an item that was already approved is a real decision, not a
 * no-op: it restamps judged_at, and `team_scores` counts the most recently
 * judged approval. That is how re-judging a re-submission at a task's new value
 * actually moves the score.
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
    .select("id,group_id,task_id,task_points,status,round,team_id,judged_at,measurement_value,scoring_mode_snapshot,measurement_threshold_snapshot,points_per_unit_snapshot,measurement_cap_snapshot,competition_bonus_snapshot")
    .eq("id", id)
    .maybeSingle();
  if (!existing) return fail("Submission not found.", 404);

  /*
   * A decision applies to every file in the group, not just the one the judge
   * happened to tap.
   *
   * Under once-per-team scoring, approving one photo of three and rejecting the
   * others would mean nothing -- the task still scores once at its best result.
   * So the set is the unit, and the write below covers all of it in a single
   * statement rather than a loop that could half-finish.
   *
   * A group of one -- every submission that predates this, and every ordinary
   * single-file upload -- resolves to `[id]` and behaves exactly as before.
   */
  const memberIds = await groupMemberIds(existing);
  if (!memberIds) {
    return fail("Couldn't read the rest of this submission just now. Try again.", 503);
  }

  const { data: task } = await sb
    .from("tasks")
    .select("id,points,scoring_mode,measurement_threshold,points_per_unit,measurement_cap,competition_bonus")
    .eq("id", existing.task_id)
    .maybeSingle();
  if (!task) return fail("Task not found.", 404);

  /*
   * Reassign bumps judged_at so the compare-and-swap below can tell two
   * concurrent edits apart -- but only when the row has already been judged.
   * Stamping judged_at on a still-pending row would mark it decided while its
   * status says otherwise.
   */
  const touch = (): SubmissionUpdate =>
    existing.judged_at === null ? {} : { judged_at: new Date().toISOString() };

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
    const rawMeasurement = body.measurementValue;
    const hasMeasurement =
      rawMeasurement !== null &&
      rawMeasurement !== undefined &&
      rawMeasurement !== "" &&
      !(typeof rawMeasurement === "string" && !rawMeasurement.trim());
    const measurementValue =
      task.scoring_mode === "fixed"
        ? null
        : hasMeasurement && Number.isInteger(Number(rawMeasurement)) && Number(rawMeasurement) >= 0
          ? Number(rawMeasurement)
          : null;
    const scoringRule = {
      ...task,
      points: existing.task_points,
      scoring_mode: existing.scoring_mode_snapshot ?? task.scoring_mode,
      measurement_threshold: existing.measurement_threshold_snapshot ?? task.measurement_threshold,
      points_per_unit: existing.points_per_unit_snapshot ?? task.points_per_unit,
      measurement_cap: existing.measurement_cap_snapshot ?? task.measurement_cap,
      competition_bonus: existing.competition_bonus_snapshot ?? task.competition_bonus,
    };
    if (scoringRule.scoring_mode !== "fixed" && measurementValue === null) {
      return fail(`Enter the ${scoringRule.scoring_mode === "competition" ? "current result" : "measured amount"} before approving.`);
    }
    patch = {
      status: "approved",
      points_awarded: effectivePoints(scoringRule, measurementValue),
      measurement_value: measurementValue,
      reject_reason: null,
      judged_at: new Date().toISOString(),
    };
  } else if (action === "reject") {
    if (guardConflict) return guardConflict;
    patch = {
      status: "rejected",
      points_awarded: null,
      measurement_value: null,
      // Free text: the judge types what actually went wrong. A fixed menu could
      // only ever cover the reasons we thought of in advance, and the team is
      // reading this to decide whether it is worth redoing the task.
      reject_reason: cleanReason(body.reason),
      judged_at: new Date().toISOString(),
    };
  } else if (action === "reset") {
    // Deliberately unguarded: "send it back to the queue" is valid from any
    // state, and it is the recovery action when two judges have collided.
    patch = {
      status: "pending",
      points_awarded: null,
      measurement_value: null,
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
    if (guardConflict) return guardConflict;
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
    patch = { team_id: teamId, ...touch() };
  } else {
    return fail("Unknown action.");
  }

  /*
   * Compare-and-swap on status AND judged_at.
   *
   * Status alone is not enough once re-review exists: two judges who both
   * reopen the same *approved* item and both approve are an approved -> approved
   * transition, so a status-only check matches for both and the second write
   * silently lands on top of the first. That matters even though both write the
   * same points, because judged_at is what decides which duplicate scores.
   * judged_at changes on every decision, so it distinguishes them.
   *
   * Applied to the whole group. The guard is what scopes it: only the members
   * actually sitting in the state this screen last saw are written. A file that
   * finished uploading a moment ago and joined the group late is simply not
   * matched -- the judge's decision still lands on everything they were looking
   * at, and the straggler comes back round as its own pending item rather than
   * turning the whole call into an error. Requiring every member to match would
   * have made that late arrival block the decision outright.
   */
  let write = sb.from("submissions").update(patch).in("id", memberIds).eq("status", existing.status);
  write =
    existing.judged_at === null
      ? write.is("judged_at", null)
      : write.eq("judged_at", existing.judged_at);

  const { data, error } = await write.select("id,status,points_awarded,reject_reason");

  if (error) return fail(error.message, 500);
  // Nothing matched: another organizer moved this out from under us. Unchanged
  // from the single-row behaviour, because a group is written in lockstep -- if
  // the row the judge tapped still matches, its siblings do too.
  if (!data || data.length === 0) {
    return fail("Someone else just judged this one. Refresh to see the decision.", 409);
  }
  const decided = data.find((r) => r.id === id) ?? data[0];
  return json({ ok: true, submission: decided, files: data.length });
}
