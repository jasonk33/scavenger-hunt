/**
 * Roster renderer. It talks to the extension over plain HTTP:
 * GET /api/roster, player/team CRUD endpoints, assignment updates and
 * copy-roster-across-rounds.
 *
 * Every edit is live, as on the Tasks tab. The panel therefore keeps the
 * selected round visible and calls out errors instead of treating an empty
 * response as a real roster.
 */

const el = {
  view: document.getElementById("roster-view"),
  error: document.getElementById("roster-error"),
  roundFilter: document.getElementById("roster-round-filter"),
  copy: document.getElementById("copy-roster"),
  summary: document.getElementById("roster-assignment-summary"),
  playerCount: document.getElementById("roster-player-count"),
  teamCount: document.getElementById("roster-team-count"),
  players: document.getElementById("player-list"),
  teams: document.getElementById("team-list"),
  addPlayers: document.getElementById("add-players"),
  addPlayersButton: document.getElementById("add-players-button"),
  newTeam: document.getElementById("new-team"),
  newTeamColor: document.getElementById("new-team-color"),
  addTeamButton: document.getElementById("add-team-button"),
};

let round = 1;
let loaded = false;
let roster = { players: [], teams: [], roster: [] };
let rosterError = null;
let busy = 0;
let pollTimer = 0;
let actionChain = Promise.resolve();
let actionMessage = "";
const playerDrafts = new Map();
const teamDrafts = new Map();
const playerTimers = new Map();
const teamTimers = new Map();

function selectedTeams() {
  return roster.teams
    .filter((team) => team.round === round)
    .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
}

function assignments() {
  return new Map(
    roster.roster
      .filter((entry) => entry.round === round)
      .map((entry) => [entry.player_id, entry.team_id])
  );
}

async function request(path, { method = "GET", body } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    throw new Error(`could not reach the roster: ${error.message}`);
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || payload.error) {
    throw new Error(payload?.error || `roster request failed (HTTP ${response.status})`);
  }
  return payload;
}

function renderError() {
  el.error.hidden = !rosterError;
  el.error.textContent = rosterError ? `Roster error: ${rosterError}` : "";
}

function button(label, className = "ghost") {
  const node = document.createElement("button");
  node.className = className;
  node.type = "button";
  node.textContent = label;
  node.disabled = busy > 0;
  return node;
}

function renderPlayers() {
  el.players.replaceChildren();
  if (!roster.players.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No people yet. Paste the guest list below.";
    el.players.append(empty);
    return;
  }

  const teams = selectedTeams();
  const assigned = assignments();
  for (const player of roster.players) {
    const row = document.createElement("div");
    row.className = "roster-row player-row";

    const name = document.createElement("input");
    name.className = "roster-name";
    name.type = "text";
    name.value = playerDrafts.get(player.id) ?? player.name;
    name.setAttribute("aria-label", `Name for ${player.name}`);

    const clearPlayerTimer = () => {
      clearTimeout(playerTimers.get(player.id));
      playerTimers.delete(player.id);
    };
    const persistPlayer = () => {
      clearPlayerTimer();
      const next = name.value.trim();
      if (!next || next === player.name) {
        name.value = player.name;
        playerDrafts.delete(player.id);
        return;
      }
      mutate(`Updating ${next}`, () => request("/api/roster/players", {
        method: "PATCH",
        body: { id: player.id, name: next },
      }), () => playerDrafts.delete(player.id));
    };
    const queuePlayer = () => {
      clearPlayerTimer();
      playerTimers.set(player.id, setTimeout(persistPlayer, 400));
    };
    name.addEventListener("input", () => {
      playerDrafts.set(player.id, name.value);
      queuePlayer();
    });
    name.addEventListener("blur", persistPlayer);
    name.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        persistPlayer();
      } else if (event.key === "Escape") {
        clearPlayerTimer();
        name.value = player.name;
        playerDrafts.delete(player.id);
      }
    });

    const select = document.createElement("select");
    select.className = "roster-team";
    select.setAttribute("aria-label", `Team for ${player.name} in Round ${round}`);
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "— unassigned —";
    select.append(none);
    for (const team of teams) {
      const option = document.createElement("option");
      option.value = team.id;
      option.textContent = team.name;
      select.append(option);
    }
    select.value = assigned.get(player.id) ?? "";
    select.disabled = busy > 0;
    select.addEventListener("change", () => {
      const teamId = select.value || null;
      mutate(
        `Assigning ${player.name}`,
        () => request("/api/roster/assign", {
          method: "POST",
          body: { round, entries: [{ playerId: player.id, teamId }] },
        })
      );
    });

    const remove = button("Remove", "ghost danger");
    remove.title = "Remove only if this person has no submissions";
    remove.addEventListener("click", () => {
      if (!window.confirm(`Remove ${player.name}? This is refused if they have submissions.`)) return;
      mutate(
        `Removing ${player.name}`,
        () => request(`/api/roster/players?id=${encodeURIComponent(player.id)}`, { method: "DELETE" }),
        () => playerDrafts.delete(player.id)
      );
    });

    row.append(name, select, remove);
    el.players.append(row);
  }
}

