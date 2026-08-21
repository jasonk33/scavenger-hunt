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

  const load = useCallback(async () => {
    if (!url || inflight.current) return;
    inflight.current = true;
    try {
      const d = await api<T>(url);
      setData(d);
      setError(null);
    } catch (e) {
      setError(errorMessage(e, "Network error"));
    } finally {
      inflight.current = false;
      setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    if (!url) {
      setLoading(false);
      return;
    }
    load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, ms);
    const onShow = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onShow);
    return () => {
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
