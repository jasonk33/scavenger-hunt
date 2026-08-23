// Extension: scavenger-tasks
// A board for tuning the scavenger hunt task list: rate every task on the same
// axes, let the point tier fall out of those ratings, and see where the tier in
// the doc disagrees. Wording changes stay an agent job — the UI just flags them.
//
// extension.mjs is wiring only: seed.mjs holds the task data, store.mjs owns
// durable state and the scoring model, and index.html/ui.js/ui.css are the
// renderer served over loopback.

import { createServer } from "node:http";
import { execFile, execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";
import { addTask, BOARD_PATH, loadBoard, scoreOf, suggestedPoints, summarize, updateModel, updateTask } from "./store.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ASSETS = {
  "/": "index.html",
  "/ui.js": "ui.js",
  "/ui.css": "ui.css",
  "/publish-state.mjs": "publish-state.mjs",
  "/tier.mjs": "tier.mjs",
};
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css" };

// ── Publishing ───────────────────────────────────────────────────────────────
//
// The canvas deliberately contains no sync logic. It shells out to the real
// `scripts/task-sync.mjs --json`, so the collision refusal, the pre-migration
// refusal and the worktree refusal are inherited rather than reimplemented, and
// cannot drift from the thing they are meant to guard.

const SYNC_SCRIPT = fileURLToPath(new URL("../../../scripts/task-sync.mjs", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
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
function boardPayload() {
  const board = loadBoard();
  return {
    model: board.model,
    tasks: board.tasks.map((t) => ({
      ...t,
      score: +scoreOf(t, board.model).toFixed(2),
      suggestedPoints: suggestedPoints(t, board.model),
    })),
  };
}

function broadcast() {
  const data = JSON.stringify(boardPayload());
  for (const res of streams) {
    try {
      res.write(`event: board\ndata: ${data}\n\n`);
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
    res.write(`event: board\ndata: ${JSON.stringify(boardPayload())}\n\n`);
    streams.add(res);
    req.on("close", () => streams.delete(res));
    return;
  }

  if (path === "/api/board") return json(res, 200, boardPayload());

  if (path === "/api/publish/status") return json(res, 200, await runSync(false));

  if (path === "/api/publish" && req.method === "POST") {
    // The script decides whether this is allowed; every refusal it can raise
    // comes back in the report rather than being pre-judged here.
    return json(res, 200, await runSync(true));
  }

  if (path === "/api/model" && req.method === "PATCH") {
    const body = await readJson(req);
    if (!body) return json(res, 400, { error: "invalid JSON" });
    updateModel(body);
    broadcast();
    return json(res, 200, boardPayload().model);
  }

  const taskMatch = path.match(/^\/api\/task\/([\w.-]+)$/);
  if (taskMatch && req.method === "PATCH") {
    const body = await readJson(req);
    if (!body) return json(res, 400, { error: "invalid JSON" });
    const task = updateTask(taskMatch[1], body);
    if (!task) return json(res, 404, { error: "unknown task" });
    broadcast();
    return json(res, 200, task);
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
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
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
    const tasks = boardPayload().tasks.filter((t) => {
      if (round !== undefined && t.round !== round) return false;
      if (status && t.status !== status) return false;
      if (flaggedForRewrite && !t.rewrite) return false;
      if (mismatchedOnly && t.points === t.suggestedPoints) return false;
      return true;
    });
    return { boardPath: BOARD_PATH, count: tasks.length, tasks };
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
    const task = updateTask(taskId, patch);
    if (!task) throw new CanvasError("task_not_found", `No task with id "${taskId}".`);
    broadcast();
    return { ...task, suggestedPoints: suggestedPoints(task, loadBoard().model) };
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
    const task = addTask(ctx.input);
    broadcast();
    return task;
  },
};

const summaryAction = {
  name: "summary",
  description:
    "Board rollup: counts by status, and per round the tier spread, total points available, tier disagreements, average payoff, and how many tasks are high-risk, high-luck or need a prop.",
  handler: async () => ({ boardPath: BOARD_PATH, ...summarize(loadBoard()) }),
};

// ── Registration ─────────────────────────────────────────────────────────────

await joinSession({
  canvases: [
    createCanvas({
      id: "scavenger-tasks",
      displayName: "Scavenger hunt tasks",
      description:
        "Rate, re-tier, and cut scavenger hunt tasks — shows where each task's assigned point value disagrees with its difficulty/guts/luck ratings.",
      actions: [listTasks, updateTaskAction, addTaskAction, summaryAction],
      open: async (ctx) => {
        // Idempotent: re-opens and provider reconnects both land here, and the
        // board is loaded from disk rather than kept per instance.
        let entry = servers.get(ctx.instanceId);
        if (!entry) {
          entry = await startServer();
          servers.set(ctx.instanceId, entry);
        }
        const { keep, maybe, cut } = summarize(loadBoard());
        return {
          title: "Scavenger hunt tasks",
          status: `${keep} keep · ${maybe} maybe · ${cut} cut`,
          url: entry.url,
        };
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
