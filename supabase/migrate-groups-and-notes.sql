-- Multi-file submissions and player notes.
--
-- RUN THIS ONE, not the whole setup.sql.
--
-- setup.sql still carries the seed INSERTs for the task list, and running it
-- again re-adds the two tasks the source doc struck through -- `seed-event.mjs`
-- deletes those on purpose (CUT_TASKS) and they do not conflict with anything,
-- so `on conflict do nothing` lets them straight back in. The same is true of
-- any task removed from the Admin screen. The team INSERTs are harmless (the
-- seeded names match the live ones, so they no-op), and so are the schema,
-- storage and settings statements.
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
