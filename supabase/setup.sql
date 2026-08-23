-- Scavenger hunt: complete Supabase setup.
-- Paste this whole file into the Supabase SQL editor and run it.
-- Safe to re-run: every statement is idempotent.

-- ========================================================================
-- 1. SCHEMA
-- ========================================================================

-- Scavenger hunt schema. Run this once in the Supabase SQL editor.
-- Safe to re-run: everything is IF NOT EXISTS / OR REPLACE.

create extension if not exists pgcrypto;

-- Rounds are just the integers 1 and 2. Teams are per-round rows, because the
-- roster is remixed at the break and the two rounds are scored separately.
create table if not exists teams (
  id         uuid primary key default gen_random_uuid(),
  round      int  not null check (round in (1, 2)),
  name       text not null,
  color      text not null,
  sort_order int  not null default 0,
  created_at timestamptz not null default now(),
  unique (round, name)
);

create table if not exists players (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  created_at timestamptz not null default now()
);

-- The remix lives here and nowhere else. Editing this table at 3:30pm is the
-- entire remix operation: no re-scanning, no new links, no stale browser tabs.
create table if not exists roster (
  round     int  not null check (round in (1, 2)),
  player_id uuid not null references players(id) on delete cascade,
  team_id   uuid not null references teams(id)   on delete cascade,
  primary key (round, player_id)
);

create table if not exists tasks (
  id             uuid primary key default gen_random_uuid(),
  round          int  not null check (round in (1, 2)),
  title          text not null,
  points         int  not null check (points > 0),
  requires_video boolean not null default false,
  is_secret      boolean not null default false,
  revealed_at    timestamptz,
  sort_order     int  not null default 0,
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  unique (round, title)
);

-- status lifecycle: uploading -> pending -> approved | rejected
--
-- team_id and task_points are DENORMALIZED ON PURPOSE.
--   * team_id: if we joined to the player's *current* team instead, every Round 1
--     score would silently change the moment the roster is remixed at 3:30pm.
--   * task_points: snapshotting means editing a task's value later cannot rewrite
--     the history of what was already scored.
create table if not exists submissions (
  id             uuid primary key default gen_random_uuid(),
  round          int  not null check (round in (1, 2)),
  task_id        uuid not null references tasks(id)   on delete cascade,
  player_id      uuid not null references players(id) on delete cascade,
  team_id        uuid not null references teams(id)   on delete cascade,
  task_points    int  not null,
  object_name    text not null,
  media_type     text,
  size_bytes     bigint,
  status         text not null default 'uploading'
                 check (status in ('uploading', 'pending', 'approved', 'rejected')),
  points_awarded int,
  reject_reason  text,
  created_at     timestamptz not null default now(),
  judged_at      timestamptz
);

-- Added after the first deploy, so these are ALTERs rather than columns in the
-- CREATE above: `create table if not exists` does nothing to a table that
-- already exists, and this file has to stay re-runnable against a live database.
--
-- group_id ties several files into one thing the judge reviews and decides ONCE.
-- A submission is still one row = one file; grouping is what the judge and the
-- player see. Nullable on purpose -- every read does `group_id ?? id`, so a row
-- that somehow misses one degrades to a group of one, which is the old behaviour.
alter table submissions add column if not exists group_id uuid;

-- board_id links a task back to its entry on the planning board
-- (the `task_board` table), which owns task content, tiers and cuts.
-- Nullable: a row added straight from Admin has no board entry, and
-- `npm run sync:tasks` leaves anything it does not recognise alone.
alter table tasks add column if not exists board_id text;
create unique index if not exists tasks_round_board_id_idx
  on tasks (round, board_id);

-- Free text the player attaches to say what the judge is looking at.
alter table submissions add column if not exists note text;

-- Rows that predate the column are each their own group of one.
update submissions set group_id = id where group_id is null;

create index if not exists submissions_queue_idx
  on submissions (status, created_at);
create index if not exists submissions_group_idx
  on submissions (group_id);
create index if not exists submissions_round_team_idx
  on submissions (round, team_id);
create index if not exists submissions_task_idx
  on submissions (round, team_id, task_id);

create table if not exists settings (
  key   text primary key,
  value text
);

