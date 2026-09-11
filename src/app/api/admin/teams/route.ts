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

  // Start with a row in each round; their names and colours can then diverge.
  // The copy-roster tool only applies while team names still match.
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

/** Rename or recolour only the selected round's team. */
export async function PATCH(req: Request) {
  if (!(await isOrganizer())) return fail("Organizer PIN required.", 401);
  const b = await req.json().catch(() => ({}));
  const id = String(b?.id ?? "");
  if (!id) return fail("id required.");

  const sb = db();
  const { data: team } = await sb.from("teams").select("id").eq("id", id).maybeSingle();
  if (!team) return fail("Team not found.", 404);

  const patch: { name?: string; color?: string } = {};
  if (typeof b.name === "string" && b.name.trim()) patch.name = b.name.trim();
  if (typeof b.color === "string" && b.color.trim()) patch.color = b.color.trim();
  if (!Object.keys(patch).length) return fail("Nothing to update.");

  const { error } = await sb.from("teams").update(patch).eq("id", id);
  if (error) {
    return fail(
      /duplicate|unique/i.test(error.message) ? "A team already has that name." : error.message,
      /duplicate|unique/i.test(error.message) ? 409 : 500
    );
  }
  return json({ ok: true, updated: 1 });
}

/**
 * Deletes the team wherever the same name appears, matching POST.
 *
 * A still-matching pair is removed together. Teams renamed independently are
 * no longer a pair and are deleted individually.
 */
export async function DELETE(req: Request) {
  if (!(await isOrganizer())) return fail("Organizer PIN required.", 401);
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return fail("id required.");

  const sb = db();
  const { data: team, error: teamError } = await sb.from("teams").select("id,name").eq("id", id).maybeSingle();
  if (teamError) return fail("Couldn't load that team. Try again.", 503);
  if (!team) return fail("Team not found.", 404);

  const { data: pair, error: pairError } = await sb.from("teams").select("id").eq("name", team.name);
  if (pairError) return fail("Couldn't load the matching teams. Try again.", 503);
  const ids = (pair ?? []).map((t) => t.id);
  if (!ids.length) return fail("Team not found.", 404);

  const { count, error: countError } = await sb
    .from("submissions")
    .select("id", { count: "exact", head: true })
    .in("team_id", ids);
  if (countError || count === null) return fail("Couldn't check that team's submissions. Try again.", 503);
  if (count) {
    return fail(`"${team.name}" has ${count} submission(s). Deleting it would delete those too.`, 409);
  }

  // roster.team_id cascades, so members are silently unassigned. Say so rather
  // than letting players discover it when they cannot submit.
  const { count: rostered, error: rosterError } = await sb
    .from("roster")
    .select("player_id", { count: "exact", head: true })
    .in("team_id", ids);
  if (rosterError || rostered === null) return fail("Couldn't check that team's roster. Try again.", 503);

  const { error } = await sb.from("teams").delete().in("id", ids);
  if (error) return fail(error.message, 500);
  return json({ ok: true, deleted: ids.length, unassigned: rostered ?? 0 });
}
