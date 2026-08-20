import { cookies } from "next/headers";
import { db } from "./db";
import type { Settings } from "./types";

const DEFAULTS: Settings = {
  active_round: 1,
  submissions_open: true,
  fallback_url: "",
  event_name: "Scavenger Hunt",
  notice: "",
};

export async function getSettings(): Promise<Settings> {
  const { data } = await db().from("settings").select("key,value");
  const map = new Map((data ?? []).map((r) => [r.key, r.value]));
  return {
    active_round: Number(map.get("active_round") ?? DEFAULTS.active_round) === 2 ? 2 : 1,
    submissions_open: (map.get("submissions_open") ?? "true") !== "false",
    fallback_url: String(map.get("fallback_url") ?? ""),
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
