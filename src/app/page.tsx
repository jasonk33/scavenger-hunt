"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { getMe, inkOn, setMe, usePoll } from "@/lib/client";

type PlayersResponse = {
  round: number;
  eventName: string;
  players: Array<{ id: string; name: string; team: { name: string; color: string } | null }>;
};

/**
 * Join screen. Identity is "which name are you", stored in localStorage. There is
 * no password because there is no cheating threat -- the only failure this needs
 * to prevent is a submission landing on the wrong team's scoreboard.
 *
 * Note what is NOT here: no team picker. Team is resolved server-side from the
 * roster for whichever round is active, so the 3:30pm remix requires nobody to
 * re-join, re-scan, or reload anything.
 */
export default function JoinPage() {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [previous, setPrevious] = useState<{ id: string; name: string } | null>(null);
  const { data, error } = usePoll<PlayersResponse>("/api/players", 10000);

  // Arriving here with an identity already stored means one of two things: a
  // returning player (bounce them straight to Submit) or someone who just tapped
  // "switch" (Submit clears the identity first, so there is nothing to bounce).
  // Either way, remember who they were so a mis-tap is one tap to undo.
  useEffect(() => {
    const me = getMe();
    if (me) router.replace("/submit");
  }, [router]);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem("sh.previous");
      if (raw) setPrevious(JSON.parse(raw));
    } catch {
      /* ignore */
    }
  }, []);

  const matches = useMemo(() => {
    const list = data?.players ?? [];
    const needle = q.trim().toLowerCase();
    if (!needle) return list;
    return list.filter((p) => p.name.toLowerCase().includes(needle));
  }, [data, q]);

  const choose = (p: { id: string; name: string }) => {
    setBusy(true);
    setMe({ id: p.id, name: p.name });
    try {
      sessionStorage.setItem("sh.previous", JSON.stringify({ id: p.id, name: p.name }));
    } catch {
      /* ignore */
    }
    router.replace("/submit");
  };

  return (
    <>
      {/* Falsy until the first poll lands, so the h1 keeps its full top margin
          while loading rather than hugging the nav. */}
      {data?.eventName && <div className="eyebrow" style={{ margin: "22px 0 0" }}>{data.eventName}</div>}
      <h1 style={{ marginTop: data?.eventName ? 4 : 22 }}>Who are you?</h1>
      <p className="lede">Tap your name. You can change it later if you tap the wrong one.</p>

      {previous && (
        <div className="card card-accent">
          <div className="row">
            <span className="grow tiny">
              You were just <b>{previous.name}</b>.
            </span>
            <button className="btn btn-sm" onClick={() => choose(previous)}>
              Go back
            </button>
          </div>
        </div>
      )}

      {error && <div className="card card-bad">Couldn&apos;t load the player list: {error}</div>}

      <input
        className="field"
        placeholder="Search your name"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        autoComplete="off"
        style={{ marginBottom: 10 }}
      />

      {!data && !error && <p className="muted">Loading…</p>}

      {data && matches.length === 0 && (
        <div className="empty">
          <b>No name matches that</b>
          Ask an organizer to add you — takes them five seconds on the Admin screen.
        </div>
      )}

      <div className="stack">
        {matches.map((p) => (
          <button
            key={p.id}
            className="btn btn-wide"
            disabled={busy}
            onClick={() => choose(p)}
            style={{ justifyContent: "space-between", gap: 10 }}
          >
            <span className="nowrap">{p.name}</span>
            {p.team ? (
              <span
                className="pill"
                style={{
                  background: p.team.color,
                  borderColor: p.team.color,
                  color: inkOn(p.team.color),
                }}
              >
                {p.team.name}
              </span>
            ) : (
              <span className="pill muted">no team yet</span>
            )}
          </button>
        ))}
      </div>
    </>
  );
}
