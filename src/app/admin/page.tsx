"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage, usePoll } from "@/lib/client";
import { eventState, type EventPhase } from "@/lib/event";
import { useEvent } from "@/components/EventShell";
import OrganizerGate from "@/components/OrganizerGate";

type AdminData = {
  settings: {
    active_round: number;
    started_round: number;
    submissions_open: boolean;
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
    scoring_mode: "fixed" | "quantity";
    measurement_label: string;
    points_per_unit: number;
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
  resetEnabled: boolean;
};

export default function AdminPage() {
  return (
    <OrganizerGate endpoint="/api/admin/data" description="Event setup: players, teams, rounds, exports.">
      <Admin />
    </OrganizerGate>
  );
}

function Admin() {
  const { data, error, reload } = usePoll<AdminData>("/api/admin/data", 8000);
  const [tab, setTab] = useState<"event" | "roster" | "tasks" | "health">("event");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const writing = useRef(false);

  const run = async (fn: () => Promise<unknown>) => {
    if (writing.current) return;
    writing.current = true;
    setBusy(true);
    setErr("");
    try {
      await fn();
      await reload();
    } catch (e) {
      setErr(errorMessage(e, "Failed"));
    } finally {
      writing.current = false;
      setBusy(false);
    }
  };

  if (!data) return <p className={error ? "bad" : "muted"} style={{ marginTop: 24 }}>{error || "Loading…"}</p>;

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
      {error && <div className="card card-bad tiny">Couldn&apos;t refresh event settings: {error}. Retrying.</div>}

      {busy && <p className="muted tiny" role="status">Saving changes…</p>}
      <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        {tab === "event" && <EventTab data={data} run={run} />}
        {tab === "roster" && <RosterTab data={data} run={run} />}
        {tab === "tasks" && <TasksTab data={data} run={run} />}
        {tab === "health" && <HealthTab data={data} run={run} />}
      </fieldset>
    </>
  );
}

function EventTab({ data, run }: { data: AdminData; run: (fn: () => Promise<unknown>) => Promise<void> }) {
  const s = data.settings;
  const [notice, setNotice] = useState(s.notice);
  const [busy, setBusy] = useState(false);
  const [awaitingPhase, setAwaitingPhase] = useState<EventPhase | null>(null);
  const acting = useRef(false);
  const { reload: reloadEvent } = useEvent();
  const { phase } = eventState(s);
  const disabled = busy || awaitingPhase === phase;
  useEffect(() => {
    if (awaitingPhase !== null && awaitingPhase !== phase) setAwaitingPhase(null);
  }, [awaitingPhase, phase]);
  const steps = {
    welcome: { title: "Before Round 1", action: "start_round_1", label: "Start Round 1", help: "Reveals Round 1 tasks and opens uploads. Guests stay on Home until they choose Tasks." },
    round1: { title: "Round 1 in progress", action: "end_round_1", label: "End Round 1", help: "Closes new uploads. Round 1 tasks, scores and photos stay available, and judging can continue." },
    break: { title: "Break — Round 1 uploads closed", action: "reveal_round_2", label: "Reveal Round 2 teams", help: "Shows the remixed teams on Home, but keeps Round 2 tasks hidden. Wait for any Round 1 uploads still in progress." },
    remix: { title: "Round 2 teams revealed", action: "start_round_2", label: "Start Round 2", help: "Reveals Round 2 tasks and opens uploads when everyone has found their new team." },
    round2: { title: "Round 2 in progress", action: "end_round_2", label: "End Round 2", help: "Closes new uploads. Final tasks, scores and photos stay available, and judging can continue." },
    finished: { title: "Event finished", action: null, label: "", help: "Uploads are closed. Keep judging the remaining evidence." },
  };
  const step = steps[phase];
  const reopen = phase === "break" ? { action: "reopen_round_1", label: "Reopen Round 1" }
    : phase === "finished" ? { action: "reopen_round_2", label: "Reopen Round 2" } : null;
  const advance = async (action: string | null) => {
    if (acting.current || disabled || !action) return;
    if (action.startsWith("end_") && !window.confirm(`End Round ${s.active_round} and close new uploads?`)) return;
    if (action === "return_to_welcome" && !window.confirm(
      "Return everyone to the welcome page before Round 1? Uploads will close and player tabs will hide. All submissions, scores, teams and tasks are kept.",
    )) return;
    acting.current = true;
    setBusy(true);
    setAwaitingPhase(phase);
    let saved = false;
    try {
      await run(async () => {
        await api("/api/admin/settings", {
          method: "POST",
          body: JSON.stringify({ event_action: action, expected_phase: phase }),
        });
        saved = true;
        await reloadEvent();
      });
    } finally {
      // reload() can return early while an older poll is still in flight.
      // Keep the old action disabled until the polled phase really changes.
      if (!saved) setAwaitingPhase(null);
      acting.current = false;
      setBusy(false);
    }
  };

  const save = (patch: Record<string, unknown>) =>
    run(() => api("/api/admin/settings", { method: "POST", body: JSON.stringify(patch) }));

  return (
    <>
      <div className="card">
        <h2 style={{ margin: "0 0 8px" }}>{step.title}</h2>
        <p className="muted" style={{ margin: "0 0 12px" }}>{step.help}</p>
        {step.action && (
          <button className="btn btn-primary btn-wide" disabled={disabled} onClick={() => void advance(step.action)}>
            {step.label}
          </button>
        )}
        {reopen && (
          <div style={{ marginTop: 14 }}>
            <p className="muted tiny" style={{ margin: "0 0 8px" }}>
              Ended by mistake? Reopen uploads without changing teams, tasks or scores.
            </p>
            <button className="btn btn-wide" disabled={disabled} onClick={() => void advance(reopen.action)}>
              {reopen.label}
            </button>
          </div>
        )}
        {phase !== "welcome" && (
          <div style={{ marginTop: 18 }}>
            <p className="muted tiny" style={{ margin: "0 0 8px" }}>
              Finished a rehearsal? Return to before Round 1 without deleting anything.
              Submissions, scores, teams and tasks are kept.
            </p>
            <button className="btn btn-wide" disabled={disabled} onClick={() => void advance("return_to_welcome")}>
              Return to welcome
            </button>
          </div>
        )}
        {awaitingPhase === phase && !busy && <p className="muted tiny">Waiting for refreshed event status…</p>}
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

    </>
  );
}

