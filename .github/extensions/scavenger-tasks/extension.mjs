// Extension: scavenger-tasks
// A planner for the scavenger hunt: the task list and the roster, both live.
//
// Every edit here writes the tables the app itself reads, so a player sees it on
// their next poll. There is no publish step, and nothing is staged. There used to
// be: task wording, points and cuts were held in a separate `task_board` table
// until someone pressed a button. See supabase/migrate-tasks-one-table.sql for
// why that is gone.
//
// extension.mjs is wiring only: store.mjs reads and writes the `tasks` table,
// roster-store.mjs the roster, tier.mjs owns the scoring model, and
// index.html/ui.js/ui.css are the renderer served over loopback.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";
import { addTask, loadTasks, summarize, updateModel, updateTask } from "./store.mjs";
import {
  addPlayers,
  addTeam,
  assignRoster,
  copyRoster,
  deletePlayer,
  deleteTeam,
  getRosterClient,
  loadRoster,
  updatePlayer,
  updateTeam,
} from "./roster-store.mjs";
import { scoreOf, suggestedPoints } from "./tier.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ASSETS = {
  "/": "index.html",
  "/ui.js": "ui.js",
  "/roster.js": "roster.js",
  "/ui.css": "ui.css",
  "/tier.mjs": "tier.mjs",
};
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css" };

/** instanceId -> { server, url }. One loopback server per open panel. */
const servers = new Map();
/** Open SSE responses across every instance, so an agent edit reaches all panels. */
const streams = new Set();

/** The task list plus everything derived from it, which is what the renderer wants. */
async function tasksPayload() {
  const board = await loadTasks();
  return {
    model: board.model,
    tasks: board.tasks.map((t) => ({
      ...t,
      score: +scoreOf(t, board.model.weights).toFixed(2),
      suggestedPoints: suggestedPoints(t, board.model),
    })),
  };
}

async function rosterPayload() {
  return loadRoster();
}

/**
 * Pushes the task list to every panel this process is serving.
 *
 * Same-process only, which is why it is an optimisation rather than the
 * mechanism: each session forks its own extension, so an edit made in one
 * session's canvas can never reach another session's panel over this stream.
 * The renderer polls `/api/tasks` for that, and the poll is what makes
 * cross-session freshness correct. A failure here is therefore not worth
 * reporting -- the next poll fixes it.
 */
async function broadcast() {
  if (!streams.size) return;
  let data;
  try {
    data = JSON.stringify(await tasksPayload());
  } catch {
    return;
  }
  for (const res of streams) {
    try {
      res.write(`event: tasks\ndata: ${data}\n\n`);
    } catch {
      streams.delete(res);
    }
  }
}

