import { cookies } from "next/headers";
import { db } from "./db";

type Settings = {
  active_round: number;
  submissions_open: boolean;
  event_name: string;
  /** Free-text banner shown on every screen. The organizer's broadcast channel. */
  notice: string;
};

const DEFAULTS: Settings = {
  active_round: 1,
  submissions_open: true,
  event_name: "Scavenger Hunt",
  notice: "",
};

export async function getSettings(): Promise<Settings> {
  const { data } = await db().from("settings").select("key,value");
  const map = new Map((data ?? []).map((r) => [r.key, r.value]));
  return {
    active_round: Number(map.get("active_round") ?? DEFAULTS.active_round) === 2 ? 2 : 1,
    submissions_open: (map.get("submissions_open") ?? "true") !== "false",
    event_name: String(map.get("event_name") || DEFAULTS.event_name),
    notice: String(map.get("notice") ?? ""),
  };
}

export async function setSetting(key: string, value: string) {
  await db().from("settings").upsert({ key, value }, { onConflict: "key" });
}

/**
 * Not a security boundary -- there is no cheating threat here. It exists so a
 * player who wanders into /judge cannot approve their own submissions by
 * accident, and so a shared phone left on the judge screen is not a live scoring
 * console.
 */
export async function isOrganizer(): Promise<boolean> {
  const pin = process.env.ORGANIZER_PIN;
  if (!pin) return true; // unset = wide open, for local development
  const jar = await cookies();
  return jar.get("organizer")?.value === pin;
}

export function checkPin(pin: string): boolean {
  const expected = process.env.ORGANIZER_PIN;
  if (!expected) return true;
  return pin === expected;
}

/**
 * The kill switch on /api/admin/reset, which deletes every submission and every
 * media file with no undo.
 *
 * The PIN is not a security boundary and never was, so it cannot be the only
 * thing between a mis-tap and 60 irreplaceable photos. This is deliberately an
 * environment variable rather than a setting: a setting lives in the same table
 * the Admin screen already writes, so the same wrong tap could turn it on and
 * then use it. Unset it in Vercel on the morning of the event and the button is
 * gone from Admin AND the route refuses -- the check is server-side, so hiding
 * the card is a convenience, not the guard.
 */
export function resetEnabled(): boolean {
  return /^(1|true|yes)$/i.test(process.env.ALLOW_RESET ?? "");
}
