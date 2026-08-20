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
