"use client";

import { useEffect, useMemo, useState } from "react";
import { api, errorMessage, fmtBytes, usePoll } from "@/lib/client";
import { REASON_MAX } from "@/lib/groups";
import Score from "@/components/Score";

type Item = {
  id: string;
  status: string;
  media: Array<{ id: string; url: string; isVideo: boolean; sizeBytes: number | null }>;
  isVideo: boolean;
  sizeBytes: number | null;
  note: string | null;
  taskTitle: string;
  taskPoints: number;
  scoringMode: "fixed" | "quantity" | "competition";
  measurementLabel: string;
  measurementValue: number | null;
  pointsPerUnit: number;
  competitionBonus: number;
  requiresVideo: boolean;
  isSecret: boolean;
  teamId: string;
  teamName: string;
  teamColor: string;
  playerName: string;
  duplicate: boolean;
  pointsAwarded: number | null;
  /** What the task was worth and what the count bought, split the same way the
      players see it. */
  awardedBase: number;
  awardedBonus: number;
  rejectReason: string | null;
};

type Queue = {
  round: number;
  teams: Array<{ id: string; name: string; color: string }>;
  queue: Item[];
  recent: Item[];
  otherRoundPending: number;
};

/** Starting points, not the whole vocabulary. Tapping one fills the box in so it
    can be edited -- the reason the team reads has to be able to say what actually
    went wrong, and four canned lines never could. */
const REASONS = ["No stranger in frame", "Doesn't match the task", "Can't tell what's happening", "Wrong round"];

/** Shared by the waiting list and the history list, so the two search the same
    three fields and can't drift apart. */
function matches(item: Item, needle: string) {
  return (
    item.taskTitle.toLowerCase().includes(needle) ||
    item.teamName.toLowerCase().includes(needle) ||
    item.playerName.toLowerCase().includes(needle)
  );
}

/** List length above which a list gets its own search box. One constant, because
    the render gate and the filter have to agree: if the filter outlived the box,
    a search would keep applying with nothing on screen to clear it. */
