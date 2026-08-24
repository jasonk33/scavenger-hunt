-- Simplify quantity scoring to baseline + (measured amount * points per item).
--
-- This updates the view after migrate-competitive-scoring.sql has already been
-- run. The old threshold and cap columns remain for backwards compatibility but
-- are no longer used by the application or the scoring view.

begin;

create or replace view team_scores as
with best as (
  select distinct on (s.round, s.team_id, s.task_id)
         s.round, s.team_id, s.task_id, s.task_points, s.measurement_value, s.points_awarded,
         coalesce(s.scoring_mode_snapshot, t.scoring_mode) as scoring_mode,
         coalesce(s.points_per_unit_snapshot, t.points_per_unit) as points_per_unit,
         coalesce(s.competition_bonus_snapshot, t.competition_bonus) as competition_bonus
  from submissions s
  join tasks t on t.id = s.task_id
  where s.status = 'approved' and s.points_awarded is not null
  order by s.round, s.team_id, s.task_id,
           s.judged_at desc nulls last, s.created_at desc, s.id desc
),
with_leaders as (
  select b.*,
         max(case when b.measurement_value is not null then b.measurement_value end)
           over (partition by b.round, b.task_id) as leading_value
  from best b
),
scored as (
  select *,
    (case
      when scoring_mode = 'quantity' then
        task_points + coalesce(measurement_value, 0) * points_per_unit
      else task_points
    end
    + case
        when scoring_mode = 'competition'
          and measurement_value is not null
          and measurement_value = leading_value
        then competition_bonus
        else 0
      end)::int as pts
  from with_leaders
)
select t.id as team_id, t.round, t.name, t.color, t.sort_order,
       coalesce(sum(s.pts), 0)::int as points,
       count(s.task_id)::int as tasks_scored
from teams t
left join scored s on s.team_id = t.id and s.round = t.round
group by t.id, t.round, t.name, t.color, t.sort_order;

commit;
