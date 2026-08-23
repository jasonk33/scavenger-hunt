// Extension: scavenger-tasks
// A planner for tuning the scavenger hunt task list and editing the live roster.
// Tasks wait for Publish; people, team names and round assignments write live.
//
// extension.mjs is wiring only: store.mjs reads and writes the board in the
// task_board table, tier.mjs owns the scoring model, and index.html/ui.js/ui.css
// are the renderer served over loopback.

import { createServer } from "node:http";
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";
import { addTask, loadBoard, summarize, updateModel, updateTask } from "./store.mjs";
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
import { mainCheckout } from "../../../scripts/board-store.mjs";
import { scoreOf, suggestedPoints } from "./tier.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ASSETS = {
  "/": "index.html",
  "/ui.js": "ui.js",
  "/roster.js": "roster.js",
  "/ui.css": "ui.css",
  "/publish-state.mjs": "publish-state.mjs",
  "/tier.mjs": "tier.mjs",
};
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css" };

// ── Publishing ───────────────────────────────────────────────────────────────
//
// The canvas deliberately contains no sync logic. It shells out to the real
// `scripts/task-sync.mjs --json`, so the collision refusal and the pre-migration
// refusal are inherited rather than reimplemented, and cannot drift from the
// thing they are meant to guard.
//
// It runs the sync from a checkout that can actually run it. The BOARD is a
// table and reachable from anywhere, but `task-sync` imports the Supabase client
// and reads `.env.local`, and both `node_modules` and `.env.local` are
// gitignored -- so they exist only where someone set the app up. In a worktree
// that is the main checkout, not this one. Running the worktree's own copy fails
// on `Cannot find package @supabase/supabase-js` before it reaches a credential.

const THIS_CHECKOUT = fileURLToPath(new URL("../../../", import.meta.url));

/** The nearest checkout with a `node_modules`, since that is what `node` needs. */
const REPO_ROOT = (() => {
  if (existsSync(join(THIS_CHECKOUT, "node_modules"))) return THIS_CHECKOUT;
  const main = mainCheckout(THIS_CHECKOUT);
  return main && existsSync(join(main, "node_modules")) ? main : THIS_CHECKOUT;
})();
const SYNC_SCRIPT = join(REPO_ROOT, "scripts", "task-sync.mjs");
/** `api()` having no timeout is a named sharp edge in AGENTS.md; a hung Supabase
 *  call must land in the banner's error state rather than spinning forever. */
const SYNC_TIMEOUT_MS = 30_000;

/**
 * Which `node` to run the sync with.
 *
 * NOT `process.execPath`: extensions are forked from the Copilot binary, so that
 * resolves to Copilot itself, which parses `--json` as one of its own flags and
 * fails. Found once, at startup, so a missing node surfaces as a stated error in
 * the banner rather than as a mystery on the day.
 */
const NODE_BIN = (() => {
  const candidates = [
    process.env.SCAVENGER_TASKS_NODE,
    "node",
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/usr/bin/node",
  ].filter(Boolean);
  for (const bin of candidates) {
    try {
      execFileSync(bin, ["--version"], { stdio: ["ignore", "ignore", "ignore"], timeout: 5000 });
      return bin;
    } catch {
      // Not this one.
    }
  }
  return null;
})();

/**
 * Runs are serialized end to end, and only a *status* run is ever shared.
 *
 * Sharing a run with a publish would be silent and catastrophic: a publish
 * arriving while a status poll was in flight would receive the dry run's report,
 * announce success, and never have written anything.
 */
let statusInFlight = null;
let chain = Promise.resolve();

/**
 * Runs the sync and returns its report.
 *
 * A non-zero exit with parseable JSON is a *result* -- that is how a refusal and
 * a collision arrive. A non-zero exit with nothing parseable is a failure, and
 * is reported as one: the banner has to be able to tell those apart, because
 * confusing them is the difference between "blocked, here's why" and a silent
 * false "nothing to publish".
 */
function execSync(apply) {
  const args = [SYNC_SCRIPT, "--json"];
  if (apply) args.push("--apply");
  const startedAt = Date.now();

  if (!NODE_BIN) {
    return Promise.resolve({
      ok: false,
      count: null,
      checkedAt: startedAt,
      error:
        "Could not find a node binary to run scripts/task-sync.mjs with. " +
        "Set SCAVENGER_TASKS_NODE to its path, or publish from a terminal with " +
        "`npm run sync:tasks -- --apply`.",
    });
  }

  return new Promise((resolve) => {
    execFile(
      NODE_BIN,
      args,
      { cwd: REPO_ROOT, timeout: SYNC_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const raw = String(stdout ?? "").trim();
        let report = null;
        if (raw) {
          try {
            report = JSON.parse(raw);
          } catch {
            report = null;
          }
        }
        // `checkedAt` is when the run STARTED, not when it finished: the board
        // it describes is the one that existed at the start, so an edit made
        // while it was running must still read as newer than the count.
        if (report && typeof report === "object" && !Array.isArray(report)) {
          resolve({ ...report, checkedAt: startedAt });
          return;
        }
        const why = err?.killed
          ? `The check timed out after ${SYNC_TIMEOUT_MS / 1000}s.`
          : String(stderr ?? "").trim() || err?.message || "the sync produced no output";
        resolve({ ok: false, count: null, error: why, checkedAt: startedAt });
      }
    );
  });
}

function runSync(apply = false) {
  if (apply) {
    const run = chain.then(() => execSync(true));
    chain = run.catch(() => {});
    return run;
  }
  if (statusInFlight) return statusInFlight;
  const run = chain.then(() => execSync(false));
  chain = run.catch(() => {});
  statusInFlight = run.finally(() => {
    statusInFlight = null;
  });
  return statusInFlight;
}

