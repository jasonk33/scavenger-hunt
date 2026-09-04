// Offline: every browser request is fulfilled here, never by the live canvas/DB.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { chromium } from "@playwright/test";

const root = new URL("../.github/extensions/scavenger-tasks/", import.meta.url);
const model = () => ({ weights: { difficulty: 1.2, guts: 1, luck: 0.6 }, thresholds: { t1: 5.9, t3: 8.1, t5: 10.8 } });
const task = (slug, active = true) => ({
  slug, title: `Task ${slug}`, round: 1, docOrder: slug.charCodeAt(0),
  active, points: 3, scoringMode: "fixed", measurementLabel: "", pointsPerUnit: 0,
  competitionBonus: 0, difficulty: 3, guts: 3, luck: 3, payoff: 3, risk: 1,
  note: "", prop: "", requiresVideo: false, rewrite: false, tierOk: null,
});
let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });

async function canvas(t) {
  const page = await browser.newPage();
  const state = { tasks: [task("a"), task("b", false), task("c")], model: model() };
  const writes = [];
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    window.EventSource = class { addEventListener() {} };
  });
  await page.route("**/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/tasks") return route.fulfill({ json: structuredClone(state) });
    if (path === "/api/roster") return route.fulfill({ json: { players: [], teams: [], roster: [] } });
    if (route.request().method() === "PATCH") {
      const patch = route.request().postDataJSON();
      let release;
      const done = new Promise((resolve) => { release = resolve; });
      writes.push({
        path, patch,
        finish: async (status = 200) => {
          if (status === 0) await route.abort("failed");
          else {
            let body = { error: "offline fixture failure" };
            if (status === 200) {
              if (path === "/api/model") {
                for (const group of ["weights", "thresholds"]) Object.assign(state.model[group], patch[group]);
                body = structuredClone(state.model);
              } else {
                body = state.tasks.find((x) => path === `/api/task/${x.slug}`);
                Object.assign(body, patch);
              }
            }
            await route.fulfill({ status, json: body });
          }
          release();
        },
      });
      await done;
      return;
    }
    const name = path === "/" ? "index.html" : path.slice(1);
    assert.match(name, /^[a-z-]+\.(html|js|mjs|css)$/, `unexpected request ${path}`);
    let body = await readFile(new URL(name, root), "utf8");
    if (name === "ui.js") body += "\nwindow.canvasTest = { refreshTasks, applyTasks };";
    return route.fulfill({
      body, contentType: name.endsWith(".html") ? "text/html" : name.endsWith(".css") ? "text/css" : "text/javascript",
    });
  });
  t.after(async () => { await page.close(); assert.deepEqual(errors, []); });
  await page.goto("https://canvas.test");
  await page.waitForFunction(() => !!window.canvasTest);
  const refresh = () => page.evaluate(() => window.canvasTest.refreshTasks());
  const slugs = () => page.locator("#list [data-slug]").evaluateAll((nodes) => nodes.map((node) => node.dataset.slug));
  async function written(n) {
    for (let i = 0; i < 100 && writes.length < n; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(writes.length >= n, `expected ${n} writes, received ${writes.length}`);
    return writes[n - 1];
  }
  async function note(slug, value) {
    const row = page.locator(`[data-slug="${slug}"]`);
    if (!await row.locator(".body").isVisible()) await row.locator(".caret").click();
    await row.locator(".note").fill(value);
  }
  return { page, state, writes, written, note, refresh, slugs };
}

test("task saves are ordered and retain in-flight edits across polls", async (t) => {
  const c = await canvas(t);
  await c.note("a", "first edit");
  const first = await c.written(1);
  c.state.tasks[0].prop = "remote prop";
  await c.refresh();
  assert.equal(await c.page.locator('[data-slug="a"] .note').inputValue(), "first edit");
  await c.note("a", "second edit");
  await c.page.waitForTimeout(350);
  assert.equal(c.writes.length, 1, "only one same-task PATCH may be in flight");
  await first.finish();
  const second = await c.written(2);
  assert.deepEqual(second.patch, { note: "second edit" });
  await second.finish();
  await c.refresh();
  assert.equal(c.state.tasks[0].note, "second edit");
  assert.equal(await c.page.locator('[data-slug="a"] .prop').inputValue(), "remote prop");
});

