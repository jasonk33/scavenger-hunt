"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api, errorMessage, fmtBytes, getMe, setMe, usePoll, type Me } from "@/lib/client";
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
  const fileInput = useRef<HTMLInputElement>(null);
  const pendingTask = useRef<Task | null>(null);
  const handle = useRef<UploadHandle | null>(null);
  const currentSubmissionId = useRef<string | null>(null);
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

      <header style={{ display: "flex", alignItems: "baseline", gap: 10, margin: "16px 0 6px" }}>
        <h1 style={{ fontSize: 26, margin: 0 }}>{me.name}</h1>
        {data?.team ? (
          <span
            className="pill"
            style={{ background: data.team.color, color: "#fff", borderColor: data.team.color }}
          >
            {data.team.name}
          </span>
        ) : (
          <span className="pill warn">no team</span>
        )}
        <span className="muted tiny" style={{ marginLeft: "auto" }}>
          Round {data?.settings.round ?? "–"}
        </span>
      </header>

      {error && <div className="card bad tiny">Connection hiccup — retrying. ({error})</div>}

      {data && !data.team && (
        <div className="card">
          <b className="warn">You&apos;re not on a Round {data.settings.round} team yet.</b>
          <p className="muted tiny" style={{ margin: "6px 0 0" }}>
            Grab an organizer. Until then your submissions can&apos;t be scored, so don&apos;t
            upload anything.
          </p>
        </div>
      )}

      {closed && (
        <div className="card">
          <b className="warn">Submissions are closed right now.</b>
        </div>
      )}

      {s && (
        <div className="card" style={{ display: "flex", gap: 14, justifyContent: "space-between" }}>
          <Stat label="points" value={s.points} big />
          <Stat label="scored" value={s.approved} />
          <Stat label="waiting" value={s.pending} />
          {s.rejected > 0 && <Stat label="rejected" value={s.rejected} />}
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

      {data && grouped.length === 0 && <p className="muted">No tasks match.</p>}

      {grouped.map(([points, list]) => (
        <section key={points}>
          <h2 style={{ fontSize: 15, margin: "18px 0 6px" }} className="muted">
            {points} point{points === 1 ? "" : "s"}
          </h2>
          <div style={{ display: "grid", gap: 8 }}>
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

      <p className="muted tiny" style={{ marginTop: 28 }}>
        Signed in as {me.name}.{" "}
        <button
          className="tiny"
          style={{ background: "none", border: 0, textDecoration: "underline", padding: 0 }}
          onClick={() => {
            setMe(null);
            router.replace("/");
          }}
        >
          Not you?
        </button>
      </p>
    </>
  );
}

function Stat({ label, value, big }: { label: string; value: number; big?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: big ? 30 : 22, fontWeight: 700, lineHeight: 1.1 }}>{value}</div>
      <div className="muted tiny">{label}</div>
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
    <div className="card" style={{ margin: 0, padding: 12 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600 }}>{task.title}</div>
          <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
            {task.requires_video && <span className="pill">video only</span>}
            {task.is_secret && (
              <span className="pill" style={{ borderColor: "var(--warn)", color: "var(--warn)" }}>
                secret · {task.points} pts
              </span>
            )}
            {approved && (
              <span className="pill" style={{ borderColor: "var(--good)", color: "var(--good)" }}>
                ✓ {(approved.points_awarded ?? 0) + approved.bonus} pts
                {approved.bonus > 0 ? ` (+${approved.bonus} bonus)` : ""}
              </span>
            )}
            {!approved && pending && <span className="pill">waiting on judge</span>}
            {!approved && !pending && rejected && (
              <span className="pill" style={{ borderColor: "var(--bad)", color: "var(--bad)" }}>
                ✗ {rejected.reject_reason || "rejected"}
              </span>
            )}
          </div>
        </div>
        <button className="btn btn-sm" disabled={disabled} onClick={onPick}>
          {approved || pending ? "Redo" : "Upload"}
        </button>
      </div>
    </div>
  );
}

function JobCard({ job, onClose, onCancel }: { job: Job; onClose: () => void; onCancel: () => void }) {
  const tone =
    job.status === "error" ? "var(--bad)" : job.status === "done" ? "var(--good)" : "var(--accent)";
  return (
    <div className="card" style={{ borderColor: tone, borderWidth: 2 }}>
      <div style={{ fontWeight: 700 }}>{job.taskTitle}</div>
      <div className="muted tiny" style={{ marginBottom: 8 }}>
        {job.fileName} · {fmtBytes(job.size)}
        {job.retries > 0 && ` · retry ${job.retries}`}
      </div>

      {job.status === "uploading" && (
        <>
          <div className="bar">
            <i style={{ width: `${job.pct}%` }} />
          </div>
          <div
            style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8 }}
          >
            <span className="tiny muted">
              {job.pct}% — keep this screen open
            </span>
            <button className="btn btn-sm" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </>
      )}

      {job.status === "done" && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <b className="good">Sent. It&apos;s in the judge&apos;s queue.</b>
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
