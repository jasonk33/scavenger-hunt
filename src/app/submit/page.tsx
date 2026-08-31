"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api, errorMessage, fmtBytes, getMe, getSaved, inkOn, setMe, setSaved, usePoll, type Me } from "@/lib/client";
import { groupBy, NOTE_MAX } from "@/lib/groups";
import { isJwt, playableType, uploadFile, createWakeLock, type UploadHandle } from "@/lib/upload";
import EvidenceEntryCard, { type EvidenceEntry } from "@/components/EvidenceEntry";

type Task = {
  id: string;
  title: string;
  points: number;
  scoring_mode: "fixed" | "quantity" | "competition";
  measurement_label: string;
  points_per_unit: number;
  competition_bonus: number;
  /** Set once an organizer picks the leader-bonus winner at the end of a round. */
  competition: { team: string; bonus: number } | null;
  requires_video: boolean;
  is_secret: boolean;
};

type Sub = {
  id: string;
  task_id: string;
  player_id: string;
  status: "uploading" | "pending" | "approved" | "rejected";
  points_awarded: number | null;
  measurement_value: number | null;
  reject_reason: string | null;
  created_at: string;
  judged_at: string | null;
  /** Files sharing this are one piece of evidence, judged as a unit. */
  groupId: string;
  note: string | null;
  mediaUrl: string;
  isVideo: boolean;
  playerName: string;
};

type Rejection = {
  id: string;
  taskId: string;
  taskTitle: string;
  reason: string | null;
  at: string;
};

type OtherTeamEntries = {
  entries: EvidenceEntry[];
};

type State = {
  settings: { round: number; submissions_open: boolean };
  me: Me | null;
  team: { id: string; name: string; color: string } | null;
  tasks: Task[];
  submissions: Sub[];
  stats: {
    submitted: number;
    pending: number;
    approved: number;
    rejected: number;
    points: number;
  };
  rejections: Rejection[];
  upload: { endpoint: string; anonKey: string; bucket: string };
};

type Job = {
  task: Task;
  fileName: string;
  size: number;
  pct: number;
  retries: number;
  status: "uploading" | "done" | "error";
  message?: string;
  /**
   * The submission every file in this batch hangs off, set as soon as the row is
   * reserved rather than when the bytes land -- so the note field is live while
   * the upload is still running, which is the dead time the player would
   * otherwise spend watching a progress bar.
   */
  anchorId: string | null;
  /** The note the group already carries, so the editor never opens blank over
      an explanation the team has already written. */
  note: string;
  /**
   * Whether anything in this batch actually reached the queue. A failure after
   * one file has landed is a very different message from a failure on the
   * first: telling the player nothing was sent would have them re-upload
   * something that is already waiting to be judged.
   */
  sent: boolean;
};

