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
  bonus          int  not null default 0 check (bonus between 0 and 2),
  starred        boolean not null default false,
  reject_reason  text,
  created_at     timestamptz not null default now(),
  judged_at      timestamptz
);

create index if not exists submissions_queue_idx
  on submissions (status, created_at);
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
-- the field. Duplicates are allowed to exist; only the best one is counted.
create or replace view team_scores as
with best as (
  select distinct on (s.round, s.team_id, s.task_id)
         s.round,
         s.team_id,
         s.task_id,
         (s.points_awarded + s.bonus) as pts
  from submissions s
  where s.status = 'approved'
    and s.points_awarded is not null
  order by s.round, s.team_id, s.task_id, (s.points_awarded + s.bonus) desc
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

-- Seed data: teams and tasks, transcribed from jasons-30th-scavenger-hunt.docx.
-- Run after 02-storage.sql. Re-running is safe (ON CONFLICT DO NOTHING).
-- Tasks marked (clip) in the doc become requires_video = true.
-- Secret challenges are seeded into BOTH rounds, unrevealed; reveal whichever
-- ones you want from the Admin screen during each round.

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

insert into tasks (round, title, points, requires_video, is_secret, sort_order) values
  (1, 'Re-create an album cover with the whole team', 1, false, false, 10),
  (1, 'Pose as statues next to a real statue — matching pose, worse execution', 1, false, false, 20),
  (1, 'Get a stranger to take your group photo, then get that stranger into a selfie with the team', 1, false, false, 30),
  (1, 'Feed a pigeon out of your hand', 1, false, false, 40),
  (1, 'Fit an entire hot dog in your mouth in one bite', 1, false, false, 50),
  (1, 'Whole team asleep in a pile on the lawn', 1, false, false, 60),
  (1, 'Order at a food cart using only gestures — not one word', 3, true, false, 70),
  (1, 'Get a pup cup from a coffee shop, for a human, and drink it at the counter', 3, false, false, 80),
  (1, 'Point at an empty bench and ask a stranger if they see him too — filmed over your teammate''s shoulder', 3, true, false, 90),
  (1, 'Sit down next to a stranger and mirror their posture exactly — photo shot from across the path', 3, false, false, 100),
  (1, 'Get a stranger to lend you their hat or jacket for a photo', 3, false, false, 110),
  (1, 'Get a stranger to let you hold their dog', 3, false, false, 120),
  (1, 'Kiss a teammate on the mouth in the middle of the lawn', 3, false, false, 130),
  (1, 'Do the worm across the lawn with people watching', 3, true, false, 140),
  (1, 'Shotgun a drink with a teammate', 3, false, false, 150),
  (1, 'Play ring around the rosie with strangers — strangers in the circle, not watching it', 5, false, false, 160),
  (1, 'Pose as mannequins inside a store, in among the real ones', 5, false, false, 170),
  (1, 'Get a stranger to sign their name on your body', 5, false, false, 180),
  (1, 'Get a piggyback ride from a stranger', 5, false, false, 190),
  (1, 'Pay for something entirely in pennies', 5, false, false, 200),
  (1, 'Get a stranger to feed a teammate a bite of their food', 5, false, false, 210),
  (1, 'Tell a stranger about the dream you had that they were in — get to the part where they are in it', 5, true, false, 220),
  (1, 'Swap full outfits with a teammate in the middle of the park', 5, false, false, 230),
  (1, 'High-five five strangers in a row without breaking stride', 5, true, false, 240),
  (1, 'Whole team shotguns at the same time — one photo, everyone mid-shotgun', 5, false, false, 250),
  (1, 'Get a stranger to do push-ups with you on the lawn', 5, false, false, 260),
  (1, 'Get a bench of strangers to scoot over until the entire team fits on it', 5, false, false, 270),
  (1, 'Put 15 t-shirts on one teammate', 10, false, false, 280),
  (1, 'Cover a stranger''s eyes from behind, say “guess who,” and commit until they play along', 10, false, false, 290),
  (1, 'Serve customers from a hot dog cart', 10, false, false, 300),
  (1, 'Get all the way into the fountain', 10, false, false, 310),
  (1, 'Trade shoes with a stranger and wear theirs for the photo', 10, false, false, 320),
  (1, 'Join a stranger''s picnic — the photo is you eating their food on their blanket', 10, false, false, 330),
  (1, 'Get a stranger to shotgun a drink with you', 10, false, false, 340),
  (1, 'Submit the worst photo of Jason', 7, false, true, 350),
  (1, 'Submit the best photo of Jason', 7, false, true, 360),
  (1, 'Write and perform a four-line poem about Jason', 7, false, true, 370),
  (1, 'Jason trivia', 7, false, true, 380),
  (2, 'Hug a stranger', 1, false, false, 10),
  (2, 'Hold hands with a stranger long enough to get the photo', 1, false, false, 20),
  (2, 'Alter a public sign so it reads dirty', 1, false, false, 30),
  (2, 'Get a barista to write something unhinged on your cup', 1, false, false, 40),
  (2, 'Ask a homeless person for money', 3, true, false, 50),
  (2, 'Try to pay for something in gum — the gum has to make it onto the counter', 3, false, false, 60),
  (2, 'Pretend to be a waiter until a table actually gives you their order', 3, true, false, 70),
  (2, 'Walk into a restaurant and ask if they sell clothes', 3, true, false, 80),
  (2, 'Get an old lady to flip off the camera', 3, false, false, 90),
  (2, 'Ask an old couple if they still poke', 3, true, false, 100),
  (2, 'Kiss a stranger on the cheek', 3, false, false, 110),
  (2, 'Scream for your mom until strangers turn around', 3, true, false, 120),
  (2, 'Hook up with a statue', 3, false, false, 130),
  (2, 'Propose to a stranger on one knee with a ring made from something off the street', 3, false, false, 140),
  (2, 'Stick a tampon up each nostril and keep a straight face inside a store', 3, false, false, 150),
  (2, 'A guy wears a thong over his clothes, out in public', 3, false, false, 160),
  (2, 'Put a condom over your entire head in public', 3, false, false, 170),
  (2, 'Blatantly smell a stranger — close enough that they notice', 5, false, false, 180),
  (2, 'Take a bite out of a stranger''s food', 5, false, false, 190),
  (2, 'Join a couple who are holding hands and hold one of their hands', 5, false, false, 200),
  (2, 'Stick a “kick me” sign on a stranger and photograph them walking away still wearing it', 5, false, false, 210),
  (2, 'Make a public scene of peeing or pooping your pants', 5, true, false, 220),
  (2, 'Fake a break-up loudly enough that strangers stop and stare', 5, true, false, 230),
  (2, 'Offer to take a stranger''s photo on their phone, then fire off a burst of selfies on it — a teammate shoots you doing it', 5, false, false, 240),
  (2, 'Get a crowd of strangers to sing happy birthday to Jason', 5, true, false, 250),
  (2, 'Blast porn audio in a cafe for ten straight seconds', 5, true, false, 260),
  (2, 'Get a stranger to put their number in your phone — the photo is them typing it in', 5, false, false, 270),
  (2, 'Get strangers to sign a petition for something insane', 5, false, false, 280),
  (2, 'Kiss a stranger on the lips', 10, false, false, 290),
  (2, 'Pick up a pigeon', 10, false, false, 300),
  (2, 'Form a pyramid with at least one stranger in the bottom row', 10, false, false, 310),
  (2, 'Carry two gallons of milk through a store, wipe out, and burst them', 10, true, false, 320),
  (2, 'Trade pants with a stranger', 10, false, false, 330),
  (2, 'Direct traffic at an intersection until cars actually react to you', 10, true, false, 340),
  (2, 'Get a stranger to rub cream on a teammate''s rash', 10, false, false, 350),
  (2, 'Get a stranger to give you the shirt off their back and wear it', 10, false, false, 360),
  (2, 'Get a stranger to carry a teammate bridal-style', 10, false, false, 370),
  (2, 'Submit the worst photo of Jason', 7, false, true, 380),
  (2, 'Submit the best photo of Jason', 7, false, true, 390),
  (2, 'Write and perform a four-line poem about Jason', 7, false, true, 400),
  (2, 'Jason trivia', 7, false, true, 410)
on conflict (round, title) do nothing;
