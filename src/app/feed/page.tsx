"use client";

import { useState } from "react";
import { usePoll } from "@/lib/client";

type Feed = {
  round: number;
  items: Array<{
    id: string;
    mediaUrl: string;
    isVideo: boolean;
    taskTitle: string;
    points: number;
    bonus: number;
    starred: boolean;
    teamName: string;
    teamColor: string;
    playerName: string;
  }>;
};

export default function FeedPage() {
  const [round, setRound] = useState(0);
  const { data, error } = usePoll<Feed>(round ? `/api/feed?round=${round}` : "/api/feed", 8000);
  const shown = round || data?.round || 1;
  const items = data?.items ?? [];

  return (
    <>
      <h1>Feed</h1>

      <div className="seg" style={{ marginBottom: 12 }}>
        {[1, 2].map((r) => (
          <button key={r} className={shown === r ? "on" : ""} onClick={() => setRound(r)}>
            Round {r}
          </button>
        ))}
      </div>

      {error && <div className="card card-bad tiny bad">Connection hiccup — retrying.</div>}

      {!data && !error && <p className="muted" style={{ marginTop: 16 }}>Loading…</p>}

      {data && items.length === 0 && (
        <div className="empty">
          <b>Nothing approved yet</b>
          Go do something stupid.
        </div>
      )}

      <div style={{ display: "grid", gap: 14 }}>
        {items.map((it) => (
          <div key={it.id} className="card" style={{ margin: 0 }}>
            <div className="row" style={{ marginBottom: 10 }}>
              <span className="swatch" style={{ background: it.teamColor }} />
              <b style={{ fontSize: 15 }}>{it.teamName}</b>
              <span className="muted tiny nowrap grow">{it.playerName}</span>
              <span className={`pill${it.starred ? " pill-warn" : ""}`}>
                {it.starred ? "⭐ " : ""}
                {it.points} pts
              </span>
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
          </div>
        ))}
      </div>
    </>
  );
}
