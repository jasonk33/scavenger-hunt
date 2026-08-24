-- Add measurable, deterministic scoring to tasks.
--
-- Existing tasks remain fixed-value tasks. Existing submissions remain valid:
-- their stored points_awarded continue to provide the baseline, while newly
-- configured quantity and competition tasks use their measurement_value.

begin;

alter table tasks add column if not exists scoring_mode text not null default 'fixed';
alter table tasks add column if not exists measurement_label text not null default '';
alter table tasks add column if not exists measurement_threshold int not null default 0;
alter table tasks add column if not exists points_per_unit int not null default 0;
alter table tasks add column if not exists measurement_cap int;
alter table tasks add column if not exists competition_bonus int not null default 0;
alter table submissions add column if not exists measurement_value int;
alter table submissions add column if not exists scoring_mode_snapshot text not null default 'fixed';
alter table submissions add column if not exists measurement_threshold_snapshot int not null default 0;
alter table submissions add column if not exists points_per_unit_snapshot int not null default 0;
alter table submissions add column if not exists measurement_cap_snapshot int;
alter table submissions add column if not exists competition_bonus_snapshot int not null default 0;

do $$
declare
  item record;
begin
  for item in
    select * from (values
      ('tasks_scoring_mode_check', 'tasks', 'scoring_mode in (''fixed'', ''quantity'', ''competition'')'),
      ('tasks_measurement_threshold_check', 'tasks', 'measurement_threshold >= 0'),
      ('tasks_points_per_unit_check', 'tasks', 'points_per_unit >= 0'),
      ('tasks_measurement_cap_check', 'tasks', 'measurement_cap is null or measurement_cap >= 0'),
      ('tasks_competition_bonus_check', 'tasks', 'competition_bonus >= 0'),
      ('submissions_scoring_mode_snapshot_check', 'submissions', 'scoring_mode_snapshot in (''fixed'', ''quantity'', ''competition'')'),
      ('submissions_measurement_threshold_snapshot_check', 'submissions', 'measurement_threshold_snapshot >= 0'),
      ('submissions_points_per_unit_snapshot_check', 'submissions', 'points_per_unit_snapshot >= 0'),
      ('submissions_measurement_cap_snapshot_check', 'submissions', 'measurement_cap_snapshot is null or measurement_cap_snapshot >= 0'),
      ('submissions_competition_bonus_snapshot_check', 'submissions', 'competition_bonus_snapshot >= 0'),
      ('submissions_measurement_value_check', 'submissions', 'measurement_value is null or measurement_value >= 0')
    ) as checks(name, table_name, expression)
  loop
    if not exists (
      select 1
      from pg_constraint
      where conrelid = format('public.%s', item.table_name)::regclass
        and conname = item.name
    ) then
      execute format(
        'alter table %I add constraint %I check (%s) not valid',
        item.table_name, item.name, item.expression
      );
    end if;
    execute format(
      'alter table %I validate constraint %I',
      item.table_name, item.name
    );
  end loop;
end $$;

create or replace view team_scores as
with best as (
  select distinct on (s.round, s.team_id, s.task_id)
         s.round, s.team_id, s.task_id, s.task_points, s.measurement_value, s.points_awarded,
         coalesce(s.scoring_mode_snapshot, t.scoring_mode) as scoring_mode,
         coalesce(s.measurement_threshold_snapshot, t.measurement_threshold) as measurement_threshold,
         coalesce(s.points_per_unit_snapshot, t.points_per_unit) as points_per_unit,
         coalesce(s.measurement_cap_snapshot, t.measurement_cap) as measurement_cap,
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
        task_points + least(
          greatest(0, coalesce(measurement_value, 0) - measurement_threshold),
          case
            when measurement_cap is null then greatest(0, coalesce(measurement_value, 0) - measurement_threshold)
            else greatest(0, measurement_cap - measurement_threshold)
          end
        ) * points_per_unit
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
