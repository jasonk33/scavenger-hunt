"use client";

import { useState } from "react";
import Score from "./Score";

export type EvidenceEntry = {
  id: string;
  taskTitle?: string;
  /** What the task was worth, and what the team earned on top of it. */
  basePoints: number;
  bonusPoints: number;
  media: Array<{ id: string; url: string; isVideo: boolean }>;
  note: string | null;
  teamId: string;
  teamName: string;
  teamColor: string;
  playerName: string;
};

/**
 * Read-only view of one approved piece of evidence. A group can contain several
 * files, but only its first file loads until someone asks to see the rest.
 */
export default function EvidenceEntryCard({
  entry,
  showTask = false,
}: {
  entry: EvidenceEntry;
  showTask?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? entry.media : entry.media.slice(0, 1);
  const hidden = entry.media.length - shown.length;

  return (
    <div className="card card-flat" style={{ margin: 0 }}>
      <div className="cardhead">
        <div className="row">
          <span className="swatch" style={{ background: entry.teamColor }} />
          <b className="name" style={{ fontSize: 15 }}>{entry.teamName}</b>
          <Score base={entry.basePoints} bonus={entry.bonusPoints} tone="pill-good" check push />
        </div>
        <div className="byline name muted tiny">{entry.playerName}</div>
      </div>

      <div style={{ display: "grid", gap: 8 }}>
        {shown.map((m) => (
          <div className="media-box" key={m.id}>
            {m.isVideo ? (
              <video
                className="media"
                controls
                playsInline
                preload="auto"
                src={`${m.url}#t=0.1`}
              />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                className="media"
                src={m.url}
                alt={entry.taskTitle ?? "Scored entry"}
                loading="lazy"
              />
            )}
          </div>
        ))}
      </div>

      {hidden > 0 && (
        <button
          className="btn btn-sm btn-wide"
          style={{ marginTop: 8 }}
          onClick={() => setExpanded(true)}
          aria-expanded={expanded}
        >
          Show {hidden} more {hidden === 1 ? "file" : "files"}
        </button>
      )}

      {showTask && entry.taskTitle && (
        <div style={{ marginTop: 10, fontSize: 15, lineHeight: 1.35 }}>{entry.taskTitle}</div>
      )}
      {entry.note && (
        <div className="muted tiny" style={{ marginTop: 4, overflowWrap: "anywhere" }}>
          “{entry.note}”
        </div>
      )}
    </div>
  );
}