for (const status of [500, 0]) {
  test(`failed task save (${status || "network"}) stays visible and can be retried`, async (t) => {
    const c = await canvas(t);
    await c.note("a", "keep this");
    await (await c.written(1)).finish(status);
    await c.page.getByRole("button", { name: "Retry saves" }).waitFor({ timeout: 1500 });
    assert.match(await c.page.locator("#save-status").innerText(), /not saved/i);
    c.state.tasks[0].title = "Changed elsewhere";
    await c.refresh();
    assert.equal(await c.page.locator('[data-slug="a"] .note').inputValue(), "keep this");
    assert.equal(await c.page.locator('[data-slug="a"] .title').innerText(), "Changed elsewhere");
    await c.page.getByRole("button", { name: "Retry saves" }).click();
    await (await c.written(2)).finish();
    await c.page.getByRole("button", { name: "Retry saves" }).waitFor({ state: "hidden" });
    assert.equal(c.state.tasks[0].note, "keep this");
  });
}

test("model saves send only edited fields, in order, and recover from failure", async (t) => {
  const c = await canvas(t);
  await c.page.locator("#toggle-balance").click();
  await c.page.locator('[data-weight="difficulty"]').fill("2");
  await c.page.locator('[data-weight="difficulty"]').press("Tab");
  const first = await c.written(1);
  assert.deepEqual(first.patch, { weights: { difficulty: 2 } });
  await c.page.locator('[data-weight="difficulty"]').fill("3");
  await c.page.locator('[data-weight="difficulty"]').press("Tab");
  await c.page.waitForTimeout(350);
  assert.equal(c.writes.length, 1);
  await first.finish(500);
  await c.page.getByRole("button", { name: "Retry saves" }).waitFor();
  await c.page.locator("#search").focus();
  c.state.model.weights.guts = 4;
  await c.refresh();
  assert.equal(await c.page.locator('[data-weight="difficulty"]').inputValue(), "3");
  assert.equal(await c.page.locator('[data-weight="guts"]').inputValue(), "4");
  await c.page.getByRole("button", { name: "Retry saves" }).click();
  const retry = await c.written(2);
  assert.deepEqual(retry.patch, { weights: { difficulty: 3 } });
  await retry.finish();
  assert.equal(c.state.model.weights.guts, 4);
  assert.equal(c.state.model.weights.difficulty, 3);
});

test("polls reconcile live/cut membership while retaining focused and open rows", async (t) => {
  const c = await canvas(t);
  await c.note("c", "unsent edit");
  await c.page.locator('[data-slug="c"] .note').evaluate((node) => { node.marker = true; });
  c.state.tasks[0].active = false;
  c.state.tasks[1].active = true;
  await c.refresh();
  assert.deepEqual(await c.slugs(), ["b", "c"]);
  assert.equal(await c.page.locator('[data-slug="c"] .note').evaluate((node) => node.marker && node === document.activeElement), true);
  assert.equal(await c.page.locator('[data-slug="c"] .body').isVisible(), true);
});

for (const filter of ["search", "flagged", "risk"]) {
  test(`polls reconcile ${filter} membership/order even with the same slugs`, async (t) => {
    const c = await canvas(t);
    c.state.tasks.forEach((x) => { x.active = true; });
    c.state.tasks[0].note = "target";
    c.state.tasks[0].rewrite = true;
    c.state.tasks[0].risk = 4;
    await c.refresh();
    if (filter === "search") { await c.page.locator("#search").fill("target"); await c.page.waitForTimeout(150); }
    if (filter === "flagged") await c.page.locator("#only-flagged").check();
    if (filter === "risk") await c.page.locator("#sort").selectOption("risk");
    c.state.tasks[0].note = "";
    c.state.tasks[0].rewrite = false;
    c.state.tasks[1].note = "target";
    c.state.tasks[1].rewrite = true;
    c.state.tasks[1].risk = 5;
    await c.refresh();
    assert.deepEqual(await c.slugs(), filter === "risk" ? ["b", "a", "c"] : ["b"]);
  });
}

