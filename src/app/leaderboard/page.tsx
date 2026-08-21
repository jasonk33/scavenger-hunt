"use client";

import { useState } from "react";
import { usePoll } from "@/lib/client";

type Board = {
  round: number;
  activeRound: number;
  totalPending: number;
  rows: Array<{
    teamId: string;
    name: string;
    color: string;
    points: number;
    tasksScored: number;
    pending: number;
  }>;
};

export default function LeaderboardPage() {
  const [round, setRound] = useState<number | null>(null);
  const { data, error } = usePoll<Board>(
    round ? `/api/leaderboard?round=${round}` : "/api/leaderboard",
    5000
  );

  const shown = round ?? data?.activeRound ?? 1;
  const rows = data?.rows ?? [];
  const lead = rows[0]?.points ?? 0;

  return (
    <>
      <h1>Scores</h1>

      <div className="row" style={{ marginBottom: 10 }}>
        <div className="seg">
          {[1, 2].map((r) => (
            <button key={r} className={shown === r ? "on" : ""} onClick={() => setRound(r)}>
              Round {r}
            </button>
          ))}
        </div>
        {data && data.totalPending > 0 && (
          // A team with a backlog is waiting, not losing. Saying so out loud stops
          // the "we're getting robbed" conversation before it starts.
          <span className="muted tiny push" style={{ textAlign: "right" }}>
            {data.totalPending} still with the judge
          </span>
        )}
      </div>

      {error && <div className="card card-bad tiny bad">Connection hiccup — retrying.</div>}

      {/* On a weak signal the first poll can take several seconds. Without this
          the two screens everyone watches sit completely blank under their
          heading, which reads as "the app is broken" rather than "it's loading". */}
      {!data && !error && <p className="muted" style={{ marginTop: 16 }}>Loading…</p>}

      <div className="stack">
        {rows.map((r) => {
          // Ties genuinely share the lead, so this highlights every team on the
          // top score rather than whichever one sorted first -- and they share a
          // position number too, so two tied teams don't read as 1st and 2nd.
          const top = lead > 0 && r.points === lead;
          const place = rows.findIndex((x) => x.points === r.points) + 1;
          return (
            <div key={r.teamId} className={`card card-flat${top ? " card-accent" : ""}`}>
              <div className="row">
                <span className={`rank${top ? " rank-1" : ""}`}>{place}</span>
                <span className="swatch swatch-lg" style={{ background: r.color }} />
                <div className="grow">
                  <div className="nowrap" style={{ fontWeight: 700 }}>
                    {r.name}
                  </div>
                  <div className="muted tiny">
                    {r.tasksScored} task{r.tasksScored === 1 ? "" : "s"}
                    {r.pending > 0 && ` · ${r.pending} pending`}
                  </div>
                </div>
                <span className="score">{r.points}</span>
              </div>
              <div className="bar" style={{ marginTop: 10, height: 6 }}>
                <i
                  style={{
                    width: lead > 0 ? `${(r.points / lead) * 100}%` : "0%",
                    background: r.color,
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>

      {data && rows.length === 0 && (
        <div className="empty">
          <b>No teams yet</b>
          Round {shown} hasn&apos;t been set up. An organizer can add teams on the Admin screen.
        </div>
      )}
    </>
  );
}
