"use client";

import { useEffect, useMemo, useState } from "react";
import { api, errorMessage, fmtBytes, usePoll } from "@/lib/client";

type Item = {
  id: string;
  status: string;
  mediaUrl: string;
  isVideo: boolean;
  sizeBytes: number | null;
  taskTitle: string;
  taskPoints: number;
  requiresVideo: boolean;
  isSecret: boolean;
  teamName: string;
  teamColor: string;
  playerName: string;
  duplicate: boolean;
  pointsAwarded: number | null;
  bonus: number;
  starred: boolean;
  rejectReason: string | null;
};

type Queue = { round: number; queue: Item[]; recent: Item[]; pendingCount: number };

const REASONS = ["No stranger in frame", "Doesn't match the task", "Can't tell what's happening", "Wrong round"];

export default function JudgePage() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState("");

  useEffect(() => {
    api("/api/judge/queue")
      .then(() => setAuthed(true))
      .catch(() => setAuthed(false));
  }, []);

  const login = async () => {
    setPinError("");
    try {
      await api("/api/admin/login", { method: "POST", body: JSON.stringify({ pin }) });
      setAuthed(true);
    } catch (e) {
      setPinError(errorMessage(e, "Wrong PIN"));
    }
  };

  if (authed === null) return <p className="muted" style={{ marginTop: 24 }}>Checking…</p>;

  if (!authed) {
    return (
      <div className="card" style={{ marginTop: 24 }}>
        <b>Organizer PIN</b>
        <input
          className="field"
          type="password"
          inputMode="numeric"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && login()}
          style={{ margin: "10px 0" }}
        />
        {pinError && <p className="bad tiny">{pinError}</p>}
        <button className="btn btn-primary btn-wide" onClick={login}>
          Unlock
        </button>
      </div>
    );
  }

  return <JudgeQueue />;
}

