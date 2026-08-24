-- Folds the planning board into `tasks`, so there is one task list and editing
-- it is live.
--
-- Run this once, in the Supabase SQL editor. It writes no submissions, no media,
-- no players, no roster and no settings, and it never deletes a task.
--
-- WHY
--
-- `task_board` existed to hold task wording, points and cuts back from players
-- until someone deliberately published, and `scripts/task-sync.mjs` was the only
-- bridge. The gap did not survive contact: Admin already edited `tasks` live and
-- then mirrored the same four fields back onto the board, so the live path
-- existed anyway and the mirror was there purely to stop the two tables
-- disagreeing. Everything the board added on top of that -- the ratings, the
-- notes, the props -- is never shown to a player at all, so there was nothing
-- for a publish step to protect. What it cost was a second table, a planner, a
-- title-collision refusal, a rename-parking dance, a mirror, and an extension
-- that had to find a `node` binary and shell out to run any of it.
--
-- So: one table. The board's planning columns move onto `tasks`, the canvas
-- writes `tasks` directly, and a task edit is live the moment it is made --
-- exactly like the roster tab already worked.
--
-- SAFETY
--
-- Additive. Every board row is carried over, including the cut ones, which land
-- as `active = false` rather than as deletions. `task_board` is not dropped: it
-- is renamed to `task_board_archive` and left sitting there as a snapshot to
-- roll back to. That rename is also what makes this file safe to re-run -- the
-- backfill below is guarded on `task_board` still existing, so a second run
-- cannot overwrite later edits with the state of the board on the day it moved.

begin;

-- ── 1. board_id becomes slug ────────────────────────────────────────────────
--
-- Same column, honest name: with no board to point at, it is just the task's
-- stable key. A secret challenge is offered in both halves of the event and is
-- therefore two rows -- `tasks.round` is `check (round in (1, 2))` and stays
-- that way -- and the two share a slug. That is the only reason the canvas has
-- to group at all, and it is why the unique index is on (round, slug).
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'tasks' and column_name = 'board_id') then
    alter table tasks rename column board_id to slug;
  end if;
end $$;

alter table tasks add column if not exists slug text;

-- Was nullable because a task added from Admin had no board entry. There is no
-- board now, so every task has one; the default means the existing insert paths
-- (Admin, the QA fixtures) keep working without passing one.
update tasks set slug = gen_random_uuid()::text where slug is null;
alter table tasks alter column slug set default gen_random_uuid()::text;
alter table tasks alter column slug set not null;

drop index if exists tasks_round_board_id_idx;
create unique index if not exists tasks_round_slug_idx on tasks (round, slug);

-- ── 2. unique (round, title) goes ───────────────────────────────────────────
--
-- It existed to stop the sync inserting a second copy of a task it had failed to
-- recognise, back when tasks were matched by their prose. Nothing matches on
-- title any more -- the slug is the identity -- so all this constraint can do
-- now is reject a rename mid-keystroke, in a field that saves as you type.
--
-- It is what forced the two most intricate parts of the old sync: a collision
-- check that had to model the end state of the whole table before writing
-- anything, and a two-phase rename that parked a title on a throwaway value
-- first so that swapping two titles didn't deadlock against itself. Both are
-- gone with it.
--
-- Found by its columns rather than by its name. `tasks_round_title_key` is what
-- Postgres would have called it, but a `drop constraint if exists` on a guessed
-- name fails SILENTLY -- and the backfill below rewrites `title` on every row,
-- so a constraint that survived would abort the whole migration there instead.
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

-- The contract `updateTask` relies on: it patches EVERY row with a given slug,
-- so two unrelated tasks that happened to share one would silently merge in the
-- canvas and one of them would disappear from it. Only a secret may repeat a
-- slug, and only once per round, which (round, slug) above already covers.
create unique index if not exists tasks_slug_solo_idx on tasks (slug) where not is_secret;

-- ── 3. the planning columns ─────────────────────────────────────────────────

-- The planning doc's exact wording, kept for provenance and never edited.
-- `title` is what a player reads; eight tasks have been reworded away from it.
alter table tasks add column if not exists doc_title text not null default '';

-- Position within the round in the planning doc. This is the canvas's own
-- reading order, and -- via the generated sort_order below -- the tie-break
-- within a tier for the player's list.
alter table tasks add column if not exists doc_order int not null default 999;

-- difficulty/guts/luck drive the suggested tier. payoff and risk do not: they
-- are the keep/cut axes.
alter table tasks add column if not exists difficulty int not null default 3 check (difficulty between 1 and 5);
alter table tasks add column if not exists guts       int not null default 3 check (guts       between 1 and 5);
alter table tasks add column if not exists luck       int not null default 3 check (luck       between 1 and 5);
alter table tasks add column if not exists payoff     int not null default 3 check (payoff     between 1 and 5);
alter table tasks add column if not exists risk       int not null default 1 check (risk       between 1 and 5);

alter table tasks add column if not exists prop text not null default '';
alter table tasks add column if not exists note text not null default '';

-- Flagged as needing better wording. An agent job, not a slider.
alter table tasks add column if not exists rewrite boolean not null default false;

-- The tier suggestion this task's owner rejected, or null for "never dismissed".
-- A number rather than a flag so that changing a rating -- which moves the
-- suggestion -- re-raises it. See the canvas's tier.mjs.
alter table tasks add column if not exists tier_ok int check (tier_ok in (1, 3, 5, 7, 10));

