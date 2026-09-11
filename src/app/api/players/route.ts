import { db } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { json, fail } from "@/lib/http";
import { eventState } from "@/lib/event";

export const dynamic = "force-dynamic";

/** Name list for the Join screen, annotated with each player's team this round. */
export async function GET() {
  const settings = await getSettings();
  const sb = db();

  const [{ data: players, error: playersError }, { data: roster, error: rosterError }, { data: teams, error: teamsError }] = await Promise.all([
    sb.from("players").select("id,name").order("name"),
    sb.from("roster").select("player_id,team_id").eq("round", settings.active_round),
    sb.from("teams").select("id,name,color").eq("round", settings.active_round),
  ]);
  if (playersError || rosterError || teamsError) return fail("Couldn't load players and teams. Try again.", 503);

  const teamById = new Map((teams ?? []).map((t) => [t.id, t]));
  const teamOf = new Map((roster ?? []).map((r) => [r.player_id, teamById.get(r.team_id)]));

  return json({
    eventName: settings.event_name,
    event: eventState(settings),
    players: (players ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      team: teamOf.get(p.id) ?? null,
    })),
  });
}