function JudgeQueue() {
  const { data, reload } = usePoll<Queue>("/api/judge/queue", 5000);
  const [bonus, setBonus] = useState(0);
  const [star, setStar] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // Judged locally but not yet reflected in a poll -- keeps the screen from
  // snapping backwards to an item that was already decided.
  const [done, setDone] = useState<Set<string>>(new Set());

  const queue = useMemo(
    () => (data?.queue ?? []).filter((i) => !done.has(i.id)),
    [data, done]
  );
  const current = queue[0];
  const next = queue[1];

  // Reset the per-item controls whenever the item changes, so a bonus meant for
  // the last submission never lands on the next one.
  useEffect(() => {
    setBonus(0);
    setStar(false);
    setRejecting(false);
    setErr("");
  }, [current?.id]);

  const decide = async (body: Record<string, unknown>) => {
    if (!current || busy) return;
    setBusy(true);
    setErr("");
    const id = current.id;
    try {
      await api(`/api/judge/${id}`, { method: "POST", body: JSON.stringify(body) });
      setDone((d) => new Set(d).add(id));
      reload();
    } catch (e) {
      setErr(errorMessage(e, "Failed"));
    } finally {
      setBusy(false);
    }
  };

  const undo = async (id: string) => {
    try {
      await api(`/api/judge/${id}`, { method: "POST", body: JSON.stringify({ action: "reset" }) });
      setDone((d) => {
        const n = new Set(d);
        n.delete(id);
        return n;
      });
      reload();
    } catch (e) {
      setErr(errorMessage(e, "Failed"));
    }
  };

  return (
    <>
      <header style={{ display: "flex", alignItems: "baseline", gap: 10, margin: "16px 0 4px" }}>
        <h1 style={{ fontSize: 24, margin: 0 }}>Judge</h1>
        <span className="pill">{queue.length} waiting</span>
        <span className="muted tiny" style={{ marginLeft: "auto" }}>
          Round {data?.round ?? "–"}
        </span>
      </header>

      {err && <div className="card bad tiny">{err}</div>}

      {!current && (
        <div className="card">
          <b className="good">Queue is empty.</b>
          <p className="muted tiny" style={{ margin: "4px 0 0" }}>
            Nothing waiting. This refreshes on its own.
          </p>
        </div>
      )}

      {current && (
        <div className="card">
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: current.teamColor }} />
            <b>{current.teamName}</b>
            <span className="muted tiny">{current.playerName}</span>
            <span className="pill" style={{ marginLeft: "auto" }}>
              {current.taskPoints} pts
            </span>
          </div>

          <div style={{ fontWeight: 700, fontSize: 19, marginBottom: 8 }}>{current.taskTitle}</div>

          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
            {current.isSecret && <span className="pill warn">secret challenge</span>}
            {/* The doc marks some tasks as clip-only. Flagging the mismatch here
                beats trying to enforce it at upload time and blocking a player
                mid-round over a technicality. */}
            {current.requiresVideo && !current.isVideo && (
              <span className="pill bad">task is video-only — this is a photo</span>
            )}
            {current.duplicate && (
              <span className="pill warn">team already has this task approved</span>
            )}
            <span className="pill muted">{fmtBytes(current.sizeBytes)}</span>
          </div>

          {current.isVideo ? (
            <video
              key={current.id}
              className="media"
              controls
              playsInline
              preload="auto"
              src={`${current.mediaUrl}#t=0.1`}
            />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={current.id} className="media" src={current.mediaUrl} alt={current.taskTitle} />
          )}

          {/* Quietly warms the next item's media so the queue feels instant. */}
          {next && !next.isVideo && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={next.mediaUrl} alt="" style={{ display: "none" }} />
          )}

          {!rejecting ? (
            <>
              <div style={{ display: "flex", gap: 8, margin: "12px 0 10px", flexWrap: "wrap" }}>
                <span className="muted tiny" style={{ alignSelf: "center" }}>
                  Creativity bonus
                </span>
                {[0, 1, 2].map((b) => (
                  <button
                    key={b}
                    className={`btn btn-sm ${bonus === b ? "btn-primary" : ""}`}
                    onClick={() => setBonus(b)}
                  >
                    {b === 0 ? "none" : `+${b}`}
                  </button>
                ))}
                <button
                  className={`btn btn-sm ${star ? "btn-primary" : ""}`}
                  onClick={() => setStar((s) => !s)}
                  title="Flag as an award candidate"
                >
                  ⭐ award
                </button>
              </div>

              <div style={{ display: "flex", gap: 8 }}>
                <button
                  className="btn btn-good"
                  style={{ flex: 2 }}
                  disabled={busy}
                  onClick={() => decide({ action: "approve", bonus, starred: star })}
                >
                  Approve {current.taskPoints + bonus}
                </button>
                <button
                  className="btn btn-bad"
                  style={{ flex: 1 }}
                  disabled={busy}
                  onClick={() => setRejecting(true)}
                >
                  Reject
                </button>
              </div>
            </>
          ) : (
            <div style={{ marginTop: 12 }}>
              <div className="muted tiny" style={{ marginBottom: 6 }}>
                Why? (the team sees this)
              </div>
              <div style={{ display: "grid", gap: 6 }}>
                {REASONS.map((r) => (
                  <button
                    key={r}
                    className="btn btn-sm"
                    disabled={busy}
                    onClick={() => decide({ action: "reject", reason: r })}
                  >
                    {r}
                  </button>
                ))}
                <button
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={() => decide({ action: "reject", reason: "" })}
                >
                  No reason
                </button>
                <button className="btn btn-sm" onClick={() => setRejecting(false)}>
                  Back
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {(data?.recent ?? []).length > 0 && (
        <>
          <h2 className="muted" style={{ fontSize: 15, margin: "20px 0 6px" }}>
            Just judged
          </h2>
          <div style={{ display: "grid", gap: 6 }}>
            {(data?.recent ?? []).map((r) => (
              <div
                key={r.id}
                className="card"
                style={{ margin: 0, padding: 10, display: "flex", gap: 10, alignItems: "center" }}
              >
                <span
                  className="pill"
                  style={{
                    borderColor: r.status === "approved" ? "var(--good)" : "var(--bad)",
                    color: r.status === "approved" ? "var(--good)" : "var(--bad)",
                  }}
                >
                  {r.status === "approved" ? `+${(r.pointsAwarded ?? 0) + r.bonus}` : "✗"}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    className="tiny"
                    style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  >
                    {r.starred ? "⭐ " : ""}
                    {r.taskTitle}
                  </div>
                  <div className="muted tiny">{r.teamName}</div>
                </div>
                <button className="btn btn-sm" onClick={() => undo(r.id)}>
                  Undo
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
