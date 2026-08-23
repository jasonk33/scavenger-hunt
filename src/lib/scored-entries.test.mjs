import { test } from "node:test";
import assert from "node:assert/strict";

import { latestApproved, winningGroups } from "./scored-entries.mjs";

const row = (overrides = {}) => ({
  id: "00000000-0000-0000-0000-000000000001",
  round: 1,
  team_id: "team-red",
  task_id: "task-one",
  status: "approved",
  points_awarded: 3,
  group_id: null,
  created_at: "2026-08-23T12:00:00.000Z",
  judged_at: "2026-08-23T12:10:00.000Z",
  ...overrides,
});

test("latestApproved keeps the most recently judged approval, not the highest value", () => {
  const olderHigh = row({
    id: "00000000-0000-0000-0000-000000000001",
    points_awarded: 10,
    judged_at: "2026-08-23T12:10:00.000Z",
  });
  const newerLow = row({
    id: "00000000-0000-0000-0000-000000000002",
    points_awarded: 3,
    judged_at: "2026-08-23T12:11:00.000Z",
  });

  assert.deepEqual(latestApproved([olderHigh, newerLow]), [newerLow]);
});

test("latestApproved ignores rejected and unawarded rows", () => {
  const approved = row();
  const rejected = row({
    id: "00000000-0000-0000-0000-000000000002",
    status: "rejected",
    points_awarded: null,
    judged_at: "2026-08-23T12:11:00.000Z",
  });
  const unawarded = row({
    id: "00000000-0000-0000-0000-000000000003",
    points_awarded: null,
    judged_at: "2026-08-23T12:12:00.000Z",
  });

  assert.deepEqual(latestApproved([approved, rejected, unawarded]), [approved]);
});

test("latestApproved uses created time and id to break identical judgment timestamps", () => {
  const older = row({
    id: "00000000-0000-0000-0000-000000000001",
    created_at: "2026-08-23T12:00:00.000Z",
  });
  const newer = row({
    id: "00000000-0000-0000-0000-000000000002",
    created_at: "2026-08-23T12:01:00.000Z",
  });

  assert.deepEqual(latestApproved([older, newer]), [newer]);
});

test("winningGroups includes every approved file in the winning evidence group only", () => {
  const anchor = row({
    id: "00000000-0000-0000-0000-000000000001",
    group_id: "group-new",
    judged_at: "2026-08-23T12:11:00.000Z",
  });
  const secondFile = row({
    id: "00000000-0000-0000-0000-000000000002",
    group_id: "group-new",
    created_at: "2026-08-23T12:00:30.000Z",
    judged_at: "2026-08-23T12:11:00.000Z",
  });
  const oldGroup = row({
    id: "00000000-0000-0000-0000-000000000003",
    group_id: "group-old",
    judged_at: "2026-08-23T12:10:00.000Z",
  });
  const otherTaskSameGroupId = row({
    id: "00000000-0000-0000-0000-000000000004",
    task_id: "task-two",
    group_id: "group-new",
    judged_at: "2026-08-23T12:12:00.000Z",
  });

  assert.deepEqual(winningGroups([anchor, secondFile, oldGroup, otherTaskSameGroupId]), [
    [anchor, secondFile],
    [otherTaskSameGroupId],
  ]);
});
