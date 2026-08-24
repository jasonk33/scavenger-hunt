/**
 * The canvas's roster query layer.
 *
 * Kept apart from the task queries because it is a different set of tables, not
 * because it is a different kind of write -- both tabs write what the app reads,
 * live. It uses the same package-free PostgREST client, which is what lets the
 * canvas work from a checkout with no node_modules.
 */

import { createTaskClient, rest } from "../../../scripts/task-store.mjs";

let db = null;
const client = () => (db ??= createTaskClient());
export const getRosterClient = () => client();

const eq = (value) => `eq.${encodeURIComponent(value)}`;
const inList = (values) => `in.(${values.map((value) => encodeURIComponent(value)).join(",")})`;
const asRows = (value) => (Array.isArray(value) ? value : []);

export function normalizeNames(value) {
  const values = Array.isArray(value) ? value : String(value ?? "").split(/[\n,]/);
  return [...new Set(values.filter((name) => typeof name === "string").map((name) => name.trim()).filter(Boolean))];
}

export async function loadRoster(dbClient = client()) {
  const [players, teams, roster] = await Promise.all([
    rest(dbClient, { path: "players?select=id,name&order=name.asc" }),
    rest(dbClient, { path: "teams?select=id,round,name,color,sort_order&order=round.asc,sort_order.asc" }),
    rest(dbClient, { path: "roster?select=round,player_id,team_id&order=round.asc,player_id.asc" }),
  ]);
  return {
    players: asRows(players),
    teams: asRows(teams),
    roster: asRows(roster),
  };
}

export async function addPlayers(dbClient, value) {
  const names = normalizeNames(value);
  if (!names.length) throw new Error("No names given.");

  await rest(dbClient, {
    method: "POST",
    path: "players?select=id,name",
    body: names.map((name) => ({ name })),
    prefer: "resolution=ignore-duplicates,return=representation",
  });
  return { added: names.length };
}

export async function updatePlayer(dbClient, playerId, name) {
  const id = String(playerId ?? "");
  const clean = String(name ?? "").trim();
  if (!id || !clean) throw new Error("id and name are required.");

  const updated = await rest(dbClient, {
    method: "PATCH",
    path: `players?id=${eq(id)}&select=id,name`,
    body: { name: clean },
    prefer: "return=representation",
  });
  if (!asRows(updated)[0]) throw new Error("Player not found.");
  return asRows(updated)[0];
}

export async function deletePlayer(dbClient, playerId) {
  const id = String(playerId ?? "");
  if (!id) throw new Error("id required.");

  const submissions = asRows(
    await rest(dbClient, { path: `submissions?select=id&player_id=${eq(id)}` })
  );
  if (submissions.length) {
    throw new Error(
      `That player has ${submissions.length} submission${submissions.length === 1 ? "" : "s"}. Removing them would delete those too.`
    );
  }

  const deleted = await rest(dbClient, {
    method: "DELETE",
    path: `players?id=${eq(id)}`,
    prefer: "return=representation",
  });
  return { deleted: asRows(deleted).length || 1 };
}

export async function addTeam(dbClient, input = {}) {
  const name = String(input.name ?? "").trim();
  const color = String(input.color ?? "#666666").trim() || "#666666";
  if (!name) throw new Error("name required.");

  const last = asRows(
    await rest(dbClient, {
      path: "teams?select=sort_order&order=sort_order.desc&limit=1",
    })
  )[0];
  const previous = Number(last?.sort_order ?? 0);
  const sortOrder = Number.isFinite(previous) ? previous + 10 : 10;

  await rest(dbClient, {
    method: "POST",
    path: "teams?select=id,round,name,color,sort_order",
    body: [
      { round: 1, name, color, sort_order: sortOrder },
      { round: 2, name, color, sort_order: sortOrder },
    ],
    prefer: "resolution=ignore-duplicates,return=representation",
  });
  return { ok: true };
}

export async function updateTeam(dbClient, teamId, input = {}) {
  const id = String(teamId ?? "");
  if (!id) throw new Error("id required.");

  const team = asRows(
    await rest(dbClient, {
      path: `teams?select=id,name,round&id=${eq(id)}&limit=1`,
    })
  )[0];
  if (!team) throw new Error("Team not found.");

  const patch = {};
  if (typeof input.name === "string" && input.name.trim()) patch.name = input.name.trim();
  if (typeof input.color === "string" && input.color.trim()) patch.color = input.color.trim();
  if (!Object.keys(patch).length) throw new Error("Nothing to update.");

  const sibling = asRows(
    await rest(dbClient, {
      path: `teams?select=id&round=${eq(team.round === 1 ? 2 : 1)}&name=${eq(team.name)}&limit=1`,
    })
  )[0];
  const ids = [id, ...(sibling ? [sibling.id] : [])];
  const updated = await rest(dbClient, {
    method: "PATCH",
    path: `teams?id=${inList(ids)}&select=id,round,name,color`,
    body: patch,
    prefer: "return=representation",
  });
  return { ok: true, updated: asRows(updated).length || ids.length };
}

