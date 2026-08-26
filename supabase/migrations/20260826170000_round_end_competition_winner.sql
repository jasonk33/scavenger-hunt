-- Competition bonuses become an end-of-round decision, not a live race.
--
-- The bonus used to go to whoever had posted the highest measured value so far,
-- recomputed on every read. Three things were wrong with that:
--
--   1. An approved task lost points later. A team that led at 2pm silently
--      dropped five points at 3pm when someone beat them -- on a task they had
--      already finished -- which is both confusing and a standing invitation to
--      go redo it.
--   2. It demanded a number from the judge for tasks that have none. "Submit
--      the worst photo of Jason" is a judgement call, and forcing it into a
--      measurement made the judge invent a score under queue pressure.
--   3. Every competition task in the event had competition_bonus = 0, so the
--      number the judge typed bought precisely nothing.
--
-- Now an organizer names the winning team once the round is over. Read-time is
-- still where the bonus is applied, but the input is an explicit column that
-- only changes when someone decides it changes.
--
-- measurement_threshold and measurement_cap are dead too -- validated,
-- snapshotted onto every submission and selected by eight routes since they
-- were added, never once read by the scoring code. They are dropped in the
-- migration after this one rather than here, because the build being served
-- while this runs still selects them.

begin;

-- Per-round by construction: a task row belongs to one round, so a secret
-- challenge offered in both halves has two rows and two independent winners.
-- The API checks the team is in the task's round; a foreign key cannot.
alter table tasks
  add column if not exists winner_team_id uuid references teams(id) on delete set null;

-- Replaced first: the previous definition selected measurement_threshold_snapshot,
-- and the columns it reads are dropped by the migration after this one.
create or replace view team_scores as
with best as (
  select distinct on (s.round, s.team_id, s.task_id)
         s.round, s.team_id, s.task_id, s.task_points, s.measurement_value, s.points_awarded,
         coalesce(s.scoring_mode_snapshot, t.scoring_mode) as scoring_mode,
         coalesce(s.points_per_unit_snapshot, t.points_per_unit) as points_per_unit,
         coalesce(s.competition_bonus_snapshot, t.competition_bonus) as competition_bonus,
         -- Not snapshotted, and cannot be: the winner is picked after the round,
         -- long after these rows were judged.
         t.winner_team_id
  from submissions s
  join tasks t on t.id = s.task_id
  where s.status = 'approved' and s.points_awarded is not null
  order by s.round, s.team_id, s.task_id,
           s.judged_at desc nulls last, s.created_at desc, s.id desc
),
scored as (
  select *,
    (case
      when scoring_mode = 'quantity' then
        task_points + coalesce(measurement_value, 0) * points_per_unit
      else task_points
    end
    + case
        when scoring_mode = 'competition' and winner_team_id = team_id
        then competition_bonus
        else 0
      end)::int as pts
  from best
)
select t.id as team_id, t.round, t.name, t.color, t.sort_order,
       coalesce(sum(s.pts), 0)::int as points,
       count(s.task_id)::int as tasks_scored
from teams t
left join scored s on s.team_id = t.id and s.round = t.round
group by t.id, t.round, t.name, t.color, t.sort_order;

commit;
