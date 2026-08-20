import { setSetting, isOrganizer } from "@/lib/settings";
import { json, fail } from "@/lib/http";

export const dynamic = "force-dynamic";

const ALLOWED = new Set([
  "active_round",
  "submissions_open",
  "fallback_url",
  "event_name",
  "notice",
]);

export async function POST(req: Request) {
  if (!(await isOrganizer())) return fail("Organizer PIN required.", 401);
  const body = await req.json().catch(() => ({}));

  const entries = Object.entries(body ?? {}).filter(([k]) => ALLOWED.has(k));
  if (!entries.length) return fail("No recognized settings.");

  for (const [k, v] of entries) await setSetting(k, String(v));
  return json({ ok: true, updated: entries.map(([k]) => k) });
}