async function broadcastRoster() {
  if (!streams.size) return;
  let data;
  try {
    data = JSON.stringify(await rosterPayload());
  } catch {
    return;
  }
  for (const res of streams) {
    try {
      res.write(`event: roster\ndata: ${data}\n\n`);
    } catch {
      streams.delete(res);
    }
  }
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

async function handle(req, res) {
  const path = new URL(req.url, "http://127.0.0.1").pathname;

  if (path === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(`event: tasks\ndata: ${JSON.stringify(await tasksPayload())}\n\n`);
    try {
      res.write(`event: roster\ndata: ${JSON.stringify(await rosterPayload())}\n\n`);
    } catch {
      // The roster poll reports this in the panel without taking down the task list.
    }
    streams.add(res);
    req.on("close", () => streams.delete(res));
    return;
  }

  if (path === "/api/tasks") return json(res, 200, await tasksPayload());
  if (path === "/api/roster") return json(res, 200, await rosterPayload());

  if (path === "/api/model" && req.method === "PATCH") {
    const body = await readJson(req);
    if (!body) return json(res, 400, { error: "invalid JSON" });
    const model = await updateModel(body);
    await broadcast();
    return json(res, 200, model);
  }

  const taskMatch = path.match(/^\/api\/task\/([\w.-]+)$/);
  if (taskMatch && req.method === "PATCH") {
    const body = await readJson(req);
    if (!body) return json(res, 400, { error: "invalid JSON" });
    const task = await updateTask(taskMatch[1], body);
    if (!task) return json(res, 404, { error: "unknown task" });
    await broadcast();
    return json(res, 200, task);
  }

  if (path === "/api/task" && req.method === "POST") {
    const body = await readJson(req);
    if (!body) return json(res, 400, { error: "invalid JSON" });
    if (!String(body.title ?? "").trim()) return json(res, 400, { error: "a task needs some wording" });
    const task = await addTask(body);
    await broadcast();
    return json(res, 200, task);
  }

  if (path === "/api/roster/players" && req.method === "POST") {
    const body = await readJson(req);
    if (!body) return json(res, 400, { error: "invalid JSON" });
    const result = await addPlayers(getRosterClient(), body.names ?? body.name);
    await broadcastRoster();
    return json(res, 200, result);
  }

  if (path === "/api/roster/players" && req.method === "PATCH") {
    const body = await readJson(req);
    if (!body) return json(res, 400, { error: "invalid JSON" });
    const player = await updatePlayer(getRosterClient(), body.id, body.name);
    await broadcastRoster();
    return json(res, 200, player);
  }

  if (path === "/api/roster/players" && req.method === "DELETE") {
    const id = new URL(req.url, "http://127.0.0.1").searchParams.get("id");
    const result = await deletePlayer(getRosterClient(), id);
    await broadcastRoster();
    return json(res, 200, result);
  }

  if (path === "/api/roster/teams" && req.method === "POST") {
    const body = await readJson(req);
    if (!body) return json(res, 400, { error: "invalid JSON" });
    const result = await addTeam(getRosterClient(), body);
    await broadcastRoster();
    return json(res, 200, result);
  }

  if (path === "/api/roster/teams" && req.method === "PATCH") {
    const body = await readJson(req);
    if (!body) return json(res, 400, { error: "invalid JSON" });
    const { id, ...patch } = body;
    const result = await updateTeam(getRosterClient(), id, patch);
    await broadcastRoster();
    return json(res, 200, result);
  }

  if (path === "/api/roster/teams" && req.method === "DELETE") {
    const id = new URL(req.url, "http://127.0.0.1").searchParams.get("id");
    const result = await deleteTeam(getRosterClient(), id);
    await broadcastRoster();
    return json(res, 200, result);
  }

  if (path === "/api/roster/assign" && req.method === "POST") {
    const body = await readJson(req);
    if (!body) return json(res, 400, { error: "invalid JSON" });
    const result = await assignRoster(getRosterClient(), body.round, body.entries);
    await broadcastRoster();
    return json(res, 200, result);
  }

  if (path === "/api/roster/copy" && req.method === "POST") {
    const body = await readJson(req);
    if (!body) return json(res, 400, { error: "invalid JSON" });
    const result = await copyRoster(getRosterClient(), body.from, body.to);
    await broadcastRoster();
    return json(res, 200, result);
  }

  const asset = ASSETS[path];
  if (asset) {
    const file = await readFile(join(HERE, asset));
    res.writeHead(200, { "Content-Type": `${TYPES[extname(asset)]}; charset=utf-8` });
    return res.end(file);
  }

  res.writeHead(404).end("not found");
}

async function startServer() {
  const server = createServer((req, res) => {
    // Every handler is a network call, so it CAN fail. Say why in a body the
    // renderer can read: a bare 500 leaves the canvas unable to tell "there are
    // no tasks" from "the database is unreachable", and those two look identical
    // on screen while meaning opposite things.
    handle(req, res).catch((e) => {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: String(e?.message ?? e) }));
        return;
      }
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

// ── Agent-facing actions ─────────────────────────────────────────────────────
//
// Deliberately narrow. The UI owns judgment calls (ratings, live/cut); these
// exist so the agent can read the current task list and apply the one thing it
// is better at than a slider — rewriting the wording of a task.
//
// Every one of them writes the live table. There is no draft to work in.

const RATING_PROPS = Object.fromEntries(
  ["difficulty", "guts", "luck", "payoff", "risk"].map((k) => [k, { type: "integer", minimum: 1, maximum: 5 }])
);

const listTasks = {
  name: "list_tasks",
  description:
    "Read the live task list: every task with its wording, assigned and suggested point tier, ratings, notes, and whether players can see it. Filter to the subset you need.",
  inputSchema: {
    type: "object",
    properties: {
      round: { type: "integer", enum: [0, 1, 2], description: "0 = secret challenges, 1 = Round 1, 2 = Round 2" },
      active: { type: "boolean", description: "true for tasks players can see, false for cut ones" },
      flaggedForRewrite: { type: "boolean", description: "Only tasks the user marked as needing better wording" },
      mismatchedOnly: { type: "boolean", description: "Only tasks whose assigned tier disagrees with the ratings" },
    },
    additionalProperties: false,
  },
  handler: async (ctx) => {
    const { round, active, flaggedForRewrite, mismatchedOnly } = ctx.input ?? {};
    const payload = await tasksPayload();
    const tasks = payload.tasks.filter((t) => {
      if (round !== undefined && t.round !== round) return false;
      if (active !== undefined && t.active !== active) return false;
      if (flaggedForRewrite && !t.rewrite) return false;
      if (mismatchedOnly && t.points === t.suggestedPoints) return false;
      return true;
    });
    return { count: tasks.length, tasks };
  },
};

const updateTaskAction = {
  name: "update_task",
  description:
    "Change one task, live — players see it on their next poll. Use this to apply a wording rewrite (and clear its rewrite flag), or to record a rating, tier or cut decision the user asked for in chat. Setting active:false hides a task from players; it is never deleted and points already scored stand.",
  inputSchema: {
    type: "object",
    properties: {
      slug: { type: "string", description: "Task slug, e.g. r1-04 — from list_tasks" },
      title: { type: "string" },
      note: { type: "string" },
      prop: { type: "string" },
      points: { type: "integer", enum: [1, 3, 5, 7, 10] },
      scoringMode: { type: "string", enum: ["fixed", "quantity", "competition"] },
      measurementLabel: { type: "string" },
      measurementThreshold: { type: "integer", minimum: 0 },
      pointsPerUnit: { type: "integer", minimum: 0 },
      measurementCap: { type: ["integer", "null"], minimum: 0 },
      competitionBonus: { type: "integer", minimum: 0 },
      active: { type: "boolean" },
      requiresVideo: { type: "boolean" },
      rewrite: { type: "boolean", description: "Set false after applying a rewrite so it leaves the flagged list" },
      ...RATING_PROPS,
    },
    required: ["slug"],
    additionalProperties: false,
  },
  handler: async (ctx) => {
    const { slug, ...patch } = ctx.input ?? {};
    const task = await updateTask(slug, patch);
    if (!task) throw new CanvasError("task_not_found", `No task with slug "${slug}".`);
    const { model } = await loadTasks();
    await broadcast();
    return { ...task, suggestedPoints: suggestedPoints(task, model) };
  },
};

const addTaskAction = {
  name: "add_task",
  description:
    "Add a task. It goes live immediately, so players in that round will see it on their next poll. A secret (round 0) is offered in both halves of the event.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string" },
      round: { type: "integer", enum: [0, 1, 2] },
      points: { type: "integer", enum: [1, 3, 5, 7, 10] },
      scoringMode: { type: "string", enum: ["fixed", "quantity", "competition"] },
      measurementLabel: { type: "string" },
      measurementThreshold: { type: "integer", minimum: 0 },
      pointsPerUnit: { type: "integer", minimum: 0 },
      measurementCap: { type: ["integer", "null"], minimum: 0 },
      competitionBonus: { type: "integer", minimum: 0 },
      note: { type: "string" },
      ...RATING_PROPS,
    },
    required: ["title", "round"],
    additionalProperties: false,
  },
  handler: async (ctx) => {
    const task = await addTask(ctx.input);
    await broadcast();
    return task;
  },
};

