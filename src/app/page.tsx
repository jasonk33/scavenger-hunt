"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { errorMessage, getMe, inkOn, setMe, usePoll } from "@/lib/client";
import type { EventState } from "@/lib/event";
import { useEvent } from "@/components/EventShell";

type PlayersResponse = {
  eventName: string;
  event: EventState;
  players: Array<{ id: string; name: string; team: { id: string; name: string; color: string } | null }>;
};

const PHASE_COPY = {
  welcome: ["Welcome to the hunt", "Meet your team and read the rules. Tasks will appear when Jason starts Round 1."],
  round1: ["Round 1 is on", "Stay together, pick a task and send your evidence."],
  break: ["Round 1 is over", "Uploads are closed. Check your scores and photos while the organizers get the new teams ready."],
  remix: ["Meet your Round 2 team", "Your new teammates are below. Round 2 tasks will appear when Jason starts the round."],
  round2: ["Round 2 is on", "New team, new tasks, separate scores. Go make it count."],
  finished: ["The hunt is over", "Uploads are closed. Check the final tasks, scores and photos while the judges finish up."],
};

export default function HomePage() {
  const [meId, setMeId] = useState<string | null | undefined>(undefined);
  const [q, setQ] = useState("");
  const [previousId, setPreviousId] = useState<string | null>(null);
  const [identityError, setIdentityError] = useState("");
  const { data, error, reload } = usePoll<PlayersResponse>("/api/players", 10000);
  const { data: event } = useEvent();
  const activeRound = event?.activeRound;

  useEffect(() => {
    setMeId(getMe()?.id ?? null);
    try {
      const raw = sessionStorage.getItem("sh.previous");
      if (raw) setPreviousId(JSON.parse(raw).id);
    } catch {
      /* A previous name is only a convenience. */
    }
  }, []);

  useEffect(() => {
    if (activeRound !== undefined) void reload();
  }, [activeRound, reload]);

  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data?.players ?? []).filter((p) => p.name.toLowerCase().includes(needle));
  }, [data, q]);
  const player = data?.players.find((p) => p.id === meId);
  const previous = data?.players.find((p) => p.id === previousId);
  const picking = meId !== undefined && (!meId || Boolean(data && !player));
  // The roster and its round are one response. Never put an old team under a
  // new-round heading while the independent event poll is ahead of the roster.
  const currentRoster = data && (!event || data.event.activeRound === event.activeRound);
  const team = player?.team;
  const teammates = team ? data?.players.filter((p) => p.id !== player.id && p.team?.id === team.id) : [];
  const phaseCopy = event ? PHASE_COPY[event.phase] : null;

  const choose = (p: { id: string; name: string } | null) => {
    setIdentityError("");
    const identity = p ? { id: p.id, name: p.name } : null;
    try {
      setMe(identity);
      setMeId(p?.id ?? null);
      setQ("");
    } catch (e) {
      setIdentityError(errorMessage(e, "Couldn't remember your name. Please try again."));
      return;
    }
    if (p) {
      setPreviousId(p.id);
      try {
        sessionStorage.setItem("sh.previous", JSON.stringify(identity));
      } catch {
        /* The selected name already lives in localStorage. */
      }
    }
  };

  return (
    <>
      {data?.eventName && <div className="eyebrow" style={{ margin: "22px 0 0" }}>{data.eventName}</div>}
      <h1 style={{ marginTop: data?.eventName ? 4 : 22 }}>{picking ? "Who are you?" : "Home"}</h1>
      {error && <div className="card card-bad" role="alert">Couldn&apos;t load the player list: {error}. Retrying.</div>}
      {identityError && <div className="card card-bad" role="alert">{identityError}</div>}
      {(!data || meId === undefined) && !error && <p className="muted">Loading your team…</p>}

      {picking && (
        <section aria-label="Choose your name">
          <p className="lede">Tap your name to find your team. You can change it any time.</p>
          {previous && (
            <button className="btn btn-wide" style={{ marginBottom: 10, padding: "10px 18px" }} onClick={() => choose(previous)}>
              <span className="name">Go back to {previous.name}</span>
            </button>
          )}
          <input
            className="field"
            placeholder="Search your name"
            aria-label="Search your name"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            autoComplete="off"
            style={{ marginBottom: 10 }}
          />
          {data && !error && matches.length === 0 && (
            <div className="empty">
              <b>{q.trim() ? "No name matches that" : "No names yet"}</b>
              Ask an organizer to add you.
            </div>
          )}
          <div className="stack">
            {matches.map((p) => (
              <button key={p.id} className="btn btn-wide" onClick={() => choose(p)} style={{ padding: "10px 18px" }}>
                <span className="name" style={{ maxWidth: "100%" }}>{p.name}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {player && (
        <>
          <div className="row" style={{ flexWrap: "wrap", marginBottom: 14 }}>
            <b className="name grow" style={{ flexBasis: 180 }}>{player.name}</b>
            <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={() => choose(null)}>Change name</button>
          </div>
          {!currentRoster ? <p className="muted">Updating your team…</p> : (
            <section className="card card-accent" aria-labelledby="your-team">
              <h2 id="your-team" style={{ margin: "0 0 10px" }}>Your Round {data.event.activeRound} team</h2>
              {team ? (
                <>
                  <div className="pill pill-wrap" style={{ background: team.color, borderColor: team.color, color: inkOn(team.color), maxWidth: "100%" }}>
                    {team.name}
                  </div>
                  <p className="muted tiny" style={{ margin: "12px 0 6px" }}>Your teammates</p>
                  <ul className="stack" style={{ paddingLeft: 20, margin: 0 }}>
                    {teammates?.map((p) => <li className="name" key={p.id}>{p.name}</li>)}
                  </ul>
                  {!teammates?.length && <p className="muted tiny">No other teammates assigned yet.</p>}
                </>
              ) : (
                <p className="muted">You haven&apos;t been assigned a team yet. Ask an organizer.</p>
              )}
            </section>
          )}
        </>
      )}

      <section className="card" aria-label="Event status">
        {phaseCopy ? (
          <>
            <h2 style={{ margin: "0 0 6px" }}>{phaseCopy[0]}</h2>
            <p style={{ margin: 0 }}>{phaseCopy[1]}</p>
            {event?.tasksVisible && player && (
              <Link className="btn btn-primary btn-wide" href="/submit" style={{ marginTop: 14 }}>
                View tasks
              </Link>
            )}
          </>
        ) : <p className="muted" style={{ margin: 0 }}>Waiting for event status…</p>}
      </section>

      <section className="card" aria-labelledby="how-to">
        <h2 id="how-to" style={{ margin: "0 0 8px" }}>How it works</h2>
        <ol className="hunt-schedule" aria-label="Afternoon schedule" role="list">
          <li><span>Round 1</span><b className="num">90 min</b></li>
          <li><span>Break</span><b className="num">1 hour</b></li>
          <li><span>Round 2</span><b className="num">90 min</b></li>
        </ol>
        <p style={{ margin: 0 }}>
          After Round 1, meet back at Jason&apos;s apartment for a 1-hour break to relax and enjoy refreshments.
          Switch teams for Round 2; each round is scored separately.
        </p>
        <p style={{ margin: "10px 0 0" }}>
          Each round, every team gets a bag of challenge props and a separate bag of handy supplies.
        </p>
        <div style={{ borderTop: "1px solid var(--line-soft)", marginTop: 14, paddingTop: 14 }}>
          <p style={{ margin: 0 }}><b>50 tasks per round.</b> Do as many as you can before time&apos;s up.</p>
          <ul className="row" aria-label="Task points" role="list" style={{ flexWrap: "wrap", listStyle: "none", padding: 0, margin: "8px 0" }}>
            {[1, 3, 5, 10].map((points) => <li key={points} className="pill pill-accent">{points} {points === 1 ? "pt" : "pts"}</li>)}
          </ul>
          <p style={{ margin: 0 }}>Some tasks offer bonus points for doing extra.</p>
        </div>
      </section>
      <section className="card" aria-labelledby="rules">
        <h2 id="rules" style={{ margin: "0 0 8px" }}>Rules</h2>
        <ul className="stack" style={{ margin: 0, paddingLeft: 20, listStyleType: "disc" }}>
          <li>Stay together.</li>
          <li>The same stranger can help with a maximum of 3 tasks per team per round.</li>
        </ul>
      </section>
      <section className="card" aria-labelledby="website">
        <h2 id="website" style={{ margin: "0 0 8px" }}>Using the website</h2>
        <ul className="stack" style={{ margin: 0, paddingLeft: 20, listStyleType: "disc" }}>
          <li><b>Tasks:</b> upload photo or video evidence and use the optional note field for extra explanation. Each task scores once per team when approved.</li>
          <li><b>Scores:</b> live team standings.</li>
          <li><b>Feed:</b> everyone&apos;s judged photos and videos.</li>
        </ul>
      </section>
    </>
  );
}
