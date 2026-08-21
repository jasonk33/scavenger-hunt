"use client";

import { useEffect, useState } from "react";

/**
 * The organizer's broadcast line. Set it in Admin and it appears at the top of
 * every screen within 15 seconds -- "secret challenge is live", "round ends in
 * 10 minutes", "stop uploading, come back". Cheaper and more reliable than
 * trying to text 20 people mid-event.
 */
export default function Notice() {
  const [text, setText] = useState("");

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch("/api/notice", { cache: "no-store" });
        const j = await r.json();
        if (alive) setText(String(j?.notice ?? ""));
      } catch {
        /* a missed poll is not worth surfacing */
      }
    };
    load();
    const t = setInterval(load, 15000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (!text) return null;

  return (
    <div className="notice">
      <span className="notice-dot" aria-hidden="true" />
      <span>{text}</span>
    </div>
  );
}