-- Scoring lives in one place so the leaderboard, the export and the team's own
-- progress view can never disagree.
--
-- "A task only counts once" is enforced here rather than with a unique constraint:
-- two teammates racing to submit the same task should not produce a hard error in
-- the field. Duplicates are allowed to exist; only one of them is counted.
--
-- The one counted is the one judged MOST RECENTLY, not the highest-scoring one.
-- Every duplicate normally carries the same value, so this only bites when a
-- task's points were edited between two approvals -- and there the judge's
-- latest ruling is the one that should stand. Picking the maximum instead meant
-- re-approving a re-submission at a lower value silently kept the old, higher
-- score, which looked exactly like the decision had been ignored.
--
-- Rejections are excluded rather than counted as "latest", so rejecting a
-- duplicate cannot un-score a task the team already got right.
create or replace view team_scores as
with best as (
  select distinct on (s.round, s.team_id, s.task_id)
         s.round,
         s.team_id,
         s.task_id,
         s.points_awarded as pts
  from submissions s
  where s.status = 'approved'
    and s.points_awarded is not null
  -- created_at and id only break ties: judged_at is identical across the files
  -- of one group, and could in principle collide across two separate decisions.
  order by s.round, s.team_id, s.task_id,
           s.judged_at desc nulls last, s.created_at desc, s.id desc
)
select t.id                                 as team_id,
       t.round,
       t.name,
       t.color,
       t.sort_order,
       coalesce(sum(b.pts), 0)::int         as points,
       count(b.task_id)::int                as tasks_scored
from teams t
left join best b on b.team_id = t.id and b.round = t.round
group by t.id, t.round, t.name, t.color, t.sort_order;

-- A discretionary 0-2 "creativity" bonus and an award-candidate star used to
-- ride along with every approval. Both are gone: a task is approved or it is
-- not, and it is worth what the task is worth.
--
-- These sit AFTER the view on purpose. The old definition of team_scores read
-- `bonus`, so on a re-run against a live database the drop would be refused
-- until the view above has already been replaced with one that doesn't.
-- Idempotent, and a no-op on a fresh database where the columns never existed.
alter table submissions drop column if exists bonus;
alter table submissions drop column if exists starred;

-- RLS is on with no policies: nothing is reachable with the anon key. Every read
-- and write goes through a Next.js route handler using the service_role key, so
-- point values and team attribution are resolved server-side and the browser
-- never gets to assert them.
alter table teams       enable row level security;
alter table players     enable row level security;
alter table roster      enable row level security;
alter table tasks       enable row level security;
alter table submissions enable row level security;
alter table settings    enable row level security;

insert into settings (key, value) values
  ('active_round',      '1'),
  ('submissions_open',  'true'),
  ('fallback_url',      ''),
  ('event_name',        'Jason''s 30th')
on conflict (key) do nothing;

-- ========================================================================
-- 2. STORAGE
-- ========================================================================

-- Storage setup. Run after 01-schema.sql.
--
-- Media bytes go browser -> Supabase Storage DIRECTLY, never through a Next.js
-- route (Vercel caps request bodies at 4.5 MB; a 150 MB video would 413).
-- That means the browser needs the anon key and the bucket needs to accept
-- anonymous writes. There is no cheating threat at a birthday party, so this is
-- the correct trade, not a compromise.

insert into storage.buckets (id, name, public, file_size_limit)
values ('hunt', 'hunt', true, 524288000)  -- 500 MB; the default 50 MB 413s most videos
on conflict (id) do update
  set public = true,
      file_size_limit = 524288000;

-- TUS resumable upload needs INSERT to create the object and UPDATE to append
-- each 6 MB chunk. Without the UPDATE policy uploads die partway through.
drop policy if exists "hunt anon insert" on storage.objects;
create policy "hunt anon insert" on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'hunt');

drop policy if exists "hunt anon update" on storage.objects;
create policy "hunt anon update" on storage.objects
  for update to anon, authenticated
  using (bucket_id = 'hunt')
  with check (bucket_id = 'hunt');

-- The judge screen and the feed read media over the public object URL.
drop policy if exists "hunt public read" on storage.objects;
create policy "hunt public read" on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'hunt');

-- ========================================================================
-- 3. SEED DATA
-- ========================================================================

-- Seed data: teams only.
-- Run after 02-storage.sql. Re-running is safe (ON CONFLICT DO NOTHING).

insert into teams (round, name, color, sort_order) values
  (1, 'The Birthday Bureau', '#dc2626', 10),
  (1, 'The Flatiron Five', '#2563eb', 20),
  (1, 'The Pigeon Intelligence Agency', '#16a34a', 30),
  (1, 'The Madison Square Menaces', '#ca8a04', 40),
  (1, 'The NoMad Nomads', '#7c3aed', 50),
  (2, 'The Birthday Bureau', '#dc2626', 10),
  (2, 'The Flatiron Five', '#2563eb', 20),
  (2, 'The Pigeon Intelligence Agency', '#16a34a', 30),
  (2, 'The Madison Square Menaces', '#ca8a04', 40),
  (2, 'The NoMad Nomads', '#7c3aed', 50)
on conflict (round, name) do nothing;

-- Tasks are NOT seeded here.
--
-- The task list lives on the planning board in the `task_board` table -- titles,
-- point tiers, the clip flag and which tasks are cut -- and `npm run sync:tasks`
-- is the only thing that writes it into this table. Keeping a second copy of the
-- list here is what let the two drift apart in the first place.
--
-- On a fresh project: run this file, then `supabase/migrate-task-board-id.sql`
-- and `supabase/migrate-task-board.sql`, then `npm run sync:tasks -- --apply`.