const summaryAction = {
  name: "summary",
  description:
    "Task list rollup: how many are live and how many are cut, and per round the tier spread, total points available, tier disagreements, average payoff, and how many tasks are high-risk, high-luck or need a prop.",
  handler: async () => summarize(await loadTasks()),
};

const listRosterAction = {
  name: "list_roster",
  description:
    "Read the current people, teams and assignments. Optionally limit the result to one round so every player includes their assigned team name.",
  inputSchema: {
    type: "object",
    properties: {
      round: { type: "integer", enum: [1, 2], description: "Round to inspect; omit for both rounds" },
    },
    additionalProperties: false,
  },
  handler: async (ctx) => {
    const data = await rosterPayload();
    const requested = ctx.input?.round;
    const rounds = requested ? [requested] : [1, 2];
    const byId = new Map(data.players.map((player) => [player.id, player]));
    return {
      rounds: rounds.map((round) => {
        const teams = data.teams.filter((team) => team.round === round);
        const names = new Map(teams.map((team) => [team.id, team.name]));
        const assignments = new Map(
          data.roster.filter((entry) => entry.round === round).map((entry) => [entry.player_id, entry.team_id])
        );
        return {
          round,
          teams,
          players: data.players.map((player) => ({
            ...player,
            teamId: assignments.get(player.id) ?? null,
            teamName: names.get(assignments.get(player.id)) ?? null,
          })),
        };
      }),
      playerCount: byId.size,
    };
  },
};

