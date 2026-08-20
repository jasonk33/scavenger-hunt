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
  const { data } = usePoll<Feed>(round ? `/api/feed?round=${round}` : "/api/feed", 8000);
  const shown = round || data?.round || 1;

  return (
    <>
      <h1 style={{ fontSize: 26, margin: "18px 0 8px" }}>Feed</h1>

      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        {[1, 2].map((r) => (
          <button
            key={r}
            className={`btn btn-sm ${shown === r ? "btn-primary" : ""}`}
            onClick={() => setRound(r)}
          >
            Round {r}
          </button>
        ))}
      </div>

      {data && data.items.length === 0 && (
        <p className="muted">Nothing approved yet. Go do something stupid.</p>
      )}

      <div style={{ display: "grid", gap: 14 }}>
        {(data?.items ?? []).map((it) => (
          <div key={it.id} className="card" style={{ margin: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <span
                style={{ width: 10, height: 10, borderRadius: 2, background: it.teamColor }}
              />
              <b style={{ fontSize: 15 }}>{it.teamName}</b>
              <span className="muted tiny">{it.playerName}</span>
              <span className="pill" style={{ marginLeft: "auto" }}>
                {it.starred ? "⭐ " : ""}
                {it.points} pts
              </span>
            </div>

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

            <div className="tiny muted" style={{ marginTop: 8 }}>
              {it.taskTitle}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
