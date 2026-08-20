import { getSettings } from "@/lib/settings";
import { json } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET() {
  const s = await getSettings();
  return json({ notice: s.notice, round: s.active_round, open: s.submissions_open });
}
