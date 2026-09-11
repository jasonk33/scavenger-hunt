import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const compiled = ts.transpileModule(
  readFileSync(new URL("../src/lib/client.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;

function client(fetch) {
  const timers = new Map();
  const exports = {};
  runInNewContext(compiled, {
    exports, fetch, AbortController,
    require(name) {
      assert.equal(name, "react");
      return {};
    },
    setTimeout(fn, ms) {
      const id = Symbol();
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  });
  return {
    ...exports, timers,
    expire() {
      assert.equal(timers.size, 1, "each request must own a deadline");
      const [id, timer] = [...timers][0];
      assert.equal(timer.ms, 15000, "metadata deadline must not apply to media uploads");
      timers.delete(id);
      timer.fn();
    },
  };
}

function pending(signal) {
  return new Promise((_, reject) => {
    if (signal?.aborted) reject(signal.reason);
    else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

test("a stalled request fails visibly and does not retain its timer", async () => {
  const c = client((_, init) => pending(init.signal));
  const request = c.api("/api/feed");
  c.expire();
  await assert.rejects(request, /timed out/i);
  assert.equal(c.timers.size, 0);
});

test("a stalled JSON response body is bounded too, not returned as empty success", async () => {
  let reading;
  const started = new Promise((resolve) => { reading = resolve; });
  const c = client(async (_, init) => ({
    ok: true, status: 200,
    json() { reading(); return pending(init.signal); },
  }));
  const request = c.api("/api/state");
  await started;
  c.expire();
  await assert.rejects(request, /timed out/i);
  assert.equal(c.timers.size, 0);
});

test("caller cancellation still aborts the request and clears the deadline", async () => {
  const controller = new AbortController();
  const c = client((_, init) => pending(init.signal));
  const request = c.api("/api/feed?round=1", { signal: controller.signal });
  controller.abort();
  await assert.rejects(request, { name: "AbortError" });
  assert.equal(c.timers.size, 0);
});

test("a caller signal already aborted before fetch is preserved", async () => {
  const controller = new AbortController();
  controller.abort();
  const c = client((_, init) => pending(init.signal));
  await assert.rejects(c.api("/api/feed", { signal: controller.signal }), { name: "AbortError" });
  assert.equal(c.timers.size, 0);
});

test("successful JSON preserves request options and clears the deadline", async () => {
  let options;
  const c = client(async (_, init) => {
    options = init;
    return new Response(JSON.stringify({ ok: true }));
  });
  assert.deepEqual(await c.api("/api/submissions/example", {
    method: "PATCH", body: '{"noteOnly":true}', headers: { "x-example": "fixture" },
  }), { ok: true });
  assert.equal(options.method, "PATCH");
  assert.equal(options.body, '{"noteOnly":true}');
  assert.equal(options.cache, "no-store");
  assert.equal(options.headers["content-type"], "application/json");
  assert.equal(options.headers["x-example"], "fixture");
  assert.equal(c.timers.size, 0);
});

test("HTTP failures preserve their API status and server message", async () => {
  const c = client(async () => new Response('{"error":"Organizer PIN required"}', { status: 401 }));
  await assert.rejects(c.api("/api/admin/data"), (error) =>
    error instanceof c.ApiError && error.status === 401 && error.message === "Organizer PIN required");
  assert.equal(c.timers.size, 0);
});

test("non-JSON HTTP failures keep their status rather than becoming parsing errors", async () => {
  const c = client(async () => new Response("temporarily unavailable", { status: 503 }));
  await assert.rejects(c.api("/api/feed"), (error) =>
    error instanceof c.ApiError && error.status === 503);
  assert.equal(c.timers.size, 0);
});

test("invalid JSON on a successful response never becomes a success-shaped empty object", async () => {
  const c = client(async () => new Response("<html>Unexpected response</html>"));
  await assert.rejects(c.api("/api/state"), /unreadable response/i);
  assert.equal(c.timers.size, 0);
});
