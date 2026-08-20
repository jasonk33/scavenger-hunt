"use client";

import { useEffect, useMemo, useState } from "react";
import { api, errorMessage, usePoll } from "@/lib/client";

type AdminData = {
  settings: {
    active_round: number;
    submissions_open: boolean;
    fallback_url: string;
    event_name: string;
    notice: string;
  };
  players: Array<{ id: string; name: string }>;
  teams: Array<{ id: string; round: number; name: string; color: string }>;
  roster: Array<{ round: number; player_id: string; team_id: string }>;
  tasks: Array<{
    id: string;
    round: number;
    title: string;
    points: number;
    requires_video: boolean;
    is_secret: boolean;
    revealed_at: string | null;
    active: boolean;
  }>;
  stuck: Array<{
    id: string;
    round: number;
    playerName: string;
    taskTitle: string;
    createdAt: string;
    mediaUrl: string;
  }>;
  counts: Record<string, { total: number; uploading: number; pending: number; approved: number; rejected: number }>;
};

export default function AdminPage() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState("");

  useEffect(() => {
    api("/api/admin/data")
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

  return <Admin />;
}

function Admin() {
  const { data, reload } = usePoll<AdminData>("/api/admin/data", 8000);
  const [tab, setTab] = useState<"event" | "roster" | "tasks" | "health">("event");
  const [err, setErr] = useState("");

  const run = async (fn: () => Promise<unknown>) => {
    setErr("");
    try {
      await fn();
      await reload();
    } catch (e) {
      setErr(errorMessage(e, "Failed"));
    }
  };

  if (!data) return <p className="muted" style={{ marginTop: 24 }}>Loading…</p>;

  return (
    <>
      <h1 style={{ fontSize: 24, margin: "16px 0 8px" }}>Admin</h1>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
        {(["event", "roster", "tasks", "health"] as const).map((t) => (
          <button
            key={t}
            className={`btn btn-sm ${tab === t ? "btn-primary" : ""}`}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>

      {err && <div className="card bad tiny">{err}</div>}

      {tab === "event" && <EventTab data={data} run={run} />}
      {tab === "roster" && <RosterTab data={data} run={run} />}
      {tab === "tasks" && <TasksTab data={data} run={run} />}
      {tab === "health" && <HealthTab data={data} run={run} />}
    </>
  );
}

function EventTab({ data, run }: { data: AdminData; run: (fn: () => Promise<unknown>) => void }) {
  const s = data.settings;
  const [notice, setNotice] = useState(s.notice);
  const [fallback, setFallback] = useState(s.fallback_url);

  const save = (patch: Record<string, unknown>) =>
    run(() => api("/api/admin/settings", { method: "POST", body: JSON.stringify(patch) }));

  return (
    <>
      <div className="card">
        <b>Active round</b>
        <p className="muted tiny" style={{ margin: "2px 0 8px" }}>
          Switching this changes which task list players see and which roster their submissions are
          attributed to. Do it at the break, after Round 1 uploads have drained.
        </p>
        <div style={{ display: "flex", gap: 8 }}>
          {[1, 2].map((r) => (
            <button
              key={r}
              className={`btn ${s.active_round === r ? "btn-primary" : ""}`}
              style={{ flex: 1 }}
              onClick={() => save({ active_round: r })}
            >
              Round {r}
            </button>
          ))}
        </div>
      </div>

      <div className="card">
        <b>Submissions</b>
        <p className="muted tiny" style={{ margin: "2px 0 8px" }}>
          Close this during the break so stragglers don&apos;t land Round 1 evidence in Round 2.
        </p>
        <button
          className={`btn btn-wide ${s.submissions_open ? "btn-good" : "btn-bad"}`}
          onClick={() => save({ submissions_open: String(!s.submissions_open) })}
        >
          {s.submissions_open ? "Open — tap to close" : "Closed — tap to open"}
        </button>
      </div>

      <div className="card">
        <b>Banner</b>
        <p className="muted tiny" style={{ margin: "2px 0 8px" }}>
          Shows on every screen within 15 seconds. Leave empty to hide.
        </p>
        <input
          className="field"
          value={notice}
          placeholder="e.g. Secret challenge is live — check your list"
          onChange={(e) => setNotice(e.target.value)}
        />
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <button className="btn btn-sm btn-primary" onClick={() => save({ notice })}>
            Post
          </button>
          <button
            className="btn btn-sm"
            onClick={() => {
              setNotice("");
              save({ notice: "" });
            }}
          >
            Clear
          </button>
        </div>
      </div>

      <div className="card">
        <b>Fallback redirect</b>
        <p className="muted tiny" style={{ margin: "2px 0 8px" }}>
          Anyone who opens <code>/go</code> gets sent here instead. Point your QR code at{" "}
          <code>/go</code> so you can move everyone without re-printing anything.
        </p>
        <input
          className="field"
          value={fallback}
          placeholder="https://… (empty = stay in the app)"
          onChange={(e) => setFallback(e.target.value)}
        />
        <button
          className="btn btn-sm btn-primary"
          style={{ marginTop: 8 }}
          onClick={() => save({ fallback_url: fallback })}
        >
          Save
        </button>
      </div>

      <div className="card">
        <b>Export</b>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
          <a className="btn btn-sm" href="/api/export">
            JSON
          </a>
          <a className="btn btn-sm" href="/api/export?format=csv">
            CSV
          </a>
          <a className="btn btn-sm" href="/api/export?format=sh">
            Media download script
          </a>
        </div>
        <p className="muted tiny" style={{ marginBottom: 0, marginTop: 8 }}>
          The script downloads every photo and video into round/team folders. Run it in an empty
          directory: <code>bash download-media.sh</code>
        </p>
      </div>
    </>
  );
}

function RosterTab({ data, run }: { data: AdminData; run: (fn: () => Promise<unknown>) => void }) {
  const [round, setRound] = useState(data.settings.active_round);
  const [names, setNames] = useState("");

  const teams = data.teams.filter((t) => t.round === round);
  const assigned = new Map(
    data.roster.filter((r) => r.round === round).map((r) => [r.player_id, r.team_id])
  );

  const setTeam = (playerId: string, teamId: string) =>
    run(() =>
      api("/api/admin/roster", {
        method: "POST",
        body: JSON.stringify({ round, playerId, teamId: teamId || null }),
      })
    );

  const unassigned = data.players.filter((p) => !assigned.get(p.id)).length;

  return (
    <>
      <div className="card">
        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          {[1, 2].map((r) => (
            <button
              key={r}
              className={`btn btn-sm ${round === r ? "btn-primary" : ""}`}
              onClick={() => setRound(r)}
            >
              Round {r}
            </button>
          ))}
          <button
            className="btn btn-sm"
            style={{ marginLeft: "auto" }}
            onClick={() =>
              run(() =>
                api("/api/admin/roster", {
                  method: "PUT",
                  body: JSON.stringify({ from: round === 1 ? 2 : 1, to: round }),
                })
              )
            }
          >
            Copy from Round {round === 1 ? 2 : 1}
          </button>
        </div>

        {/* Editing Round 2 here IS the remix. Round 1 submissions carry their
            team on the row, so nothing already scored can move. */}
        <p className="muted tiny" style={{ marginTop: 0 }}>
          {unassigned > 0 ? (
            <b className="warn">
              {unassigned} player{unassigned === 1 ? "" : "s"} not on a Round {round} team — they
              can&apos;t submit.
            </b>
          ) : (
            "Everyone is assigned."
          )}
        </p>

        <div style={{ display: "grid", gap: 6 }}>
          {data.players.map((p) => (
            <div key={p.id} style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span style={{ flex: 1, minWidth: 0 }}>{p.name}</span>
              <select
                className="field"
                style={{ width: 200, minHeight: 44 }}
                value={assigned.get(p.id) ?? ""}
                onChange={(e) => setTeam(p.id, e.target.value)}
              >
                <option value="">— none —</option>
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <b>Add players</b>
        <p className="muted tiny" style={{ margin: "2px 0 8px" }}>
          One name per line. Safe to paste the whole guest list — duplicates are ignored.
        </p>
        <textarea
          className="field"
          rows={4}
          value={names}
          onChange={(e) => setNames(e.target.value)}
          style={{ minHeight: 90 }}
        />
        <button
          className="btn btn-sm btn-primary"
          style={{ marginTop: 8 }}
          disabled={!names.trim()}
          onClick={() =>
            run(async () => {
              await api("/api/admin/players", { method: "POST", body: JSON.stringify({ names }) });
              setNames("");
            })
          }
        >
          Add
        </button>
      </div>
    </>
  );
}

function TasksTab({ data, run }: { data: AdminData; run: (fn: () => Promise<unknown>) => void }) {
  const [round, setRound] = useState(data.settings.active_round);
  const [title, setTitle] = useState("");
  const [points, setPoints] = useState(3);

  const tasks = useMemo(
    () => data.tasks.filter((t) => t.round === round),
    [data.tasks, round]
  );
  const secrets = tasks.filter((t) => t.is_secret);

  const patch = (body: Record<string, unknown>) =>
    run(() => api("/api/admin/tasks", { method: "PATCH", body: JSON.stringify(body) }));

  return (
    <>
      <div style={{ display: "flex", gap: 8, margin: "10px 0" }}>
        {[1, 2].map((r) => (
          <button
            key={r}
            className={`btn btn-sm ${round === r ? "btn-primary" : ""}`}
            onClick={() => setRound(r)}
          >
            Round {r}
          </button>
        ))}
      </div>

      <div className="card">
        <b>Secret challenges</b>
        <p className="muted tiny" style={{ margin: "2px 0 8px" }}>
          Hidden from players until you reveal them. Reveal is manual on purpose — a timer would
          fire while the round is running late.
        </p>
        <div style={{ display: "grid", gap: 6 }}>
          {secrets.map((t) => (
            <div key={t.id} style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span style={{ flex: 1 }}>{t.title}</span>
              <button
                className={`btn btn-sm ${t.revealed_at ? "btn-good" : ""}`}
                onClick={() => patch({ id: t.id, revealed: !t.revealed_at })}
              >
                {t.revealed_at ? "Live" : "Reveal"}
              </button>
            </div>
          ))}
          {secrets.length === 0 && <span className="muted tiny">None for this round.</span>}
        </div>
      </div>

      <div className="card">
        <b>Add a task</b>
        <input
          className="field"
          placeholder="Task description"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          style={{ margin: "8px 0" }}
        />
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
          {[1, 3, 5, 7, 10].map((p) => (
            <button
              key={p}
              className={`btn btn-sm ${points === p ? "btn-primary" : ""}`}
              onClick={() => setPoints(p)}
            >
              {p}
            </button>
          ))}
        </div>
        <button
          className="btn btn-sm btn-primary"
          disabled={!title.trim()}
          onClick={() =>
            run(async () => {
              await api("/api/admin/tasks", {
                method: "POST",
                body: JSON.stringify({ round, title, points, isSecret: points === 7 }),
              });
              setTitle("");
            })
          }
        >
          Add to Round {round}
        </button>
      </div>

      <div className="card">
        <b>All tasks ({tasks.length})</b>
        <div style={{ display: "grid", gap: 4, marginTop: 8 }}>
          {tasks.map((t) => (
            <div
              key={t.id}
              style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
                opacity: t.active ? 1 : 0.45,
              }}
            >
              <span className="pill">{t.points}</span>
              <span
                className="tiny"
                style={{ flex: 1, minWidth: 0, textDecoration: t.active ? "none" : "line-through" }}
              >
                {t.title}
                {t.requires_video && <span className="muted"> · clip</span>}
              </span>
              {t.active && (
                <button
                  className="btn btn-sm"
                  onClick={() =>
                    run(() => api(`/api/admin/tasks?id=${t.id}`, { method: "DELETE" }))
                  }
                >
                  Remove
                </button>
              )}
              {!t.active && (
                <button className="btn btn-sm" onClick={() => patch({ id: t.id, active: true })}>
                  Restore
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function HealthTab({ data, run }: { data: AdminData; run: (fn: () => Promise<unknown>) => void }) {
  const { data: health } = usePoll<{
    ok: boolean;
    checks: Array<{ name: string; ok: boolean; detail: string }>;
  }>("/api/admin/health", 30000);

  return (
    <>
      <div className="card">
        <b>Pre-flight</b>
        <p className="muted tiny" style={{ margin: "2px 0 8px" }}>
          Run this the day before. It does a real upload to Storage — the same path a player&apos;s
          phone uses — so a bad key or a missing policy shows up now instead of at 1:05pm.
        </p>
        {!health && <span className="muted tiny">Checking…</span>}
        <div style={{ display: "grid", gap: 6 }}>
          {(health?.checks ?? []).map((c) => (
            <div key={c.name} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
              <span className={c.ok ? "good" : "bad"} style={{ fontWeight: 700 }}>
                {c.ok ? "✓" : "✕"}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 15 }}>{c.name}</div>
                <div className={`tiny ${c.ok ? "muted" : "bad"}`}>{c.detail}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {[1, 2].map((r) => {
        const c = data.counts[String(r)];
        if (!c) return null;
        return (
          <div key={r} className="card">
            <b>Round {r}</b>
            <div style={{ display: "flex", gap: 16, marginTop: 8, flexWrap: "wrap" }}>
              <Num label="total" v={c.total} />
              <Num label="pending" v={c.pending} />
              <Num label="approved" v={c.approved} />
              <Num label="rejected" v={c.rejected} />
              <Num label="stuck" v={c.uploading} />
            </div>
          </div>
        );
      })}

      <div className="card">
        <b>Stuck uploads</b>
        <p className="muted tiny" style={{ margin: "2px 0 8px" }}>
          Submissions that started but never finished — a phone died, a tab closed, or the upload
          landed but the app never heard back. They don&apos;t reach the judge queue on their own.
          <b> Open the file first:</b> if it plays, the media arrived and you can send it to the
          judge. If it 404s, ask the player to re-upload.
        </p>
        {data.stuck.length === 0 && <span className="good tiny">None.</span>}
        <div style={{ display: "grid", gap: 8 }}>
          {data.stuck.map((s) => (
            <div key={s.id} style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <div className="tiny" style={{ flex: 1, minWidth: 0 }}>
                R{s.round} · <b>{s.playerName}</b> · {s.taskTitle}
                <br />
                <span className="muted">{new Date(s.createdAt).toLocaleTimeString()}</span>
              </div>
              <a className="btn btn-sm" href={s.mediaUrl} target="_blank" rel="noreferrer">
                Open
              </a>
              <button
                className="btn btn-sm btn-good"
                onClick={() =>
                  run(() => api(`/api/submissions/${s.id}`, { method: "PATCH", body: "{}" }))
                }
              >
                Send to judge
              </button>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function Num({ label, v }: { label: string; v: number }) {
  return (
    <div>
      <div style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.1 }}>{v}</div>
      <div className="muted tiny">{label}</div>
    </div>
  );
}