function RosterTab({ data, run }: { data: AdminData; run: (fn: () => Promise<unknown>) => void }) {
  const [round, setRound] = useState(data.settings.active_round);
  const [names, setNames] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [newTeam, setNewTeam] = useState("");

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

  const rename = (id: string) =>
    run(async () => {
      await api("/api/admin/players", {
        method: "PATCH",
        body: JSON.stringify({ id, name: draft }),
      });
      setEditing((current) => current === id ? null : current);
    });

  const unassigned = data.players.filter((p) => !assigned.get(p.id)).length;

  return (
    <>
      <div className="card">
        <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
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
            title="Requires matching team names across rounds."
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
          {data.players.map((p) =>
            editing === p.id ? (
              <div key={p.id} style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                <input
                  className="field"
                  style={{ flex: "1 1 100%", minWidth: 0, minHeight: 44 }}
                  value={draft}
                  autoFocus
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && draft.trim()) {
                      rename(p.id);
                    }
                    if (e.key === "Escape") setEditing(null);
                  }}
                />
                <button
                  className="btn btn-sm btn-primary"
                  disabled={!draft.trim()}
                  onClick={() => rename(p.id)}
                >
                  Save
                </button>
                <button className="btn btn-sm" onClick={() => setEditing(null)}>
                  Cancel
                </button>
                {/* Refused server-side if they already have submissions, so this
                    cannot quietly delete someone's evidence. */}
                <button
                  className="btn btn-sm btn-bad"
                  onClick={() => {
                    run(async () => {
                      await api(`/api/admin/players?id=${p.id}`, { method: "DELETE" });
                      setEditing((current) => current === p.id ? null : current);
                    });
                  }}
                >
                  Delete
                </button>
              </div>
            ) : (
              <div key={p.id} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <button
                  className="name"
                  style={{
                    flex: "1 1 180px",
                    minWidth: 0,
                    textAlign: "left",
                    background: "none",
                    border: 0,
                    padding: 0,
                    color: "var(--ink)",
                    cursor: "pointer",
                  }}
                  onClick={() => {
                    setEditing(p.id);
                    setDraft(p.name);
                  }}
                  title="Rename or remove"
                >
                  {p.name} <span className="muted tiny">edit</span>
                </button>
                <select
                  className="field"
                  style={{ flex: "1 1 200px", width: "100%", minWidth: 0, minHeight: 44 }}
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
            )
          )}
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

      <div className="card">
        <b>Teams</b>
        <p className="muted tiny" style={{ margin: "2px 0 8px" }}>
          Renaming is safe at any time — submissions point at the team, not its name.
          Names and colours apply only to the selected round.
        </p>
        <div style={{ display: "grid", gap: 6 }}>
          {teams.map((t) => (
            <div key={t.id} style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type="color"
                defaultValue={t.color}
                title="Team colour"
                // onBlur, not onChange: a colour input fires continuously while
                // the picker is dragged, and each tick would write to the database.
                onBlur={(e) => {
                  if (e.target.value !== t.color) {
                    run(() =>
                      api("/api/admin/teams", {
                        method: "PATCH",
                        body: JSON.stringify({ id: t.id, color: e.target.value }),
                      })
                    );
                  }
                }}
                style={{
                  width: 44,
                  height: 44,
                  padding: 2,
                  border: "1px solid var(--line)",
                  borderRadius: 10,
                  background: "var(--card)",
                }}
              />
              <input
                className="field"
                style={{ flex: 1, minHeight: 44 }}
                defaultValue={t.name}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v && v !== t.name) {
                    run(() =>
                      api("/api/admin/teams", {
                        method: "PATCH",
                        body: JSON.stringify({ id: t.id, name: v }),
                      })
                    );
                  }
                }}
              />
              <button
                className="btn btn-sm"
                onClick={() => run(() => api(`/api/admin/teams?id=${t.id}`, { method: "DELETE" }))}
              >
                Remove
              </button>
            </div>
          ))}
        </div>

        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <input
            className="field"
            style={{ flex: 1, minHeight: 44 }}
            placeholder="New team name"
            value={newTeam}
            onChange={(e) => setNewTeam(e.target.value)}
          />
          <button
            className="btn btn-sm btn-primary"
            disabled={!newTeam.trim()}
            onClick={() =>
              run(async () => {
                await api("/api/admin/teams", {
                  method: "POST",
                  body: JSON.stringify({ name: newTeam, color: "#6b7280" }),
                });
                setNewTeam("");
              })
            }
          >
            Add team
          </button>
        </div>
      </div>
    </>
  );
}

