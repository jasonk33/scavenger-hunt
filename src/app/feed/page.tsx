"use client";

import { useState } from "react";
import { usePoll } from "@/lib/client";

type Feed = {
  round: number;
  items: Array<{
    id: string;
    status: "approved" | "rejected";
    media: Array<{ id: string; url: string; isVideo: boolean }>;
    note: string | null;
    taskTitle: string;
    points: number;
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
  // Filtered here rather than at the API so switching is instant and doesn't
  // re-download anything. It also cuts what renders, which is what actually
  // costs bandwidth -- videos load eagerly.
  const items = filter === "all" ? all : all.filter((it) => it.status === filter);

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
    </>
  );
}

/** One judged submission. Several files are one post, because they were one
    thing the team did and one decision the judge made. */
function Post({ item: it }: { item: Feed["items"][number] }) {
  // Only the first file renders up front. Videos in this feed load eagerly --
  // preload="auto" is required or iOS shows an untappable black box -- so a
  // three-clip post that expanded on its own would cost three fetches from
  // every phone that merely scrolled past it.
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
                  <span className="pill push">{it.points} pts</span>
                )}
              </div>
              <div className="byline name muted tiny">{it.playerName}</div>
            </div>

            <div style={{ display: "grid", gap: 8 }}>
              {shown.map((m) => (
                <div className="media-box" key={m.id}>
                  {m.isVideo ? (
                    /* preload="auto" plus the #t=0.1 fragment forces iOS Safari
                       to render a real first frame instead of an untappable
                       black box. */
                    <video
                      className="media"
                      controls
                      playsInline
                      preload="auto"
                      src={`${m.url}#t=0.1`}
                    />
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

            <div style={{ marginTop: 10, fontSize: 15, lineHeight: 1.35 }}>{it.taskTitle}</div>
            {it.note && (
              <div className="muted tiny" style={{ marginTop: 4, overflowWrap: "anywhere" }}>
                “{it.note}”
              </div>
            )}
            {it.status === "rejected" && (
              <div className="muted tiny" style={{ marginTop: 4 }}>
                {it.rejectReason || "Rejected"}
              </div>
            )}
          </div>
  );
}
