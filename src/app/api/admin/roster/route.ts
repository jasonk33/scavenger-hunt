import { db } from "@/lib/db";
import { isOrganizer } from "@/lib/settings";
import { json, fail } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * Assign a player to a team for one round. This IS the remix: at the break the
 * organizer edits Round 2 assignments and nothing else changes. Round 1
 * submissions already carry their team on the row, so their scores cannot move.
 */
export async function POST(req: Request) {
  if (!(await isOrganizer())) return fail("Organizer PIN required.", 401);
  const body = await req.json().catch(() => ({}));

  const round = Number(body?.round);
  if (round !== 1 && round !== 2) return fail("round must be 1 or 2.");

  const entries: Array<{ playerId: string; teamId: string | null }> = Array.isArray(body?.entries)
    ? body.entries
    : [{ playerId: body?.playerId, teamId: body?.teamId ?? null }];

  const sb = db();
  const toSet = entries
    .filter((e): e is { playerId: string; teamId: string } => Boolean(e.playerId && e.teamId))
    .map((e) => ({ round, player_id: e.playerId, team_id: e.teamId }));
  const toClear = entries.filter((e) => e.playerId && !e.teamId).map((e) => e.playerId);

  if (toSet.length) {
    // Teams are per-round rows. Assigning a player to a team from the OTHER
    // round would attribute their submissions to a team that doesn't exist in
    // this round's standings, and the score would silently vanish.
    const { data: valid } = await sb
      .from("teams")
      .select("id")
      .eq("round", round)
      .in("id", toSet.map((e) => e.team_id));
    const allowed = new Set((valid ?? []).map((t) => t.id));
    const bad = toSet.filter((e) => !allowed.has(e.team_id));
    if (bad.length) return fail(`Those teams don't belong to Round ${round}.`, 409);

    const { error } = await sb.from("roster").upsert(toSet, { onConflict: "round,player_id" });
    if (error) return fail(error.message, 500);
  }

  if (toClear.length) {
    const { error } = await sb
      .from("roster")
      .delete()
      .eq("round", round)
      .in("player_id", toClear);
    if (error) return fail(error.message, 500);
  }

  return json({ ok: true, updated: entries.length });
}

/**
 * Copy one round's assignments to the other. The remix is usually a few swaps
 * off the Round 1 layout, not a blank slate -- doing it by hand for 20 people at
 * 3:25pm is how mistakes get made.
 */
export async function PUT(req: Request) {
  if (!(await isOrganizer())) return fail("Organizer PIN required.", 401);
  const { from, to } = await req.json().catch(() => ({}));
  if (![1, 2].includes(Number(from)) || ![1, 2].includes(Number(to)) || from === to) {
    return fail("from and to must be 1 and 2.");
  }

  const sb = db();
  const [{ data: src }, { data: srcTeams }, { data: dstTeams }] = await Promise.all([
    sb.from("roster").select("player_id,team_id").eq("round", from),
    sb.from("teams").select("id,name").eq("round", from),
    sb.from("teams").select("id,name").eq("round", to),
  ]);

  // Teams are per-round rows, so map across by name.
  const srcName = new Map((srcTeams ?? []).map((t) => [t.id, t.name]));
  const dstId = new Map((dstTeams ?? []).map((t) => [t.name, t.id]));

  const rows = (src ?? [])
    .map((r) => ({
      round: to as number,
      player_id: r.player_id,
      team_id: dstId.get(srcName.get(r.team_id) ?? ""),
    }))
    .filter((r): r is { round: number; player_id: string; team_id: string } => Boolean(r.team_id));

  if (!rows.length) return json({ ok: true, copied: 0 });

  const { error } = await sb.from("roster").upsert(rows, { onConflict: "round,player_id" });
  if (error) return fail(error.message, 500);
  return json({ ok: true, copied: rows.length });
}
