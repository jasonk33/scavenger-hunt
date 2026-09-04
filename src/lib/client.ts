"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const KEY = "sh.player";

export type Me = { id: string; name: string };

export function getMe(): Me | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Me) : null;
  } catch {
    return null;
  }
}

export function setMe(me: Me | null) {
  if (me) localStorage.setItem(KEY, JSON.stringify(me));
  else localStorage.removeItem(KEY);
}

const SAVED_PREFIX = "sh.saved.";

/**
 * The tasks a player has starred to come back to.
 *
 * Deliberately local to the device rather than a table. A round puts far more
 * tasks in front of a guest than anyone can hold in their head, but the
 * shortlist is a private triage note rather than shared team state -- so it
 * needs no schema, no route and no poll, and a tap lands instantly instead of
 * at the next 5-second tick.
 *
 * Keyed by player id because one phone can change hands mid-event (the submit
 * page has a "pick a different name" flow). An unkeyed list would hand the new
 * player the previous one's picks.
 *
 * Task ids are per-round rows, so a Round 1 list simply stops matching anything
 * after the remix -- correct, since the second half is a different list. A task
 * cut mid-event (active = false) leaves an id here that never matches again, so
 * there is nothing to clean up.
 */
export function getSaved(playerId: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(SAVED_PREFIX + playerId);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x): x is string => typeof x === "string"));
  } catch {
    return new Set();
  }
}

export function setSaved(playerId: string, ids: Set<string>) {
  try {
    if (ids.size) localStorage.setItem(SAVED_PREFIX + playerId, JSON.stringify([...ids]));
    else localStorage.removeItem(SAVED_PREFIX + playerId);
  } catch {
    // A full or disabled store must not take the task list down with it: a star
    // that fails to persist is a far better outcome than a screen that throws.
  }
}

// Deliberately not under SAVED_PREFIX, or clearing every key with that prefix
// would take the record of the clear with it and the next poll would clear
// again -- deleting each star a second after it was tapped.
const EPOCH_KEY = "sh.savedEpoch";

/**
 * Throw away this device's shortlists when the organizer has reset the event.
 *
 * A reset deletes every submission, so a shortlist of tasks the team already
 * "did" is worse than no shortlist -- but the stars are localStorage and no
 * route can reach them. So the reset bumps `saved_epoch` in settings and each
 * phone clears itself the first time it polls a value it has not seen.
 *
 * A device with no stored marker adopts the current one WITHOUT clearing: on
 * the poll right after this shipped, every phone in the event would otherwise
 * decide the epoch was news and wipe a shortlist nothing had reset.
 *
 * Returns whether anything was actually cleared, so the caller can drop the set
 * it is rendering rather than wait for a state refresh to notice.
 */
export function syncSavedEpoch(epoch: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    const seen = localStorage.getItem(EPOCH_KEY);
    if (seen === epoch) return false;
    localStorage.setItem(EPOCH_KEY, epoch);
    if (seen === null) return false;

    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(SAVED_PREFIX)) localStorage.removeItem(key);
    }
    return true;
  } catch {
    return false;
  }
}

export async function api<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    cache: "no-store",
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string })?.error ?? `Request failed (${res.status})`);
  return body as T;
}

/** Narrows an unknown thrown value into something safe to show a person. */
export function errorMessage(e: unknown, fallback = "Something went wrong"): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string" && e) return e;
  return fallback;
}

/**
 * Polling instead of WebSockets or Supabase Realtime.
 *
 * A socket needs reconnect logic, and reconnect logic that has never been
 * exercised on a moving phone is exactly the thing that breaks on the day. A
 * 5-second poll cannot get stuck in a bad state: the next tick fixes it.
 *
 * Polling pauses while the tab is hidden and fires immediately on return, so a
 * phone in a pocket isn't making requests for 90 minutes.
 */
export function usePoll<T>(url: string | null, ms = 5000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const inflight = useRef(false);
  const generation = useRef(0);

  const load = useCallback(async () => {
    if (!url || inflight.current) return;
    const requestGeneration = generation.current;
    inflight.current = true;
    try {
      const d = await api<T>(url);
      if (requestGeneration !== generation.current) return;
      setData(d);
      setError(null);
    } catch (e) {
      if (requestGeneration !== generation.current) return;
      setError(errorMessage(e, "Network error"));
    } finally {
      if (requestGeneration === generation.current) {
        inflight.current = false;
        setLoading(false);
      }
    }
  }, [url]);

  useEffect(() => {
    generation.current += 1;
    inflight.current = false;
    // A changed URL is a new question. Do not briefly render the previous
    // round/team/task's answer while that request is on the way.
    setData(null);
    setError(null);
    if (!url) {
      setLoading(false);
      return;
    }
    setLoading(true);
    load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, ms);
    const onShow = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onShow);
    return () => {
      generation.current += 1;
      inflight.current = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onShow);
    };
  }, [url, ms, load]);

  return { data, error, loading, reload: load };
}

export function fmtBytes(b?: number | null) {
  if (!b) return "";
  if (b >= 1073741824) return (b / 1073741824).toFixed(2) + " GB";
  if (b >= 1048576) return (b / 1048576).toFixed(1) + " MB";
  return Math.round(b / 1024) + " KB";
}

/**
 * Readable text colour for a solid team-colour chip.
 *
 * Team colours are organizer-editable from a colour picker, so a pale pick is
 * possible and white-on-pale is unreadable. Compares the WCAG contrast of black
 * and white against the swatch and returns whichever wins, which guarantees at
 * least 4.58:1 for every possible colour -- a fixed lightness threshold does
 * not, and lands around 2.9:1 on mid-tones. Unparseable input falls back to
 * white, matching the old fixed behaviour.
 */
export function inkOn(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "#ffffff";
  const n = parseInt(m[1], 16);
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const l =
    0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  const onWhite = 1.05 / (l + 0.05);
  const onBlack = (l + 0.05) / 0.05;
  return onBlack > onWhite ? "#000000" : "#ffffff";
}
