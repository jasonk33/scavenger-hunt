import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const migrationPath = "supabase/migrations/20260911180000_retire_task_features.sql";
const migration = () => read(migrationPath);
const sql = (text) => text.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim();
const view = (text) => sql(text.match(/create or replace view team_scores as[\s\S]*?;/i)?.[0] ?? "");
const retirement = (text) => text.match(/-- BEGIN task feature retirement[\s\S]*?-- END task feature retirement/)?.[0];

test("retirement is a transaction mirrored exactly in the idempotent setup", () => {
  const change = migration();
  assert.match(sql(change), /^begin; .* commit;$/i);
  assert.ok(retirement(change));
  assert.equal(retirement(read("supabase/setup.sql")), retirement(change));
  assert.equal(view(read("supabase/setup.sql")), view(change));
});

test("migration keeps identities, evidence, assigned points and dormant planner storage", () => {
  const change = sql(migration());
  assert.doesNotMatch(change, /\b(drop (?:table|column)|truncate|delete from)\b/i);
  assert.doesNotMatch(change, /\b(?:set |new\.)(?:slug|title|round|task_points|points_awarded|measurement_value|object_name|group_id)\s*(?::=|=)/i);
  assert.doesNotMatch(change, /\bupdate settings\b/i);
  assert.doesNotMatch(change, /\b(?:difficulty|guts|luck|payoff|risk|tier_ok)\s*(?::=|=)/i);
});

test("historical paired secret rows keep their marker and remain cut", () => {
  const change = sql(migration());
  assert.match(change, /update public\.tasks set active = false where is_secret/i);
  assert.match(change, /if tg_op = 'UPDATE' and old\.is_secret then new\.is_secret := true;/i);
  assert.match(change, /if new\.is_secret then new\.active := false;/i);
  assert.doesNotMatch(change, /is_secret\s*(?:=|:=)\s*false|active\s*(?:=|:=)\s*true/i);
  assert.match(read("supabase/setup.sql"), /tasks_slug_solo_idx on tasks \(slug\) where not is_secret/);
});

test("old in-flight task and submission writes are normalized instead of rejected", () => {
  const change = sql(migration());
  for (const field of ["requires_video := false", "competition_bonus := 0", "winner_team_id := null",
    "scoring_mode := 'fixed'", "scoring_mode_snapshot := 'fixed'", "competition_bonus_snapshot := 0"]) {
    assert.ok(change.includes(`new.${field};`), field);
  }
  assert.match(change, /if new\.scoring_mode = 'competition' then/);
  assert.match(change, /if new\.scoring_mode_snapshot = 'competition' then/);
  assert.match(change, /before insert or update on public\.tasks/);
  assert.match(change, /before insert or update on public\.submissions/);
  assert.doesNotMatch(change, /raise exception|add constraint|drop constraint/i);
});

test("persisted legacy feature values are retired without changing fixed or quantity snapshots", () => {
  const change = sql(migration());
  assert.match(change, /update public\.tasks set requires_video = false, competition_bonus = 0, winner_team_id = null/);
  assert.match(change, /update public\.tasks set scoring_mode = 'fixed' where scoring_mode = 'competition'/);
  assert.match(change, /update public\.submissions set competition_bonus_snapshot = 0/);
  assert.match(change, /update public\.submissions set scoring_mode_snapshot = 'fixed' where scoring_mode_snapshot = 'competition'/);
});

test("team score view retains quantity, latest approval, and denormalized team/round rules", () => {
  const scoreView = view(migration());
  assert.match(scoreView, /distinct on \(s\.round, s\.team_id, s\.task_id\)/);
  assert.match(scoreView, /s\.status = 'approved' and s\.points_awarded is not null/);
  assert.match(scoreView, /s\.judged_at desc nulls last, s\.created_at desc, s\.id desc/);
  assert.match(scoreView, /when scoring_mode = 'quantity' then task_points \+ coalesce\(measurement_value, 0\) \* points_per_unit else points_awarded/);
  assert.match(scoreView, /s\.team_id = t\.id and s\.round = t\.round/);
  assert.doesNotMatch(scoreView, /competition|winner_team_id|roster|active|is_secret/);
});

test("ready and seed leave retired capabilities alone", () => {
  assert.doesNotMatch(read("scripts/ready.mjs"), /revealed_at|requires_video|secret challenges|bySlug|tier_model/);
  assert.doesNotMatch(read("scripts/seed-event.mjs"), /revealed_at|re-hid/i);
  assert.match(read("scripts/ready.mjs"), /\.eq\("is_secret", false\)/);
});

test("QA keeps evidence regressions without creating or revealing retired task kinds", () => {
  for (const path of ["scripts/smoke.mjs", "qa/flow5-admin.mjs", "qa/flow6-scoring.mjs",
    "qa/probe-admin-ui.mjs", "qa/probe-welcome.mjs", "qa/probe-canvas-reliability.mjs"]) {
    const source = read(path);
    assert.doesNotMatch(source, /scoringMode:\s*"competition"|scoring_mode:\s*"competition"|isSecret:\s*true|revealed:\s*true|winnerTeamId\s*:|\/api\/model/, path);
  }
  assert.equal(existsSync(new URL("qa/probe-secret.mjs", root)), false);
  assert.match(read("qa/flow6-scoring.mjs"), /scoringMode: "quantity"/);
  assert.match(read("qa/flow6-scoring.mjs"), /compFiles\.length === 2|quantityFiles\.length === 2/);
  assert.match(read("qa/lib.mjs"), /\.in\("status", \["pending", "uploading"\]\)/);
  assert.match(read("qa/lib.mjs"), /Refusing to run:.*real submission/);
});

test("the one offline browser driver rejects retired UI instead of trying to reveal a task", () => {
  const driver = read("qa/probe-bug-bash.mjs");
  assert.doesNotMatch(driver, /getByRole\("button", \{ name: "(Reveal|Live)"/);
  assert.match(driver, /Player ignores retired badges in an old API response/);
  assert.match(driver, /Judge ignores retired badges and leader guidance in an old API response/);
  assert.match(driver, /Admin has no task reveal or leader controls/);
  assert.match(driver, /Quantity judging sends the count, not discretionary points/);
  assert.match(driver, /Grouped feed shows baseline, bonus and playable clip/);
});

test("smoke checks video playability per file, not the retired group-level video flag", () => {
  const smoke = read("scripts/smoke.mjs");
  assert.doesNotMatch(smoke, /mine\?\.isVideo/);
  assert.match(smoke, /mine\?\.media\?\.\[0\]\?\.isVideo === true/);
});