function renderTeams() {
  el.teams.replaceChildren();
  const teams = selectedTeams();
  if (!teams.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No teams yet. Add one below.";
    el.teams.append(empty);
    return;
  }

  const assigned = assignments();
  for (const team of teams) {
    const row = document.createElement("div");
    row.className = "roster-row team-row";
    const draft = teamDrafts.get(team.id) ?? { name: team.name, color: team.color };

    const color = document.createElement("input");
    color.className = "color";
    color.type = "color";
    color.value = draft.color;
    color.title = `Colour for ${team.name}`;
    color.setAttribute("aria-label", `Colour for ${team.name}`);

    const name = document.createElement("input");
    name.className = "roster-name";
    name.type = "text";
    name.value = draft.name;
    name.setAttribute("aria-label", `Name for ${team.name}`);

    // Keep the editor's baseline across polls; a newer row is not a local edit.
    let baseline = draft.baseline ?? { name: name.value.trim(), color: color.value };
    const remember = () => teamDrafts.set(team.id, { name: name.value, color: color.value, baseline });
    const resetTeam = () => {
      name.value = team.name;
      color.value = team.color;
      baseline = { name: name.value.trim(), color: color.value };
      teamDrafts.delete(team.id);
    };
    const clearTeamTimer = () => {
      clearTimeout(teamTimers.get(team.id));
      teamTimers.delete(team.id);
    };
    const persistTeam = () => {
      clearTeamTimer();
      const nextName = name.value.trim();
      if (!nextName) {
        resetTeam();
        return;
      }
      const patch = {};
      if (nextName !== baseline.name) patch.name = nextName;
      if (color.value !== baseline.color) patch.color = color.value;
      if (!Object.keys(patch).length) {
        resetTeam();
        return;
      }
      mutate(`Updating ${nextName}`, () => request("/api/roster/teams", {
        method: "PATCH",
        body: { id: team.id, ...patch },
      }), () => {
        teamDrafts.delete(team.id);
        for (const sibling of roster.teams) {
          if (sibling.name === team.name) teamDrafts.delete(sibling.id);
        }
      });
    };
    const queueTeam = () => {
      clearTeamTimer();
      teamTimers.set(team.id, setTimeout(persistTeam, 400));
    };
    name.addEventListener("input", () => {
      remember();
      queueTeam();
    });
    color.addEventListener("input", () => {
      remember();
      queueTeam();
    });
    name.addEventListener("blur", persistTeam);
    color.addEventListener("blur", persistTeam);
    name.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        persistTeam();
      } else if (event.key === "Escape") {
        clearTeamTimer();
        resetTeam();
      }
    });

    const members = document.createElement("span");
    members.className = "roster-count";
    const count = [...assigned.values()].filter((id) => id === team.id).length;
    members.textContent = `${count} assigned`;

    const remove = button("Remove", "ghost danger");
    remove.title = "Remove only if this team has no submissions";
    remove.addEventListener("click", () => {
      if (!window.confirm(`Remove ${team.name} from both rounds? This is refused if it has submissions.`)) return;
      mutate(
        `Removing ${team.name}`,
        () => request(`/api/roster/teams?id=${encodeURIComponent(team.id)}`, { method: "DELETE" }),
        () => {
          for (const sibling of roster.teams) {
            if (sibling.name === team.name) teamDrafts.delete(sibling.id);
          }
        }
      );
    });

    row.append(color, name, members, remove);
    el.teams.append(row);
  }
}