const SEARCH_AT = 8;

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
        <h2 style={{ margin: "0 0 2px" }}>Organizer</h2>
        <p className="muted tiny" style={{ margin: "0 0 12px" }}>
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
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [measurement, setMeasurement] = useState("");
  const [reassigning, setReassigning] = useState(false);
  // When set, the review card shows this specific submission instead of the head
  // of the queue -- either a queued one the judge scrolled to, or an
  // already-judged one being reopened to change the call.
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [queueQ, setQueueQ] = useState("");
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
  // Queue first: if another judge decides the picked item while it is on screen
  // it moves to history, and resolving it there keeps the card showing the same
  // submission with its new status rather than silently jumping elsewhere.
  const picked = pickedId
    ? queue.find((i) => i.id === pickedId) ?? history.find((h) => h.id === pickedId) ?? null
    : null;
  const current = picked ?? queue[0];
  // Only a judged item gets the "Re-reviewing" banner. A picked item that is
  // still pending is an ordinary review, just not the one at the front.
  const reviewing = picked && picked.status !== "pending" ? picked : null;
  // Warm whatever comes after the item actually on screen, which is only
  // meaningful while that item is itself in the queue.
  const currentIndex = current ? queue.findIndex((i) => i.id === current.id) : -1;
  const next = currentIndex >= 0 ? queue[currentIndex + 1] : undefined;
  const otherRoundPending = data?.otherRoundPending ?? 0;

  const filteredQueue = useMemo(() => {
    // Derived from the same condition that renders the box, so a search can never
    // outlive the only control that clears it. The queue SHRINKS as the judge
    // works, so it crosses the threshold downward mid-session -- leaving the
    // needle applied would strand them on a short or empty list with no input.
    const needle = queue.length > SEARCH_AT ? queueQ.trim().toLowerCase() : "";
    return needle ? queue.filter((i) => matches(i, needle)) : queue;
  }, [queue, queueQ]);

  const filteredHistory = useMemo(() => {
    // Same rule: Undo moves a row back to the queue, so history shrinks too.
    const needle = history.length > SEARCH_AT ? historyQ.trim().toLowerCase() : "";
    return needle ? history.filter((h) => matches(h, needle)) : history;
  }, [history, historyQ]);

  // Reset the per-item controls whenever the item changes, so a reason typed
  // about the last submission never lands on the next one.
  useEffect(() => {
    // Seed from the existing decision when reopening a judged item, so a judge
    // adjusting the wording of a rejection doesn't have to retype it. Status is
    // a dependency as well as id: a picked item keeps its id when another
    // organizer judges it out from under this screen, and without it the box
    // would still hold the previous ruling's text.
    setReason(current?.status === "rejected" ? (current.rejectReason ?? "") : "");
    setMeasurement(current?.measurementValue === null || current?.measurementValue === undefined ? "" : String(current.measurementValue));
    setRejecting(false);
    setReassigning(false);
    setErr("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, current?.status]);

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
      // Only a queued item needs suppressing: `done` filters the queue, and
      // adding an already-judged id would hide it if another organizer sent it
      // back. Either way the pick is spent.
      if (queue.some((i) => i.id === id)) setDone((d) => new Set(d).add(id));
      setPickedId((p) => (p === id ? null : p));
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
      <header className="row" style={{ margin: "18px 0 10px" }}>
        <h1 style={{ margin: 0 }}>Judge</h1>
        <span className={`pill${queue.length > 0 ? " pill-accent" : ""}`}>
          {queue.length} waiting
        </span>
      </header>

      <div className="row" style={{ marginBottom: 10 }}>
        <div className="seg">
          {[1, 2].map((r) => (
            <button
              key={r}
              className={(round ?? data?.round) === r ? "on" : ""}
              onClick={() => setRound(r)}
            >
              Round {r}
              {otherRoundPending > 0 && (round ?? data?.round) !== r ? ` · ${otherRoundPending}` : ""}
            </button>
          ))}
        </div>
      </div>

      {/* After the break there is usually still a Round 1 backlog. Saying so
          stops it from being forgotten once the active round moves on. */}
      {otherRoundPending > 0 && (
        <p className="warn tiny" style={{ marginTop: 0 }}>
          {otherRoundPending} submission{otherRoundPending === 1 ? "" : "s"} still waiting in the
          other round.
        </p>
      )}

      {err && <div className="card card-bad tiny bad">{err}</div>}

      {!current && (
        data ? (
          <div className="empty">
            <b className="good">Queue is empty</b>
            Nothing waiting. This refreshes on its own.
          </div>
        ) : (
          // Before the first poll returns, `queue` is empty simply because
          // nothing has loaded. Rendering the green all-clear here would tell a
          // judge they were caught up while a backlog was still on its way --
          // worse than saying nothing, because they might walk away.
          <p className="muted" style={{ marginTop: 16 }}>Loading…</p>
        )
      )}

      {/* Whenever the card below is showing something other than the front of
          the queue, say so and offer the way back -- otherwise a judge who
          taps into the middle of the backlog has no route to the front except
          judging their way there. */}
      {picked && (
        <div className="card card-accent">
          <div className="row" style={{ flexWrap: "wrap" }}>
            {reviewing ? (
              <>
                <b>Re-reviewing</b>
                <span
                  className={`pill ${reviewing.status === "approved" ? "pill-good" : "pill-bad"}`}
                >
                  currently{" "}
                  {reviewing.status === "approved"
                    ? `approved +${reviewing.awardedBase}${
                        reviewing.awardedBonus > 0 ? ` +${reviewing.awardedBonus} bonus` : ""
                      }`
                    : "rejected"}
                </span>
              </>
            ) : (
              <b>Picked out of the queue</b>
            )}
            <button className="btn btn-sm push" onClick={() => setPickedId(null)}>
              Back to the front
            </button>
          </div>
          {reviewing && (
            <p className="muted tiny" style={{ margin: "8px 0 0" }}>
              Approving or rejecting below replaces the earlier call. The team sees the change on
              their next refresh.
            </p>
          )}
        </div>
      )}

      {current && (
        <div className="card">
          <div className="cardhead">
            <div className="row">
              <span className="swatch" style={{ background: current.teamColor }} />
              {/* Tap the team name to move a submission that landed on the wrong
                  scoreboard -- usually because the player tapped the wrong name
                  when they joined. */}
              <button
                className="btn-plain name"
                style={{ fontWeight: 700 }}
                onClick={() => setReassigning((v) => !v)}
                title="Wrong team? Tap to move it"
              >
                {current.teamName}
              </button>
              {/* What this decision is worth. Removed once as redundant, which
                  left the judge approving and rejecting with no idea whether a
                  task was worth 1 or 10 -- it appears nowhere else on the
                  screen. For a quantity task it is the baseline, and the rate
                  that sits beside the count box below completes it. */}
              <span className="pill pill-solid push">{current.taskPoints} pts</span>
            </div>
            <div className="byline name muted tiny">{current.playerName}</div>
          </div>

          {reassigning && (
            <div className="row" style={{ gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
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

          <div style={{ fontWeight: 700, fontSize: 19, lineHeight: 1.3, marginBottom: 8 }}>
            {current.taskTitle}
          </div>

          <div className="row" style={{ gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
            {current.isSecret && <span className="pill pill-warn">secret challenge</span>}
            {/* The doc marks some tasks as clip-only. Flagging the mismatch here
                beats trying to enforce it at upload time and blocking a player
                mid-round over a technicality. */}
            {current.requiresVideo && !current.isVideo && (
              <span className="pill pill-bad pill-wrap">
                {current.media.length > 1
                  ? "task is video-only — none of these is a clip"
                  : "task is video-only — this is a photo"}
              </span>
            )}
            {current.duplicate && (
              <span className="pill pill-warn pill-wrap">team already has this task approved</span>
            )}
            {current.media.length > 1 && (
              <span className="pill pill-accent">{current.media.length} files — one decision</span>
            )}
            <span className="pill muted">{fmtBytes(current.sizeBytes)}</span>
          </div>

          {current.scoringMode === "quantity" && (
            <div className="card card-flat" style={{ padding: "10px 12px", marginBottom: 10 }}>
              {/* The stored label is ONE unit ("extra pigeon") so the rate line
                  below reads as a sentence. That makes it the wrong thing to
                  paste into a heading -- "How many extra pigeon?" -- so the
                  question stays bare and the unit is named underneath. */}
              <div className="stat-label" style={{ marginBottom: 4 }}>
                How many?
              </div>
              <div>
                <input
                  className="field"
                  type="number"
                  min={0}
                  step={1}
                  inputMode="numeric"
                  placeholder="0"
                  aria-label={`How many, at +${current.pointsPerUnit} per ${
                    current.measurementLabel || "extra item"
                  }`}
                  value={measurement}
                  onChange={(e) => setMeasurement(e.target.value)}
                  style={{ width: "100%" }}
                />
              </div>
              {/* Without the rate the count is a number with no meaning: the
                  judge types 3 and cannot tell whether that bought 3 points or
                  30. */}
              <div className="muted tiny" style={{ marginTop: 6 }}>
                +{current.pointsPerUnit} pt{current.pointsPerUnit === 1 ? "" : "s"} per{" "}
                {current.measurementLabel || "extra item"}, on top of the {current.taskPoints} above
              </div>
            </div>
          )}

          {/* A leader-bonus task has nothing for the judge to measure. It is
              approved or not, at face value, and an organizer picks the winning
              team from Admin once the round is over. Said out loud because the
              obvious question on seeing "leader +5" here is "so where do I put
              the score?". */}
          {current.scoringMode === "competition" && (
            <div className="card card-flat" style={{ padding: "10px 12px", marginBottom: 10 }}>
              <div className="stat-label" style={{ marginBottom: 4 }}>
                Leader bonus
              </div>
              <div style={{ lineHeight: 1.4 }}>
                Just approve or reject this on its merits. The +{current.competitionBonus} goes to
                whichever team you and Anna pick in Admin at the end of the round.
              </div>
            </div>
          )}

          {/* What the team says the judge is looking at. Sits ABOVE the media,
              because a photo whose point isn't obvious is exactly the case this
              exists for -- read first, then look. */}
          {current.note && (
            <div className="card card-flat" style={{ padding: "10px 12px", marginBottom: 10 }}>
              <div className="stat-label" style={{ marginBottom: 4 }}>
                They said
              </div>
              <div style={{ overflowWrap: "anywhere", lineHeight: 1.4 }}>{current.note}</div>
            </div>
          )}

          {/* Every file in the set, stacked. A carousel would hide evidence
              behind a swipe the judge has no reason to expect, and approving a
              set on the strength of the one photo that happened to be on top is
              exactly the mistake this has to prevent. */}
          <div className="stack" style={{ gap: 8 }}>
            {current.media.map((m) => (
              <div className="media-box" key={m.id}>
                {m.isVideo ? (
                  <video
                    key={m.id}
                    className="media"
                    controls
                    playsInline
                    preload="auto"
                    src={`${m.url}#t=0.1`}
                  />
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={m.id} className="media" src={m.url} alt={current.taskTitle} />
                )}
              </div>
            ))}
          </div>

          {/* Quietly warms the next item's media so the queue feels instant.
              Only its first file: warming a whole set would spend the egress
              budget on evidence the judge may never reach. */}
          {next && !next.media[0].isVideo && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={next.media[0].url} alt="" style={{ display: "none" }} />
          )}

          {!rejecting ? (
            /* Wraps rather than overflowing: at a large text size these two
               stop fitting side by side, and the judge's primary control
               scrolling off the edge is not an acceptable failure. */
            <div className="row" style={{ gap: 8, marginTop: 14, flexWrap: "wrap" }}>
              <button
                className="btn btn-lg btn-good"
                style={{ flex: 2 }}
                disabled={busy}
                onClick={() => decide({
                  action: "approve",
                  measurementValue: measurement === "" ? null : Number(measurement),
                })}
              >
                {reviewing?.status === "approved" ? "Re-approve" : "Approve"}
              </button>
              <button
                className="btn btn-lg btn-bad"
                style={{ flex: 1 }}
                disabled={busy}
                onClick={() => setRejecting(true)}
              >
                Reject
              </button>
            </div>
          ) : (
            <div style={{ marginTop: 14 }}>
              <div className="stat-label" style={{ marginBottom: 8 }}>
                Why? (the team sees this)
              </div>
              {/* Typed, not picked. The chips below only prefill this, so the
                  common reasons stay one tap while anything else is still
                  sayable -- and every rejection travels the same code path. */}
              <textarea
                className="field"
                rows={2}
                autoFocus
                placeholder="Type the reason, or tap one below"
                maxLength={REASON_MAX}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                style={{ marginBottom: 8, resize: "vertical" }}
              />
              <div className="row" style={{ gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
                {REASONS.map((r) => (
                  <button
                    key={r}
                    className="btn btn-sm"
                    disabled={busy}
                    onClick={() => setReason(r)}
                  >
                    {r}
                  </button>
                ))}
              </div>
              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <button
                  className="btn btn-lg btn-bad"
                  style={{ flex: 2 }}
                  disabled={busy}
                  onClick={() => decide({ action: "reject", reason })}
                >
                  {/* Naming the empty case out loud: a blank box is a valid
                      rejection, and a judge who meant to type something should
                      be able to see that they didn't. */}
                  {reason.trim() ? "Reject" : "Reject with no reason"}
                </button>
                <button className="btn btn-lg" style={{ flex: 1 }} onClick={() => setRejecting(false)}>
                  Back
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* The whole backlog, not just its front. Text rows on purpose: a
          thumbnail grid would fetch every queued photo the moment the judge
          opens the screen. The queue is ordered by upload time and a poll only
          ever appends to it, so no row moves under a thumb on its own -- rows
          shift up only as the direct result of the judge's own decision. */}
      {queue.length > 1 && (
        <>
          <h2 className="eyebrow">Waiting ({queue.length}) — tap any to review it now</h2>

          {queue.length > SEARCH_AT && (
            <input
              className="field"
              /* Distinct from the one over the judged list. Both can be on
                 screen at once, and two boxes reading the same thing leave the
                 judge -- and anything driving this screen -- unable to tell
                 which list they are about to filter. */
              placeholder="Search what's waiting"
              value={queueQ}
              onChange={(e) => setQueueQ(e.target.value)}
              style={{ marginBottom: 8 }}
            />
          )}

          <div className="stack" style={{ gap: 6 }}>
            {filteredQueue.map((r) => (
              <div
                key={r.id}
                className={`card card-flat row${r.id === current?.id ? " card-accent" : ""}`}
                /* Wraps rather than crushes. Page zoom and iOS larger text lay a
                   390px phone out like a 260px one, and at that width the score,
                   the name and Undo cannot share a line -- the name was handed
                   zero pixels and disappeared entirely. */
                style={{ padding: 10, flexWrap: "wrap" }}
              >
                <span className="swatch" style={{ background: r.teamColor }} />
                <button
                  className="btn-plain grow"
                  style={{ minHeight: 40 }}
                  onClick={() => {
                    setPickedId(r.id);
                    window.scrollTo({ top: 0, behavior: "smooth" });
                  }}
                >
                  <div className="tiny nowrap" style={{ fontWeight: 600 }}>
                    {r.taskTitle}
                  </div>
                  {/* Names wrap rather than clip, the same rule as everywhere
                      else. This line used to be `nowrap`, which quietly
                      ellipsised a team name the moment the row got tight. */}
                  <div className="muted tiny name">
                    {r.teamName} · {r.playerName}
                  </div>
                </button>
                {/* Says what is behind the tap without fetching any of it: a
                    set is more work than a single photo, and a note is often
                    the reason a confusing one makes sense. */}
                {r.media.length > 1 && <span className="pill">{r.media.length}📎</span>}
                {r.note && <span className="pill" title={r.note}>note</span>}
                <span className="pill">{r.taskPoints}</span>
              </div>
            ))}
            {filteredQueue.length === 0 && (
              <span className="muted tiny">Nothing matches that.</span>
            )}
          </div>
        </>
      )}

      {history.length > 0 && (
        <>
          <h2 className="eyebrow">Judged this round ({history.length}) — tap any to change it</h2>

          {history.length > SEARCH_AT && (
            <input
              className="field"
              placeholder="Search what's been judged"
              value={historyQ}
              onChange={(e) => setHistoryQ(e.target.value)}
              style={{ marginBottom: 8 }}
            />
          )}

          <div className="stack" style={{ gap: 6 }}>
            {filteredHistory.map((r) => (
              <div
                key={r.id}
                className={`card card-flat row${r.id === pickedId ? " card-accent" : ""}`}
                style={{ padding: 10, flexWrap: "wrap" }}
              >
                {r.status === "approved" ? (
                  <Score base={r.awardedBase} bonus={r.awardedBonus} tone="pill-good" />
                ) : (
                  <span className="pill pill-bad">✗</span>
                )}
                <button className="btn-plain grow" style={{ minHeight: 40 }} onClick={() => {
                  setPickedId(r.id);
                  window.scrollTo({ top: 0, behavior: "smooth" });
                }}>
                  <div className="tiny nowrap" style={{ fontWeight: 600 }}>
                    {r.taskTitle}
                  </div>
                  {/* A name and the judge's own words, so it wraps: the score
                      beside it is two pills now, and at 320px the clipped
                      remainder read "The Birthday Bur...". */}
                  <div className="muted tiny name">
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
