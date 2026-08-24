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

-- ONE task list. `tasks` is both what players see and where tasks are planned:
-- the canvas in .github/extensions/scavenger-tasks edits these rows directly and
-- every edit is live at once, exactly like the roster.
--
-- There used to be a second `task_board` table holding wording, points and cuts
-- back until someone published. It bought nothing -- Admin already edited tasks
-- live and mirrored the same fields back onto the board, and the columns the
-- board added on top (the ratings, the notes) are never shown to a player at
-- all. supabase/migrate-tasks-one-table.sql folds it in and explains the rest.
create table if not exists tasks (
  id             uuid primary key default gen_random_uuid(),
  round          int  not null check (round in (1, 2)),

  -- The stable key. A secret challenge is offered in BOTH halves of the event,
  -- and `round` is 1 or 2, so it is two rows sharing one slug -- the only thing
  -- the canvas has to group by. The default means an insert that has no opinion
  -- (Admin, a QA fixture) still gets a unique one.
  slug           text not null default gen_random_uuid()::text,

  -- What a player reads. The planning doc's original wording is kept beside it
  -- for provenance and never edited; eight tasks have been reworded away from
  -- it. Deliberately NOT unique per round: the slug is the identity, and a
  -- unique title can only reject a rename halfway through typing it.
  title          text not null,
  doc_title      text not null default '',

  points         int  not null check (points > 0),
  requires_video boolean not null default false,
  is_secret      boolean not null default false,
  revealed_at    timestamptz,
  active         boolean not null default true,

  -- Position within the round in the planning doc: the canvas's own reading
  -- order, and the tie-break within a tier below.
  doc_order      int  not null default 999,

  -- The player's order, derived rather than maintained. Tier ascending with the
  -- secrets last, which is what the old publish step used to compute and then
  -- renumber densely on every cut.
  sort_order     int generated always as
                   ((case when is_secret then 500000 else 0 end) + points * 1000 + doc_order) stored,

  -- Planning only, never shown to a player. difficulty/guts/luck drive the
  -- suggested tier; payoff and risk are the keep/cut axes.
  difficulty     int  not null default 3 check (difficulty between 1 and 5),
  guts           int  not null default 3 check (guts       between 1 and 5),
  luck           int  not null default 3 check (luck       between 1 and 5),
  payoff         int  not null default 3 check (payoff     between 1 and 5),
  risk           int  not null default 1 check (risk       between 1 and 5),
  prop           text not null default '',
  note           text not null default '',
  rewrite        boolean not null default false,
  -- The tier suggestion this task's owner rejected, or null for "never
  -- dismissed". A number rather than a flag so that changing a rating -- which
  -- moves the suggestion -- re-raises it. See the canvas's tier.mjs.
  tier_ok        int check (tier_ok in (1, 3, 5, 7, 10)),

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
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

-- The task list was two tables until supabase/migrate-tasks-one-table.sql folded
-- the planning board into this one. These mirror the columns that migration
-- adds, so this file stays the whole picture and stays re-runnable; the one-shot
-- part -- carrying the board's rows over and retiring it -- lives only there.
--
-- On a database that predates the fold, RUN THAT FILE, not this one. This block
-- gets the schema right on its own, but only the migration can recover the
-- planning columns from the old table, and the ratings and notes are not
-- recoverable from anywhere else.
--
-- The rename comes first and is not optional: on a database that still has
-- `board_id`, adding `slug` beside it instead would leave every task with a
-- fresh random key, and a secret challenge's two rows would stop sharing one.
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'tasks' and column_name = 'board_id') then
    alter table tasks rename column board_id to slug;
  end if;
end $$;

alter table tasks add column if not exists slug       text;
update tasks set slug = gen_random_uuid()::text where slug is null;
alter table tasks alter column slug set default gen_random_uuid()::text;
alter table tasks alter column slug set not null;
alter table tasks add column if not exists doc_title  text not null default '';
alter table tasks add column if not exists doc_order  int  not null default 999;
alter table tasks add column if not exists difficulty int  not null default 3 check (difficulty between 1 and 5);
alter table tasks add column if not exists guts       int  not null default 3 check (guts       between 1 and 5);
alter table tasks add column if not exists luck       int  not null default 3 check (luck       between 1 and 5);
alter table tasks add column if not exists payoff     int  not null default 3 check (payoff     between 1 and 5);
alter table tasks add column if not exists risk       int  not null default 1 check (risk       between 1 and 5);
alter table tasks add column if not exists prop       text not null default '';
alter table tasks add column if not exists note       text not null default '';
alter table tasks add column if not exists rewrite    boolean not null default false;
alter table tasks add column if not exists tier_ok    int check (tier_ok in (1, 3, 5, 7, 10));
alter table tasks add column if not exists updated_at timestamptz not null default now();

-- unique (round, title) existed only so the old publish step could match tasks
-- by their prose. Found by its columns rather than by its name, because a
-- `drop constraint if exists` on a guessed name fails silently.
do $$
declare c text;
begin
  for c in
    select con.conname
    from pg_constraint con
    where con.conrelid = 'public.tasks'::regclass
      and con.contype = 'u'
      -- attname is `name`, not `text`, and `name[] = text[]` has no operator at
      -- all -- so this has to cast or the whole migration aborts here.
      and (select array_agg(att.attname::text order by att.attname::text)
           from unnest(con.conkey) k
           join pg_attribute att on att.attrelid = con.conrelid and att.attnum = k) = array['round', 'title']
  loop
    execute format('alter table tasks drop constraint %I', c);
  end loop;
end $$;

create unique index if not exists tasks_round_slug_idx on tasks (round, slug);
drop index if exists tasks_round_board_id_idx;

-- Only a secret challenge may repeat a slug, and only once per round. Two
-- unrelated tasks sharing one would be merged into a single entry by the canvas,
-- which patches every row with a given slug at once.
create unique index if not exists tasks_slug_solo_idx on tasks (slug) where not is_secret;

-- sort_order was a plain column the old publish step recomputed and renumbered.
-- On a database that predates the fold it still is one, and nothing maintains it
-- any more, so convert it in place. No-op everywhere else.
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'tasks'
               and column_name = 'sort_order' and is_generated = 'NEVER') then

    -- The old dense sort_order is the only record of the order players are
    -- looking at, and doc_order -- which replaces it as the tie-break inside a
    -- tier -- has just defaulted every row to 999. Carrying it across keeps
    -- every task where it is; without this, running THIS file instead of the
    -- migration silently reshuffles each tier.
    update tasks set doc_order = sort_order where doc_order = 999;

    alter table tasks drop column sort_order;
    alter table tasks add column sort_order int
      generated always as ((case when is_secret then 500000 else 0 end) + points * 1000 + doc_order) stored;
  end if;
end $$;

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
  ('event_name',        'Jason''s 30th')
on conflict (key) do nothing;

-- ========================================================================
-- 2. STORAGE
-- ========================================================================

-- Storage setup.
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

-- Seed data: teams only. Re-running is safe (ON CONFLICT DO NOTHING).

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
-- Keeping a copy of the list in this file is what let two copies of it drift
-- apart in the first place. Tasks are written and edited in the planner canvas,
-- which reads and writes the `tasks` table above directly.
--
-- On a fresh project: run this file, then open the canvas and add tasks.
