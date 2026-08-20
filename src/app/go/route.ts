import { redirect } from "next/navigation";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

/**
 * The QR code target.
 *
 * Point every printed/shared QR code at /go rather than at /. If something needs
 * to move mid-event, set `fallback_url` in Admin and everyone who scans lands
 * somewhere else -- you cannot re-print 20 QR codes at 2pm.
 *
 * This only covers "the app is up but we want people elsewhere". For "the whole
 * deployment is down", the QR should encode a re-targetable short link that
 * points here, so the redirect itself survives the app.
 */
export async function GET() {
  const { fallback_url } = await getSettings();
  redirect(fallback_url && /^https?:\/\//i.test(fallback_url) ? fallback_url : "/");
}
