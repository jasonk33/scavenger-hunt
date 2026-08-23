import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

test("QA has one bounded browser entry point", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

  assert.equal(pkg.scripts.qa, "node qa/flow2-judge.mjs");
  assert.equal(existsSync(new URL("../qa/run-all.mjs", import.meta.url)), false);
});
