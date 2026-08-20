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
    .select("id,task_points,bonus,starred,status")
    .eq("id", id)
    .maybeSingle();
  if (!existing) return fail("Submission not found.", 404);

  let patch: SubmissionUpdate;

  if (action === "approve") {
    // Guard on `pending`: two organizers judging at once are not occasionally
    // colliding, they are ALWAYS looking at the same oldest item. Without this,
    // whoever writes second silently overwrites the first decision and the
    // points disappear with no trace on any screen.
    if (existing.status !== "pending") {
      return fail("Someone already judged this one. Refresh to see the decision.", 409);
    }
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
    if (existing.status !== "pending") {
      return fail("Someone already judged this one. Refresh to see the decision.", 409);
    }
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
