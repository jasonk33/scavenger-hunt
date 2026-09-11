import { getSettings } from "@/lib/settings";
import { eventState } from "@/lib/event";
import { json } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET() {
  return json(eventState(await getSettings()));
}
