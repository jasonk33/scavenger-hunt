-- Multi-file submissions and player notes.
--
-- RUN THIS ONE, not the whole setup.sql.
--
-- (Historical: setup.sql used to carry the seed INSERTs for the task list, so
-- re-running it resurrected every task since deleted. The task list now lives on
-- the planning board in the `task_board` table and is published by
-- `npm run sync:tasks`, so setup.sql no longer touches tasks at all.)
--
-- Paste this whole file into the Supabase SQL editor and run it.
-- Safe to re-run: every statement is idempotent.

-- A submission is still one row = one file. group_id ties several files
-- together into one thing the judge reviews and decides ONCE.
--
-- Nullable on purpose. Every read does `group_id ?? id`, so a row that somehow
-- misses one degrades to a group of one -- which is exactly the behaviour that
-- shipped before this column existed.
alter table submissions add column if not exists group_id uuid;

-- Free text the player attaches to say what the judge is looking at.
alter table submissions add column if not exists note text;

-- Rows that predate the column are each their own group of one.
update submissions set group_id = id where group_id is null;

create index if not exists submissions_group_idx on submissions (group_id);
