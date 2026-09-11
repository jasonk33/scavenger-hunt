import { getSettings, isOrganizer } from "@/lib/settings";
import { db } from "@/lib/db";
import { eventState, eventTransition, type EventSettings } from "@/lib/event";
import { json, fail } from "@/lib/http";

export const dynamic = "force-dynamic";

const ALLOWED = new Set([
  "active_round",
  "started_round",
  "submissions_open",
  "event_name",
  "notice",
]);

export async function POST(req: Request) {
  if (!(await isOrganizer())) return fail("Organizer PIN required.", 401);
  const body = await req.json().catch(() => ({}));
  if (!body || typeof body !== "object" || Array.isArray(body)) return fail("Invalid settings.");

  if ("event_action" in body) {
    const settings = await getSettings();
    if (body.expected_phase !== eventState(settings).phase) {
      return fail("The event has moved on. Refresh and try again.", 409);
    }
    let next: EventSettings;
    try {
      next = eventTransition(settings, String(body.event_action));
    } catch {
      return fail("That action isn't available at this stage. Refresh and try again.", 409);
    }
    // Recheck under the database lock: a delayed earlier request must not
    // overwrite a later transition after passing the optimistic check above.
    const { data, error } = await db().rpc("transition_event", {
      expected_active_round: settings.active_round,
      expected_started_round: settings.started_round,
      expected_submissions_open: settings.submissions_open,
      next_active_round: next.active_round,
      next_started_round: next.started_round,
      next_submissions_open: next.submissions_open,
    });
    if (error) return fail("Couldn't change the event stage. Try again.", 503);
    if (data === "stale") return fail("The event has moved on. Refresh and try again.", 409);
    if (data === "uploading") {
      return fail("Round 1 still has an upload in progress. Let it finish or recover it in Health before revealing the new teams.", 409);
    }
    if (data !== "ok") return fail("Couldn't confirm the event stage. Refresh and try again.", 503);
    return json({ ok: true, updated: Object.keys(next) });
  }

  const entries = Object.entries(body).filter(([k]) => ALLOWED.has(k));
  if (!entries.length) return fail("No recognized settings.");
  for (const [key, value] of entries) {
    if (key === "active_round" && !["1", "2"].includes(String(value))) return fail("Round must be 1 or 2.");
    if (key === "started_round" && !["0", "1", "2"].includes(String(value))) return fail("Started round must be 0, 1 or 2.");
    if (key === "submissions_open" && !["true", "false"].includes(String(value))) return fail("Submissions must be open or closed.");
  }

  // One statement: readers must never see the new roster with the old open flag.
  const { error } = await db().from("settings").upsert(
    entries.map(([key, value]) => ({ key, value: String(value) })), { onConflict: "key" },
  );
  if (error) return fail("Couldn't save event settings. Try again.", 503);
  return json({ ok: true, updated: entries.map(([k]) => k) });
}
