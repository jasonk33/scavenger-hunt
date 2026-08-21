import { db } from "@/lib/db";
import { isOrganizer } from "@/lib/settings";
import { json, fail } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * Teams are per-round rows: "The Flatiron Five" in Round 1 and in Round 2 are
 * two different rows, because the two rounds are scored as separate
 * competitions and membership changes at the break.
 *
 * A rename here is cosmetic and safe at any time -- submissions reference the
 * team by id, so renaming mid-event does not move a single point.
 */

export async function POST(req: Request) {
  if (!(await isOrganizer())) return fail("Organizer PIN required.", 401);
  const b = await req.json().catch(() => ({}));

  const name = String(b?.name ?? "").trim();
  const color = String(b?.color ?? "#666666").trim();
  if (!name) return fail("name required.");

  const sb = db();
  const { data: last } = await sb
    .from("teams")
    .select("sort_order")
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  const sort = Number(last?.sort_order ?? 0) + 10;

  // Created in BOTH rounds. A team that exists in only one round is almost
  // always a mistake, and the copy-roster-across-rounds tool matches by name.
  const { error } = await sb
    .from("teams")
    .upsert(
      [
        { round: 1, name, color, sort_order: sort },
        { round: 2, name, color, sort_order: sort },
      ],
      { onConflict: "round,name", ignoreDuplicates: true }
    );
  if (error) return fail(error.message, 500);
  return json({ ok: true });
}

/** Rename or recolour. Applies to both rounds' rows so they stay in step. */
export async function PATCH(req: Request) {
  if (!(await isOrganizer())) return fail("Organizer PIN required.", 401);
  const b = await req.json().catch(() => ({}));
  const id = String(b?.id ?? "");
  if (!id) return fail("id required.");

  const sb = db();
  const { data: team } = await sb.from("teams").select("id,name,round").eq("id", id).maybeSingle();
  if (!team) return fail("Team not found.", 404);

  const patch: { name?: string; color?: string } = {};
  if (typeof b.name === "string" && b.name.trim()) patch.name = b.name.trim();
  if (typeof b.color === "string" && b.color.trim()) patch.color = b.color.trim();
  if (!Object.keys(patch).length) return fail("Nothing to update.");

  // Update the matching row in the other round too, so the pair keeps the same
  // identity and "copy roster from the other round" keeps working.
  const { data: sibling } = await sb
    .from("teams")
    .select("id")
    .eq("round", team.round === 1 ? 2 : 1)
    .eq("name", team.name)
    .maybeSingle();

  const ids = [id, ...(sibling ? [sibling.id] : [])];
  const { error } = await sb.from("teams").update(patch).in("id", ids);
  if (error) {
    return fail(
      /duplicate|unique/i.test(error.message) ? "A team already has that name." : error.message,
      /duplicate|unique/i.test(error.message) ? 409 : 500
    );
  }
  return json({ ok: true, updated: ids.length });
}

export async function DELETE(req: Request) {
  if (!(await isOrganizer())) return fail("Organizer PIN required.", 401);
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return fail("id required.");

  const sb = db();
  const { count } = await sb
    .from("submissions")
    .select("id", { count: "exact", head: true })
    .eq("team_id", id);
  if (count) {
    return fail(`That team has ${count} submissions. Deleting it would delete those too.`, 409);
  }

  const { error } = await sb.from("teams").delete().eq("id", id);
  if (error) return fail(error.message, 500);
  return json({ ok: true });
}
