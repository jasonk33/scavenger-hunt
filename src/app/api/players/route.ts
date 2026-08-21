import { db } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { json } from "@/lib/http";

export const dynamic = "force-dynamic";

/** Name list for the Join screen, annotated with each player's team this round. */
export async function GET() {
  const settings = await getSettings();
  const sb = db();

  const [{ data: players }, { data: roster }, { data: teams }] = await Promise.all([
    sb.from("players").select("id,name").order("name"),
    sb.from("roster").select("player_id,team_id").eq("round", settings.active_round),
    sb.from("teams").select("id,name,color").eq("round", settings.active_round),
  ]);

  const teamById = new Map((teams ?? []).map((t) => [t.id, t]));
  const teamOf = new Map((roster ?? []).map((r) => [r.player_id, teamById.get(r.team_id)]));

  return json({
    round: settings.active_round,
    eventName: settings.event_name,
    players: (players ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      team: teamOf.get(p.id) ?? null,
    })),
  });
}
