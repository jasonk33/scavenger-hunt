import { db } from "@/lib/db";
import { isOrganizer } from "@/lib/settings";
import { json, fail } from "@/lib/http";
import type { Database } from "@/lib/database.types";
import { SCORING_MODES } from "@/lib/scoring.mjs";

type TaskUpdate = Database["public"]["Tables"]["tasks"]["Update"];

export const dynamic = "force-dynamic";

const EDITABLE = ["title", "points", "scoringMode", "measurementLabel", "pointsPerUnit", "active"];

function invalidInput(body: Record<string, unknown>, creating = false) {
  const allowed = [...EDITABLE, creating ? "round" : "id"];
  if (Object.keys(body).some((key) => !allowed.includes(key))) return "Unsupported task field.";
  if (body.scoringMode !== undefined &&
    (typeof body.scoringMode !== "string" || !SCORING_MODES.includes(body.scoringMode))) {
    return "scoringMode must be fixed or quantity.";
  }
}

/**
 * Admin and the planner canvas write the same rows. There is nothing to keep in
 * step and nothing to publish: an edit made here is what the canvas shows, and
 * an edit made there is what players see.
 */
export async function POST(req: Request) {
  if (!(await isOrganizer())) return fail("Organizer PIN required.", 401);
  const b = await req.json().catch(() => ({}));
  const invalid = invalidInput(b ?? {}, true);
  if (invalid) return fail(invalid);

  const round = Number(b?.round);
  const title = String(b?.title ?? "").trim();
  const points = Number(b?.points);
  const scoringMode = b?.scoringMode ?? "fixed";
  const pointsPerUnit = Number.isInteger(Number(b?.pointsPerUnit)) ? Number(b.pointsPerUnit) : 0;
  if (round !== 1 && round !== 2) return fail("round must be 1 or 2.");
  if (!title) return fail("title required.");
  if (!Number.isFinite(points) || points <= 0) return fail("points must be a positive number.");
  if (!Number.isInteger(pointsPerUnit) || pointsPerUnit < 0) {
    return fail("Scoring measurements must be non-negative whole numbers.");
  }

  // Display order is generated; new tasks land last in the planning order.
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
      doc_order: Number(last?.doc_order ?? 0) + 1,
    })
    .select("id")
    .single();

  if (error) return fail(error.message, 500);
  return json({ ok: true, id: data.id });
}

/** Apply only the fields deliberately edited, scoped by the stable slug. */
export async function PATCH(req: Request) {
  if (!(await isOrganizer())) return fail("Organizer PIN required.", 401);
  const b = await req.json().catch(() => ({}));
  const invalid = invalidInput(b ?? {});
  if (invalid) return fail(invalid);
  const id = String(b?.id ?? "");
  if (!id) return fail("id required.");

  const task: TaskUpdate = {};
  if (typeof b.title === "string" && b.title.trim()) task.title = b.title.trim();
  if (Number.isFinite(Number(b.points)) && Number(b.points) > 0) task.points = Number(b.points);
  if (SCORING_MODES.includes(b.scoringMode)) task.scoring_mode = b.scoringMode;
  if (typeof b.measurementLabel === "string") task.measurement_label = b.measurementLabel.trim();
  if (Number.isInteger(Number(b.pointsPerUnit)) && Number(b.pointsPerUnit) >= 0) {
    task.points_per_unit = Number(b.pointsPerUnit);
  }
  if (typeof b.active === "boolean") task.active = b.active;

  if (!Object.keys(task).length) {
    return fail("Nothing to update.");
  }

  const { data: found, error: readError } = await db()
    .from("tasks")
    .select("slug")
    .eq("id", id)
    .eq("is_secret", false)
    .maybeSingle();
  if (readError) return fail("Couldn't load that task. Try again.", 503);
  if (!found) return fail("No such task.", 404);

  const { error } = await db()
    .from("tasks")
    .update({ ...task, updated_at: new Date().toISOString() })
    .eq("slug", found.slug)
    .eq("is_secret", false);
  if (error) return fail(error.message, 500);

  return json({ ok: true });
}

/**
 * Cutting a task always deactivates it. Never hard-delete a row that evidence
 * can reference, including evidence arriving after a submission-count check.
 */
export async function DELETE(req: Request) {
  if (!(await isOrganizer())) return fail("Organizer PIN required.", 401);
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return fail("id required.");

  const { data: found, error: readError } = await db().from("tasks").select("slug").eq("id", id).maybeSingle();
  if (readError) return fail("Couldn't load that task. Try again.", 503);
  if (!found) return fail("No such task.", 404);

  const { error } = await db().from("tasks").update({ active: false }).eq("slug", found.slug);
  if (error) return fail(error.message, 500);
  return json({ ok: true, deactivated: true });
}
