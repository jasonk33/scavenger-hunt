import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Run the page's actual handlers with controlled hooks and IO, not a copy of the
// upload algorithm. No server, environment file, browser or database is loaded.
const source = readFileSync(new URL("../src/app/submit/page.tsx", import.meta.url), "utf8");
const renderStart = source.indexOf("  if (!me) return <p");
assert.notEqual(renderStart, -1, "the submit page's render boundary must exist");
const handlers = compile(`${source.slice(0, renderStart)}
  return { job, pickFor, onFile, cancelUpload, dismiss: () => setJob(null) };
}`);
const uploadSource = compile(
  readFileSync(new URL("../src/lib/upload.ts", import.meta.url), "utf8")
);

function compile(text) {
  return ts.transpileModule(text, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

function load(code, imports, globals = {}) {
  const exports = {};
  runInNewContext(code, {
    exports,
    require(name) {
      assert.ok(Object.hasOwn(imports, name), `unexpected import: ${name}`);
      return imports[name];
    },
    ...globals,
  });
  return exports;
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const file = { name: "clip.mov", size: 150_000_000, type: "video/quicktime" };
const task = { id: "task-one", title: "A task", points: 3 };
const init = (id) => ({ submissionId: id, objectName: `${id}.mov`, contentType: "video/mp4" });

function harness({ rejectDelete = false } = {}) {
  const requests = [], uploads = [], locks = [], created = [], revoked = [];
  const slots = [];
  let cursor = 0, effects = [], changed = false, reloads = 0;
  const router = { replace() {} };
  const me = { id: "player-one", name: "Player" };
  const data = { me, settings: {}, tasks: [], submissions: [], upload: { anonKey: "eyJ.test" } };
  const hooks = {
    useState(initial) {
      const index = cursor++;
      slots[index] ??= { value: typeof initial === "function" ? initial() : initial };
      return [slots[index].value, (update) => {
        const prev = slots[index].value;
        // React may invoke updater functions twice; neither invocation may mint
        // another preview URL or issue a request.
        if (typeof update === "function") update(prev);
        slots[index].value = typeof update === "function" ? update(prev) : update;
        changed = true;
      }];
    },
    useRef(initial) {
      const index = cursor++;
      slots[index] ??= { current: initial };
      return slots[index];
    },
    useMemo(fn) { return fn(); },
    useEffect(fn, deps) {
      const index = cursor++;
      const prev = slots[index];
      if (!prev || deps.some((dep, i) => !Object.is(dep, prev.deps[i]))) {
        const next = { deps };
        slots[index] = next;
        effects.push(() => { prev?.cleanup?.(); next.cleanup = fn(); });
      }
    },
  };
  const client = {
    api(url, options) {
      const request = { url, ...options, ...deferred() };
      requests.push(request);
      if (options.method === "DELETE") {
        if (rejectDelete) request.reject(new Error("offline"));
        else request.resolve({});
      }
      return request.promise;
    },
    errorMessage: (error, fallback = "Something went wrong.") => error?.message || fallback,
    getMe: () => me,
    getSaved: () => new Set(),
    syncSavedEpoch: () => false,
    usePoll: () => ({ data, reload: () => { reloads++; }, error: null }),
  };
  const upload = load(uploadSource, { "tus-js-client": {}, "./client": client }, {
    navigator: {
      wakeLock: {
        request() {
          const lock = {
            ...deferred(),
            releases: 0,
            release() { this.releases++; },
          };
          locks.push(lock);
          return lock.promise;
        },
      },
    },
  });
  const { default: page } = load(handlers, {
    react: hooks,
    "next/navigation": { useRouter: () => router },
    "@/lib/client": client,
    "@/lib/upload": {
      ...upload,
      uploadFile(options) {
        const running = { ...options, aborts: 0, abort() { this.aborts++; } };
        uploads.push(running);
        return running;
      },
    },
  }, {
    URL: {
      createObjectURL() { const url = `blob:${created.length}`; created.push(url); return url; },
      revokeObjectURL(url) { revoked.push(url); },
    },
    // Distinct uploads can start in the same millisecond, even for the same file.
    Date: { now: () => 1234 },
  });
  function render() {
    let view;
    do {
      changed = false;
      cursor = 0;
      view = page();
      const pending = effects;
      effects = [];
      pending.forEach((effect) => effect());
    } while (changed);
    return view;
  }
  return {
    requests, uploads, locks, created, revoked,
    get job() { return render().job; },
    get reloads() { return reloads; },
    of(method) { return requests.filter((r) => r.method === method); },
    start(group) {
      const view = render();
      view.pickFor(task, group);
      const event = { target: { files: [file], value: "picked" } };
      const promise = view.onFile(event);
      assert.equal(event.target.value, "", "picking the same file again remains possible");
      render();
      return promise;
    },
    cancel() { render().cancelUpload(); render(); },
    dismiss() { render().dismiss(); render(); },
    unmount() { slots.forEach((slot) => slot.cleanup?.()); },
  };
}

async function startUploading(h, id = "submission-one", group) {
  const pending = h.start(group);
  h.of("POST").at(-1).resolve(init(id));
  await flush();
  const lock = h.locks.at(-1);
  lock.resolve(lock);
  await pending;
  return h.uploads.at(-1);
}

test("cancel before reservation returns never starts tus and deletes only its late row", async () => {
  const h = harness();
  const pending = h.start();
  h.cancel();
  assert.equal(h.job.message, "Cancelled. Nothing was sent.");
  assert.equal(h.job.anchorId, null);
  h.of("POST")[0].resolve(init("late-row"));
  await flush();
  assert.equal(h.locks.length, 0, "cancelled reservation must not request a wake lock");
  assert.equal(h.uploads.length, 0);
  assert.deepEqual(h.of("DELETE").map((r) => r.url), ["/api/submissions/late-row"]);
  assert.equal(h.of("PATCH").length, 0);
  assert.equal(h.job.anchorId, null);
  await pending;
});

test("cancel while wake acquisition waits releases the late lock without starting tus", async () => {
  const h = harness();
  const pending = h.start();
  h.of("POST")[0].resolve(init("waiting-for-wake"));
  await flush();
  h.cancel();
  const lock = h.locks[0];
  lock.resolve(lock);
  await pending;
  assert.equal(h.uploads.length, 0, "cancelled wake continuation must not start tus");
  assert.equal(lock.releases, 1);
  assert.deepEqual(h.of("DELETE").map((r) => r.url), ["/api/submissions/waiting-for-wake"]);
  assert.equal(h.job.message, "Cancelled. Nothing was sent.");
});

test("a late reservation cannot overwrite or cancel the replacement upload", async () => {
  const h = harness();
  const oldPending = h.start();
  h.cancel();
  const replacement = await startUploading(h, "replacement");
  const current = h.job;
  h.of("POST")[0].resolve(init("old-row"));
  await flush();
  assert.equal(h.job, current, "late reservation must not attach its anchor to the new job");
  assert.equal(h.locks.length, 1);
  assert.equal(h.uploads.length, 1);
  await oldPending;
  h.cancel();
  assert.equal(replacement.aborts, 1);
  assert.deepEqual(h.of("DELETE").map((r) => r.url), [
    "/api/submissions/old-row", "/api/submissions/replacement",
  ]);
});

test("a rejected late reservation cannot replace the cancellation message or a new job", async () => {
  for (const replace of [false, true]) {
    const h = harness();
    const pending = h.start();
    h.cancel();
    if (replace) await startUploading(h, "replacement");
    const current = h.job;
    h.of("POST")[0].reject(new Error("reservation failed"));
    await pending;
    assert.equal(h.job, current);
    assert.equal(h.of("DELETE").length, 0);
  }
});

test("a cancelled late wake acquisition cannot release a replacement's wake lock", async () => {
  const h = harness();
  const oldPending = h.start();
  h.of("POST")[0].resolve(init("old-row"));
  await flush();
  h.cancel();
  const replacement = await startUploading(h, "replacement");
  const current = h.job;
  h.locks[0].resolve(h.locks[0]);
  await oldPending;
  assert.equal(h.uploads.length, 1);
  assert.equal(h.locks[0].releases, 1);
  assert.equal(h.locks[1].releases, 0);
  assert.equal(h.job, current);
  h.cancel();
  assert.equal(replacement.aborts, 1);
  assert.equal(h.locks[1].releases, 1);
});

test("callbacks from an aborted upload cannot touch the replacement's state or resources", async () => {
  const h = harness();
  const old = await startUploading(h, "old-row");
  h.cancel();
  assert.equal(old.aborts, 1);
  const replacement = await startUploading(h, "replacement");
  const current = h.job;
  const deleting = h.of("DELETE").length;
  old.onProgress(75, 100);
  old.onRetry(4);
  old.onError("old error");
  const success = old.onSuccess();
  assert.equal(h.of("PATCH").length, 0, "a cancelled upload must not be finalized");
  await success;
  assert.equal(h.job, current);
  assert.equal(h.of("DELETE").length, deleting);
  assert.equal(h.locks[1].releases, 0);
  h.cancel();
  assert.equal(replacement.aborts, 1, "stale success must not set the replacement's settled flag");
});

test("success still makes Cancel a no-op throughout finalization and preserves retries", async () => {
  const h = harness();
  const running = await startUploading(h);
  assert.equal(running.contentType, "video/mp4");
  assert.equal(running.file, file);
  running.onProgress(60, 100);
  running.onRetry(2);
  assert.equal(h.job.pct, 60);
  assert.equal(h.job.retries, 2);
  const success = running.onSuccess();
  const current = h.job;
  h.cancel();
  assert.equal(h.job, current);
  assert.equal(running.aborts, 0);
  assert.equal(h.of("DELETE").length, 0);
  assert.equal(h.locks[0].releases, 1);
  h.of("PATCH")[0].resolve({});
  await success;
  assert.equal(h.job.status, "done");
  assert.equal(h.job.sent, true);
  assert.equal(h.job.pct, 100);
  assert.equal(h.reloads, 1);
});

test("late tus callbacks cannot undo success while registration is still pending", async () => {
  const h = harness();
  const running = await startUploading(h);
  const success = running.onSuccess();
  const current = h.job;
  running.onProgress(20, 100);
  running.onRetry(3);
  running.onError("late error");
  const repeatedSuccess = running.onSuccess();
  assert.equal(h.job, current);
  assert.equal(h.of("DELETE").length, 0);
  assert.equal(h.of("PATCH").length, 1);
  h.of("PATCH")[0].resolve({});
  await Promise.all([success, repeatedSuccess]);
  assert.equal(h.job.status, "done");
});

test("reservation failure allows a fresh upload and unavailable wake locks remain harmless", async () => {
  const h = harness();
  const first = h.start();
  h.of("POST")[0].reject(new Error("reservation failed"));
  await first;
  assert.equal(h.job.message, "reservation failed");
  assert.equal(h.job.anchorId, null);
  const second = h.start();
  h.of("POST")[1].resolve(init("retry"));
  await flush();
  h.locks[0].reject(new Error("wake locks unsupported"));
  await second;
  assert.equal(h.uploads.length, 1);
  assert.equal(h.job.status, "uploading");
  h.cancel();
  assert.deepEqual(h.of("DELETE").map((r) => r.url), ["/api/submissions/retry"]);
});

test("a promotion failure keeps the arrived file and allows a fresh retry", async () => {
  const h = harness();
  const running = await startUploading(h);
  const success = running.onSuccess();
  h.of("PATCH")[0].reject(new Error("offline"));
  await success;
  assert.equal(h.job.status, "error");
  assert.equal(h.job.sent, true);
  assert.match(h.job.message, /Uploaded, but couldn't register it: offline/);
  h.cancel();
  assert.equal(h.of("DELETE").length, 0);
  const replacement = await startUploading(h, "retry");
  const current = h.job;
  running.onProgress(50, 100);
  running.onRetry(9);
  running.onError("late error");
  assert.equal(h.job, current);
  h.cancel();
  assert.equal(replacement.aborts, 1);
  assert.deepEqual(h.of("DELETE").map((r) => r.url), ["/api/submissions/retry"]);
});

test("cancelling another file keeps the earlier file's sent message and note anchor", async () => {
  const h = harness();
  const first = await startUploading(h, "first-file");
  const success = first.onSuccess();
  h.of("PATCH")[0].resolve({});
  await success;
  const pending = h.start({ anchorId: "first-file", note: "Another angle" });
  h.cancel();
  assert.equal(h.job.message, "Cancelled. The file before it is still in the queue.");
  assert.equal(h.job.sent, true);
  assert.equal(h.job.anchorId, "first-file");
  h.of("POST")[1].resolve(init("cancelled-sibling"));
  await flush();
  assert.equal(h.uploads.length, 1);
  assert.equal(h.locks.length, 1);
  assert.deepEqual(h.of("DELETE").map((r) => r.url), ["/api/submissions/cancelled-sibling"]);
  await pending;
});

test("upload errors clean only their placeholder and permit retrying the same file", async () => {
  const h = harness();
  const running = await startUploading(h, "failed");
  running.onError("upload failed");
  assert.equal(h.job.status, "error");
  assert.equal(h.job.sent, false);
  assert.equal(h.job.anchorId, null);
  assert.equal(h.locks[0].releases, 1);
  const replacement = await startUploading(h, "retry");
  assert.equal(replacement.file, running.file);
  h.cancel();
  assert.deepEqual(h.of("DELETE").map((r) => r.url), [
    "/api/submissions/failed", "/api/submissions/retry",
  ]);
});

test("failed late-row cleanup cannot affect a new job", async () => {
  const h = harness({ rejectDelete: true });
  const pending = h.start();
  h.cancel();
  await startUploading(h, "replacement");
  const current = h.job;
  h.of("POST")[0].resolve(init("late-row"));
  await flush();
  assert.equal(h.locks.length, 1);
  assert.equal(h.job, current);
  assert.equal(h.of("DELETE").length, 1);
  await pending;
});

test("previews remain visible after cancel and are revoked exactly once on replacement or close", async () => {
  const h = harness();
  const first = h.start();
  const firstUrl = h.job.preview.url;
  h.cancel();
  assert.equal(h.job.preview.url, firstUrl);
  assert.deepEqual(h.revoked, []);
  const second = h.start();
  const secondUrl = h.job.preview.url;
  assert.deepEqual(h.created, [firstUrl, secondUrl]);
  assert.deepEqual(h.revoked, [firstUrl]);
  h.cancel();
  h.dismiss();
  assert.deepEqual(h.revoked, [firstUrl, secondUrl]);
  h.unmount();
  assert.deepEqual(h.revoked, [firstUrl, secondUrl]);
  h.of("POST")[0].reject(new Error("cancelled"));
  h.of("POST")[1].reject(new Error("cancelled"));
  await Promise.all([first, second]);
});