function TasksTab({ data, run }: { data: AdminData; run: (fn: () => Promise<unknown>) => void }) {
  const [round, setRound] = useState(data.settings.active_round);
  const [title, setTitle] = useState("");
  const [points, setPoints] = useState(3);
  const [scoringMode, setScoringMode] = useState<"fixed" | "quantity">("fixed");
  const [measurementLabel, setMeasurementLabel] = useState("");
  const [pointsPerUnit, setPointsPerUnit] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);

  const tasks = useMemo(() => data.tasks.filter((t) => t.round === round), [data.tasks, round]);

  const patch = (body: Record<string, unknown>, onSaved?: () => void) =>
    run(async () => {
      await api("/api/admin/tasks", { method: "PATCH", body: JSON.stringify(body) });
      onSaved?.();
    });

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
        <div className="row" style={{ gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
          <select className="field" value={scoringMode} onChange={(e) => setScoringMode(e.target.value as typeof scoringMode)}>
            <option value="fixed">Fixed score</option>
            <option value="quantity">Extra per item</option>
          </select>
          {scoringMode === "quantity" && (
            <>
              <input className="field" placeholder="One unit, e.g. extra shirt — reads &quot;+1 pt per extra shirt&quot;" value={measurementLabel} onChange={(e) => setMeasurementLabel(e.target.value)} />
              <input className="field" type="number" min={0} placeholder="Extra points per item" value={pointsPerUnit} onChange={(e) => setPointsPerUnit(Number(e.target.value))} />
            </>
          )}
        </div>
        <button
          className="btn btn-sm btn-primary"
          disabled={!title.trim()}
          onClick={() =>
            run(async () => {
              await api("/api/admin/tasks", {
                method: "POST",
                body: JSON.stringify({
                  round,
                  title,
                  points,
                  scoringMode,
                  measurementLabel,
                  pointsPerUnit,
                }),
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
        <p className="muted tiny" style={{ margin: "2px 0 8px" }}>
          Tap a task to change its wording, baseline or scoring rule. Editing the value does NOT rescore
          anything already judged — each submission keeps the points it was worth at the time.
          This is the same task list the planner canvas edits, so there is nothing to publish.
        </p>
        <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
          {tasks.map((t) =>
            editing === t.id ? (
              <TaskEditor
                key={t.id}
                task={t}
                onCancel={() => setEditing(null)}
                onSave={(body) => {
                  patch({ id: t.id, ...body }, () => {
                    setEditing((current) => current === t.id ? null : current);
                  });
                }}
                onDelete={() => {
                  run(async () => {
                    await api(`/api/admin/tasks?id=${t.id}`, { method: "DELETE" });
                    setEditing((current) => current === t.id ? null : current);
                  });
                }}
              />
            ) : (
              <button
                key={t.id}
                onClick={() => setEditing(t.id)}
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                  textAlign: "left",
                  background: "none",
                  border: 0,
                  padding: "2px 0",
                  color: "var(--ink)",
                  opacity: t.active ? 1 : 0.45,
                  cursor: "pointer",
                }}
              >
                <span className="pill">{t.points}</span>
                <span
                  className="tiny"
                  style={{ flex: 1, minWidth: 0, textDecoration: t.active ? "none" : "line-through" }}
                >
                  {t.title}
                </span>
                <span className="muted tiny">edit</span>
              </button>
            )
          )}
        </div>
      </div>
    </>
  );
}

function TaskEditor({
  task,
  onSave,
  onCancel,
  onDelete,
}: {
  task: AdminData["tasks"][number];
  onSave: (body: Record<string, unknown>) => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const [baseline] = useState(task);
  const [title, setTitle] = useState(task.title);
  const [points, setPoints] = useState(task.points);
  const [scoringMode, setScoringMode] = useState(task.scoring_mode);
  const [measurementLabel, setMeasurementLabel] = useState(task.measurement_label);
  const [pointsPerUnit, setPointsPerUnit] = useState(task.points_per_unit);

  const save = () => {
    // Polls update `task`, not the values this editor opened with. Only send
    // deliberate edits so a stale editor cannot overwrite another organizer.
    const patch: Record<string, unknown> = {};
    if (title.trim() !== baseline.title.trim()) patch.title = title.trim();
    if (points !== baseline.points) patch.points = points;
    if (scoringMode !== baseline.scoring_mode) patch.scoringMode = scoringMode;
    if (measurementLabel.trim() !== baseline.measurement_label.trim()) patch.measurementLabel = measurementLabel.trim();
    if (pointsPerUnit !== baseline.points_per_unit) patch.pointsPerUnit = pointsPerUnit;
    if (Object.keys(patch).length) onSave(patch);
    else onCancel();
  };

  return (
    <div className="card" style={{ margin: 0, borderColor: "var(--accent)" }}>
      <textarea
        className="field"
        rows={2}
        value={title}
        autoFocus
        onChange={(e) => setTitle(e.target.value)}
        style={{ minHeight: 70, marginBottom: 8 }}
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
      {!task.active && <span className="pill muted" style={{ marginBottom: 10 }}>removed</span>}
      <div className="row" style={{ gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
        <select className="field" value={scoringMode} onChange={(e) => setScoringMode(e.target.value as typeof scoringMode)}>
          <option value="fixed">Fixed score</option>
          <option value="quantity">Extra per item</option>
        </select>
        {scoringMode === "quantity" && (
          <>
            <input className="field" placeholder="One unit, e.g. extra shirt — reads &quot;+1 pt per extra shirt&quot;" value={measurementLabel} onChange={(e) => setMeasurementLabel(e.target.value)} />
            <input className="field" type="number" min={0} placeholder="Extra points per item" value={pointsPerUnit} onChange={(e) => setPointsPerUnit(Number(e.target.value))} />
          </>
        )}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button
          className="btn btn-sm btn-primary"
          style={{ flex: 1 }}
          disabled={!title.trim()}
          onClick={save}
        >
          Save
        </button>
        <button className="btn btn-sm" onClick={onCancel}>
          Cancel
        </button>
        {task.active ? (
          <button className="btn btn-sm btn-bad" onClick={onDelete}>
            Remove
          </button>
        ) : (
          <button className="btn btn-sm" onClick={() => onSave({ active: true })}>
            Restore
          </button>
        )}
      </div>
    </div>
  );
}

function HealthTab({ data, run }: { data: AdminData; run: (fn: () => Promise<unknown>) => void }) {
  const { data: health, error, reload } = usePoll<{
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
        {error && (
          <div className="card card-bad tiny" role="alert">
            Couldn&apos;t refresh health checks: {error}. Retrying.
            {health && " The results below are from the last successful check."}
            <button className="btn btn-sm" style={{ display: "flex", marginTop: 8 }} onClick={() => void reload()}>
              Try again
            </button>
          </div>
        )}
        {!health && !error && <span className="muted tiny">Checking…</span>}
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
            <div key={s.id} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <div className="tiny name" style={{ flex: "1 1 100%" }}>
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

      <ResetCard data={data} run={run} />
    </>
  );
}

/**
 * The clean slate for testing. Deleting media is permanent, so this is guarded
 * three deep: the PIN, the server-side ALLOW_RESET switch, and typing the word.
 * The typed word is the one that matters -- it is the only guard a mis-tap
 * cannot get past.
 *
 * When the switch is off this says so rather than rendering nothing, because a
 * control that silently vanishes sends the organizer hunting through the code
 * for it. It is one muted line, not a disabled button, so there is nothing to
 * tap at all during the event.
 */
function ResetCard({ data, run }: { data: AdminData; run: (fn: () => Promise<unknown>) => void }) {
  const [word, setWord] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ text: string; ok: boolean } | null>(null);

  if (!data.resetEnabled) {
    return (
      <p className="muted tiny" style={{ margin: "4px 2px 0" }}>
        Submission reset is switched off. Set <code>ALLOW_RESET=1</code> in the environment to
        enable it.
      </p>
    );
  }

  const total = Object.values(data.counts).reduce((n, c) => n + c.total, 0);
  const armed = word.trim().toUpperCase() === "RESET";

  const reset = () => {
    setBusy(true);
    setDone(null);
    run(async () => {
      try {
        const r = await api<{
          submissions: number;
          objects: number;
          orphaned: number;
        }>("/api/admin/reset", { method: "POST", body: JSON.stringify({ confirm: "RESET" }) });
        setWord("");
        // Report partial storage cleanup rather than silently claiming success.
        setDone({
          text:
            `Deleted ${r.submissions} submission${r.submissions === 1 ? "" : "s"} and ` +
            `${r.objects} file${r.objects === 1 ? "" : "s"}.` +
            (r.orphaned ? ` ${r.orphaned} file(s) could not be removed from storage.` : ""),
          ok: r.orphaned === 0,
        });
      } finally {
        setBusy(false);
      }
    });
  };

  return (
    <div className="card bad">
      <b>Reset submissions</b>
      <p className="muted tiny" style={{ margin: "2px 0 8px" }}>
        Deletes all <b>{total}</b> submission{total === 1 ? "" : "s"} and the media{" "}
        {total === 1 ? "file" : "files"} they uploaded, and clears
        the tasks players have starred. Players, teams, the roster and the task list
        are left alone. <b>There is no undo</b> — the uploaded photos are the only copy.
        Type <b>RESET</b> to enable the button.
      </p>
      <input
        className="field"
        value={word}
        placeholder="RESET"
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
        onChange={(e) => setWord(e.target.value)}
      />
      <button
        className="btn btn-wide btn-bad"
        style={{ marginTop: 8 }}
        disabled={!armed || busy}
        onClick={reset}
      >
        {busy ? "Deleting…" : `Delete ${total} submission${total === 1 ? "" : "s"} and their media`}
      </button>
      {done && (
        <p className={`${done.ok ? "good" : "bad"} tiny`} style={{ margin: "8px 0 0" }}>
          {done.text}
        </p>
      )}
    </div>
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