test("adding a remote task preserves existing row identity and model input focus", async (t) => {
  const c = await canvas(t);
  await c.page.locator('[data-slug="a"] .caret').click();
  await c.page.locator('[data-slug="a"]').evaluate((node) => { node.marker = true; });
  await c.page.locator("#toggle-balance").click();
  await c.page.locator('[data-weight="difficulty"]').fill("2.");
  c.state.tasks.push(task("d"));
  await c.refresh();
  assert.equal(await c.page.locator('[data-slug="a"]').evaluate((node) => node.marker), true);
  assert.equal(await c.page.locator('[data-slug="a"] .body').isVisible(), true);
  assert.equal(await c.page.locator('[data-weight="difficulty"]').evaluate((node) => node === document.activeElement), true);
});

test("a failure keeps newer queued edits until an explicit retry", async (t) => {
  const c = await canvas(t);
  await c.note("a", "first edit");
  const first = await c.written(1);
  await c.note("a", "newer edit");
  await first.finish(500);
  await c.page.waitForTimeout(350);
  assert.equal(c.writes.length, 1, "the debounce timer must not clear a failed save's recovery state");
  await c.page.getByRole("button", { name: "Retry saves" }).click();
  const retry = await c.written(2);
  assert.deepEqual(retry.patch, { note: "newer edit" });
  await retry.finish();
});

test("a reordered focused row keeps its draft and only disappears after blur", async (t) => {
  const c = await canvas(t);
  await c.page.locator("#sort").selectOption("risk");
  await c.page.locator('[data-slug="c"] .title').fill("unfinished title");
  c.state.tasks[2].risk = 5;
  await c.refresh();
  assert.deepEqual(await c.slugs(), ["c", "a"]);
  assert.equal(await c.page.locator('[data-slug="c"] .title').evaluate((node) => node === document.activeElement), true);
  assert.equal(c.writes.length, 0, "reordering must not blur/save an unfinished title");
  c.state.tasks[2].active = false;
  await c.refresh();
  assert.ok((await c.slugs()).includes("c"), "defer removing the focused draft");
  await c.page.locator('[data-slug="c"] .title').press("Tab");
  // Focus remains inside that row after Tab; explicitly leave the row to finish.
  await c.page.locator("#search").focus();
  await c.page.waitForFunction(() => !document.querySelector('[data-slug="c"]'));
  assert.deepEqual(await c.slugs(), ["a"]);
  const write = await c.written(1);
  assert.deepEqual(write.patch, { title: "unfinished title" });
  await write.finish();
});

for (const concurrentMembership of [false, true]) {
  test(`focused cut/restored tasks keep round headings ordered${concurrentMembership ? " with concurrent membership changes" : ""}`, async (t) => {
    const c = await canvas(t);
    c.state.tasks = [task("a"), task("b"), { ...task("c"), round: 2 }, { ...task("d"), round: 2 }];
    await c.refresh();
    const r1 = "Round 1 · Madison Square Park";
    const r2 = "Round 2 · NoMad & Flatiron";
    const interleaving = () => c.page.locator("#list > *").evaluateAll((nodes) =>
      nodes.map((node) => node.dataset.slug || node.textContent)
    );
    assert.deepEqual(await interleaving(), [r1, "a", "b", r2, "c", "d"]);
    await c.page.locator('[data-slug="b"] .caret').click();
    const title = c.page.locator('[data-slug="b"] .title');
    await title.fill("unfinished title");
    await title.evaluate((node) => { node.marker = true; });
    if (concurrentMembership) {
      c.state.tasks[0].active = false;
      c.state.tasks.push({ ...task("e"), docOrder: 1 });
    }
    const first = concurrentMembership ? "e" : "a";
    for (const active of [false, true, false]) {
      c.state.tasks[1].active = active;
      await c.refresh();
      assert.deepEqual(await interleaving(), [r1, first, "b", r2, "c", "d"]);
      assert.equal(await title.evaluate((node) => node.marker && node === document.activeElement), true);
      assert.equal(await title.innerText(), "unfinished title");
      assert.equal(await c.page.locator('[data-slug="b"] .body').isVisible(), true);
      assert.equal(c.writes.length, 0, "remote cut/restore must not blur or save the draft");
    }
    await c.page.locator("#search").focus();
    await c.page.waitForFunction(() => !document.querySelector('[data-slug="b"]'));
    assert.deepEqual(await interleaving(), [r1, first, r2, "c", "d"]);
    const write = await c.written(1);
    assert.deepEqual(write.patch, { title: "unfinished title" });
    await write.finish();
  });
}