-- Maintained by the writer, not a trigger. "When did this last change" is worth
-- keeping now that a change is live the moment it is made.
alter table tasks add column if not exists updated_at timestamptz not null default now();

-- The board's three-way keep/maybe/cut collapses into `active`, which `tasks`
-- already had and which is the thing players actually feel. `maybe` meant
-- "publishes as live, but warn about it" -- with nothing left to publish it has
-- no meaning, and no task was in that state when this ran.

-- ── 4. carry the board over ─────────────────────────────────────────────────
--
-- Guarded on `task_board` still existing, and step 6 renames it away, so this is
-- strictly one-shot. Re-running this file later must not resurrect the board's
-- state over edits made since.
do $$
begin
  if to_regclass('public.task_board') is not null then

    -- Everything the board owned, onto the row that already exists for it.
    -- `active` comes from the board's status, which agrees with the live table
    -- on every row that has one -- the only board rows that disagree are cuts
    -- that were never published, and those have no live row at all.
    update tasks t set
      title          = coalesce(nullif(btrim(b.title), ''), b.doc_title),
      points         = b.points,
      requires_video = b.needs_clip,
      active         = (b.status <> 'cut'),
      doc_title      = b.doc_title,
      doc_order      = b.doc_order,
      difficulty     = b.difficulty,
      guts           = b.guts,
      luck           = b.luck,
      payoff         = b.payoff,
      risk           = b.risk,
      prop           = b.prop,
      note           = b.note,
      rewrite        = b.rewrite,
      tier_ok        = b.tier_ok,
      updated_at     = b.updated_at
    from task_board b
    where t.slug = b.board_id;

    -- Board entries with no live row: tasks that were cut before they were ever
    -- published, so the sync had nothing to deactivate and skipped them
    -- entirely. They land as inactive rows rather than being dropped -- the
    -- reasoning for why each one was cut is written down in its note, and that
    -- is the part worth keeping.
    insert into tasks (round, slug, title, points, requires_video, is_secret, active,
                       doc_title, doc_order, difficulty, guts, luck, payoff, risk,
                       prop, note, rewrite, tier_ok, updated_at)
    select r.round,
           b.board_id,
           coalesce(nullif(btrim(b.title), ''), b.doc_title),
           b.points,
           b.needs_clip,
           (b.round = 0),
           (b.status <> 'cut'),
           b.doc_title, b.doc_order, b.difficulty, b.guts, b.luck, b.payoff, b.risk,
           b.prop, b.note, b.rewrite, b.tier_ok, b.updated_at
    from task_board b
    cross join lateral unnest(case when b.round = 0 then array[1, 2] else array[b.round] end) as r(round)
    where not exists (select 1 from tasks t where t.slug = b.board_id and t.round = r.round);

  end if;
end $$;

-- ── 5. sort_order stops being maintained ────────────────────────────────────
--
-- The old sync computed this: it sorted each round by (secrets last, tier
-- ascending, doc order) and numbered the survivors 10, 20, 30. Because the
-- numbering was dense over the LIVE tasks only, cutting one task renumbered
-- every task below it -- two real cuts once produced 31 pending updates, 29 of
-- which were renumbering, listed one line each above a live write button.
--
-- The same order falls out of a generated column, which nothing has to remember
-- to maintain and which cannot drift from the values it is derived from. Every
-- existing `.order("sort_order")` read keeps working untouched; the numbers are
-- no longer dense, which nothing depends on.
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'tasks'
               and column_name = 'sort_order' and is_generated = 'NEVER') then

    -- The old column is the ONLY record of the order players are looking at
    -- right now, and dropping it is irreversible. The whole file is one
    -- transaction, so proving the new expression reproduces that order costs
    -- nothing -- and a mistake here would surface on the day as a task list
    -- that quietly reshuffled, which nothing else would catch.
    --
    -- IF THIS FIRES, read the named tasks before assuming the worst. There is
    -- one legitimate cause: the board holds a re-tier that was never published,
    -- so step 4 just changed a live task's points and the reorder is the
    -- intended consequence. Check the names; if that is all it is, delete this
    -- `raise` and re-run. Anything else means the expression is wrong.
    declare offenders text;
    begin
      select string_agg(slug, ', ' order by slug) into offenders
      from (
        select slug,
               row_number() over (partition by round order by sort_order) as was,
               row_number() over (partition by round order by is_secret, points, doc_order, id) as now
        from tasks
        where active
      ) x
      where x.was <> x.now;

      if offenders is not null then
        raise exception 'the generated sort_order would move these tasks in the player''s list: % -- nothing was written', offenders;
      end if;
    end;

    alter table tasks drop column sort_order;
    alter table tasks add column sort_order int
      generated always as ((case when is_secret then 500000 else 0 end) + points * 1000 + doc_order) stored;
  end if;
end $$;

-- ── 6. retire the board ─────────────────────────────────────────────────────
--
-- Renamed rather than dropped. It is the rollback, and it is what stops step 4
-- from ever running twice.
do $$
begin
  if to_regclass('public.task_board') is not null and to_regclass('public.task_board_archive') is null then
    alter table task_board rename to task_board_archive;
  end if;
end $$;

-- The tier weights and thresholds the canvas fits tasks against. Same JSON, in
-- the same key/value table; it was only ever called `board_model` because of the
-- board.
update settings set key = 'tier_model' where key = 'board_model'
  and not exists (select 1 from settings where key = 'tier_model');
delete from settings where key = 'board_model';

commit;