export async function deleteTeam(dbClient, teamId) {
  const id = String(teamId ?? "");
  if (!id) throw new Error("id required.");

  const team = asRows(
    await rest(dbClient, {
      path: `teams?select=id,name,round&id=${eq(id)}&limit=1`,
    })
  )[0];
  if (!team) throw new Error("Team not found.");

  const pair = asRows(
    await rest(dbClient, { path: `teams?select=id&name=${eq(team.name)}` })
  );
  const ids = [...new Set(pair.map((row) => row.id))];
  if (!ids.length) throw new Error("Team not found.");

  const submissions = asRows(
    await rest(dbClient, { path: `submissions?select=id&team_id=${inList(ids)}` })
  );
  if (submissions.length) {
    throw new Error(
      `"${team.name}" has ${submissions.length} submission${submissions.length === 1 ? "" : "s"}. Deleting it would delete those too.`
    );
  }

  const roster = asRows(
    await rest(dbClient, { path: `roster?select=player_id&team_id=${inList(ids)}` })
  );
  await rest(dbClient, {
    method: "DELETE",
    path: `teams?id=${inList(ids)}`,
    prefer: "return=representation",
  });
  return { ok: true, deleted: ids.length, unassigned: roster.length };
}

export async function assignRoster(dbClient, roundValue, entriesValue) {
  const round = Number(roundValue);
  if (round !== 1 && round !== 2) throw new Error("round must be 1 or 2.");

  const rawEntries = Array.isArray(entriesValue) ? entriesValue : [entriesValue];
  const entriesByPlayer = new Map(
    rawEntries
      .filter((entry) => entry && entry.playerId)
      .map((entry) => [
        String(entry.playerId),
        { playerId: String(entry.playerId), teamId: entry.teamId ? String(entry.teamId) : null },
      ])
  );
  const entries = [...entriesByPlayer.values()];
  if (!entries.length) throw new Error("At least one player assignment is required.");

  const toSet = entries
    .filter((entry) => entry.teamId)
    .map((entry) => ({ round, player_id: entry.playerId, team_id: entry.teamId }));
  const toClear = entries.filter((entry) => !entry.teamId).map((entry) => entry.playerId);

  if (toSet.length) {
    const teamIds = [...new Set(toSet.map((entry) => entry.team_id))];
    const valid = asRows(
      await rest(dbClient, {
        path: `teams?select=id&round=${eq(round)}&id=${inList(teamIds)}`,
      })
    );
    const allowed = new Set(valid.map((team) => team.id));
    if (toSet.some((entry) => !allowed.has(entry.team_id))) {
      throw new Error(`Those teams do not belong to Round ${round}.`);
    }
    await rest(dbClient, {
      method: "POST",
      path: "roster?select=round,player_id,team_id",
      body: toSet,
      prefer: "resolution=merge-duplicates,return=representation",
    });
  }

  if (toClear.length) {
    await rest(dbClient, {
      method: "DELETE",
      path: `roster?round=${eq(round)}&player_id=${inList(toClear)}`,
      prefer: "return=representation",
    });
  }

  return { ok: true, updated: entries.length };
}

export async function copyRoster(dbClient, fromValue, toValue) {
  const from = Number(fromValue);
  const to = Number(toValue);
  if (![1, 2].includes(from) || ![1, 2].includes(to) || from === to) {
    throw new Error("from and to must be 1 and 2.");
  }

  const data = await loadRoster(dbClient);
  const sourceTeams = new Map(
    data.teams.filter((team) => team.round === from).map((team) => [team.id, team.name])
  );
  const destinationTeams = new Map(
    data.teams.filter((team) => team.round === to).map((team) => [team.name, team.id])
  );
  const rows = data.roster
    .filter((row) => row.round === from)
    .map((row) => ({
      round: to,
      player_id: row.player_id,
      team_id: destinationTeams.get(sourceTeams.get(row.team_id) ?? ""),
    }))
    .filter((row) => row.team_id);

  if (rows.length) {
    await rest(dbClient, {
      method: "POST",
      path: "roster?select=round,player_id,team_id",
      body: rows,
      prefer: "resolution=merge-duplicates,return=representation",
    });
  }
  return { ok: true, copied: rows.length };
}
