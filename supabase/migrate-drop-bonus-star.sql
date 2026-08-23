-- Drop the creativity bonus and the award star, and make a re-approval count.
--
-- Run this in the Supabase SQL editor AFTER the new code is deployed, not
-- before: the old code writes `bonus` and `starred` on every approval, so
-- dropping the columns first would break judging. The new code never touches
-- them, so it is happy against either shape of the table.
--
-- Safe to re-run.

-- 1. Scoring, without the bonus and with the judge's latest ruling winning.
--
-- The old view counted the HIGHEST approved submission for a (round, team, task).
-- Duplicates normally carry the same value, so that only mattered when a task's
-- points were edited between two approvals -- and there it silently kept the
-- old, higher score, which looked like the judge's newer decision had been
-- ignored. Now the most recently judged approval wins.
--
-- Rejections stay excluded rather than counting as "latest", so rejecting a
-- duplicate cannot un-score a task the team already got right.
--
-- Output columns are unchanged, which is what lets this be a replace rather
-- than a drop -- nothing that reads team_scores needs to change.
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

-- 2. The columns themselves. Only reachable once the view above no longer
--    reads `bonus`, which is why this is the second statement and not the first.
alter table submissions drop column if exists bonus;
alter table submissions drop column if exists starred;
