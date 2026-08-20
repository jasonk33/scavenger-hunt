import { db } from "@/lib/db";
import { isOrganizer } from "@/lib/settings";
import { json, fail } from "@/lib/http";

export const dynamic = "force-dynamic";

/** Add players. Accepts one name or a pasted list, one per line. */
export async function POST(req: Request) {
  if (!(await isOrganizer())) return fail("Organizer PIN required.", 401);
  const body = await req.json().catch(() => ({}));

  const names = String(body?.names ?? body?.name ?? "")
    .split(/[\n,]/)
    .map((n) => n.trim())
    .filter(Boolean);
  if (!names.length) return fail("No names given.");

  const { error } = await db()
    .from("players")
    .upsert(
      names.map((name) => ({ name })),
      { onConflict: "name", ignoreDuplicates: true }
    );
  if (error) return fail(error.message, 500);

  return json({ ok: true, added: names.length });
}

export async function DELETE(req: Request) {
  if (!(await isOrganizer())) return fail("Organizer PIN required.", 401);
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return fail("id required.");

  const { count } = await db()
    .from("submissions")
    .select("id", { count: "exact", head: true })
    .eq("player_id", id);
  if (count) return fail(`That player has ${count} submissions. Removing them would delete those too.`, 409);

  const { error } = await db().from("players").delete().eq("id", id);
  if (error) return fail(error.message, 500);
  return json({ ok: true });
}
