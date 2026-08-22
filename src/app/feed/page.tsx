"use client";

import { useState } from "react";
import { usePoll } from "@/lib/client";

type Feed = {
  round: number;
  items: Array<{
    id: string;
    status: "approved" | "rejected";
    mediaUrl: string;
    isVideo: boolean;
    taskTitle: string;
    points: number;
    bonus: number;
    starred: boolean;
    rejectReason: string | null;
    teamName: string;
    teamColor: string;
    playerName: string;
  }>;
};

const FILTERS = [
  { key: "all", label: "All" },
  { key: "approved", label: "Scored" },
  { key: "rejected", label: "Rejected" },
] as const;

export default function FeedPage() {
  const [round, setRound] = useState(0);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["key"]>("all");
  const { data, error } = usePoll<Feed>(round ? `/api/feed?round=${round}` : "/api/feed", 8000);
  const shown = round || data?.round || 1;
  const all = data?.items ?? [];
  // Filtered here rather than at the API so switching is instant and doesn't
  // re-download anything. It also cuts what renders, which is what actually
  // costs bandwidth -- videos load eagerly.
  const items = filter === "all" ? all : all.filter((it) => it.status === filter);
  const rejectedCount = all.filter((it) => it.status === "rejected").length;

  return (
    <>
      <h1>Feed</h1>

      <div className="row" style={{ flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
        <div className="seg">
          {[1, 2].map((r) => (
            <button key={r} className={shown === r ? "on" : ""} onClick={() => setRound(r)}>
              Round {r}
            </button>
          ))}
        </div>

        {/* Only worth the space once there is actually something rejected to
            filter out. */}
        {rejectedCount > 0 && (
          <div className="seg">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                className={filter === f.key ? "on" : ""}
                onClick={() => setFilter(f.key)}
              >
                {f.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {error && <div className="card card-bad tiny bad">Connection hiccup — retrying.</div>}

      {!data && !error && <p className="muted" style={{ marginTop: 16 }}>Loading…</p>}

      {data && items.length === 0 && (
        <div className="empty">
          <b>{filter === "rejected" ? "Nothing rejected yet" : "Nothing judged yet"}</b>
          {filter === "rejected" ? "Everyone's behaving." : "Go do something stupid."}
        </div>
      )}

      <div style={{ display: "grid", gap: 14 }}>
        {items.map((it) => (
          <div key={it.id} className="card" style={{ margin: 0 }}>
            <div className="cardhead">
              <div className="row">
                <span className="swatch" style={{ background: it.teamColor }} />
                <b className="name" style={{ fontSize: 15 }}>{it.teamName}</b>
                {/* A rejected card must never show a points pill. "0 pts"
                    sitting beside "3 pts" reads as a score that was earned and
                    came to nothing, rather than something that didn't count. */}
                {it.status === "rejected" ? (
                  <span className="pill pill-bad push">didn&apos;t count</span>
                ) : (
                  <span className={`pill push${it.starred ? " pill-warn" : ""}`}>
                    {it.starred ? "⭐ " : ""}
                    {it.points} pts
                  </span>
                )}
              </div>
              <div className="byline name muted tiny">{it.playerName}</div>
            </div>

            <div className="media-box">
              {it.isVideo ? (
                /* preload="auto" plus the #t=0.1 fragment forces iOS Safari to
                   render a real first frame instead of an untappable black box. */
                <video
                  className="media"
                  controls
                  playsInline
                  preload="auto"
                  src={`${it.mediaUrl}#t=0.1`}
                />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img className="media" src={it.mediaUrl} alt={it.taskTitle} loading="lazy" />
              )}
            </div>

            <div style={{ marginTop: 10, fontSize: 15, lineHeight: 1.35 }}>{it.taskTitle}</div>
            {it.status === "rejected" && (
              <div className="muted tiny" style={{ marginTop: 4 }}>
                {it.rejectReason || "Rejected"}
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
