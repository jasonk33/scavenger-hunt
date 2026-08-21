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
  teamId: string;
  teamName: string;
  teamColor: string;
  playerName: string;
  duplicate: boolean;
  pointsAwarded: number | null;
  bonus: number;
  starred: boolean;
  rejectReason: string | null;
};

type Queue = {
  round: number;
  teams: Array<{ id: string; name: string; color: string }>;
  queue: Item[];
  recent: Item[];
  pendingCount: number;
  otherRoundPending: number;
};

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

  // This is the only door into the organizer screens, so it says what is behind
  // it. Players will land here by tapping "Organizer" out of curiosity; the PIN
  // is what stops them, not obscurity.
  if (!authed) {
    return (
      <div className="card" style={{ marginTop: 24 }}>
        <b>Organizer</b>
        <p className="muted tiny" style={{ margin: "4px 0 10px" }}>
          Judging and event setup. Players don&apos;t need this.
        </p>
        <input
          className="field"
          type="password"
          inputMode="numeric"
          placeholder="PIN"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && login()}
          style={{ marginBottom: 10 }}
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
  // Deliberately NOT locked to the active round. When the organizer flips to
  // Round 2 at the break there will still be a Round 1 backlog in the queue,
  // and without this selector those submissions become invisible and never get
  // scored -- a silently wrong Round 1 result.
  const [round, setRound] = useState<number | null>(null);
  const { data, reload } = usePoll<Queue>(
    round ? `/api/judge/queue?round=${round}` : "/api/judge/queue",
    5000
  );
  const [bonus, setBonus] = useState(0);
  const [star, setStar] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reassigning, setReassigning] = useState(false);
  // When set, the review card shows this already-judged item instead of the
  // head of the queue, so any past call can be reopened and changed.
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [historyQ, setHistoryQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // Judged locally but not yet reflected in a poll -- keeps the screen from
  // snapping backwards to an item that was already decided.
  const [done, setDone] = useState<Set<string>>(new Set());

  const queue = useMemo(
    () => (data?.queue ?? []).filter((i) => !done.has(i.id)),
    [data, done]
  );
  const history = useMemo(() => data?.recent ?? [], [data]);
  const reviewing = reviewId ? history.find((h) => h.id === reviewId) ?? null : null;
  const current = reviewing ?? queue[0];
  const next = reviewing ? undefined : queue[1];
  const otherRoundPending = data?.otherRoundPending ?? 0;

  const filteredHistory = useMemo(() => {
    const needle = historyQ.trim().toLowerCase();
    if (!needle) return history;
    return history.filter(
      (h) =>
        h.taskTitle.toLowerCase().includes(needle) ||
        h.teamName.toLowerCase().includes(needle) ||
        h.playerName.toLowerCase().includes(needle)
    );
  }, [history, historyQ]);

  // Reset the per-item controls whenever the item changes, so a bonus meant for
  // the last submission never lands on the next one.
  useEffect(() => {
    // Seed from the existing decision when reopening a judged item, so tapping
    // "Update" doesn't silently wipe a bonus or an award flag.
    setBonus(current?.status === "approved" ? (current.bonus ?? 0) : 0);
    setStar(Boolean(current?.starred));
    setRejecting(false);
    setReassigning(false);
    setErr("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  const decide = async (body: Record<string, unknown>) => {
    if (!current || busy) return;
    setBusy(true);
    setErr("");
    const id = current.id;
    try {
      // expectedStatus is what makes re-reviewing safe: the server accepts the
      // change only if the row is still in the state this screen last saw, so a
      // deliberate correction goes through but a stale second judge is refused.
      await api(`/api/judge/${id}`, {
        method: "POST",
        body: JSON.stringify({ expectedStatus: current.status, ...body }),
      });
      if (reviewing) setReviewId(null);
      else setDone((d) => new Set(d).add(id));
      reload();
    } catch (e) {
      setErr(errorMessage(e, "Failed"));
    } finally {
      setBusy(false);
    }
  };

  const undo = async (id: string) => {
    try {
      await api(`/api/judge/${id}`, {
        method: "POST",
        body: JSON.stringify({ action: "reset" }),
      });
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
      </header>

      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        {[1, 2].map((r) => (
          <button
            key={r}
            className={`btn btn-sm ${(round ?? data?.round) === r ? "btn-primary" : ""}`}
            onClick={() => setRound(r)}
          >
            Round {r}
            {otherRoundPending > 0 && (round ?? data?.round) !== r ? ` · ${otherRoundPending}` : ""}
          </button>
        ))}
      </div>

      {/* After the break there is usually still a Round 1 backlog. Saying so
          stops it from being forgotten once the active round moves on. */}
      {otherRoundPending > 0 && (
        <p className="warn tiny" style={{ marginTop: 0 }}>
          {otherRoundPending} submission{otherRoundPending === 1 ? "" : "s"} still waiting in the
          other round.
        </p>
      )}

      {err && <div className="card bad tiny">{err}</div>}

      {!current && !reviewing && (
        <div className="card">
          <b className="good">Queue is empty.</b>
          <p className="muted tiny" style={{ margin: "4px 0 0" }}>
            Nothing waiting. This refreshes on its own.
          </p>
        </div>
      )}

      {reviewing && (
        <div className="card" style={{ borderColor: "var(--accent)", borderWidth: 2 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <b>Re-reviewing</b>
            <span
              className="pill"
              style={{
                borderColor: reviewing.status === "approved" ? "var(--good)" : "var(--bad)",
                color: reviewing.status === "approved" ? "var(--good)" : "var(--bad)",
              }}
            >
              currently{" "}
              {reviewing.status === "approved"
                ? `approved +${(reviewing.pointsAwarded ?? 0) + reviewing.bonus}`
                : "rejected"}
            </span>
            <button
              className="btn btn-sm"
              style={{ marginLeft: "auto" }}
              onClick={() => setReviewId(null)}
            >
              Back to queue
            </button>
          </div>
          <p className="muted tiny" style={{ margin: "6px 0 0" }}>
            Approving or rejecting below replaces the earlier call. The team sees the change on
            their next refresh.
          </p>
        </div>
      )}

      {current && (
        <div className="card">
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: current.teamColor }} />
            {/* Tap the team name to move a submission that landed on the wrong
                scoreboard -- usually because the player tapped the wrong name
                when they joined. */}
            <button
              onClick={() => setReassigning((v) => !v)}
              style={{
                background: "none",
                border: 0,
                padding: 0,
                font: "inherit",
                fontWeight: 700,
                color: "var(--ink)",
                cursor: "pointer",
              }}
              title="Wrong team? Tap to move it"
            >
              {current.teamName}
            </button>
            <span className="muted tiny">{current.playerName}</span>
            <span className="pill" style={{ marginLeft: "auto" }}>
              {current.taskPoints} pts
            </span>
          </div>

          {reassigning && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
              <span className="muted tiny" style={{ width: "100%" }}>
                Move this submission to:
              </span>
              {(data?.teams ?? [])
                .filter((tm) => tm.id !== current.teamId)
                .map((tm) => (
                  <button
                    key={tm.id}
                    className="btn btn-sm"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        await api(`/api/judge/${current.id}`, {
                          method: "POST",
                          body: JSON.stringify({
                            action: "reassign",
                            teamId: tm.id,
                            expectedStatus: current.status,
                          }),
                        });
                        setReassigning(false);
                        reload();
                      } catch (e) {
                        setErr(errorMessage(e, "Failed"));
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    {tm.name}
                  </button>
                ))}
              <button className="btn btn-sm" onClick={() => setReassigning(false)}>
                Cancel
              </button>
            </div>
          )}

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
                  {reviewing?.status === "approved" ? "Update to" : "Approve"}{" "}
                  {current.taskPoints + bonus}
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

      {history.length > 0 && (
        <>
          <h2 className="muted" style={{ fontSize: 15, margin: "20px 0 6px" }}>
            Judged this round ({history.length}) — tap any to change it
          </h2>

          {history.length > 8 && (
            <input
              className="field"
              placeholder="Search by task, team or player"
              value={historyQ}
              onChange={(e) => setHistoryQ(e.target.value)}
              style={{ marginBottom: 8 }}
            />
          )}

          <div style={{ display: "grid", gap: 6 }}>
            {filteredHistory.map((r) => (
              <div
                key={r.id}
                className="card"
                style={{
                  margin: 0,
                  padding: 10,
                  display: "flex",
                  gap: 10,
                  alignItems: "center",
                  borderColor: r.id === reviewId ? "var(--accent)" : undefined,
                }}
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
                <button
                  onClick={() => {
                    setReviewId(r.id);
                    window.scrollTo({ top: 0, behavior: "smooth" });
                  }}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    textAlign: "left",
                    background: "none",
                    border: 0,
                    padding: 0,
                    color: "var(--ink)",
                    cursor: "pointer",
                  }}
                >
                  <div
                    className="tiny"
                    style={{
                      fontWeight: 600,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {r.starred ? "⭐ " : ""}
                    {r.taskTitle}
                  </div>
                  <div className="muted tiny">
                    {r.teamName}
                    {r.status === "rejected" && r.rejectReason ? ` · ${r.rejectReason}` : ""}
                  </div>
                </button>
                <button className="btn btn-sm" onClick={() => undo(r.id)} title="Send back to the queue">
                  Undo
                </button>
              </div>
            ))}
            {filteredHistory.length === 0 && (
              <span className="muted tiny">Nothing matches that.</span>
            )}
          </div>
        </>
      )}
    </>
  );
}
