/**
 * The canvas must load in a checkout that has no `node_modules` and no
 * `.env.local`.
 *
 *   node --test scripts/portable.test.mjs
 *
 * This exists because it broke. Reading the tasks from the database put a
 * top-level `import ... from "@supabase/supabase-js"` in the canvas's load path.
 * `node_modules` is gitignored, so a worktree does not have one, and the import
 * threw at load time -- which does not fail the canvas, it fails the whole
 * EXTENSION. The panel did not error; it vanished. There was nothing to click.
 *
 * That is the precise opposite of the point of keeping the tasks in a table,
 * which was "open any session -- worktree, branch, any git branch -- and edit".
 *
 * So the rule is: **nothing in the canvas's import graph may require a package.**
 * Node built-ins and global `fetch` only. The test copies the real files into a
 * bare scratch checkout and imports them for real. A resolver guard rejects
 * packages and paths escaping the copy, so this repo's installed dependencies
 * cannot mask a transitive import.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isBuiltin, registerHooks } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const HERE = new URL(".", import.meta.url);
const guards = new Map();
const scratch = (prefix) => {
  const root = resolve(`.${prefix}-${randomUUID()}`);
  mkdirSync(root);
  return root;
};

/**
 * A throwaway checkout holding only the files the canvas needs.
 *
 * The resolver permits only builtins and files inside this copy. Importing a
 * package must fail even when the parent checkout has it installed.
 */
function bareCheckout() {
  const root = scratch("canvas-portable");
  const rootUrl = pathToFileURL(`${root}/`).href;
  guards.set(root, registerHooks({
    resolve(specifier, context, nextResolve) {
      if (!context.parentURL?.startsWith(rootUrl)) return nextResolve(specifier, context);
      if (isBuiltin(specifier)) return nextResolve(specifier, context);
      if (!specifier.startsWith(".") && !specifier.startsWith("file:")) {
        throw new Error(`Non-portable package import: ${specifier}`);
      }
      const result = nextResolve(specifier, context);
      if (!result.url.startsWith(rootUrl)) throw new Error(`Import escapes bare checkout: ${specifier}`);
      return result;
    },
  }));
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, ".github", "extensions", "scavenger-tasks"), { recursive: true });
  for (const file of ["task-store.mjs"]) {
    cpSync(new URL(file, HERE), join(root, "scripts", file));
  }
  for (const file of ["store.mjs", "roster-store.mjs"]) {
    cpSync(new URL(`../.github/extensions/scavenger-tasks/${file}`, HERE), join(root, ".github", "extensions", "scavenger-tasks", file));
  }
  return root;
}

const load = (root, rel) => import(pathToFileURL(join(root, rel)).href);
const cleanup = (root) => {
  guards.get(root)?.deregister();
  guards.delete(root);
  rmSync(root, { recursive: true, force: true });
};

test("the portability guard rejects a transitive package import even when installed", async () => {
  const root = bareCheckout();
  try {
    writeFileSync(join(root, "package-import.mjs"), 'import "@supabase/supabase-js";');
    await assert.rejects(load(root, "package-import.mjs"), /Non-portable package import/);
  } finally {
    cleanup(root);
  }
});

test("the canvas store imports with no node_modules and no .env.local", async () => {
  const root = bareCheckout();
  try {
    const store = await load(root, ".github/extensions/scavenger-tasks/store.mjs");
    // Importing is the whole assertion -- a throw here is an extension that
    // never registers, and a canvas the user cannot open at all.
    assert.equal(typeof store.loadTasks, "function");
    assert.equal(typeof store.summarize, "function");
  } finally {
    cleanup(root);
  }
});

test("the roster store imports with no node_modules and no .env.local", async () => {
  const root = bareCheckout();
  try {
    const roster = await load(root, ".github/extensions/scavenger-tasks/roster-store.mjs");
    assert.equal(typeof roster.loadRoster, "function");
    assert.equal(typeof roster.assignRoster, "function");
  } finally {
    cleanup(root);
  }
});

test("the query layer imports with no node_modules", async () => {
  const root = bareCheckout();
  try {
    const mod = await load(root, "scripts/task-store.mjs");
    for (const name of ["readTasks", "updateTask", "moveTask", "addTask", "createTaskClient"]) {
      assert.equal(typeof mod[name], "function", `${name} must be importable`);
    }
  } finally {
    cleanup(root);
  }
});

test("summarize works in a bare checkout, so the panel can render without credentials", async () => {
  // The header renders before anything is fetched. If this needed a package or
  // a connection, an offline or unconfigured checkout would show nothing.
  const root = bareCheckout();
  try {
    const { summarize } = await load(root, ".github/extensions/scavenger-tasks/store.mjs");
    assert.equal(summarize({ tasks: [] }).total, 0);
  } finally {
    cleanup(root);
  }
});

test("a missing .env.local is a readable error, never a crash at import", async () => {
  const root = bareCheckout();
  try {
    const { loadEnv } = await load(root, "scripts/task-store.mjs");
    // Pin the fallback to the bare copy, never this worktree's real credentials.
    const env = loadEnv({ cwd: root, mainCheckout: root, env: {} });
    assert.deepEqual(env, {}, "absence is an empty result, not a throw");
  } finally {
    cleanup(root);
  }
});

test("credentials are found in the main checkout when this one has none", async () => {
  // A worktree has no `.env.local` -- it is gitignored, so it exists only where
  // someone actually set the app up. The tasks are one table shared by every
  // checkout, so the only question a worktree has to answer is "where are the
  // credentials", and the main checkout is the answer.
  const root = bareCheckout();
  const main = scratch("canvas-main");
  try {
    writeFileSync(join(main, ".env.local"), "SUPABASE_URL=https://example.test\nSUPABASE_SERVICE_ROLE_KEY=secret\n");
    const { loadEnv } = await load(root, "scripts/task-store.mjs");
    const env = loadEnv({ cwd: root, mainCheckout: main, env: {} });
    assert.equal(env.SUPABASE_URL, "https://example.test");
    assert.equal(env.SUPABASE_SERVICE_ROLE_KEY, "secret");
  } finally {
    cleanup(root);
    cleanup(main);
  }
});

test("an exported variable wins over a file, so a session can be configured without one", async () => {
  const root = bareCheckout();
  try {
    const { loadEnv } = await load(root, "scripts/task-store.mjs");
    const env = loadEnv({ cwd: root, mainCheckout: root, env: { SUPABASE_URL: "https://from-env.test", SUPABASE_SERVICE_ROLE_KEY: "k" } });
    assert.equal(env.SUPABASE_URL, "https://from-env.test");
  } finally {
    cleanup(root);
  }
});