const addPlayersAction = {
  name: "add_players",
  description: "Add one or more people to the guest list. Pass a comma- or newline-separated names string; duplicates are ignored.",
  inputSchema: {
    type: "object",
    properties: { names: { type: "string" } },
    required: ["names"],
    additionalProperties: false,
  },
  handler: async (ctx) => {
    const result = await addPlayers(getRosterClient(), ctx.input.names);
    await broadcastRoster();
    return result;
  },
};

const updatePlayerAction = {
  name: "update_player",
  description: "Rename one person without changing their id or any submission history.",
  inputSchema: {
    type: "object",
    properties: { playerId: { type: "string" }, name: { type: "string" } },
    required: ["playerId", "name"],
    additionalProperties: false,
  },
  handler: async (ctx) => {
    const player = await updatePlayer(getRosterClient(), ctx.input.playerId, ctx.input.name);
    await broadcastRoster();
    return player;
  },
};

const deletePlayerAction = {
  name: "delete_player",
  description: "Remove one person only when they have no submissions; the store refuses to delete evidence.",
  inputSchema: {
    type: "object",
    properties: { playerId: { type: "string" } },
    required: ["playerId"],
    additionalProperties: false,
  },
  handler: async (ctx) => {
    const result = await deletePlayer(getRosterClient(), ctx.input.playerId);
    await broadcastRoster();
    return result;
  },
};

const assignPlayersAction = {
  name: "assign_players",
  description:
    "Assign or unassign people for one round. Pass teamId as an empty string to clear an assignment; team ids must belong to that round.",
  inputSchema: {
    type: "object",
    properties: {
      round: { type: "integer", enum: [1, 2] },
      entries: {
        type: "array",
        items: {
          type: "object",
          properties: { playerId: { type: "string" }, teamId: { type: "string" } },
          required: ["playerId", "teamId"],
          additionalProperties: false,
        },
      },
    },
    required: ["round", "entries"],
    additionalProperties: false,
  },
  handler: async (ctx) => {
    const result = await assignRoster(getRosterClient(), ctx.input.round, ctx.input.entries);
    await broadcastRoster();
    return result;
  },
};

