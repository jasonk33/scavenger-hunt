#!/usr/bin/env node
/**
 * Runs every QA driver in sequence and reports one verdict.
 *
 *   npm run dev        # in one terminal
 *   node qa/run-all.mjs
 *   npm run qa -- judge    # just the drivers whose filename contains "judge"
 *
 * Each driver creates and tears down its own `__qa` fixtures and restores
 * settings in a `finally`, then diffs a snapshot of the real event data. A
 * non-zero exit means either a check failed or real data drifted.
 */
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";

const dir = new URL("./", import.meta.url).pathname;
const args = process.argv.slice(2);
// Anything not a flag is a driver filter. Flags (--allow-prod, --allow-real-data)
// still belong to the drivers and are forwarded; a filter must NOT be, or it
// reaches lib.mjs as an unknown argument.
const flags = args.filter((a) => a.startsWith("-"));
const filters = args.filter((a) => !a.startsWith("-"));

const all = readdirSync(dir)
  .filter((f) => /^(flow|probe)/.test(f) && f.endsWith(".mjs"))
  .sort();
const drivers = filters.length
  ? all.filter((f) => filters.some((n) => f.includes(n.replace(/\.mjs$/, ""))))
  : all;

// A filter that matches nothing would otherwise run zero drivers and exit 0,
// reporting a clean suite for a run that tested absolutely nothing.
if (!drivers.length) {
  console.error(`\nNo driver matches ${JSON.stringify(filters)}. Available:\n` +
    all.map((f) => `  ${f}`).join("\n") + "\n");
  process.exit(1);
}

const run = (file) =>
  new Promise((resolve) => {
    // Forward our own flags (e.g. --allow-prod) so `npm run qa -- --allow-prod`
    // reaches the per-driver guard in lib.mjs instead of being swallowed here.
    const p = spawn(process.execPath, [`${dir}${file}`, ...flags], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    p.stdout.on("data", (d) => { out += d; process.stdout.write(d); });
    p.stderr.on("data", (d) => { out += d; process.stderr.write(d); });
    p.on("close", (code) => {
      const m = out.match(/^(.+): (\d+)\/(\d+) passed/m);
      // Require the line to be present AND true. Inferring "intact" from the
      // absence of a failure line would score a driver that never checked as
      // clean, which is exactly the case worth catching.
      const intact = /real data intact: true/.test(out);
      resolve({
        file,
        code,
        passed: m ? Number(m[2]) : 0,
        total: m ? Number(m[3]) : 0,
        intact,
      });
    });
  });

const results = [];
for (const f of drivers) {
  console.log(`\n\x1b[1m━━━ ${f} ━━━\x1b[0m`);
  results.push(await run(f));
}

console.log("\n\x1b[1m━━━ QA SUMMARY ━━━\x1b[0m");
let ok = true;
for (const r of results) {
  const clean = r.code === 0 && r.passed === r.total && r.total > 0 && r.intact;
  if (!clean) ok = false;
  console.log(
    `  ${clean ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ${r.file.padEnd(30)} ` +
      `${r.passed}/${r.total}` +
      (r.intact ? "" : "  \x1b[31m<- REAL DATA DRIFTED\x1b[0m") +
      (r.code !== 0 ? `  \x1b[31m<- exit ${r.code}\x1b[0m` : "")
  );
}
const totals = results.reduce((a, r) => ({ p: a.p + r.passed, t: a.t + r.total }), { p: 0, t: 0 });
console.log(`\n  ${totals.p}/${totals.t} checks passed across ${results.length} drivers`);
process.exit(ok ? 0 : 1);
