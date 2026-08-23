-- The planning board, moved out of a version-controlled JSON file and into the
-- database.
--
-- Run this once, in the Supabase SQL editor, before `node scripts/board-import.mjs`.
-- Additive and re-runnable: it creates one table and writes no seed data, so it
-- is safe against the live project. It does not touch `tasks`.
--
-- WHY THIS TABLE EXISTS, AND WHY IT IS NOT `tasks`
--
-- The board is where tasks are argued about; `tasks` is what players see. The
-- gap between them is the entire point of the design -- re-rating a task at
-- 2:55pm must not change the player's list until someone deliberately publishes.
-- `scripts/task-sync.mjs` is the only bridge, and it still only ever writes to
-- `tasks`. Collapsing these two tables into one would delete the staging gap and
-- make every keystroke live.
--
-- The board used to be `data/task-board.json`. A file in a checkout has one copy
-- per checkout, so a worktree edited a board nobody published, two processes
-- holding it in memory could silently revert each other, and publishing left a
-- commit stranded on whatever branch happened to be checked out. There is only
-- ever one Supabase project behind all of them, so the board belongs here.

create table if not exists task_board (
  -- The stable board id (`r1-01`, `s-04`) mirrored onto `tasks.board_id`. It is
  -- the sync key and the primary key: never match tasks on their title, which
  -- eight tasks have already outgrown.
  board_id   text primary key,

  -- 0 is a secret challenge, offered in BOTH halves of the event. `tasks.round`
  -- is `check (round in (1, 2))`, so a secret fans out to one row per round
  -- sharing this board_id. That is why the board counts 76 and `tasks` holds
  -- more; it is not corruption.
  round      int  not null check (round in (0, 1, 2)),

  -- The planning doc's exact wording, kept for provenance and never edited.
  -- Empty on a task added straight into the canvas.
  doc_title  text not null default '',
  -- What a player actually reads. Starts equal to doc_title and is what the
  -- canvas edits.
  title      text not null check (length(btrim(title)) > 0),

  points     int  not null check (points in (1, 3, 5, 7, 10)),
  -- Position within the round in the planning doc. Ordering for PLAYERS is
  -- derived by the sync (tier ascending, secrets last) and lives in
  -- `tasks.sort_order`; this is only the board's own reading order.
  doc_order  int  not null default 999,

  -- difficulty/guts/luck drive the suggested tier. payoff and risk do not --
  -- they are the keep/cut axes.
  difficulty int  not null default 3 check (difficulty between 1 and 5),
  guts       int  not null default 3 check (guts       between 1 and 5),
  luck       int  not null default 3 check (luck       between 1 and 5),
  payoff     int  not null default 3 check (payoff     between 1 and 5),
  risk       int  not null default 1 check (risk       between 1 and 5),

  needs_clip boolean not null default false,
  prop       text    not null default '',

  -- `cut` publishes as `active = false`, never a delete -- a delete would
  -- cascade to submissions. `maybe` publishes as live and warns.
  status     text not null default 'maybe' check (status in ('keep', 'maybe', 'cut')),
  -- Flagged as needing better wording. An agent job, not a slider.
  rewrite    boolean not null default false,
  note       text    not null default '',

  -- The tier suggestion this task's owner rejected, or null for "never
  -- dismissed". A number rather than a flag so that changing a rating -- which
  -- moves the suggestion -- re-raises it. See `tier.mjs`.
  tier_ok    int check (tier_ok in (1, 3, 5, 7, 10)),

  created_at timestamptz not null default now(),
  -- Maintained by the writer, not a trigger. The board lost git history when it
  -- moved in here, and "when did this last change" is the part of that history
  -- worth keeping.
  updated_at timestamptz not null default now()
);

-- Matches every other table: RLS on with NO policies, so the browser cannot read
-- or write this at all. The canvas reaches it through the service_role key in a
-- Node process, never from the page.
alter table task_board enable row level security;

-- The board's own reading order, which the canvas sorts by.
create index if not exists task_board_round_doc_order_idx on task_board (round, doc_order);

-- The scoring model (`weights`, `thresholds`) lives in the existing key/value
-- `settings` table under `board_model`, as JSON. It is three weights and three
-- thresholds; a table for it would be a table with one row.
--
-- No default is inserted here. The importer writes it, and the canvas falls back
-- to the fitted defaults in code when the key is absent -- so a missing row is a
-- working board, not a broken one.
