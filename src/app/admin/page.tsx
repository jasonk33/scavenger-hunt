"use client";

import { useEffect, useMemo, useState } from "react";
import { api, errorMessage, usePoll } from "@/lib/client";

type AdminData = {
  settings: {
    active_round: number;
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
    scoring_mode: "fixed" | "quantity" | "competition";
    measurement_label: string;
    points_per_unit: number;
    competition_bonus: number;
    winner_team_id: string | null;
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
  resetEnabled: boolean;
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
        <b>Organizer</b>
        <p className="muted tiny" style={{ margin: "4px 0 10px" }}>
          Event setup: players, teams, rounds, exports.
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
          {data.players.map((p) =>
            editing === p.id ? (
              <div key={p.id} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input
                  className="field"
                  style={{ flex: 1, minHeight: 44 }}
                  value={draft}
                  autoFocus
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && draft.trim()) {
                      run(() =>
                        api("/api/admin/players", {
                          method: "PATCH",
                          body: JSON.stringify({ id: p.id, name: draft }),
                        })
                      );
                      setEditing(null);
                    }
                    if (e.key === "Escape") setEditing(null);
                  }}
                />
                <button
                  className="btn btn-sm btn-primary"
                  disabled={!draft.trim()}
                  onClick={() => {
                    run(() =>
                      api("/api/admin/players", {
                        method: "PATCH",
                        body: JSON.stringify({ id: p.id, name: draft }),
                      })
                    );
                    setEditing(null);
                  }}
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
                    run(() => api(`/api/admin/players?id=${p.id}`, { method: "DELETE" }));
                    setEditing(null);
                  }}
                >
                  Delete
                </button>
              </div>
            ) : (
              <div key={p.id} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <button
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
          Renaming is safe at any time — submissions point at the team, not its name. A change
          applies to both rounds so the two stay paired.
        </p>
        <div style={{ display: "grid", gap: 6 }}>
          {teams.map((t) => (
            <div key={t.id} style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type="color"
                defaultValue={t.color}
                title="Team colour"
                // onBlur, not onChange: a colour input fires continuously while
                // the picker is dragged, and each tick would PATCH both rounds.
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
  const [scoringMode, setScoringMode] = useState<"fixed" | "quantity" | "competition">("fixed");
  const [measurementLabel, setMeasurementLabel] = useState("");
  const [pointsPerUnit, setPointsPerUnit] = useState(0);
  const [competitionBonus, setCompetitionBonus] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);

  const tasks = useMemo(() => data.tasks.filter((t) => t.round === round), [data.tasks, round]);
  // Cut tasks are excluded for the same reason as the contests below: revealing
  // one does nothing, because /api/state drops inactive rows before it checks
  // revealed_at. Leaving them in showed every retired secret with a live button.
  const secrets = tasks.filter((t) => t.is_secret && t.active);
  // Leader bonuses are decided after the round, so this list is the checklist of
  // what still owes a decision. Cut tasks are excluded: nobody could submit to
  // them, so there is nothing to award.
  const contests = tasks.filter((t) => t.scoring_mode === "competition" && t.active);
  const undecided = contests.filter((t) => !t.winner_team_id).length;
  const roundTeams = useMemo(
    () => data.teams.filter((t) => t.round === round),
    [data.teams, round]
  );

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

      {contests.length > 0 && (
        <div className="card">
          <b>Leader bonuses</b>
          <p className="muted tiny" style={{ margin: "2px 0 8px" }}>
            Pick the winner once Round {round} is over. Nothing is awarded until you do, and the
            bonus lands on that team&apos;s score straight away — players never see a running leader,
            so nobody wastes the round redoing a task to overtake someone.
          </p>
          {undecided > 0 && (
            <div className="pill pill-warn pill-wrap" style={{ marginBottom: 8 }}>
              {undecided} still to decide
            </div>
          )}
          <div style={{ display: "grid", gap: 8 }}>
            {contests.map((t) => (
              <div key={t.id}>
                <div style={{ marginBottom: 4, lineHeight: 1.35 }}>
                  {t.title} <span className="muted tiny">+{t.competition_bonus}</span>
                </div>
                <select
                  className="field"
                  value={t.winner_team_id ?? ""}
                  onChange={(e) => patch({ id: t.id, winnerTeamId: e.target.value || null })}
                  style={{ width: "100%" }}
                >
                  <option value="">Not decided yet</option>
                  {roundTeams.map((team) => (
                    <option key={team.id} value={team.id}>
                      {team.name}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </div>
      )}

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
            <option value="competition">Leader bonus</option>
          </select>
          {scoringMode === "quantity" && (
            <>
              <input className="field" placeholder="One unit, e.g. extra shirt — reads &quot;+1 pt per extra shirt&quot;" value={measurementLabel} onChange={(e) => setMeasurementLabel(e.target.value)} />
              <input className="field" type="number" min={0} placeholder="Extra points per item" value={pointsPerUnit} onChange={(e) => setPointsPerUnit(Number(e.target.value))} />
            </>
          )}
          {scoringMode === "competition" && (
            <input className="field" type="number" min={0} placeholder="Leader bonus" value={competitionBonus} onChange={(e) => setCompetitionBonus(Number(e.target.value))} />
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
                  isSecret: points === 7,
                  scoringMode,
                  measurementLabel,
                  pointsPerUnit,
                  competitionBonus,
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
          A secret challenge is offered in both rounds: everything except Reveal changes both,
          and Reveal only unlocks the round you are in.
        </p>
        <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
          {tasks.map((t) =>
            editing === t.id ? (
              <TaskEditor
                key={t.id}
                task={t}
                onCancel={() => setEditing(null)}
                onSave={(body) => {
                  patch({ id: t.id, ...body });
                  setEditing(null);
                }}
                onDelete={() => {
                  run(() => api(`/api/admin/tasks?id=${t.id}`, { method: "DELETE" }));
                  setEditing(null);
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
                  {t.requires_video && <span className="muted"> · clip</span>}
                  {t.is_secret && <span className="warn"> · secret</span>}
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
  const [title, setTitle] = useState(task.title);
  const [points, setPoints] = useState(task.points);
  const [scoringMode, setScoringMode] = useState(task.scoring_mode);
  const [measurementLabel, setMeasurementLabel] = useState(task.measurement_label);
  const [pointsPerUnit, setPointsPerUnit] = useState(task.points_per_unit);
  const [competitionBonus, setCompetitionBonus] = useState(task.competition_bonus);
  const [clip, setClip] = useState(task.requires_video);
  const [secret, setSecret] = useState(task.is_secret);

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
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
        <button
          className={`btn btn-sm ${clip ? "btn-primary" : ""}`}
          onClick={() => setClip((v) => !v)}
        >
          video only
        </button>
        <button
          className={`btn btn-sm ${secret ? "btn-primary" : ""}`}
          onClick={() => setSecret((v) => !v)}
        >
          secret
        </button>
        {!task.active && <span className="pill muted">removed</span>}
      </div>
      <div className="row" style={{ gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
        <select className="field" value={scoringMode} onChange={(e) => setScoringMode(e.target.value as typeof scoringMode)}>
          <option value="fixed">Fixed score</option>
          <option value="quantity">Extra per item</option>
          <option value="competition">Leader bonus</option>
        </select>
        {scoringMode === "quantity" && (
          <>
            <input className="field" placeholder="One unit, e.g. extra shirt — reads &quot;+1 pt per extra shirt&quot;" value={measurementLabel} onChange={(e) => setMeasurementLabel(e.target.value)} />
            <input className="field" type="number" min={0} placeholder="Extra points per item" value={pointsPerUnit} onChange={(e) => setPointsPerUnit(Number(e.target.value))} />
          </>
        )}
        {scoringMode === "competition" && (
          <input className="field" type="number" min={0} placeholder="Leader bonus" value={competitionBonus} onChange={(e) => setCompetitionBonus(Number(e.target.value))} />
        )}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button
          className="btn btn-sm btn-primary"
          style={{ flex: 1 }}
          disabled={!title.trim()}
          onClick={() =>
            // Deliberately does NOT send `active`. Sending `active: true` here
            // would silently un-remove a deactivated task just because someone
            // fixed its wording -- and would make the Restore button below dead
            // UI. Removed tasks stay removed until Restore is tapped.
            onSave({
              title,
              points,
              requiresVideo: clip,
              isSecret: secret,
              scoringMode,
              measurementLabel,
              pointsPerUnit,
              competitionBonus,
            })
          }
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
          winnersCleared: boolean;
        }>("/api/admin/reset", { method: "POST", body: JSON.stringify({ confirm: "RESET" }) });
        setWord("");
        // Both partial outcomes are reported. A silent "done" over media that is
        // still in the bucket, or over leader bonuses still being paid on the
        // leaderboard, is worse than no reset at all -- nobody would think to
        // look.
        setDone({
          text:
            `Deleted ${r.submissions} submission${r.submissions === 1 ? "" : "s"} and ` +
            `${r.objects} file${r.objects === 1 ? "" : "s"}.` +
            (r.orphaned ? ` ${r.orphaned} file(s) could not be removed from storage.` : "") +
            (r.winnersCleared ? "" : " Leader bonuses could NOT be un-awarded — try again."),
          ok: r.orphaned === 0 && r.winnersCleared,
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
        {total === 1 ? "file" : "files"} they uploaded, un-awards every leader bonus, and clears
        the tasks players have starred. Players, teams, the roster, the task list and any revealed
        secrets are left alone. <b>There is no undo</b> — the uploaded photos are the only copy.
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
