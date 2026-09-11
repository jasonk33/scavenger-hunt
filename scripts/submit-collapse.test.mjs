import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

function compile(source) {
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
}

const source = readFileSync(new URL("../src/app/submit/page.tsx", import.meta.url), "utf8");
const compiled = compile(`${source}\nexports.TaskRow = TaskRow;`);
const groups = {};
runInNewContext(compile(readFileSync(new URL("../src/lib/groups.ts", import.meta.url), "utf8")), {
  exports: groups,
});

const task = { id: "task-one", title: "A task", points: 3, scoring_mode: "fixed" };
const submission = (status = "pending", id = "submission-one") => ({
  id, groupId: id, task_id: task.id, player_id: "player-one", status,
  created_at: "2026-09-11T12:00:00Z", judged_at: status === "approved" ? "2026-09-11T12:01:00Z" : null,
  points_awarded: status === "approved" ? 3 : null,
});
const job = (status = "done") => ({
  status, task, anchorId: "submission-one", note: "The second angle",
  preview: { url: "blob:fixture", isVideo: false },
});

// Render the actual row and invoke its controls without a server or live data.
function row({ subs = [], upload = null } = {}) {
  const slots = [];
  let cursor = 0, tree, closes = 0;
  const jsx = (type, props) => ({ type, props });
  const unexpected = () => { throw new Error("Collapsing must not cancel, upload, or mutate a submission"); };
  const exports = {};
  runInNewContext(compiled, {
    exports,
    require(name) {
      if (name === "react") return {
        useState(initial) {
          const index = cursor++;
          if (!(index in slots)) slots[index] = initial;
          return [slots[index], (value) => {
            slots[index] = typeof value === "function" ? value(slots[index]) : value;
          }];
        },
        useMemo: (fn) => fn(),
      };
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "fragment" };
      if (name === "@/lib/groups") return groups;
      if (name === "@/lib/client") return { usePoll: () => ({ data: null, error: null }), api: unexpected };
      if ([
        "next/navigation", "@/lib/upload", "@/components/EvidenceEntry",
        "@/components/EvidenceVideo", "@/components/Score",
      ].includes(name)) return {};
      throw new Error(`Unexpected import: ${name}`);
    },
  });
  const props = {
    task, subs, job: upload, playerId: "player-one", saved: false,
    onJobClose() { closes++; props.job = null; },
    onJobCancel: unexpected, onNoteSaved: unexpected, onToggleSaved: unexpected,
    onPick: unexpected, onAddTo: unexpected, onChanged: unexpected,
  };
  function render(update = {}) {
    Object.assign(props, update);
    cursor = 0;
    tree = exports.TaskRow({ ...props, disabled: props.job?.status === "uploading" });
  }
  function find(predicate, node) {
    if (!node || typeof node !== "object") return undefined;
    if (Array.isArray(node)) {
      for (const child of node) {
        const match = find(predicate, child);
        if (match) return match;
      }
      return undefined;
    }
    return predicate(node) ? node : find(predicate, node.props?.children);
  }
  const button = (label) => find((node) => node.type === "button" && node.props.children === label, tree);
  render();
  return {
    render, button,
    get closes() { return closes; },
    component: (name) => find((node) => node.type?.name === name, tree),
    click(label) {
      const control = button(label);
      assert.ok(control, `${label} button exists`);
      assert.ok(!control.props.disabled, `${label} is enabled`);
      control.props.onClick();
      render();
    },
  };
}

test("a just-completed upload can be hidden before the next poll returns its submission", () => {
  const view = row({ upload: job() });
  assert.ok(view.component("JobCard"));
  view.click("Hide");
  assert.equal(view.closes, 1);
  assert.ok(!view.component("JobCard"));
  assert.ok(!view.component("SubmissionView"));
  view.render({ subs: [submission()] });
  assert.ok(view.button("See"), "polling must not reopen the hidden upload");
  assert.ok(!view.component("SubmissionView"));
});

for (const status of ["pending", "approved", "rejected"]) {
  test(`Hide dismisses a completed ${status} upload without requiring OK`, () => {
    const view = row({ subs: [submission(status)], upload: job() });
    view.click("Hide");
    assert.equal(view.closes, 1);
    assert.ok(!view.component("JobCard"));
    assert.ok(!view.component("SubmissionView"));
    view.click("See");
    assert.ok(view.component("SubmissionView"));
    assert.ok(!view.component("JobCard"), "reopening shows submitted evidence, not the old confirmation");
    view.click("Hide");
    assert.ok(!view.component("SubmissionView"));
    assert.equal(view.closes, 1, "only the completed upload is dismissed");
  });
}

test("Hide closes both expanded evidence and a newly completed redo", () => {
  const view = row({ subs: [submission("approved")] });
  view.click("See");
  assert.ok(view.component("SubmissionView"));
  view.render({ job: job() });
  assert.ok(view.component("JobCard"));
  view.click("Hide");
  assert.ok(!view.component("JobCard"));
  assert.ok(!view.component("SubmissionView"));
  view.render({ subs: [submission("approved"), submission("pending", "redo")] });
  assert.ok(view.button("See 2"));
  assert.ok(!view.component("SubmissionView"));
});

for (const status of ["uploading", "error"]) {
  test(`Hide leaves an ${status} upload visible while collapsing older evidence`, () => {
    const view = row({ subs: [submission("approved")], upload: job(status) });
    view.click("See");
    view.click("Hide");
    assert.equal(view.closes, 0);
    assert.ok(view.component("JobCard"));
    assert.ok(!view.component("SubmissionView"));
  });

  test(`an ${status} upload without older evidence has no premature Hide button`, () => {
    const view = row({ upload: job(status) });
    assert.ok(!view.button("Hide"));
    assert.ok(view.component("JobCard"));
  });
}

test("completed uploads keep the existing OK dismissal callback", () => {
  const view = row({ subs: [submission()], upload: job() });
  view.component("JobCard").props.onClose();
  view.render();
  assert.equal(view.closes, 1);
  assert.ok(!view.component("JobCard"));
  assert.ok(view.button("See"));
});

test("Hide does not change the separately expanded other-team entries", () => {
  const view = row({ subs: [submission()], upload: job() });
  view.click("See other teams' entries");
  view.click("Hide");
  assert.ok(view.button("Hide other teams"));
  assert.ok(!view.component("JobCard"));
});
