"use client";

import { useState } from "react";
import { usePoll } from "@/lib/client";
import Score from "@/components/Score";
import { useEvent } from "@/components/EventShell";
import EvidenceVideo, { VideoScope } from "@/components/EvidenceVideo";

type Feed = {
  round: number;
  items: Array<{
    id: string;
    status: "approved" | "rejected";
    media: Array<{ id: string; url: string; isVideo: boolean }>;
    note: string | null;
    taskTitle: string;
    points: number;
    /** What the task was worth, and what the team earned on top of it. */
    basePoints: number;
    bonusPoints: number;
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
  const { data: event } = useEvent();
  const [round, setRound] = useState(0);
  const [filterPref, setFilterPref] = useState<(typeof FILTERS)[number]["key"]>("all");
  const { data, error } = usePoll<Feed>(round ? `/api/feed?round=${round}` : "/api/feed", 8000);
  const shown = round || data?.round || 1;
  const all = data?.items ?? [];
  const rejectedCount = all.filter((it) => it.status === "rejected").length;
  // The filter only appears while there is something to filter, so the choice is
  // derived rather than trusted: switching to a round with no rejections yet, or
  // a judge undoing the round's only rejection, would otherwise unmount the
  // control and leave the screen filtered to nothing with no way back.
  const filter = rejectedCount > 0 ? filterPref : "all";
  // Filter locally so switching doesn't need another request.
  const items = filter === "all" ? all : all.filter((it) => it.status === filter);

  return (
    <VideoScope key={`${shown}:${filter}`}>
      <h1>Feed</h1>

      <div className="row" style={{ flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
        <div className="seg">
          {[1, 2].filter((r) => r <= (event?.startedRound ?? 0)).map((r) => (
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
                onClick={() => setFilterPref(f.key)}
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
          <Post key={it.id} item={it} />
        ))}
      </div>
    </VideoScope>
  );
}

/** One judged submission. Several files are one post, because they were one
    thing the team did and one decision the judge made. */
function Post({ item: it }: { item: Feed["items"][number] }) {
  // Keep extra files behind a tap; each video is separately tap-to-load.
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? it.media : it.media.slice(0, 1);
  const hidden = it.media.length - shown.length;

  return (
          <div className="card" style={{ margin: 0 }}>
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
                  <Score base={it.basePoints} bonus={it.bonusPoints} push />
                )}
              </div>
              <div className="byline name muted tiny">{it.playerName}</div>
            </div>

            {/* Above the media, not below it: on a phone the card is about one
                photo tall, so a title underneath only gets read after scrolling
                past the thing it explains. */}
            <div style={{ margin: "0 0 8px", fontSize: 15, lineHeight: 1.35 }}>{it.taskTitle}</div>

            <div style={{ display: "grid", gap: 8 }}>
              {shown.map((m) => (
                <div className="media-box" key={m.id}>
                  {m.isVideo ? (
                    <EvidenceVideo url={m.url} />
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img className="media" src={m.url} alt={it.taskTitle} loading="lazy" />
                  )}
                </div>
              ))}
            </div>

            {hidden > 0 && (
              <button
                className="btn btn-sm btn-wide"
                style={{ marginTop: 8 }}
                onClick={() => setExpanded(true)}
              >
                Show {hidden} more {hidden === 1 ? "file" : "files"}
              </button>
            )}

            {(it.note || it.status === "rejected") && (
              <div className="stack" style={{ gap: 4, marginTop: 10 }}>
                {it.note && (
                  <div className="muted tiny" style={{ overflowWrap: "anywhere" }}>
                    “{it.note}”
                  </div>
                )}
                {it.status === "rejected" && (
                  <div className="muted tiny">{it.rejectReason || "Rejected"}</div>
                )}
              </div>
            )}
          </div>
  );
}