function render() {
  renderError();
  for (const buttonNode of el.roundFilter.querySelectorAll("button")) {
    buttonNode.classList.toggle("on", Number(buttonNode.dataset.round) === round);
  }
  el.copy.textContent = `Copy from Round ${round === 1 ? 2 : 1}`;
  el.copy.disabled = busy > 0 || !loaded;
  el.addPlayersButton.disabled = busy > 0 || !el.addPlayers.value.trim();
  el.addTeamButton.disabled = busy > 0 || !el.newTeam.value.trim();
  el.newTeamColor.disabled = busy > 0;

  if (!loaded) {
    el.summary.textContent = "";
    el.playerCount.textContent = "";
    el.teamCount.textContent = "";
    el.players.replaceChildren();
    el.teams.replaceChildren();
    const loading = document.createElement("p");
    loading.className = "empty";
    loading.textContent = rosterError ? "Roster unavailable." : "Loading the roster…";
    el.players.append(loading);
    return;
  }

  const assigned = assignments();
  const assignedCount = assigned.size;
  const unassigned = Math.max(0, roster.players.length - assignedCount);
  el.summary.textContent = busy
    ? `${actionMessage}…`
    : `${assignedCount}/${roster.players.length} assigned in Round ${round}`;
  el.playerCount.textContent = `${unassigned} unassigned`;
  el.teamCount.textContent = `${selectedTeams().length} teams`;
  renderPlayers();
  renderTeams();
}

function applyRoster(next) {
  if (
    !next ||
    !Array.isArray(next.players) ||
    !Array.isArray(next.teams) ||
    !Array.isArray(next.roster)
  ) {
    throw new Error("the roster response was incomplete");
  }
  const changed = !loaded || JSON.stringify(next) !== JSON.stringify(roster);
  roster = next;
  rosterError = null;
  loaded = true;
  if (changed) render();
}

async function refreshRoster({ force = false } = {}) {
  if (busy && !force) return;
  try {
    applyRoster(await request("/api/roster"));
  } catch (error) {
    rosterError = String(error?.message ?? error);
    if (loaded) renderError();
    else render();
  }
}

function mutate(label, fn, after) {
  const run = actionChain.then(async () => {
    busy += 1;
    actionMessage = label;
    rosterError = null;
    el.view.setAttribute("aria-busy", "true");
    render();
    try {
      await fn();
      after?.();
      await refreshRoster({ force: true });
    } catch (error) {
      rosterError = String(error?.message ?? error);
      renderError();
    } finally {
      busy -= 1;
      if (!busy) actionMessage = "";
      el.view.setAttribute("aria-busy", busy > 0 ? "true" : "false");
      render();
    }
  });
  actionChain = run.catch(() => {});
  return run;
}

el.roundFilter.addEventListener("click", (event) => {
  const target = event.target.closest("button");
  if (!target) return;
  round = Number(target.dataset.round);
  render();
});

el.copy.addEventListener("click", () => {
  const from = round === 1 ? 2 : 1;
  if (!window.confirm(`Copy every assignment from Round ${from} into Round ${round}?`)) return;
  mutate(`Copying Round ${from}`, () => request("/api/roster/copy", {
    method: "POST",
    body: { from, to: round },
  }));
});

el.addPlayers.addEventListener("input", () => {
  el.addPlayersButton.disabled = busy > 0 || !el.addPlayers.value.trim();
});

el.addPlayersButton.addEventListener("click", () => {
  const names = el.addPlayers.value;
  mutate("Adding people", () => request("/api/roster/players", {
    method: "POST",
    body: { names },
  }), () => {
    el.addPlayers.value = "";
  });
});

el.newTeam.addEventListener("input", () => {
  el.addTeamButton.disabled = busy > 0 || !el.newTeam.value.trim();
});

el.addTeamButton.addEventListener("click", () => {
  const name = el.newTeam.value;
  const color = el.newTeamColor.value;
  mutate("Adding team", () => request("/api/roster/teams", {
    method: "POST",
    body: { name, color },
  }), () => {
    el.newTeam.value = "";
  });
});

window.addEventListener("roster-update", (event) => {
  if (busy) return;
  try {
    applyRoster(JSON.parse(event.detail));
  } catch (error) {
    rosterError = String(error?.message ?? error);
    renderError();
  }
});

const POLL_MS = 8000;
async function schedulePoll() {
  clearTimeout(pollTimer);
  if (document.hidden) return;
  pollTimer = setTimeout(async () => {
    await refreshRoster();
    schedulePoll();
  }, POLL_MS);
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) clearTimeout(pollTimer);
  else refreshRoster().finally(schedulePoll);
});

render();
await refreshRoster();
schedulePoll();
