"use client";

import { useState } from "react";
import { usePoll } from "@/lib/client";
import EvidenceEntryCard, { type EvidenceEntry } from "@/components/EvidenceEntry";

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

type TeamDetail = {
  round: number;
  team: { id: string; name: string; color: string };
  entries: EvidenceEntry[];
};

export default function LeaderboardPage() {
  const [round, setRound] = useState<number | null>(null);
  const [expandedTeamId, setExpandedTeamId] = useState<string | null>(null);
  const { data, error } = usePoll<Board>(
    round ? `/api/leaderboard?round=${round}` : "/api/leaderboard",
    5000
  );

  const shown = round ?? data?.activeRound ?? 1;
  const {
    data: teamDetail,
    error: teamDetailError,
  } = usePoll<TeamDetail>(
    expandedTeamId ? `/api/leaderboard/${expandedTeamId}?round=${shown}` : null,
    5000
  );
  const rows = data?.rows ?? [];
  const lead = rows[0]?.points ?? 0;

  return (
    <>
      <h1>Scores</h1>

      <div className="row" style={{ marginBottom: 10 }}>
        <div className="seg">
          {[1, 2].map((r) => (
            <button
              key={r}
              className={shown === r ? "on" : ""}
              onClick={() => {
                setRound(r);
                setExpandedTeamId(null);
              }}
            >
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
          const expanded = expandedTeamId === r.teamId;
          const details =
            expanded && teamDetail?.round === shown && teamDetail.team.id === r.teamId ? teamDetail : null;
          return (
            <div key={r.teamId} className={`card card-flat${top ? " card-accent" : ""}`}>
              <button
                type="button"
                className="btn-plain row"
                style={{ width: "100%", minHeight: 44 }}
                onClick={() => setExpandedTeamId((current) => (current === r.teamId ? null : r.teamId))}
                aria-expanded={expanded}
                aria-controls={`entries-${r.teamId}`}
                title={expanded ? "Hide scored entries" : "Show scored entries"}
              >
                <span className={`rank${top ? " rank-1" : ""}`}>{place}</span>
                <span className="swatch swatch-lg" style={{ background: r.color }} />
                <div className="grow">
                  <div className="name" style={{ fontWeight: 700 }}>
                    {r.name}
                  </div>
                  <div className="muted tiny">
                    {r.tasksScored} task{r.tasksScored === 1 ? "" : "s"}
                    {r.pending > 0 && ` · ${r.pending} pending`}
                  </div>
                </div>
                <span className="score">{r.points}</span>
                <span className="muted tiny" aria-hidden="true">{expanded ? "▲" : "▼"}</span>
              </button>
              <div className="bar" style={{ marginTop: 10, height: 6 }}>
                <i
                  style={{
                    width: lead > 0 ? `${(r.points / lead) * 100}%` : "0%",
                    background: r.color,
                  }}
                />
              </div>
              {expanded && (
                <div id={`entries-${r.teamId}`} className="stack" style={{ marginTop: 12 }}>
                  {teamDetailError && <div className="card card-bad tiny bad">{teamDetailError}</div>}
                  {!details && !teamDetailError && <p className="muted tiny">Loading scored entries…</p>}
                  {details && details.entries.length === 0 && (
                    <div className="empty" style={{ margin: 0, padding: "18px 10px" }}>
                      <b>No scored entries yet</b>
                      This team is still waiting for its first approval.
                    </div>
                  )}
                  {details?.entries.map((entry) => (
                    <EvidenceEntryCard key={entry.id} entry={entry} showTask />
                  ))}
                </div>
              )}
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