/** instanceId -> { server, url }. One loopback server per open panel. */
const servers = new Map();
/** Open SSE responses across every instance, so an agent edit reaches all panels. */
const streams = new Set();

/** The board plus everything derived from it, which is what the renderer wants. */
async function boardPayload() {
  const board = await loadBoard();
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
 * Pushes the board to every panel this process is serving.
 *
 * Same-process only, which is why it is an optimisation rather than the
 * mechanism: each session forks its own extension, so an edit made in one
 * session's canvas can never reach another session's panel over this stream.
 * The renderer polls `/api/board` for that, and the poll is what makes
 * cross-session freshness correct. A failure here is therefore not worth
 * reporting -- the next poll fixes it.
 */
async function broadcast() {
  if (!streams.size) return;
  let data;
  try {
    data = JSON.stringify(await boardPayload());
  } catch {
    return;
  }
  for (const res of streams) {
    try {
      res.write(`event: board\ndata: ${data}\n\n`);
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
    res.write(`event: board\ndata: ${JSON.stringify(await boardPayload())}\n\n`);
    try {
      res.write(`event: roster\ndata: ${JSON.stringify(await rosterPayload())}\n\n`);
    } catch {
      // The roster poll reports this in the panel without taking down the task board.
    }
    streams.add(res);
    req.on("close", () => streams.delete(res));
    return;
  }

  if (path === "/api/board") return json(res, 200, await boardPayload());
  if (path === "/api/roster") return json(res, 200, await rosterPayload());

  if (path === "/api/publish/status") return json(res, 200, await runSync(false));

  if (path === "/api/publish" && req.method === "POST") {
    // The script decides whether this is allowed; every refusal it can raise
    // comes back in the report rather than being pre-judged here.
    return json(res, 200, await runSync(true));
  }

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
    // The board is a network call now, so a handler CAN fail in ways the file
    // never did. Say why in a body the renderer can read: a bare 500 leaves the
    // canvas unable to tell "the board is empty" from "the board is unreachable",
    // and those two look identical on screen while meaning opposite things.
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
// Deliberately narrow. The UI owns judgment calls (ratings, keep/cut); these
// exist so the agent can read the board's current state and apply the one thing
// it is better at than a slider — rewriting the wording of a task.

const RATING_PROPS = Object.fromEntries(
  ["difficulty", "guts", "luck", "payoff", "risk"].map((k) => [k, { type: "integer", minimum: 1, maximum: 5 }])
);

const listTasks = {
  name: "list_tasks",
  description:
    "Read the current task board: every task with its wording, assigned and suggested point tier, ratings, status and notes. Filter to the subset you need.",
  inputSchema: {
    type: "object",
    properties: {
      round: { type: "integer", enum: [0, 1, 2], description: "0 = secret challenges, 1 = Round 1, 2 = Round 2" },
      status: { type: "string", enum: ["keep", "maybe", "cut"] },
      flaggedForRewrite: { type: "boolean", description: "Only tasks the user marked as needing better wording" },
      mismatchedOnly: { type: "boolean", description: "Only tasks whose assigned tier disagrees with the ratings" },
    },
    additionalProperties: false,
  },
  handler: async (ctx) => {
    const { round, status, flaggedForRewrite, mismatchedOnly } = ctx.input ?? {};
    const payload = await boardPayload();
    const tasks = payload.tasks.filter((t) => {
      if (round !== undefined && t.round !== round) return false;
      if (status && t.status !== status) return false;
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
    "Change one task. Use this to apply a wording rewrite (and clear its rewrite flag), or to record a rating, tier or keep/cut decision the user asked for in chat.",
  inputSchema: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "Task id, e.g. r1-04 — from list_tasks" },
      title: { type: "string" },
      note: { type: "string" },
      prop: { type: "string" },
      points: { type: "integer", enum: [1, 3, 5, 7, 10] },
      status: { type: "string", enum: ["keep", "maybe", "cut"] },
      needsClip: { type: "boolean" },
      rewrite: { type: "boolean", description: "Set false after applying a rewrite so it leaves the flagged list" },
      ...RATING_PROPS,
    },
    required: ["taskId"],
    additionalProperties: false,
  },
  handler: async (ctx) => {
    const { taskId, ...patch } = ctx.input ?? {};
    const task = await updateTask(taskId, patch);
    if (!task) throw new CanvasError("task_not_found", `No task with id "${taskId}".`);
    const { model } = await loadBoard();
    await broadcast();
    return { ...task, suggestedPoints: suggestedPoints(task, model) };
  },
};

const addTaskAction = {
  name: "add_task",
  description: "Add a new task to the board. It lands as 'maybe' so it has to be reviewed before it counts.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string" },
      round: { type: "integer", enum: [0, 1, 2] },
      points: { type: "integer", enum: [1, 3, 5, 7, 10] },
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
    "Board rollup: counts by status, and per round the tier spread, total points available, tier disagreements, average payoff, and how many tasks are high-risk, high-luck or need a prop.",
  handler: async () => summarize(await loadBoard()),
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
        "Plan tasks and edit the live scavenger hunt roster: people, paired team names, and Round 1/2 assignments.",
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
        // board is read from the database rather than kept per instance.
        let entry = servers.get(ctx.instanceId);
        if (!entry) {
          entry = await startServer();
          servers.set(ctx.instanceId, entry);
        }
        // A board that cannot be read must still open the panel: the renderer
        // says what went wrong, and a canvas that refuses to open says nothing
        // at all. The status line is a summary, never the thing that gates it.
        let status = "board unavailable — open to see why";
        try {
          const { keep, maybe, cut } = summarize(await loadBoard());
          status = `${keep} keep · ${maybe} maybe · ${cut} cut`;
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