export default function SubmitPage() {
  const router = useRouter();
  const [me, setMeState] = useState<Me | null>(null);
  const [q, setQ] = useState("");
  // Loaded from localStorage alongside `me`, never before it. The task list is
  // gated on `me`, so the saved set is always ready by the time a star renders
  // -- no frame where every task claims to be unsaved.
  const [saved, setSavedState] = useState<Set<string>>(new Set());
  const [onlySaved, setOnlySaved] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [switching, setSwitching] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const pendingTask = useRef<Task | null>(null);
  // Set when the picker was opened by "Add another": the submission the next
  // file joins rather than stands beside, plus the note that group already
  // carries. Without the note the editor would open blank over an explanation
  // the team had already written, and typing would replace it unseen.
  const pendingGroup = useRef<{ anchorId: string; note: string } | null>(null);
  const handle = useRef<UploadHandle | null>(null);
  const currentSubmissionId = useRef<string | null>(null);
  // Set the moment tus reports success. From that point the bytes are already in
  // Storage and the row is being promoted, but the progress card is still
  // rendering "uploading" -- so Cancel is still on screen and still tappable.
  const settled = useRef(false);
  const wakeRef = useRef<ReturnType<typeof createWakeLock> | null>(null);
  if (!wakeRef.current) wakeRef.current = createWakeLock();
  const wake = wakeRef.current;

  useEffect(() => {
    const m = getMe();
    if (!m) router.replace("/");
    else {
      setMeState(m);
      setSavedState(getSaved(m.id));
    }
  }, [router]);

  const { data, reload, error } = usePoll<State>(
    me ? `/api/state?playerId=${encodeURIComponent(me.id)}` : null,
    5000
  );

  // The server is the authority on who exists. If a player row was deleted or
  // this device has stale identity, send them back rather than letting every
  // submission fail with a confusing error.
  useEffect(() => {
    if (data && me && !data.me) {
      setMe(null);
      router.replace("/");
    }
  }, [data, me, router]);

  const byTask = useMemo(() => {
    const m = new Map<string, Sub[]>();
    for (const s of data?.submissions ?? []) {
      const list = m.get(s.task_id) ?? [];
      list.push(s);
      m.set(s.task_id, list);
    }
    return m;
  }, [data]);

  const tasks = useMemo(() => {
    const list = data?.tasks ?? [];
    const needle = q.trim().toLowerCase();
    const found = needle ? list.filter((t) => t.title.toLowerCase().includes(needle)) : list;
    return onlySaved ? found.filter((t) => saved.has(t.id)) : found;
  }, [data, q, onlySaved, saved]);

  /* Counted against the round's live task list rather than the stored set, so
     ids left behind by the remix or by a task an organizer cut never inflate
     the number the chip shows. */
  const savedCount = useMemo(
    () => (data?.tasks ?? []).filter((t) => saved.has(t.id)).length,
    [data, saved]
  );

  const toggleSaved = (taskId: string) => {
    if (!me) return;
    /* Re-read storage at the moment of the tap rather than trusting the set
       this render closed over. Two things break if we trust the closure: a
       second tab (or a duplicate of this page opened from the QR code) holds a
       snapshot from ITS mount, and writing the whole set back would silently
       destroy every star the other tab added. Reading first makes localStorage
       the single source of truth and makes the write a merge, so no tap is ever
       lost. It also removes the stale-closure hazard in two toggles dispatched
       from one commit. The other tab's display stays stale until it reloads,
       which is cosmetic -- nothing is lost. */
    const next = getSaved(me.id);
    if (next.has(taskId)) next.delete(taskId);
    else next.add(taskId);
    setSaved(me.id, next);
    setSavedState(next);
  };

  const grouped = useMemo(() => {
    const g = new Map<number, Task[]>();
    for (const t of tasks) {
      const list = g.get(t.points) ?? [];
      list.push(t);
      g.set(t.points, list);
    }
    return [...g.entries()].sort((a, b) => a[0] - b[0]);
  }, [tasks]);

  /**
   * Open the file picker for a task. `groupWith` names a submission the new file
   * is another angle on, rather than a separate piece of evidence -- passed
   * straight through to the server, which decides whether the two may actually
   * be grouped.
   */
  const pickFor = (task: Task, group?: { anchorId: string; note: string }) => {
    pendingTask.current = task;
    pendingGroup.current = group ?? null;
    fileInput.current?.click();
  };

  /**
   * tus's abort(true) suppresses every callback -- neither onError nor onSuccess
   * fires afterwards. So cancelling has to drive the terminal state itself, or
   * the job sticks at "uploading" forever, which leaves every Upload button on
   * the page disabled and the progress card impossible to dismiss.
   */
  const cancelUpload = () => {
    // Once tus has succeeded there is nothing left to cancel: the bytes are in
    // Storage and the row is mid-promotion. Claiming "Nothing was sent" here
    // would send the player off to re-upload something already in the queue.
    if (settled.current) return;
    handle.current?.abort();
    handle.current = null;
    wake.release();
    const id = currentSubmissionId.current;
    currentSubmissionId.current = null;
    if (id) void api(`/api/submissions/${id}`, { method: "DELETE" }).catch(() => {});
    setJob(
      (j) =>
        j && {
          ...j,
          status: "error",
          message: j.sent
            ? "Cancelled. The file before it is still in the queue."
            : "Cancelled. Nothing was sent.",
          // The row this note would have been saved against has just been
          // deleted. Unless an earlier file in the batch survived, there is
          // nothing left to attach a note to.
          anchorId: j.sent ? j.anchorId : null,
        }
    );
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset immediately so picking the SAME file twice still fires a change event.
    e.target.value = "";
    const task = pendingTask.current;
    const group = pendingGroup.current;
    const groupWith = group?.anchorId;
    pendingTask.current = null;
    pendingGroup.current = null;
    if (!file || !task || !me || !data) return;

    if (!isJwt(data.upload.anonKey)) {
      setJob({
        task,
        fileName: file.name,
        size: file.size,
        pct: 0,
        retries: 0,
        status: "error",
        anchorId: null,
        note: "",
        sent: false,
        message:
          "The upload key on the server isn't valid. Tell an organizer: it must be the legacy anon key.",
      });
      return;
    }

    setJob((prev) => ({
      task,
      fileName: file.name,
      size: file.size,
      pct: 0,
      retries: 0,
      status: "uploading",
      // Another angle on the batch already on screen keeps its anchor, so the
      // note the player has been typing stays attached to the same group.
      anchorId: groupWith && prev?.anchorId === groupWith ? prev.anchorId : null,
      note: groupWith && prev?.anchorId === groupWith ? prev.note : (group?.note ?? ""),
      // Joining a group that is ALREADY in the queue counts as sent: cancelling
      // this file must not claim nothing was sent while its siblings wait to be
      // judged. That is the message this flag exists to prevent.
      sent: Boolean(groupWith) && (prev?.anchorId === groupWith ? Boolean(prev?.sent) : true),
    }));
    settled.current = false;

    let submissionId: string;
    let objectName: string;
    let contentType: string;
    try {
      // Reserve the row first. The server decides round, team and points; the
      // client only names a task and a file.
      const init = await api<{ submissionId: string; objectName: string; contentType: string }>(
        "/api/submissions",
        {
          method: "POST",
          body: JSON.stringify({
            playerId: me.id,
            taskId: task.id,
            fileName: file.name,
            fileType: file.type,
            groupWith: groupWith ?? undefined,
          }),
        }
      );
      submissionId = init.submissionId;
      objectName = init.objectName;
      contentType = init.contentType;
      currentSubmissionId.current = submissionId;
      // The row exists from here, so a note can be saved against it even though
      // the bytes are still moving.
      setJob((j) => j && { ...j, anchorId: j.anchorId ?? submissionId });
    } catch (err) {
      setJob(
        (j) =>
          j && { ...j, status: "error", message: errorMessage(err, "Could not start."), anchorId: j.sent ? j.anchorId : null }
      );
      return;
    }

    await wake.acquire();

    handle.current = uploadFile({
      file,
      objectName,
      // Server and client compute this the same way; passing the server's answer
      // keeps the stored content-type and the DB row from ever disagreeing.
      contentType: contentType || playableType(file),
      config: data.upload,
      onProgress: (sent, total) =>
        setJob((j) => j && { ...j, pct: Math.round((sent / total) * 100) }),
      onRetry: (n) => setJob((j) => j && { ...j, retries: n }),
      onError: (message) => {
        wake.release();
        handle.current = null;
        currentSubmissionId.current = null;
        setJob(
          (j) => j && { ...j, status: "error", message, anchorId: j.sent ? j.anchorId : null }
        );
        // Drop the placeholder row so it doesn't linger as a phantom submission.
        void api(`/api/submissions/${submissionId}`, { method: "DELETE" }).catch(() => {});
      },
      onSuccess: async () => {
        settled.current = true;
        wake.release();
        handle.current = null;
        currentSubmissionId.current = null;
        try {
          await api(`/api/submissions/${submissionId}`, {
            method: "PATCH",
            body: JSON.stringify({ sizeBytes: file.size, mediaType: contentType }),
          });
          setJob((j) => j && { ...j, pct: 100, status: "done", sent: true });
          reload();
        } catch (err) {
          // The bytes ARE in Storage; only the registration failed. Say so, and
          // leave the row for Admin to promote rather than deleting the media.
          setJob(
            (j) =>
              j && {
                ...j,
                status: "error",
                sent: true,
                message: `Uploaded, but couldn't register it: ${errorMessage(err)}. Tell an organizer — the file did arrive.`,
              }
          );
        }
      },
    });
  };

  if (!me) return <p className="muted" style={{ marginTop: 24 }}>Loading…</p>;

  const s = data?.stats;
  const closed = data && !data.settings.submissions_open;
  // One gate, two buttons: the retry button on a rejection and every task row's
  // Upload button open the same file picker, so they must agree about when that
  // is allowed. Written out twice they agreed only by copy-paste.
  const uploadBlocked = Boolean(closed) || !data?.team || job?.status === "uploading";

  return (
    <>
      <input
        ref={fileInput}
        type="file"
        // No `capture` attribute on purpose: people shoot first and upload after,
        // so they must be able to pick a clip from their camera roll.
        accept="image/*,video/*"
        onChange={onFile}
        style={{ display: "none" }}
      />

      {/* Tapping your own name switches player. Mis-taps on the join list are
          the realistic mistake here, and picking the wrong name can put you on
          the wrong TEAM -- which means your uploads credit the wrong
          scoreboard. So this has to be obvious, not buried at the bottom.

          Two lines rather than one: sharing a row with the team pill left a long
          team name to squeeze the h1, and a player looking at their own name
          rendered as "E." has no way to tell whether they picked the right
          person. On its own line the name always fits. */}
      <header style={{ margin: "18px 0 8px" }}>
        <button
          className="btn-plain row"
          style={{ gap: 8, minHeight: 44 }}
          onClick={() => setSwitching(true)}
          title="Not you? Tap to switch"
        >
          <h1 className="name" style={{ margin: 0 }}>{me.name}</h1>
          <span className="pill muted">switch</span>
        </button>
        <div className="row" style={{ marginTop: 2 }}>
          {data?.team ? (
            // Team colours are organizer-editable, so the label colour is derived
            // from the swatch rather than assumed to be white.
            <span
              className="pill pill-wrap"
              style={{
                background: data.team.color,
                color: inkOn(data.team.color),
                borderColor: data.team.color,
              }}
            >
              {data.team.name}
            </span>
          ) : data ? (
            <span className="pill pill-warn">no team</span>
          ) : (
            // Before the first poll lands `data` is null, which is not the same as
            // "not on a team". Warning here would tell every player they were
            // unrostered for as long as the request takes.
            <span className="pill muted">…</span>
          )}
          <span className="muted tiny push">R{data?.settings.round ?? "–"}</span>
        </div>
      </header>

      {switching && (
        <div className="card card-accent">
          <b>You&apos;re submitting as {me.name}</b>
          <p className="muted tiny" style={{ margin: "4px 0 10px" }}>
            {s && s.submitted > 0
              ? `${s.submitted} submission${s.submitted === 1 ? "" : "s"} already went in under this name. Switching won't move those — ask an organizer if any of them are on the wrong team.`
              : "Nothing has been submitted under this name yet, so switching is clean."}
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              className="btn btn-sm btn-primary"
              style={{ flex: 1 }}
              onClick={() => {
                setMe(null);
                router.replace("/");
              }}
            >
              Pick a different name
            </button>
            <button className="btn btn-sm" onClick={() => setSwitching(false)}>
              Stay
            </button>
          </div>
        </div>
      )}

      {error && <div className="card card-bad tiny bad">Connection hiccup — retrying. ({error})</div>}

      {data && !data.team && (
        <div className="card card-bad">
          <b className="warn">You&apos;re not on a Round {data.settings.round} team yet.</b>
          <p className="muted tiny" style={{ margin: "6px 0 0" }}>
            Grab an organizer. Until then your submissions can&apos;t be scored, so don&apos;t
            upload anything.
          </p>
        </div>
      )}

      {closed && (
        <div className="card card-bad">
          <b className="warn">Submissions are closed right now.</b>
        </div>
      )}

      {s && (
        <div className="card row" style={{ gap: 14, justifyContent: "space-between" }}>
          <Stat label="points" value={s.points} big />
          <Stat label="scored" value={s.approved} />
          <Stat label="waiting" value={s.pending} />
          {s.rejected > 0 && <Stat label="rejected" value={s.rejected} />}
        </div>
      )}

      {/* A rejected team that isn't told has simply lost those points -- they
          will never know to redo it. This sits above the task list until the
          task gets an approved submission, at which point it disappears on its
          own. Tapping jumps to the task so the retry is one action. */}
      {(data?.rejections ?? []).length > 0 && (
        <div className="card card-bad">
          <b className="bad">
            {data!.rejections.length} rejected — redo {data!.rejections.length === 1 ? "it" : "them"}{" "}
            to get the points
          </b>
          <div className="stack" style={{ marginTop: 10 }}>
            {data!.rejections.map((r) => (
              <div key={r.id} className="row" style={{ gap: 8 }}>
                <div className="grow">
                  <div style={{ fontWeight: 600, fontSize: 15 }}>{r.taskTitle}</div>
                  <div className="muted tiny">{r.reason || "No reason given"}</div>
                </div>
                <button
                  className="btn btn-sm"
                  disabled={uploadBlocked}
                  onClick={() => {
                    const task = data?.tasks.find((x) => x.id === r.taskId);
                    if (task) pickFor(task);
                  }}
                >
                  Retry
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {job && (
        <JobCard
          job={job}
          onClose={() => setJob(null)}
          onCancel={cancelUpload}
          onAddAnother={() =>
            pickFor(job.task, job.anchorId ? { anchorId: job.anchorId, note: job.note } : undefined)
          }
          addAnotherBlocked={uploadBlocked}
        />
      )}

      <input
        className="field"
        placeholder="Search tasks"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        autoComplete="off"
        style={{ margin: "6px 0 4px" }}
      />

      {/* Stays on screen whenever the filter is ON, even at zero saved tasks.
          Hiding it at that moment would take away the only control that undoes
          it and leave the player staring at an empty list. It only disappears
          when there is nothing saved AND the filter is already off, where there
          is no state to strand. */}
      {(savedCount > 0 || onlySaved) && (
        <div className="row" style={{ margin: "0 0 4px" }}>
          <button
            className={`btn btn-sm saved-filter${onlySaved ? " is-on" : ""}`}
            aria-pressed={onlySaved}
            onClick={() => setOnlySaved((v) => !v)}
          >
            ★ Saved · {savedCount}
          </button>
          {onlySaved && <span className="muted tiny">showing saved only</span>}
        </div>
      )}

      {data && grouped.length === 0 && onlySaved && (
        <div className="empty">
          {/* Three different truths, and saying the wrong one is its own small
              bug: after the remix a player who saved five Round 1 tasks has a
              full shortlist and an empty round, which is not "nothing saved".
              saved.size is what they stored; savedCount is what survives into
              this round's list. */}
          <b>
            {saved.size === 0
              ? "Nothing saved yet"
              : savedCount === 0
                ? "None of your saved tasks are in this round"
                : "No saved tasks match that search"}
          </b>
          {saved.size === 0
            ? "Tap ☆ on any task to keep it here for later."
            : savedCount === 0
              ? "This half of the hunt has its own task list — star the ones you want from it."
              : "Clear the search to see the rest of your saved tasks."}
          <div>
            <button
              className="btn btn-sm"
              style={{ marginTop: 12 }}
              onClick={() => setOnlySaved(false)}
            >
              Show all tasks
            </button>
          </div>
        </div>
      )}

      {data && grouped.length === 0 && !onlySaved && (
        <div className="empty">
          <b>No tasks match</b>
          Try a shorter search.
        </div>
      )}

      {grouped.map(([points, list]) => (
        <section key={points}>
          <h2 className="eyebrow">
            {points} point{points === 1 ? "" : "s"}
          </h2>
          <div className="stack">
            {list.map((t) => (
              <TaskRow
                key={t.id}
                task={t}
                subs={byTask.get(t.id) ?? []}
                disabled={uploadBlocked}
                playerId={me.id}
                saved={saved.has(t.id)}
                onToggleSaved={() => toggleSaved(t.id)}
                onPick={() => pickFor(t)}
                onAddTo={(anchorId, note) => pickFor(t, { anchorId, note })}
                onChanged={reload}
              />
            ))}
          </div>
        </section>
      ))}

    </>
  );
}

function Stat({ label, value, big }: { label: string; value: number; big?: boolean }) {
  return (
    <div>
      <div className={big ? "stat-value big" : "stat-value"}>{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

function TaskRow({
  task,
  subs,
  disabled,
  playerId,
  saved,
  onToggleSaved,
  onPick,
  onAddTo,
  onChanged,
}: {
  task: Task;
  subs: Sub[];
  disabled: boolean;
  playerId: string;
  saved: boolean;
  onToggleSaved: () => void;
  onPick: () => void;
  onAddTo: (anchorId: string, note: string) => void;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [otherOpen, setOtherOpen] = useState(false);
  const { data: otherData, error: otherError } = usePoll<OtherTeamEntries>(
    otherOpen
      ? `/api/task-entries?taskId=${encodeURIComponent(task.id)}&playerId=${encodeURIComponent(playerId)}`
      : null,
    8000
  );
  const approved = subs
    .filter((s) => s.status === "approved")
    .sort((a, b) =>
      `${b.judged_at ?? ""}|${b.created_at}|${b.id}`.localeCompare(
        `${a.judged_at ?? ""}|${a.created_at}|${a.id}`
      )
    )[0];
  const pending = subs.find((s) => s.status === "pending" || s.status === "uploading");
  const rejected = subs.find((s) => s.status === "rejected");

  /* An "uploading" row has a path reserved but no bytes in Storage yet, so its
     URL would 404. Everything else is viewable. Newest first, matching the
     order the server sends. */
  const viewable = subs.filter((s) => s.status !== "uploading");
  // Several files sent as one piece of evidence are one thing to look at, and
  // one thing the judge will decide. Counting groups rather than files keeps
  // "See 2" meaning two submissions rather than two photos of the same moment.
  const groups = useMemo(
    () =>
      // Oldest file first WITHIN a group, so the player sees the set in the same
      // order the judge did. The list itself stays newest-group-first, which is
      // the order the server sends.
      groupBy(viewable, (s) => s.groupId).map((files) =>
        [...files].sort((a, b) => a.created_at.localeCompare(b.created_at))
      ),
    [viewable]
  );

  return (
    <div className={`card card-flat${approved ? " card-done" : ""}`}>
      <div className="task-content">
        <div>
          <div className="row" style={{ alignItems: "flex-start" }}>
            <div className="grow" style={{ fontWeight: 600, lineHeight: 1.35 }}>
              {task.title}
            </div>
            {/* Sits on the title line rather than in the action row below: on a
                list this long it gets tapped far more often than Upload, and it
                must not push the real actions around as titles wrap. */}
            <button
              className={`btn btn-sm btn-star${saved ? " is-on" : ""}`}
              aria-label="Save for later"
              aria-pressed={saved}
              onClick={onToggleSaved}
            >
              {saved ? "★" : "☆"}
            </button>
          </div>
          <div className="row" style={{ gap: 6, marginTop: 7, flexWrap: "wrap" }}>
            {task.requires_video && <span className="pill">video only</span>}
            {task.scoring_mode === "quantity" && (
              <span className="pill pill-accent">
                +{task.points_per_unit} per extra {task.measurement_label || "item"}
              </span>
            )}
            {task.scoring_mode === "competition" && (
              <span className="pill pill-warn pill-wrap">
                best one wins +{task.competition_bonus} at the end of the round
              </span>
            )}
            {task.is_secret && (
              <span className="pill pill-warn">secret · {task.points} pts</span>
            )}
            {task.competition && (
              <span className="pill pill-wrap">
                {task.competition.team} won +{task.competition.bonus}
              </span>
            )}
            {approved && (
              <span className="pill pill-good">✓ {approved.points_awarded ?? 0} pts</span>
            )}
            {!approved && pending && <span className="pill">waiting on judge</span>}
            {!approved && !pending && rejected && (
              <span className="pill pill-bad pill-wrap">
                ✗ {rejected.reject_reason || "rejected"}
              </span>
            )}
          </div>
        </div>
        {/* Keep all task wording readable before presenting the controls. The
            long "other teams" action gets its own wrapped line, while shorter
            actions can share the row below it. */}
        <div className="row task-actions" style={{ gap: 6, flexWrap: "wrap", marginTop: 10 }}>
          <button
            className="btn btn-sm"
            style={{ flex: "1 1 120px" }}
            disabled={disabled}
            onClick={onPick}
          >
            {approved || pending ? "Redo" : "Upload"}
          </button>
          {groups.length > 0 && (
            <button
              className="btn btn-sm"
              style={{ flex: "1 1 120px" }}
              onClick={() => setOpen((v) => !v)}
            >
              {open ? "Hide" : groups.length > 1 ? `See ${groups.length}` : "See"}
            </button>
          )}
          <button
            className="btn btn-sm"
            style={{ flex: "1 1 100%" }}
            onClick={() => setOtherOpen((v) => !v)}
            aria-expanded={otherOpen}
          >
            {otherOpen ? "Hide other teams" : "See other teams' entries"}
          </button>
        </div>
      </div>

      {open && (
        <div className="stack" style={{ marginTop: 12 }}>
          {groups.map((files) => (
            <SubmissionView
              key={files[0].groupId}
              files={files}
              mine={files[0].player_id === playerId}
              disabled={disabled}
              onAddTo={onAddTo}
              onChanged={onChanged}
            />
          ))}
        </div>
      )}

      {otherOpen && (
        <div className="card card-flat" style={{ marginTop: 12, background: "var(--line-soft)" }}>
          <div className="row" style={{ marginBottom: 8 }}>
            <b>Other teams&apos; entries</b>
            {otherData && (
              <span className="muted tiny push">
                {otherData.entries.length} scored
              </span>
            )}
          </div>
          {otherError && <div className="card card-bad tiny bad">{otherError}</div>}
          {!otherData && !otherError && <p className="muted tiny">Loading…</p>}
          {otherData && otherData.entries.length === 0 && (
            <div className="empty" style={{ margin: 0, padding: "18px 10px" }}>
              <b>No other team has scored this task yet</b>
              Keep moving.
            </div>
          )}
          {otherData?.entries.map((entry) => (
            <EvidenceEntryCard key={entry.id} entry={entry} />
          ))}
        </div>
      )}
    </div>
  );
}

/** One of the team's submissions for a task: what was sent, by whom, and where
    it got to. Rendered only while expanded, so nothing downloads until asked.

    "One" can be several files -- a photo and the clip that explains it -- which
    the judge sees and decides together. They are laid out one under another
    rather than in a carousel: a carousel hides evidence behind a gesture, and
    the person reviewing this has already told us they want to look. */
function SubmissionView({
  files,
  mine,
  disabled,
  onAddTo,
  onChanged,
}: {
  files: Sub[];
  mine: boolean;
  disabled: boolean;
  onAddTo: (anchorId: string, note: string) => void;
  onChanged: () => void;
}) {
  const sub = files[0];
  const waiting = sub.status === "pending" || sub.status === "uploading";
  // Read off whichever file carries it rather than off the first, so the note
  // survives a member that predates it -- the same rule the judge screen and
  // the feed follow.
  const groupNote = files.find((f) => f.note)?.note ?? null;
  const label =
    sub.status === "approved"
      ? `✓ ${sub.points_awarded ?? 0} pts`
      : sub.status === "rejected"
        ? `✗ ${sub.reject_reason || "rejected"}`
        : "waiting on judge";

  return (
    <div>
      <div className="row" style={{ gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
        <span className="name tiny muted">{mine ? "you" : sub.playerName}</span>
        {files.length > 1 && (
          <span className="pill">
            {files.length} files
          </span>
        )}
        <span
          className={`pill pill-wrap push ${
            sub.status === "approved" ? "pill-good" : sub.status === "rejected" ? "pill-bad" : ""
          }`}
        >
          {label}
        </span>
      </div>

      <div className="stack" style={{ gap: 8 }}>
        {files.map((f) => (
          <div className="media-box" key={f.id}>
            {f.isVideo ? (
              /* Same iOS rule as the feed: preload="auto" and the #t=0.1
                 fragment, or Safari renders an untappable black box. */
              <video className="media" controls playsInline preload="auto" src={`${f.mediaUrl}#t=0.1`} />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img className="media" src={f.mediaUrl} alt="Your submission" />
            )}
          </div>
        ))}
      </div>

      {/* Still waiting means the note can still change the judge's mind, so it
          stays editable. Once judged it is shown as it was, because a caption
          rewritten under a decision is something the judge never saw. */}
      {waiting ? (
        <NoteEditor submissionId={sub.id} initial={groupNote ?? ""} onSaved={onChanged} />
      ) : (
        groupNote && (
          <p className="tiny muted" style={{ margin: "8px 0 0", overflowWrap: "anywhere" }}>
            “{groupNote}”
          </p>
        )
      )}

      {waiting && (
        <button
          className="btn btn-sm"
          style={{ marginTop: 8 }}
          disabled={disabled}
          onClick={() => onAddTo(sub.id, groupNote ?? "")}
        >
          Add another file to this
        </button>
      )}
    </div>
  );
}

/**
 * The player's own note on a submission: what the judge is looking at.
 *
 * Saved on blur rather than behind a Save button, because the realistic ending
 * to typing a note on a phone mid-scavenger-hunt is putting the phone away, not
 * tapping one more control. Blur fires before the click that dismisses the card,
 * so tapping OK saves too. The state line exists so a save that fails is
 * visible: silently losing the note would be worse than not offering one.
 */
function NoteEditor({
  submissionId,
  initial,
  onSaved,
}: {
  submissionId: string;
  initial: string;
  onSaved?: () => void;
}) {
  const [text, setText] = useState(initial);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  // What the server is known to hold. Compared against on every blur so
  // re-blurring an unchanged box doesn't fire a pointless write.
  const stored = useRef(initial);

  const save = async () => {
    const value = text.trim();
    if (value === stored.current) return;
    setState("saving");
    try {
      await api(`/api/submissions/${submissionId}`, {
        method: "PATCH",
        body: JSON.stringify({ noteOnly: true, note: value }),
      });
      stored.current = value;
      setState("saved");
      onSaved?.();
    } catch {
      setState("error");
    }
  };

  return (
    <div style={{ marginTop: 8 }}>
      <textarea
        className="field"
        rows={2}
        maxLength={NOTE_MAX}
        placeholder="Add a note for the judge (optional)"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setState("idle");
        }}
        onBlur={save}
        style={{ resize: "none" }}
      />
      <div className="row" style={{ marginTop: 4 }}>
        <span className="tiny muted grow">
          {state === "saving" && "Saving…"}
          {state === "saved" && "Note saved."}
          {state === "error" && <span className="bad">Couldn&apos;t save that note.</span>}
        </span>
        {state === "error" && (
          <button className="btn btn-sm" onClick={save}>
            Retry
          </button>
        )}
      </div>
    </div>
  );
}

function JobCard({
  job,
  onClose,
  onCancel,
  onAddAnother,
  addAnotherBlocked,
}: {
  job: Job;
  onClose: () => void;
  onCancel: () => void;
  onAddAnother: () => void;
  addAnotherBlocked: boolean;
}) {
  const tone =
    job.status === "error" ? "card-bad" : job.status === "done" ? "card-good" : "card-accent";
  return (
    <div className={`card ${tone}`}>
      <div style={{ fontWeight: 700, lineHeight: 1.3 }}>{job.task.title}</div>
      <div className="muted tiny" style={{ marginBottom: 10 }}>
        {job.fileName} · {fmtBytes(job.size)}
        {job.retries > 0 && ` · retry ${job.retries}`}
      </div>

      {job.status === "uploading" && (
        <>
          <div className="bar">
            <i style={{ width: `${job.pct}%` }} />
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <span className="tiny muted grow">
              <b className="num">{job.pct}%</b> — keep this screen open
            </span>
            <button className="btn btn-sm" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </>
      )}

      {job.status === "done" && (
        <div className="row">
          <b className="good grow">Sent. It&apos;s in the judge&apos;s queue.</b>
          <button className="btn btn-sm" onClick={onClose}>
            OK
          </button>
        </div>
      )}

      {job.status === "error" && (
        <div>
          <b className="bad">Didn&apos;t send.</b>
          <p className="tiny" style={{ margin: "4px 0 10px" }}>
            {job.message}
          </p>
          <p className="tiny muted" style={{ margin: "0 0 10px" }}>
            Your photo is still on your phone. Try again, or text it to an organizer.
          </p>
          <button className="btn btn-sm" onClick={onClose}>
            Dismiss
          </button>
        </div>
      )}

      {/* The note goes here, next to the progress bar, because the upload is
          dead time the player is already spending looking at this card. The row
          exists from the moment it is reserved, so this is live before the bytes
          have finished moving. */}
      {job.anchorId && job.status !== "error" && (
        <NoteEditor key={job.anchorId} submissionId={job.anchorId} initial={job.note} />
      )}

      {/* Some tasks need two photos, or a photo and the clip that explains it.
          Adding one at a time reuses the upload path exactly as it is rather
          than introducing a batch, and a file that fails still leaves the ones
          before it safely in the queue. */}
      {job.anchorId && job.status !== "uploading" && (
        <button
          className="btn btn-sm btn-wide"
          style={{ marginTop: 8 }}
          disabled={addAnotherBlocked}
          onClick={onAddAnother}
        >
          Add another photo or clip to this
        </button>
      )}
    </div>
  );
}
