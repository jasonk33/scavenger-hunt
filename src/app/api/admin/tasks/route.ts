import { db } from "@/lib/db";
import { isOrganizer } from "@/lib/settings";
import { json, fail } from "@/lib/http";
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
  return json({ ok: true });
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
