/**
 * The canvas must load in a checkout that has no `node_modules` and no
 * `.env.local`.
 *
 *   node --test scripts/board-portable.test.mjs
 *
 * This exists because it broke. Moving the board into the database put a
 * top-level `import ... from "@supabase/supabase-js"` in the canvas's load path.
 * `node_modules` is gitignored, so a worktree does not have one, and the import
 * threw at load time -- which does not fail the canvas, it fails the whole
 * EXTENSION. The panel did not error; it vanished. There was nothing to click.
 *
 * That is the precise opposite of the point of moving the board into a table,
 * which was "open any session -- worktree, branch, any git branch -- and edit".
 *
 * So the rule is: **nothing in the canvas's import graph may require a package.**
 * Node built-ins and global `fetch` only. The test copies the real files into a
 * bare temp directory with no `node_modules` anywhere above it and imports them
 * for real, because that is the only thing that actually proves it -- reading
 * the source for import statements would miss a transitive one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const HERE = new URL(".", import.meta.url);

/**
 * A throwaway checkout holding only the files the canvas needs.
 *
 * Built under the OS temp directory rather than beside the repo: Node walks
 * every parent looking for `node_modules`, so a copy inside the repo would find
 * the real one and the test would pass while the bug was still there.
 */
function bareCheckout() {
  const root = mkdtempSync(join(tmpdir(), "board-portable-"));
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, ".github", "extensions", "scavenger-tasks"), { recursive: true });
  for (const file of ["board-store.mjs"]) {
    cpSync(new URL(file, HERE), join(root, "scripts", file));
  }
  for (const file of ["store.mjs", "roster-store.mjs", "tier.mjs", "publish-state.mjs"]) {
    cpSync(new URL(`../.github/extensions/scavenger-tasks/${file}`, HERE), join(root, ".github", "extensions", "scavenger-tasks", file));
  }
  return root;
}

const load = (root, rel) => import(pathToFileURL(join(root, rel)).href);

test("the canvas store imports with no node_modules and no .env.local", async () => {
  const root = bareCheckout();
  try {
    const store = await load(root, ".github/extensions/scavenger-tasks/store.mjs");
    // Importing is the whole assertion -- a throw here is an extension that
    // never registers, and a canvas the user cannot open at all.
    assert.equal(typeof store.loadBoard, "function");
    assert.equal(typeof store.summarize, "function");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the roster store imports with no node_modules and no .env.local", async () => {
  const root = bareCheckout();
  try {
    const roster = await load(root, ".github/extensions/scavenger-tasks/roster-store.mjs");
    assert.equal(typeof roster.loadRoster, "function");
    assert.equal(typeof roster.assignRoster, "function");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the board's query layer imports with no node_modules", async () => {
  const root = bareCheckout();
  try {
    const mod = await load(root, "scripts/board-store.mjs");
    for (const name of ["readBoard", "updateTask", "addTask", "updateModel", "createBoardClient"]) {
      assert.equal(typeof mod[name], "function", `${name} must be importable`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("summarize works in a bare checkout, so the panel can render without credentials", async () => {
  // The header renders before anything is fetched. If this needed a package or
  // a connection, an offline or unconfigured checkout would show nothing.
  const root = bareCheckout();
  try {
    const { summarize } = await load(root, ".github/extensions/scavenger-tasks/store.mjs");
    assert.equal(summarize({ tasks: [], model: null }).total, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing .env.local is a readable error, never a crash at import", async () => {
  const root = bareCheckout();
  try {
    const { loadEnv } = await load(root, "scripts/board-store.mjs");
    // No .env.local anywhere above a temp directory, and no vars exported.
    const env = loadEnv({ cwd: root, env: {} });
    assert.deepEqual(env, {}, "absence is an empty result, not a throw");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("credentials are found in the main checkout when this one has none", async () => {
  // A worktree has no `.env.local` -- it is gitignored, so it exists only where
  // someone actually set the app up. The board is one table shared by every
  // checkout, so the only question a worktree has to answer is "where are the
  // credentials", and the main checkout is the answer.
  const root = bareCheckout();
  const main = mkdtempSync(join(tmpdir(), "board-main-"));
  try {
    writeFileSync(join(main, ".env.local"), "SUPABASE_URL=https://example.test\nSUPABASE_SERVICE_ROLE_KEY=secret\n");
    const { loadEnv } = await load(root, "scripts/board-store.mjs");
    const env = loadEnv({ cwd: root, mainCheckout: main, env: {} });
    assert.equal(env.SUPABASE_URL, "https://example.test");
    assert.equal(env.SUPABASE_SERVICE_ROLE_KEY, "secret");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(main, { recursive: true, force: true });
  }
});

test("an exported variable wins over a file, so a session can be configured without one", async () => {
  const root = bareCheckout();
  try {
    const { loadEnv } = await load(root, "scripts/board-store.mjs");
    const env = loadEnv({ cwd: root, env: { SUPABASE_URL: "https://from-env.test", SUPABASE_SERVICE_ROLE_KEY: "k" } });
    assert.equal(env.SUPABASE_URL, "https://from-env.test");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