const addTeamAction = {
  name: "add_team",
  description: "Add a named team to both rounds so the roster remix can keep the two rounds paired.",
  inputSchema: {
    type: "object",
    properties: { name: { type: "string" }, color: { type: "string" } },
    required: ["name"],
    additionalProperties: false,
  },
  handler: async (ctx) => {
    const result = await addTeam(getRosterClient(), ctx.input);
    await broadcastRoster();
    return result;
  },
};

const updateTeamAction = {
  name: "update_team",
  description: "Rename or recolor a team; the matching team row in the other round is updated atomically too.",
  inputSchema: {
    type: "object",
    properties: { teamId: { type: "string" }, name: { type: "string" }, color: { type: "string" } },
    required: ["teamId"],
    additionalProperties: false,
  },
  handler: async (ctx) => {
    const { teamId, ...patch } = ctx.input;
    const result = await updateTeam(getRosterClient(), teamId, patch);
    await broadcastRoster();
    return result;
  },
};

const deleteTeamAction = {
  name: "delete_team",
  description: "Remove a team from both rounds only when it has no submissions; roster members become unassigned.",
  inputSchema: {
    type: "object",
    properties: { teamId: { type: "string" } },
    required: ["teamId"],
    additionalProperties: false,
  },
  handler: async (ctx) => {
    const result = await deleteTeam(getRosterClient(), ctx.input.teamId);
    await broadcastRoster();
    return result;
  },
};

const copyRosterAction = {
  name: "copy_roster",
  description: "Copy all assignments from one round to the other by paired team name.",
  inputSchema: {
    type: "object",
    properties: {
      from: { type: "integer", enum: [1, 2] },
      to: { type: "integer", enum: [1, 2] },
    },
    required: ["from", "to"],
    additionalProperties: false,
  },
  handler: async (ctx) => {
    const result = await copyRoster(getRosterClient(), ctx.input.from, ctx.input.to);
    await broadcastRoster();
    return result;
  },
};

// ── Registration ─────────────────────────────────────────────────────────────

await joinSession({
  canvases: [
    createCanvas({
      id: "scavenger-tasks",
      displayName: "Scavenger hunt planner",
      description:
        "Edit the live scavenger hunt: the task list, and the people, paired team names and Round 1/2 assignments.",
      actions: [
        listTasks,
        updateTaskAction,
        addTaskAction,
        summaryAction,
        listRosterAction,
        addPlayersAction,
        updatePlayerAction,
        deletePlayerAction,
        assignPlayersAction,
        addTeamAction,
        updateTeamAction,
        deleteTeamAction,
        copyRosterAction,
      ],
      open: async (ctx) => {
        // Idempotent: re-opens and provider reconnects both land here, and the
        // tasks are read from the database rather than kept per instance.
        let entry = servers.get(ctx.instanceId);
        if (!entry) {
          entry = await startServer();
          servers.set(ctx.instanceId, entry);
        }
        // A list that cannot be read must still open the panel: the renderer
        // says what went wrong, and a canvas that refuses to open says nothing
        // at all. The status line is a summary, never the thing that gates it.
        let status = "task list unavailable — open to see why";
        try {
          const { live, cut } = summarize(await loadTasks());
          status = `${live} live · ${cut} cut`;
        } catch {
          // Reported in the panel, which is where it can actually be read.
        }
        return { title: "Scavenger hunt planner", status, url: entry.url };
      },
      onClose: async (ctx) => {
        const entry = servers.get(ctx.instanceId);
        if (!entry) return;
        servers.delete(ctx.instanceId);
        await new Promise((resolve) => entry.server.close(() => resolve()));
      },
    }),
  ],
});
