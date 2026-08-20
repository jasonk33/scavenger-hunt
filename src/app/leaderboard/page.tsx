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
      <h1 style={{ fontSize: 26, margin: "18px 0 8px" }}>Scores</h1>

      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
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

      {error && <div className="card bad tiny">Connection hiccup — retrying.</div>}

      {/* A team with a backlog is waiting, not losing. Saying so out loud stops
          the "we're getting robbed" conversation before it starts. */}
      {data && data.totalPending > 0 && (
        <p className="muted tiny" style={{ marginTop: 0 }}>
          {data.totalPending} submission{data.totalPending === 1 ? "" : "s"} still with the judge.
        </p>
      )}

      <div style={{ display: "grid", gap: 8 }}>
        {rows.map((r, i) => (
          <div key={r.teamId} className="card" style={{ margin: 0, padding: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ width: 22, fontWeight: 700, color: "var(--muted)" }}>{i + 1}</span>
              <span
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: 3,
                  background: r.color,
                  flexShrink: 0,
                }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis" }}>
                  {r.name}
                </div>
                <div className="muted tiny">
                  {r.tasksScored} task{r.tasksScored === 1 ? "" : "s"}
                  {r.pending > 0 && ` · ${r.pending} pending`}
                </div>
              </div>
              <div style={{ fontSize: 28, fontWeight: 800 }}>{r.points}</div>
            </div>
            <div className="bar" style={{ marginTop: 8, height: 6 }}>
              <i
                style={{
                  width: lead > 0 ? `${(r.points / lead) * 100}%` : "0%",
                  background: r.color,
                }}
              />
            </div>
          </div>
        ))}
      </div>

      {data && rows.length === 0 && <p className="muted">No teams set up for this round yet.</p>}
    </>
  );
}
