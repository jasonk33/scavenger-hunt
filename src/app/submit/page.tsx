"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api, errorMessage, fmtBytes, getMe, inkOn, setMe, usePoll, type Me } from "@/lib/client";
import { isJwt, playableType, uploadFile, createWakeLock, type UploadHandle } from "@/lib/upload";

type Task = {
  id: string;
  title: string;
  points: number;
  requires_video: boolean;
  is_secret: boolean;
};

type Sub = {
  id: string;
  task_id: string;
  status: "uploading" | "pending" | "approved" | "rejected";
  points_awarded: number | null;
  bonus: number;
  reject_reason: string | null;
};

type Rejection = {
  id: string;
  taskId: string;
  taskTitle: string;
  reason: string | null;
  at: string;
};

type State = {
  settings: { round: number; submissions_open: boolean; event_name: string };
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
  configOk: boolean;
};

type Job = {
  taskTitle: string;
  fileName: string;
  size: number;
  pct: number;
  retries: number;
  status: "uploading" | "done" | "error";
  message?: string;
};

export default function SubmitPage() {
  const router = useRouter();
  const [me, setMeState] = useState<Me | null>(null);
  const [q, setQ] = useState("");
  const [job, setJob] = useState<Job | null>(null);
  const [switching, setSwitching] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const pendingTask = useRef<Task | null>(null);
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
    else setMeState(m);
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
    return needle ? list.filter((t) => t.title.toLowerCase().includes(needle)) : list;
  }, [data, q]);

  const grouped = useMemo(() => {
    const g = new Map<number, Task[]>();
    for (const t of tasks) {
      const list = g.get(t.points) ?? [];
      list.push(t);
      g.set(t.points, list);
    }
    return [...g.entries()].sort((a, b) => a[0] - b[0]);
  }, [tasks]);

  const pickFor = (task: Task) => {
    pendingTask.current = task;
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
    setJob((j) => j && { ...j, status: "error", message: "Cancelled. Nothing was sent." });
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset immediately so picking the SAME file twice still fires a change event.
    e.target.value = "";
    const task = pendingTask.current;
    pendingTask.current = null;
    if (!file || !task || !me || !data) return;

    if (!isJwt(data.upload.anonKey)) {
      setJob({
        taskTitle: task.title,
        fileName: file.name,
        size: file.size,
        pct: 0,
        retries: 0,
        status: "error",
        message:
          "The upload key on the server isn't valid. Tell an organizer: it must be the legacy anon key.",
      });
      return;
    }

    setJob({
      taskTitle: task.title,
      fileName: file.name,
      size: file.size,
      pct: 0,
      retries: 0,
      status: "uploading",
    });
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
          }),
        }
      );
      submissionId = init.submissionId;
      objectName = init.objectName;
      contentType = init.contentType;
      currentSubmissionId.current = submissionId;
    } catch (err) {
      setJob((j) => j && { ...j, status: "error", message: errorMessage(err, "Could not start.") });
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
        setJob((j) => j && { ...j, status: "error", message });
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
          setJob((j) => j && { ...j, pct: 100, status: "done" });
          reload();
        } catch (err) {
          // The bytes ARE in Storage; only the registration failed. Say so, and
          // leave the row for Admin to promote rather than deleting the media.
          setJob(
            (j) =>
              j && {
                ...j,
                status: "error",
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
          scoreboard. So this has to be obvious, not buried at the bottom. */}
      <header className="row" style={{ margin: "18px 0 8px" }}>
        <button
          className="btn-plain row"
          style={{ gap: 8, minHeight: 44 }}
          onClick={() => setSwitching(true)}
          title="Not you? Tap to switch"
        >
          <h1 className="nowrap" style={{ margin: 0 }}>
            {me.name}
          </h1>
          <span className="pill muted">switch</span>
        </button>
        {data?.team ? (
          // Team colours are organizer-editable, so the label colour is derived
          // from the swatch rather than assumed to be white.
          <span
            className="pill"
            style={{
              background: data.team.color,
              color: inkOn(data.team.color),
              borderColor: data.team.color,
            }}
          >
            {data.team.name}
          </span>
        ) : (
          <span className="pill pill-warn">no team</span>
        )}
        <span className="muted tiny push">R{data?.settings.round ?? "–"}</span>
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
                  disabled={Boolean(closed) || !data?.team || job?.status === "uploading"}
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
        <JobCard job={job} onClose={() => setJob(null)} onCancel={cancelUpload} />
      )}

      <input
        className="field"
        placeholder="Search tasks"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        autoComplete="off"
        style={{ margin: "6px 0 4px" }}
      />

      {data && grouped.length === 0 && (
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
                disabled={Boolean(closed) || !data?.team || job?.status === "uploading"}
                onPick={() => pickFor(t)}
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
  onPick,
}: {
  task: Task;
  subs: Sub[];
  disabled: boolean;
  onPick: () => void;
}) {
  const approved = subs.find((s) => s.status === "approved");
  const pending = subs.find((s) => s.status === "pending" || s.status === "uploading");
  const rejected = subs.find((s) => s.status === "rejected");

  return (
    <div className={`card card-flat${approved ? " card-done" : ""}`}>
      <div className="row" style={{ alignItems: "flex-start" }}>
        <div className="grow">
          <div style={{ fontWeight: 600, lineHeight: 1.35 }}>{task.title}</div>
          <div className="row" style={{ gap: 6, marginTop: 7, flexWrap: "wrap" }}>
            {task.requires_video && <span className="pill">video only</span>}
            {task.is_secret && (
              <span className="pill pill-warn">secret · {task.points} pts</span>
            )}
            {approved && (
              <span className="pill pill-good">
                ✓ {(approved.points_awarded ?? 0) + approved.bonus} pts
                {approved.bonus > 0 ? ` (+${approved.bonus} bonus)` : ""}
              </span>
            )}
            {!approved && pending && <span className="pill">waiting on judge</span>}
            {!approved && !pending && rejected && (
              <span className="pill pill-bad">✗ {rejected.reject_reason || "rejected"}</span>
            )}
          </div>
        </div>
        <button
          className="btn btn-sm"
          disabled={disabled}
          onClick={onPick}
        >
          {approved || pending ? "Redo" : "Upload"}
        </button>
      </div>
    </div>
  );
}

function JobCard({ job, onClose, onCancel }: { job: Job; onClose: () => void; onCancel: () => void }) {
  const tone =
    job.status === "error" ? "card-bad" : job.status === "done" ? "card-good" : "card-accent";
  return (
    <div className={`card ${tone}`}>
      <div style={{ fontWeight: 700, lineHeight: 1.3 }}>{job.taskTitle}</div>
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
    </div>
  );
}
